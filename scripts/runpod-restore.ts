/**
 * `npx tsx scripts/runpod-restore.ts [--wait]` — find Brain's GPU pod, or recreate it.
 *
 * Reads RUNPOD_API_KEY (the account key), RUNPOD_VLLM_KEY (vLLM's --api-key,
 * reused so the Brain's key does not change), RUNPOD_VLLM_URL (the last known
 * address), optional RUNPOD_VLLM_MODEL and RUNPOD_MAX_USD_PER_HOUR. Prints no
 * secret. With --wait, waits for vLLM to serve (a new pod downloads the model).
 *
 * Last lines, for the workflow: `POD <id> <status> <usd/h>` and `URL <address>`.
 */
import { ensurePod, sweepBenchPods } from '../server/services/cheap/runpodRestore.ts';
import { accountReading } from '../server/services/cheap/runpodAccount.ts';

const apiKey = process.env['RUNPOD_API_KEY']?.trim();
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim();
if (!apiKey || !vllmKey) {
  console.log('FAIL config: RUNPOD_API_KEY and RUNPOD_VLLM_KEY are both required');
  process.exit(2);
}
const ceiling = Number(process.env['RUNPOD_MAX_USD_PER_HOUR']);

async function main(): Promise<void> {
  const wait = process.argv.includes('--wait');
  // A benchmark pod a cancelled run left behind bills until deleted (§108).
  const swept = await sweepBenchPods(apiKey!).catch(() => []);
  if (swept.length) console.log(`SWEPT leftover benchmark pod(s): ${swept.join(', ')}`);
  // RunPod deletes every pod when the balance reaches zero (2026-11-10): the runway is reported every hour.
  const account = await accountReading(apiKey!);
  if (account.balance !== null) {
    console.log(`ACCOUNT balance $${account.balance.toFixed(2)} · spending $${account.spendPerHour?.toFixed(3) ?? '?'}/h · runway ${account.runwayHours === null ? 'unknown' : `${Math.round(account.runwayHours)} h`}`);
    if (account.runwayHours !== null && account.runwayHours < 72) console.log(`RUNWAY-LOW ${Math.round(account.runwayHours)}`);
  }
  const attempt = () =>
    ensurePod({
      apiKey: apiKey!,
      vllmKey: vllmKey!,
      oldUrl: process.env['RUNPOD_VLLM_URL'] ?? null,
      model: process.env['RUNPOD_VLLM_MODEL']?.trim() || undefined,
      maxUsdPerHour: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined,
    });
  // RunPod's stock comes and goes by the minute; with --wait, keep asking for 20 minutes.
  const firstTry = Date.now();
  let pod: Awaited<ReturnType<typeof ensurePod>>;
  for (;;) {
    try {
      pod = await attempt();
      break;
    } catch (error) {
      if (!wait || Date.now() - firstTry > 20 * 60_000) throw error;
      console.log(`retrying in 2 min: ${(error as Error).message.slice(0, 300)}`);
      await new Promise((resolve) => setTimeout(resolve, 120_000));
    }
  }
  for (const line of pod.log) console.log(line);
  if (pod.created) console.log(`CREATED ${pod.podId}`);
  if (wait && pod.status === 'RUNNING') {
    const started = Date.now();
    let ready = false;
    while (!ready && Date.now() - started < 30 * 60_000) {
      try {
        const r = await fetch(`${pod.url}/models`, { headers: { authorization: `Bearer ${vllmKey}` }, signal: AbortSignal.timeout(15_000) });
        ready = r.ok;
      } catch {
        /* still booting */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    console.log(ready ? `READY vLLM served after ${Math.round((Date.now() - started) / 1000)}s` : 'NOT READY vLLM did not serve within 30 min');
  }
  console.log(`POD ${pod.podId} ${pod.status} ${pod.costPerHr ?? 'unknown'}`);
  console.log(`URL ${pod.url}`);
}

main().catch((error) => {
  console.log(`FAIL restore: ${(error as Error).message}`);
  process.exit(1);
});
