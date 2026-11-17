/**
 * RES-15-5 repair, episode 2 (review finding: earliest cause inferred, not
 * shown). A failing decision row with zero sums over counted jobs was read as
 * NON_FINITE_JOB_TIME from its shape alone. The cause is now read from the
 * window's job rows: the production loader records why each unmeasured job
 * gave no run time, and `causeFromJobInputs` names the cause only those inputs
 * show — NOT_SHOWN when they do not account for the row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  MAX_READABLE_JOB_MS,
  causeFromJobInputs,
  researchYieldByPurpose,
  summarizeResearchYield,
  type YieldJob,
} from '../server/services/goals/researchYield.ts';
import { priorWindowsToReread } from '../server/services/goals/tick.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);

const job = (id: string, over: Partial<YieldJob> = {}): YieldJob => ({
  id, lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: [], startMs: T0 + 1_000, durationMs: 1_000,
  queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over,
});
const summarize = (jobs: YieldJob[]) => summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs: [] });

describe('a window records its job-time inputs and the cause they show', () => {
  it('every job without a duration: ALL_JOBS_UNMEASURED, with the job ids, and both sums 0', () => {
    const r = summarize([1, 2, 3].map((n) => job(`j${n}`, { durationMs: 0, timeMeasured: false, timeIssue: 'NO_DURATION' })));
    expect(r.costCountedOnce.totalJobMs).toBe(0);
    expect(r.costCountedOnce.jobTimeInputs).toMatchObject({ jobs: 3, measured: 0, unmeasured: 3, issues: { NO_DURATION: 3 } });
    const shown = causeFromJobInputs(r.costCountedOnce.jobTimeInputs);
    expect(shown.cause).toBe('ALL_JOBS_UNMEASURED');
    expect(shown.basis).toMatch(/j1, j2, j3/);
  });

  it('a duration beyond the readable cap or not finite: NON_FINITE_JOB_TIME, naming the job', () => {
    const r = summarize([job('big', { durationMs: MAX_READABLE_JOB_MS * 2 }), job('nan', { durationMs: Number.NaN }), job('ok')]);
    expect(r.costCountedOnce.jobTimeInputs).toMatchObject({ jobs: 3, measured: 1, issues: { OVER_CAP: 1, NON_FINITE_DURATION: 1 } });
    const shown = causeFromJobInputs(r.costCountedOnce.jobTimeInputs);
    expect(shown.cause).toBe('NON_FINITE_JOB_TIME');
    expect(shown.basis).toMatch(/big/);
    expect(shown.basis).toMatch(/nan/);
  });

  it('readable zero-time jobs: ALL_JOBS_ZERO_TIME; readable time that does not explain zero sums: NOT_SHOWN', () => {
    expect(causeFromJobInputs(summarize([job('z1', { durationMs: 0 }), job('z2', { durationMs: 0 })]).costCountedOnce.jobTimeInputs).cause).toBe('ALL_JOBS_ZERO_TIME');
    const measured = causeFromJobInputs(summarize([job('a', { durationMs: 5_000 })]).costCountedOnce.jobTimeInputs);
    expect(measured.cause).toBe('NOT_SHOWN');
    expect(measured.basis).toMatch(/do not account/);
    expect(causeFromJobInputs(null).cause).toBe('NOT_SHOWN');
    expect(causeFromJobInputs(summarize([]).costCountedOnce.jobTimeInputs).cause).toBe('NOT_SHOWN');
  });

  it('re-reads only the windows of failing rows whose own numbers cannot show the cause and that recorded no inputs, earliest first', () => {
    const w = (h: number) => ({ since: new Date(T0 + h * 3_600_000).toISOString(), until: new Date(T0 + (h + 24) * 3_600_000).toISOString() });
    const zero = { jobs: 4, totalJobMs: 0, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: false };
    const rows = [
      { at: '2026-11-17T05:00:00.000Z', detail: { held: false, window: w(5), costCountedOnce: zero } },
      { at: '2026-11-17T04:00:00.000Z', detail: { held: false, window: w(4), costCountedOnce: { ...zero, totalJobMs: 10, purposeJobMs: 20 } } },
      { at: '2026-11-17T03:00:00.000Z', detail: { held: false, window: w(3), costCountedOnce: { ...zero, jobTimeInputs: { jobs: 4 } } } },
      { at: '2026-11-17T02:00:00.000Z', detail: { held: true, window: w(2), costCountedOnce: zero } },
      { at: '2026-11-17T01:00:00.000Z', detail: { held: false, window: w(1), costCountedOnce: zero } },
      { at: '2026-11-17T00:30:00.000Z', detail: { held: false, window: w(1), costCountedOnce: zero } },
    ];
    expect(priorWindowsToReread(rows).map((one) => one.since)).toEqual([w(1).since, w(5).since]);
    expect(priorWindowsToReread(rows, 1)).toHaveLength(1);
  });
});

describe('the production loader records why each job row gave no run time', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('reads the issue from the bin_events rows themselves', async () => {
    const db = getDb();
    const ev = (id: string, type: string, at: string, extra: { bin_id?: string; ms?: number | null; outcome?: string; reason?: string } = {}) =>
      db.run(`INSERT INTO bin_events (id, event_type, at, bin_id, duration_ms, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, type, at, extra.bin_id ?? null, extra.ms ?? null, extra.outcome ?? null, extra.reason ?? null]);
    const tag = Math.random().toString(36).slice(2, 8);
    await ev(`fl1_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T10:00:00.000Z', { ms: null, outcome: 'SUBMITTED', reason: 'runpod/m' });
    await ev(`fl2_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T10:05:00.000Z', { ms: -5, outcome: 'SUBMITTED', reason: 'runpod/m' });
    await ev(`fl3_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T99:99:99.000Z', { ms: 5_000, outcome: 'SUBMITTED', reason: 'runpod/m' });
    await ev(`ba1_${tag}`, 'BIN_ASSIGNED', '2026-11-16T25:00:00.000Z', { bin_id: `bin_a_${tag}` });
    const r = await researchYieldByPurpose({ since: SINCE, until: UNTIL });
    const inputs = r.costCountedOnce.jobTimeInputs!;
    expect(inputs.measured).toBe(0);
    expect(inputs.issues).toMatchObject({ NO_DURATION: 1, NEGATIVE_DURATION: 1, UNREADABLE_TIMESTAMP: 2 });
    expect(inputs.examples.map((e) => e.jobId)).toEqual(expect.arrayContaining([`lane:fl1_${tag}`, `lane:fl2_${tag}`]));
    // Both sums are 0 because no job gave a readable run time — shown, not inferred.
    expect(r.costCountedOnce.totalJobMs).toBe(0);
    expect(causeFromJobInputs(inputs).cause).toBe('ALL_JOBS_UNMEASURED');
    // It survives JSON storage, so a decision row carries it.
    expect(JSON.parse(JSON.stringify(r.costCountedOnce)).jobTimeInputs.issues.NO_DURATION).toBe(1);
  });
});
