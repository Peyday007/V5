/**
 * `npx tsx scripts/runpod-repurpose.ts --recipe a,b,c` — serve a recipe on Brain's
 * existing pod in place (§108), trying each in order: update the image and start
 * command, wait for vLLM, then *use* it — a real lane-shaped answer and a
 * structured operator tool call — before calling it served. A recipe that does
 * not pass moves to the next; when none passes, the recipe the pod served before
 * is put back. 2026-11-12 21:17: Qwen3-8B with FP8 KV listed its model and
 * answered every chat HTTP 500, so "it lists models" is never enough.
 * Prints `POD`, `TRY`, `CHECK`, `SERVED <recipe>` or `REVERTED`, `URL`; no secret.
 */
import { POD_NAME, listPods, podServedModel, podUrl, recipeFor, repurposePod, RECIPES, type PodRecipe } from '../server/services/cheap/runpodRestore.ts';
import { chatFor, OPERATOR_BENCH_TOOLS, GOAL_ID } from '../server/services/cheap/modelBench.ts';

const at = process.argv.indexOf('--recipe');
const apiKey = process.env['RUNPOD_API_KEY']?.trim() ?? '';
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim() ?? '';

async function ready(url: string, served: string, minutes: number): Promise<boolean> {
  const until = Date.now() + minutes * 60_000;
  await new Promise((r) => setTimeout(r, 60_000));
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${vllmKey}` }, signal: AbortSignal.timeout(15_000) });
      if (r.ok && ((await r.json()) as { data?: { id: string }[] }).data?.some((m) => m.id === served)) return true;
    } catch {
      /* restarting or downloading */
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return false;
}

/** Use it: a plain answer and a structured tool call, as the lane and the operator will. */
async function works(url: string, recipe: PodRecipe): Promise<{ ok: boolean; detail: string }> {
  const chat = chatFor({ label: recipe.key, url, key: vllmKey, model: recipe.served, usdPerHour: null }, fetch, 180_000);
  const plain = await chat([{ role: 'user', content: 'Reply with exactly the JSON {"ok":true}' }], undefined, 400);
  if (plain.error) return { ok: false, detail: `chat: ${plain.error}` };
  const tool = await chat(
    [
      { role: 'system', content: "You are Brain's operator. Act only through the tools." },
      { role: 'user', content: `Inspect goal ${GOAL_ID}.` },
    ],
    OPERATOR_BENCH_TOOLS,
    1500,
  );
  if (tool.error) return { ok: false, detail: `tool call: ${tool.error}` };
  const call = tool.toolCalls[0];
  if (!call || call.name !== 'brain_operator_goal' || call.args?.['goal_id'] !== GOAL_ID) return { ok: false, detail: `no structured tool call (${tool.content.slice(0, 120)})` };
  return { ok: true, detail: `chat ${plain.ms} ms, tool call ${tool.ms} ms` };
}

async function main(): Promise<void> {
  if (!apiKey || !vllmKey) throw new Error('RUNPOD_API_KEY and RUNPOD_VLLM_KEY are both required');
  const keys = (at >= 0 ? process.argv[at + 1] ?? '' : '').split(',').map((k) => k.trim()).filter(Boolean);
  const recipes = (keys.length ? keys : [null]).map((k) => recipeFor(k));
  const pod = (await listPods(apiKey)).find((p) => p.name === POD_NAME && p.desiredStatus !== 'TERMINATED');
  if (!pod) throw new Error(`no pod named ${POD_NAME}`);
  const before = podServedModel(pod);
  // What to fall back to: the recipe that last served, never one of the candidates that just failed.
  const previous = Object.values(RECIPES).find((r) => r.served === before && !recipes.includes(r)) ?? RECIPES['qwen3-4b-legacy']!;
  const url = podUrl(pod.id);
  console.log(`POD ${pod.id} ${pod.desiredStatus} serving ${before ?? 'unknown'}`);
  for (const recipe of recipes) {
    console.log(`TRY ${recipe.key}`);
    const changed = await repurposePod(apiKey, pod.id, recipe, vllmKey);
    if (!changed.ok) {
      console.log(`CHECK ${recipe.key} update refused: HTTP ${changed.status} ${changed.detail}`);
      continue;
    }
    if (!(await ready(url, recipe.served, 25))) {
      console.log(`CHECK ${recipe.key} not serving after 25 min`);
      continue;
    }
    const used = await works(url, recipe);
    console.log(`CHECK ${recipe.key} ${used.ok ? 'PASS' : 'FAIL'} ${used.detail}`);
    if (used.ok) {
      console.log(`SERVED ${recipe.key}`);
      console.log(`URL ${url}`);
      return;
    }
  }
  console.log(`REVERTING to ${previous.key}`);
  await repurposePod(apiKey, pod.id, previous, vllmKey);
  console.log(`REVERTED ${previous.key}; serving again: ${await ready(url, previous.served, 20)}`);
  console.log(`URL ${url}`);
  process.exit(1);
}

main().catch((error) => {
  console.log(`FAIL repurpose: ${(error as Error).message}`);
  process.exit(1);
});
