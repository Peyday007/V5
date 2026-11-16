/**
 * CAP-16-3 repair (episode 2), the call layer: a provider that refuses is backed
 * off for every caller, a refused call is answered by the next route of its
 * chain, and a call fails only when every route refused — naming each one.
 *
 * Production, 2026-11-15 20:00–23:00Z: probe r01.cap-16-3 read 64–98% of the
 * free lane's six-hour outcomes as "model call failed", while every concurrent
 * slot kept sending to the provider that was refusing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_ROUTE_MS,
  ROUTE_BACKOFF_BASE_MS,
  busyStatus,
  httpCompleter,
  laneConfig,
  parseRetryAfter,
  resetRouteBackoff,
  routeBackoff,
  routeBudget,
  type LaneConfig,
} from '../server/services/cheap/lane.ts';
import { resetRunpod } from '../server/services/cheap/runpod.ts';
import { PROVIDER_BUSY, classifyRouteFailure } from '../server/services/freeLane/worker.ts';

const SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz';

interface Seen {
  model: string;
  url: string;
}

/** A fetch whose answer is decided per model; records which model every request named. */
function stubFetch(answer: (model: string, n: number) => { status: number; body?: string; headers?: Record<string, string> }): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const model = String((JSON.parse(init.body) as { model: string }).model);
    seen.push({ model, url: String(url) });
    const reply = answer(model, seen.filter((s) => s.model === model).length);
    const text = reply.body ?? JSON.stringify({ choices: [{ message: { content: `answer from ${model}` } }] });
    return new Response(text, { status: reply.status, headers: reply.headers ?? {} });
  });
  return seen;
}

function config(over: Partial<LaneConfig> = {}): LaneConfig {
  return {
    url: 'https://router.invalid/v1',
    key: SECRET,
    models: ['primary'],
    dailyBudget: 100,
    timeoutMs: 30_000,
    runpod: null,
    fallbackModel: null,
    fallbacks: ['spare'],
    ...over,
  };
}

beforeEach(() => {
  resetRouteBackoff();
  resetRunpod();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('failover across configured routes', () => {
  it('answers a call its own route refuses as busy from the next route, in the same call', async () => {
    const seen = stubFetch((model) => (model === 'primary' ? { status: 429 } : { status: 200 }));
    const text = await httpCompleter(config(), 'primary', 's', 'p');
    expect(text).toBe('answer from spare');
    expect(seen.map((s) => s.model)).toEqual(['primary', 'spare']);
  });

  it.each([408, 409, 425, 429, 500, 502, 503, 504])('fails over on HTTP %i', async (status) => {
    stubFetch((model) => (model === 'primary' ? { status } : { status: 200 }));
    expect(await httpCompleter(config(), 'primary', 's', 'p')).toBe('answer from spare');
  });

  it('never answers one slot from the other slot (a claim is verified by a different model, §85)', async () => {
    const seen = stubFetch((model) => (model === 'b' ? { status: 503 } : { status: 200 }));
    await expect(httpCompleter(config({ models: ['a', 'b'], fallbacks: ['a'] }), 'b', 's', 'p')).rejects.toThrow(/HTTP 503/);
    expect(seen.map((s) => s.model)).toEqual(['b']);
  });

  it('does not fail over on a credential or routing refusal: it is not the provider being busy', async () => {
    const seen = stubFetch((model) => (model === 'primary' ? { status: 401 } : { status: 200 }));
    await expect(httpCompleter(config(), 'primary', 's', 'p')).rejects.toThrow('cheap lane HTTP 401');
    expect(seen.map((s) => s.model)).toEqual(['primary']);
  });

  it('answers the GPU slot from its free fallback, and the free fallback from the next route', async () => {
    const seen = stubFetch((model) => (model === 'Qwen/Qwen3-8B-AWQ' ? { status: 503 } : model === 'free' ? { status: 429 } : { status: 200 }));
    const gpu = config({
      models: ['runpod/Qwen/Qwen3-8B-AWQ', 'free'],
      runpod: { url: 'https://pod.invalid/v1', key: null, model: 'Qwen/Qwen3-8B-AWQ', label: 'runpod/Qwen/Qwen3-8B-AWQ' },
      fallbackModel: 'free',
      fallbacks: ['spare'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await httpCompleter(gpu, 'runpod/Qwen/Qwen3-8B-AWQ', 's', 'p')).toBe('answer from spare');
    expect(seen.map((s) => s.model)).toEqual(['Qwen/Qwen3-8B-AWQ', 'free', 'spare']);
  });
});

describe('shared backoff', () => {
  it('a route that answered 429 with Retry-After is not called again before that time by any caller', async () => {
    const seen = stubFetch(() => ({ status: 429, headers: { 'retry-after': '120' } }));
    const single = config({ fallbacks: [] });
    await expect(httpCompleter(single, 'primary', 's', 'p')).rejects.toThrow(/HTTP 429/);
    expect(seen).toHaveLength(1);
    const held = routeBackoff(single, 'primary');
    expect(held).not.toBeNull();
    expect(held!.until - Date.now()).toBeGreaterThan(110_000);
    // Concurrent callers meet the backoff and send nothing.
    const results = await Promise.allSettled([1, 2, 3].map(() => httpCompleter(single, 'primary', 's', 'p')));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(seen).toHaveLength(1);
    // The refusal still reads as the provider being busy, so the worker attributes it.
    const message = String((results[0] as PromiseRejectedResult).reason.message);
    expect(PROVIDER_BUSY.test(message)).toBe(true);
    expect(classifyRouteFailure(message)).toBe('provider availability');
  });

  it('a backed-off route sends its callers to the next route without touching it', async () => {
    const seen = stubFetch((model) => (model === 'primary' ? { status: 429, headers: { 'retry-after': '300' } } : { status: 200 }));
    await httpCompleter(config(), 'primary', 's', 'p');
    await httpCompleter(config(), 'primary', 's', 'p');
    expect(seen.map((s) => s.model)).toEqual(['primary', 'spare', 'spare']);
  });

  it('waits out a short Retry-After inside the call budget and is answered by the same route', async () => {
    const seen = stubFetch((_model, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '0.05' } } : { status: 200 }));
    expect(await httpCompleter(config({ fallbacks: [] }), 'primary', 's', 'p')).toBe('answer from primary');
    expect(seen).toHaveLength(2);
    expect(routeBackoff(config({ fallbacks: [] }), 'primary')).toBeNull();
  });

  it('without Retry-After the backoff grows from the base and an answer clears it', async () => {
    let refuse = true;
    stubFetch(() => (refuse ? { status: 503 } : { status: 200 }));
    const single = config({ fallbacks: [], timeoutMs: 1_000 });
    await expect(httpCompleter(single, 'primary', 's', 'p')).rejects.toThrow(/HTTP 503/);
    const first = routeBackoff(single, 'primary')!.until - Date.now();
    expect(first).toBeGreaterThan(ROUTE_BACKOFF_BASE_MS - 1_000);
    expect(first).toBeLessThanOrEqual(ROUTE_BACKOFF_BASE_MS);
    resetRouteBackoff();
    refuse = false;
    expect(await httpCompleter(single, 'primary', 's', 'p')).toBe('answer from primary');
    expect(routeBackoff(single, 'primary')).toBeNull();
  });
});

describe('every route refused', () => {
  it('names each route and its own refusal, and never the credential', async () => {
    stubFetch((model) => (model === 'primary' ? { status: 429 } : { status: 503 }));
    const error = await httpCompleter(config(), 'primary', 's', 'p').then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/primary: .*HTTP 429/);
    expect(error!.message).toMatch(/spare: .*HTTP 503/);
    expect(error!.message).not.toContain(SECRET);
    expect(classifyRouteFailure(error!.message)).toBe('provider availability');
  });

  it('with a single route and no GPU the refusal is the route’s own, as before', async () => {
    stubFetch(() => ({ status: 503 }));
    await expect(httpCompleter(config({ fallbacks: [] }), 'primary', 's', 'p')).rejects.toThrow('cheap lane HTTP 503');
  });
});

describe('configuration', () => {
  it('reads fallback routes from the same address and never repeats a slot', () => {
    const c = laneConfig({ BRAIN_CHEAP_LLM_URL: 'https://router.invalid/v1', BRAIN_CHEAP_LLM_MODELS: 'a,b', BRAIN_CHEAP_LLM_FALLBACK_MODELS: 'b, c ,c,d' });
    expect(c!.models).toEqual(['a', 'b']);
    expect(c!.fallbacks).toEqual(['c', 'd']);
  });

  it('adds nothing to the config when no fallback is set', () => {
    const c = laneConfig({ BRAIN_CHEAP_LLM_URL: 'https://router.invalid/v1' });
    expect(c).not.toHaveProperty('fallbacks');
  });

  it('reads Retry-After as seconds or a date, and classifies busy statuses', () => {
    const now = Date.parse('2026-11-15T23:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Sun, 15 Nov 2026 23:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
    expect([408, 409, 413, 425, 429, 500, 503].every(busyStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(busyStatus)).toBe(false);
  });
});

/**
 * Review finding F3: every route of a chain shared one clock, so after the first
 * route timed out the next was sent with a 1 ms signal, aborted at once, and was
 * itself backed off for every caller for a timeout it never had.
 */
describe('a timed-out route does not spend or poison the next route (repair-F3)', () => {
  /** A fetch where the named models never answer until their signal aborts them; the rest answer. */
  function hangingFetch(hang: readonly string[]): { seen: Seen[]; budgets: Map<string, number> } {
    const seen: Seen[] = [];
    const budgets = new Map<string, number>();
    vi.stubGlobal('fetch', (url: string, init: { body: string; signal: AbortSignal }) => {
      const model = String((JSON.parse(init.body) as { model: string }).model);
      seen.push({ model, url: String(url) });
      const sent = Date.now();
      if (!hang.includes(model)) {
        // A healthy route still takes a moment to answer, and honours its signal like any request.
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: `answer from ${model}` } }] }), { status: 200 })),
            50,
          );
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal.reason ?? new Error('This operation was aborted'));
          });
        });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          budgets.set(model, Date.now() - sent);
          reject(init.signal.reason ?? new Error('This operation was aborted'));
        });
      });
    });
    return { seen, budgets };
  }

  it('answers from the next route with its own time after the first route timed out, and backs off only the route that timed out', async () => {
    const c = config({ timeoutMs: 400 });
    const { seen } = hangingFetch(['primary']);
    const text = await httpCompleter(c, 'primary', 's', 'p');
    expect(text).toBe('answer from spare');
    expect(seen.map((s) => s.model)).toEqual(['primary', 'spare']);
    expect(routeBackoff(c, 'primary')).not.toBeNull();
    expect(routeBackoff(c, 'spare')).toBeNull();
  });

  it('gives a fallback that also hangs a real budget, not the 1 ms the first route left', async () => {
    const c = config({ timeoutMs: 400 });
    const { budgets } = hangingFetch(['primary', 'spare']);
    await expect(httpCompleter(c, 'primary', 's', 'p')).rejects.toThrow(/every route refused/);
    expect(budgets.get('primary')!).toBeGreaterThanOrEqual(300);
    expect(budgets.get('spare')!).toBeGreaterThanOrEqual(300);
  });

  it('does not send, and does not back off, a route the call has no time left for', async () => {
    const c = config({ timeoutMs: 400, fallbacks: ['spare', 'third'] });
    const { seen } = hangingFetch(['primary', 'spare']);
    await expect(httpCompleter(c, 'primary', 's', 'p')).rejects.toThrow(/third: not tried, the call's time was spent/);
    expect(seen.map((s) => s.model)).toEqual(['primary', 'spare']);
    expect(routeBackoff(c, 'third')).toBeNull();
  });

  it('a single-route call keeps exactly its one timeout', () => {
    const now = 1_000_000;
    expect(routeBudget({ timeoutMs: 30_000 }, now + 30_000, now)).toBe(30_000);
    expect(routeBudget({ timeoutMs: 30_000 }, now + 60_000, now)).toBe(30_000);
    expect(routeBudget({ timeoutMs: 30_000 }, now + 12_000, now)).toBe(12_000);
    expect(routeBudget({ timeoutMs: 30_000 }, now + MIN_ROUTE_MS - 1, now)).toBe(0);
  });
});
