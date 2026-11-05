/**
 * The RunPod GPU behind the cheap lane: off until switched to primary, then
 * slot A with the free model as its fallback and as slot B, so verification
 * stays on a different model. A failing GPU never stops the lane.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { laneConfig } from '../server/services/cheap/lane.ts';
import {
  BREAKER_FAILURES,
  normalizeRunpodUrl,
  resetRunpod,
  routeRunpod,
  runpodBreakerOpen,
  runpodConfig,
  runpodReading,
  stripThinking,
  type Fetch,
} from '../server/services/cheap/runpod.ts';

const free = { BRAIN_CHEAP_LLM_URL: 'https://cheap.test/v1', BRAIN_CHEAP_LLM_KEY: 'free-key', BRAIN_CHEAP_LLM_MODELS: 'fast,smart' };
const gpu = { BRAIN_RUNPOD_URL: 'https://abc123-8000.proxy.runpod.net', BRAIN_RUNPOD_KEY: 'gpu-key', BRAIN_RUNPOD_MODEL: 'Qwen/Qwen3-8B-AWQ' };

function reply(status: number, content: string, calls: { url: string; body: Record<string, unknown>; auth: string | null }[]): Fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), auth: headers['authorization'] ?? null });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as Fetch;
}

beforeEach(() => resetRunpod());

describe('configuration', () => {
  it('is off unless the URL is set and the mode is primary', () => {
    expect(runpodConfig({})).toBeNull();
    expect(runpodConfig(gpu)).toBeNull();
    expect(runpodConfig({ ...gpu, BRAIN_RUNPOD_MODE: 'shadow' })).toBeNull();
    expect(runpodConfig({ ...gpu, BRAIN_RUNPOD_MODE: 'primary' })?.url).toBe('https://abc123-8000.proxy.runpod.net/v1');
  });

  it('normalizes the pod and serverless address forms', () => {
    expect(normalizeRunpodUrl('https://x-8000.proxy.runpod.net/')).toBe('https://x-8000.proxy.runpod.net/v1');
    expect(normalizeRunpodUrl('https://x-8000.proxy.runpod.net/v1/chat/completions')).toBe('https://x-8000.proxy.runpod.net/v1');
    expect(normalizeRunpodUrl('https://api.runpod.ai/v2/ep1/openai/v1')).toBe('https://api.runpod.ai/v2/ep1/openai/v1');
  });

  it('leaves the free lane exactly as it was while RunPod is off', () => {
    const config = laneConfig({ ...free, ...gpu });
    expect(config?.models).toEqual(['fast', 'smart']);
    expect(config?.runpod).toBeNull();
    expect(config?.url).toBe('https://cheap.test/v1');
  });

  it('in primary mode puts the GPU in slot A and the first free model in slot B and as fallback', () => {
    const config = laneConfig({ ...free, ...gpu, BRAIN_RUNPOD_MODE: 'primary' });
    expect(config?.models).toEqual(['runpod/Qwen/Qwen3-8B-AWQ', 'fast']);
    expect(config?.fallbackModel).toBe('fast');
    expect(config?.key).toBe('free-key');
  });

  it('runs the lane on the GPU alone when no free address is set', () => {
    const config = laneConfig({ ...gpu, BRAIN_RUNPOD_MODE: 'primary' });
    expect(config?.models).toEqual(['runpod/Qwen/Qwen3-8B-AWQ']);
    expect(config?.fallbackModel).toBeNull();
  });
});

describe('routing', () => {
  const config = laneConfig({ ...free, ...gpu, BRAIN_RUNPOD_MODE: 'primary' })!;

  it('answers on the GPU with its own key, thinking off, and strips any thinking', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const text = await routeRunpod(config, 'sys', 'p', { maxTokens: 500 }, async () => 'fallback', {
      fetchImpl: reply(200, '<think>hmm {x}</think>{"verdict":"KEEP"}', calls),
    });
    expect(text).toBe('{"verdict":"KEEP"}');
    expect(calls[0]!.url).toBe('https://abc123-8000.proxy.runpod.net/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer gpu-key');
    expect(calls[0]!.body['model']).toBe('Qwen/Qwen3-8B-AWQ');
    expect(calls[0]!.body['chat_template_kwargs']).toEqual({ enable_thinking: false });
    expect(runpodReading().served).toBe(1);
  });

  it('falls back to the free model when the GPU fails, and opens the breaker after repeated failures', async () => {
    const used: string[] = [];
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    for (let i = 0; i < BREAKER_FAILURES; i += 1) {
      const text = await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async (m) => (used.push(m), 'free answer'), {
        fetchImpl: reply(503, 'down', calls),
      });
      expect(text).toBe('free answer');
    }
    expect(used).toEqual(['fast', 'fast', 'fast']);
    expect(runpodBreakerOpen()).toBe(true);
    await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async () => 'free answer', { fetchImpl: reply(503, 'x', calls) });
    expect(calls).toHaveLength(BREAKER_FAILURES);
    expect(runpodReading()).toMatchObject({ fellBack: BREAKER_FAILURES + 1, skipped: 1 });
  });

  it('tries the GPU again once the breaker has aged out', async () => {
    let clock = 1_000;
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    for (let i = 0; i < BREAKER_FAILURES; i += 1) {
      await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async () => 'f', { fetchImpl: reply(500, '', calls), now: () => clock });
    }
    clock += 10 * 60_000;
    const text = await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async () => 'f', { fetchImpl: reply(200, 'ok', calls), now: () => clock });
    expect(text).toBe('ok');
    expect(runpodBreakerOpen(clock)).toBe(false);
  });

  it('with no free fallback, a GPU failure is a failed call the lane already handles', async () => {
    const alone = laneConfig({ ...gpu, BRAIN_RUNPOD_MODE: 'primary' })!;
    await expect(
      routeRunpod(alone, 's', 'p', { maxTokens: 10 }, async () => 'never', { fetchImpl: reply(502, '', []) }),
    ).rejects.toThrow(/runpod unavailable/);
  });

  it('strips an unclosed thinking prefix', () => {
    expect(stripThinking('reasoning...</think>\n{"a":1}')).toBe('{"a":1}');
  });
});
