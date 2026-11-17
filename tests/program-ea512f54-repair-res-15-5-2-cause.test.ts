/**
 * RES-15-5 repair, episode 2 (review finding: earliest cause unproven). The
 * production failures of probe r01.res-15-5 are decision rows written by older
 * recorders, and their cause was asserted rather than shown. Each allocation
 * pass now diagnoses every measured row the probe reads that does not show its
 * cost counted once, from that row's own recorded numbers, and records the
 * diagnosis — earliest first — on its own decision row, so the cause is read
 * from production records, not argued.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_AUDIT_ROWS,
  diagnosePriorCostFailures,
  reallocateResearch,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { JobTimeInputs, ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';

const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
const OLD_FP = JSON.stringify({ shares: [0.037, 0.2, 0.03, 0.577, 0.156], lanes: ['bin:claude-routine:MEASURING_REMEDY'], capacity: [] });
const NEW_FP = JSON.stringify({ held: false, shares: [0.2, 0.2, 0.2, 0.2, 0.2], lanes: [], capacity: [] });

const ZERO_WINDOW = { since: at(T0 - 90_000_000), until: at(T0 - 3_600_000) };
const ZERO_KEY = `${ZERO_WINDOW.since}|${ZERO_WINDOW.until}`;
/** The zero-sum window's job rows, as re-read: every one of its twelve jobs gives no duration. */
const ALL_UNMEASURED: JobTimeInputs = {
  jobs: 12, measured: 0, zeroMeasured: 0, unmeasured: 12, issues: { NO_DURATION: 12 },
  examples: [1, 2, 3, 4, 5].map((n) => ({ jobId: `lane:ev_${n}`, issue: 'NO_DURATION' as const })), maxMeasuredMs: null,
};

/** A row exactly as JSON storage returns it: NaN and Infinity become null. */
const stored = (detail: Record<string, unknown>) => JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;

const rows = [
  // newest first, as the repository returns them
  { at: at(T0), detail: stored({ fingerprint: NEW_FP, held: false, costCountedOnce: { jobs: 9, totalJobMs: 100, purposeJobMs: 100, totalCostMinor: null, purposeCostMinor: null, holds: true } }) },
  { at: at(T0 - 1_000), detail: stored({ fingerprint: '{"held":true}', held: true }) },
  { at: at(T0 - 2_000), detail: stored({ fingerprint: OLD_FP, held: false, costCountedOnce: { jobs: 40, totalJobMs: 5_000, purposeJobMs: 10_000, totalCostMinor: null, purposeCostMinor: null, holds: false } }) },
  { at: at(T0 - 3_000), detail: stored({ fingerprint: OLD_FP, held: false, costCountedOnce: { jobs: 40, totalJobMs: NaN, purposeJobMs: NaN, totalCostMinor: null, purposeCostMinor: null, holds: false } }) },
  { at: at(T0 - 4_000), detail: stored({ fingerprint: OLD_FP, held: false, window: ZERO_WINDOW, costCountedOnce: { jobs: 12, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: false } }) },
  { at: at(T0 - 5_000), detail: stored({ fingerprint: OLD_FP, held: false }) },
];

describe('the cause of each recorded counted-once failure is read from the row itself', () => {
  it('diagnoses every failing measured row the probe reads, earliest first, and skips holding and held rows', () => {
    // Without the zero-sum window's job rows, its cause is not shown — never inferred from the row's shape.
    const unread = diagnosePriorCostFailures(rows);
    expect(unread.failures[1]!.cause).toBe('FLAG_DISAGREES');
    expect(unread.failures[1]!.shownByJobs).toBe('NOT_SHOWN');
    expect(unread.failures[1]!.jobInputs).toBeNull();
    expect(unread.failures[1]!.basis).toMatch(/not re-read/);
    expect(unread.causes).toEqual({ NOT_RECORDED: 1, FLAG_DISAGREES: 1, NON_FINITE_JOB_TIME: 1, DOUBLE_COUNT: 1 });
    const { failures, causes, earliest } = diagnosePriorCostFailures(rows, new Map([[ZERO_KEY, ALL_UNMEASURED]]));
    expect(failures.map((f) => f.at)).toEqual([at(T0 - 5_000), at(T0 - 4_000), at(T0 - 3_000), at(T0 - 2_000)]);
    expect(failures.map((f) => f.cause)).toEqual(['NOT_RECORDED', 'FLAG_DISAGREES', 'NON_FINITE_JOB_TIME', 'DOUBLE_COUNT']);
    // Equal zero sums over twelve jobs: the window's job rows show every job gave no duration.
    expect(failures[1]!.shownByJobs).toBe('ALL_JOBS_UNMEASURED');
    expect(failures[1]!.jobInputs).toMatchObject({ source: 'REREAD', jobs: 12, unmeasured: 12 });
    expect(failures[1]!.basis).toMatch(/lane:ev_1/);
    expect(failures.every((f) => f.recorder === 'BEFORE_HELD_IN_FINGERPRINT')).toBe(true);
    expect(failures[3]!.jobMsGap).toBe(5_000);
    expect(causes).toEqual({ NOT_RECORDED: 1, ALL_JOBS_UNMEASURED: 1, NON_FINITE_JOB_TIME: 1, DOUBLE_COUNT: 1 });
    expect(earliest!.cause).toBe('NOT_RECORDED');
    // The same rows fail the owner's probe: the diagnosis covers exactly what it judges.
    expect(yieldAllocationHolds(rows.map((r) => r.detail) as never).ok).toBe(false);
    expect(diagnosePriorCostFailures(rows.slice(0, 2)).failures).toEqual([]);
  });

  it('a pass records the diagnosis of the probe window on its own decision row', async () => {
    const recorded: Record<string, unknown>[] = [];
    let asked = 0;
    const bucket = (over: Partial<YieldBucket> = {}): YieldBucket => ({
      submissions: 0, completions: 0, inFlight: 0,
      failures: { total: 0, rateLimited: 0, other: 0, causes: [] },
      queueWait: { measured: 0, medianMs: null, p90Ms: null },
      acceptedClaims: 0, sourceQuality: { primary: 0, secondary: 0, unretrieved: 0, primaryShare: null },
      packetsFiled: 0, newMechanisms: 0, qualifiedPositions: 0, executableOffers: 0, paidTransactions: 0, usefulResults: 0,
      jobMs: 0, costMinor: null, uncostedJobs: 0, msPerUsefulResult: null, costMinorPerUsefulResult: null, utilization: 0,
      ...over,
    });
    const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 600_000 })])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
    const reading: ResearchYieldReading = {
      window: { since: at(T0 - 86_400_000), until: at(T0), ms: 86_400_000 },
      total: bucket({ submissions: 30, completions: 30, usefulResults: 6, jobMs: 3_600_000 }),
      lanes: { 'free-lane:m': bucket({ submissions: 30, completions: 30, jobMs: 3_600_000 }) },
      purposes,
      costCountedOnce: { jobs: 30, totalJobMs: 3_600_000, purposeJobMs: 3_600_000, totalCostMinor: null, purposeCostMinor: null, holds: true, jobTimeInputs: { jobs: 30, measured: 30, zeroMeasured: 0, unmeasured: 0, issues: {}, examples: [], maxMeasuredMs: 120_000 } },
      attributions: [],
      notes: [],
    };
    const windowsRead: string[] = [];
    const ports: ResearchAllocationPorts = {
      readYield: async (w) => {
        windowsRead.push(`${w.since}|${w.until}`);
        // The failing row's window re-read gives its own job rows; every other window the current reading.
        return `${w.since}|${w.until}` === ZERO_KEY ? { ...reading, costCountedOnce: { ...reading.costCountedOnce, jobTimeInputs: ALL_UNMEASURED } } : reading;
      },
      appliedRemedies: async () => [],
      lastDecision: async () => rows[0]!,
      recentDecisions: async (limit) => {
        asked = limit;
        return rows.slice(0, limit);
      },
      recordDecision: async (_s, detail) => {
        recorded.push(stored(detail));
      },
    };
    const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as unknown as GoalView;
    const report = await reallocateResearch({ goals: [goal], now: at(T0 + 3_600_000) }, ports);
    expect(report.recorded).toBe(true);
    expect(asked).toBe(ALLOCATION_AUDIT_ROWS);
    const audit = recorded[0]!.priorCostFailures as { rowsRead: number; failing: number; causes: Record<string, number>; earliest: { cause: string; at: string }; failures: { cause: string }[] };
    expect(audit.rowsRead).toBe(rows.length);
    expect(audit.failing).toBe(4);
    expect(audit.causes).toEqual({ NOT_RECORDED: 1, ALL_JOBS_UNMEASURED: 1, NON_FINITE_JOB_TIME: 1, DOUBLE_COUNT: 1 });
    // Only the failing window whose cause its numbers cannot show is re-read; the pass's own window once.
    expect(windowsRead.filter((k) => k === ZERO_KEY)).toHaveLength(1);
    // The pass's own row records its job inputs, so a later failure of it is shown from what it recorded.
    expect((recorded[0]!.costCountedOnce as { jobTimeInputs: JobTimeInputs }).jobTimeInputs).toMatchObject({ jobs: 30, measured: 30 });
    expect(audit.earliest).toMatchObject({ cause: 'NOT_RECORDED', at: at(T0 - 5_000) });
    // The pass's own row holds: the audit reports history, it does not fail the new decision.
    expect((recorded[0]!.costCountedOnce as { holds: boolean }).holds).toBe(true);
    expect(yieldAllocationHolds([recorded[0]] as never).ok).not.toBe(false);
  });
});
