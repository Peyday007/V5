/**
 * RES-07 / RES-15-5 in the goals tick: every tick that changes the research
 * allocation leaves one append-only Brain-wide row naming the five shares, the
 * floors kept and why — never a copy per goal; per-window yield drives the
 * decision; a capacity change is only a recommendation; nothing is started,
 * spent or raised; and the goals briefing shows the decision and the capacity
 * it found (`server/services/goals/tick.ts`, `briefing.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import {
  RESEARCH_ALLOCATION_DECIDED,
  RESEARCH_REALLOCATED_EVENT,
  advanceGoals,
  latestResearchDecision,
  allocationInputFrom,
  purposePressureFrom,
  productionResearchAllocationPorts,
  reallocateResearch,
  recordRemedyApplied,
  reallocateResearchIfDue,
  sharesInForceFrom,
  triedRemediesFrom,
  type AppliedRemedy,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { binPriorityShift, purposePriorityShifts, purposesBelowFloor, COMMERCIAL_FLOOR } from '../server/services/goals/researchAllocation.ts';
import { createWorkstream as createGoal, linkWorkstream } from '../server/repos/register.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import type { BinManifest } from '../server/domain/types.ts';
import { RESEARCH_PURPOSES, EXPLORATION_FLOOR, SYSTEM_HEALTH_FLOOR, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { listImprovementEvents, recordImprovementEvent } from '../server/repos/improvement.ts';
import { briefFrom, goalBriefing, researchBriefingFrom } from '../server/services/goals/briefing.ts';

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

/** In-memory ports: `decisions` is the one Brain-wide decision log, in the order written. */
function memoryPorts(yieldReading: ResearchYieldReading) {
  const decisions: Record<string, unknown>[] = [];
  const applied: AppliedRemedy[] = [];
  const ports: ResearchAllocationPorts = {
    readYield: async () => yieldReading,
    appliedRemedies: async () => [...applied],
    lastDecision: async () => (decisions.length ? { detail: decisions.at(-1)!, at: '2026-11-14T00:00:00.000Z' } : null),
    recordDecision: async (_summary, detail) => {
      decisions.push(detail);
    },
  };
  return { ports, decisions, apply: (one: AppliedRemedy) => applied.push(one) };
}

describe('the research allocation decision in the tick', () => {
  it('moves share toward the purpose with the higher useful yield, keeps the floors, and records why', async () => {
    const { ports, decisions } = memoryPorts(reading());
    const report = await reallocateResearch({ goals: [goalView('wst_a'), goalView('wst_b')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.changed).toBe(true);
    // One Brain-wide row for the whole decision, however many goals are live.
    expect(report.recorded).toBe(true);
    expect(decisions).toHaveLength(1);
    // Measured share of job time in the window: TRANSACTION_ROUTES ran 20%, BROAD_DISCOVERY 60%.
    expect(report.shares.TRANSACTION_ROUTES).toBeGreaterThan(0.2);
    expect(report.shares.BROAD_DISCOVERY).toBeLessThan(0.6);
    expect(report.shares.SELF_IMPROVEMENT).toBeGreaterThanOrEqual(SYSTEM_HEALTH_FLOOR - 1e-9);
    expect(report.shares.BROAD_DISCOVERY + report.shares.FORWARD_EXPLORATION).toBeGreaterThanOrEqual(EXPLORATION_FLOOR - 1e-9);
    const detail = decisions[0]!;
    expect(Object.keys(detail.shares as object).sort()).toEqual([...RESEARCH_PURPOSES].sort());
    expect(detail.floors).toMatchObject({ exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR });
    expect((detail.changes as { reasons: string[] }[]).some((c) => c.reasons.length > 0)).toBe(true);
    expect(detail.costCountedOnce).toMatchObject({ holds: true });
  });

  it('gives a claims-heavy, link-poor lane a question-design change before any limit is raised, then the next remedy once that change was applied and measured', async () => {
    const { ports, decisions, apply } = memoryPorts(reading());
    const first = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const lane = first.laneActions.find((a) => a.lane === 'free-lane');
    expect(lane?.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(lane?.limitRaiseAllowed).toBe(false);
    // Recommending a change is not making it.
    expect(triedRemediesFrom(decisions.at(-1)!).get('free-lane')).toEqual([]);
    // The change is made and recorded, then measured over a whole window after it.
    apply({ lane: 'free-lane', remedy: 'QUESTION_DESIGN', appliedAt: '2026-11-14T00:30:00.000Z', ref: 'prompt-v2' });
    const measuring = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T12:00:00.000Z' }, ports);
    expect(measuring.laneActions.find((a) => a.lane === 'free-lane')).toMatchObject({ kind: 'MEASURING_REMEDY', remedy: 'QUESTION_DESIGN', limitRaiseAllowed: false });
    const second = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-15T01:00:00.000Z' }, ports);
    expect(second.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_EVIDENCE_SOURCES');
    expect(triedRemediesFrom(decisions.at(-1)!).get('free-lane')).toEqual(['QUESTION_DESIGN']);
  });

  it('never walks a lane to a limit raise when no remedy was ever applied', async () => {
    const { ports, decisions } = memoryPorts(reading());
    const kinds: string[] = [];
    for (let hour = 0; hour < 6; hour += 1) {
      const report = await reallocateResearch({ goals: [goalView('wst_a')], now: new Date(Date.parse('2026-11-14T00:00:00.000Z') + hour * 3_600_000).toISOString() }, ports);
      const lane = report.laneActions.find((a) => a.lane === 'free-lane')!;
      kinds.push(lane.kind);
      expect(lane.limitRaiseAllowed).toBe(false);
    }
    expect(new Set(kinds)).toEqual(new Set(['CHANGE_QUESTION_DESIGN']));
    // The same recommendation hour after hour is one row, not one an hour.
    expect(decisions).toHaveLength(1);
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
    const { ports, decisions } = memoryPorts(reading());
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.capacity.every((c) => c.kind === 'NO_CAPACITY')).toBe(true);
    expect((decisions[0]!.capacity as { recommendationOnly: boolean }[]).every((c) => c.recommendationOnly)).toBe(true);
  });

  it('writes nothing when the decision is unchanged', async () => {
    // No lane needs a remedy, so the same window gives the same decision twice.
    const steady = reading();
    steady.lanes = {};
    const { ports, decisions } = memoryPorts(steady);
    const first = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(first.changed).toBe(true);
    const repeat = await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(repeat.changed).toBe(false);
    expect(repeat.recorded).toBe(false);
    expect(decisions).toHaveLength(1);
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

  it('records the decision once, Brain-wide, copies it onto no goal, and starts, raises or reprioritizes nothing', async () => {
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'CAPABILITY', createdByUserId: ownerId });
    const other = await createWorkstream({ projectId, title: 'Second goal', intent: 'Another goal.', purpose: 'CAPABILITY', createdByUserId: ownerId });
    const binsBefore = await getDb().all<{ id: string; priority: number; state: string }>('SELECT id, priority, state FROM bins ORDER BY id');
    const report = await advanceGoals();
    const research = report.research;
    expect(research && !('error' in research)).toBe(true);
    const rows = await listImprovementEvents({ kinds: [RESEARCH_ALLOCATION_DECIDED] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.candidateId).toBeNull();
    // Two live goals, and neither carries a copy of the Brain-wide decision.
    for (const id of [goal.id, other.id]) {
      expect((await listWorkstreamEvents(id, 50)).filter((e) => e.kind === RESEARCH_REALLOCATED_EVENT)).toHaveLength(0);
    }
    const detail = rows[0]!.detail;
    expect(Object.keys(detail.shares as object).sort()).toEqual([...RESEARCH_PURPOSES].sort());
    expect(detail.floors).toBeDefined();
    expect(detail.window).toBeDefined();
    // Nothing was measured on a fresh database, so every share holds and the row says so.
    expect(detail.held).toBe(true);
    expect(await getDb().all('SELECT id, priority, state FROM bins ORDER BY id')).toEqual(binsBefore);
    // Throttled: a second tick in the same hour does not run the pass again.
    expect((await advanceGoals()).research).toBeNull();
    // Forced, the unchanged decision writes nothing more.
    await reallocateResearchIfDue({ goals: [goalView(goal.id, { projectId }), goalView(other.id, { projectId })] }, undefined, { force: true });
    expect(await listImprovementEvents({ kinds: [RESEARCH_ALLOCATION_DECIDED] })).toHaveLength(1);
  });

  it('shows the decision in force and the capacity it found on the goals briefing, once', async () => {
    await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'CAPABILITY', createdByUserId: ownerId });
    await recordImprovementEvent({
      candidateId: null,
      kind: RESEARCH_ALLOCATION_DECIDED,
      detail: {
        fingerprint: 'seen', held: false,
        shares: shares({ TRANSACTION_ROUTES: 0.35, BROAD_DISCOVERY: 0.15 }),
        observed: shares({}),
        floors: { exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR, commercial: COMMERCIAL_FLOOR, perPurpose: 0.03 },
        deadlineGoals: ['wst_due'],
        laneCapacity: [{ lane: 'free-lane', utilization: 1.5, inFlight: 30, queueWaitMedianMs: 40 * 60_000, completions: 50, failures: 10, rateLimited: 10 }],
        capacity: [{ lane: 'free-lane', kind: 'NO_CAPACITY', units: 0, resource: 'MODEL_RATE_LIMIT', reason: 'quota headroom unmeasured' }],
        laneActions: [{ lane: 'free-lane', kind: 'CHANGE_QUESTION_DESIGN', reason: 'claims without links' }],
      },
      at: new Date(Date.now() + 1000).toISOString(),
    });
    expect((await latestResearchDecision())?.detail.fingerprint).toBe('seen');
    const { briefing } = await goalBriefing([projectId]);
    expect(briefing.research).not.toBeNull();
    expect(briefing.research!.shares.find((s) => s.purpose === 'TRANSACTION_ROUTES')?.share).toBe(0.35);
    expect(briefing.research!.laneCapacity).toEqual([expect.objectContaining({ lane: 'free-lane', inFlight: 30, rateLimited: 10 })]);
    expect(briefing.research!.deadlineGoals).toEqual(['wst_due']);
    // The rendered headline carries it: transaction routes, the floors, the measured capacity and the lane remedy.
    expect(briefing.headline).toContain('transaction routes 35.0%');
    expect(briefing.headline).toContain('commercial ≥ 20.0%');
    expect(briefing.headline).toContain('free-lane avg 1.5 running, 30 in flight, wait 40m, 10 rate-limited');
    expect(briefing.headline).toContain('free-lane change question design');
    expect(briefing.headline.match(/Research:/g)).toHaveLength(1);
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

/* ------------------------------------------------------------------------- */
/* The decision is applied to the work, not only recorded (review finding F1) */
/* ------------------------------------------------------------------------- */

const shares = (over: Partial<Record<ResearchPurpose, number>>): Record<ResearchPurpose, number> => {
  const base: Record<ResearchPurpose, number> = { BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.15, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.2 };
  return { ...base, ...over };
};

describe('the decision in force moves capacity (pure)', () => {
  it('steps an under-served purpose up, an over-served one down, and leaves a small gap alone', () => {
    const shifts = purposePriorityShifts({
      shares: shares({ BROAD_DISCOVERY: 0.3, TRANSACTION_ROUTES: 0.2 }),
      observed: shares({ BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.35, OPERATING_SUPPORT: 0.13 }),
      held: false,
      urgentCommercialGoal: false,
    });
    expect(shifts.BROAD_DISCOVERY).toBe(1);
    expect(shifts.TRANSACTION_ROUTES).toBe(-1);
    expect(shifts.OPERATING_SUPPORT).toBe(0);
  });

  it('always raises a purpose below a protected floor, whatever the gap says', () => {
    const f = {
      shares: shares({ SELF_IMPROVEMENT: SYSTEM_HEALTH_FLOOR }),
      observed: shares({ SELF_IMPROVEMENT: 0.02, BROAD_DISCOVERY: 0.05, FORWARD_EXPLORATION: 0.05, TRANSACTION_ROUTES: 0.1 }),
      held: false,
      urgentCommercialGoal: true,
    };
    expect(purposesBelowFloor(f).sort()).toEqual(['BROAD_DISCOVERY', 'FORWARD_EXPLORATION', 'SELF_IMPROVEMENT', 'TRANSACTION_ROUTES'].sort());
    expect(f.observed.TRANSACTION_ROUTES).toBeLessThan(COMMERCIAL_FLOOR);
    const shifts = purposePriorityShifts(f);
    expect(shifts.SELF_IMPROVEMENT).toBe(1);
    expect(shifts.BROAD_DISCOVERY).toBe(1);
    expect(shifts.FORWARD_EXPLORATION).toBe(1);
    expect(shifts.TRANSACTION_ROUTES).toBe(1);
  });

  it('moves nothing on a held decision, and a bin takes the largest step of the purposes it serves', () => {
    const held = purposePriorityShifts({ shares: shares({ SELF_IMPROVEMENT: 0.5 }), observed: shares({ SELF_IMPROVEMENT: 0 }), held: true, urgentCommercialGoal: true });
    expect(Object.values(held).every((v) => v === 0)).toBe(true);
    const shifts = { BROAD_DISCOVERY: 1, TRANSACTION_ROUTES: -1, OPERATING_SUPPORT: 0, SELF_IMPROVEMENT: 0, FORWARD_EXPLORATION: 0 } as const;
    expect(binPriorityShift(['TRANSACTION_ROUTES', 'BROAD_DISCOVERY'], shifts)).toBe(1);
    expect(binPriorityShift(['TRANSACTION_ROUTES'], shifts)).toBe(-1);
    expect(binPriorityShift(['UNATTRIBUTED'], shifts)).toBe(0);
    expect(binPriorityShift([], shifts)).toBe(0);
  });

  it('reads the shares in force from a recorded decision, and refuses one that cannot be compared', () => {
    const parsed = sharesInForceFrom({ fingerprint: 'f1', shares: shares({}), observed: shares({}), held: false, floors: { commercial: COMMERCIAL_FLOOR } });
    expect(parsed).toMatchObject({ fingerprint: 'f1', held: false, urgentCommercialGoal: true });
    expect(sharesInForceFrom({ shares: shares({}), held: false })).toBeNull();
    expect(sharesInForceFrom(null)).toBeNull();
  });

  it('records what the window gave each purpose beside the decided shares, so the tick can compare them', async () => {
    const { ports, decisions } = memoryPorts(reading());
    await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const detail = decisions.at(-1)!;
    const inForce = sharesInForceFrom(detail);
    expect(inForce).not.toBeNull();
    const total = RESEARCH_PURPOSES.reduce((sum, p) => sum + inForce!.observed[p], 0);
    expect(total).toBeCloseTo(1, 2);
  });
});

describe('the briefing reads the Brain-wide decision (pure)', () => {
  it('a row with no shares is no decision, and the headline is unchanged without one', () => {
    expect(researchBriefingFrom(null, null)).toBeNull();
    expect(researchBriefingFrom({ held: true }, null)).toBeNull();
    const plain = briefFrom([], '2026-11-14T00:00:00.000Z');
    expect(plain.research).toBeNull();
    expect(plain.headline).not.toContain('Research');
  });

  it('says a held decision is held', () => {
    const r = researchBriefingFrom({ held: true, shares: shares({}), observed: shares({}), floors: {} }, '2026-11-14T00:00:00.000Z')!;
    expect(r.held).toBe(true);
    expect(r.line).toMatch(/^Research allocation held/);
  });
});

describe('advanceGoals applies the newest recorded decision to live bins (review finding F1)', () => {
  let ownerId: string;
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    ownerId = (await createUser({ email: `apply-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    // Spend this hour's decision pass so the seeded decision below is the one in force.
    await reallocateResearchIfDue({ goals: [] }, memoryPorts(reading()).ports, { nowMs: Date.now(), force: true });
  });

  function manifest(): BinManifest {
    return {
      objective: 'Establish a value.', why: 'Exercise allocation.', lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'unit-1', establishes: 'The transform of input 1', input: 'one', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [], excludedSources: [], evidence: ['a recomputed value'], outputs: ['one unit result'],
      authorizedActions: ['submit unit results'], prohibitedActions: ['anything with an external effect'], budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['every unit verified'],
    };
  }

  async function brainBin(priority: number): Promise<string> {
    const bin = await createBin({ projectId, kind: 'DETERMINISTIC_CHECK', title: 'Method check', objective: 'Establish a value.', manifest: manifest(), completionContract: 'DETERMINISTIC_UNITS_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true });
    await getDb().run(`UPDATE bins SET purpose = 'BRAIN_IMPROVEMENT', priority = ? WHERE id = ?`, [priority, bin.id]);
    return bin.id;
  }

  async function goalPursuing(binId: string): Promise<string> {
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'Answer the question.', whyNow: 'A goal pursues it.', idempotencyKey: `m-${binId}` });
    await linkMission({ missionId: mission.id, binId });
    const goal = await createGoal({ projectId, title: 'Improve methods', intent: 'Better methods.', purpose: 'CAPABILITY', createdByUserId: ownerId });
    await linkWorkstream({ workstreamId: goal.id, kind: 'MISSION', ref: mission.id, relation: 'PURSUES', recordedBy: 'PERSON' });
    return goal.id;
  }

  let seeded = 0;
  /** Seed the Brain-wide decision row; each one is newer than the last. */
  async function seedDecision(detail: Record<string, unknown>): Promise<void> {
    seeded += 1;
    await recordImprovementEvent({ candidateId: null, kind: RESEARCH_ALLOCATION_DECIDED, detail, at: new Date(Date.now() + seeded * 1000).toISOString() });
  }

  async function decide(_goalId: string, observed: Record<ResearchPurpose, number>, decided: Record<ResearchPurpose, number>): Promise<void> {
    await seedDecision({ fingerprint: `seed-${Math.random()}`, shares: decided, observed, held: false, floors: { exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR, commercial: null, perPurpose: 0.03 } });
  }

  it('raises a bin no goal pursues while system health is below its floor', async () => {
    const owned = await brainBin(5);
    const goalId = await goalPursuing(owned);
    const loose = await brainBin(5);
    await decide(goalId, shares({ SELF_IMPROVEMENT: 0.02 }), shares({ SELF_IMPROVEMENT: SYSTEM_HEALTH_FLOOR }));
    const report = await advanceGoals();
    expect(report.researchApplied?.belowFloor).toContain('SELF_IMPROVEMENT');
    expect((await getBin(loose))!.priority).toBe(8);
    expect(report.researchApplied?.floorRaised).toContainEqual(expect.objectContaining({ binId: loose, from: 5, to: 8 }));
    // The goal's own bin is at its rank's priority (already the top), never past it.
    expect((await getBin(owned))!.priority).toBe(8);
  });

  it('steps a goal bin of an over-served purpose down from its rank, and back when the decision changes', async () => {
    const owned = await brainBin(5);
    const goalId = await goalPursuing(owned);
    await decide(goalId, shares({ SELF_IMPROVEMENT: 0.6 }), shares({ SELF_IMPROVEMENT: 0.3 }));
    const report = await advanceGoals();
    expect(report.researchApplied?.shifts.SELF_IMPROVEMENT).toBe(-1);
    expect((await getBin(owned))!.priority).toBe(7);
    expect(report.researchApplied?.goalBins).toContainEqual(expect.objectContaining({ binId: owned, shift: -1 }));
    const allocated = (await listWorkstreamEvents(goalId, 50)).find((e) => e.kind === 'GOAL_CAPACITY_ALLOCATED');
    expect((allocated!.detail as { researchShift: unknown[] }).researchShift).toHaveLength(1);

    // A newer decision that finds the purpose in balance returns the bin to its rank's priority.
    await decide(goalId, shares({}), shares({}));
    await advanceGoals();
    expect((await getBin(owned))!.priority).toBe(8);
  });

  it('a held decision moves no bin', async () => {
    const owned = await brainBin(5);
    await goalPursuing(owned);
    await seedDecision({ fingerprint: 'h', shares: shares({ SELF_IMPROVEMENT: 0.6 }), observed: shares({ SELF_IMPROVEMENT: 0 }), held: true, floors: {} });
    const report = await advanceGoals();
    expect(report.researchApplied).toBeNull();
    expect((await getBin(owned))!.priority).toBe(8);
  });
});

describe('deadlines and expected decision value reach every purpose a goal’s research serves (F4)', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const nowMs = Date.parse(now);
  const target = (remainingCents: number, achieved = false) => ({ remainingCents, achieved }) as GoalView['target'];
  const job = (goalId: string | undefined, purposes: string[], jobMs: number) =>
    ({ jobId: `j_${goalId}_${purposes.join('_')}`, lane: 'free-lane', purposes, basis: [], ...(goalId ? { goalId } : {}), jobMs }) as ResearchYieldReading['attributions'][number];

  it('splits a goal’s remaining target across the purposes its research served, by job time, counted once', () => {
    const goals = [goalView('wst_cash', { dueAt: '2026-11-17T00:00:00.000Z', target: target(1_000_000) })];
    const p = purposePressureFrom(goals, { attributions: [job('wst_cash', ['BROAD_DISCOVERY'], 3_000), job('wst_cash', ['TRANSACTION_ROUTES'], 1_000)] }, nowMs);
    expect(p.BROAD_DISCOVERY.decisionValue).toBeCloseTo(750_000, 6);
    expect(p.TRANSACTION_ROUTES.decisionValue).toBeCloseTo(250_000, 6);
    // The stake is counted once across purposes, like a job's cost.
    expect(RESEARCH_PURPOSES.reduce((s, one) => s + (p[one].decisionValue ?? 0), 0)).toBeCloseTo(1_000_000, 6);
    // The deadline bears on every purpose the goal's research served — not only TRANSACTION_ROUTES.
    expect(p.BROAD_DISCOVERY.nearestDeadlineDays).toBeCloseTo(3, 6);
    expect(p.TRANSACTION_ROUTES.nearestDeadlineDays).toBeCloseTo(3, 6);
    expect(p.SELF_IMPROVEMENT).toMatchObject({ nearestDeadlineDays: null, decisionValue: null });
  });

  it('a goal no job names puts its target on transaction routes, and a goal without a target its deadline on forward exploration with no invented value', () => {
    const goals = [
      goalView('wst_cash', { dueAt: '2026-11-24T00:00:00.000Z', target: target(500_000) }),
      goalView('wst_next', { dueAt: '2026-11-16T00:00:00.000Z', target: null }),
      goalView('wst_done', { dueAt: '2026-11-15T00:00:00.000Z', target: target(0, true) }),
      goalView('wst_paused', { lifecycle: 'PAUSED', dueAt: '2026-11-15T00:00:00.000Z', target: target(9_000_000) } as Partial<GoalView>),
    ];
    const p = purposePressureFrom(goals, { attributions: [job(undefined, ['SELF_IMPROVEMENT'], 5_000)] }, nowMs);
    expect(p.TRANSACTION_ROUTES.decisionValue).toBe(500_000);
    expect(p.FORWARD_EXPLORATION.nearestDeadlineDays).toBeCloseTo(2, 6);
    expect(p.FORWARD_EXPLORATION.decisionValue).toBeNull();
    // An achieved target is a deadline with nothing left at stake; a paused goal is not live.
    expect(p.TRANSACTION_ROUTES.nearestDeadlineDays).toBeCloseTo(1, 6);
    expect(p.SELF_IMPROVEMENT.decisionValue).toBeNull();
  });

  it('the production pass gives the decision a decision value and a deadline beyond TRANSACTION_ROUTES, and records them', async () => {
    const r = reading();
    r.attributions = [job('wst_cash', ['BROAD_DISCOVERY'], 9_000), job('wst_cash', ['TRANSACTION_ROUTES'], 1_000), job('wst_next', ['FORWARD_EXPLORATION'], 1_000)];
    const goals = [
      goalView('wst_cash', { dueAt: '2026-11-16T00:00:00.000Z', target: target(2_000_000) }),
      goalView('wst_next', { dueAt: '2026-11-15T00:00:00.000Z', target: null }),
    ];
    const pressure = purposePressureFrom(goals, r, nowMs);
    const input = allocationInputFrom(r, { urgentCommercialGoal: true, nearestDeadlineDays: 2, triedRemedies: new Map(), pressure });
    const by = new Map(input.purposes.map((m) => [m.purpose, m]));
    expect(by.get('BROAD_DISCOVERY')!.decisionValue).toBeCloseTo(1_800_000, 6);
    expect(by.get('BROAD_DISCOVERY')!.nearestDeadlineDays).toBeCloseTo(2, 6);
    expect(by.get('FORWARD_EXPLORATION')!.nearestDeadlineDays).toBeCloseTo(1, 6);
    expect(by.get('SELF_IMPROVEMENT')!.decisionValue).toBeUndefined();

    const { ports, decisions } = memoryPorts(r);
    await reallocateResearch({ goals, now }, ports);
    const detail = decisions[0]! as { pressure: Record<string, { decisionValue: number | null; nearestDeadlineDays: number | null; basis: string[] }>; changes: { purpose: string; reasons: string[] }[] };
    expect(detail.pressure.BROAD_DISCOVERY!.decisionValue).toBe(1_800_000);
    expect(detail.pressure.FORWARD_EXPLORATION!.nearestDeadlineDays).toBe(1);
    expect(detail.pressure.TRANSACTION_ROUTES!.basis.join(' ')).toContain('wst_cash');
    const reasons = detail.changes.flatMap((c) => c.reasons).join(' | ');
    expect(reasons).toContain('expected decision value');
    expect(detail.changes.find((c) => c.purpose === 'FORWARD_EXPLORATION')?.reasons.join(' ') ?? '').toContain('a deadline in 1 day(s)');
  });
});
