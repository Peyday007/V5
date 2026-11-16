/**
 * CAP-16-3, repair episode 3: an intermittently failing model route is held by
 * its failure ratio, not only by consecutive failures.
 *
 * Production, 2026-11-16 16:48Z: brain-a's provider was "overloaded: 89% of 9
 * calls failed" beside a healthy GPU route, and r01.cap-16-3 read 62–98% of six
 * hours' free-lane outcomes as provider failures. The breaker forgot a route's
 * failures on a single answer, and that answer also ended every route cooldown,
 * so a provider answering about one call in nine was never held.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  recordRouteOutcome,
  resetRouteHealth,
  restoreRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_WINDOW_MS,
  routeHold,
  routeWindowFailing,
  takeRouteProbe,
} from '../server/services/freeLane/worker.ts';

const BUSY = 'model call failed [provider availability]: cheap lane HTTP 503';
const LIMITED = 'model call failed [provider availability]: cheap lane HTTP 429';
const REPROBE_MS = 5 * 60_000;

describe('route breaker under an intermittent provider (the recorded failure class)', () => {
  beforeEach(() => resetRouteHealth());

  it('keeps a route held when one answer interrupts a run of mostly failing calls', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    // Five failures, one answer, four failures: nine in ten fail.
    for (let i = 0; i < 5; i += 1) recordRouteOutcome('brain-a', { ok: false, why: i % 2 ? LIMITED : BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    // The rare answer: before this repair it deleted the route's state, reopening it to every slot.
    const open = recordRouteOutcome('brain-a', { ok: true }, (at += 1000));
    expect(open).toBe(false); // the caller does not clear the route's cooldowns
    expect(routeWindowFailing('brain-a', at)).toBe(true);
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    for (let i = 0; i < 4; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();
  });

  it('after that one answer, the very next failure finds the route still held rather than starting a fresh count', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 5; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    recordRouteOutcome('brain-a', { ok: true }, (at += 1000));
    recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    // Before this repair: one failure after a reset, under ROUTE_FAILURE_LIMIT, so every slot took items again.
    expect(ROUTE_FAILURE_LIMIT).toBeGreaterThan(1);
    expect(routeHold('brain-a', at)).not.toBeNull();
  });

  it('offers a held route one re-probe per interval, and releases it once its window is back under the bar', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();

    at += REPROBE_MS;
    expect(routeHold('brain-a', at)).toBeNull(); // the single re-probe is due
    takeRouteProbe('brain-a', at);
    expect(routeHold('brain-a', at)).not.toBeNull(); // the next item waits for it
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(false); // 1 of 9 answered: still failing
    expect(routeHold('brain-a', at)).not.toBeNull();
    expect(routeHold('brain-a', at + REPROBE_MS - 1)).not.toBeNull();

    at += REPROBE_MS;
    expect(routeHold('brain-a', at)).toBeNull();
    takeRouteProbe('brain-a', at);
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(true); // 2 of 10 answered: no longer under one in five
    expect(routeHold('brain-a', at)).toBeNull();
    expect(routeWindowFailing('brain-a', at)).toBe(false);
  });

  it('forgets failures older than the window, so a recovered route is not held for its past', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    at += ROUTE_WINDOW_MS;
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(true);
    expect(routeHold('brain-a', at)).toBeNull();
  });
});

describe('route breaker leaves a mostly answering route alone (2026-11-15 07:46Z)', () => {
  beforeEach(() => resetRouteHealth());

  it('never holds a route that answers seven calls in nine through occasional 503s', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const pattern = [true, true, false, true, true, true, false, true, true];
    for (let round = 0; round < 3; round += 1) {
      for (const ok of pattern) {
        const open = recordRouteOutcome('brain-a', ok ? { ok: true } : { ok: false, why: BUSY }, (at += 1000));
        if (ok) expect(open).toBe(true); // its answers still end the route's cooldowns
        expect(routeHold('brain-a', at)).toBeNull();
      }
    }
    expect(routeWindowFailing('brain-a', at)).toBe(false);
  });

  it('still never counts Brain\'s own database being unavailable against a model route', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const why = 'model call failed: The database pool had no free connection (12 caller(s) waiting)';
    for (let i = 0; i < 10; i += 1) recordRouteOutcome('brain-a', { ok: false, why }, (at += 1000));
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(routeHold('brain-a', at)).toBeNull();
  });

  it('a failing route does not hold another one', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();
    expect(routeHold('runpod/openai/gpt-oss-120b', at)).toBeNull();
    expect(recordRouteOutcome('runpod/openai/gpt-oss-120b', { ok: true }, at)).toBe(true);
  });
});

describe('route breaker survives a worker restart (review F1: the window was process memory)', () => {
  let seq = 0;
  async function laneRow(at: number, model: string, why: string | null): Promise<void> {
    seq += 1;
    await getDb().run(
      `INSERT INTO bin_events (id, event_type, at, outcome, reason) VALUES (?, 'FREE_LANE_ITEM', ?, ?, ?)`,
      [
        `bev_route_${seq}`,
        new Date(at).toISOString(),
        why === null ? 'SUBMITTED' : 'RELEASED_TRANSIENT',
        why === null ? `model ${model}` : `model ${model}: ${why}`,
      ],
    );
  }

  beforeEach(async () => {
    await freshProject();
    resetRouteHealth();
  });

  it('a failing route recorded before the restart is held on the first tick after it, with no new failure', async () => {
    const start = Date.parse('2026-11-16T16:00:00.000Z');
    let at = start;
    // Production pattern: about one call in nine answered.
    for (let i = 0; i < 9; i += 1) await laneRow((at += 10_000), 'brain-a', i === 4 ? null : i % 2 ? LIMITED : BUSY);
    // A healthy route beside it.
    for (let i = 0; i < 5; i += 1) await laneRow((at += 10_000), 'runpod/qwen', null);

    // The restart: every bit of memory is gone.
    resetRouteHealth();
    expect(routeHold('brain-a', at)).toBeNull(); // the defect, before the rows are read

    const replayed = await restoreRouteHealth(['brain-a', 'runpod/qwen'], at);
    expect(replayed).toBe(14);
    expect(routeWindowFailing('brain-a', at)).toBe(true);
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHold('runpod/qwen', at)).toBeNull();
    expect(routeWindowFailing('runpod/qwen', at)).toBe(false);
  });

  it('rows older than the window are not replayed, so a recovered route is not held for its past', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) await laneRow((at += 1000), 'brain-a', BUSY);
    at += ROUTE_WINDOW_MS + 1000;
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(0);
    expect(routeHold('brain-a', at)).toBeNull();
  });

  it('replays once per process, and never double-counts a route already judged live', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 3; i += 1) await laneRow((at += 1000), 'brain-a', BUSY);
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(3);
    // The next tick reads nothing again.
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(0);

    // A route this process already called keeps its live window rather than adding the rows to it.
    resetRouteHealth();
    recordRouteOutcome('brain-b', { ok: true }, at);
    for (let i = 0; i < 6; i += 1) await laneRow((at += 1000), 'brain-b', BUSY);
    expect(await restoreRouteHealth(['brain-b'], at)).toBe(0);
    expect(routeHold('brain-b', at)).toBeNull();
  });

  it('Brain\'s own database outage recorded in the rows is still not counted against the route', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const why = 'model call failed: The database pool had no free connection (12 caller(s) waiting)';
    for (let i = 0; i < 8; i += 1) await laneRow((at += 1000), 'brain-a', why);
    await restoreRouteHealth(['brain-a'], at);
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(routeHold('brain-a', at)).toBeNull();
  });
});
