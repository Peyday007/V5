/**
 * CAP-16-3 / S-0171: "Scale independent worker replicas, CPU, memory,
 * networking, storage and model instances only after measurements identify the
 * constrained stage, with a measured expected gain". The adaptive pool
 * (capacity.ts controlStep) consults the recorded stage-capacity reading
 * through `gateGrowth` before it raises any model's slots past what that model
 * has already proven: restore first, then scale only the measured constraint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { answering, controlStep, decideTarget, readCapacity, startAdaptivePool, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import {
  chooseConstraint,
  gateGrowth,
  perReplicaGain,
  type RecordedStageCapacity,
  type StageCapacityReport,
  type StageReading,
  type ThroughputDiagnosis,
} from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const measured = <T>(value: T) => ({ measured: true as const, value });
const not = { measured: false as const, reason: 'unseen' };

const HOUR_MS = 3_600_000;

/**
 * A stage over the 6 h window. `facts` are its distinct sourced claims; `replicas`
 * is how many items it had in flight on average, recorded as item time
 * (`elapsedMs` = replicas x window), which is how the reading measures it.
 */
function stage(
  id: string,
  waiting: number,
  processedPerHour: number,
  acceptedPerHour: number,
  dollars: number | null = null,
  { facts = 0, replicas = 1 }: { facts?: number; replicas?: number } = {},
): StageReading {
  return {
    stage: id,
    label: `${id} label`,
    queueSize: measured(waiting),
    oldestUsefulItemMinutes: measured(0),
    itemsProcessedPerHour: measured(processedPerHour),
    uniqueUsableFacts: measured(facts),
    droppedOrDuplicate: measured(0),
    modelCallsAvoided: not,
    providerFailures: measured(0),
    elapsedMs: measured(replicas * 6 * HOUR_MS),
    incrementalDollars: dollars === null ? not : measured(dollars),
    resources: not,
    accepted: 0,
    acceptedPerHour,
  };
}

const NO_FAILURE: ThroughputDiagnosis = { routes: [], gpu: { samples: {}, startFailures: 0, lastStartFailure: null, notRunning: false }, primary: null, restored: [] };

function recorded(stages: StageReading[], options: { primary?: ThroughputDiagnosis['primary']; stale?: boolean } = {}): RecordedStageCapacity {
  const diagnosis = { ...NO_FAILURE, primary: options.primary ?? null };
  const report = { windowHours: 6, since: '2026-11-11T00:00:00Z', stages, diagnosis, constrained: chooseConstraint(stages, diagnosis.primary, 6) } as unknown as StageCapacityReport;
  return { at: '2026-11-11T06:00:00Z', outcome: 'MEASURED', reason: 'r', ageMinutes: options.stale ? 300 : 5, stale: !!options.stale, report, queuedNow: 0, queueAdvance: null };
}

const FAILING = { route: 'brain-a', cause: 'credentials' as never, failures: 40, evidence: 'credentials ×40' };
// 2 replicas producing 120 facts in 6 h (20 facts/h, 1 per processed item): one more adds 10 facts/h.
const CONSTRAINED_AT_MODEL = [stage('model-interpretation', 120, 20, 10, null, { facts: 120, replicas: 2 })];

describe('gateGrowth: restore first, then scale only the measured constraint', () => {
  const base = { model: 'brain-a', gpu: false, current: 4, stableHigh: 8 };

  it('never holds shrinking, holding, or regaining proven capacity', () => {
    const failing = recorded(CONSTRAINED_AT_MODEL, { primary: FAILING });
    expect(gateGrowth({ ...base, proposed: 2, recorded: failing })).toEqual({ target: 2, held: false, reason: null });
    expect(gateGrowth({ ...base, proposed: 8, recorded: failing })).toEqual({ target: 8, held: false, reason: null });
  });

  it('holds growth past proven capacity while a model route is failing', () => {
    const v = gateGrowth({ ...base, proposed: 16, recorded: recorded(CONSTRAINED_AT_MODEL, { primary: FAILING }) });
    expect(v.held).toBe(true);
    expect(v.target).toBe(8);
    expect(v.reason).toMatch(/restore model route brain-a first/);
  });

  it('holds only the failing route: another route that serves the work grows (production 2026-11-15: RunPod held at 2 by brain-a)', () => {
    const reading = recorded(CONSTRAINED_AT_MODEL, { primary: { ...FAILING, cause: 'provider availability' as never, failures: 100 } });
    // A free provider beside the failing one grows on its own measured gain.
    const other = gateGrowth({ ...base, model: 'brain-b', proposed: 16, recorded: reading });
    expect(other.held).toBe(false);
    expect(other.target).toBe(16);
    // The GPU slot is gated by its priced gain, never by brain-a's failures.
    const gpu = gateGrowth({ model: 'runpod/Qwen/Qwen3-4B-AWQ', gpu: true, current: 2, stableHigh: 2, proposed: 4, recorded: recorded([stage('model-interpretation', 120, 20, 10, 6, { facts: 120, replicas: 2 })], { primary: { ...FAILING, failures: 100 } }) });
    expect(gpu.reason ?? '').not.toMatch(/restore model route brain-a/);
    expect(gpu.held).toBe(false);
  });

  it('does not hold a failing route that its own live window shows answering since the reading', () => {
    const reading = recorded(CONSTRAINED_AT_MODEL, { primary: FAILING });
    expect(gateGrowth({ ...base, proposed: 16, recorded: reading, answering: false }).held).toBe(true);
    const restored = gateGrowth({ ...base, proposed: 16, recorded: reading, answering: true });
    expect(restored.held).toBe(false);
    expect(restored.target).toBe(16);
  });

  it('reads a route as answering only while its live window accepts work with few provider failures, and still halves an erroring route', () => {
    expect(answering({ ok: 10, content: 1, transient: 1 })).toBe(true);
    expect(answering({ ok: 5, content: 0, transient: 3 })).toBe(false);
    expect(answering({ ok: 0, content: 0, transient: 0 })).toBe(false);
    // Backpressure is the controller's own and is untouched: an overloaded route halves.
    const calm = { db: false, lagMs: 5, cpu: 0.1 };
    expect(decideTarget({ target: 8, active: 8, waiting: 11, window: { ok: 5, content: 0, transient: 5 }, pressure: calm }).target).toBe(4);
  });

  it('holds when the measured constraint is a stage model slots do not serve', () => {
    const v = gateGrowth({ ...base, proposed: 16, recorded: recorded([stage('commercial-execution', 30, 1, 0), stage('model-interpretation', 0, 20, 10)]) });
    expect(v.held).toBe(true);
    expect(v.reason).toMatch(/commercial-execution, which more model slots do not serve/);
  });

  it('holds when no stage has work waiting, when the reading is stale, and when the measured gain is zero', () => {
    expect(gateGrowth({ ...base, proposed: 16, recorded: recorded([stage('model-interpretation', 0, 20, 10)]) }).reason).toMatch(/no measured stage has work waiting/);
    expect(gateGrowth({ ...base, proposed: 16, recorded: recorded(CONSTRAINED_AT_MODEL, { stale: true }) }).reason).toMatch(/300 min old/);
    expect(gateGrowth({ ...base, proposed: 16, recorded: recorded([stage('model-interpretation', 50, 20, 0)]) }).reason).toMatch(/0 accepted facts\/h/);
  });

  it('allows growth on a free provider when the constraint is a lane stage with a measured gain at $0', () => {
    const v = gateGrowth({ ...base, proposed: 16, recorded: recorded(CONSTRAINED_AT_MODEL) });
    expect(v).toMatchObject({ target: 16, held: false });
    expect(v.reason).toMatch(/constrained at model-interpretation; measured gain 10 accepted facts\/h for \$0\/h/);
  });

  it('on a GPU slot requires the reading’s priced expected gain', () => {
    expect(gateGrowth({ ...base, gpu: true, proposed: 16, recorded: recorded(CONSTRAINED_AT_MODEL) }).reason).toMatch(/GPU's expected gain is not measured/);
    // $6 over 6 h is $1/h for the stage, run by 2 replicas: one more costs $0.5/h.
    const priced = gateGrowth({ ...base, gpu: true, proposed: 16, recorded: recorded([stage('model-interpretation', 120, 20, 10, 6, { facts: 120, replicas: 2 })]) });
    expect(priced).toMatchObject({ target: 16, held: false });
    expect(priced.reason).toMatch(/measured gain 10 accepted facts\/h for \$0\.5\/h/);
  });
});

describe('the expected gain is what ONE added replica adds, in accepted facts per hour', () => {
  it('divides the stage\'s facts per hour and its dollars by the replicas it measurably ran', () => {
    // 4 replicas, 240 facts in 6 h = 40 facts/h; $24 in 6 h = $4/h. Backlog is ample.
    const s = stage('model-interpretation', 1000, 40, 40, 24, { facts: 240, replicas: 4 });
    const gain = chooseConstraint([s], null, 6).expectedGain;
    expect(gain).toEqual({ measured: true, value: { acceptedFactsPerHour: 10, dollars: 1 } });
    // Not the whole stage's rate or spend.
    expect(perReplicaGain(s, 6)).not.toEqual({ measured: true, value: { acceptedFactsPerHour: 40, dollars: 4 } });
  });

  it('counts accepted facts, not accepted items', () => {
    // 60 items accepted per hour, but they carried no sourced claim: nothing is gained.
    const s = stage('model-interpretation', 500, 60, 60, 6, { facts: 0, replicas: 2 });
    expect(perReplicaGain(s, 6)).toEqual({ measured: true, value: { acceptedFactsPerHour: 0, dollars: 0.5 } });
  });

  it('bounds it by the facts the waiting work yields per hour, not by a raw count', () => {
    // 3 waiting at 0.5 facts per processed item = 1.5 facts, over the 6 h window = 0.25 facts/h,
    // although one replica runs at 30 facts/h (the old bound compared 1.5 facts with a rate).
    const s = stage('model-interpretation', 3, 120, 60, 6, { facts: 360, replicas: 2 });
    const gain = perReplicaGain(s, 6);
    expect(gain.measured && gain.value.acceptedFactsPerHour).toBeCloseTo(0.25, 10);
  });

  it('is not measured when the facts, the replicas or the spend are not', () => {
    const s = stage('model-interpretation', 100, 20, 10, 6, { facts: 60, replicas: 2 });
    expect(perReplicaGain({ ...s, uniqueUsableFacts: not }, 6).measured).toBe(false);
    expect(perReplicaGain({ ...s, elapsedMs: not }, 6).measured).toBe(false);
    expect(perReplicaGain({ ...s, elapsedMs: measured(0) }, 6).measured).toBe(false);
    expect(perReplicaGain({ ...s, incrementalDollars: not }, 6).measured).toBe(false);
    // A free provider's slot is priced at $0 by its caller and still needs the rest.
    expect(perReplicaGain({ ...s, incrementalDollars: not }, 6, 0)).toEqual({ measured: true, value: { acceptedFactsPerHour: 5, dollars: 0 } });
  });

  it('gates a free slot on the per-replica gain, not the stage total', () => {
    const v = gateGrowth({ model: 'brain-a', gpu: false, current: 4, stableHigh: 8, proposed: 16, recorded: recorded([stage('model-interpretation', 1000, 40, 40, null, { facts: 240, replicas: 4 })]) });
    expect(v.reason).toMatch(/measured gain 10 accepted facts\/h for \$0\/h/);
  });
});

/* ------------------------------------------------------------------------- */
/* The production path: controlStep consults the gate                         */
/* ------------------------------------------------------------------------- */

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
const calm = { db: false, lagMs: 5, cpu: 0.1 };
let play: TestProject;
let inFlight = 0;
let peak = 0;

/** A route whose provider answers every call with a 503, or null. */
let failRoute: string | null = null;
const completer: Completer = async (_c, name, _s, prompt) => {
  if (name === failRoute) throw new Error('cheap lane HTTP 503');
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 40));
  inFlight -= 1;
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: ['https://www.bls.gov/x'] });
  const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
  const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
  return JSON.stringify({
    claims: [{ claim: 'US median receptionist wage was $17.39 an hour in May 2024.', claim_type: 'SOURCED_FACT', source: Number(ref?.[1]), sentences: [Number(ref?.[2])], evidence_lane: 'wage' }],
  });
};
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
  retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length,
});

async function queueFragments(n: number): Promise<void> {
  const layerId = (await play.layerByName('Monetization Logic')).id;
  for (let i = 0; i < n; i += 1) {
    const run = await createRun({ projectId: play.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
    const orchestration = await createOrchestration({ projectId: play.project.id, layerId, runId: run.id, title: `Receptionist wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([{
      orchestrationId: orchestration.id, projectId: play.project.id, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
      question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
      population: 'Receptionists', definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    }]);
    await createBin({
      projectId: play.project.id, kind: 'RESEARCH_PACKET', title: `Receptionist wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
      manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const def = workType('RESEARCH_FRAGMENT');
    await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
  }
}

async function drive(reading: RecordedStageCapacity, steps: number): Promise<string[]> {
  const reasons: string[] = [];
  await queueFragments(30);
  await new Promise((r) => setTimeout(r, 20));
  startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, stageReading: async () => reading }, 60_000);
  for (let step = 0; step < steps; step += 1) {
    await new Promise((r) => setTimeout(r, 150));
    await controlStep();
    for (const row of await readCapacity()) reasons.push(row.reason);
  }
  return reasons;
}

describe('the adaptive pool consults the measured constraint before it scales', () => {
  beforeEach(async () => {
    play = await freshProject();
    await setBrainOnlyMode(true, 'test', 'capacity scaling suite');
    await getDb().run('DELETE FROM free_lane_capacity', []);
    inFlight = 0;
    peak = 0;
    failRoute = null;
  });
  afterEach(() => stopAdaptivePool());

  it('does not grow the failing route past its starting size, and grows the route that serves its work', async () => {
    failRoute = 'brain-a';
    const reasons = await drive(recorded(CONSTRAINED_AT_MODEL, { primary: FAILING }), 12);
    const rows = await readCapacity();
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.model === 'brain-a')!.target).toBeLessThanOrEqual(2);
    expect(rows.find((r) => r.model === 'brain-b')!.target).toBeGreaterThan(2);
    expect(reasons.some((r) => /restore model route brain-b/.test(r))).toBe(false);
  }, 60_000);

  it('grows past its starting size when the reading names a lane-stage constraint with a measured gain', async () => {
    await drive(recorded(CONSTRAINED_AT_MODEL), 12);
    const rows = await readCapacity();
    expect(Math.max(...rows.map((r) => r.target))).toBeGreaterThan(2);
    /*
     * Every step that took a model past the most it had reached was the gate's,
     * and named the measured constraint. Not "the latest GROW": on a slow runner
     * (Deploy 44236050783, 2026-11-18) the queue read empty while every item was
     * leased, the pool shrank 4 -> 3 on "no research waiting", and the latest
     * GROW was the 3 -> 4 that regained it — restoring proven capacity, which
     * the gate deliberately does not hold or annotate.
     */
    const events = await getDb().all<{ workload_class: string; reason: string }>(
      "SELECT workload_class, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome IN ('GROW', 'SHRINK') ORDER BY at, id", [],
    );
    const reached = new Map<string, number>();
    let pastProven = 0;
    for (const event of events) {
      const step = /^(\d+) -> (\d+):/.exec(event.reason);
      expect(step, event.reason).not.toBeNull();
      const to = Number(step![2]);
      const most = reached.get(event.workload_class) ?? Number(step![1]);
      if (to > most) {
        pastProven += 1;
        expect(event.reason).toMatch(/constrained at model-interpretation; measured gain/);
      }
      reached.set(event.workload_class, Math.max(most, to));
    }
    expect(pastProven).toBeGreaterThan(0);
  }, 60_000);
});
