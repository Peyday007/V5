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
import { controlStep, readCapacity, startAdaptivePool, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import {
  chooseConstraint,
  gateGrowth,
  type RecordedStageCapacity,
  type StageCapacityReport,
  type StageReading,
  type ThroughputDiagnosis,
} from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const measured = <T>(value: T) => ({ measured: true as const, value });
const not = { measured: false as const, reason: 'unseen' };

function stage(id: string, waiting: number, processedPerHour: number, acceptedPerHour: number, dollars: number | null = null): StageReading {
  return {
    stage: id,
    label: `${id} label`,
    queueSize: measured(waiting),
    oldestUsefulItemMinutes: measured(0),
    itemsProcessedPerHour: measured(processedPerHour),
    uniqueUsableFacts: measured(0),
    droppedOrDuplicate: measured(0),
    modelCallsAvoided: not,
    providerFailures: measured(0),
    elapsedMs: measured(0),
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
const CONSTRAINED_AT_MODEL = [stage('model-interpretation', 50, 20, 10)];

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
    const priced = gateGrowth({ ...base, gpu: true, proposed: 16, recorded: recorded([stage('model-interpretation', 50, 20, 10, 6)]) });
    expect(priced).toMatchObject({ target: 16, held: false });
    expect(priced.reason).toMatch(/for \$1\/h/);
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

const completer: Completer = async (_c, _m, _s, prompt) => {
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
  });
  afterEach(() => stopAdaptivePool());

  it('does not grow past its starting size while the reading names a failing route', async () => {
    const reasons = await drive(recorded(CONSTRAINED_AT_MODEL, { primary: FAILING }), 12);
    const rows = await readCapacity();
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.target).toBeLessThanOrEqual(2);
    expect(reasons.some((r) => /restore model route brain-a first/.test(r))).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
  }, 60_000);

  it('grows past its starting size when the reading names a lane-stage constraint with a measured gain', async () => {
    await drive(recorded(CONSTRAINED_AT_MODEL), 12);
    const rows = await readCapacity();
    expect(Math.max(...rows.map((r) => r.target))).toBeGreaterThan(2);
    const grew = await getDb().get<{ reason: string }>("SELECT reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'GROW' ORDER BY at DESC LIMIT 1", []);
    expect(grew?.reason ?? '').toMatch(/constrained at model-interpretation; measured gain/);
  }, 60_000);
});
