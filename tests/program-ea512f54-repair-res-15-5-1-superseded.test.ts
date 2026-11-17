/**
 * RES-15-5 repair, finding F1: the probe reads the newest 50
 * RESEARCH_ALLOCATION_DECIDED rows, which are append-only history. A decision
 * that failed the counted-once check stayed in that window after a repair, and
 * the allocation pass did not even record the next decision that held when it
 * decided the same shares — the fingerprint ignored whether it was held, so a
 * held-for-cost row (observed shares) and the holding decision after it read
 * as one decision. These tests pin both: the holding decision is recorded,
 * and the probe judges the decisions in force while reporting the superseded one.
 */
import { describe, expect, it } from 'vitest';
import { summarizeResearchYield, type PurposeKey, type ResearchYieldReading, type YieldJob } from '../server/services/goals/researchYield.ts';
import { allocationFingerprint, reallocateResearch, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';
import type { GoalView } from '../server/services/goals/model.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;

function job(id: string, purposes: PurposeKey[]): YieldJob {
  return { id, lane: 'free-lane:m', purposes, basis: ['b'], startMs: T0 + 1000, durationMs: 60_000, queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null };
}

/** An even window: every purpose the same yield, so the decision keeps the observed shares. */
function evenReading(): ResearchYieldReading {
  const purposes: PurposeKey[] = ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'OPERATING_SUPPORT', 'SELF_IMPROVEMENT', 'FORWARD_EXPLORATION'];
  const jobs = purposes.flatMap((p) => Array.from({ length: 10 }, (_, i) => job(`${p}${i}`, [p])));
  return summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs: [] });
}

function ports(read: () => ResearchYieldReading) {
  const rows: Record<string, unknown>[] = [];
  const p: ResearchAllocationPorts = {
    readYield: async () => read(),
    appliedRemedies: async () => [],
    lastDecision: async () => (rows.length ? { detail: rows.at(-1)!, at: UNTIL } : null),
    recordDecision: async (_s, detail) => { rows.push(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>); },
  };
  return { p, rows };
}

const measured = (over: Record<string, unknown> = {}) => ({ fingerprint: 'f', held: false, changes: [], costCountedOnce: { holds: true }, ...over });

describe('the holding decision after a failed counted-once window is recorded', () => {
  it('a held decision and an unheld one with the same shares have different fingerprints', () => {
    const d = { shares: { BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.2, OPERATING_SUPPORT: 0.2, SELF_IMPROVEMENT: 0.2, FORWARD_EXPLORATION: 0.2 }, laneActions: [], capacity: [], changes: [], notes: [], held: false } as never;
    expect(allocationFingerprint({ ...(d as object), held: true } as never)).not.toBe(allocationFingerprint(d));
  });

  it('records a new row when the cost reading recovers, even when the shares do not move', async () => {
    let failing = true;
    const { p, rows } = ports(() => {
      const r = evenReading();
      return failing ? { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } } : r;
    });
    await reallocateResearch({ goals: [goal], now: UNTIL }, p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.heldForCost).toBe(true);
    failing = false;
    const report = await reallocateResearch({ goals: [goal], now: new Date(Date.parse(UNTIL) + 3_600_000).toISOString() }, p);
    expect(report.recorded).toBe(true);
    expect(rows).toHaveLength(2);
    expect((rows[1]!.costCountedOnce as { holds: unknown }).holds).toBe(true);
    // Read the way the probe reads production: newest first.
    expect(yieldAllocationHolds([...rows].reverse() as never).ok).not.toBe(false);
    // And it fails again the moment a newer window double counts.
    failing = true;
    await reallocateResearch({ goals: [goal], now: new Date(Date.parse(UNTIL) + 7_200_000).toISOString() }, p);
    expect(rows).toHaveLength(3);
    expect(yieldAllocationHolds([...rows].reverse() as never).ok).toBe(false);
  });
});

describe('probe r01.res-15-5 judges the decisions in force and reports superseded history', () => {
  const bad = measured({ fingerprint: 'old', costCountedOnce: { holds: false } });
  const moved = measured({ fingerprint: 'new', changes: [{ purpose: 'TRANSACTION_ROUTES', reasons: ['yield'] }] });

  it('fails when the newest measured decision does not hold, whatever is older', () => {
    expect(yieldAllocationHolds([bad, moved, moved]).ok).toBe(false);
    expect(yieldAllocationHolds([{ held: true }, bad, moved]).ok).toBe(false);
    expect(yieldAllocationHolds([measured({ changes: [{ purpose: 'X', reasons: [] }] }), moved]).ok).toBe(false);
  });

  it('passes on newer holding decisions and names the superseded failure', () => {
    const r = yieldAllocationHolds([moved, measured(), bad, moved, bad]);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/2 measured decision\(s\)/);
    expect(r.detail).toMatch(/2 older decision\(s\) that did not hold are superseded \(newest: decision old does not show its cost counted once\)/);
  });

  it('is unknown, not passing, when no decision in force has moved a share yet', () => {
    const r = yieldAllocationHolds([measured(), bad]);
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/superseded/);
  });

  it('keeps every other answer it gave before', () => {
    expect(yieldAllocationHolds([]).ok).toBeNull();
    expect(yieldAllocationHolds([{ held: true }]).ok).toBeNull();
    expect(yieldAllocationHolds([moved]).ok).toBe(true);
  });
});
