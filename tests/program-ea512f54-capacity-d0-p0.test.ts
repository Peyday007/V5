/**
 * CAP-16-3: research capacity measured per stage, and a failing model route is
 * named by its cause and held off until it is re-probed.
 *
 * Covers `stageCapacity` / `chooseConstraint` (server/services/freeLane/stageCapacity.ts)
 * and `classifyRouteFailure`, `redactSecrets`, `routeHold` / `recordRouteOutcome`
 * (server/services/freeLane/worker.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  STAGES,
  chooseConstraint,
  stageCapacity,
  type StageReading,
} from '../server/services/freeLane/stageCapacity.ts';
import {
  ROUTE_FAILURE_LIMIT,
  classifyRouteFailure,
  recordRouteOutcome,
  redactSecrets,
  resetRouteHealth,
  routeHold,
} from '../server/services/freeLane/worker.ts';

describe('classifyRouteFailure names the cause from the error itself', () => {
  it.each([
    ['HTTP 401 Unauthorized', 'credentials'],
    ['HTTP 403 forbidden for this key', 'credentials'],
    ['invalid_api_key supplied', 'credentials'],
    ['HTTP 404 model qwen3-4b not found', 'task routing'],
    ['unknown model brain-z', 'task routing'],
    ['CUDA error: device-side assert triggered', 'broken GPU'],
    ['runpod worker exited: out of memory', 'broken GPU'],
    ['database pool had no free connection', 'database'],
    ['HTTP 429 rate limit', 'provider availability'],
    ['HTTP 503 Service Unavailable', 'provider availability'],
    ['fetch failed', 'provider availability'],
    ['the model returned something odd', 'unclassified'],
  ] as const)('%s → %s', (message, cause) => {
    expect(classifyRouteFailure(message)).toBe(cause);
  });
});

describe('redactSecrets keeps credentials out of a recorded reason', () => {
  it('cuts bearer tokens, key-shaped strings and key query parameters', () => {
    const raw =
      'HTTP 401 Authorization: Bearer abc.DEF-123_xyz for sk-ant-AAAAAAAAAAAAAAAAAAAA at https://x.test/v1?api_key=s3cr3t&model=m and ghp_BBBBBBBBBBBBBBBBBBBB';
    const out = redactSecrets(raw);
    expect(out).not.toContain('abc.DEF-123_xyz');
    expect(out).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('BBBBBBBBBBBBBBBBBBBB');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('api_key=[redacted]');
    // Everything that is not a secret survives, so the cause stays readable.
    expect(out).toContain('HTTP 401');
    expect(out).toContain('&model=m');
  });
  it('leaves an ordinary message untouched', () => {
    expect(redactSecrets('HTTP 503 upstream overloaded')).toBe('HTTP 503 upstream overloaded');
  });
});

describe('a failing route is held, re-probed once, and restored when it answers', () => {
  beforeEach(() => resetRouteHealth());
  afterEach(() => resetRouteHealth());

  const fail = (why = 'model call failed [credentials]: HTTP 401 Unauthorized') => ({ ok: false, why });

  it('stays open below the limit and holds at it, naming the cause', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT - 1; i += 1) recordRouteOutcome('brain-a', fail(), t0);
    expect(routeHold('brain-a', t0)).toBeNull();
    recordRouteOutcome('brain-a', fail(), t0);
    const held = routeHold('brain-a', t0 + 1);
    expect(held).toMatch(/model route failing \(credentials\)/);
    // Another model is unaffected.
    expect(routeHold('brain-b', t0 + 1)).toBeNull();
  });

  it('lets exactly one item re-probe after the wait, then holds again until it answers', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome('brain-a', fail(), t0);
    const later = t0 + 5 * 60_000;
    expect(routeHold('brain-a', later)).toBeNull();
    expect(routeHold('brain-a', later + 1)).not.toBeNull();
    // The probe answered: the route is healthy again.
    recordRouteOutcome('brain-a', { ok: true }, later + 2);
    expect(routeHold('brain-a', later + 3)).toBeNull();
  });

  it('does not count Brain’s own database pressure or non-model failures against a route', () => {
    const t0 = 3_000_000;
    for (let i = 0; i < ROUTE_FAILURE_LIMIT + 2; i += 1) {
      recordRouteOutcome('brain-a', { ok: false, why: 'database pool had no free connection' }, t0);
      recordRouteOutcome('brain-a', { ok: false, why: 'the answer cited no source' }, t0);
      recordRouteOutcome('brain-a', { ok: false }, t0);
    }
    expect(routeHold('brain-a', t0 + 1)).toBeNull();
  });

  it('records the latest cause when a route fails for a different reason', () => {
    const t0 = 4_000_000;
    recordRouteOutcome('brain-a', fail(), t0);
    recordRouteOutcome('brain-a', fail(), t0);
    recordRouteOutcome('brain-a', fail('model call failed [broken GPU]: CUDA error'), t0);
    expect(routeHold('brain-a', t0 + 1)).toMatch(/\(broken GPU\)/);
  });
});

function reading(stage: string, over: Partial<StageReading>): StageReading {
  return {
    stage,
    label: stage,
    queueSize: { measured: true, value: 0 },
    oldestUsefulItemMinutes: { measured: true, value: null },
    itemsProcessedPerHour: { measured: true, value: 0 },
    uniqueUsableFacts: { measured: true, value: 0 },
    droppedOrDuplicate: { measured: true, value: 0 },
    modelCallsAvoided: { measured: false, reason: 'x' },
    providerFailures: { measured: true, value: 0 },
    elapsedMs: { measured: true, value: 0 },
    incrementalDollars: { measured: false, reason: 'x' },
    accepted: 0,
    acceptedPerHour: 0,
    ...over,
  };
}

describe('chooseConstraint names a stage only from measurements', () => {
  it('names none when nothing measured is waiting, however slow', () => {
    const c = chooseConstraint([
      reading('model-interpretation', { itemsProcessedPerHour: { measured: true, value: 50 } }),
      reading('source-ingestion', { queueSize: { measured: false, reason: 'unseen' }, itemsProcessedPerHour: { measured: false, reason: 'unseen' } }),
    ]);
    expect(c.stage).toBeNull();
    expect(c.expectedGain.measured).toBe(false);
  });

  it('picks the stage whose waiting work is least likely to be accepted', () => {
    const c = chooseConstraint([
      // 100 waiting, 90% accepted → score 10.
      reading('model-interpretation', { queueSize: { measured: true, value: 100 }, itemsProcessedPerHour: { measured: true, value: 10 }, acceptedPerHour: 9 }),
      // 40 waiting, 0% accepted → score 40.
      reading('evidence-verification', { queueSize: { measured: true, value: 40 }, itemsProcessedPerHour: { measured: true, value: 10 }, acceptedPerHour: 0 }),
    ]);
    expect(c.stage).toBe('evidence-verification');
    expect(c.basis).toMatch(/40 waiting, 0% of processed items accepted/);
  });

  it('never claims a gain without a recorded dollar cost, and never recommends enlarging the web process', () => {
    const c = chooseConstraint([reading('model-interpretation', { queueSize: { measured: true, value: 5 } })]);
    expect(c.stage).toBe('model-interpretation');
    expect(c.expectedGain.measured).toBe(false);
    expect(c.recommendation).toMatch(/Restore the failing provider/);
    expect(c.recommendation).toMatch(/Do not enlarge the web process/);
  });

  it('skips a stage the rows cannot see even when it would look worst', () => {
    const c = chooseConstraint([
      reading('commercial-execution', { queueSize: { measured: false, reason: 'unseen' }, itemsProcessedPerHour: { measured: false, reason: 'unseen' } }),
      reading('model-interpretation', { queueSize: { measured: true, value: 1 } }),
    ]);
    expect(c.stage).toBe('model-interpretation');
  });
});

describe('stageCapacity reads the lane’s own rows', () => {
  let play: TestProject;
  beforeEach(async () => {
    play = await freshProject();
    await getDb().run('DELETE FROM bin_events', []);
  });

  it('separates every named stage and reports unseen ones as not measured with a reason', async () => {
    const report = await stageCapacity({ hours: 6 });
    expect(report.stages.map((s) => s.stage)).toEqual(STAGES.map((s) => s.id));
    for (const id of ['source-ingestion', 'parsing-indexing', 'graph-quant', 'commercial-execution']) {
      const stage = report.stages.find((s) => s.stage === id)!;
      expect(stage.queueSize.measured).toBe(false);
      if (!stage.queueSize.measured) expect(stage.queueSize.reason.length).toBeGreaterThan(0);
    }
    expect(report.process.scope).toBe('process');
    expect(report.process.rssBytes).toBeGreaterThan(0);
    expect(report.process.network.measured).toBe(false);
  });

  it('counts queue, throughput, provider failures and attributes each productive job to one purpose', async () => {
    const projectId = play.project.id;
    await enqueueWork({ projectId, workType: 'RESEARCH_VERIFY', payload: {}, createdByType: 'SYSTEM' });
    await enqueueWork({ projectId, workType: 'RESEARCH_VERIFY', payload: {}, createdByType: 'SYSTEM' });
    await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: {}, createdByType: 'SYSTEM' });
    // Not yet claimable: not part of the useful queue.
    await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: {}, createdByType: 'SYSTEM', availableAt: new Date(Date.now() + 3_600_000).toISOString() });

    const bin = await createBin({
      projectId, kind: 'RESEARCH_PACKET', title: 'cap', objective: 'cap',
      manifest: { objective: 'cap', why: 't', lineage: { projectId, layerId: null, goal: 'cap', orchestrationId: null }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);

    const ev = (workloadClass: string, outcome: string, reason: string | null, binId: string | null = null) =>
      recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass, outcome, reason, durationMs: 100, binId });
    await ev('RESEARCH_FRAGMENT', 'SUBMITTED', null, bin.id);
    await ev('RESEARCH_FRAGMENT', 'SUBMITTED', null);
    await ev('RESEARCH_FRAGMENT', 'FAILED_RETRYABLE', 'model brain-a: model call failed [provider availability]: HTTP 503');
    await ev('RESEARCH_VERIFY', 'FAILED_RETRYABLE', 'model brain-a: model call failed [credentials]: HTTP 401');
    await ev('RESEARCH_VERIFY', 'FAILED_RETRYABLE', 'the answer cited no source');

    const report = await stageCapacity({ hours: 2 });
    const model = report.stages.find((s) => s.stage === 'model-interpretation')!;
    const verify = report.stages.find((s) => s.stage === 'evidence-verification')!;

    expect(model.queueSize).toEqual({ measured: true, value: 1 });
    expect(verify.queueSize).toEqual({ measured: true, value: 2 });
    expect(model.oldestUsefulItemMinutes.measured).toBe(true);
    expect(model.itemsProcessedPerHour).toEqual({ measured: true, value: 1.5 });
    expect(model.accepted).toBe(2);
    expect(model.acceptedPerHour).toBe(1);
    expect(model.droppedOrDuplicate).toEqual({ measured: true, value: 1 });
    expect(model.providerFailures).toEqual({ measured: true, value: 1 });
    expect(model.elapsedMs).toEqual({ measured: true, value: 300 });
    expect(verify.providerFailures).toEqual({ measured: true, value: 1 });
    expect(verify.accepted).toBe(0);
    expect(model.incrementalDollars.measured).toBe(false);

    // Two productive jobs, each counted once: one attributed to its bin's purpose, one unattributed.
    expect(report.totalProductiveJobs).toBe(2);
    expect(report.purposesSumToTotal).toBe(true);
    expect(report.purposes).toEqual(
      expect.arrayContaining([
        { purpose: 'PLAY_RESEARCH', productiveJobs: 1 },
        { purpose: 'UNATTRIBUTED', productiveJobs: 1 },
      ]),
    );
    // Verification has waiting work and accepts nothing: it is the constraint.
    expect(report.constrained.stage).toBe('evidence-verification');
  });

  it('ignores events outside the window', async () => {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED' });
    const report = await stageCapacity({ hours: 1, now: Date.now() + 2 * 3_600_000 });
    expect(report.totalProductiveJobs).toBe(0);
    expect(report.stages.find((s) => s.stage === 'model-interpretation')!.accepted).toBe(0);
  });
});
