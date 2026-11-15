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
import {
  pingHeldRoutes,
  recordRouteOutcome,
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
