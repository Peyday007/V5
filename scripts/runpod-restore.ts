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
import { ensurePod } from '../server/services/cheap/runpodRestore.ts';

const apiKey = process.env['RUNPOD_API_KEY']?.trim();
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim();
if (!apiKey || !vllmKey) {
  console.log('FAIL config: RUNPOD_API_KEY and RUNPOD_VLLM_KEY are both required');
  process.exit(2);
}
const ceiling = Number(process.env['RUNPOD_MAX_USD_PER_HOUR']);

async function main(): Promise<void> {
  const pod = await ensurePod({
    apiKey: apiKey!,
    vllmKey: vllmKey!,
    oldUrl: process.env['RUNPOD_VLLM_URL'] ?? null,
    model: process.env['RUNPOD_VLLM_MODEL']?.trim() || undefined,
    maxUsdPerHour: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined,
  });
  for (const line of pod.log) console.log(line);
  if (pod.created) console.log(`CREATED ${pod.podId}`);
  if (process.argv.includes('--wait') && pod.status === 'RUNNING') {
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
