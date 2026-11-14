/**
 * RES-07 / RES-15-5 in the goals tick: every tick that changes the research
 * allocation leaves an append-only row naming the five shares, the floors kept
 * and why; per-window yield drives the decision; a capacity change is only a
 * recommendation; nothing is started, spent or raised
 * (`server/services/goals/tick.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { goalsRouter } from '../server/routes/goals.ts';
import type { Principal } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import {
  RESEARCH_REALLOCATED_EVENT,
  advanceGoals,
  allocationInputFrom,
  reallocateResearch,
  reallocateResearchIfDue,
  sharesInForceFrom,
  triedRemediesFrom,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { binPriorityShift, purposePriorityShifts, purposesBelowFloor, COMMERCIAL_FLOOR } from '../server/services/goals/researchAllocation.ts';
import { createWorkstream as createGoal, linkWorkstream, recordWorkstreamEvent } from '../server/repos/register.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import type { BinManifest } from '../server/domain/types.ts';
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
    const { ports, events } = memoryPorts(reading());
    await reallocateResearch({ goals: [goalView('wst_a')], now: '2026-11-14T00:00:00.000Z' }, ports);
    const detail = events.get('wst_a')!.at(-1)!;
    const inForce = sharesInForceFrom(detail);
    expect(inForce).not.toBeNull();
    const total = RESEARCH_PURPOSES.reduce((sum, p) => sum + inForce!.observed[p], 0);
    expect(total).toBeCloseTo(1, 2);
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

  async function decide(goalId: string, observed: Record<ResearchPurpose, number>, decided: Record<ResearchPurpose, number>): Promise<void> {
    await recordWorkstreamEvent({
      workstreamId: goalId, kind: RESEARCH_REALLOCATED_EVENT, summary: 'Research reallocated (seeded).', actorRef: 'BRAIN',
      detail: { fingerprint: `seed-${Math.random()}`, shares: decided, observed, held: false, floors: { exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR, commercial: null, perPurpose: 0.03 } },
    });
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
    const goalId = await goalPursuing(owned);
    await recordWorkstreamEvent({ workstreamId: goalId, kind: RESEARCH_REALLOCATED_EVENT, summary: 'held', actorRef: 'BRAIN', detail: { fingerprint: 'h', shares: shares({ SELF_IMPROVEMENT: 0.6 }), observed: shares({ SELF_IMPROVEMENT: 0 }), held: true, floors: {} } });
    const report = await advanceGoals();
    expect(report.researchApplied).toBeNull();
    expect((await getBin(owned))!.priority).toBe(8);
  });
});

/*
 * Finding F6: the decision was copied onto every live goal with identical
 * Brain-wide content, and no product surface was confirmed to show research
 * capacity and allocation decisions. Each goal now carries what the decision
 * means for it, and the line its history shows names the capacity verdicts
 * and lane remedies — read back here through the product's own goal route.
 */
describe('each goal sees what the allocation decision means for it (F6)', () => {
  it('records a different, goal-specific reading on a dated goal and an undated one', async () => {
    const { ports, events } = memoryPorts(reading());
    const summaries = new Map<string, string>();
    const recordGoal = ports.recordGoal;
    ports.recordGoal = async (goalId, summary, detail) => {
      summaries.set(goalId, summary);
      await recordGoal(goalId, summary, detail);
    };
    await reallocateResearch(
      {
        goals: [
          goalView('wst_due', { dueAt: '2026-11-20T00:00:00.000Z', target: {} as GoalView['target'] }),
          goalView('wst_open'),
        ],
        now: '2026-11-14T00:00:00.000Z',
      },
      ports,
    );
    const due = events.get('wst_due')!.at(-1)!;
    const open = events.get('wst_open')!.at(-1)!;
    expect(due.forGoal).toMatchObject({ goalId: 'wst_due', deadlineDays: 6, holdsCommercialFloor: true, nearestDeadline: true });
    expect(open.forGoal).toMatchObject({ goalId: 'wst_open', deadlineDays: null, holdsCommercialFloor: false, nearestDeadline: false });
    expect(due.goalFingerprint).not.toEqual(open.goalFingerprint);
    expect(summaries.get('wst_due')).not.toEqual(summaries.get('wst_open'));
    expect(summaries.get('wst_due')).toMatch(/due in 6 days, the nearest deadline, so it holds the commercial floor/);
    expect(summaries.get('wst_open')).toMatch(/no dated target, so it holds no commercial floor/);
    // The rendered line carries the decisions, not only the shares.
    for (const line of summaries.values()) {
      expect(line).toMatch(/capacity: /);
      expect(line).toMatch(/lanes: free-lane change question design/);
      expect(line.length).toBeLessThanOrEqual(400);
    }
  });

  it('writes a goal again only when what the decision means for it changes', async () => {
    // No lane needs a remedy, so the same window gives the same Brain-wide decision each pass.
    const steady = reading();
    steady.lanes = {};
    const { ports, events } = memoryPorts(steady);
    const goals = (dueAt: string | null) => [goalView('wst_a', dueAt ? { dueAt, target: {} as GoalView['target'] } : {})];
    await reallocateResearch({ goals: goals(null), now: '2026-11-14T00:00:00.000Z' }, ports);
    // The same decision, the same bearing: nothing more.
    await reallocateResearch({ goals: goals(null), now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(events.get('wst_a')).toHaveLength(1);
    // The goal gains a deadline: its reading changed, so it is written once more.
    await reallocateResearch({ goals: goals('2026-11-20T00:00:00.000Z'), now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(events.get('wst_a')).toHaveLength(2);
    expect(events.get('wst_a')!.at(-1)!.forGoal).toMatchObject({ holdsCommercialFloor: true });
  });
});

describe('the decision is visible in the product: the goal page route returns it', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('GET /api/goals/:id carries the goal-specific research allocation line in the goal history', async () => {
    const projectId = (await freshProject()).project.id;
    const userId = (await createUser({ email: `alloc-view-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    await grantMembership({ projectId, principalType: 'HUMAN', principalId: userId, role: 'ADMIN', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'CAPABILITY', createdByUserId: userId });
    const { productionResearchAllocationPorts } = await import('../server/services/goals/tick.ts');
    const ports = await productionResearchAllocationPorts();
    ports.readYield = async () => reading();
    await reallocateResearch({ goals: [goalView(goal.id, { projectId })], now: '2026-11-14T00:00:00.000Z' }, ports);

    const principal = {
      type: 'HUMAN', id: userId, handle: 'owner@example.test', displayName: 'Owner', isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'ses_browser', authMethod: 'SESSION_COOKIE', requestId: 'req',
      memberships: [{ id: 'mem', projectId, principalType: 'HUMAN', principalId: userId, role: 'ADMIN', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test', grantedAt: '2026-01-01T00:00:00.000Z', active: true }],
    } as Principal;
    const app = express();
    app.use((req, _res, next) => {
      attachContext(req, { principal, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
      next();
    });
    app.use('/api', goalsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/goals/${goal.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { kind: string; summary: string; detail: Record<string, unknown> }[] };
    const shown = body.events.find((e) => e.kind === RESEARCH_REALLOCATED_EVENT);
    expect(shown).toBeDefined();
    expect(shown!.summary).toMatch(/^Research reallocated — this goal has no dated target/);
    expect(shown!.summary).toMatch(/capacity: /);
    expect(shown!.summary).toMatch(/lanes: free-lane change question design/);
    expect(shown!.detail.forGoal).toMatchObject({ goalId: goal.id });
  });
});
