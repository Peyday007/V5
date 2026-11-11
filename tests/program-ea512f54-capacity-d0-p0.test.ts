/**
 * CAP-16-3: stage-level research capacity is measured from the rows, the
 * constrained stage is named only from measurements, and a failing model route
 * is classified by its own error, held after repeated failures, re-probed, and
 * never leaks a credential into a recorded reason.
 *
 * Covers stageCapacity, chooseConstraint, recordStageCapacity (stageCapacity.ts)
 * and classifyRouteFailure, redactSecrets, routeHold, takeRouteProbe and
 * recordRouteOutcome
 * (worker.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  chooseConstraint,
  isDroppedOutcome,
  recordStageCapacity,
  STAGE_CAPACITY_EVENT,
  STAGES,
  stageCapacity,
  type StageReading,
} from '../server/services/freeLane/stageCapacity.ts';
import {
  classifyRouteFailure,
  recordRouteOutcome,
  redactSecrets,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  routeHold,
  takeRouteProbe,
} from '../server/services/freeLane/worker.ts';

/* ------------------------------------------------------------------------- */
/* chooseConstraint: pure                                                     */
/* ------------------------------------------------------------------------- */

function reading(stage: string, waiting: number | null, processedPerHour: number, acceptedPerHour: number): StageReading {
  const measured = <T>(value: T) => ({ measured: true as const, value });
  const not = { measured: false as const, reason: 'unseen' };
  return {
    stage,
    label: `${stage} label`,
    queueSize: waiting === null ? not : measured(waiting),
    oldestUsefulItemMinutes: waiting === null ? not : measured(0),
    itemsProcessedPerHour: waiting === null ? not : measured(processedPerHour),
    uniqueUsableFacts: measured(0),
    droppedOrDuplicate: measured(0),
    modelCallsAvoided: not,
    providerFailures: measured(0),
    elapsedMs: measured(0),
    incrementalDollars: not,
    accepted: 0,
    acceptedPerHour,
  };
}

describe('chooseConstraint', () => {
  it('names no stage when nothing measured has work waiting', () => {
    const result = chooseConstraint([reading('a', 0, 10, 1), reading('b', null, 0, 0)]);
    expect(result.stage).toBeNull();
    expect(result.expectedGain.measured).toBe(false);
  });

  it('ignores unmeasured stages and picks the one with the most waiting, poorly accepted work', () => {
    const result = chooseConstraint([
      reading('healthy', 10, 10, 9), // 10 waiting × 10% unaccepted = 1
      reading('failing', 5, 10, 0), // 5 waiting × 100% unaccepted = 5
      reading('unseen', null, 0, 0),
    ]);
    expect(result.stage).toBe('failing');
    expect(result.basis).toContain('5 waiting');
    expect(result.basis).toContain('0% of processed items accepted');
  });

  it('never claims a gain without a dollar cost, and never recommends enlarging the web process', () => {
    const result = chooseConstraint([reading('failing', 3, 0, 0)]);
    expect(result.expectedGain.measured).toBe(false);
    expect(result.recommendation).toMatch(/Restore the failing provider/);
    expect(result.recommendation).toMatch(/Do not enlarge the web process/);
  });
});

/* ------------------------------------------------------------------------- */
/* stageCapacity / recordStageCapacity: from the rows                         */
/* ------------------------------------------------------------------------- */

describe('stageCapacity', () => {
  let fixture: TestProject;

  beforeEach(async () => {
    fixture = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  async function binWithPurpose(purpose: string | null): Promise<string> {
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'RESEARCH_PACKET',
      title: 'a bin',
      objective: 'measure',
      manifest: {
        objective: 'measure', why: 'test', lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
        units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [],
        budgetUnits: 1, retry: { maxAttempts: 1, backoffSeconds: 1 }, stoppingConditions: ['done'],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
    } as unknown as Parameters<typeof createBin>[0]);
    await getDb().run('UPDATE bins SET purpose = ? WHERE id = ?', [purpose, bin.id]);
    return bin.id;
  }

  it('measures each lane stage from its rows and says why the others are not measured', async () => {
    await enqueueWork({
      projectId: fixture.project.id, workType: 'RESEARCH_FRAGMENT', payload: {}, createdByType: 'SYSTEM', requiredScopes: ['queue:claim'],
    });
    await enqueueWork({
      projectId: fixture.project.id, workType: 'RESEARCH_VERIFY', payload: {}, createdByType: 'SYSTEM', requiredScopes: ['queue:claim'],
    });
    const improvement = await binWithPurpose('BRAIN_IMPROVEMENT');
    const play = await binWithPurpose('PLAY_RESEARCH');
    const lane = (workloadClass: string, outcome: string, reason: string | null, binId: string | null, durationMs: number) =>
      recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass, outcome, reason, binId, durationMs });
    await lane('RESEARCH_FRAGMENT', 'SUBMITTED', null, improvement, 1000);
    await lane('RESEARCH_FRAGMENT', 'SUBMITTED', null, play, 2000);
    // A provider failure handed back with its attempt refunded: a provider
    // failure, never a dropped or duplicate record.
    await lane('RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', 'model qwen: model call failed: HTTP 503', null, 500);
    await lane('RESEARCH_VERIFY', 'SUBMITTED', null, null, 300);

    const report = await stageCapacity({ hours: 2, now: Date.now() + 1000 });
    expect(report.stages.map((s) => s.stage)).toEqual(STAGES.map((s) => s.id));

    const model = report.stages.find((s) => s.stage === 'model-interpretation')!;
    expect(model.queueSize).toEqual({ measured: true, value: 1 });
    expect(model.oldestUsefulItemMinutes.measured).toBe(true);
    expect(model.itemsProcessedPerHour).toEqual({ measured: true, value: 3 / 2 });
    expect(model.accepted).toBe(2);
    expect(model.acceptedPerHour).toBe(1);
    expect(model.providerFailures).toEqual({ measured: true, value: 1 });
    expect(model.droppedOrDuplicate).toEqual({ measured: true, value: 0 });
    expect(model.elapsedMs).toEqual({ measured: true, value: 3500 });
    // Not recorded by the lane: said so, never invented.
    expect(model.incrementalDollars.measured).toBe(false);
    expect(model.modelCallsAvoided.measured).toBe(false);

    const verify = report.stages.find((s) => s.stage === 'evidence-verification')!;
    expect(verify.queueSize).toEqual({ measured: true, value: 1 });
    expect(verify.accepted).toBe(1);

    for (const id of ['source-ingestion', 'parsing-indexing', 'graph-quant', 'commercial-execution']) {
      const stage = report.stages.find((s) => s.stage === id)!;
      expect(stage.queueSize.measured).toBe(false);
      if (!stage.queueSize.measured) expect(stage.queueSize.reason.length).toBeGreaterThan(0);
    }

    // Every productive job attributed to exactly one purpose.
    expect(report.totalProductiveJobs).toBe(3);
    expect(report.purposesSumToTotal).toBe(true);
    expect(Object.fromEntries(report.purposes.map((p) => [p.purpose, p.productiveJobs]))).toEqual({
      BRAIN_IMPROVEMENT: 1,
      PLAY_RESEARCH: 1,
      UNATTRIBUTED: 1,
    });

    expect(report.process.scope).toBe('process');
    expect(report.process.rssBytes).toBeGreaterThan(0);
    expect(report.process.network.measured).toBe(false);
    expect(report.constrained.stage).not.toBeNull();
  });

  it('keeps provider failures and handed-back items out of the dropped/duplicate count', async () => {
    const lane = (outcome: string, reason: string | null) =>
      recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason, binId: null, durationMs: 10 });
    // The three outcomes worker.ts records, with the reasons it records them under.
    await lane('SUBMITTED', 'model qwen');
    await lane('RELEASED_TRANSIENT', 'model qwen: model call failed: HTTP 429 rate limited');
    await lane('RELEASED_TRANSIENT', 'model qwen: The database pool had no free connection, 593 caller(s) waiting');
    await lane('RELEASED_TRANSIENT', 'model qwen: no JSON in the answer');
    await lane('FAILED_RETRYABLE', 'model qwen: model call failed: HTTP 400 bad request');
    await lane('FAILED_RETRYABLE', "model qwen: the answer did not survive Brain's own checks: 3 claim(s) offered");

    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    const model = report.stages.find((s) => s.stage === 'model-interpretation')!;
    expect(model.itemsProcessedPerHour).toEqual({ measured: true, value: 6 });
    expect(model.accepted).toBe(1);
    expect(model.providerFailures).toEqual({ measured: true, value: 2 });
    // Only the item the lane gave up on without an accepted answer, and not for a
    // provider failure, is dropped: never total minus accepted (which would be 5).
    expect(model.droppedOrDuplicate).toEqual({ measured: true, value: 1 });
  });

  it('excludes events outside the window', async () => {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED' });
    const later = Date.now() + 10 * 3_600_000;
    const report = await stageCapacity({ hours: 1, now: later });
    expect(report.stages.find((s) => s.stage === 'model-interpretation')!.accepted).toBe(0);
    expect(report.totalProductiveJobs).toBe(0);
  });

  it('records the measurement as one production row', async () => {
    const report = await recordStageCapacity({ hours: 6 });
    expect(report).not.toBeNull();
    const rows = await getDb().all<{ outcome: string; measures: string | null }>(
      'SELECT outcome, measures FROM bin_events WHERE event_type = ?',
      [STAGE_CAPACITY_EVENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('MEASURED');
    const measures = JSON.parse(rows[0]!.measures ?? '{}') as { stages?: unknown[]; queuedNow?: unknown };
    expect(measures.stages).toHaveLength(STAGES.length);
    expect(typeof measures.queuedNow).toBe('number');
  });
});

/* ------------------------------------------------------------------------- */
/* Route health                                                               */
/* ------------------------------------------------------------------------- */

describe('classifyRouteFailure', () => {
  it.each([
    ['model call failed: HTTP 401 Unauthorized', 'credentials'],
    ['model call failed: invalid api key', 'credentials'],
    ['model call failed: HTTP 404 model qwen3 not found', 'task routing'],
    ['model call failed: CUDA out of memory on the RunPod pod', 'broken GPU'],
    ['database pool had no free connection', 'database'],
    ['model call failed: HTTP 429 rate limit', 'provider availability'],
    ['model call failed: ECONNRESET', 'provider availability'],
    ['model call failed: the answer was not JSON', 'unclassified'],
  ])('%s → %s', (message, cause) => {
    expect(classifyRouteFailure(message)).toBe(cause);
  });
});

describe('redactSecrets', () => {
  it('cuts out bearer tokens, key-shaped strings and key query parameters', () => {
    const out = redactSecrets(
      'Authorization: Bearer abc.DEF-123_xyz failed with sk-ABCDEFGHIJKLMNOPQRST at https://x.invalid/v1?api_key=s3cr3t&model=q',
    );
    expect(out).not.toContain('abc.DEF-123_xyz');
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOPQRST');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('api_key=[redacted]');
    expect(out).toContain('model=q');
  });

  it('leaves text without a secret unchanged', () => {
    expect(redactSecrets('model call failed: HTTP 503')).toBe('model call failed: HTTP 503');
  });
});

describe('routeHold / recordRouteOutcome', () => {
  beforeEach(() => resetRouteHealth());

  it('holds a route after ROUTE_FAILURE_LIMIT model-call failures, naming the cause', () => {
    const now = 1_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT - 1; i += 1) {
      recordRouteOutcome('m', { ok: false, why: 'model call failed: HTTP 401' }, now);
      expect(routeHold('m', now)).toBeNull();
    }
    recordRouteOutcome('m', { ok: false, why: 'model call failed: HTTP 401' }, now);
    expect(routeHold('m', now)).toMatch(/model route failing \(credentials\)/);
    expect(routeHold('other', now)).toBeNull();
  });

  it('lets one item re-probe after the interval, then holds again until it answers', () => {
    const now = 1_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why: 'model call failed: timeout' }, now);
    expect(routeHold('m', now)).not.toBeNull();
    const later = now + 5 * 60_000;
    expect(routeHold('m', later)).toBeNull(); // the single re-probe is due
    expect(takeRouteProbe('m', later)).toBe(true); // an admitted item takes it
    expect(routeHold('m', later)).not.toBeNull(); // the next item waits for it
    expect(takeRouteProbe('m', later)).toBe(false); // and cannot take it a second time
    recordRouteOutcome('m', { ok: true }, later);
    expect(routeHold('m', later)).toBeNull();
    expect(takeRouteProbe('m', later)).toBe(true); // a healthy route has nothing to spend
  });

  it('does not spend the re-probe slot on an item a later admission filter refuses', () => {
    const now = 1_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('m', { ok: false, why: 'model call failed: timeout' }, now);
    const later = now + 5 * 60_000;
    // takeOne's admit asks routeHold first, then the unfit and freeLaneAdmits
    // filters. Items those filters refuse only ever read the standing, so the
    // slot is still free for the first item that is admitted.
    for (let refused = 0; refused < 5; refused += 1) expect(routeHold('m', later)).toBeNull();
    expect(takeRouteProbe('m', later + 1)).toBe(true);
    expect(routeHold('m', later + 1)).not.toBeNull();
  });

  it('does not count Brain database pressure or non-model failures against a route', () => {
    const now = 1_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT + 2; i += 1) {
      recordRouteOutcome('m', { ok: false, why: 'database pool had no free connection' }, now);
      recordRouteOutcome('m', { ok: false, why: 'the answer cited no source' }, now);
    }
    expect(routeHold('m', now)).toBeNull();
  });
});

describe('isDroppedOutcome', () => {
  it('counts only a non-provider FAILED_RETRYABLE as dropped', () => {
    expect(isDroppedOutcome('FAILED_RETRYABLE', false)).toBe(true);
    expect(isDroppedOutcome('FAILED_RETRYABLE', true)).toBe(false);
    expect(isDroppedOutcome('RELEASED_TRANSIENT', false)).toBe(false);
    expect(isDroppedOutcome('RELEASED_TRANSIENT', true)).toBe(false);
    expect(isDroppedOutcome('SUBMITTED', false)).toBe(false);
    expect(isDroppedOutcome(null, false)).toBe(false);
  });
});
