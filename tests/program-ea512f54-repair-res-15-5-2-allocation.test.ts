/**
 * RES-15-5 repair, episode 2: the allocation pass recorded a decision row only
 * when its fingerprint changed, so a steady decision (every lane MEASURING_REMEDY,
 * the same capacity verdicts) left no row for days. The newest row on production
 * stayed an old one and a failed counted-once window never left the probe's
 * window. Each measured allocation window is now recorded exactly once; the
 * fingerprint still says whether the decision changed. These tests drive
 * `reallocateResearch` with fake ports and judge the rows with the owner's
 * probe check (`yieldAllocationHolds`, read-only).
 */
import { describe, expect, it } from 'vitest';
import {
  RESEARCH_ALLOCATION_EVERY_MS,
  allocationWindowKey,
  allocationWindowKeyOf,
  reallocateResearch,
  type AppliedRemedy,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import {
  RESEARCH_PURPOSES,
  decideCapacity,
  decideLaneActions,
  decideResearchAllocation,
  type BottleneckMeasurement,
  type LaneMeasurement,
  type ResearchPurpose,
} from '../server/services/goals/researchAllocation.ts';
import type { LaneCapacityReading, ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';

const T0 = '2026-11-14T00:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

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

/** A window whose yield differs by purpose, so the decision moves shares; the free lane is claims-heavy and link-poor. */
function reading(over: Partial<ResearchYieldReading> = {}): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  purposes.BROAD_DISCOVERY = bucket({ submissions: 60, completions: 60, usefulResults: 1, jobMs: 10_800_000 });
  purposes.SELF_IMPROVEMENT = bucket({ submissions: 10, completions: 10, usefulResults: 2, jobMs: 1_800_000 });
  purposes.OPERATING_SUPPORT = bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 900_000 });
  purposes.FORWARD_EXPLORATION = bucket({ submissions: 5, completions: 5, usefulResults: 0, jobMs: 900_000 });
  return {
    window: { since: '2026-11-13T00:00:00.000Z', until: T0, ms: 86_400_000 },
    total: bucket({ submissions: 100, completions: 100, usefulResults: 16, jobMs: 18_000_000 }),
    lanes: {
      'free-lane:m': bucket({ submissions: 60, completions: 50, acceptedClaims: 400, qualifiedPositions: 2, jobMs: 10_800_000, failures: { total: 10, rateLimited: 10, other: 0, causes: [] }, inFlight: 30, queueWait: { measured: 30, medianMs: 40 * 60_000, p90Ms: 60 * 60_000 } }),
    },
    purposes,
    costCountedOnce: { jobs: 100, totalJobMs: 18_000_000, purposeJobMs: 18_000_000, totalCostMinor: null, purposeCostMinor: null, unmeasuredJobs: 0, holds: true },
    attributions: [{ jobId: 'job_1', lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: ['discovery bucket'] }],
    notes: [],
    ...over,
  } as ResearchYieldReading;
}

const empty = (): ResearchYieldReading => {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  return reading({ total: bucket(), lanes: {}, purposes, attributions: [], costCountedOnce: { jobs: 0, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, unmeasuredJobs: 0, holds: true } as ResearchYieldReading['costCountedOnce'] });
};

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;

function memoryPorts(read: () => ResearchYieldReading, capacity: LaneCapacityReading[] = []) {
  const rows: Record<string, unknown>[] = [];
  const applied: AppliedRemedy[] = [];
  const ports: ResearchAllocationPorts = {
    readYield: async () => read(),
    readLaneCapacity: async () => capacity,
    appliedRemedies: async () => [...applied],
    lastDecision: async () => (rows.length ? { detail: rows.at(-1)!, at: T0 } : null),
    recordDecision: async (_s, detail) => { rows.push(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>); },
  };
  return { ports, rows, applied };
}

/** Newest first, the way the probe reads production. */
const probe = (rows: Record<string, unknown>[]) => yieldAllocationHolds([...rows].reverse() as never);

describe('one decision row per measured allocation window', () => {
  it('records every measured window once, even when the decision does not change', async () => {
    const { ports, rows } = memoryPorts(() => reading());
    const reports = [];
    for (let h = 0; h < 4; h += 1) reports.push(await reallocateResearch({ goals: [goal], now: at(h) }, ports));
    expect(rows).toHaveLength(4);
    expect(reports.map((r) => r.recorded)).toEqual([true, true, true, true]);
    // The fingerprint still says whether the decision itself changed.
    expect(reports[0]!.changed).toBe(true);
    expect(reports.slice(1).every((r) => r.changed === false)).toBe(true);
    expect(new Set(rows.map((r) => r.windowKey)).size).toBe(4);
    expect(rows.map((r) => (r.window as { until: string }).until)).toEqual([at(0), at(1), at(2), at(3)]);
  });

  it('never records twice for the same window', async () => {
    const { ports, rows } = memoryPorts(() => reading());
    await reallocateResearch({ goals: [goal], now: at(0) }, ports);
    const again = await reallocateResearch({ goals: [goal], now: new Date(Date.parse(at(0)) + 10 * 60_000).toISOString() }, ports);
    expect(again.recorded).toBe(false);
    expect(rows).toHaveLength(1);
    // Even a decision that differs inside the same window is not a second row for it.
    const { ports: p2, rows: r2 } = memoryPorts((() => { let n = 0; return () => (n++ === 0 ? reading() : empty()); })());
    await reallocateResearch({ goals: [goal], now: at(0) }, p2);
    const changed = await reallocateResearch({ goals: [goal], now: at(0) }, p2);
    expect(changed.changed).toBe(true);
    expect(changed.recorded).toBe(false);
    expect(r2).toHaveLength(1);
  });

  it('reads the window of a row written before windowKey existed from its window', () => {
    expect(allocationWindowKeyOf({ window: { until: at(5) } })).toBe(allocationWindowKey(Date.parse(at(5))));
    expect(allocationWindowKeyOf({ windowKey: 7 })).toBe(7);
    expect(allocationWindowKeyOf({})).toBeNull();
    expect(allocationWindowKeyOf(null)).toBeNull();
    expect(allocationWindowKey(Date.parse(at(1))) - allocationWindowKey(Date.parse(at(0)))).toBe(3_600_000 / RESEARCH_ALLOCATION_EVERY_MS);
  });

  it('keeps passes with nothing measured recorded as held, once, not a row an hour', async () => {
    const { ports, rows } = memoryPorts(() => empty());
    for (let h = 0; h < 3; h += 1) await reallocateResearch({ goals: [goal], now: at(h) }, ports);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.held).toBe(true);
    expect(rows[0]!.heldForCost).toBe(false);
    expect(probe(rows).ok).toBeNull();
  });
});

describe('cost counted once on every recorded window', () => {
  it('a holding window records holds true, not held for cost, and the probe judges it PASS', async () => {
    const { ports, rows } = memoryPorts(() => reading());
    await reallocateResearch({ goals: [goal], now: at(0) }, ports);
    const row = rows[0]!;
    expect((row.costCountedOnce as { holds: unknown }).holds).toBe(true);
    expect(row.heldForCost).toBe(false);
    expect(row.held).toBe(false);
    const changes = row.changes as { reasons: string[] }[];
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => Array.isArray(c.reasons) && c.reasons.length > 0)).toBe(true);
    expect(probe(rows).ok).toBe(true);
  });

  it('a double-counting window is held for cost with its diagnosed cause and moves no share; later windows are still recorded', async () => {
    let failing = true;
    const { ports, rows } = memoryPorts(() => {
      const r = reading();
      return failing ? { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } } : r;
    });
    await reallocateResearch({ goals: [goal], now: at(0) }, ports);
    await reallocateResearch({ goals: [goal], now: at(1) }, ports);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.heldForCost).toBe(true);
      expect(row.changes).toEqual([]);
      const once = row.costCountedOnce as { holds: unknown; cause: unknown };
      expect(once.holds).toBe(false);
      expect(typeof once.cause).toBe('string');
      expect(String(once.cause)).not.toBe('');
    }
    expect(probe(rows).ok).toBe(false);
    failing = false;
    const recovered = await reallocateResearch({ goals: [goal], now: at(2) }, ports);
    expect(recovered.recorded).toBe(true);
    expect(rows).toHaveLength(3);
    expect((rows[2]!.costCountedOnce as { holds: unknown }).holds).toBe(true);
    // A failing window leaves the probe's newest-50 window as later measured windows are recorded.
    for (let h = 3; h < 3 + 50; h += 1) await reallocateResearch({ goals: [goal], now: at(h) }, ports);
    expect(probe(rows.slice(-50)).ok).toBe(true);
  });
});

describe('lane remedies and capacity (researchAllocation, read-only)', () => {
  const lane = (over: Partial<LaneMeasurement> = {}): LaneMeasurement => ({ lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], claims: 400, actionableLinks: 2, triedRemedies: [], measuringRemedy: null, ...over });
  const neck = (over: Partial<BottleneckMeasurement> = {}): BottleneckMeasurement => ({
    lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], resource: 'MODEL_RATE_LIMIT', qualifiedQueued: 5, queueWaitMs: 60 * 60_000,
    measuredMachineLimit: true, quotaHeadroom: 4, reliability: 0.95, ownedByAnotherWorker: false, incrementalCostPerUnit: 0, ...over,
  });

  it('changes question design, then sources, then routing before any limit raise', () => {
    expect(decideLaneActions([lane()])[0]).toMatchObject({ kind: 'CHANGE_QUESTION_DESIGN', limitRaiseAllowed: false });
    expect(decideLaneActions([lane({ triedRemedies: ['QUESTION_DESIGN'] })])[0]).toMatchObject({ kind: 'CHANGE_EVIDENCE_SOURCES', limitRaiseAllowed: false });
    expect(decideLaneActions([lane({ triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES'] })])[0]).toMatchObject({ kind: 'CHANGE_MODEL_ROUTING', limitRaiseAllowed: false });
    expect(decideLaneActions([lane({ triedRemedies: ['QUESTION_DESIGN'], measuringRemedy: 'EVIDENCE_SOURCES' })])[0]).toMatchObject({ kind: 'MEASURING_REMEDY', limitRaiseAllowed: false });
    expect(decideLaneActions([lane({ triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES', 'MODEL_ROUTING'] })])[0]).toMatchObject({ kind: 'REMEDIES_EXHAUSTED', limitRaiseAllowed: true });
  });

  it('adds capacity only for a measured machine limit with qualified work waiting, after the remedies', () => {
    const done = lane({ triedRemedies: ['QUESTION_DESIGN', 'EVIDENCE_SOURCES', 'MODEL_ROUTING'] });
    expect(decideCapacity([neck()], [done])[0]!.kind).toBe('ADD_CAPACITY');
    expect(decideCapacity([neck()], [lane()])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([neck({ qualifiedQueued: 0 })], [done])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([neck({ qualifiedQueued: null })], [done])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([neck({ measuredMachineLimit: false, resource: null })], [done])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([neck({ queueWaitMs: 1000 })], [done])[0]!.kind).toBe('NO_CAPACITY');
  });

  it('every share change carries a measured reason', () => {
    const r = reading();
    const decision = decideResearchAllocation({
      currentShares: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, r.purposes[p].jobMs])),
      purposes: RESEARCH_PURPOSES.map((p) => ({ purpose: p, usefulResults: r.purposes[p].usefulResults, cost: r.purposes[p].jobMs })),
      urgentCommercialGoal: false,
    });
    expect(decision.changes.length).toBeGreaterThan(0);
    expect(decision.changes.every((c) => c.reasons.length > 0)).toBe(true);
  });

  it('the recorded rows keep laneActions and capacity verdicts per window', async () => {
    const { ports, rows } = memoryPorts(() => reading(), [{ lane: 'free-lane:m', queued: 5, queueWaitMs: 60 * 60_000, quotaHeadroom: 4, incrementalCostPerUnit: 0, basis: ['measured'] } as LaneCapacityReading]);
    await reallocateResearch({ goals: [goal], now: at(0) }, ports);
    await reallocateResearch({ goals: [goal], now: at(1) }, ports);
    for (const row of rows) {
      const actions = row.laneActions as { limitRaiseAllowed: boolean }[];
      expect(actions.every((a) => a.limitRaiseAllowed === false)).toBe(true);
      const cap = row.capacity as { kind: string }[];
      expect(cap.every((c) => c.kind === 'NO_CAPACITY')).toBe(true);
    }
  });
});
