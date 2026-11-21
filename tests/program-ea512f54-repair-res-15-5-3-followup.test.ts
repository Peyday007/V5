/**
 * RES-15-5 repair, episode 3, finding F1. The failing counted-once row on
 * production was written by an earlier recorder, and history is never edited
 * (§5), so it leaves the 50 rows probe r01.res-15-5 judges only as newer
 * decision rows are written. At one row per daily window that took up to fifty
 * days. While a failure is still in that window, a holding measured pass is
 * now recorded once per hourly cadence (`failureFollowUp`), decided from the
 * newest row's carried audit, so the probe reads the running recorder within
 * about fifty hours, and the extra rows stop by themselves once the failure has
 * left.
 */
import { describe, expect, it } from 'vitest';
import { summarizeResearchYield, type ResearchYieldReading } from '../server/services/goals/researchYield.ts';
import {
  ALLOCATION_AUDIT_ROWS,
  RECORDED_AFTER_FAILURE,
  RESEARCH_ALLOCATION_EVERY_MS,
  failureFollowUp,
  probeWindowStanding,
  reallocateResearch,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';
import type { GoalView } from '../server/services/goals/model.ts';

const HOUR = RESEARCH_ALLOCATION_EVERY_MS;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-17T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** The pre-F1 row the probe failed on in production: no leading `held`, cost not shown counted once. */
const legacyRow = {
  fingerprint: JSON.stringify({ shares: [0.033, 0.2, 0.03, 0.577, 0.161], lanes: ['free-lane:auto:MEASURING_REMEDY'], capacity: [] }),
  held: false,
  shares: { BROAD_DISCOVERY: 0.033, TRANSACTION_ROUTES: 0.2, OPERATING_SUPPORT: 0.03, SELF_IMPROVEMENT: 0.577, FORWARD_EXPLORATION: 0.161 },
  changes: [],
  costCountedOnce: { holds: false, totalJobMs: null, purposeJobMs: null },
};

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;

/** A steady measured reading: the same jobs whatever the window, so the decision repeats. */
function steady(until: string): ResearchYieldReading {
  const untilMs = Date.parse(until);
  const since = untilMs - DAY;
  const purposes = [['SELF_IMPROVEMENT'], ['BROAD_DISCOVERY', 'FORWARD_EXPLORATION'], ['TRANSACTION_ROUTES', 'OPERATING_SUPPORT']] as const;
  return summarizeResearchYield({
    since: iso(since),
    until,
    jobs: Array.from({ length: 30 }, (_, i) => ({
      id: `j${i}`, lane: 'free-lane:auto', purposes: [...purposes[i % 3]!], basis: ['row'], startMs: since + i * 60_000, durationMs: 10_000 + i * 17,
      queueWaitMs: 1_000, outcome: 'COMPLETED' as const, failureCause: null, rateLimited: false, costMinor: null,
    })),
    outputs: Array.from({ length: 30 }, (_, i) => ({ kind: 'ACCEPTED_CLAIM' as const, id: `c${i}`, lane: 'free-lane:auto', purposes: [...purposes[i % 3]!], source: 'PRIMARY' })),
  });
}

function ports() {
  const rows: { detail: Record<string, unknown>; at: string }[] = [{ detail: legacyRow, at: iso(START - HOUR) }];
  let clock = START;
  let historyReads = 0;
  const p: ResearchAllocationPorts = {
    readYield: async (w) => steady(w.until),
    appliedRemedies: async () => [],
    lastDecision: async () => rows.at(-1) ?? null,
    recentDecisions: async (limit) => { historyReads += 1; return [...rows].reverse().slice(0, limit); },
    recordDecision: async (_s, detail) => { rows.push({ detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>, at: iso(clock) }); },
  };
  const pass = async (ms: number) => {
    clock = ms;
    const before = historyReads;
    const report = await reallocateResearch({ goals: [goal], now: iso(ms) }, p);
    return { report, historyRead: historyReads > before };
  };
  const probe = () => yieldAllocationHolds([...rows].reverse().slice(0, ALLOCATION_AUDIT_ROWS).map((r) => r.detail));
  return { rows, pass, probe };
}

describe('RES-15-5 F1: a legacy counted-once failure leaves the probe window in hours, not weeks', () => {
  it('records each hourly holding pass while the failure is in the window, until the probe stops failing, without touching history', async () => {
    const { rows, pass, probe } = ports();
    expect(probe().ok).toBe(false);
    let hours = 0;
    while (probe().ok === false && hours < 60 * 24) {
      await pass(START + hours * HOUR);
      hours += 1;
    }
    // About one row an hour against a fifty-row window: about fifty hours, never fifty days.
    expect(probe().ok).not.toBe(false);
    expect(hours).toBeLessThanOrEqual(ALLOCATION_AUDIT_ROWS + 1);
    const written = rows.slice(1).map((r) => r.detail);
    for (const d of written) expect((d.costCountedOnce as { holds: unknown }).holds).toBe(true);
    expect(written.filter((d) => d.recordedBecause === RECORDED_AFTER_FAILURE).length).toBeGreaterThan(ALLOCATION_AUDIT_ROWS / 2);
    // Append-only: the failing row is still there, unchanged, only no longer among the newest fifty.
    expect(rows[0]!.detail).toEqual(legacyRow);
    expect(probeWindowStanding([...rows].reverse()).newestFailingIndex).toBeNull();

    // Once clear, the ordinary rule is back: an unchanged decision in a recorded window writes nothing and reads nothing.
    const lastUntil = Date.parse((rows.at(-1)!.detail.window as { until: string }).until);
    const before = rows.length;
    for (const h of [1, 2, 3]) {
      const later = lastUntil + h * HOUR;
      if (Math.floor(later / DAY) !== Math.floor(lastUntil / DAY)) break;
      const r = await pass(later);
      expect(r.report.recorded).toBe(false);
      expect(r.historyRead).toBe(false);
    }
    expect(rows.length).toBe(before);
  });

  it('writes at most one follow-up row per hour of reading time, and a pass that writes nothing reads no history', async () => {
    const { rows, pass } = ports();
    await pass(START);
    const after = rows.length;
    for (const m of [1, 10, 30, 59]) {
      const r = await pass(START + m * 60_000);
      expect(r.report.recorded).toBe(false);
      expect(r.historyRead).toBe(false);
    }
    expect(rows.length).toBe(after);
    const r = await pass(START + HOUR);
    expect(r.report.recorded).toBe(true);
    expect(rows.at(-1)!.detail.recordedBecause).toBe(RECORDED_AFTER_FAILURE);
  });

  it('reads the newest row alone: no audit, no failure left in the window, or too soon means no follow-up', () => {
    const row = (newestFailingIndex: number | null, until = iso(START)) => ({ detail: { window: { until }, priorCostFailures: { standing: { newestFailingIndex } } } });
    expect(failureFollowUp(row(0), iso(START + HOUR))).toBe(true);
    expect(failureFollowUp(row(ALLOCATION_AUDIT_ROWS - 2), iso(START + HOUR))).toBe(true);
    // The newest row pushed the failing one back a place: at the window's edge it has left.
    expect(failureFollowUp(row(ALLOCATION_AUDIT_ROWS - 1), iso(START + HOUR))).toBe(false);
    expect(failureFollowUp(row(null), iso(START + HOUR))).toBe(false);
    expect(failureFollowUp(row(0), iso(START + HOUR - 1))).toBe(false);
    expect(failureFollowUp({ detail: { window: { until: iso(START) } } }, iso(START + HOUR))).toBe(false);
    expect(failureFollowUp(null, iso(START + HOUR))).toBe(false);
  });
});
