/**
 * `npx tsx scripts/runpod-repurpose.ts --recipe <key>` — serve a recipe on Brain's
 * existing pod (§108): update its image and start command in place, wait for vLLM,
 * and on failure put the previous recipe back. Prints `POD <id> …`, `URL <address>`,
 * `REPURPOSED <recipe>` or `REVERTED`; prints no secret.
 */
import { POD_NAME, listPods, podServedModel, podUrl, recipeFor, repurposePod, RECIPES } from '../server/services/cheap/runpodRestore.ts';

const at = process.argv.indexOf('--recipe');
const apiKey = process.env['RUNPOD_API_KEY']?.trim() ?? '';
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim() ?? '';

async function ready(url: string, minutes: number): Promise<boolean> {
  const until = Date.now() + minutes * 60_000;
  // A restart takes the old server down first; give it a minute before reading "ready".
  await new Promise((r) => setTimeout(r, 60_000));
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${vllmKey}` }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) return true;
    } catch {
      /* restarting or downloading */
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return false;
}

async function main(): Promise<void> {
  if (!apiKey || !vllmKey) throw new Error('RUNPOD_API_KEY and RUNPOD_VLLM_KEY are both required');
  const recipe = recipeFor(at >= 0 ? process.argv[at + 1] : null);
  const pod = (await listPods(apiKey)).find((p) => p.name === POD_NAME && p.desiredStatus !== 'TERMINATED');
  if (!pod) throw new Error(`no pod named ${POD_NAME}`);
  const before = podServedModel(pod);
  const previous = Object.values(RECIPES).find((r) => r.served === before) ?? RECIPES['qwen3-4b-legacy']!;
  console.log(`POD ${pod.id} ${pod.desiredStatus} serving ${before ?? 'unknown'} on ${pod.gpu?.displayName ?? '?'}`);
  const changed = await repurposePod(apiKey, pod.id, recipe, vllmKey);
  console.log(`UPDATE HTTP ${changed.status} ${changed.ok ? '' : changed.detail}`);
  if (!changed.ok) process.exit(1);
  const url = podUrl(pod.id);
  if (await ready(url, 30)) {
    console.log(`REPURPOSED ${recipe.key}`);
    console.log(`URL ${url}`);
    return;
  }
  console.log(`NOT READY ${recipe.key} after 30 min; putting ${previous.key} back`);
  const back = await repurposePod(apiKey, pod.id, previous, vllmKey);
  console.log(`REVERTED HTTP ${back.status}; ready again: ${await ready(url, 20)}`);
  console.log(`URL ${url}`);
  process.exit(1);
}

main().catch((error) => {
  console.log(`FAIL repurpose: ${(error as Error).message}`);
  process.exit(1);
});
