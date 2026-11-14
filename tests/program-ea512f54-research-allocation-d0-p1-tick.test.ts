/**
 * RES-07 / RES-15-5 in the goals tick: every tick that changes the research
 * allocation leaves an append-only row naming the five shares, the floors kept
 * and why; per-window yield drives the decision; a capacity change is only a
 * recommendation; nothing is started, spent or raised
 * (`server/services/goals/tick.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import {
  RESEARCH_REALLOCATED_EVENT,
  advanceGoals,
  allocationInputFrom,
  productionResearchAllocationPorts,
  reallocateResearch,
  recordRemedyApplied,
  reallocateResearchIfDue,
  triedRemediesFrom,
  type AppliedRemedy,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, EXPLORATION_FLOOR, SYSTEM_HEALTH_FLOOR, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
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
  const applied: AppliedRemedy[] = [];
  const ports: ResearchAllocationPorts = {
    readYield: async () => yieldReading,
    appliedRemedies: async () => [...applied],
    lastDecision: async (goalId) => events.get(goalId)?.at(-1) ?? null,
    recordGoal: async (goalId, _summary, detail) => {
      events.set(goalId, [...(events.get(goalId) ?? []), detail]);
    },
  };
  return { ports, events, apply: (one: AppliedRemedy) => applied.push(one) };
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

  it('gives a claims-heavy, link-poor lane a question-design change before any limit is raised, then the next remedy once that change was applied and measured', async () => {
    const { ports, events, apply } = memoryPorts(reading());
    const first = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const lane = first.laneActions.find((a) => a.lane === 'free-lane');
    expect(lane?.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(lane?.limitRaiseAllowed).toBe(false);
    // Recommending a change is not making it.
    expect(triedRemediesFrom(events.get('wst_a')!.at(-1)!).get('free-lane')).toEqual([]);
    // The change is made and recorded, then measured over a whole window after it.
    apply({ lane: 'free-lane', remedy: 'QUESTION_DESIGN', appliedAt: '2026-11-14T00:30:00.000Z', ref: 'prompt-v2' });
    const measuring = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T12:00:00.000Z' }, ports);
    expect(measuring.laneActions.find((a) => a.lane === 'free-lane')).toMatchObject({ kind: 'MEASURING_REMEDY', remedy: 'QUESTION_DESIGN', limitRaiseAllowed: false });
    const second = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-15T01:00:00.000Z' }, ports);
    expect(second.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_EVIDENCE_SOURCES');
    expect(triedRemediesFrom(events.get('wst_a')!.at(-1)!).get('free-lane')).toEqual(['QUESTION_DESIGN']);
  });

  it('never walks a lane to a limit raise when no remedy was ever applied', async () => {
    const { ports, events } = memoryPorts(reading());
    const kinds: string[] = [];
    for (let hour = 0; hour < 6; hour += 1) {
      const report = await reallocateResearch({ goals: [goalView('wst_a')], now: new Date(Date.parse('2026-11-14T00:00:00.000Z') + hour * 3_600_000).toISOString() }, ports);
      const lane = report.laneActions.find((a) => a.lane === 'free-lane')!;
      kinds.push(lane.kind);
      expect(lane.limitRaiseAllowed).toBe(false);
    }
    expect(new Set(kinds)).toEqual(new Set(['CHANGE_QUESTION_DESIGN']));
    // The same recommendation hour after hour is one row, not one an hour.
    expect(events.get('wst_a')).toHaveLength(1);
  });

  it('a remedy record that names no change is not a change', async () => {
    const { ports, apply } = memoryPorts(reading());
    apply({ lane: 'free-lane', remedy: 'QUESTION_DESIGN', appliedAt: '2026-11-01T00:00:00.000Z', ref: ' ' });
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_QUESTION_DESIGN');
  });

  it('reaches REMEDIES_EXHAUSTED only after all three changes were applied and measured', async () => {
    const { ports, apply } = memoryPorts(reading());
    apply({ lane: 'free-lane', remedy: 'QUESTION_DESIGN', appliedAt: '2026-11-01T00:00:00.000Z', ref: 'prompt-v2' });
    apply({ lane: 'free-lane', remedy: 'EVIDENCE_SOURCES', appliedAt: '2026-11-05T00:00:00.000Z', ref: 'sources-v2' });
    apply({ lane: 'free-lane', remedy: 'MODEL_ROUTING', appliedAt: '2026-11-09T00:00:00.000Z', ref: 'routing-v2' });
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.laneActions.find((a) => a.lane === 'free-lane')).toMatchObject({ kind: 'REMEDIES_EXHAUSTED', limitRaiseAllowed: true });
  });

  it('never adds capacity on an unmeasured quota: a capacity change is a recommendation, and none is made here', async () => {
    const { ports, events } = memoryPorts(reading());
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.capacity.every((c) => c.kind === 'NO_CAPACITY')).toBe(true);
    expect((events.get('wst_a')![0]!.capacity as { recommendationOnly: boolean }[]).every((c) => c.recommendationOnly)).toBe(true);
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

  it('reads an applied remedy from the goal’s own events, and refuses one that names no change', async () => {
    const goal = await createWorkstream({ projectId, title: 'Remedy goal', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: ownerId });
    const ports = await productionResearchAllocationPorts();
    expect(await ports.appliedRemedies!([goal.id])).toEqual([]);
    await expect(recordRemedyApplied({ goalId: goal.id, lane: 'free-lane', remedy: 'QUESTION_DESIGN', ref: '  ', actorRef: 'BRAIN' })).rejects.toThrow(/name the change/);
    await recordRemedyApplied({ goalId: goal.id, lane: 'free-lane', remedy: 'QUESTION_DESIGN', ref: 'prompt-v2', actorRef: 'BRAIN' });
    expect(await ports.appliedRemedies!([goal.id])).toMatchObject([{ lane: 'free-lane', remedy: 'QUESTION_DESIGN', ref: 'prompt-v2' }]);
  });
});
