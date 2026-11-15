/**
 * CAP-16-3 repair, episode 1: a held model route is re-probed with a health
 * ping on a growing interval, never with a claimed work item.
 *
 * Production, 2026-11-15 18:58Z: r01.cap-16-3 failed with "6h: 15 accepted of
 * 137 lane outcomes; 80% provider failures", and brain_operator_capacity at
 * 19:06Z showed both routes (the RunPod slot and brain-a) at "100% of 4 calls
 * failed". A held route was re-probed every five minutes with a real item for
 * as long as it stayed down, so each dead route spent up to twelve items an
 * hour on failures and recorded every one as a lane outcome.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import { laneHttpError } from '../server/services/cheap/lane.ts';
import {
  pingHeldRoutes,
  providerRetryAfterMs,
  recordRouteOutcome,
  ROUTE_RETRY_AFTER_FLOOR_MS,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_REPROBE_BACKOFF_MS,
  routeHold,
  takeRouteProbe,
} from '../server/services/freeLane/worker.ts';

const MIN = 60_000;
const config: LaneConfig = { url: 'http://free.invalid/v1', key: null, models: ['m', 'other'], dailyBudget: 100, timeoutMs: 1000 };

function hold(model: string, now: number): void {
  for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome(model, { ok: false, why: 'model call failed [provider availability]: cheap lane HTTP 503' }, now);
}

function completer(answer: () => string): { fn: Completer; calls: Array<{ model: string; prompt: string }> } {
  const calls: Array<{ model: string; prompt: string }> = [];
  const fn: Completer = async (_config, model, _system, prompt) => {
    calls.push({ model, prompt });
    return answer();
  };
  return { fn, calls };
}

describe('held route re-probe (worker.ts)', () => {
  beforeEach(() => resetRouteHealth());
  afterEach(() => resetRouteHealth());

  it('declares the backoff as 5, 10, 20, 40, then 60 minutes', () => {
    expect(ROUTE_REPROBE_BACKOFF_MS).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 60 * MIN]);
  });

  it('holds a failing route and leaves another route free to take the work', () => {
    const now = 1_000_000;
    hold('m', now);
    expect(routeHold('m', now)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHold('other', now)).toBeNull();
  });

  it('pings nothing that is healthy or not yet due', async () => {
    const now = 1_000_000;
    hold('m', now);
    const c = completer(() => '{"ok":true}');
    expect(await pingHeldRoutes(['m', 'other'], c.fn, config, () => now + MIN)).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it('a failing ping holds the route again on a growing interval, with no item spent', async () => {
    let now = 1_000_000;
    hold('m', now);
    const c = completer(() => {
      throw new Error('cheap lane HTTP 503');
    });
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const due = now + (i === 0 ? ROUTE_REPROBE_BACKOFF_MS[0]! : waits[i - 1]!);
      now = due;
      // Due: the ping, not an item, is the probe.
      const [ping] = await pingHeldRoutes(['m'], c.fn, config, () => now);
      expect(ping).toMatchObject({ model: 'm', ok: false, cause: 'provider availability' });
      expect(routeHold('m', now)).not.toBeNull();
      waits.push(ping!.nextProbeAt! - now);
    }
    expect(waits).toEqual([10 * MIN, 20 * MIN, 40 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
    // Every probe went to the model as a ping; none carried work.
    expect(c.calls).toHaveLength(6);
    for (const call of c.calls) expect(call.prompt).toBe('Reply with {"ok": true}.');
  });

  it('a ping that answers makes the route healthy, and the backoff starts over next time', async () => {
    let now = 1_000_000;
    hold('m', now);
    let up = false;
    const c = completer(() => {
      if (!up) throw new Error('cheap lane HTTP 429');
      return '{"ok":true}';
    });
    now += 5 * MIN;
    await pingHeldRoutes(['m'], c.fn, config, () => now);
    now += 10 * MIN;
    await pingHeldRoutes(['m'], c.fn, config, () => now);
    expect(routeHold('m', now)).not.toBeNull();
    up = true;
    now += 20 * MIN;
    const [ping] = await pingHeldRoutes(['m'], c.fn, config, () => now);
    expect(ping).toEqual({ model: 'm', ok: true, cause: null, nextProbeAt: null });
    expect(routeHold('m', now)).toBeNull();
    // Down again later: held after the limit, first wait is five minutes again.
    hold('m', now);
    expect(routeHold('m', now + 5 * MIN - 1)).not.toBeNull();
    expect(routeHold('m', now + 5 * MIN)).toBeNull();
  });

  it('keeps the route held while its ping is in flight, so no slot takes an item as the probe', async () => {
    const now = 1_000_000;
    hold('m', now);
    let release: (v: string) => void = () => undefined;
    const fn: Completer = () => new Promise<string>((resolve) => (release = resolve));
    const later = now + 5 * MIN;
    const pending = pingHeldRoutes(['m'], fn, config, () => later);
    expect(routeHold('m', later)).not.toBeNull();
    // A second caller does not ping the same route at once.
    expect(await pingHeldRoutes(['m'], fn, config, () => later)).toEqual([]);
    release('{"ok":true}');
    await pending;
    expect(routeHold('m', later)).toBeNull();
  });

  it('an item that does probe a route and fails also lengthens the wait', () => {
    const now = 1_000_000;
    hold('m', now);
    const due = now + 5 * MIN;
    takeRouteProbe('m', due);
    recordRouteOutcome('m', { ok: false, why: 'model call failed: timeout' }, due);
    expect(routeHold('m', due + 10 * MIN - 1)).not.toBeNull();
    expect(routeHold('m', due + 10 * MIN)).toBeNull();
  });

  it('names a credential failure on the ping as credentials, with no secret in the reason', async () => {
    const now = 1_000_000;
    hold('m', now);
    const c = completer(() => {
      throw new Error('cheap lane HTTP 401 Bearer sk-abcdefghijklmnopqrstuvwxyz');
    });
    const [ping] = await pingHeldRoutes(['m'], c.fn, config, () => now + 5 * MIN);
    expect(ping?.cause).toBe('credentials');
    expect(routeHold('m', now + 5 * MIN)).toMatch(/credentials/);
  });
});

describe("a provider's Retry-After sets the route's hold (lane.ts → worker.ts)", () => {
  beforeEach(() => resetRouteHealth());
  afterEach(() => resetRouteHealth());

  it('reads the delay laneHttpError writes, end to end from a real 429 response', async () => {
    const response = new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    const message = await laneHttpError(response, 'https://omni.test/v1', 'fast');
    expect(providerRetryAfterMs(`model call failed [provider availability]: ${message}`)).toBe(120_000);
    expect(providerRetryAfterMs('model call failed [provider availability]: cheap lane HTTP 503')).toBeNull();
  });

  it('holds the route for the provider\'s delay instead of the ladder\'s first step', () => {
    const now = 1_000_000;
    const why = 'model call failed [provider availability]: cheap lane HTTP 429 from omni.test model m retry-after 120s';
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why }, now);
    expect(routeHold('m', now + 119_000)).not.toBeNull();
    expect(routeHold('m', now + 120_000)).toBeNull();
  });

  it('a long provider delay holds longer than the ladder would, up to its last step', () => {
    const now = 1_000_000;
    const why = 'model call failed [provider availability]: cheap lane HTTP 429 from omni.test model m retry-after 1800s';
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why }, now);
    expect(routeHold('m', now + ROUTE_REPROBE_BACKOFF_MS[0]!)).not.toBeNull();
    expect(routeHold('m', now + 1_800_000)).toBeNull();
    resetRouteHealth();
    const huge = 'model call failed [provider availability]: cheap lane HTTP 429 from omni.test model m retry-after 86400s';
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why: huge }, now);
    expect(routeHold('m', now + ROUTE_REPROBE_BACKOFF_MS.at(-1)!)).toBeNull();
  });

  it('a tiny provider delay is floored so the route is not pinged every control step', () => {
    const now = 1_000_000;
    const why = 'model call failed [provider availability]: cheap lane HTTP 429 from omni.test model m retry-after 1s';
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why }, now);
    expect(routeHold('m', now + ROUTE_RETRY_AFTER_FLOOR_MS - 1)).not.toBeNull();
    expect(routeHold('m', now + ROUTE_RETRY_AFTER_FLOOR_MS)).toBeNull();
  });

  it('a failed health ping that carries Retry-After sets the next probe from it', async () => {
    const now = 1_000_000;
    hold('m', now);
    const failing: Completer = async () => {
      throw new Error('cheap lane HTTP 429 from omni.test model m retry-after 300s');
    };
    const due = now + ROUTE_REPROBE_BACKOFF_MS[0]!;
    const [ping] = await pingHeldRoutes(['m'], failing, config, () => due);
    expect(ping?.ok).toBe(false);
    expect(ping?.nextProbeAt).toBe(due + 300_000);
  });
});
