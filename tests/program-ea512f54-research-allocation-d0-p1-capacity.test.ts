/**
 * RES-15-5 (F3): "If the queue contains qualified useful jobs and measured
 * machine limits cause delay, add/repurpose capacity as justified by the
 * bottleneck and incremental cost." The capacity verdict is reachable from
 * production rows: waiting work is what is queued now (never the jobs that
 * already started), its wait is how long those queued jobs have waited, and
 * headroom and incremental cost come from the §86 controller's rows. Anything
 * unmeasured stays null and adds nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { waitingNow } from '../server/services/freeLane/capacity.ts';
import {
  allocationInputFrom,
  productionResearchAllocationPorts,
  reallocateResearch,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, QUEUE_WAIT_CONSTRAINT_MS, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import { freeLaneCapacityFrom, laneCapacityNow, type LaneCapacityReading, type ResearchYieldReading, type YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';

function bucket(over: Partial<YieldBucket> = {}): YieldBucket {
  return {
    submissions: 0, completions: 0, inFlight: 0,
    failures: { total: 0, rateLimited: 0, other: 0, causes: [] },
    queueWait: { measured: 0, medianMs: null, p90Ms: null },
    acceptedClaims: 0, sourceQuality: { primary: 0, secondary: 0, unretrieved: 0, primaryShare: null },
    packetsFiled: 0, newMechanisms: 0, qualifiedPositions: 0, executableOffers: 0, paidTransactions: 0, usefulResults: 0,
    jobMs: 0, costMinor: null, uncostedJobs: 0, msPerUsefulResult: null, costMinorPerUsefulResult: null, utilization: 0,
    ...over,
  };
}

const LANE = 'free-lane:brain-a';

/** A lane that yields actionable links (so no remedy comes first), is rate limited, and is reliable enough to grow. */
function reading(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  return {
    window: { since: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z', ms: 86_400_000 },
    total: bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 }),
    lanes: {
      // 30 jobs already running and a 40-minute median wait for jobs that already started: neither is waiting work.
      [LANE]: bucket({ submissions: 60, completions: 54, acceptedClaims: 40, qualifiedPositions: 20, executableOffers: 10, jobMs: 3_600_000, failures: { total: 6, rateLimited: 6, other: 0, causes: [] }, inFlight: 30, queueWait: { measured: 30, medianMs: 40 * 60_000, p90Ms: 60 * 60_000 } }),
    },
    purposes,
    costCountedOnce: { jobs: 60, totalJobMs: 3_600_000, purposeJobMs: 3_600_000, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [{ jobId: 'job_1', lane: LANE, purposes: ['TRANSACTION_ROUTES'], basis: ['deal bucket'] }],
    notes: [],
  };
}

function ports(laneCapacity?: LaneCapacityReading[]): ResearchAllocationPorts & { decisions: Record<string, unknown>[] } {
  const decisions: Record<string, unknown>[] = [];
  return {
    decisions,
    readYield: async () => reading(),
    ...(laneCapacity ? { readLaneCapacity: async () => laneCapacity } : {}),
    lastDecision: async () => null,
    recordDecision: async (_s, detail) => {
      decisions.push(detail);
    },
  };
}

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as unknown as GoalView;
const NOW = '2026-11-14T00:00:00.000Z';
const ctx = { urgentCommercialGoal: false, nearestDeadlineDays: null, triedRemedies: new Map() };

describe('capacity is decided from work waiting now, not from jobs already running', () => {
  it('never reads in-flight jobs as queued, nor started jobs’ wait as queue wait', () => {
    const input = allocationInputFrom(reading(), ctx);
    const b = input.bottlenecks!.find((one) => one.lane === LANE)!;
    expect(b.qualifiedQueued).toBeNull();
    expect(b.queueWaitMs).toBeNull();
    expect(b.quotaHeadroom).toBeNull();
    expect(b.incrementalCostPerUnit).toBeNull();
  });

  it('carries the measured queue, wait, headroom and cost into the bottleneck', () => {
    const cap: LaneCapacityReading = { lane: LANE, queued: 7, queueWaitMs: 20 * 60_000, quotaHeadroom: 3, incrementalCostPerUnit: 0, basis: ['test'] };
    const b = allocationInputFrom(reading(), { ...ctx, capacity: new Map([[LANE, cap]]) }).bottlenecks!.find((one) => one.lane === LANE)!;
    expect(b).toMatchObject({ qualifiedQueued: 7, queueWaitMs: 20 * 60_000, quotaHeadroom: 3, incrementalCostPerUnit: 0 });
  });

  it('produces ADD_CAPACITY through the allocation pass when the rows measure it', async () => {
    const p = ports([{ lane: LANE, queued: 7, queueWaitMs: QUEUE_WAIT_CONSTRAINT_MS + 60_000, quotaHeadroom: 3, incrementalCostPerUnit: 0, basis: ['test'] }]);
    const report = await reallocateResearch({ goals: [goal], now: NOW }, p);
    expect(report.capacity.find((c) => c.lane === LANE)).toMatchObject({ kind: 'ADD_CAPACITY', resource: 'MODEL_RATE_LIMIT', units: 3, incrementalCost: 0 });
    // Still a recommendation, and the record shows what it read.
    const detail = p.decisions[0]!;
    expect((detail.capacity as { recommendationOnly: boolean }[]).every((c) => c.recommendationOnly)).toBe(true);
    expect((detail.laneCapacity as { lane: string; queuedNow: number | null; quotaHeadroom: number | null }[]).find((l) => l.lane === LANE)).toMatchObject({ queuedNow: 7, quotaHeadroom: 3 });
  });

  it('adds nothing when the measured queue is empty, the wait is short, or headroom is spent', async () => {
    for (const over of [{ queued: 0, queueWaitMs: null }, { queueWaitMs: 60_000 }, { quotaHeadroom: 0, incrementalCostPerUnit: null }]) {
      const cap = { lane: LANE, queued: 7, queueWaitMs: QUEUE_WAIT_CONSTRAINT_MS + 60_000, quotaHeadroom: 3, incrementalCostPerUnit: 0, basis: [], ...over };
      const report = await reallocateResearch({ goals: [goal], now: NOW }, ports([cap]));
      expect(report.capacity.find((c) => c.lane === LANE)!.kind).toBe('NO_CAPACITY');
    }
  });

  it('wires the production ports to the capacity reader', async () => {
    expect(typeof (await productionResearchAllocationPorts()).readLaneCapacity).toBe('function');
  });
});

describe('the free-lane capacity reading (pure)', () => {
  const now = Date.parse(NOW);
  it('reads headroom as sustained-but-unused concurrency, at no incremental cost inside it', () => {
    const [a, c] = freeLaneCapacityFrom({
      nowMs: now,
      queuedAvailableAt: [new Date(now - 10 * 60_000).toISOString(), new Date(now - 30 * 60_000).toISOString(), new Date(now - 50 * 60_000).toISOString()],
      controller: [{ model: 'brain-a', target: 4, stableHigh: 19 }, { model: 'brain-c', target: 26, stableHigh: 26 }],
    });
    expect(a).toMatchObject({ lane: 'free-lane:brain-a', queued: 3, queueWaitMs: 30 * 60_000, quotaHeadroom: 15, incrementalCostPerUnit: 0 });
    // No headroom: the cost of another slot is not measured, and stays unknown.
    expect(c).toMatchObject({ lane: 'free-lane:brain-c', queued: 3, quotaHeadroom: 0, incrementalCostPerUnit: null });
  });
  it('has no wait when nothing waits', () => {
    const [a] = freeLaneCapacityFrom({ nowMs: now, queuedAvailableAt: [], controller: [{ model: 'brain-a', target: 2, stableHigh: 8 }] });
    expect(a).toMatchObject({ queued: 0, queueWaitMs: null });
  });
});

describe('the free-lane capacity reading (production rows)', () => {
  let play: TestProject;
  beforeEach(async () => {
    play = await freshProject();
  });

  async function queueFragments(n: number): Promise<void> {
    const layerId = (await play.layerByName('Monetization Logic')).id;
    for (let i = 0; i < n; i += 1) {
      const run = await createRun({ projectId: play.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
      const orchestration = await createOrchestration({ projectId: play.project.id, layerId, runId: run.id, title: `Wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
      const [fragment] = await createFragments([{
        orchestrationId: orchestration.id, projectId: play.project.id, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
        question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
        population: 'Receptionists', definitions: 'Median hourly wage',
        requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
        acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
      }]);
      await createBin({
        projectId: play.project.id, kind: 'RESEARCH_PACKET', title: `Wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
        manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
        completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
      });
      const def = workType('RESEARCH_FRAGMENT');
      await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
    }
  }

  it('counts exactly what the §86 pool counts as waiting, with each job’s wait and the controller’s headroom', async () => {
    await queueFragments(3);
    await getDb().run('DELETE FROM free_lane_capacity', []);
    await getDb().run("INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 2, 9, ?, 'test')", [new Date().toISOString()]);
    const until = new Date(Date.now() + 20 * 60_000).toISOString();
    const [a] = await laneCapacityNow(until);
    const pool = await waitingNow({ includeImprovement: false });
    expect(a!.queued).toBe(pool);
    expect(a!.queued).toBeGreaterThan(0);
    expect(a!.queueWaitMs).toBeGreaterThanOrEqual(19 * 60_000);
    expect(a).toMatchObject({ lane: 'free-lane:brain-a', quotaHeadroom: 7, incrementalCostPerUnit: 0 });
  });
});
