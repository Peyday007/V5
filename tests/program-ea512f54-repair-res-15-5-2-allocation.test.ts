/**
 * RES-15-5 repair, episode 2: the research allocation records one decision row
 * per measured allocation window, not only when the decision's fingerprint
 * changes. Recording only on change left measured windows with no row of their
 * own, so the newest measured row could be days old and a failed counted-once
 * row stayed among the newest the probe reads. These tests drive
 * `reallocateResearch` with fake ports and judge the rows with the owner's
 * probe (`yieldAllocationHolds`, read-only).
 */
import { describe, expect, it } from 'vitest';
import {
  allocationWindowKey,
  reallocateResearch,
  recordedWindowKey,
  RESEARCH_ALLOCATION_WINDOW_MS,
  type AppliedRemedy,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { LaneCapacityReading, ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';

const DAY = RESEARCH_ALLOCATION_WINDOW_MS;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-14T00:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
const LANE = 'free-lane:m';

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

/** A measured, reallocating window: TRANSACTION_ROUTES yields far more per hour than BROAD_DISCOVERY; the lane is all claims, few links. */
function measuredReading(opts: { rateLimited?: number; linkRich?: boolean } = {}): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  purposes.BROAD_DISCOVERY = bucket({ submissions: 60, completions: 60, usefulResults: 1, jobMs: 10_800_000 });
  purposes.SELF_IMPROVEMENT = bucket({ submissions: 10, completions: 10, usefulResults: 2, jobMs: 1_800_000 });
  purposes.OPERATING_SUPPORT = bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 900_000 });
  purposes.FORWARD_EXPLORATION = bucket({ submissions: 5, completions: 5, usefulResults: 0, jobMs: 900_000 });
  const rl = opts.rateLimited ?? 0;
  return {
    window: { since: at(T0 - DAY), until: at(T0), ms: DAY },
    total: bucket({ submissions: 100, completions: 100, usefulResults: 16, jobMs: 18_000_000 }),
    lanes: {
      [LANE]: opts.linkRich
        ? bucket({ submissions: 60, completions: 54, acceptedClaims: 40, qualifiedPositions: 20, executableOffers: 10, jobMs: 10_800_000, failures: { total: rl, rateLimited: rl, other: 0, causes: [] } })
        : bucket({ submissions: 60, completions: 50, acceptedClaims: 400, qualifiedPositions: 2, jobMs: 10_800_000, failures: { total: rl, rateLimited: rl, other: 0, causes: [] } }),
    },
    purposes,
    costCountedOnce: { jobs: 100, totalJobMs: 18_000_000, purposeJobMs: 18_000_000, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [{ jobId: 'job_1', lane: LANE, purposes: ['BROAD_DISCOVERY'], basis: ['discovery bucket'] }],
    notes: [],
  };
}

/** Nothing ran in the window. */
function emptyReading(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  return {
    window: { since: at(T0 - DAY), until: at(T0), ms: DAY },
    total: bucket(),
    lanes: {},
    purposes,
    costCountedOnce: { jobs: 0, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [],
    notes: [],
  };
}

function doubleCounted(r: ResearchYieldReading): ResearchYieldReading {
  return { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } };
}

function fakePorts(read: () => ResearchYieldReading, extra: Partial<ResearchAllocationPorts> = {}) {
  const rows: Record<string, unknown>[] = [];
  const p: ResearchAllocationPorts = {
    readYield: async () => read(),
    appliedRemedies: async () => [],
    lastDecision: async () => (rows.length ? { detail: rows.at(-1)!, at: at(T0) } : null),
    recordDecision: async (_s, detail) => { rows.push(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>); },
    ...extra,
  };
  return { p, rows, newestFirst: () => [...rows].reverse() };
}

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as unknown as GoalView;

describe('one decision row per measured allocation window', () => {
  it('names the window a moment belongs to, and reads it back from a row', () => {
    expect(allocationWindowKey(at(T0 + 5 * HOUR))).toBe(at(T0));
    expect(allocationWindowKey(at(T0 + DAY - 1))).toBe(at(T0));
    expect(allocationWindowKey(at(T0 + DAY))).toBe(at(T0 + DAY));
    expect(allocationWindowKey('nonsense')).toBeNull();
    expect(recordedWindowKey({ window: { until: at(T0 + 3 * HOUR) } })).toBe(at(T0));
    expect(recordedWindowKey({ windowKey: 'k' })).toBe('k');
    expect(recordedWindowKey(null)).toBeNull();
  });

  it('records each measured window once, even when the decision repeats, and never twice in one window', async () => {
    const { p, rows, newestFirst } = fakePorts(() => measuredReading());
    const first = await reallocateResearch({ goals: [goal], now: at(T0) }, p);
    expect(first.recorded).toBe(true);
    // A second pass in the same window, same decision: no row.
    const again = await reallocateResearch({ goals: [goal], now: at(T0 + 3 * HOUR) }, p);
    expect(again.recorded).toBe(false);
    expect(again.changed).toBe(false);
    expect(rows).toHaveLength(1);
    // The next two windows each get their row although nothing changed.
    for (const day of [1, 2]) {
      const r = await reallocateResearch({ goals: [goal], now: at(T0 + day * DAY + HOUR) }, p);
      expect(r.recorded).toBe(true);
      expect(r.changed).toBe(false);
    }
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.windowKey)).size).toBe(3);
    for (const row of rows) {
      expect(row.held).toBe(false);
      expect(row.heldForCost).toBe(false);
      expect((row.costCountedOnce as { holds: unknown }).holds).toBe(true);
      const changes = row.changes as { reasons: unknown[] }[];
      expect(changes.length).toBeGreaterThan(0);
      for (const c of changes) expect(c.reasons.length).toBeGreaterThan(0);
    }
    // The owner's probe judges these rows, newest first, as it reads production.
    expect(yieldAllocationHolds(newestFirst() as never).ok).toBe(true);
  });

  it('keeps held-for-nothing-measured passes recorded as held, once, not one per window', async () => {
    const { p, rows, newestFirst } = fakePorts(() => emptyReading());
    for (const day of [0, 1, 2]) await reallocateResearch({ goals: [goal], now: at(T0 + day * DAY) }, p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.held).toBe(true);
    expect(yieldAllocationHolds(newestFirst() as never).ok).toBeNull();
  });

  it('a window that fails counted-once is held for cost with its cause and moves nothing; the recovered window is recorded the pass it is measured', async () => {
    let failing = true;
    const { p, rows, newestFirst } = fakePorts(() => (failing ? doubleCounted(measuredReading()) : measuredReading()));
    await reallocateResearch({ goals: [goal], now: at(T0) }, p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.heldForCost).toBe(true);
    expect(rows[0]!.held).toBe(false);
    expect(rows[0]!.changes).toEqual([]);
    const once = rows[0]!.costCountedOnce as { holds: unknown; cause: unknown };
    expect(once.holds).toBe(false);
    expect(typeof once.cause).toBe('string');
    expect(once.cause).not.toBe('HOLDS');
    // The same failing window again: no second row.
    await reallocateResearch({ goals: [goal], now: at(T0 + HOUR) }, p);
    expect(rows).toHaveLength(1);
    // Recovered inside the same window: recorded at once.
    failing = false;
    const recovered = await reallocateResearch({ goals: [goal], now: at(T0 + 2 * HOUR) }, p);
    expect(recovered.recorded).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.heldForCost).toBe(false);
    expect((rows[1]!.costCountedOnce as { holds: unknown }).holds).toBe(true);
    // Append-only: the failed row is still there and the probe still sees it.
    expect(yieldAllocationHolds(newestFirst() as never).ok).toBe(false);
    expect(yieldAllocationHolds([rows[1]] as never).ok).toBe(true);
  });

  it('never allows a limit raise before a remedy was applied and measured, and walks remedies in order', async () => {
    const applied: AppliedRemedy[] = [];
    const { p, rows } = fakePorts(() => measuredReading(), {
      appliedRemedies: async () => applied,
      applyRemedy: async ({ lane, remedy, ref }) => { applied.push({ lane, remedy, ref, appliedAt: at(T0) }); },
    });
    const r = await reallocateResearch({ goals: [goal], now: at(T0) }, p);
    const lane = r.laneActions.find((a) => a.lane === LANE)!;
    expect(lane.kind).toBe('CHANGE_QUESTION_DESIGN');
    expect(lane.limitRaiseAllowed).toBe(false);
    for (const row of rows) {
      for (const a of row.laneActions as { limitRaiseAllowed: boolean }[]) expect(a.limitRaiseAllowed).toBe(false);
    }
  });

  it('adds capacity only on a measured machine limit with qualified work queued', async () => {
    const cap: LaneCapacityReading = { lane: LANE, queued: 7, queueWaitMs: 2 * HOUR, quotaHeadroom: 3, incrementalCostPerUnit: 0, basis: ['test'] };
    const limited = fakePorts(() => measuredReading({ rateLimited: 6, linkRich: true }), { readLaneCapacity: async () => [cap] });
    const a = await reallocateResearch({ goals: [goal], now: at(T0) }, limited.p);
    expect(a.capacity.find((c) => c.lane === LANE)?.kind).toBe('ADD_CAPACITY');
    expect((limited.rows[0]!.capacity as { kind: string; reason: string }[]).find((c) => c.kind === 'ADD_CAPACITY')?.reason).toMatch(/measured MODEL_RATE_LIMIT/);
    // A low-actionability lane on the same measured limit gets its remedy first, not capacity.
    const linkPoor = fakePorts(() => measuredReading({ rateLimited: 6 }), { readLaneCapacity: async () => [cap] });
    const lp = await reallocateResearch({ goals: [goal], now: at(T0) }, linkPoor.p);
    expect(lp.capacity.find((c) => c.lane === LANE)?.kind).toBe('NO_CAPACITY');
    expect(lp.laneActions.find((x) => x.lane === LANE)?.kind).toBe('CHANGE_QUESTION_DESIGN');
    // No measured limit: no capacity added, whatever is queued.
    const unlimited = fakePorts(() => measuredReading({ linkRich: true }), { readLaneCapacity: async () => [cap] });
    const b = await reallocateResearch({ goals: [goal], now: at(T0) }, unlimited.p);
    expect(b.capacity.find((c) => c.lane === LANE)?.kind).not.toBe('ADD_CAPACITY');
    // A measured limit but nothing queued: none either.
    const empty = fakePorts(() => measuredReading({ rateLimited: 6, linkRich: true }), { readLaneCapacity: async () => [{ ...cap, queued: 0, queueWaitMs: null }] });
    const c = await reallocateResearch({ goals: [goal], now: at(T0) }, empty.p);
    expect(c.capacity.find((one) => one.lane === LANE)?.kind).not.toBe('ADD_CAPACITY');
    // Unmeasured capacity: none.
    const unmeasured = fakePorts(() => measuredReading({ rateLimited: 6, linkRich: true }));
    const d = await reallocateResearch({ goals: [goal], now: at(T0) }, unmeasured.p);
    expect(d.capacity.find((one) => one.lane === LANE)?.kind).not.toBe('ADD_CAPACITY');
  });
});
