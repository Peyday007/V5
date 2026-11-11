/**
 * CAP-16-3, first remedial action: the cause of failing model throughput is read
 * from production item rows, consumed by the recorded reading and the
 * constraint's recommendation, and whether queued work advanced afterwards is
 * measured against the previous recorded reading.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import {
  chooseConstraint,
  judgeThroughput,
  recordStageCapacity,
  RESTORE_ACTION,
  STAGE_CAPACITY_EVENT,
  stageCapacity,
  type RouteDiagnosis,
  type StageReading,
} from '../server/services/freeLane/stageCapacity.ts';
import {
  recordRouteOutcome,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_STATE_EVENT,
} from '../server/services/freeLane/worker.ts';

const item = (reason: string, outcome = 'FAILED_RETRYABLE') =>
  recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason });

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('judgeThroughput (pure)', () => {
  const route = (over: Partial<RouteDiagnosis>): RouteDiagnosis => ({
    model: 'm', failures: 0, causes: {}, dominantCause: null, submitted: 0, lastFailureAt: null, lastSubmittedAt: null,
    held: 0, restored: 0, status: 'IDLE', ...over,
  });

  it('names the cause of a failing route and the action that restores it', () => {
    const result = judgeThroughput(
      [route({ model: 'qwen3:4b', failures: 5, causes: { 'broken GPU': 5 }, dominantCause: 'broken GPU', status: 'FAILING' })],
      { measured: false, reason: 'no earlier reading' },
    );
    expect(result.verdict).toBe('FAILING');
    expect(result.cause).toBe('broken GPU');
    expect(result.action).toBe(RESTORE_ACTION['broken GPU']);
    expect(result.basis).toContain('qwen3:4b (broken GPU, 5 failures)');
  });

  it('reports NOT_ADVANCING when no route fails but queued work was not accepted', () => {
    const result = judgeThroughput([], {
      measured: true,
      value: { previousAt: '2026-11-09T00:00:00.000Z', previousQueued: 40, queuedNow: 41, submittedSince: 0, advancing: false },
    });
    expect(result.verdict).toBe('NOT_ADVANCING');
  });

  it('reports RESTORED when a route that failed answers again and work advanced', () => {
    const result = judgeThroughput(
      [route({ model: 'a', failures: 3, causes: { credentials: 3 }, dominantCause: 'credentials', submitted: 2, status: 'RESTORED' })],
      { measured: true, value: { previousAt: '2026-11-09T00:00:00.000Z', previousQueued: 40, queuedNow: 38, submittedSince: 2, advancing: true } },
    );
    expect(result.verdict).toBe('RESTORED');
    expect(result.basis).toContain('a (was credentials)');
  });

  it('feeds the cause into the constraint recommendation, never a web-process scale-up', () => {
    const stage: StageReading = {
      stage: 'model-interpretation', label: 'model', queueSize: { measured: true, value: 9 },
      oldestUsefulItemMinutes: { measured: true, value: 1 }, itemsProcessedPerHour: { measured: true, value: 5 },
      uniqueUsableFacts: { measured: true, value: 0 }, droppedOrDuplicate: { measured: true, value: 5 },
      modelCallsAvoided: { measured: false, reason: 'x' }, providerFailures: { measured: true, value: 5 },
      elapsedMs: { measured: true, value: 0 }, incrementalDollars: { measured: false, reason: 'x' }, accepted: 0, acceptedPerHour: 0,
    };
    const throughput = judgeThroughput(
      [route({ model: 'g', failures: 4, causes: { credentials: 4 }, dominantCause: 'credentials', status: 'FAILING' })],
      { measured: false, reason: 'first' },
    );
    const constraint = chooseConstraint([stage], throughput);
    expect(constraint.recommendation).toContain(RESTORE_ACTION.credentials);
    expect(constraint.recommendation).toMatch(/Do not enlarge the web process/);
  });
});

describe('stage capacity reads the cause and the queue advance from production rows', () => {
  beforeEach(async () => {
    await freshProject();
    resetRouteHealth();
  });
  afterEach(async () => {
    await teardown();
  });

  it('classifies each route from its own item reasons, ignoring database pressure', async () => {
    await item('model qwen3:4b: model call failed [broken GPU]: CUDA out of memory');
    await item('model qwen3:4b: model call failed: HTTP 404 model not found');
    await item('model qwen3:4b: model call failed: database pool had no free connection');
    await item('model brain-a: model call failed [provider availability]: HTTP 503');
    await item('model brain-a', 'SUBMITTED');
    const report = await stageCapacity({ hours: 6 });
    const gpu = report.throughput.routes.find((r) => r.model === 'qwen3:4b')!;
    expect(gpu.failures).toBe(2);
    expect(gpu.causes).toEqual({ 'broken GPU': 1, 'task routing': 1 });
    expect(gpu.status).toBe('FAILING');
    const a = report.throughput.routes.find((r) => r.model === 'brain-a')!;
    expect(a.status).toBe('RESTORED');
    expect(report.throughput.verdict).toBe('FAILING');
    expect(['broken GPU', 'task routing']).toContain(report.throughput.cause);
  });

  it('records route held and restored transitions and counts them per route', async () => {
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('g', { ok: false, why: 'model call failed [credentials]: HTTP 401' });
    recordRouteOutcome('g', { ok: true });
    await settle();
    const rows = await getDb().all<{ outcome: string; reason: string }>(
      'SELECT outcome, reason FROM bin_events WHERE event_type = ? ORDER BY at',
      [ROUTE_STATE_EVENT],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['HELD', 'RESTORED']);
    expect(rows[0]!.reason).toContain('credentials');
    const report = await stageCapacity({ hours: 6 });
    const g = report.throughput.routes.find((r) => r.model === 'g')!;
    expect(g.held).toBe(1);
    expect(g.restored).toBe(1);
  });

  it('measures whether queued work advanced since the previous recorded reading', async () => {
    const first = await recordStageCapacity({ hours: 6 });
    expect(first!.throughput.queue.measured).toBe(false);
    await settle();
    await item('model m', 'SUBMITTED');
    const second = await recordStageCapacity({ hours: 6, now: Date.now() + 1000 });
    expect(second!.throughput.queue.measured).toBe(true);
    if (second!.throughput.queue.measured) {
      expect(second!.throughput.queue.value.submittedSince).toBe(1);
      expect(second!.throughput.queue.value.advancing).toBe(true);
    }
    const rows = await getDb().all<{ reason: string; measures: string }>(
      'SELECT reason, measures FROM bin_events WHERE event_type = ? ORDER BY at',
      [STAGE_CAPACITY_EVENT],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.reason).toMatch(/^(RESTORED|NO_FAILURE_SEEN):/);
    const measures = JSON.parse(rows[1]!.measures) as { throughput?: { verdict?: string }; queuedNow?: unknown };
    expect(typeof measures.queuedNow).toBe('number');
    expect(measures.throughput?.verdict).toBeDefined();
  });
});
