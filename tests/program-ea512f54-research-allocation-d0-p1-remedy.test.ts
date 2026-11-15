/**
 * RES-15-5, review finding R2-F1: a lane remedy is applied, not only
 * recommended. The goals tick puts each recommended question-design or
 * evidence-source change in force on the live goals' research and records it
 * with the change it made; the goal question builders read that record and
 * carry the change; the next windows measure it and move the lane on; and a
 * remedy with no lever (model routing) never holds a lane for ever, so a lane
 * whose applied changes were measured can reach a capacity decision again.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import {
  RESEARCH_REMEDY_APPLIED_EVENT,
  productionResearchAllocationPorts,
  reallocateResearch,
  remediesToApply,
  type AppliedRemedy,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import {
  APPLICABLE_REMEDIES,
  REMEDY_LEVERS,
  RESEARCH_PURPOSES,
  decideCapacity,
  decideLaneActions,
  remediesInForce,
  remedyInstructions,
  type BottleneckMeasurement,
  type LaneMeasurement,
  type ResearchPurpose,
} from '../server/services/goals/researchAllocation.ts';
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

/** The free lane: 400 accepted claims, 2 actionable links — low actionability, every window. */
function reading(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  purposes.BROAD_DISCOVERY = bucket({ submissions: 60, completions: 60, usefulResults: 1, jobMs: 10_800_000 });
  return {
    window: { since: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z', ms: 86_400_000 },
    total: bucket({ submissions: 80, completions: 80, usefulResults: 13, jobMs: 14_400_000 }),
    lanes: {
      'free-lane': bucket({ submissions: 60, completions: 50, acceptedClaims: 400, qualifiedPositions: 2, jobMs: 10_800_000, failures: { total: 10, rateLimited: 10, other: 0, causes: [] } }),
    },
    purposes,
    costCountedOnce: { jobs: 80, totalJobMs: 14_400_000, purposeJobMs: 14_400_000, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [{ jobId: 'job_1', lane: 'free-lane', purposes: ['BROAD_DISCOVERY'], basis: ['discovery bucket'] }],
    notes: [],
  };
}

const goalView = (id: string): GoalView => ({ id, projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null }) as unknown as GoalView;

/** In-memory ports whose `applyRemedy` records the change at the pass's own time, as production does. */
function memoryPorts() {
  const clock = { now: '2026-11-14T00:00:00.000Z' };
  const applied: (AppliedRemedy & { goalId: string })[] = [];
  const decisions: Record<string, unknown>[] = [];
  const ports: ResearchAllocationPorts = {
    readYield: async () => reading(),
    appliedRemedies: async (ids) => applied.filter((one) => ids.includes(one.goalId)),
    applyRemedy: async ({ lane, remedy, ref, goalIds }) => {
      for (const goalId of goalIds) applied.push({ goalId, lane, remedy, ref, appliedAt: clock.now });
    },
    lastDecision: async () => (decisions.length ? { detail: decisions.at(-1)!, at: clock.now } : null),
    recordDecision: async (_s, detail) => {
      decisions.push(detail);
    },
  };
  return { ports, applied, clock };
}

const lowLane: LaneMeasurement = { lane: 'free-lane', purposes: ['BROAD_DISCOVERY'], claims: 400, actionableLinks: 2 };
const waiting: BottleneckMeasurement = {
  lane: 'free-lane', purposes: ['BROAD_DISCOVERY'], resource: 'MODEL_RATE_LIMIT', qualifiedQueued: 6, queueWaitMs: 40 * 60_000,
  measuredMachineLimit: true, quotaHeadroom: 3, reliability: 0.9, ownedByAnotherWorker: false, incrementalCostPerUnit: 0,
};

describe('a remedy nothing can apply never holds a lane (pure)', () => {
  it('question design and evidence sources have levers; model routing has none here', () => {
    expect(APPLICABLE_REMEDIES).toEqual(['QUESTION_DESIGN', 'EVIDENCE_SOURCES']);
    expect(REMEDY_LEVERS.QUESTION_DESIGN?.ref).toMatch(/question-design/);
    expect(remedyInstructions([])).toBe('');
    expect(remedyInstructions(['EVIDENCE_SOURCES', 'QUESTION_DESIGN'])).toBe(`${REMEDY_LEVERS.QUESTION_DESIGN!.instruction} ${REMEDY_LEVERS.EVIDENCE_SOURCES!.instruction}`);
  });

  it('after every applicable change was measured, the lane may reach a capacity decision; with all three waited on it may not', () => {
    const measured = { ...lowLane, triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES'] as const };
    const withLevers = decideLaneActions([{ ...measured, triedRemedies: [...measured.triedRemedies] }], APPLICABLE_REMEDIES)[0]!;
    expect(withLevers).toMatchObject({ kind: 'REMEDIES_EXHAUSTED', limitRaiseAllowed: true });
    expect(withLevers.reason).toMatch(/model routing has no lever/);
    expect(decideCapacity([waiting], [{ ...measured, triedRemedies: [...measured.triedRemedies] }], APPLICABLE_REMEDIES)[0]).toMatchObject({ kind: 'ADD_CAPACITY' });
    // The stricter default is unchanged for a caller that names no levers.
    expect(decideLaneActions([{ ...measured, triedRemedies: [...measured.triedRemedies] }])[0]?.kind).toBe('CHANGE_MODEL_ROUTING');
  });

  it('a lane that has measured nothing is still refused capacity until its first change is made', () => {
    expect(decideCapacity([waiting], [lowLane], APPLICABLE_REMEDIES)[0]).toMatchObject({ kind: 'NO_CAPACITY' });
    expect(decideCapacity([waiting], [lowLane], APPLICABLE_REMEDIES)[0]!.reason).toMatch(/comes before more capacity/);
  });

  it('applies only a recommended change with a lever that no record says was applied', () => {
    const actions = decideLaneActions([lowLane], APPLICABLE_REMEDIES);
    expect(remediesToApply(actions, [])).toEqual([{ lane: 'free-lane', remedy: 'QUESTION_DESIGN', ref: REMEDY_LEVERS.QUESTION_DESIGN!.ref }]);
    expect(remediesToApply(actions, [{ lane: 'free-lane', remedy: 'QUESTION_DESIGN', appliedAt: '2026-11-14T00:00:00.000Z', ref: 'x' }])).toEqual([]);
    const measuring = decideLaneActions([{ ...lowLane, measuringRemedy: 'QUESTION_DESIGN' }], APPLICABLE_REMEDIES);
    expect(remediesToApply(measuring, [])).toEqual([]);
  });
});

describe('the tick applies the remedy it recommends', () => {
  it('walks a low-actionability lane through applied, measured changes instead of recommending the first one for ever', async () => {
    const { ports, applied, clock } = memoryPorts();
    const goals = [goalView('wst_a'), goalView('wst_b')];

    const first = await reallocateResearch({ goals, now: clock.now }, ports);
    expect(first.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(first.applied).toEqual([{ lane: 'free-lane', remedy: 'QUESTION_DESIGN', ref: REMEDY_LEVERS.QUESTION_DESIGN!.ref }]);
    // Put in force on every live goal's research, each record naming the change.
    expect(applied.map((one) => one.goalId).sort()).toEqual(['wst_a', 'wst_b']);

    clock.now = '2026-11-14T06:00:00.000Z';
    const measuring = await reallocateResearch({ goals, now: clock.now }, ports);
    expect(measuring.laneActions.find((a) => a.lane === 'free-lane')).toMatchObject({ kind: 'MEASURING_REMEDY', remedy: 'QUESTION_DESIGN' });
    expect(measuring.applied).toEqual([]);

    clock.now = '2026-11-15T01:00:00.000Z';
    const second = await reallocateResearch({ goals, now: clock.now }, ports);
    expect(second.laneActions.find((a) => a.lane === 'free-lane')?.kind).toBe('CHANGE_EVIDENCE_SOURCES');
    expect(second.applied.map((one) => one.remedy)).toEqual(['EVIDENCE_SOURCES']);

    clock.now = '2026-11-16T02:00:00.000Z';
    const third = await reallocateResearch({ goals, now: clock.now }, ports);
    const lane = third.laneActions.find((a) => a.lane === 'free-lane')!;
    expect(lane).toMatchObject({ kind: 'REMEDIES_EXHAUSTED', limitRaiseAllowed: true });
    expect(third.applied).toEqual([]);
    // Capacity is no longer refused because a remedy is pending; it is judged on the measured constraint.
    expect(third.capacity.every((c) => !/comes before more capacity/.test(c.reason))).toBe(true);
  });

  it('applies nothing without a lever port, and nothing on a pass with no live goal', async () => {
    const { ports, applied } = memoryPorts();
    const report = await reallocateResearch({ goals: [], now: '2026-11-14T00:00:00.000Z' }, ports);
    expect(report.applied).toEqual([]);
    expect(applied).toEqual([]);
  });
});

describe('on production rows', () => {
  let ownerId: string;
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    ownerId = (await createUser({ email: `remedy-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('records an applied remedy on each goal, and the goal’s question builders read it into their questions', async () => {
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: ownerId });
    const other = await createWorkstream({ projectId, title: 'Untouched', intent: 'Another goal.', purpose: 'REVENUE_DIRECT', createdByUserId: ownerId });
    expect(await remediesInForce(goal.id)).toEqual([]);
    const ports = await productionResearchAllocationPorts();
    await ports.applyRemedy!({ lane: 'free-lane:brain-a', remedy: 'QUESTION_DESIGN', ref: REMEDY_LEVERS.QUESTION_DESIGN!.ref, goalIds: [goal.id] });
    const events = (await listWorkstreamEvents(goal.id, 50)).filter((e) => e.kind === RESEARCH_REMEDY_APPLIED_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ lane: 'free-lane:brain-a', remedy: 'QUESTION_DESIGN', ref: REMEDY_LEVERS.QUESTION_DESIGN!.ref });
    // The record is what makes it tried for the allocation, and in force for the question builders.
    expect(await ports.appliedRemedies!([goal.id])).toMatchObject([{ lane: 'free-lane:brain-a', remedy: 'QUESTION_DESIGN' }]);
    expect(await remediesInForce(goal.id)).toEqual(['QUESTION_DESIGN']);
    expect(remedyInstructions(await remediesInForce(goal.id))).toContain('specific buyer');
    expect(await remediesInForce(other.id)).toEqual([]);
  });
});
