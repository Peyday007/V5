/**
 * RES-07 / RES-15-5 in the goals tick: every tick that changes the research
 * allocation leaves an append-only row naming the five shares, the floors kept
 * and why; per-window yield drives the decision; a capacity change is only a
 * recommendation; nothing is started, spent or raised
 * (`server/services/goals/tick.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import {
  RESEARCH_REALLOCATED_EVENT,
  advanceGoals,
  allocationInputFrom,
  bottleneckFrom,
  productionResearchAllocationPorts,
  reallocateResearch,
  reallocateResearchIfDue,
  triedRemediesFrom,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, EXPLORATION_FLOOR, SYSTEM_HEALTH_FLOOR, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import { laneCapacityFrom, researchCapacityNow, type LaneCapacityReading, type ResearchYieldReading, type YieldBucket } from '../server/services/goals/researchYield.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { createUser, createWorker, getWorkerByName } from '../server/repos/identity.ts';
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

/** One window: TRANSACTION_ROUTES yields a lot per hour, BROAD_DISCOVERY almost nothing, and the free lane is all claims and no links. */
function reading(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  purposes.BROAD_DISCOVERY = bucket({ submissions: 60, completions: 60, usefulResults: 1, jobMs: 10_800_000 });
  purposes.SELF_IMPROVEMENT = bucket({ submissions: 10, completions: 10, usefulResults: 2, jobMs: 1_800_000 });
  purposes.OPERATING_SUPPORT = bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 900_000 });
  purposes.FORWARD_EXPLORATION = bucket({ submissions: 5, completions: 5, usefulResults: 0, jobMs: 900_000 });
  return {
    window: { since: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z', ms: 86_400_000 },
    total: bucket({ submissions: 100, completions: 100, usefulResults: 16, jobMs: 18_000_000 }),
    lanes: {
      'free-lane': bucket({ submissions: 60, completions: 50, acceptedClaims: 400, qualifiedPositions: 2, jobMs: 10_800_000, failures: { total: 10, rateLimited: 10, other: 0, causes: [] }, inFlight: 30, queueWait: { measured: 30, medianMs: 40 * 60_000, p90Ms: 60 * 60_000 } }),
    },
    purposes,
    costCountedOnce: { jobs: 100, totalJobMs: 18_000_000, purposeJobMs: 18_000_000, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [{ jobId: 'job_1', lane: 'free-lane', purposes: ['BROAD_DISCOVERY'], basis: ['discovery bucket'] }],
    notes: [],
  };
}

function goalView(id: string, over: Partial<GoalView> = {}): GoalView {
  return { id, projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null, ...over } as GoalView;
}

function memoryPorts(yieldReading: ResearchYieldReading) {
  const events = new Map<string, Record<string, unknown>[]>();
  const ports: ResearchAllocationPorts = {
    readYield: async () => yieldReading,
    lastDecision: async (goalId) => events.get(goalId)?.at(-1) ?? null,
    recordGoal: async (goalId, _summary, detail) => {
      events.set(goalId, [...(events.get(goalId) ?? []), detail]);
    },
  };
  return { ports, events };
}

describe('the research allocation decision in the tick', () => {
  it('moves share toward the purpose with the higher useful yield, keeps the floors, and records why', async () => {
    const { ports, events } = memoryPorts(reading());
    const report = await reallocateResearch({ goals: [goalView('wst_a'), goalView('wst_b')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.changed).toBe(true);
    expect(report.recordedOn).toEqual(['wst_a', 'wst_b']);
    // Measured share of job time in the window: TRANSACTION_ROUTES ran 20%, BROAD_DISCOVERY 60%.
    expect(report.shares.TRANSACTION_ROUTES).toBeGreaterThan(0.2);
    expect(report.shares.BROAD_DISCOVERY).toBeLessThan(0.6);
    expect(report.shares.SELF_IMPROVEMENT).toBeGreaterThanOrEqual(SYSTEM_HEALTH_FLOOR - 1e-9);
    expect(report.shares.BROAD_DISCOVERY + report.shares.FORWARD_EXPLORATION).toBeGreaterThanOrEqual(EXPLORATION_FLOOR - 1e-9);
    const detail = events.get('wst_a')![0]!;
    expect(Object.keys(detail.shares as object).sort()).toEqual([...RESEARCH_PURPOSES].sort());
    expect(detail.floors).toMatchObject({ exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR });
    expect((detail.changes as { reasons: string[] }[]).some((c) => c.reasons.length > 0)).toBe(true);
    expect(detail.costCountedOnce).toMatchObject({ holds: true });
  });

  it('gives a claims-heavy, link-poor lane a question-design change before any limit is raised, then the next remedy', async () => {
    const { ports, events } = memoryPorts(reading());
    const first = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const lane = first.laneActions.find((a) => a.lane === 'free-lane');
    expect(lane?.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(lane?.limitRaiseAllowed).toBe(false);
    expect(triedRemediesFrom(events.get('wst_a')!.at(-1)!).get('free-lane')).toEqual(['QUESTION_DESIGN']);
    const second = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T01:00:00.000Z' }, ports);
    expect(second.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_EVIDENCE_SOURCES');
  });

  it('never adds capacity without a live capacity reading: a running job is not a waiting one', async () => {
    // The window's lane has 30 jobs running and a 40-minute wait on jobs that already began — neither is work waiting.
    const input = allocationInputFrom(reading(), { urgentCommercialGoal: false, nearestDeadlineDays: null, triedRemedies: new Map() });
    const lane = input.bottlenecks!.find((b) => b.lane === 'free-lane')!;
    expect(lane.qualifiedQueued).toBeNull();
    expect(lane.queueWaitMs).toBeNull();
    const { ports, events } = memoryPorts(reading());
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.capacity.every((c) => c.kind === 'NO_CAPACITY')).toBe(true);
    expect((events.get('wst_a')![0]!.capacity as { recommendationOnly: boolean }[]).every((c) => c.recommendationOnly)).toBe(true);
  });

  it('recommends capacity when qualified work is waiting on full slots with proven headroom at a known cost', async () => {
    const r = reading();
    // A lane that turns claims into links, completes reliably and was never refused by its provider.
    r.lanes = { 'free-lane:brain-a': bucket({ submissions: 40, completions: 40, acceptedClaims: 40, qualifiedPositions: 12, jobMs: 3_600_000 }) };
    r.attributions = [{ jobId: 'job_1', lane: 'free-lane:brain-a', purposes: ['TRANSACTION_ROUTES'], basis: ['goal round'] }];
    const capacity: Record<string, LaneCapacityReading> = {
      'free-lane:brain-a': { lane: 'free-lane:brain-a', waiting: 12, waitingMedianAgeMs: 30 * 60_000, target: 4, proven: 10, ceiling: 256, headroom: 6, busyNow: 4, slotsFull: true, incrementalCostPerUnitMinor: 0 },
    };
    const { ports, events } = memoryPorts(r);
    ports.readCapacity = async () => capacity;
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const add = report.capacity.find((c) => c.lane === 'free-lane:brain-a');
    expect(add).toMatchObject({ kind: 'ADD_CAPACITY', resource: 'WORKER', units: 4, incrementalCost: 0 });
    const detail = events.get('wst_a')![0]!;
    expect((detail.capacity as { kind: string; recommendationOnly: boolean }[]).find((c) => c.kind === 'ADD_CAPACITY')?.recommendationOnly).toBe(true);
    expect((detail.capacityNow as { lane: string; waiting: number }[])[0]).toMatchObject({ lane: 'free-lane:brain-a', waiting: 12 });
  });

  it('adds nothing for a provider that refused a measured share of attempts, or for slots that are not full', () => {
    const lane = bucket({ submissions: 20, completions: 18, acceptedClaims: 5, qualifiedPositions: 3, jobMs: 1_000_000, failures: { total: 2, rateLimited: 2, other: 0, causes: [] } });
    const c: LaneCapacityReading = { lane: 'free-lane:m', waiting: 9, waitingMedianAgeMs: 60 * 60_000, target: 2, proven: 8, ceiling: 256, headroom: 6, busyNow: 2, slotsFull: true, incrementalCostPerUnitMinor: 0 };
    const limited = bottleneckFrom('free-lane:m', lane, c, []);
    expect(limited).toMatchObject({ resource: 'MODEL_RATE_LIMIT', quotaHeadroom: 0, measuredMachineLimit: true, qualifiedQueued: 9 });
    const calm = bottleneckFrom('free-lane:m', bucket({ completions: 20, submissions: 20 }), { ...c, slotsFull: false, busyNow: 1 }, []);
    expect(calm).toMatchObject({ resource: null, measuredMachineLimit: false, quotaHeadroom: null });
  });

  it('writes nothing when the decision is unchanged', async () => {
    // No lane needs a remedy, so the same window gives the same decision twice.
    const steady = reading();
    steady.lanes = {};
    const { ports, events } = memoryPorts(steady);
    const first = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(first.changed).toBe(true);
    const repeat = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(repeat.changed).toBe(false);
    expect(repeat.recordedOn).toEqual([]);
    expect(events.get('wst_a')).toHaveLength(1);
  });

  it('holds every share and says so when nothing in the window was measured', async () => {
    const empty = reading();
    for (const p of [...RESEARCH_PURPOSES, 'UNATTRIBUTED'] as const) empty.purposes[p] = bucket();
    empty.lanes = {};
    const input = allocationInputFrom(empty, { urgentCommercialGoal: false, nearestDeadlineDays: null, triedRemedies: new Map() });
    expect(input.purposes.every((p) => p.usefulResults === null && p.cost === null)).toBe(true);
    const { ports } = memoryPorts(empty);
    const report = await reallocateResearch({ goals: [goalView('wst_a')] }, ports);
    expect(report.held).toBe(true);
  });

  it('an urgent commercial goal with a deadline keeps the commercial floor', async () => {
    const { ports } = memoryPorts(reading());
    const report = await reallocateResearch(
      { goals: [goalView('wst_a', { dueAt: '2026-11-20T00:00:00.000Z', target: {} as GoalView['target'] })], now: '2026-11-14T00:00:00.000Z' },
      ports,
    );
    expect(report.floors.commercial).toBe(0.2);
    expect(report.shares.TRANSACTION_ROUTES).toBeGreaterThanOrEqual(0.2 - 1e-9);
  });
});

describe('on production rows, through advanceGoals', () => {
  let ownerId: string;
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    ownerId = (await createUser({ email: `alloc-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('records the decision on each live goal, and starts, raises or reprioritizes nothing', async () => {
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'CAPABILITY', createdByUserId: ownerId });
    const binsBefore = await getDb().all<{ id: string; priority: number; state: string }>('SELECT id, priority, state FROM bins ORDER BY id');
    const report = await advanceGoals();
    const research = report.research;
    expect(research && !('error' in research)).toBe(true);
    const events = (await listWorkstreamEvents(goal.id, 50)).filter((e) => e.kind === RESEARCH_REALLOCATED_EVENT);
    expect(events).toHaveLength(1);
    const detail = events[0]!.detail as Record<string, unknown>;
    expect(Object.keys(detail.shares as object).sort()).toEqual([...RESEARCH_PURPOSES].sort());
    expect(detail.floors).toBeDefined();
    expect(detail.window).toBeDefined();
    // Nothing was measured on a fresh database, so every share holds and the row says so.
    expect(detail.held).toBe(true);
    expect(await getDb().all('SELECT id, priority, state FROM bins ORDER BY id')).toEqual(binsBefore);
    // Throttled: a second tick in the same hour does not run the pass again.
    expect((await advanceGoals()).research).toBeNull();
    // Forced, the unchanged decision writes nothing more.
    await reallocateResearchIfDue({ goals: [goalView(goal.id, { projectId })] }, undefined, { force: true });
    expect((await listWorkstreamEvents(goal.id, 50)).filter((e) => e.kind === RESEARCH_REALLOCATED_EVENT)).toHaveLength(1);
  });
});

describe('capacity read from the rows that own it', () => {
  it('folds waiting ages, target, proven concurrency and live leases into one reading per model', () => {
    const out = laneCapacityFrom({
      waitingAgesMs: [60_000, 20 * 60_000, 40 * 60_000],
      models: [
        { model: 'a', target: 3, proven: 9, ceiling: 256, busyNow: 3, unpaid: true },
        { model: 'runpod:gpu', target: 4, proven: 40, ceiling: 32, busyNow: 1, unpaid: false },
        { model: 'new', target: null, proven: null, ceiling: 256, busyNow: 0, unpaid: true },
      ],
    });
    expect(out['free-lane:a']).toMatchObject({ waiting: 3, waitingMedianAgeMs: 20 * 60_000, headroom: 6, slotsFull: true, incrementalCostPerUnitMinor: 0 });
    // Headroom never passes the lane's ceiling, and the GPU's pod time has no recorded price.
    expect(out['free-lane:runpod:gpu']).toMatchObject({ headroom: 28, slotsFull: false, incrementalCostPerUnitMinor: null });
    expect(out['free-lane:new']).toMatchObject({ headroom: null, slotsFull: false });
  });

  let play: TestProject;
  async function queueFragments(n: number): Promise<string[]> {
    const layerId = (await play.layerByName('Monetization Logic')).id;
    const ids: string[] = [];
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
      const item = await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
      ids.push(item.id);
    }
    return ids;
  }

  it('on production rows, the tick recommends capacity for a lane whose full slots leave qualified work waiting', async () => {
    play = await freshProject();
    process.env['BRAIN_CHEAP_LLM_URL'] = 'http://lane.test/v1';
    process.env['BRAIN_CHEAP_LLM_MODELS'] = 'brain-a';
    try {
      const ids = await queueFragments(8);
      const db = getDb();
      const worker = (await getWorkerByName('free-lane-a')) ?? (await createWorker({ name: 'free-lane-a', displayName: 'free-lane-a', createdByType: 'SYSTEM', createdById: 'test' }));
      const now = Date.now();
      // Two items leased by the lane's only slots; six queued and claimable for the last 40 minutes.
      await db.run(`UPDATE work_items SET state = 'LEASED', lease_id = 'lse_test_' || id, worker_id = ?, lease_expires_at = ? WHERE id IN (?, ?)`, [worker.id, new Date(now + 10 * 60_000).toISOString(), ids[0]!, ids[1]!]);
      await db.run(`UPDATE work_items SET available_at = ? WHERE state = 'QUEUED'`, [new Date(now - 40 * 60_000).toISOString()]);
      await db.run('DELETE FROM free_lane_capacity', []);
      await db.run("INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 2, 12, ?, 'test')", [new Date(now).toISOString()]);
      // The lane completed its recent work reliably.
      for (let i = 0; i < 10; i += 1) await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a', durationMs: 60_000 });

      const capacity = await researchCapacityNow(new Date(now + 1000).toISOString());
      expect(capacity['free-lane:brain-a']).toMatchObject({ waiting: 6, target: 2, proven: 12, headroom: 10, busyNow: 2, slotsFull: true, incrementalCostPerUnitMinor: 0 });
      expect(capacity['free-lane:brain-a']!.waitingMedianAgeMs!).toBeGreaterThanOrEqual(39 * 60_000);

      const report = await reallocateResearch({ goals: [goalView('wst_x')], now: new Date(now + 1000).toISOString() }, {
        ...(await productionResearchAllocationPorts()),
        lastDecision: async () => null,
        recordGoal: async () => {},
      });
      expect(report.capacity.find((c) => c.lane === 'free-lane:brain-a')).toMatchObject({ kind: 'ADD_CAPACITY', resource: 'WORKER', units: 4, incrementalCost: 0 });
    } finally {
      delete process.env['BRAIN_CHEAP_LLM_URL'];
      delete process.env['BRAIN_CHEAP_LLM_MODELS'];
    }
  });
});
