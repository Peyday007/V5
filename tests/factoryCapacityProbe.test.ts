/**
 * CAP-16-3 is judged from the free lane's hourly `FREE_LANE_STAGE_CAPACITY`
 * rows: UNKNOWN until a recurring reading exists, FAIL when a reading
 * contradicts the requirement, PASS when recent readings separate the six
 * stages, carry every measure, and attribute productive work to purposes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { stageCapacityHoldsOnRows } from '../server/services/factory/program/release01/capacityProbe.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';

beforeEach(async () => {
  await freshProject();
});
afterEach(async () => {
  await teardown();
});

const ok = (value: unknown) => ({ measured: true, value });
const not = (reason: string) => ({ measured: false, reason });

/** One lane stage as the free lane writes it: every core measure a real number. */
function laneStage(stage: string, label: string): Record<string, unknown> {
  return {
    stage,
    label,
    queueSize: ok(12),
    oldestUsefulItemMinutes: ok(40),
    itemsProcessedPerHour: ok(3.5),
    uniqueUsableFacts: ok(17),
    droppedOrDuplicate: ok(1),
    modelCallsAvoided: not('no lane item in the window recorded its model calls'),
    providerFailures: ok(2),
    elapsedMs: ok(812_000),
    incrementalDollars: not('no RunPod supervisor sample in the window'),
    resources: ok({ scope: 'stage', itemsMetered: 4, itemsInWindow: 21, modelCalls: 9, cpuSeconds: 3.2, cpuBound: 'UPPER', peakRssBytes: 1e8, meanRssShareBytes: 2e7, dbCalls: 40, dbMs: 120, networkBytesOut: 5000, networkBytesIn: 90000 }),
    accepted: 15,
    acceptedPerHour: 2.5,
  };
}

/** A stage the lane does not run, read from its own table, with honest labels where the table records nothing. */
function rowStage(stage: string, label: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage,
    label,
    queueSize: not('feeds are pulled on the feed tick\'s schedule; no fetch waits in a queue'),
    oldestUsefulItemMinutes: not('no queue'),
    itemsProcessedPerHour: ok(1),
    uniqueUsableFacts: ok(4),
    droppedOrDuplicate: ok(0),
    modelCallsAvoided: not('calls no model'),
    providerFailures: not('calls no provider'),
    elapsedMs: not('the table records no duration'),
    incrementalDollars: not('the lane records no dollar cost per job'),
    resources: not('this stage runs outside the free lane'),
    accepted: 6,
    acceptedPerHour: 1,
    ...overrides,
  };
}

function reading(mutate: (m: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const measures: Record<string, unknown> = {
    windowHours: 6,
    stages: [
      rowStage('source-ingestion', 'source fetching / ingestion'),
      rowStage('parsing-indexing', 'parsing and indexing', { queueSize: ok(0), oldestUsefulItemMinutes: ok(null), elapsedMs: ok(4000) }),
      rowStage('graph-quant', 'graph / detection / quant computation', { modelCallsAvoided: ok(30) }),
      laneStage('model-interpretation', 'model-based interpretation'),
      laneStage('evidence-verification', 'evidence verification'),
      rowStage('commercial-execution', 'human / authorized commercial execution', { queueSize: ok(2), oldestUsefulItemMinutes: ok(300) }),
    ],
    purposes: [
      { purpose: 'PLAY_RESEARCH', productiveJobs: 20 },
      { purpose: 'BRAIN_IMPROVEMENT', productiveJobs: 10 },
    ],
    totalProductiveJobs: 30,
    purposesSumToTotal: true,
    attributionSumsToTotal: true,
  };
  mutate(measures);
  return measures;
}

async function record(minutesAgo: number, measures: Record<string, unknown> | null, outcome = 'MEASURED'): Promise<void> {
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, outcome, reason, evidence_class, measures)
     VALUES (?, 'FREE_LANE_STAGE_CAPACITY', ?, ?, ?, 'MEASURED', ?)`,
    [newId('bev'), new Date(Date.now() - minutesAgo * 60_000).toISOString(), outcome, 'reading', JSON.stringify(measures ?? {})],
  );
}

// The stage half of r01.cap-16-3; the throughput half is tested in factoryProgramAmendments.
const probe = async () => stageCapacityHoldsOnRows();

describe('r01.cap-16-3: stage-level research capacity', () => {
  it('is UNKNOWN with no reading, and with only one', async () => {
    expect((await probe()).ok).toBeNull();
    await record(10, reading());
    const one = await probe();
    expect(one.ok).toBeNull();
    expect(one.detail).toMatch(/not yet shown to recur/);
  });

  it('passes on recurring, well-formed readings that attribute productive work', async () => {
    await record(10, reading());
    await record(70, reading());
    const result = await probe();
    expect(result.detail).toMatch(/all six stages/);
    expect(result.ok).toBe(true);
  });

  it('is UNKNOWN when no productive job has been attributed yet', async () => {
    const idle = (m: Record<string, unknown>) => {
      m['purposes'] = [];
      m['totalProductiveJobs'] = 0;
    };
    await record(10, reading(idle));
    await record(70, reading(idle));
    expect((await probe()).ok).toBeNull();
  });

  it('fails when a required stage is missing', async () => {
    await record(10, reading((m) => {
      m['stages'] = (m['stages'] as Record<string, unknown>[]).filter((s) => s['stage'] !== 'evidence-verification');
    }));
    await record(70, reading());
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/evidence verification/);
  });

  it('fails when a measure is absent altogether, unlabelled, or negative', async () => {
    await record(10, reading((m) => {
      delete (m['stages'] as Record<string, unknown>[])[0]!['droppedOrDuplicate'];
    }));
    await record(70, reading());
    expect((await probe()).detail).toMatch(/carries no droppedOrDuplicate/);

    await freshProject();
    await record(10, reading((m) => {
      (m['stages'] as Record<string, unknown>[])[3]!['providerFailures'] = ok(-1);
    }));
    await record(70, reading());
    const negative = await probe();
    expect(negative.ok).toBe(false);
    expect(negative.detail).toMatch(/negative/);

    await freshProject();
    await record(10, reading((m) => {
      (m['stages'] as Record<string, unknown>[])[0]!['elapsedMs'] = { measured: false };
    }));
    await record(70, reading());
    expect((await probe()).ok).toBe(false);
  });

  it('fails when the stage restored first does not measure its queue', async () => {
    await record(10, reading((m) => {
      (m['stages'] as Record<string, unknown>[])[3]!['queueSize'] = not('unknown');
    }));
    await record(70, reading());
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/restored first/);
  });

  it('fails when purposes do not sum to the productive total', async () => {
    await record(10, reading((m) => {
      m['totalProductiveJobs'] = 31;
    }));
    await record(70, reading());
    expect((await probe()).ok).toBe(false);
  });

  it('fails when the measurement has stopped or keeps failing', async () => {
    await record(300, reading());
    await record(360, reading());
    const stopped = await probe();
    expect(stopped.ok).toBe(false);
    expect(stopped.detail).toMatch(/stopped/);

    await freshProject();
    await record(5, null, 'NOT_MEASURED');
    await record(65, null, 'NOT_MEASURED');
    await record(125, reading());
    expect((await probe()).ok).toBe(false);
  });
});
