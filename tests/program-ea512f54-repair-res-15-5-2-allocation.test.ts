/**
 * RES-15-5 repair, episode 2: the allocation pass recorded a decision row only
 * when the decision's fingerprint changed, so a steady decision left the newest
 * row on production days old — its window, counted-once record and per-lane
 * capacity stale — and a failed window was never followed by the windows
 * measured after it. Now every measured window is recorded exactly once
 * (`allocationWindowKey`), a second pass in the same window records nothing,
 * and a window with nothing measured is still recorded as held, only when that
 * changes the decision on record. The fingerprint still says whether the
 * decision moved (`changed`).
 *
 * The rows are judged with the owner's probe check, imported read-only.
 */
import { describe, expect, it } from 'vitest';
import {
  allocationWindowKey,
  allocationWindowKeyOf,
  reallocateResearch,
  RESEARCH_ALLOCATION_EVERY_MS,
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
import type { ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';

const UNTIL = '2026-11-17T00:00:00.000Z';
const hourAfter = (h: number, minutes = 0) => new Date(Date.parse(UNTIL) + h * 3_600_000 + minutes * 60_000).toISOString();

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

/** A measured window whose yield is uneven, so the decision moves share; cost counted once unless told otherwise. */
function skewed(holds = true): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  purposes.BROAD_DISCOVERY = bucket({ submissions: 60, completions: 60, usefulResults: 1, jobMs: 10_800_000 });
  purposes.SELF_IMPROVEMENT = bucket({ submissions: 10, completions: 10, usefulResults: 2, jobMs: 1_800_000 });
  purposes.OPERATING_SUPPORT = bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 900_000 });
  purposes.FORWARD_EXPLORATION = bucket({ submissions: 5, completions: 5, usefulResults: 0, jobMs: 900_000 });
  return {
    window: { since: '2026-11-16T00:00:00.000Z', until: UNTIL, ms: 86_400_000 },
    total: bucket({ submissions: 100, completions: 100, usefulResults: 16, jobMs: 18_000_000 }),
    lanes: {
      'free-lane:m': bucket({ submissions: 60, completions: 50, acceptedClaims: 400, qualifiedPositions: 2, jobMs: 10_800_000, failures: { total: 10, rateLimited: 10, other: 0, causes: [] }, inFlight: 30, queueWait: { measured: 30, medianMs: 40 * 60_000, p90Ms: 60 * 60_000 } }),
    },
    purposes,
    costCountedOnce: { jobs: 100, totalJobMs: 18_000_000, purposeJobMs: holds ? 18_000_000 : 36_000_000, totalCostMinor: null, purposeCostMinor: null, holds },
    attributions: [{ jobId: 'job_1', lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: ['discovery bucket'] }],
    notes: [],
  };
}

/** A window with nothing measured: every purpose held. */
function empty(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  return {
    window: { since: '2026-11-16T00:00:00.000Z', until: UNTIL, ms: 86_400_000 },
    total: bucket(),
    lanes: {},
    purposes,
    costCountedOnce: { jobs: 0, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [],
    notes: [],
  };
}

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;

/** In-memory ports; `rows` is the append-only decision log in the order written, stored as production stores it (JSON). */
function ports(read: () => ResearchYieldReading) {
  const rows: Record<string, unknown>[] = [];
  const p: ResearchAllocationPorts = {
    readYield: async () => read(),
    appliedRemedies: async () => [] as AppliedRemedy[],
    lastDecision: async () => (rows.length ? { detail: rows.at(-1)!, at: UNTIL } : null),
    recordDecision: async (_s, detail) => { rows.push(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>); },
  };
  return { p, rows };
}

/** The probe reads newest first. */
const probe = (rows: Record<string, unknown>[]) => yieldAllocationHolds([...rows].reverse() as never);

describe('one decision row per measured allocation window', () => {
  it('records each measured window once, even when the decision does not change', async () => {
    const { p, rows } = ports(() => skewed());
    const reports = [];
    for (let h = 0; h < 4; h += 1) reports.push(await reallocateResearch({ goals: [goal], now: hourAfter(h) }, p));
    expect(rows).toHaveLength(4);
    expect(reports.every((r) => r.recorded)).toBe(true);
    // The fingerprint still says whether the decision moved.
    expect(reports[0]!.changed).toBe(true);
    expect(new Set(rows.map((r) => r.windowKey)).size).toBe(4);
    for (const [i, r] of rows.entries()) {
      expect(r.windowKey).toBe(allocationWindowKey(Date.parse(hourAfter(i))));
      expect((r.window as { until: string }).until).toBe(hourAfter(i));
      // Each row carries its window's per-lane capacity and counted-once record.
      expect(Array.isArray(r.laneCapacity) && (r.laneCapacity as unknown[]).length).toBe(1);
      expect((r.costCountedOnce as { holds: unknown }).holds).toBe(true);
    }
  });

  it('never records twice for the same window: a second pass in the window records none', async () => {
    const { p, rows } = ports(() => skewed());
    const first = await reallocateResearch({ goals: [goal], now: hourAfter(0, 5) }, p);
    const again = await reallocateResearch({ goals: [goal], now: hourAfter(0, 40) }, p);
    expect(first.recorded).toBe(true);
    expect(again.recorded).toBe(false);
    expect(again.changed).toBe(false);
    expect(rows).toHaveLength(1);
    // The next window is recorded.
    expect((await reallocateResearch({ goals: [goal], now: hourAfter(1, 5) }, p)).recorded).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('a window with nothing measured stays recorded as held, and only when that changes the decision', async () => {
    const { p, rows } = ports(empty);
    for (let h = 0; h < 3; h += 1) await reallocateResearch({ goals: [goal], now: hourAfter(h) }, p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.held).toBe(true);
    expect(rows[0]!.heldForCost).toBe(false);
    expect(probe(rows).ok).toBeNull();
  });

  it('a measured window that counts cost once holds; one that does not is held for cost with its cause and moves no share', async () => {
    let holds = true;
    const { p, rows } = ports(() => skewed(holds));
    await reallocateResearch({ goals: [goal], now: hourAfter(0) }, p);
    expect((rows[0]!.costCountedOnce as { holds: unknown }).holds).toBe(true);
    expect(rows[0]!.heldForCost).toBe(false);
    holds = false;
    const failed = await reallocateResearch({ goals: [goal], now: hourAfter(1) }, p);
    expect(failed.recorded).toBe(true);
    const bad = rows[1]!;
    expect(bad.heldForCost).toBe(true);
    expect(bad.held).toBe(false);
    expect(bad.changes).toEqual([]);
    const once = bad.costCountedOnce as { holds: unknown; cause: unknown };
    expect(once.holds).toBe(false);
    expect(typeof once.cause).toBe('string');
    expect(once.cause).not.toBe('');
    // The shares in force are kept, never moved by the failing reading.
    expect(bad.shares).toEqual(rows[0]!.shares);
    // The recovered window is recorded as soon as it is measured.
    holds = true;
    expect((await reallocateResearch({ goals: [goal], now: hourAfter(2) }, p)).recorded).toBe(true);
    expect((rows[2]!.costCountedOnce as { holds: unknown }).holds).toBe(true);
  });

  it('the rows of measured, reallocating windows are what the owner probe judges PASS', async () => {
    const { p, rows } = ports(() => skewed());
    for (let h = 0; h < 3; h += 1) await reallocateResearch({ goals: [goal], now: hourAfter(h) }, p);
    expect(rows.every((r) => r.held === false && r.heldForCost === false)).toBe(true);
    expect(rows.some((r) => Array.isArray(r.changes) && (r.changes as unknown[]).length > 0)).toBe(true);
    for (const r of rows) for (const c of r.changes as { reasons: unknown[] }[]) expect(c.reasons.length).toBeGreaterThan(0);
    expect(probe(rows).ok).toBe(true);
  });

  it('a failed window is followed on record by the measured windows after it', async () => {
    let n = 0;
    const { p, rows } = ports(() => skewed(++n !== 1));
    for (let h = 0; h < 51; h += 1) await reallocateResearch({ goals: [goal], now: hourAfter(h) }, p);
    expect(rows).toHaveLength(51);
    expect(rows[0]!.heldForCost).toBe(true);
    // While the failed row is among the newest 50 the probe fails on it ...
    expect(probe(rows.slice(0, 50)).ok).toBe(false);
    // ... and once 50 later windows are recorded it has left them by normal operation.
    expect(probe(rows.slice(-50)).ok).toBe(true);
  });

  it('reads the window slot of a recorded row, including a row written before windowKey existed', () => {
    expect(allocationWindowKeyOf(null)).toBeNull();
    expect(allocationWindowKeyOf({ windowKey: 7 })).toBe(7);
    expect(allocationWindowKeyOf({ window: { until: UNTIL } })).toBe(Math.floor(Date.parse(UNTIL) / RESEARCH_ALLOCATION_EVERY_MS));
    expect(allocationWindowKeyOf({ window: { until: 'not a time' } })).toBeNull();
  });
});

describe('remedies before limits, capacity only to a measured constraint (researchAllocation.ts)', () => {
  const low: LaneMeasurement = { lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], claims: 400, actionableLinks: 2 };

  it('a low-actionability lane gets a question-design, evidence-source or routing change before any limit raise', () => {
    const order: string[] = [];
    const tried: LaneMeasurement['triedRemedies'] = [];
    for (;;) {
      const [action] = decideLaneActions([{ ...low, triedRemedies: [...tried] }]);
      if (!action) throw new Error('a low-actionability lane got no action');
      if (action.limitRaiseAllowed) break;
      expect(['CHANGE_QUESTION_DESIGN', 'CHANGE_EVIDENCE_SOURCES', 'CHANGE_MODEL_ROUTING']).toContain(action.kind);
      order.push(action.kind);
      tried.push(action.remedy!);
    }
    expect(order).toEqual(['CHANGE_QUESTION_DESIGN', 'CHANGE_EVIDENCE_SOURCES', 'CHANGE_MODEL_ROUTING']);
    // A change applied inside the window is measured before anything escalates.
    const [measuring] = decideLaneActions([{ ...low, measuringRemedy: 'QUESTION_DESIGN' }]);
    expect(measuring!.kind).toBe('MEASURING_REMEDY');
    expect(measuring!.limitRaiseAllowed).toBe(false);
  });

  it('adds capacity only for a measured machine limit with qualified work waiting', () => {
    const constrained: BottleneckMeasurement = {
      lane: 'claude:x', purposes: ['TRANSACTION_ROUTES'], resource: 'MODEL_RATE_LIMIT', qualifiedQueued: 6, queueWaitMs: 40 * 60_000,
      measuredMachineLimit: true, quotaHeadroom: 3, reliability: 0.95, ownedByAnotherWorker: false, incrementalCostPerUnit: 0,
    };
    expect(decideCapacity([constrained])[0]!.kind).toBe('ADD_CAPACITY');
    expect(decideCapacity([{ ...constrained, qualifiedQueued: 0 }])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([{ ...constrained, qualifiedQueued: null }])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([{ ...constrained, measuredMachineLimit: false }])[0]!.kind).toBe('NO_CAPACITY');
    expect(decideCapacity([{ ...constrained, queueWaitMs: 60_000 }])[0]!.kind).toBe('NO_CAPACITY');
    // A low-actionability lane is remedied before it gets capacity.
    expect(decideCapacity([{ ...constrained, lane: low.lane }], [low])[0]!.kind).toBe('NO_CAPACITY');
  });

  it('every share change carries a measured reason', () => {
    const d = decideResearchAllocation({
      currentShares: { BROAD_DISCOVERY: 0.6, TRANSACTION_ROUTES: 0.2, OPERATING_SUPPORT: 0.05, SELF_IMPROVEMENT: 0.1, FORWARD_EXPLORATION: 0.05 },
      purposes: [
        { purpose: 'BROAD_DISCOVERY', usefulResults: 1, cost: 10_800_000 },
        { purpose: 'TRANSACTION_ROUTES', usefulResults: 12, cost: 3_600_000 },
        { purpose: 'OPERATING_SUPPORT', usefulResults: 1, cost: 900_000 },
        { purpose: 'SELF_IMPROVEMENT', usefulResults: 2, cost: 1_800_000 },
        { purpose: 'FORWARD_EXPLORATION', usefulResults: 0, cost: 900_000 },
      ],
      urgentCommercialGoal: false,
    });
    expect(d.changes.length).toBeGreaterThan(0);
    for (const c of d.changes) expect(c.reasons.length).toBeGreaterThan(0);
  });
});
