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
  MIN_ACTION_GAP_MS,
  decidePod,
  podConfig,
  podIdFromUrl,
  resetPodSupervisor,
  superviseRunpodPod,
  type PodConfig,
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
    if (u.includes('rest.runpod.io')) return new Response(JSON.stringify({ desiredStatus: pod.status, costPerHr: 0.24 }), { status: 200 });
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
