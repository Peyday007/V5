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
import * as allocation from '../server/services/goals/researchAllocation.ts';
import * as yieldReader from '../server/services/goals/researchYield.ts';
import { summarizeResearchYield, type YieldJob, type YieldOutput } from '../server/services/goals/researchYield.ts';

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
    // A change applied inside the window is measured before anything escalates, and allows no limit raise.
    expect(decideLaneActions([{ ...lowLane, measuringRemedy: 'QUESTION_DESIGN' }])[0]).toMatchObject({ kind: 'MEASURING_REMEDY', remedy: 'QUESTION_DESIGN', limitRaiseAllowed: false });
    expect(decideLaneActions([{ ...lowLane, triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES'], measuringRemedy: 'MODEL_ROUTING' }])[0]).toMatchObject({ kind: 'MEASURING_REMEDY', limitRaiseAllowed: false });
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

describe('cost counted once and per-lane yield per window', () => {
  // The one production reader, `summarizeResearchYield`; the allocation module keeps no second one.
  const H = 3_600_000;
  const job = (over: Partial<YieldJob> & Pick<YieldJob, 'id' | 'lane' | 'purposes' | 'startMs'>): YieldJob => ({
    basis: [], durationMs: H, queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over,
  });
  const week1 = { since: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z' };
  const week2 = { since: '2026-11-08T00:00:00Z', until: '2026-11-15T00:00:00Z' };
  const t = (iso: string) => Date.parse(iso);
  const week1Jobs: YieldJob[] = [
    job({ id: 'j1', lane: 'a', purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'], startMs: t('2026-11-01T00:00:00Z'), costMinor: 9 }),
    // The same job read twice is still one job.
    job({ id: 'j1', lane: 'a', purposes: ['BROAD_DISCOVERY'], startMs: t('2026-11-01T00:00:00Z'), costMinor: 9 }),
    job({ id: 'j2', lane: 'b', purposes: ['SELF_IMPROVEMENT'], startMs: t('2026-11-02T00:00:00Z'), outcome: 'IN_FLIGHT', costMinor: 3 }),
  ];
  const week1Outputs: YieldOutput[] = [
    ...[1, 2, 3, 4].map((n) => ({ kind: 'ACCEPTED_CLAIM' as const, id: `c${n}`, lane: 'a', purposes: ['BROAD_DISCOVERY' as const], source: 'PRIMARY' as const })),
    { kind: 'PACKET_FILED', id: 'p1', lane: 'a', purposes: ['TRANSACTION_ROUTES'] },
  ];

  it('a job serving several purposes has its cost counted once', () => {
    const r = summarizeResearchYield({ ...week1, jobs: week1Jobs, outputs: week1Outputs });
    expect(r.costCountedOnce.jobs).toBe(2);
    expect(r.total.costMinor).toBe(12);
    const sum = RESEARCH_PURPOSES.reduce((s, p) => s + (r.purposes[p].costMinor ?? 0), 0);
    expect(sum).toBeCloseTo(12, 9);
    expect(r.costCountedOnce.holds).toBe(true);
    expect(r.purposes.BROAD_DISCOVERY.costMinor).toBeCloseTo(3, 9);
    expect(r.purposes.TRANSACTION_ROUTES.submissions).toBe(1);
  });

  it('per-lane yield is read over a consistent window', () => {
    const r1 = summarizeResearchYield({ ...week1, jobs: week1Jobs, outputs: week1Outputs });
    expect(r1.window.ms).toBe(7 * 24 * H);
    expect(Object.keys(r1.lanes).sort()).toEqual(['a', 'b']);
    expect(r1.lanes.a).toMatchObject({ submissions: 1, completions: 1, acceptedClaims: 4, usefulResults: 1, costMinor: 9, costMinorPerUsefulResult: 9 });
    expect(r1.lanes.b).toMatchObject({ submissions: 1, completions: 0, inFlight: 1, usefulResults: 0, costMinor: 3, costMinorPerUsefulResult: null });
    const r2 = summarizeResearchYield({
      ...week2,
      jobs: [job({ id: 'j3', lane: 'a', purposes: ['OPERATING_SUPPORT'], startMs: t('2026-11-09T00:00:00Z'), durationMs: 2 * H, costMinor: 5 })],
      outputs: [{ kind: 'EXECUTABLE_OFFER', id: 'o1', lane: 'a', purposes: ['OPERATING_SUPPORT'] }, { kind: 'PAID_TRANSACTION', id: 't1', lane: 'a', purposes: ['OPERATING_SUPPORT'] }],
    });
    expect(r2.window.ms).toBe(r1.window.ms);
    expect(Object.keys(r2.lanes)).toEqual(['a']);
    expect(r2.lanes.a).toMatchObject({ submissions: 1, completions: 1, acceptedClaims: 0, usefulResults: 2, costMinor: 5, costMinorPerUsefulResult: 3 });
  });
});

describe('the purposes and the window measurement have one definition each', () => {
  it('researchYield uses the allocation module\'s purposes, not a copy', () => {
    expect(yieldReader.RESEARCH_PURPOSES).toBe(allocation.RESEARCH_PURPOSES);
  });

  it('the allocation module carries no second cost-attribution or per-lane window reader', () => {
    for (const name of ['attributeJobCosts', 'laneYieldForWindow']) expect(Object.keys(allocation)).not.toContain(name);
  });
});
