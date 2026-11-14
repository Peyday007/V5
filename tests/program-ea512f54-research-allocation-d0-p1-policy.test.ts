import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_FLOOR,
  EXPLORATION_FLOOR,
  MAX_STEP,
  MIN_PURPOSE_SHARE,
  RESEARCH_PURPOSES,
  SYSTEM_HEALTH_FLOOR,
  decideCapacity,
  decideLaneActions,
  decideResearchAllocation,
  enforceFloors,
  type AllocationInput,
  type BottleneckMeasurement,
  type PurposeMeasurement,
  type ResearchPurpose,
} from '../server/services/goals/researchAllocation.ts';
import { RESEARCH_PURPOSES as YIELD_PURPOSES, summarizeResearchYield, type YieldJob, type YieldOutput } from '../server/services/goals/researchYield.ts';

const equal = Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, 0.2])) as Record<ResearchPurpose, number>;

function measured(over: Partial<Record<ResearchPurpose, Partial<PurposeMeasurement>>> = {}): PurposeMeasurement[] {
  return RESEARCH_PURPOSES.map((purpose) => ({ purpose, usefulResults: 10, cost: 10, ...over[purpose] }));
}

function assertFloors(shares: Record<ResearchPurpose, number>, commercial: boolean) {
  const sum = RESEARCH_PURPOSES.reduce((s, p) => s + shares[p], 0);
  expect(sum).toBeCloseTo(1, 9);
  for (const p of RESEARCH_PURPOSES) expect(shares[p]).toBeGreaterThanOrEqual(MIN_PURPOSE_SHARE - 1e-9);
  expect(shares.BROAD_DISCOVERY + shares.FORWARD_EXPLORATION).toBeGreaterThanOrEqual(EXPLORATION_FLOOR - 1e-9);
  expect(shares.SELF_IMPROVEMENT).toBeGreaterThanOrEqual(SYSTEM_HEALTH_FLOOR - 1e-9);
  if (commercial) expect(shares.TRANSACTION_ROUTES).toBeGreaterThanOrEqual(COMMERCIAL_FLOOR - 1e-9);
}

const bottleneck = (over: Partial<BottleneckMeasurement> = {}): BottleneckMeasurement => ({
  lane: 'free-lane',
  purposes: ['TRANSACTION_ROUTES'],
  resource: 'GPU',
  qualifiedQueued: 6,
  queueWaitMs: 40 * 60_000,
  measuredMachineLimit: true,
  quotaHeadroom: 3,
  reliability: 0.95,
  ownedByAnotherWorker: false,
  incrementalCostPerUnit: 2,
  ...over,
});

describe('A01: shares move with outcome, deadline, decision value and bottleneck; floors hold', () => {
  it('moves share toward the purpose with higher useful outcome per unit cost, at most MAX_STEP', () => {
    const d = decideResearchAllocation({ currentShares: equal, purposes: measured({ OPERATING_SUPPORT: { usefulResults: 60 } }), urgentCommercialGoal: false });
    expect(d.held).toBe(false);
    expect(d.shares.OPERATING_SUPPORT).toBeGreaterThan(0.2);
    expect(d.shares.OPERATING_SUPPORT - 0.2).toBeLessThanOrEqual(MAX_STEP + 1e-9);
    const change = d.changes.find((c) => c.purpose === 'OPERATING_SUPPORT');
    expect(change?.reasons.join(' ')).toMatch(/useful results per unit cost/);
    assertFloors(d.shares, false);
  });

  it('an impending deadline pulls share toward its purpose', () => {
    const d = decideResearchAllocation({ currentShares: equal, purposes: measured({ TRANSACTION_ROUTES: { nearestDeadlineDays: 1 } }), urgentCommercialGoal: true });
    expect(d.shares.TRANSACTION_ROUTES).toBeGreaterThan(0.2);
    expect(d.changes.find((c) => c.purpose === 'TRANSACTION_ROUTES')?.reasons.join(' ')).toMatch(/deadline in 1 day/);
  });

  it('expected decision value pulls share toward its purpose', () => {
    const d = decideResearchAllocation({ currentShares: equal, purposes: measured({ FORWARD_EXPLORATION: { decisionValue: 100 }, BROAD_DISCOVERY: { decisionValue: 1 } }), urgentCommercialGoal: false });
    expect(d.shares.FORWARD_EXPLORATION).toBeGreaterThan(d.shares.BROAD_DISCOVERY);
    expect(d.changes.find((c) => c.purpose === 'FORWARD_EXPLORATION')?.reasons.join(' ')).toMatch(/decision value/);
  });

  it('moves share away from a purpose held by a measured bottleneck no capacity can be added for', () => {
    const d = decideResearchAllocation({
      currentShares: equal,
      purposes: measured(),
      bottlenecks: [bottleneck({ purposes: ['OPERATING_SUPPORT'], ownedByAnotherWorker: true })],
      urgentCommercialGoal: false,
    });
    expect(d.shares.OPERATING_SUPPORT).toBeLessThan(0.2);
    expect(d.changes.find((c) => c.purpose === 'OPERATING_SUPPORT')?.reasons.join(' ')).toMatch(/measured GPU limit/);
  });

  it('keeps every floor under extreme inputs, and the commercial goal keeps its share', () => {
    const extremes: AllocationInput[] = [
      { currentShares: { TRANSACTION_ROUTES: 1 }, purposes: measured({ TRANSACTION_ROUTES: { usefulResults: 1e9, nearestDeadlineDays: 0, decisionValue: 1e9 } }), urgentCommercialGoal: true },
      { currentShares: { SELF_IMPROVEMENT: 1 }, purposes: measured({ SELF_IMPROVEMENT: { usefulResults: 1e9 }, TRANSACTION_ROUTES: { usefulResults: 0 } }), urgentCommercialGoal: true },
      { currentShares: { BROAD_DISCOVERY: 0, FORWARD_EXPLORATION: 0, OPERATING_SUPPORT: 1 }, purposes: measured({ BROAD_DISCOVERY: { usefulResults: 0 }, FORWARD_EXPLORATION: { usefulResults: 0 } }), urgentCommercialGoal: false },
      { currentShares: { OPERATING_SUPPORT: -5, TRANSACTION_ROUTES: Number.NaN }, purposes: measured({ OPERATING_SUPPORT: { usefulResults: 1e12, cost: 1e-9 } }), urgentCommercialGoal: true },
    ];
    for (const input of extremes) {
      let shares = decideResearchAllocation(input).shares;
      assertFloors(shares, input.urgentCommercialGoal);
      // Repeated decisions under the same pressure still never cross a floor.
      for (let i = 0; i < 30; i += 1) {
        shares = decideResearchAllocation({ ...input, currentShares: shares }).shares;
        assertFloors(shares, input.urgentCommercialGoal);
      }
    }
  });

  it('enforceFloors restores every floor from a degenerate vector', () => {
    const zero = Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, 0])) as Record<ResearchPurpose, number>;
    assertFloors(enforceFloors({ ...zero, OPERATING_SUPPORT: 1 }, true), true);
    assertFloors(enforceFloors(zero, false), false);
  });

  it('holds every share and says so when nothing is measured', () => {
    const d = decideResearchAllocation({
      currentShares: { BROAD_DISCOVERY: 0.25, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.15, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.15 },
      purposes: RESEARCH_PURPOSES.map((purpose) => ({ purpose, usefulResults: null, cost: null })),
      urgentCommercialGoal: true,
    });
    expect(d.held).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.notes.join(' ')).toMatch(/every share holds/);
  });

  it('an unmeasured purpose is never raised for yield it did not show', () => {
    const d = decideResearchAllocation({
      currentShares: equal,
      purposes: measured({ FORWARD_EXPLORATION: { usefulResults: null, cost: null }, BROAD_DISCOVERY: { usefulResults: 1 } }),
      urgentCommercialGoal: false,
    });
    expect(d.shares.FORWARD_EXPLORATION).toBeLessThanOrEqual(0.2 + 0.05);
    const fe = d.changes.find((c) => c.purpose === 'FORWARD_EXPLORATION');
    if (fe) expect(fe.reasons.join(' ')).toMatch(/not measured/);
  });

  it('a lane name is a free string: no lane or industry is whitelisted', () => {
    const actions = decideLaneActions([{ lane: 'any-industry-whatsoever', purposes: ['BROAD_DISCOVERY'], claims: 100, actionableLinks: 1 }]);
    expect(actions).toHaveLength(1);
  });
});

describe('A02: actionability remedies before limits; capacity only for a measured constraint', () => {
  const lowLane = { lane: 'free-lane', purposes: ['BROAD_DISCOVERY'] as ResearchPurpose[], claims: 200, actionableLinks: 3 };

  it('a low-actionability lane gets question design, then sources, then routing, skipping ones tried', () => {
    expect(decideLaneActions([lowLane])[0]).toMatchObject({ kind: 'CHANGE_QUESTION_DESIGN', limitRaiseAllowed: false });
    expect(decideLaneActions([{ ...lowLane, triedRemedies: ['QUESTION_DESIGN'] }])[0]).toMatchObject({ kind: 'CHANGE_EVIDENCE_SOURCES' });
    expect(decideLaneActions([{ ...lowLane, triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES'] }])[0]).toMatchObject({ kind: 'CHANGE_MODEL_ROUTING' });
    expect(decideLaneActions([{ ...lowLane, triedRemedies: ['EVIDENCE_SOURCES'] }])[0]).toMatchObject({ kind: 'CHANGE_QUESTION_DESIGN' });
    expect(decideLaneActions([{ ...lowLane, triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES', 'MODEL_ROUTING'] }])[0]).toMatchObject({ kind: 'REMEDIES_EXHAUSTED', limitRaiseAllowed: true });
  });

  it('a lane with healthy actionability, too few claims or unmeasured claims gets no remedy', () => {
    expect(decideLaneActions([{ ...lowLane, actionableLinks: 50 }])).toEqual([]);
    expect(decideLaneActions([{ ...lowLane, claims: 5, actionableLinks: 0 }])).toEqual([]);
    expect(decideLaneActions([{ ...lowLane, claims: null }])).toEqual([]);
  });

  it('no capacity for a low-actionability lane whose remedies are untried, even under a measured constraint', () => {
    const [c] = decideCapacity([bottleneck()], [lowLane]);
    expect(c).toMatchObject({ kind: 'NO_CAPACITY', units: 0 });
    expect(c!.reason).toMatch(/question design/);
    const [after] = decideCapacity([bottleneck()], [{ ...lowLane, triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES', 'MODEL_ROUTING'] }]);
    expect(after).toMatchObject({ kind: 'ADD_CAPACITY' });
  });

  it('adds capacity for a measured constraint with qualified queued work, within quota, naming bottleneck and cost', () => {
    const [c] = decideCapacity([bottleneck()]);
    expect(c).toMatchObject({ kind: 'ADD_CAPACITY', resource: 'GPU', units: 3, incrementalCost: 6 });
    expect(c!.reason).toMatch(/GPU/);
    expect(c!.reason).toMatch(/incremental cost 6/);
  });

  it('refuses capacity without qualified waiting work, a measured limit, or a long enough wait', () => {
    for (const over of [{ qualifiedQueued: 0 }, { qualifiedQueued: null }, { measuredMachineLimit: false }, { resource: null }, { queueWaitMs: 60_000 }, { queueWaitMs: null }]) {
      expect(decideCapacity([bottleneck(over)])[0]).toMatchObject({ kind: 'NO_CAPACITY', units: 0 });
    }
  });

  it('refuses capacity past quota, below real reliability, on another worker\'s capacity, or at unknown cost', () => {
    const cases: [Partial<BottleneckMeasurement>, RegExp][] = [
      [{ quotaHeadroom: 0 }, /quota/],
      [{ quotaHeadroom: null }, /quota/],
      [{ reliability: 0.5 }, /reliability/],
      [{ reliability: null }, /reliability/],
      [{ ownedByAnotherWorker: true }, /another worker/],
      [{ incrementalCostPerUnit: null }, /incremental cost/],
    ];
    for (const [over, why] of cases) {
      const [c] = decideCapacity([bottleneck(over)]);
      expect(c).toMatchObject({ kind: 'NO_CAPACITY' });
      expect(c!.reason).toMatch(why);
    }
  });

  it('decideResearchAllocation carries lane actions and capacity decisions with the shares', () => {
    const d = decideResearchAllocation({ currentShares: equal, purposes: measured(), lanes: [lowLane], bottlenecks: [bottleneck()], urgentCommercialGoal: true });
    expect(d.laneActions[0]?.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(d.capacity[0]?.kind).toBe('NO_CAPACITY');
  });
});

/*
 * Cost attribution and per-lane windows have one implementation, the
 * production reading's (`summarizeResearchYield`, fed per window by
 * `researchYieldByPurpose`); the decision module keeps no second one. These
 * are the same cases, read through it: a job is a `YieldJob`, its accepted
 * claims and actionable links are its outputs, and a window is the set of jobs
 * the reader selected for it.
 */
describe('cost counted once and per-lane yield per window', () => {
  const at = (iso: string) => Date.parse(iso);
  const job = (over: Partial<YieldJob> & { id: string; lane: string; startMs: number }): YieldJob => ({
    purposes: ['BROAD_DISCOVERY'], basis: [], durationMs: 1_000, queueWaitMs: null, outcome: 'IN_FLIGHT', failureCause: null, rateLimited: false, costMinor: null, ...over,
  });
  const jobs: YieldJob[] = [
    job({ id: 'j1', lane: 'a', purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'], costMinor: 9, startMs: at('2026-11-01T00:00:00Z'), outcome: 'COMPLETED' }),
    // The same job read twice is one job.
    job({ id: 'j1', lane: 'a', purposes: ['BROAD_DISCOVERY'], costMinor: 9, startMs: at('2026-11-01T00:00:00Z') }),
    job({ id: 'j2', lane: 'b', purposes: ['SELF_IMPROVEMENT'], costMinor: 3, startMs: at('2026-11-02T00:00:00Z') }),
    job({ id: 'j3', lane: 'a', purposes: ['OPERATING_SUPPORT'], costMinor: 6, startMs: at('2026-11-09T00:00:00Z'), outcome: 'COMPLETED' }),
  ];
  const outputs: YieldOutput[] = [
    ...['c1', 'c2', 'c3', 'c4'].map((id): YieldOutput => ({ kind: 'ACCEPTED_CLAIM', id, lane: 'a', purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'], source: 'SECONDARY' })),
    { kind: 'QUALIFIED_POSITION', id: 'q1', lane: 'a', purposes: ['TRANSACTION_ROUTES'] },
  ];
  const nextOutputs: YieldOutput[] = [
    { kind: 'EXECUTABLE_OFFER', id: 'x1', lane: 'a', purposes: ['OPERATING_SUPPORT'] },
    { kind: 'PAID_TRANSACTION', id: 'p1', lane: 'a', purposes: ['OPERATING_SUPPORT'] },
  ];
  const week = { since: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z' };
  const nextWeek = { since: '2026-11-08T00:00:00Z', until: '2026-11-15T00:00:00Z' };
  /** The jobs a reader selects for a window: those that ran inside it. */
  const inWindow = (w: { since: string; until: string }) => jobs.filter((j) => j.startMs >= at(w.since) && j.startMs < at(w.until));

  it('a job serving several purposes has its cost counted once', () => {
    const all = summarizeResearchYield({ since: week.since, until: nextWeek.until, jobs, outputs: [...outputs, ...nextOutputs] });
    expect(all.total.costMinor).toBe(18);
    expect(all.costCountedOnce).toMatchObject({ jobs: 3, totalCostMinor: 18, purposeCostMinor: 18, holds: true });
    const sum = RESEARCH_PURPOSES.reduce((s, p) => s + (all.purposes[p].costMinor ?? 0), 0);
    expect(sum).toBeCloseTo(18, 9);
    expect(all.purposes.BROAD_DISCOVERY.costMinor).toBeCloseTo(3, 9);
    expect(all.purposes.TRANSACTION_ROUTES.submissions).toBe(1);
  });

  it('per-lane yield is read over a consistent window', () => {
    const first = summarizeResearchYield({ ...week, jobs: inWindow(week), outputs });
    expect(Object.keys(first.lanes).sort()).toEqual(['a', 'b']);
    expect(first.lanes.a).toMatchObject({ submissions: 1, completions: 1, acceptedClaims: 4, qualifiedPositions: 1, usefulResults: 1, costMinor: 9, costMinorPerUsefulResult: 9 });
    expect(first.lanes.b).toMatchObject({ submissions: 1, completions: 0, acceptedClaims: 0, qualifiedPositions: 0, usefulResults: 0, costMinor: 3, costMinorPerUsefulResult: null });
    const next = summarizeResearchYield({ ...nextWeek, jobs: inWindow(nextWeek), outputs: nextOutputs });
    expect(Object.keys(next.lanes)).toEqual(['a']);
    expect(next.lanes.a).toMatchObject({ submissions: 1, completions: 1, acceptedClaims: 0, qualifiedPositions: 0, usefulResults: 2, costMinor: 6, costMinorPerUsefulResult: 3 });
  });
});

describe('one definition of the purposes and of cost attribution', () => {
  it('the decision uses the instrumentation’s purposes, not a copy', () => {
    expect(RESEARCH_PURPOSES).toBe(YIELD_PURPOSES);
  });

  it('researchAllocation.ts defines no purpose list, cost attribution or per-lane window of its own', () => {
    const source = readFileSync('server/services/goals/researchAllocation.ts', 'utf8');
    expect(source).not.toMatch(/export const RESEARCH_PURPOSES\s*=\s*\[/);
    expect(source).not.toMatch(/export type ResearchPurpose\s*=/);
    expect(source).not.toMatch(/function attributeJobCosts|function laneYieldForWindow|interface ResearchJobRecord/);
    expect(source).toMatch(/from '\.\/researchYield\.ts'/);
  });
});
