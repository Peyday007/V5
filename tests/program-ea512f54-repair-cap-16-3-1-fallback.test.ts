/**
 * CAP-16-3 repair, episode 1: the probe read 15 accepted of 137 lane outcomes
 * with 80% provider failures. Both cheap-lane routes ended at one OmniRoute
 * model — slot B was free[0] and the GPU's fallback was the same free[0] — so
 * one provider rate-limiting took both slots down together. These tests pin the
 * repair: a fallback that can be named apart from slot B, Retry-After carried, a dead pod recovered through
 * the existing `ensurePod` path once, and the failure text naming its cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpCompleter, laneConfig, laneHttpError, retryAfterSeconds, type LaneConfig } from '../server/services/cheap/lane.ts';
import {
  classifyGpuFailure,
  resetRunpod,
  routeRunpod,
  runpodConfig,
  runpodRecoveryReading,
  type Fetch,
  type PodRestorer,
} from '../server/services/cheap/runpod.ts';
import { ensurePod } from '../server/services/cheap/runpodRestore.ts';
import { classifyRouteFailure } from '../server/services/freeLane/worker.ts';

const free = { BRAIN_CHEAP_LLM_URL: 'https://omni.test/v1', BRAIN_CHEAP_LLM_KEY: 'free-key', BRAIN_CHEAP_LLM_MODELS: 'fast,smart' };
const gpu = { BRAIN_RUNPOD_URL: 'https://abc123-8000.proxy.runpod.net', BRAIN_RUNPOD_KEY: 'gpu-key', BRAIN_RUNPOD_MODE: 'primary' };

function status(code: number, headers: Record<string, string> = {}, body = ''): Fetch {
  return (async () => new Response(body, { status: code, headers })) as unknown as Fetch;
}

beforeEach(() => resetRunpod());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the GPU fallback can be taken off slot B\'s model', () => {
  it('with BRAIN_RUNPOD_FALLBACK_MODEL naming the second free model, the fallback differs from slot B', () => {
    const config = laneConfig({ ...free, ...gpu, BRAIN_RUNPOD_FALLBACK_MODEL: 'smart' })!;
    expect(config.models).toEqual(['runpod/Qwen/Qwen3-8B-AWQ', 'fast']);
    expect(config.fallbackModel).toBe('smart');
    expect(config.fallbackModel).not.toBe(config.models[1]);
  });

  it('can name OmniRoute auto as the fallback', () => {
    const config = laneConfig({ ...free, ...gpu, BRAIN_CHEAP_LLM_MODELS: 'fast', BRAIN_RUNPOD_FALLBACK_MODEL: 'auto' })!;
    expect(config.models[1]).toBe('fast');
    expect(config.fallbackModel).toBe('auto');
  });

  it('unset, the fallback is slot B\'s model as before', () => {
    const config = laneConfig({ ...free, ...gpu, BRAIN_RUNPOD_FALLBACK_MODEL: '  ' })!;
    expect(config.fallbackModel).toBe('fast');
  });

  it('a GPU call that falls back asks the named fallback, not slot B', async () => {
    const config = laneConfig({ ...free, ...gpu, BRAIN_RUNPOD_FALLBACK_MODEL: 'smart' })!;
    const asked: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async (m) => (asked.push(m), 'ok'), { fetchImpl: status(503) });
    expect(asked).toEqual(['smart']);
  });
});

describe('a provider refusal carries its status, provider and retry delay', () => {
  it('parses Retry-After as seconds or as an HTTP date', () => {
    expect(retryAfterSeconds('30')).toBe(30);
    expect(retryAfterSeconds(new Date(Date.UTC(2026, 10, 15, 0, 1, 0)).toUTCString(), Date.UTC(2026, 10, 15, 0, 0, 0))).toBe(60);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('soon')).toBeNull();
  });

  it('a 429 with Retry-After yields a message with the delay and the HTTP status', async () => {
    vi.stubGlobal('fetch', status(429, { 'retry-after': '42' }, 'rate limited, model not available'));
    const config = laneConfig(free)!;
    const error = await httpCompleter(config, 'fast', 's', 'p').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/cheap lane HTTP 429/);
    expect(message).toMatch(/omni\.test model fast/);
    expect(message).toMatch(/retry-after 42s/);
    expect(classifyRouteFailure(message)).toBe('provider availability');
  });

  it('a 503 with Retry-After is provider availability with its delay', async () => {
    const message = await laneHttpError(new Response('', { status: 503, headers: { 'retry-after': '7' } }), 'https://omni.test/v1', 'smart');
    expect(message).toMatch(/HTTP 503/);
    expect(message).toMatch(/retry-after 7s/);
    expect(classifyRouteFailure(message)).toBe('provider availability');
  });

  it('401 and 403 are credentials, not overload, and no key reaches the text', async () => {
    for (const code of [401, 403]) {
      const message = await laneHttpError(
        new Response('invalid api key Bearer sk-abcdefghijklmnop', { status: code }),
        'https://omni.test/v1',
        'fast',
      );
      expect(message).toMatch(new RegExp(`HTTP ${code}`));
      expect(message).not.toMatch(/sk-abcdefghijklmnop/);
      expect(classifyRouteFailure(message)).toBe('credentials');
    }
  });
});

describe('a dead pod is told from an overloaded one, and recovered once', () => {
  const fullConfig = (): LaneConfig => laneConfig({ ...free, ...gpu })!;
  const env = { ...gpu, BRAIN_RUNPOD_API_KEY: 'acct-key', RUNPOD_MAX_USD_PER_HOUR: '0.24' };

  it('classifies 404 and refused connections as a dead pod, 401/403 as credentials, the rest as overload', () => {
    expect(classifyGpuFailure(new Error('runpod HTTP 404'))).toBe('dead pod');
    expect(classifyGpuFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('dead pod');
    expect(classifyGpuFailure(new Error('runpod HTTP 401 bad key'))).toBe('credentials');
    expect(classifyGpuFailure(new Error('runpod HTTP 503 overloaded'))).toBe('overload');
    expect(classifyGpuFailure(new Error('The operation was aborted due to timeout'))).toBe('overload');
  });

  it('a 404 from the proxy invokes the recovery path once, under the price ceiling, and still falls back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restored: Parameters<PodRestorer>[0][] = [];
    const restore: PodRestorer = async (input) => {
      restored.push(input);
      return { url: 'https://newpod1-8000.proxy.runpod.net/v1', created: true, log: [] };
    };
    const config = fullConfig();
    for (let i = 0; i < 3; i += 1) {
      const text = await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async () => 'free answer', {
        fetchImpl: status(404),
        restore,
        env,
      });
      expect(text).toBe('free answer');
      await runpodRecoveryReading().pending;
    }
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ apiKey: 'acct-key', vllmKey: 'gpu-key', maxUsdPerHour: 0.24 });
    expect(runpodRecoveryReading().attempts).toBe(1);
    // The recovered pod is the GPU's address until the secret itself changes.
    expect(runpodConfig(gpu)?.url).toBe('https://newpod1-8000.proxy.runpod.net/v1');
    expect(runpodConfig({ ...gpu, BRAIN_RUNPOD_URL: 'https://other9-8000.proxy.runpod.net' })?.url).toBe('https://other9-8000.proxy.runpod.net/v1');
  });

  it('overload never invokes recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = vi.fn<PodRestorer>();
    await routeRunpod(fullConfig(), 's', 'p', { maxTokens: 10 }, async () => 'f', { fetchImpl: status(503), restore, env });
    await routeRunpod(fullConfig(), 's', 'p', { maxTokens: 10 }, async () => 'f', { fetchImpl: status(429), restore, env });
    expect(restore).not.toHaveBeenCalled();
  });

  it('without the RunPod account key, a dead pod spends nothing and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = vi.fn<PodRestorer>();
    await routeRunpod(fullConfig(), 's', 'p', { maxTokens: 10 }, async () => 'f', { fetchImpl: status(404), restore, env: gpu });
    expect(restore).not.toHaveBeenCalled();
    expect(runpodRecoveryReading().last).toMatch(/BRAIN_RUNPOD_API_KEY/);
  });

  it('without a person-set price ceiling, a dead pod spends nothing and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = vi.fn<PodRestorer>();
    await routeRunpod(fullConfig(), 's', 'p', { maxTokens: 10 }, async () => 'f', {
      fetchImpl: status(404),
      restore,
      env: { ...gpu, BRAIN_RUNPOD_API_KEY: 'acct-key' },
    });
    expect(restore).not.toHaveBeenCalled();
    expect(runpodRecoveryReading().last).toMatch(/RUNPOD_MAX_USD_PER_HOUR/);
  });

  it('the real ensurePod keeps its ceiling: a pod priced above it is deleted', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if ((init?.method ?? 'GET') === 'GET') return new Response('[]', { status: 200 });
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'dear1', costPerHr: 0.9 }), { status: 200 });
      return new Response('', { status: 200 });
    }) as unknown as Fetch;
    await expect(ensurePod({ apiKey: 'a', vllmKey: 'v', oldUrl: 'https://gone1-8000.proxy.runpod.net/v1', maxUsdPerHour: 0.24, fetchImpl })).rejects.toThrow(/no pod within \$0.24\/h/);
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('dear1'))).toBe(true);
  });
});
