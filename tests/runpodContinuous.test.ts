/**
 * The owner's standing authorization for continuous GPU operation (§121,
 * 2026-11-24): no budget window ends the run; the pod stops only after sustained
 * idleness and starts again by itself; a stopped, deleted or stalled pod is
 * recovered; a card above the authorized rate is refused; and the GPU slot's
 * concurrency rises while work waits and answers hold.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRunpod, setRunpodUrlOverride, type Fetch } from '../server/services/cheap/runpod.ts';
import {
  CONTINUOUS_IDLE_STOP_MS,
  DEFAULT_CONTINUOUS_RECIPE,
  MIN_ACTION_GAP_MS,
  VLLM_STALL_MS,
  balanceRestriction,
  decidePod,
  gpuAuthorization,
  podBudget,
  podConfig,
  rateRefusal,
  resetPodSupervisor,
  superviseRunpodPod,
  type PodConfig,
} from '../server/services/cheap/runpodPod.ts';
import { creationPlan, RECIPES } from '../server/services/cheap/runpodRestore.ts';
import { decideTarget, latencyBaseline, poolShare, slotShare, SLOTS_PER_DB_CONNECTION } from '../server/services/freeLane/capacity.ts';
import { gpuRestrictions, workState } from '../server/services/cheap/gpuStatus.ts';
import { gpuThroughput, summarizeGpuJobs } from '../server/services/cheap/gpuCapacity.ts';
import type { RecordBinEventInput } from '../server/repos/bins.ts';

const URL = 'https://eaboawshas41wq-8000.proxy.runpod.net/v1';
const AUTH_ENV = {
  BRAIN_RUNPOD_URL: URL,
  BRAIN_RUNPOD_MODE: 'primary',
  BRAIN_RUNPOD_MODEL: 'openai/gpt-oss-120b',
  BRAIN_RUNPOD_API_KEY: 'rp-account-key',
  BRAIN_RUNPOD_KEY: 'vllm-key',
  BRAIN_RUNPOD_AUTHORIZATION: 'continuous',
  BRAIN_RUNPOD_AUTHORIZED_USD_PER_HOUR: '2.50',
  BRAIN_RUNPOD_AUTHORIZED_AT: '2026-11-24T18:00:00Z',
};
const auth = gpuAuthorization(AUTH_ENV)!;
const config: PodConfig = { ...podConfig(AUTH_ENV)! };
const H = 3_600_000;

beforeEach(() => {
  resetRunpod();
  resetPodSupervisor();
  setRunpodUrlOverride(null);
});

/** A fake RunPod API and vLLM. `status: 'GONE'` answers 404 as RunPod does for a deleted pod. */
function fakeRunpod(pod: { status: string; vllm: boolean; costPerHr: number }) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? 'GET', url: u });
    if (u.endsWith('/stop')) {
      pod.status = 'EXITED';
      return new Response('{}', { status: 200 });
    }
    if (u.endsWith('/start') || u.endsWith('/restart')) {
      pod.status = 'RUNNING';
      return new Response('{}', { status: 200 });
    }
    if (u.includes('rest.runpod.io')) {
      if (pod.status === 'GONE') return new Response('{"error":"pod not found"}', { status: 404 });
      return new Response(JSON.stringify({ desiredStatus: pod.status, costPerHr: pod.costPerHr, lastStartedAt: '1970-01-01T09:00:00.000Z' }), { status: 200 });
    }
    return new Response('{"data":[]}', { status: pod.vllm ? 200 : 503 });
  }) as Fetch;
  return { calls, fetchImpl };
}

const events: RecordBinEventInput[] = [];
const record = async (e: RecordBinEventInput) => {
  events.push(e);
};
const quiet = { record, lastStartFailed: async () => false, hostRefusals: async () => 0, rows: async () => [], balance: async () => 142.02 };

describe('the standing authorization', () => {
  it('is read from the environment and survives without any budget secret; a budget window no longer applies', () => {
    expect(auth).toMatchObject({ mode: 'continuous', usdPerHour: 2.5, since: '2026-11-24T18:00:00.000Z', recipe: DEFAULT_CONTINUOUS_RECIPE, balanceFloorUsd: 10, replenishAtUsd: 75 });
    expect(gpuAuthorization({})).toBeNull();
    // The bounded run that stopped the H200 on 2026-11-19: a fixed window long past.
    const ended = { ...AUTH_ENV, BRAIN_RUNPOD_BUDGET_USD: '60', BRAIN_RUNPOD_BUDGET_WINDOW_HOURS: '12', BRAIN_RUNPOD_BUDGET_FROM: '2026-11-19T07:00:00Z' };
    expect(podBudget(ended)).toBeNull();
    expect(podConfig(ended)?.budget).toBeNull();
    expect(podConfig(ended)?.idleStopMs).toBe(CONTINUOUS_IDLE_STOP_MS);
    // Without the authorization the same secrets still bind as a bounded run.
    const { BRAIN_RUNPOD_AUTHORIZATION: _gone, ...budgeted } = ended;
    expect(podBudget(budgeted)).toMatchObject({ usd: 60 });
  });

  it('defaults to the A100 recipe on SECURE cloud, which an H100 or a community card never satisfies at the authorized rate', () => {
    const recipe = RECIPES[DEFAULT_CONTINUOUS_RECIPE]!;
    expect(recipe.served).toBe('openai/gpt-oss-120b');
    expect(recipe.clouds).toEqual(['SECURE']);
    expect(recipe.gpuCount ?? 1).toBe(1);
    // runpod-survey 45346063896's listed prices.
    const prices = new Map([
      ['NVIDIA A100-SXM4-80GB', { SECURE: 2.19, COMMUNITY: 1.39 }],
      ['NVIDIA A100 80GB PCIe', { SECURE: 2.09, COMMUNITY: null }],
      ['NVIDIA H100 80GB HBM3', { SECURE: 4.39, COMMUNITY: 2.69 }],
    ]);
    const plan = creationPlan(recipe, auth.usdPerHour, prices);
    expect(plan.attempts.every((a) => a.cloud === 'SECURE')).toBe(true);
    expect(plan.attempts.map((a) => a.gpus[0])).toEqual(['NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB']);
    // The H100 fallback recipe is over the authorized rate: nothing in it is created.
    expect(creationPlan(RECIPES['gpt-oss-120b-h100']!, auth.usdPerHour, prices).attempts.filter((a) => a.listed !== null)).toEqual([]);
  });
});

describe('no window expiry under continuous authorization', () => {
  it('keeps a busy pod running for days with no budget, no BUDGET_EXHAUSTED row and no stop', async () => {
    const pod = { status: 'RUNNING', vllm: true, costPerHr: 2.19 };
    const { calls, fetchImpl } = fakeRunpod(pod);
    events.length = 0;
    let t = 10 * H;
    for (let i = 0; i < 72; i += 1) {
      t += H;
      const r = await superviseRunpodPod({ waiting: 20, inFlight: 9 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
      expect(r?.budget).toBeNull();
      expect(r?.decision.action).toBe('NONE');
    }
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);
    expect(events.some((e) => String(e.outcome).startsWith('BUDGET_'))).toBe(false);
    // The owner's rule is on the record once, not once per step.
    expect(events.filter((e) => e.outcome === 'AUTHORIZED')).toHaveLength(1);
    expect(pod.status).toBe('RUNNING');
  });

  it('decides on the pod alone: a spent window that would have stopped a bounded run changes nothing', () => {
    const base = { status: 'RUNNING' as const, waiting: 5, inFlight: 3, idleSince: null, lastActionAt: 0, now: 100 * H, idleStopMs: CONTINUOUS_IDLE_STOP_MS };
    expect(decidePod({ ...base, authorization: auth, costPerHr: 2.19, balance: 140, ready: true, budget: null }).action).toBe('NONE');
  });
});

describe('idle stop and automatic resume', () => {
  it('stops only after 30 idle minutes, and starts again when GPU work appears', async () => {
    const pod = { status: 'RUNNING', vllm: true, costPerHr: 2.19 };
    const { calls, fetchImpl } = fakeRunpod(pod);
    let t = 10 * H;
    await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    t += 16 * 60_000;
    // Past the old 15-minute idle stop, not past the continuous one.
    expect((await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true }))?.decision.action).toBe('NONE');
    t += 15 * 60_000;
    const stopped = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    expect(stopped?.decision.action).toBe('STOP');
    expect(pod.status).toBe('EXITED');
    t += MIN_ACTION_GAP_MS;
    const idle = await superviseRunpodPod({ waiting: 0, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    expect(idle?.decision.action).toBe('NONE');
    t += 60_000;
    const resumed = await superviseRunpodPod({ waiting: 12, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    expect(resumed?.decision.action).toBe('START');
    expect(pod.status).toBe('RUNNING');
    expect(calls.filter((c) => c.url.endsWith('/start'))).toHaveLength(1);
  });
});

describe('recovery of an EXITED, deleted or stalled pod', () => {
  it('starts an EXITED pod within the rate when work waits — the H200 left stopped since 11-19 would be replaced instead', async () => {
    const pod = { status: 'EXITED', vllm: false, costPerHr: 2.19 };
    const { fetchImpl } = fakeRunpod(pod);
    const r = await superviseRunpodPod({ waiting: 174, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => 10 * H, force: true });
    expect(r?.decision.action).toBe('START');
    expect(pod.status).toBe('RUNNING');
  });

  it('recreates a deleted pod (RunPod answers 404) from the authorized recipe within the authorized rate', async () => {
    const pod = { status: 'GONE', vllm: false, costPerHr: 0 };
    const { fetchImpl } = fakeRunpod(pod);
    const created: { recipe: { key: string }; maxUsdPerHour: number }[] = [];
    const r = await superviseRunpodPod({ waiting: 30, inFlight: 0 }, {
      ...quiet,
      config,
      fetchImpl,
      now: () => 10 * H,
      force: true,
      migrate: {
        env: AUTH_ENV,
        create: (async (input: { recipe: { key: string }; maxUsdPerHour: number }) => {
          created.push(input);
          return { podId: 'a100pod1234567', url: 'x', status: 'RUNNING', costPerHr: 2.19, created: true, log: [] };
        }) as never,
        remove: async () => 404,
      },
    });
    expect(r?.status).toBe('TERMINATED');
    expect(r?.decision.action).toBe('REPLACE');
    expect(r?.acted).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.recipe.key).toBe('gpt-oss-120b-a100');
    expect(created[0]!.maxUsdPerHour).toBe(2.5);
    setRunpodUrlOverride(null);
  });

  it('a deleted pod with nothing waiting is left until work arrives', () => {
    const d = decidePod({ status: 'TERMINATED', waiting: 0, inFlight: 0, idleSince: null, lastActionAt: 0, now: H, idleStopMs: CONTINUOUS_IDLE_STOP_MS, authorization: auth });
    expect(d.action).toBe('NONE');
  });

  it('restarts a pod whose vLLM stopped serving, twice, then replaces it', () => {
    const base = { status: 'RUNNING' as const, waiting: 10, inFlight: 0, idleSince: null, lastActionAt: 0, now: 10 * H, idleStopMs: CONTINUOUS_IDLE_STOP_MS, authorization: auth, costPerHr: 2.19, balance: 140, ready: false };
    expect(decidePod({ ...base, unreadyMs: VLLM_STALL_MS - 60_000 }).action).toBe('NONE');
    expect(decidePod({ ...base, unreadyMs: VLLM_STALL_MS, restarts: 0 }).action).toBe('RESTART');
    expect(decidePod({ ...base, unreadyMs: VLLM_STALL_MS, restarts: 1 }).action).toBe('RESTART');
    expect(decidePod({ ...base, unreadyMs: VLLM_STALL_MS, restarts: 2 }).action).toBe('REPLACE');
    // Without the authorization a stalled pod is only paused onto the fallback, as before.
    expect(decidePod({ ...base, authorization: null, unreadyMs: 10 * H }).action).toBe('NONE');
  });

  it('the supervisor restarts the stalled pod through RunPod and records it', async () => {
    const pod = { status: 'RUNNING', vllm: false, costPerHr: 2.19 };
    const { calls, fetchImpl } = fakeRunpod(pod);
    events.length = 0;
    let t = 10 * H;
    await superviseRunpodPod({ waiting: 10, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    t += VLLM_STALL_MS;
    const r = await superviseRunpodPod({ waiting: 10, inFlight: 0 }, { ...quiet, config, fetchImpl, now: () => t, force: true });
    expect(r?.decision.action).toBe('RESTART');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/eaboawshas41wq/restart'))).toBe(true);
    expect(events.some((e) => e.outcome === 'RESTARTED')).toBe(true);
  });
});

describe('refusal above the authorized rate', () => {
  it('stops a running card priced above the rate and says it needs the owner', async () => {
    const pod = { status: 'RUNNING', vllm: true, costPerHr: 5.29 };
    const { fetchImpl } = fakeRunpod(pod);
    const r = await superviseRunpodPod({ waiting: 50, inFlight: 8 }, { ...quiet, config, fetchImpl, now: () => 10 * H, force: true });
    expect(r?.decision.action).toBe('STOP');
    expect(r?.decision.reason).toMatch(/refused: card at \$5\.29\/h is above the authorized \$2\.50\/h.*owner's approval/);
    expect(pod.status).toBe('EXITED');
  });

  it('never starts a stopped card above the rate: it is replaced by the authorized recipe when work waits', () => {
    const base = { status: 'EXITED' as const, inFlight: 0, idleSince: null, lastActionAt: 0, now: 10 * H, idleStopMs: CONTINUOUS_IDLE_STOP_MS, authorization: auth, costPerHr: 5.29, balance: 142 };
    expect(decidePod({ ...base, waiting: 174 }).action).toBe('REPLACE');
    expect(decidePod({ ...base, waiting: 0 }).action).toBe('NONE');
    expect(decidePod({ ...base, waiting: 0 }).reason).toMatch(/refused/);
    expect(rateRefusal(auth, 2.19)).toBeNull();
    expect(rateRefusal(auth, 4.39)).toMatch(/needs the owner's approval/);
  });
});

describe('the balance through replenishment', () => {
  it('keeps running under the $75 replenishment trigger and stops only near RunPod\'s zero', () => {
    expect(balanceRestriction(auth, 142)).toBeNull();
    expect(balanceRestriction(auth, 74)).toMatchObject({ stop: false });
    expect(balanceRestriction(auth, 9)).toMatchObject({ stop: true });
    const base = { status: 'RUNNING' as const, waiting: 10, inFlight: 4, idleSince: null, lastActionAt: 0, now: 10 * H, idleStopMs: CONTINUOUS_IDLE_STOP_MS, authorization: auth, costPerHr: 2.19, ready: true };
    expect(decidePod({ ...base, balance: 60 }).action).toBe('NONE');
    expect(decidePod({ ...base, balance: 8 }).action).toBe('STOP');
    expect(decidePod({ ...base, status: 'EXITED', balance: 8 }).action).toBe('NONE');
  });
});

describe('the GPU slot\'s concurrency rises under waiting work (§86, §121)', () => {
  const calm = { db: false, lagMs: 5, cpu: 0.1 };

  it('gives the GPU the database-pool budget the free model does not hold, never the total beyond it', () => {
    // Production: an 8-connection pool, two models — the even split held the H200 at 12.
    const total = 8 * SLOTS_PER_DB_CONNECTION;
    expect(poolShare({ gpu: true, models: 2, othersTarget: 4, poolMax: 8 })).toBe(total - 4);
    expect(poolShare({ gpu: false, models: 2, othersTarget: 20, poolMax: 8, gpuBeside: true })).toBe(4);
    // With no GPU beside it, a free model keeps its even share whatever the others hold.
    expect(poolShare({ gpu: false, models: 2, othersTarget: 20, poolMax: 8 })).toBe(slotShare(2, 8));
    expect(poolShare({ gpu: false, models: 2, othersTarget: 2, poolMax: 8, gpuBeside: true })).toBe(12);
    expect(poolShare({ gpu: true, models: 2, othersTarget: 4, poolMax: null })).toBeNull();
  });

  it('climbs past the old 12 while work waits and answers hold, to what the pool and vLLM allow', () => {
    let target = 2;
    const seen: number[] = [];
    for (let step = 0; step < 8; step += 1) {
      const d = decideTarget({ target, active: target, waiting: 174, window: { ok: 20, content: 1, transient: 0 }, pressure: calm, ceiling: 48, latency: { meanMs: 9_000, baselineMs: 8_000 } });
      const share = poolShare({ gpu: true, models: 2, othersTarget: 4, poolMax: 8 })!;
      target = Math.min(d.target, share);
      seen.push(target);
    }
    expect(seen.some((n) => n > 12)).toBe(true);
    expect(target).toBe(20);
  });

  it('holds when the GPU\'s answer time doubles against its baseline', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 100, window: { ok: 20, content: 0, transient: 0 }, pressure: calm, ceiling: 48, latency: { meanMs: 25_000, baselineMs: 10_000 } });
    expect(d.target).toBe(16);
    expect(d.reason).toMatch(/GPU answer time/);
  });

  it('keeps the lowest answer time of the last hour as the baseline', () => {
    const readings: { at: number; ms: number }[] = [];
    expect(latencyBaseline(readings, 9_000, 0)).toBe(9_000);
    expect(latencyBaseline(readings, 20_000, 60_000)).toBe(9_000);
    expect(latencyBaseline(readings, null, 2 * H)).toBeNull();
  });

  it('measures accepted GPU jobs per dollar', () => {
    const jobs = summarizeGpuJobs([
      { at: '2026-11-25T01:00:00Z', outcome: 'SUBMITTED', slot: 'runpod/openai/gpt-oss-120b', durationMs: 60_000, measures: { servedBy: ['runpod/openai/gpt-oss-120b'] } },
      { at: '2026-11-25T01:05:00Z', outcome: 'SUBMITTED', slot: 'runpod/openai/gpt-oss-120b', durationMs: 60_000, measures: { servedBy: ['runpod/openai/gpt-oss-120b'] } },
    ]);
    const t = gpuThroughput(jobs, [{ day: '2026-11-25', runningHours: 1, stoppedHours: 0, dollars: 2.19, costPerHr: 2.19 }]);
    expect(t.acceptedPerDollar).toBe(0.91);
  });
});

describe('the Command Center\'s GPU restrictions', () => {
  it('names each restriction in a sentence', () => {
    const base = { configured: true, authorization: auth, status: 'EXITED', ready: false, costPerHr: 2.19, balance: 140, waiting: 0, paused: 'pod exited', lastReason: null, slotReason: null, budgeted: false };
    expect(gpuRestrictions(base)).toContain('stopped: no waiting work (starts again by itself when GPU work is queued)');
    expect(gpuRestrictions({ ...base, costPerHr: 5.29 }).some((r) => r.startsWith('refused: card at $5.29/h'))).toBe(true);
    expect(gpuRestrictions({ ...base, authorization: null, budgeted: true }).some((r) => /no standing authorization/.test(r))).toBe(true);
    expect(gpuRestrictions({ ...base, status: 'RUNNING', ready: true, waiting: 10, paused: null, slotReason: 'useful research waiting (10); held to its share of the database pool (20 of 24 slots)' })).toEqual([
      'concurrency: useful research waiting (10); held to its share of the database pool (20 of 24 slots)',
    ]);
    expect(workState('RUNNING', 10, 0)).toBe('IDLE_WITH_WORK');
    expect(workState('EXITED', 0, 0)).toBe('STOPPED_NO_WORK');
  });
});
