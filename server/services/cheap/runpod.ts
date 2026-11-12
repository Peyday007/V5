/**
 * The RunPod GPU behind the cheap lane: Brain's own model (Qwen3 8B on vLLM),
 * used first, with the free providers (OmniRoute) as the fallback.
 *
 * Off unless `BRAIN_RUNPOD_URL` is set AND `BRAIN_RUNPOD_MODE=primary`. Off,
 * nothing here runs and the lane is exactly what it was.
 *
 * How it plugs in. The lane has one or two model slots. In primary mode the
 * RunPod model takes slot A and the first free model moves to slot B, so the
 * free research lane still has its independence rule (§85): what one model
 * found is verified by a different model. Each call on slot A goes to the GPU;
 * if the GPU fails (stopped pod, timeout, 5xx, overflowing the context), the
 * same call is answered by the free model it displaced. A run of failures opens
 * a breaker so a stopped pod does not cost every call a timeout.
 *
 * Authentication. vLLM is started with `--api-key` (or RunPod serverless uses
 * the RunPod API key); Brain sends it as a Bearer token. The connect workflow
 * refuses an endpoint that answers without one.
 */
import type { LaneConfig } from './lane.ts';

export interface RunpodConfig {
  /** OpenAI-compatible base, ending in /v1. */
  url: string;
  key: string | null;
  /** The served model name vLLM reports on /v1/models. */
  model: string;
  /** The slot label the lane, its cache and its events use. */
  label: string;
}

export const RUNPOD_PREFIX = 'runpod/';

/** `https://<pod>-8000.proxy.runpod.net` or `.../v1`, or a serverless `.../openai/v1`; always ends in /v1. */
export function normalizeRunpodUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Read per call, like the lane's own config. Null unless the GPU is switched to primary. */
export function runpodConfig(env: NodeJS.ProcessEnv = process.env): RunpodConfig | null {
  const url = env['BRAIN_RUNPOD_URL']?.trim();
  const mode = (env['BRAIN_RUNPOD_MODE'] ?? 'off').trim().toLowerCase();
  if (!url || mode !== 'primary') return null;
  const model = env['BRAIN_RUNPOD_MODEL']?.trim() || 'Qwen/Qwen3-8B-AWQ';
  return {
    url: normalizeRunpodUrl(url),
    key: env['BRAIN_RUNPOD_KEY']?.trim() || null,
    model,
    label: `${RUNPOD_PREFIX}${model}`,
  };
}

export function isRunpodSlot(model: string): boolean {
  return model.startsWith(RUNPOD_PREFIX);
}

/* ------------------------------------------------------------------------- */
/* Breaker                                                                    */
/* ------------------------------------------------------------------------- */

/** Consecutive failures that open the breaker, and how long it stays open. */
export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 2 * 60_000;

const breaker = { failures: 0, openUntil: 0 };
const counts = { served: 0, fellBack: 0, skipped: 0 };

/*
 * Paused: the pod is stopped or still loading (`runpodPod.ts` decides). Every
 * GPU call goes straight to the free fallback, without a timeout and without
 * counting against the GPU, so stopping an idle pod never interrupts research.
 */
let paused: string | null = null;
export function setRunpodPaused(reason: string | null): void {
  paused = reason;
}
export function runpodPaused(): string | null {
  return paused;
}

/*
 * The GPU's own recent calls. The lane's per-model window cannot see a GPU
 * failure — the fallback answers it — so the capacity controller reads this to
 * size the GPU's slots by what the GPU itself did.
 */
const calls: { at: number; ok: boolean }[] = [];
function noteCall(ok: boolean, now: number): void {
  calls.push({ at: now, ok });
  if (calls.length > 2000) calls.splice(0, calls.length - 2000);
}
export function runpodCallWindow(ms: number, now = Date.now()): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  for (const call of calls) {
    if (call.at < now - ms) continue;
    if (call.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}

export function runpodBreakerOpen(now = Date.now()): boolean {
  return breaker.openUntil > now;
}

function recordFailure(now: number): void {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_FAILURES) {
    breaker.openUntil = now + BREAKER_OPEN_MS;
    breaker.failures = 0;
  }
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

/** Calls served by the GPU, answered by the fallback, and skipped by the breaker since boot. */
export function runpodReading(): { served: number; fellBack: number; skipped: number; breakerOpen: boolean } {
  return { ...counts, breakerOpen: runpodBreakerOpen() };
}

export function resetRunpod(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
  counts.served = 0;
  counts.fellBack = 0;
  counts.skipped = 0;
  paused = null;
  calls.length = 0;
}

/* ------------------------------------------------------------------------- */
/* The call                                                                   */
/* ------------------------------------------------------------------------- */

/** Qwen3 can think out loud; the lane's parsers want only the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

export type Fetch = typeof fetch;

/** One chat call to vLLM. Throws on anything but a 2xx with content. */
export async function runpodChat(
  runpod: RunpodConfig,
  system: string,
  prompt: string,
  options: { maxTokens: number; timeoutMs: number; fetchImpl?: Fetch },
): Promise<string> {
  const response = await (options.fetchImpl ?? fetch)(`${runpod.url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(runpod.key ? { authorization: `Bearer ${runpod.key}` } : {}),
    },
    body: JSON.stringify({
      model: runpod.model,
      // Qwen3's own advice for non-thinking mode, kept cool for fixed-shape answers.
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: options.maxTokens,
      // Closed tasks with a fixed JSON shape: thinking costs time and VRAM and adds nothing.
      chat_template_kwargs: { enable_thinking: false },
      // gpt-oss reasons before it answers and spends max_tokens doing it; low keeps lane answers whole (§108).
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    throw new Error(`runpod HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = stripThinking(body.choices?.[0]?.message?.content ?? '');
  if (!text) throw new Error('runpod returned an empty answer');
  return text;
}

/**
 * Answer one call on the RunPod slot: the GPU first, the free model it displaced
 * second. `fallback` is the lane's ordinary HTTP call to OmniRoute.
 */
export async function routeRunpod(
  config: LaneConfig,
  system: string,
  prompt: string,
  options: { maxTokens: number },
  fallback: (model: string) => Promise<string>,
  deps: { fetchImpl?: Fetch; now?: () => number } = {},
): Promise<string> {
  const runpod = config.runpod;
  const now = deps.now ?? Date.now;
  const backup = config.fallbackModel ?? null;
  const fallBack = async (why: string, quiet = false): Promise<string> => {
    if (!backup) throw new Error(`runpod unavailable and no free fallback: ${why}`);
    // A pod paused on purpose is not a GPU failure: no warning, no fallback count.
    if (!quiet) {
      counts.fellBack += 1;
      console.warn(`[runpod] fallback to ${backup}: ${why.slice(0, 200)}`);
    }
    return fallback(backup);
  };
  if (!runpod) return fallBack('runpod is not configured');
  if (paused) {
    counts.skipped += 1;
    return fallBack(`pod paused: ${paused}`, true);
  }
  if (runpodBreakerOpen(now())) {
    counts.skipped += 1;
    return fallBack('breaker open after repeated failures');
  }
  try {
    // Never wait longer on the GPU than the caller would wait on anyone.
    const text = await runpodChat(runpod, system, prompt, {
      maxTokens: options.maxTokens,
      timeoutMs: config.timeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    recordSuccess();
    counts.served += 1;
    noteCall(true, now());
    return text;
  } catch (error) {
    recordFailure(now());
    noteCall(false, now());
    return fallBack(error instanceof Error ? error.message : String(error));
  }
}
