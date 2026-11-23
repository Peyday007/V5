/**
 * CAP-16-3, structural review (episode 4): a model route's health is asked of
 * the route with one minimal completion, recorded once as a
 * FREE_LANE_ROUTE_PROBE row, and never by spending a work item on it.
 *
 * Production 2026-11-16 00:17Z → 2026-11-22 06:45Z: r01.cap-16-3 read 57–67%
 * of six hours' lane outcomes as provider failures after three breaker repairs,
 * because each re-probe of a held route, and each queued item cooled on it, was
 * a real item attempt that wrote its own "model call failed" FREE_LANE_ITEM row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import { classifyRouteFailure, redactSecrets, ROUTE_FAILURE_CAUSES } from '../server/services/freeLane/worker.ts';
import {
  nextReprobeDelay,
  probeRoute,
  REPROBE_FIRST_MS,
  REPROBE_MAX_MS,
  ROUTE_PROBE_EVENT,
} from '../server/services/freeLane/routeProbe.ts';

const config: LaneConfig = { url: 'http://lane.invalid', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 180_000 };
const classify = (message: string): string => classifyRouteFailure(message);

interface Row {
  event_type: string;
  outcome: string | null;
  reason: string | null;
  measures: string | null;
  duration_ms: number | null;
}

async function probeRows(): Promise<Row[]> {
  return getDb().all<Row>('SELECT event_type, outcome, reason, measures, duration_ms FROM bin_events WHERE event_type = ? ORDER BY at, id', [ROUTE_PROBE_EVENT]);
}

async function workTouched(): Promise<{ items: number; laneItems: number }> {
  const items = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE state <> 'QUEUED'");
  const laneItems = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM'");
  return { items: Number(items?.n ?? 0), laneItems: Number(laneItems?.n ?? 0) };
}

const failing = (message: string): Completer => async () => {
  throw new Error(message);
};

describe('route probe (CAP-16-3 structural)', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('records one OK row for a route that answers, and touches no work item', async () => {
    const before = await workTouched();
    const asked: { model: string; maxTokens: number | undefined; timeoutMs: number }[] = [];
    const completer: Completer = async (cfg, model, _system, _prompt, options) => {
      asked.push({ model, maxTokens: options?.maxTokens, timeoutMs: cfg.timeoutMs });
      options?.onServed?.(model);
      return '{"ok":true}';
    };
    const result = await probeRoute({ completer, config, model: 'brain-a', classify });
    expect(result).toMatchObject({ ok: true, cause: null, reason: 'model brain-a' });
    expect(asked).toEqual([{ model: 'brain-a', maxTokens: 16, timeoutMs: 60_000 }]);
    const rows = await probeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'OK', reason: 'model brain-a' });
    expect(JSON.parse(rows[0]!.measures ?? '{}')).toMatchObject({ route: 'brain-a', servedBy: 'brain-a' });
    expect(await workTouched()).toEqual(before);
  });

  it.each([
    ['provider availability', 'cheap lane HTTP 429: rate limited'],
    ['credentials', 'cheap lane HTTP 401 unauthorized'],
    ['task routing', 'cheap lane HTTP 404: model qwen not found'],
    ['broken GPU', 'runpod HTTP 404: pod gone'],
    ['database', 'The database pool had no free connection'],
    ['unclassified', 'something nobody has seen before'],
  ])('a failed probe records exactly one FAILED row naming its cause (%s)', async (cause, message) => {
    expect(ROUTE_FAILURE_CAUSES).toContain(cause);
    const before = await workTouched();
    const result = await probeRoute({ completer: failing(message), config, model: 'brain-a', classify });
    expect(result.ok).toBe(false);
    expect(result.cause).toBe(classifyRouteFailure(message));
    const rows = await probeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('FAILED');
    // The FREE_LANE_ITEM shape, so the breaker's replay and the stage measurement read it the same way.
    expect(rows[0]!.reason).toBe(`model brain-a: model call failed [${result.cause}]: ${message}`);
    expect(JSON.parse(rows[0]!.measures ?? '{}')).toMatchObject({ route: 'brain-a', cause: result.cause });
    expect(await workTouched()).toEqual(before);
  });

  it('the database cause is classified the way the worker classifies it', async () => {
    const result = await probeRoute({ completer: failing('The database pool had no free connection'), config, model: 'brain-b', classify });
    expect(result.cause).toBe('database');
  });

  it('never records a credential the provider echoed back', async () => {
    const message = 'cheap lane HTTP 401: invalid api key Bearer abcdefghijklmnopqrstuvwxyz0123 for sk-live_ABCDEFGHIJKLMNOPQRST at https://x.invalid/v1?api_key=SECRETVALUE123';
    const result = await probeRoute({ completer: failing(message), config, model: 'brain-a', classify, redact: redactSecrets });
    expect(result.cause).toBe('credentials');
    const [row] = await probeRows();
    for (const secret of ['abcdefghijklmnopqrstuvwxyz0123', 'sk-live_ABCDEFGHIJKLMNOPQRST', 'SECRETVALUE123']) {
      expect(row!.reason).not.toContain(secret);
      expect(result.reason).not.toContain(secret);
    }
  });

  it('a completer that never resolves cleanly still records the elapsed time', async () => {
    let t = 1_000;
    const completer: Completer = async () => {
      t += 2_500;
      throw new Error('cheap lane HTTP 503');
    };
    const result = await probeRoute({ completer, config, model: 'brain-a', classify, now: () => t });
    expect(result.elapsedMs).toBe(2_500);
    const [row] = await probeRows();
    expect(row!.duration_ms).toBe(2_500);
  });

  it('backs off from five minutes, doubling, capped at an hour', () => {
    expect(nextReprobeDelay(0)).toBe(REPROBE_FIRST_MS);
    expect(REPROBE_FIRST_MS).toBe(5 * 60_000);
    expect(nextReprobeDelay(1)).toBe(10 * 60_000);
    expect(nextReprobeDelay(2)).toBe(20 * 60_000);
    expect(nextReprobeDelay(3)).toBe(40 * 60_000);
    expect(nextReprobeDelay(4)).toBe(REPROBE_MAX_MS);
    expect(nextReprobeDelay(1_000)).toBe(REPROBE_MAX_MS);
    expect(REPROBE_MAX_MS).toBe(60 * 60_000);
    expect(nextReprobeDelay(-3)).toBe(REPROBE_FIRST_MS);
    expect(nextReprobeDelay(Number.NaN)).toBe(REPROBE_FIRST_MS);
    let last = 0;
    for (let n = 0; n < 50; n += 1) {
      const delay = nextReprobeDelay(n);
      expect(delay).toBeGreaterThanOrEqual(last);
      expect(delay).toBeLessThanOrEqual(REPROBE_MAX_MS);
      last = delay;
    }
  });
});
