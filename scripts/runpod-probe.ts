/**
 * `npx tsx scripts/runpod-probe.ts` — is the RunPod GPU fit to take slot A of the cheap lane?
 *
 * Reads RUNPOD_VLLM_URL, RUNPOD_VLLM_KEY and optionally RUNPOD_VLLM_MODEL from the
 * environment (repository secrets in `cheap-lane.yml`). Prints no secret. Checks, in order:
 *
 *   1. auth    — the endpoint refuses a request with no key (an open GPU is anyone's GPU);
 *   2. models  — with the key it lists models, and the one Brain will name is served;
 *   3. task    — a real lane task (SCREEN_OPENING) through Brain's own RunPod call,
 *                answered in a shape Brain's own parser accepts;
 *   4. load    — four of them at once all come back valid (the lane runs slots in parallel);
 *   5. long    — a research-sized prompt (~10k tokens) fits the server's context.
 *
 * Exit 0 only when all pass. The last line is `MODEL <name>` for the workflow to read.
 */
import { normalizeRunpodUrl, runpodChat, type RunpodConfig } from '../server/services/cheap/runpod.ts';
import { TASKS, parseScreen } from '../server/services/cheap/lane.ts';

const rawUrl = process.env['RUNPOD_VLLM_URL']?.trim();
const key = process.env['RUNPOD_VLLM_KEY']?.trim() || null;
if (!rawUrl) {
  console.log('FAIL config: RUNPOD_VLLM_URL is not set');
  process.exit(2);
}
const url = normalizeRunpodUrl(rawUrl);
let failed = false;
let servedContext: number | null = null;
const say = (ok: boolean, step: string, detail: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

async function main(): Promise<void> {
  // 1. auth
  try {
    const open = await fetch(`${url}/models`, { signal: AbortSignal.timeout(60_000) });
    say(open.status === 401 || open.status === 403, 'auth', `no-key request got HTTP ${open.status} (want 401)`);
  } catch (error) {
    say(false, 'auth', `endpoint unreachable: ${(error as Error).message}`);
    return;
  }
  if (!key) {
    say(false, 'auth', 'RUNPOD_VLLM_KEY is not set');
    return;
  }
  // 2. models
  let model = process.env['RUNPOD_VLLM_MODEL']?.trim() || '';
  try {
    const listed = await fetch(`${url}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await listed.json().catch(() => ({}))) as { data?: { id: string; max_model_len?: number }[] };
    const ids = (body.data ?? []).map((one) => one.id);
    // A pinned name the pod no longer serves (a recipe change) falls back to what it serves.
    if (!model || !ids.includes(model)) model = ids[0] ?? '';
    const served = body.data?.find((one) => one.id === model);
    servedContext = served?.max_model_len ?? null;
    say(listed.ok && !!served, 'models', `HTTP ${listed.status}, serving [${ids.join(', ')}], Brain will use "${model}"${served?.max_model_len ? `, context ${served.max_model_len}` : ''}`);
    if (served?.max_model_len && served.max_model_len < 20_000) {
      say(false, 'context', `max_model_len ${served.max_model_len} is under the 20000 research packets need (start vLLM with --max-model-len 32768)`);
    }
  } catch (error) {
    say(false, 'models', (error as Error).message);
    return;
  }
  if (!model) return;
  const gpu: RunpodConfig = { url, key, model, label: `runpod/${model}` };
  const input = {
    title: 'County posts RFQ for a flood-zone parcel spreadsheet, due in 10 days',
    mechanism: 'PUBLISHED_REQUEST',
    source: 'https://example.gov/rfq',
    payer: 'Example County',
    buyingSignal: 'Posted RFQ with a budget',
    deadline: '2026-11-15',
    price: '1500 USD',
  };
  const one = async (timeoutMs: number) => {
    const started = Date.now();
    const text = await runpodChat(gpu, TASKS.SCREEN_OPENING.system, TASKS.SCREEN_OPENING.prompt(input), { maxTokens: 400, timeoutMs });
    return { parsed: parseScreen(text), ms: Date.now() - started, text };
  };
  // 3. task (a cold model may load slowly the first time)
  try {
    const first = await one(180_000);
    say(!!first.parsed, 'task', first.parsed ? `${first.parsed.verdict} in ${first.ms} ms` : `off-shape answer: ${first.text.slice(0, 200)}`);
  } catch (error) {
    say(false, 'task', (error as Error).message);
    return;
  }
  // 4. load
  const started = Date.now();
  const many = await Promise.allSettled([0, 1, 2, 3].map(() => one(60_000)));
  const good = many.filter((r) => r.status === 'fulfilled' && r.value.parsed).length;
  say(good === 4, 'load', `${good}/4 valid answers in parallel, ${Date.now() - started} ms total`);
  // 5. long
  try {
    const filler = 'The county parcel register lists owner, acreage, zoning and flood zone for each lot. '.repeat(450);
    const t = Date.now();
    const text = await runpodChat(gpu, 'Answer ONLY with a JSON object.', `${filler}\n\nReply exactly: {"verdict":"KEEP","window":"UNKNOWN","tags":[],"reason":"read"}`, {
      maxTokens: 4000,
      timeoutMs: 180_000,
    });
    say(!!parseScreen(text), 'long', `~10k-token prompt answered in ${Date.now() - t} ms`);
  } catch (error) {
    say(false, 'long', (error as Error).message.slice(0, 200));
  }
  // 6. tools — the operator's every call is a structured tool call (§108). Production's 4B
  // recipe answered HTTP 400 here; a pod that fails it still serves research, never Hermes.
  try {
    const { chatFor, OPERATOR_BENCH_TOOLS, GOAL_ID } = await import('../server/services/cheap/modelBench.ts');
    const chat = chatFor({ label: 'probe', url, key, model, usdPerHour: null }, fetch, 180_000);
    const r = await chat(
      [
        { role: 'system', content: "You are Brain's operator. Act only through the tools." },
        { role: 'user', content: `Inspect goal ${GOAL_ID}.` },
      ],
      OPERATOR_BENCH_TOOLS,
      2048,
    );
    const call = r.toolCalls[0];
    const ok = !r.error && !!call && call.name === 'brain_operator_goal' && call.args?.['goal_id'] === GOAL_ID;
    console.log(`${ok ? 'PASS' : 'WARN'} tools: ${ok ? `structured call ${call!.name} in ${r.ms} ms` : (r.error ?? `no structured call (${r.content.slice(0, 120)})`)}`);
    console.log(`TOOLS ${ok ? 'on' : 'off'}`);
  } catch (error) {
    console.log(`WARN tools: ${(error as Error).message.slice(0, 200)}`);
    console.log('TOOLS off');
  }
  if (servedContext) console.log(`CONTEXT ${servedContext}`);
  console.log(`MODEL ${model}`);
}

main()
  .catch((error) => say(false, 'probe', (error as Error).message))
  .finally(() => {
    console.log(failed ? 'RESULT FAIL' : 'RESULT PASS');
    process.exit(failed ? 1 : 0);
  });
