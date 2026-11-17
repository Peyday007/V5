/**
 * RES-15-5 repair, episode 2 (review finding F1: an unconsumed diagnostic
 * re-read past windows on every pass). The counted-once audit of earlier
 * decision rows is now read only on a pass that writes a row, a failing
 * window's job rows are re-read once and carried on the row rather than read
 * again every hour, and the audit is shown where research decisions are shown
 * (the goals briefing), so what it costs has a reader.
 */
import { describe, expect, it } from 'vitest';
import { carriedRereads, priorWindowsToReread, reallocateResearch, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { JobTimeInputs, ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { GoalView } from '../server/services/goals/model.ts';
import { researchBriefingFrom } from '../server/services/goals/briefing.ts';

const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const OLD_FP = JSON.stringify({ shares: [0.037, 0.2, 0.03, 0.577, 0.156], lanes: ['bin:claude-routine:MEASURING_REMEDY'], capacity: [] });
const LEGACY_WINDOW = { since: at(T0 - 90_000_000), until: at(T0 - HOUR) };
const LEGACY_KEY = `${LEGACY_WINDOW.since}|${LEGACY_WINDOW.until}`;
const ALL_UNMEASURED: JobTimeInputs = {
  jobs: 12, measured: 0, zeroMeasured: 0, unmeasured: 12, issues: { NO_DURATION: 12 },
  examples: [{ jobId: 'lane:ev_1', issue: 'NO_DURATION' }], maxMeasuredMs: null,
};
const stored = (detail: Record<string, unknown>) => JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;

/** A failing row written before job inputs were recorded: equal zero sums, so only its job rows can show why. */
const legacy = { at: at(T0 - 4_000), detail: stored({ fingerprint: OLD_FP, held: false, window: LEGACY_WINDOW, costCountedOnce: { jobs: 12, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: false } }) };

const bucket = (over: Partial<YieldBucket> = {}): YieldBucket => ({
  submissions: 0, completions: 0, inFlight: 0,
  failures: { total: 0, rateLimited: 0, other: 0, causes: [] },
  queueWait: { measured: 0, medianMs: null, p90Ms: null },
  acceptedClaims: 0, sourceQuality: { primary: 0, secondary: 0, unretrieved: 0, primaryShare: null },
  packetsFiled: 0, newMechanisms: 0, qualifiedPositions: 0, executableOffers: 0, paidTransactions: 0, usefulResults: 0,
  jobMs: 0, costMinor: null, uncostedJobs: 0, msPerUsefulResult: null, costMinorPerUsefulResult: null, utilization: 0,
  ...over,
});
const reading = (w: { since: string; until: string }): ResearchYieldReading => ({
  window: { since: w.since, until: w.until, ms: Date.parse(w.until) - Date.parse(w.since) },
  total: bucket({ submissions: 30, completions: 30, usefulResults: 6, jobMs: 3_600_000 }),
  lanes: { 'free-lane:m': bucket({ submissions: 30, completions: 30, jobMs: 3_600_000 }) },
  purposes: Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket({ submissions: 5, completions: 5, usefulResults: 1, jobMs: 600_000 })])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>,
  costCountedOnce: { jobs: 30, totalJobMs: 3_600_000, purposeJobMs: 3_600_000, totalCostMinor: null, purposeCostMinor: null, holds: true, jobTimeInputs: { jobs: 30, measured: 30, zeroMeasured: 0, unmeasured: 0, issues: {}, examples: [], maxMeasuredMs: 120_000 } },
  attributions: [],
  notes: [],
});
const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as unknown as GoalView;

function fakePorts() {
  const rows: { at: string; detail: Record<string, unknown> }[] = [legacy];
  const windowsRead: string[] = [];
  let historyReads = 0;
  let clock = '';
  const ports: ResearchAllocationPorts = {
    readYield: async (w) => {
      windowsRead.push(`${w.since}|${w.until}`);
      return w.since === LEGACY_WINDOW.since && w.until === LEGACY_WINDOW.until
        ? { ...reading(w), costCountedOnce: { ...reading(w).costCountedOnce, jobTimeInputs: ALL_UNMEASURED } }
        : reading(w);
    },
    appliedRemedies: async () => [],
    lastDecision: async () => rows[0] ?? null,
    recentDecisions: async (limit) => {
      historyReads += 1;
      return rows.slice(0, limit);
    },
    recordDecision: async (_s, detail) => {
      rows.unshift({ at: clock, detail: stored(detail) });
    },
  };
  const pass = async (ms: number) => {
    clock = at(ms);
    windowsRead.length = 0;
    const before = historyReads;
    const report = await reallocateResearch({ goals: [goal], now: at(ms) }, ports);
    return { report, windowsRead: [...windowsRead], historyRead: historyReads > before };
  };
  return { rows, pass };
}

describe('the counted-once audit costs a read only when a row is written, and a window is re-read once', () => {
  it('re-reads a legacy failing window on the first recorded pass only; hourly passes that record nothing read no history', async () => {
    const { rows, pass } = fakePorts();

    const first = await pass(T0 + HOUR);
    expect(first.report.recorded).toBe(true);
    expect(first.historyRead).toBe(true);
    expect(first.windowsRead.filter((k) => k === LEGACY_KEY)).toHaveLength(1);
    const audit1 = rows[0]!.detail.priorCostFailures as { reread: Record<string, unknown>; earliest: { shownByJobs: string } };
    expect(Object.keys(audit1.reread)).toEqual([LEGACY_KEY]);
    expect(audit1.earliest.shownByJobs).toBe('ALL_JOBS_UNMEASURED');

    // Same window, nothing changed: no row, so no history read and no past window re-read — only its own window.
    for (const h of [2, 3, 4]) {
      const quiet = await pass(T0 + h * HOUR);
      expect(quiet.report.recorded).toBe(false);
      expect(quiet.historyRead).toBe(false);
      expect(quiet.windowsRead).toHaveLength(1);
      expect(quiet.windowsRead).not.toContain(LEGACY_KEY);
    }
    expect(rows).toHaveLength(2);

    // The next window records again: the legacy window's inputs are carried from the newest row, never re-read.
    const next = await pass(T0 + 25 * HOUR);
    expect(next.report.recorded).toBe(true);
    expect(next.historyRead).toBe(true);
    expect(next.windowsRead).not.toContain(LEGACY_KEY);
    const audit2 = rows[0]!.detail.priorCostFailures as { reread: Record<string, JobTimeInputs>; failing: number; earliest: { shownByJobs: string; jobInputs: { source: string } } };
    expect(audit2.failing).toBe(1);
    expect(audit2.earliest.shownByJobs).toBe('ALL_JOBS_UNMEASURED');
    expect(audit2.earliest.jobInputs.source).toBe('REREAD');
    expect(audit2.reread[LEGACY_KEY]).toMatchObject({ jobs: 12, unmeasured: 12 });
  });

  it('carries only well-formed inputs and skips windows already read', () => {
    const carried = carriedRereads({ priorCostFailures: { reread: { [LEGACY_KEY]: ALL_UNMEASURED, broken: { jobs: 'x' } } } });
    expect([...carried.keys()]).toEqual([LEGACY_KEY]);
    expect(carriedRereads(null).size).toBe(0);
    expect(priorWindowsToReread([legacy])).toEqual([{ key: LEGACY_KEY, ...LEGACY_WINDOW }]);
    expect(priorWindowsToReread([legacy], 6, new Set([LEGACY_KEY]))).toEqual([]);
  });

  it('the briefing shows what the audit found, where research decisions are shown', async () => {
    const { rows, pass } = fakePorts();
    await pass(T0 + HOUR);
    const r = researchBriefingFrom(rows[0]!.detail, rows[0]!.at)!;
    expect(r.costCountedOnce).toEqual({ holds: true, earlierFailures: 1, earliestCause: 'ALL_JOBS_UNMEASURED', earliestAt: legacy.at });
    expect(r.line).toContain('1 earlier decision(s) did not show cost counted once (earliest: all jobs unmeasured)');
    // A row with no audit reads as none, and its line says nothing about it.
    const plain = researchBriefingFrom({ ...rows[0]!.detail, priorCostFailures: undefined }, null)!;
    expect(plain.costCountedOnce.earlierFailures).toBe(0);
    expect(plain.line).not.toContain('earlier decision');
  });
});
