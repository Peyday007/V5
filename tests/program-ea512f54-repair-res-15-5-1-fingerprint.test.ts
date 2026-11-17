/**
 * RES-15-5 repair, finding F1: a decision is recorded only when its fingerprint
 * changes, and the fingerprint left out whether the window's cost was shown
 * counted once. A pass whose reading recovered — same shares, lanes and
 * capacity as the row held for cost before it — was therefore never recorded,
 * and the failing row stayed the newest decision the probe reads. The verdict
 * is now part of what makes two decisions the same.
 */
import { describe, expect, it } from 'vitest';
import { summarizeResearchYield, type PurposeKey, type ResearchYieldReading, type YieldJob } from '../server/services/goals/researchYield.ts';
import { allocationFingerprint, reallocateResearch, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, type AllocationDecision } from '../server/services/goals/researchAllocation.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';
import type { GoalView } from '../server/services/goals/model.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);

const goal = (id: string): GoalView => ({ id, projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null }) as GoalView;

function job(id: string, purposes: PurposeKey[]): YieldJob {
  return { id, lane: 'free-lane:m', purposes, basis: ['b'], startMs: T0 + 1000, durationMs: 60_000, queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null };
}

function reading(): ResearchYieldReading {
  const jobs: YieldJob[] = [];
  for (let i = 0; i < 40; i++) jobs.push(job(`tr${i}`, ['TRANSACTION_ROUTES']));
  for (let i = 0; i < 120; i++) jobs.push(job(`bd${i}`, ['BROAD_DISCOVERY']));
  for (let i = 0; i < 20; i++) jobs.push(job(`si${i}`, ['SELF_IMPROVEMENT', 'OPERATING_SUPPORT']));
  const outputs = Array.from({ length: 12 }, (_, i) => ({ kind: 'PACKET_FILED' as const, id: `p${i}`, lane: 'free-lane:m', purposes: ['TRANSACTION_ROUTES'] as PurposeKey[] }));
  return summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs });
}

const doubled = (): ResearchYieldReading => {
  const r = reading();
  return { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } };
};

function memoryPorts(read: () => ResearchYieldReading) {
  const decisions: Record<string, unknown>[] = [];
  const ports: ResearchAllocationPorts = {
    readYield: async () => read(),
    appliedRemedies: async () => [],
    lastDecision: async () => (decisions.length ? { detail: decisions.at(-1)!, at: UNTIL } : null),
    recordDecision: async (_s, detail) => {
      decisions.push(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>);
    },
  };
  return { ports, decisions };
}

describe('the allocation fingerprint carries the cost-counted-once verdict (finding F1)', () => {
  it('two decisions identical but for the verdict have different fingerprints', () => {
    const decision = {
      shares: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, 0.2])),
      laneActions: [],
      capacity: [],
      changes: [],
      notes: [],
      held: false,
    } as unknown as AllocationDecision;
    expect(allocationFingerprint(decision, { holds: true })).not.toBe(allocationFingerprint(decision, { holds: false }));
    expect(allocationFingerprint(decision, { holds: true })).toBe(allocationFingerprint(decision, { holds: true }));
  });

  it('a recovered reading is recorded at once, and the newest decision holds, even when nothing else differs', async () => {
    let bad = true;
    const { ports, decisions } = memoryPorts(() => (bad ? doubled() : reading()));
    await reallocateResearch({ goals: [goal('wst_a')], now: UNTIL }, ports);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.heldForCost).toBe(true);
    // The held row's shares are the observed ones; make the recovered pass decide exactly those,
    // so the only difference between the two decisions is the verdict.
    const held = decisions[0]!;
    const sameShares = { ...ports, lastDecision: async () => ({ detail: { ...held, fingerprint: allocationFingerprint(sharesOf(held), { holds: false }) }, at: UNTIL }) };
    expect(allocationFingerprint(sharesOf(held), { holds: false })).not.toBe(allocationFingerprint(sharesOf(held), { holds: true }));
    bad = false;
    const report = await reallocateResearch({ goals: [goal('wst_a')], now: new Date(Date.parse(UNTIL) + 3_600_000).toISOString() }, sameShares);
    expect(report.recorded).toBe(true);
    const newest = decisions.at(-1)!;
    expect((newest.costCountedOnce as { holds: unknown }).holds).toBe(true);
    expect(yieldAllocationHolds([newest] as never).ok).not.toBe(false);
    // The failing row is still in the history, unedited (append-only).
    expect(decisions[0]!.heldForCost).toBe(true);
  });

  it('an unchanged decision with an unchanged verdict is still not recorded twice', async () => {
    const { ports, decisions } = memoryPorts(reading);
    await reallocateResearch({ goals: [goal('wst_a')], now: UNTIL }, ports);
    const again = await reallocateResearch({ goals: [goal('wst_a')], now: UNTIL }, ports);
    expect(again.recorded).toBe(false);
    expect(decisions).toHaveLength(1);
  });
});

function sharesOf(detail: Record<string, unknown>): AllocationDecision {
  const s = detail.shares as Record<string, number>;
  const lanes = (detail.laneActions as { lane: string; kind: string }[]) ?? [];
  const capacity = (detail.capacity as { lane: string; kind: string; units: number }[]) ?? [];
  return { shares: s, laneActions: lanes, capacity, changes: [], notes: [], held: false } as unknown as AllocationDecision;
}
