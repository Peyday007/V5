/**
 * CAP-16-3 / S-0171: the lane's slots grow only after the stage measurement names
 * the constrained stage with a measured gain, and never on a model route that is
 * still failing. Before this, chooseConstraint's answer was written to a row the
 * controller never read, and the adaptive pool grew exactly as before.
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
import { controlStep, measuredScalingGate, readCapacity, startAdaptivePool, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import {
  laneDollarsByStage,
  resetStageReading,
  scalingGate,
  SCALING_READING_MAX_AGE_MS,
  type Constraint,
  type StageCapacityReport,
  type ThroughputDiagnosis,
} from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const calm = { db: false, lagMs: 5, cpu: 0.1 };

function report(constrained: Partial<Constraint>, primary: ThroughputDiagnosis['primary'] = null): StageCapacityReport {
  const full: Constraint = {
    stage: null,
    basis: 'basis',
    expectedGain: { measured: false, reason: 'unmeasured' },
    recommendation: 'restore first',
    ...constrained,
  };
  return {
    diagnosis: { routes: [], gpu: { samples: {}, startFailures: 0, lastStartFailure: null, notRunning: false }, primary, restored: [] },
    constrained: full,
  } as unknown as StageCapacityReport;
}

const gain = (acceptedFactsPerHour: number, dollars = 0) => ({ measured: true as const, value: { acceptedFactsPerHour, dollars } });

describe('scalingGate', () => {
  it('holds growth until a measurement exists, and after one fails', () => {
    expect(scalingGate(null, 'brain-a', NOW).allowGrowth).toBe(false);
    const failed = scalingGate({ report: null, at: NOW, error: 'db busy' }, 'brain-a', NOW);
    expect(failed.allowGrowth).toBe(false);
    expect(failed.reason).toMatch(/db busy/);
  });

  it('holds growth on a stale measurement', () => {
    const r = report({ stage: 'model-interpretation', expectedGain: gain(3) });
    expect(scalingGate({ report: r, at: NOW - SCALING_READING_MAX_AGE_MS - 1, }, 'brain-a', NOW).allowGrowth).toBe(false);
    expect(scalingGate({ report: r, at: NOW - 60_000 }, 'brain-a', NOW).allowGrowth).toBe(true);
  });

  it('restores a failing route before growing it, and still lets a healthy route grow', () => {
    const r = report({ stage: 'model-interpretation', expectedGain: gain(3) }, { route: 'runpod-qwen', cause: 'broken GPU', failures: 9, evidence: 'pod EXITED' });
    const failing = scalingGate({ report: r, at: NOW }, 'runpod-qwen', NOW);
    expect(failing.allowGrowth).toBe(false);
    expect(failing.reason).toMatch(/restore model route runpod-qwen first/);
    expect(scalingGate({ report: r, at: NOW }, 'brain-a', NOW).allowGrowth).toBe(true);
  });

  it('grows only on a measured constraint that lane slots relieve, with a measured positive gain', () => {
    expect(scalingGate({ report: report({ stage: null }), at: NOW }, 'brain-a', NOW).allowGrowth).toBe(false);
    const elsewhere = scalingGate({ report: report({ stage: 'source-ingestion', expectedGain: gain(5) }), at: NOW }, 'brain-a', NOW);
    expect(elsewhere.allowGrowth).toBe(false);
    expect(elsewhere.reason).toMatch(/source-ingestion/);
    expect(scalingGate({ report: report({ stage: 'evidence-verification' }), at: NOW }, 'brain-a', NOW).allowGrowth).toBe(false);
    expect(scalingGate({ report: report({ stage: 'evidence-verification', expectedGain: gain(0) }), at: NOW }, 'brain-a', NOW).allowGrowth).toBe(false);
    const ok = scalingGate({ report: report({ stage: 'evidence-verification', expectedGain: gain(2.5, 0.4) }), at: NOW }, 'brain-a', NOW);
    expect(ok.allowGrowth).toBe(true);
    expect(ok.reason).toMatch(/\+2\.50 accepted facts\/hour at \$0\.40\/hour/);
  });
});

describe('a gain whose dollars are not measured', () => {
  it('holds growth: the spend is never assumed, so no gain is projected from it', () => {
    const none = { dollars: 0, runningHours: 0, unpricedRunningSamples: 0, samples: 0 };
    const spend = laneDollarsByStage(none, new Map());
    expect([...spend.values()].every((m) => !m.measured)).toBe(true);
    const held = scalingGate(
      { report: report({ stage: 'model-interpretation', expectedGain: { measured: false, reason: 'spend not measured' } }), at: NOW },
      'brain-a',
      NOW,
    );
    expect(held.allowGrowth).toBe(false);
    expect(held.reason).toMatch(/no measured expected gain for model-interpretation: spend not measured/);
  });
});

/* ------------------------------------------------------------------------- */
/* The controller consults the gate                                          */
/* ------------------------------------------------------------------------- */

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
let play: TestProject;

const completer: Completer = async (_c, _m, _s, prompt) => {
  await new Promise((r) => setTimeout(r, 200));
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

async function grows(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'GROW'", []);
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  play = await freshProject();
  await setBrainOnlyMode(true, 'test', 'scaling gate suite');
});
afterEach(() => {
  stopAdaptivePool();
  resetStageReading(null);
});

describe('the adaptive pool scales on the measured constraint (production gate)', () => {
  it('holds growth when the measured constraint is a stage lane slots do not relieve, and says why', async () => {
    await queueFragments(12);
    resetStageReading({ report: report({ stage: 'source-ingestion', expectedGain: gain(4) }), at: Date.now() });
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, scaling: measuredScalingGate }, 60_000);
    for (let step = 0; step < 4; step += 1) {
      await new Promise((r) => setTimeout(r, 60));
      await controlStep();
    }
    expect(await grows()).toBe(0);
    const [row] = await readCapacity();
    expect(row?.reason).toMatch(/^growth held: the constrained stage is source-ingestion/);
  }, 30_000);

  it('grows when the measurement names a lane stage with a measured gain', async () => {
    await queueFragments(12);
    resetStageReading({ report: report({ stage: 'model-interpretation', expectedGain: gain(4) }), at: Date.now() });
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, scaling: measuredScalingGate }, 60_000);
    for (let step = 0; step < 4; step += 1) {
      await new Promise((r) => setTimeout(r, 60));
      await controlStep();
    }
    expect(await grows()).toBeGreaterThan(0);
  }, 30_000);

  it('holds growth of the very route the measurement names as failing', async () => {
    await queueFragments(12);
    resetStageReading({
      report: report({ stage: 'model-interpretation', expectedGain: gain(4) }, { route: 'brain-a', cause: 'credentials', failures: 7, evidence: '401 ×7' }),
      at: Date.now(),
    });
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, scaling: measuredScalingGate }, 60_000);
    for (let step = 0; step < 4; step += 1) {
      await new Promise((r) => setTimeout(r, 60));
      await controlStep();
    }
    expect(await grows()).toBe(0);
    const [row] = await readCapacity();
    expect(row?.reason).toMatch(/restore model route brain-a first/);
  }, 30_000);
});
