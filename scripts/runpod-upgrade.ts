/**
 * `npx tsx scripts/runpod-upgrade.ts --recipe <key>` / `--retire <podId>` —
 * move Brain's GPU to another recipe without a gap (§108).
 *
 * A pod's GPU cannot change, so a new recipe on a different card is a new pod:
 * it is created beside the old one, within the price ceiling and only while the
 * balance lasts a day, waited on until vLLM serves, and deleted again if it
 * never does. The workflow then probes it (tool calls included), points the
 * Brain at it, and only then retires the old pod (`--retire`), so Brain owns one
 * GPU pod before and after. Prints `NEW <id>`, `OLD <id>`, `URL <address>`,
 * `POD <id> <status> <usd/h>`; prints no secret.
 */
import { DEFAULT_MAX_USD_PER_HOUR, POD_NAME, createPod, deletePod, listPods, recipeFor } from '../server/services/cheap/runpodRestore.ts';
import { accountReading } from '../server/services/cheap/runpodAccount.ts';

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? '') : null;
};
const apiKey = process.env['RUNPOD_API_KEY']?.trim() ?? '';
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim() ?? '';
const ceiling = Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) > 0 ? Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) : DEFAULT_MAX_USD_PER_HOUR;

async function main(): Promise<void> {
  if (!apiKey || !vllmKey) throw new Error('RUNPOD_API_KEY and RUNPOD_VLLM_KEY are both required');
  const retire = arg('retire');
  if (retire) {
    for (const id of retire.split(',').map((x) => x.trim()).filter(Boolean)) console.log(`RETIRED ${id} (HTTP ${await deletePod(apiKey, id)})`);
    return;
  }
  const recipe = recipeFor(arg('recipe'));
  const before = (await listPods(apiKey)).filter((p) => p.name === POD_NAME && p.desiredStatus !== 'TERMINATED');
  for (const p of before) console.log(`OLD ${p.id}`);
  const account = await accountReading(apiKey);
  console.log(`ACCOUNT balance $${account.balance?.toFixed(2) ?? '?'} spending $${account.spendPerHour?.toFixed(3) ?? '?'}/h`);
  if (account.balance !== null && account.balance / ((account.spendPerHour ?? 0) + ceiling) < 24) {
    throw new Error('the balance would last under 24 hours with two pods running; the old pod stays');
  }
  const pod = await createPod({ apiKey, vllmKey, recipe, name: POD_NAME, maxUsdPerHour: ceiling });
  pod.log.forEach((l) => console.log(l));
  console.log(`NEW ${pod.podId}`);
  const started = Date.now();
  let ready = false;
  while (!ready && Date.now() - started < 35 * 60_000) {
    try {
      ready = (await fetch(`${pod.url}/models`, { headers: { authorization: `Bearer ${vllmKey}` }, signal: AbortSignal.timeout(15_000) })).ok;
    } catch {
      /* downloading the model */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  if (!ready) {
    console.log(`NOT READY after 35 min; deleted the new pod (HTTP ${await deletePod(apiKey, pod.podId)}), the old one keeps serving`);
    process.exit(1);
  }
  console.log(`READY ${recipe.key} served after ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`POD ${pod.podId} RUNNING ${pod.costPerHr ?? 'unknown'}`);
  console.log(`URL ${pod.url}`);
}

main().catch((error) => {
  console.log(`FAIL upgrade: ${(error as Error).message}`);
  process.exit(1);
});
