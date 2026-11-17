/**
 * The RunPod pod's power: stopped when no useful research is left, started when
 * some arrives, and the GPU slot paused onto the free model while the pod is
 * off or loading, so research is never interrupted by it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { laneConfig } from '../server/services/cheap/lane.ts';
import { resetRunpod, routeRunpod, runpodCallWindow, runpodPaused, runpodReading, type Fetch } from '../server/services/cheap/runpod.ts';
import {
  DEFAULT_IDLE_STOP_MS,
  DEFAULT_PRIMARY_BUDGET_USD,
  MIN_ACTION_GAP_MS,
  budgetEvent,
  budgetReading,
  decidePod,
  podBudget,
  podConfig,
  podIdFromUrl,
  resetPodSupervisor,
  superviseRunpodPod,
  windowSpendFromRows,
  type PodConfig,
  type PodRow,
} from '../server/services/cheap/runpodPod.ts';
import { gpuCeiling } from '../server/services/freeLane/capacity.ts';

const base = { status: 'RUNNING' as const, waiting: 0, inFlight: 0, idleSince: null, lastActionAt: 0, now: 10 * 3_600_000, idleStopMs: DEFAULT_IDLE_STOP_MS };
const config: PodConfig = { apiKey: 'rp-account-key', podId: 'yxabw9083tp8hk', idleStopMs: DEFAULT_IDLE_STOP_MS, vllm: { url: 'https://yxabw9083tp8hk-8000.proxy.runpod.net/v1', key: 'vllm-key' } };

beforeEach(() => {
  resetRunpod();
  resetPodSupervisor();
});

describe('configuration', () => {
  it('reads the pod id from the proxy address', () => {
    expect(podIdFromUrl('https://yxabw9083tp8hk-8000.proxy.runpod.net/v1')).toBe('yxabw9083tp8hk');
    expect(podIdFromUrl('https://api.runpod.ai/v2/abc/openai/v1')).toBeNull();
  });

  it('is off without the RunPod account key, or when the GPU is not primary, or when turned off', () => {
    const gpu = { BRAIN_RUNPOD_URL: 'https://yxabw9083tp8hk-8000.proxy.runpod.net/v1', BRAIN_RUNPOD_MODE: 'primary' };
    expect(podConfig(gpu)).toBeNull();
    expect(podConfig({ ...gpu, BRAIN_RUNPOD_MODE: 'off', BRAIN_RUNPOD_API_KEY: 'k' })).toBeNull();
    expect(podConfig({ ...gpu, BRAIN_RUNPOD_API_KEY: 'k', BRAIN_RUNPOD_AUTOSTOP: 'off' })).toBeNull();
    expect(podConfig({ ...gpu, BRAIN_RUNPOD_API_KEY: 'k', BRAIN_RUNPOD_IDLE_STOP_MINUTES: '30' })).toMatchObject({ apiKey: 'k', podId: 'yxabw9083tp8hk', idleStopMs: 30 * 60_000, vllm: { url: 'https://yxabw9083tp8hk-8000.proxy.runpod.net/v1' } });
  });

  it("guards the GPU's slots with its own ceiling", () => {
    expect(gpuCeiling({})).toBe(32);
    expect(gpuCeiling({ BRAIN_RUNPOD_MAX_SLOTS: '12' })).toBe(12);
  });
});

describe('the decision', () => {
  it('keeps a pod with work waiting or in flight running', () => {
    expect(decidePod({ ...base, waiting: 3, idleSince: 0 }).action).toBe('NONE');
    expect(decidePod({ ...base, inFlight: 1, idleSince: 0 }).action).toBe('NONE');
  });

  it('stops a pod only after it has been idle for the whole idle period', () => {
    expect(decidePod({ ...base, idleSince: base.now - DEFAULT_IDLE_STOP_MS + 60_000 }).action).toBe('NONE');
    expect(decidePod({ ...base, idleSince: base.now - DEFAULT_IDLE_STOP_MS }).action).toBe('STOP');
    // RunPod refused a recent start of this pod: idle or not, it is not stopped again.
    expect(decidePod({ ...base, idleSince: base.now - DEFAULT_IDLE_STOP_MS, startFailedRecently: true }).action).toBe('NONE');
    // Starting a stopped pod for waiting research is never held back by it.
    expect(decidePod({ ...base, status: 'EXITED', waiting: 2, startFailedRecently: true }).action).toBe('START');
  });

  it('starts a stopped pod when research arrives, and never one with nothing to do', () => {
    expect(decidePod({ ...base, status: 'EXITED', waiting: 2 }).action).toBe('START');
    expect(decidePod({ ...base, status: 'EXITED', waiting: 0 }).action).toBe('NONE');
  });

  it('does not flip the pod twice within the gap', () => {
    expect(decidePod({ ...base, status: 'EXITED', waiting: 2, lastActionAt: base.now - MIN_ACTION_GAP_MS + 1 }).action).toBe('NONE');
  });

  it('changes nothing on a terminated or unreadable pod', () => {
    expect(decidePod({ ...base, status: 'TERMINATED', waiting: 5 }).action).toBe('NONE');
    expect(decidePod({ ...base, status: 'UNKNOWN', idleSince: 0 }).action).toBe('NONE');
  });
});

/** A fake RunPod API and vLLM: records calls, answers with the pod's status. */
function fakeRunpod(pod: { status: string; vllm: boolean }) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url: String(url), auth: headers['authorization'] ?? null });
    const u = String(url);
    if (u.endsWith('/stop')) {
      pod.status = 'EXITED';
      return new Response('{}', { status: 200 });
    }
    if (u.endsWith('/start')) {
      pod.status = 'RUNNING';
      return new Response('{}', { status: 200 });
    }
    if (u.includes('rest.runpod.io')) return new Response(JSON.stringify({ desiredStatus: pod.status, costPerHr: 0.24, lastStartedAt: '1970-01-01T09:59:00.000Z' }), { status: 200 });
    return new Response('{"data":[]}', { status: pod.vllm ? 200 : 503 });
  }) as Fetch;
  return { calls, fetchImpl };
}

describe('the supervisor', () => {
  it('stops an idle pod with the RunPod account key, and pauses the GPU slot', async () => {
    const pod = { status: 'RUNNING', vllm: true };
    const { calls, fetchImpl } = fakeRunpod(pod);
    let t = 10 * 3_600_000;
    const now = () => t;
    const lastStartFailed = async () => false;
    const first = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config, fetchImpl, now, force: true, lastStartFailed });
    expect(first?.decision.action).toBe('NONE');
    expect(runpodPaused()).toBeNull();
    t += DEFAULT_IDLE_STOP_MS;
    const second = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config, fetchImpl, now, force: true, lastStartFailed });
    expect(second?.decision.action).toBe('STOP');
    expect(second?.acted).toBe(true);
    expect(pod.status).toBe('EXITED');
    expect(runpodPaused()).toBe('pod stopped');
    const stop = calls.find((c) => c.url.endsWith('/stop'))!;
    expect(stop).toMatchObject({ method: 'POST', url: 'https://rest.runpod.io/v1/pods/yxabw9083tp8hk/stop', auth: 'Bearer rp-account-key' });
    // vLLM is asked with its own key, never the account key.
    expect(calls.find((c) => c.url.endsWith('/v1/models'))?.auth).toBe('Bearer vllm-key');
  });

  it('never stops an idle pod again once RunPod refused to start it (its GPU may be gone)', async () => {
    const pod = { status: 'RUNNING', vllm: true };
    const { calls, fetchImpl } = fakeRunpod(pod);
    let t = 10 * 3_600_000;
    const lastStartFailed = async () => true;
    await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config, fetchImpl, now: () => t, force: true, lastStartFailed });
    t += 2 * DEFAULT_IDLE_STOP_MS;
    const later = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config, fetchImpl, now: () => t, force: true, lastStartFailed });
    expect(later?.decision.reason).toMatch(/refused a recent start/);
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);
    expect(pod.status).toBe('RUNNING');
  });

  it('never stops while research is waiting or in flight', async () => {
    const pod = { status: 'RUNNING', vllm: true };
    const { calls, fetchImpl } = fakeRunpod(pod);
    let t = 0;
    for (let i = 0; i < 40; i += 1) {
      t += 60_000;
      await superviseRunpodPod({ waiting: i % 2, inFlight: 1 - (i % 2) }, { config, fetchImpl, now: () => t, force: true });
    }
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);
    expect(pod.status).toBe('RUNNING');
  });

  it('starts a stopped pod when research arrives, and keeps the slot paused until vLLM answers', async () => {
    const pod = { status: 'EXITED', vllm: false };
    const { calls, fetchImpl } = fakeRunpod(pod);
    let t = 10 * 3_600_000;
    const idle = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config, fetchImpl, now: () => t, force: true });
    expect(idle?.decision.action).toBe('NONE');
    expect(runpodPaused()).toBe('pod exited');
    t += 60_000;
    const started = await superviseRunpodPod({ waiting: 4, inFlight: 0 }, { config, fetchImpl, now: () => t, force: true });
    expect(started?.decision.action).toBe('START');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/yxabw9083tp8hk/start'))).toBe(true);
    expect(runpodPaused()).toBe('pod starting');
    t += 60_000;
    await superviseRunpodPod({ waiting: 4, inFlight: 2 }, { config, fetchImpl, now: () => t, force: true });
    expect(runpodPaused()).toBe('vLLM still loading');
    pod.vllm = true;
    t += 60_000;
    await superviseRunpodPod({ waiting: 4, inFlight: 2 }, { config, fetchImpl, now: () => t, force: true });
    expect(runpodPaused()).toBeNull();
  });

  it('does nothing at all when not configured', async () => {
    expect(await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config: null, force: true })).toBeNull();
  });
});

describe('the dollar budget (owner 2026-11-16: continuous GPU operation under automatic budget control)', () => {
  const budgetOf = (usd: number) => ({ usd, windowMs: 24 * 3_600_000, defaulted: false });

  it('reads the budget from the environment, and caps a primary GPU by default', () => {
    expect(podBudget({})).toBeNull();
    expect(podBudget({ BRAIN_RUNPOD_MODE: 'primary' })).toEqual({ usd: DEFAULT_PRIMARY_BUDGET_USD, windowMs: 24 * 3_600_000, defaulted: true });
    expect(podBudget({ BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_BUDGET_USD: '25', BRAIN_RUNPOD_BUDGET_WINDOW_HOURS: '12' })).toEqual({ usd: 25, windowMs: 12 * 3_600_000, defaulted: false });
    expect(podBudget({ BRAIN_RUNPOD_BUDGET_USD: 'lots' })).toBeNull();
    const gpu = { BRAIN_RUNPOD_URL: 'https://yxabw9083tp8hk-8000.proxy.runpod.net/v1', BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_API_KEY: 'k' };
    expect(podConfig(gpu)?.budget).toMatchObject({ usd: 10, defaulted: true });
  });

  it('stops a busy pod and refuses every start once spend reaches the budget; an unreadable spend refuses starts only', () => {
    const now = base.now;
    const over = budgetReading(budgetOf(5), 5.01, now);
    const under = budgetReading(budgetOf(5), 4.99, now);
    const unknown = budgetReading(budgetOf(5), null, now);
    expect(over).toMatchObject({ spent: 5.01, budget: 5, remaining: 0, exhausted: true, known: true });
    expect(under.exhausted).toBe(false);
    expect(under.remaining).toBeCloseTo(0.01, 5);
    // Over budget: stopped even with research in flight and after a refused start.
    expect(decidePod({ ...base, inFlight: 4, waiting: 9, budget: over, startFailedRecently: true })).toMatchObject({ action: 'STOP', reason: expect.stringMatching(/budget exhausted/) });
    expect(decidePod({ ...base, status: 'EXITED', waiting: 9, budget: over }).action).toBe('NONE');
    expect(decidePod({ ...base, status: 'EXITED', waiting: 9, budget: under }).action).toBe('START');
    expect(decidePod({ ...base, status: 'EXITED', waiting: 9, budget: unknown }).action).toBe('NONE');
    expect(decidePod({ ...base, inFlight: 4, budget: unknown }).action).toBe('NONE');
  });

  it('records one BUDGET_EXHAUSTED per exhaustion, and one BUDGET_AVAILABLE when the window frees budget', () => {
    const now = base.now;
    const over = budgetReading(budgetOf(5), 6, now);
    const under = budgetReading(budgetOf(5), 1, now);
    expect(budgetEvent(over, null)).toBe('BUDGET_EXHAUSTED');
    expect(budgetEvent(over, 'BUDGET_AVAILABLE')).toBe('BUDGET_EXHAUSTED');
    expect(budgetEvent(over, 'BUDGET_EXHAUSTED')).toBeNull();
    expect(budgetEvent(under, 'BUDGET_EXHAUSTED')).toBe('BUDGET_AVAILABLE');
    expect(budgetEvent(under, null)).toBeNull();
    expect(budgetEvent(budgetReading(budgetOf(5), null, now), 'BUDGET_EXHAUSTED')).toBeNull();
  });

  it('as spend crosses the budget: the running pod is stopped, no start or move follows, and one event is recorded', async () => {
    const pod = { status: 'RUNNING', vllm: true };
    const { calls, fetchImpl } = fakeRunpod(pod);
    const events: { outcome: string; measures: unknown }[] = [];
    const record = async (e: { outcome?: string | null; measures?: unknown }) => {
      events.push({ outcome: e.outcome ?? '', measures: e.measures });
    };
    let spent = 4.5;
    const spend = async () => spent;
    const budgeted: PodConfig = { ...config, budget: budgetOf(5) };
    let t = 10 * 3_600_000;
    const tick = (waiting: number, inFlight: number, hostRefusals = 9) =>
      superviseRunpodPod({ waiting, inFlight }, { config: budgeted, fetchImpl, now: () => t, force: true, lastStartFailed: async () => false, hostRefusals: async () => hostRefusals, spend, record });

    const busy = await tick(20, 8);
    expect(busy?.decision.action).toBe('NONE');
    expect(busy?.budget).toMatchObject({ spent: 4.5, remaining: 0.5, exhausted: false });

    spent = 5.2;
    t += MIN_ACTION_GAP_MS;
    const capped = await tick(20, 8);
    expect(capped?.decision.action).toBe('STOP');
    expect(capped?.acted).toBe(true);
    expect(pod.status).toBe('EXITED');

    // Research keeps waiting for an hour (with enough host refusals to move): nothing starts, nothing moves, no more budget events.
    for (let i = 0; i < 60; i += 1) {
      t += 60_000;
      const step = await tick(30, 0);
      expect(step?.decision.action).toBe('NONE');
    }
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['https://rest.runpod.io/v1/pods/yxabw9083tp8hk/stop']);
    expect(pod.status).toBe('EXITED');
    const exhausted = events.filter((e) => e.outcome === 'BUDGET_EXHAUSTED');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.measures).toMatchObject({ spent: 5.2, budget: 5, windowHours: 24 });
    expect(events.filter((e) => e.outcome === 'STOPPED')).toHaveLength(1);

    // The window frees budget: one BUDGET_AVAILABLE, and the waiting research starts the pod.
    spent = 3;
    t += MIN_ACTION_GAP_MS;
    const freed = await tick(30, 0, 0);
    expect(freed?.decision.action).toBe('START');
    expect(events.filter((e) => e.outcome === 'BUDGET_AVAILABLE')).toHaveLength(1);
  });
});

describe('a paused GPU slot', () => {
  const env = {
    BRAIN_CHEAP_LLM_URL: 'https://cheap.test/v1',
    BRAIN_CHEAP_LLM_KEY: 'free-key',
    BRAIN_CHEAP_LLM_MODELS: 'fast,smart',
    BRAIN_RUNPOD_URL: 'https://abc123-8000.proxy.runpod.net',
    BRAIN_RUNPOD_KEY: 'gpu-key',
    BRAIN_RUNPOD_MODE: 'primary',
  };

  it('answers on the free model without calling the GPU, and without counting a GPU failure', async () => {
    const lane = laneConfig(env)!;
    resetPodSupervisor();
    const { setRunpodPaused } = await import('../server/services/cheap/runpod.ts');
    setRunpodPaused('pod stopped');
    let gpuCalls = 0;
    const fetchImpl = (async () => {
      gpuCalls += 1;
      return new Response('{}', { status: 500 });
    }) as Fetch;
    const text = await routeRunpod(lane, 's', 'p', { maxTokens: 10 }, async (model) => `free:${model}`, { fetchImpl });
    expect(text).toBe('free:fast');
    expect(gpuCalls).toBe(0);
    expect(runpodReading().fellBack).toBe(0);
    expect(runpodCallWindow(60_000)).toEqual({ ok: 0, failed: 0 });
  });

  it("counts the GPU's own failures for the capacity controller", async () => {
    const lane = laneConfig(env)!;
    const fetchImpl = (async () => new Response('{}', { status: 503 })) as Fetch;
    await routeRunpod(lane, 's', 'p', { maxTokens: 10 }, async () => 'free', { fetchImpl });
    expect(runpodCallWindow(60_000)).toEqual({ ok: 0, failed: 1 });
  });
});

describe('moving a pod whose host has no GPU left (production 2026-11-15: 109 refused starts)', () => {
  it('moves only a stopped pod with research waiting after three host refusals', async () => {
    const { shouldMigrate, HOST_FULL } = await import('../server/services/cheap/runpodPod.ts');
    expect(HOST_FULL.test('start pod: There are not enough free GPUs on the host machine to start this pod.')).toBe(true);
    expect(HOST_FULL.test('unauthorized')).toBe(false);
    expect(shouldMigrate({ status: 'EXITED', waiting: 30, hostRefusals: 3 })).toBe(true);
    expect(shouldMigrate({ status: 'EXITED', waiting: 30, hostRefusals: 2 })).toBe(false);
    expect(shouldMigrate({ status: 'EXITED', waiting: 0, hostRefusals: 9 })).toBe(false);
    expect(shouldMigrate({ status: 'RUNNING', waiting: 30, hostRefusals: 9 })).toBe(false);
  });

  it('creates the same recipe elsewhere, points the lane at it, deletes the stranded pod, and starts nothing on the old one', async () => {
    const { runpodConfig, setRunpodUrlOverride } = await import('../server/services/cheap/runpod.ts');
    const pod = { status: 'EXITED', vllm: false };
    const { calls, fetchImpl } = fakeRunpod(pod);
    const created: unknown[] = [];
    const deleted: string[] = [];
    const result = await superviseRunpodPod({ waiting: 30, inFlight: 0 }, {
      config,
      fetchImpl,
      now: () => 10 * 3_600_000,
      force: true,
      lastStartFailed: async () => false,
      hostRefusals: async () => 3,
      migrate: {
        env: { BRAIN_RUNPOD_URL: config.vllm.url, BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_MODEL: 'Qwen/Qwen3-4B-AWQ' },
        create: (async (input: { recipe: { key: string }; maxUsdPerHour: number }) => {
          created.push(input);
          return { podId: 'newpod12345678', url: 'x', status: 'RUNNING', costPerHr: 0.19, created: true, log: ['created'] };
        }) as never,
        remove: async (_key: string, id: string) => {
          deleted.push(id);
          return 204;
        },
      },
    });
    expect(result?.acted).toBe(true);
    expect(result?.decision.reason).toMatch(/moved to newpod12345678/);
    expect(created).toHaveLength(1);
    expect((created[0] as { recipe: { key: string }; maxUsdPerHour: number }).recipe.key).toBe('qwen3-4b-awq-tools');
    expect((created[0] as { maxUsdPerHour: number }).maxUsdPerHour).toBeLessThanOrEqual(0.24);
    expect(deleted).toEqual([config.podId]);
    expect(calls.some((c) => c.url.endsWith('/start'))).toBe(false);
    // The lane now points at the new pod, and its pod id follows.
    expect(runpodConfig({ BRAIN_RUNPOD_URL: config.vllm.url, BRAIN_RUNPOD_MODE: 'primary' })?.url).toBe('https://newpod12345678-8000.proxy.runpod.net/v1');
    expect(podConfig({ BRAIN_RUNPOD_URL: config.vllm.url, BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_API_KEY: 'k', BRAIN_RUNPOD_POD_ID: 'yxabw9083tp8hk' })?.podId).toBe('newpod12345678');
    // The override moves a configured pod; it never turns an unconfigured GPU on.
    expect(runpodConfig({ BRAIN_RUNPOD_MODE: 'primary' })).toBeNull();
    setRunpodUrlOverride(null);
  });

  it('retries the start on the same host before the third refusal', async () => {
    const pod = { status: 'EXITED', vllm: false };
    const { calls, fetchImpl } = fakeRunpod(pod);
    await superviseRunpodPod({ waiting: 30, inFlight: 0 }, { config, fetchImpl, now: () => 10 * 3_600_000, force: true, lastStartFailed: async () => false, hostRefusals: async () => 2 });
    expect(calls.some((c) => c.url.endsWith('/start'))).toBe(true);
  });

  it('records a failed move and changes nothing when no replacement can be had', async () => {
    const { runpodUrlOverride } = await import('../server/services/cheap/runpod.ts');
    const pod = { status: 'EXITED', vllm: false };
    const { fetchImpl } = fakeRunpod(pod);
    const result = await superviseRunpodPod({ waiting: 30, inFlight: 0 }, {
      config, fetchImpl, now: () => 10 * 3_600_000, force: true, lastStartFailed: async () => false, hostRefusals: async () => 5,
      migrate: { env: { BRAIN_RUNPOD_URL: config.vllm.url, BRAIN_RUNPOD_MODE: 'primary' }, create: (async () => { throw new Error('no pod within $0.24/h could be created'); }) as never, remove: async () => 204 },
    });
    expect(result?.acted).toBe(false);
    expect(result?.decision.reason).toMatch(/move failed/);
    expect(runpodUrlOverride()).toBeNull();
  });
});

describe('host refusals are this pod\'s own (production 2026-11-15 23:07Z: a hand-moved pod inherited 20 refusals)', () => {
  it('counts only the current pod, and only since its last stop, start or move', async () => {
    const { hostRefusalsOf } = await import('../server/services/cheap/runpodPod.ts');
    const full = 'RunPod answered HTTP 500: {"error":"start pod: There are not enough free GPUs on the host machine to start this pod."}';
    const rows = [
      { outcome: 'STOPPED', reason: 'runpod-cycle', podId: 'newpod' },
      { outcome: 'START_FAILED', reason: full, podId: 'oldpod' },
      { outcome: 'START_FAILED', reason: full, podId: 'oldpod' },
      { outcome: 'START_FAILED', reason: full, podId: 'oldpod' },
    ];
    expect(hostRefusalsOf('newpod', rows)).toBe(0);
    expect(hostRefusalsOf('oldpod', rows)).toBe(3);
    expect(hostRefusalsOf('newpod', [{ outcome: 'START_FAILED', reason: full, podId: 'newpod' }, { outcome: 'START_FAILED', reason: full, podId: 'newpod' }, { outcome: 'STOPPED', reason: '', podId: 'newpod' }, { outcome: 'START_FAILED', reason: full, podId: 'newpod' }])).toBe(2);
    expect(hostRefusalsOf('newpod', [{ outcome: 'START_FAILED', reason: 'pod not found', podId: 'newpod' }])).toBe(0);
  });
});

describe('a move follows the pod it moved (production 2026-11-16: a stale move sent the upgraded GPU\'s calls to a deleted pod)', () => {
  it('follows the MIGRATED chain from the configured pod, and ignores moves of a pod no longer configured', async () => {
    const { movedPodUrl } = await import('../server/services/cheap/runpodPod.ts');
    const url = (id: string) => `https://${id}-8000.proxy.runpod.net/v1`;
    const rows = [
      { from: 'a', podId: 'b', url: url('b') },
      { from: 'b', podId: 'c', url: url('c') },
    ];
    expect(movedPodUrl('a', rows)).toBe(url('c'));
    expect(movedPodUrl('b', rows)).toBe(url('c'));
    // The pod runpod-upgrade connected after the last move: no move applies to it.
    expect(movedPodUrl('xwepsiiv7b0hbn', [{ from: '48zd8pqu8dh7sg', podId: 'uhtkd69eol85xz', url: url('uhtkd69eol85xz') }])).toBeNull();
    expect(movedPodUrl(null, rows)).toBeNull();
    expect(movedPodUrl('a', [{ from: 'a', podId: null, url: url('b') }])).toBeNull();
  });
});

describe('a pod is stopped even when RunPod REST is unreachable (production 2026-11-16 23:36Z: "fetch failed")', () => {
  it('falls back to GraphQL podStop when the REST request throws, and reads status the same way', async () => {
    const { stopOrStartForTest, readPod } = await import('../server/services/cheap/runpodPod.ts').then((m) => ({ stopOrStartForTest: m.viaGraphql, readPod: m.readPod }));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u.includes('graphql') ? `gql:${String(init?.body ?? '')}` : `rest:${u}`);
      if (!u.includes('graphql')) throw new TypeError('fetch failed');
      const q = String(init?.body ?? '');
      const data = q.includes('podStop') ? { podStop: { desiredStatus: 'EXITED' } } : { pod: { desiredStatus: 'RUNNING', costPerHr: 5.29 } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const config = { apiKey: 'k', podId: 'pod1', idleStopMs: 1, vllm: { url: 'u', key: 'k' } };
    const read = await readPod(config as never, fetchImpl);
    expect(read).toEqual({ status: 'RUNNING', costPerHr: 5.29, startedAt: null });
    const stopped = await stopOrStartForTest(config, 'POST', '/stop', fetchImpl);
    expect(stopped?.status).toBe(200);
    expect(calls.some((c) => c.startsWith('gql:') && c.includes('podStop'))).toBe(true);
    expect(await stopOrStartForTest(config, 'POST', '/other', fetchImpl)).toBeNull();
  });
});

describe('the budget is measured from what RunPod bills, not only from Brain\'s samples (production 2026-11-17: pod 6lsnbsnctavj2m)', () => {
  const H = 3_600_000;
  const M = 60_000;
  const PRICE = 5.29;
  const budget = { usd: 4, windowMs: 2 * H, defaulted: false };
  const podId = '6lsnbsnctavj2m';
  const podConf: PodConfig = { apiKey: 'rp', podId, idleStopMs: DEFAULT_IDLE_STOP_MS, budget, vllm: { url: `https://${podId}-8000.proxy.runpod.net/v1`, key: 'vllm-key' } };
  const sample = (at: number): PodRow => ({ at, outcome: 'SAMPLE_RUNNING', durationMs: 5 * M, measures: { podId, costPerHr: PRICE } });

  /** RunPod as GraphQL answers it (REST is down): the pod, its price and its uptime; stop and resume change it. */
  function graphqlRunpod(pod: { status: string; uptimeSeconds: number | null }) {
    const posts: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('rest.runpod.io')) throw new TypeError('fetch failed');
      if (u.includes('graphql')) {
        const q = String(init?.body ?? '');
        if (q.includes('podStop')) {
          posts.push('stop');
          pod.status = 'EXITED';
          return new Response(JSON.stringify({ data: { podStop: { desiredStatus: 'EXITED' } } }), { status: 200 });
        }
        if (q.includes('podResume')) {
          posts.push('start');
          pod.status = 'RUNNING';
          return new Response(JSON.stringify({ data: { podResume: { desiredStatus: 'RUNNING' } } }), { status: 200 });
        }
        const running = pod.status === 'RUNNING';
        return new Response(
          JSON.stringify({ data: { pod: { desiredStatus: pod.status, costPerHr: PRICE, runtime: running && pod.uptimeSeconds !== null ? { uptimeInSeconds: pod.uptimeSeconds } : null } } }),
          { status: 200 },
        );
      }
      return new Response('{"data":[]}', { status: 200 });
    }) as Fetch;
    return { posts, fetchImpl };
  }

  it('reads when RunPod started billing from lastStartedAt, else from the runtime uptime', async () => {
    const { billingStartOf } = await import('../server/services/cheap/runpodPod.ts');
    const now = Date.parse('2026-11-17T01:46:00Z');
    expect(billingStartOf({ lastStartedAt: '2026-11-17T00:45:00Z' }, now)).toBe(Date.parse('2026-11-17T00:45:00Z'));
    expect(billingStartOf({ runtime: { uptimeInSeconds: 3000 } }, now)).toBe(now - 3000 * 1000);
    expect(billingStartOf({ runtime: null }, now)).toBeNull();
  });

  it('a pod billed 61 min at $5.29 with only 35 min of samples exhausts a $4 / 2 h budget: STOP, and no START after', async () => {
    const rented = Date.parse('2026-11-17T00:45:00Z');
    let t = rented + 61 * M;
    // 15 min of model load before Brain connected, 35 min sampled, then a restart's 11 unsampled minutes.
    const rows: PodRow[] = [];
    for (let i = 0; i < 7; i += 1) rows.push(sample(rented + 20 * M + i * 5 * M));
    const sampledOnly = windowSpendFromRows(rows, { since: t - budget.windowMs, now: t, live: null });
    expect(sampledOnly.sampled).toBeCloseTo((35 / 60) * PRICE, 2); // $3.09: what PR #1002 counted
    expect(sampledOnly.sampled).toBeLessThan(budget.usd);

    const pod = { status: 'RUNNING', uptimeSeconds: 61 * 60 };
    const { posts, fetchImpl } = graphqlRunpod(pod);
    const record = async (e: { outcome?: string | null; measures?: Record<string, unknown>; durationMs?: number | null }) => {
      rows.push({ at: t, outcome: e.outcome ?? '', durationMs: e.durationMs ?? null, measures: e.measures ?? {} });
    };
    const tick = (waiting: number, inFlight: number) =>
      superviseRunpodPod({ waiting, inFlight }, { config: podConf, fetchImpl, now: () => t, force: true, lastStartFailed: async () => false, hostRefusals: async () => 0, rows: async () => rows, record });

    const capped = await tick(12, 6);
    expect(capped?.budget).toMatchObject({ exhausted: true, known: true, budget: 4, windowHours: 2 });
    expect(capped!.budget!.spent!).toBeCloseTo((61 / 60) * PRICE, 2); // $5.38, RunPod's figure
    expect(capped?.decision.action).toBe('STOP');
    expect(capped?.acted).toBe(true);
    expect(pod.status).toBe('EXITED');
    const exhausted = rows.filter((r) => r.outcome === 'BUDGET_EXHAUSTED');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.measures).toMatchObject({ startedAt: new Date(rented).toISOString() });

    // Stopped, RunPod reports no uptime any more; the rows still carry when billing began. Nothing starts.
    for (let i = 0; i < 30; i += 1) {
      t += 2 * M;
      const step = await tick(40, 0);
      expect(step?.decision.action).toBe('NONE');
      expect(step?.budget?.exhausted).toBe(true);
    }
    expect(posts).toEqual(['stop']);
  });

  it('a RUNNING pod with no samples at all counts from when RunPod started billing it — on the first step after boot', async () => {
    const t = Date.parse('2026-11-17T01:35:00Z');
    const pod = { status: 'RUNNING', uptimeSeconds: 50 * 60 };
    const { posts, fetchImpl } = graphqlRunpod(pod);
    const rows: PodRow[] = [];
    const record = async (e: { outcome?: string | null; measures?: Record<string, unknown>; durationMs?: number | null }) => {
      rows.push({ at: t, outcome: e.outcome ?? '', durationMs: e.durationMs ?? null, measures: e.measures ?? {} });
    };
    // The boot check: budget only, no reading of the work.
    const first = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config: podConf, fetchImpl, now: () => t, force: true, lastStartFailed: async () => false, rows: async () => [], record, budgetOnly: true });
    expect(first!.budget!.spent!).toBeCloseTo((50 / 60) * PRICE, 2); // $4.41 with zero samples
    expect(first?.budget?.exhausted).toBe(true);
    expect(first?.decision.action).toBe('STOP');
    expect(posts).toEqual(['stop']);
    // The first sample row records when RunPod started billing, so the time survives the stop.
    expect(rows.find((r) => r.outcome === 'SAMPLE_RUNNING')?.measures).toMatchObject({ startedAt: new Date(t - 50 * M).toISOString() });
  });

  it('the boot check under budget changes nothing, whatever the idle reading would say', async () => {
    const t = Date.parse('2026-11-17T01:35:00Z');
    const pod = { status: 'RUNNING', uptimeSeconds: 10 * 60 };
    const { posts, fetchImpl } = graphqlRunpod(pod);
    const step = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { config: podConf, fetchImpl, now: () => t, force: true, lastStartFailed: async () => false, rows: async () => [], record: async () => undefined, budgetOnly: true });
    expect(step?.budget?.exhausted).toBe(false);
    expect(step?.decision.action).toBe('NONE');
    expect(posts).toEqual([]);
  });

  it('counts a pod created and deleted in the window from its rows, clipped to the window, and never twice', () => {
    const now = 10 * H;
    const since = now - 2 * H;
    const rows: PodRow[] = [
      // Old pod running since before the window, moved off at since + 30 min; new pod created then.
      { at: since - 60 * M, outcome: 'STARTED', durationMs: null, measures: { podId: 'old', costPerHr: 2 } },
      { at: since + 30 * M, outcome: 'MIGRATED', durationMs: null, measures: { from: 'old', podId: 'new', costPerHr: 3 } },
      { at: since + 31 * M, outcome: 'OLD_POD_DELETED', durationMs: null, measures: { podId: 'old' } },
      // The new pod sampled for 10 min, then stopped at since + 60 min.
      { at: since + 35 * M, outcome: 'SAMPLE_RUNNING', durationMs: 5 * M, measures: { podId: 'new', costPerHr: 3 } },
      { at: since + 40 * M, outcome: 'SAMPLE_RUNNING', durationMs: 5 * M, measures: { podId: 'new', costPerHr: 3 } },
      { at: since + 60 * M, outcome: 'STOPPED', durationMs: null, measures: { podId: 'new', costPerHr: 3 } },
    ];
    const spend = windowSpendFromRows(rows, { since, now, live: { podId: 'new', status: 'EXITED', costPerHr: 3, startedAt: null } });
    const byPod = Object.fromEntries(spend.pods.map((p) => [p.podId, p]));
    expect(byPod['old']!.billed).toBeCloseTo(0.5 * 2, 4); // 30 min in the window, not the 60 before it
    expect(byPod['new']!.billed).toBeCloseTo(0.5 * 3, 4); // 30 min billed, though only 10 sampled
    expect(byPod['new']!.sampled).toBeCloseTo((10 / 60) * 3, 4);
    expect(spend.dollars).toBeCloseTo(1 + 1.5, 4);
  });
});
