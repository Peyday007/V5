/**
 * RES-15-5 repair, episode 1: a measured research allocation decision must show
 * each job's cost counted once. The production decision row failed probe
 * r01.res-15-5 because `costCountedOnce.holds` was false: a job whose run time
 * the rows did not give (an unparseable timestamp, a non-numeric duration)
 * made the total job time NaN, and NaN never equals anything. These tests feed
 * those degenerate rows through the summarizer, the production loader and the
 * allocation pass, and read every recorded decision with the probe's own check.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  diagnoseCostCountedOnce,
  researchYieldByPurpose,
  summarizeResearchYield,
  sumsAgree,
  type PurposeKey,
  type ResearchYieldReading,
  type YieldJob,
} from '../server/services/goals/researchYield.ts';
import { RESEARCH_ALLOCATION_WINDOW_MS, reallocateResearch, sharesInForceFrom, verifiedCostReading, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { RESEARCH_PURPOSES } from '../server/services/goals/researchAllocation.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';
import type { GoalView } from '../server/services/goals/model.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);

function job(id: string, over: Partial<YieldJob> = {}): YieldJob {
  return {
    id, lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: ['b'], startMs: T0 + 1000, durationMs: 60_000,
    queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over,
  };
}

const summarize = (jobs: YieldJob[]) => summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs: [] });

describe('summarizeResearchYield counts every job cost once, whatever its rows say', () => {
  it('holds with finite sums for NaN, undefined and negative durations, unreadable starts, null and NaN costs, duplicate ids and multi-purpose jobs', () => {
    const jobs: YieldJob[] = [
      job('ok', { costMinor: 30 }),
      job('nan', { durationMs: Number.NaN }),
      job('undef', { durationMs: undefined as unknown as number }),
      job('neg', { durationMs: -5 }),
      job('nostart', { startMs: Number.NaN }),
      job('nullcost', { costMinor: null }),
      job('nancost', { costMinor: Number.NaN }),
      job('multi', { purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'SELF_IMPROVEMENT'], costMinor: 10 }),
      job('dupkeys', { purposes: ['OPERATING_SUPPORT', 'OPERATING_SUPPORT'] as PurposeKey[] }),
      job('unknown', { purposes: ['NOT_A_PURPOSE' as PurposeKey] }),
      job('ok', { durationMs: 999_999 }), // duplicate id: counted once
      job('flagged', { timeMeasured: false }),
    ];
    const r = summarize(jobs);
    expect(r.costCountedOnce.holds).toBe(true);
    expect(Number.isFinite(r.costCountedOnce.totalJobMs)).toBe(true);
    expect(Number.isFinite(r.costCountedOnce.purposeJobMs)).toBe(true);
    expect(r.costCountedOnce.jobs).toBe(11);
    expect(r.total.submissions).toBe(11);
    // nan, undef, neg, nostart and flagged have no readable run time.
    expect(r.costCountedOnce.unmeasuredJobs).toBe(5);
    expect(r.costCountedOnce.totalJobMs).toBe(6 * 60_000);
    expect(r.costCountedOnce.totalCostMinor).toBe(40);
    expect(r.costCountedOnce.purposeCostMinor).toBeCloseTo(40, 2);
    expect(r.notes.some((n) => /no readable run time/.test(n))).toBe(true);
    expect(r.purposes.UNATTRIBUTED.submissions).toBe(1);
    expect(r.attributions).toHaveLength(11);
    for (const b of [r.total, ...Object.values(r.lanes), ...Object.values(r.purposes)]) {
      expect(Number.isFinite(b.jobMs)).toBe(true);
      expect(Number.isFinite(b.utilization)).toBe(true);
    }
  });

  it('still fails on a real double count: purposes summing to more than the total', () => {
    expect(sumsAgree(60_000, 120_000)).toBe(false);
    expect(sumsAgree(10, 20)).toBe(false);
    expect(sumsAgree(Number.NaN, Number.NaN)).toBe(false);
    expect(sumsAgree(null, 5)).toBe(false);
    expect(sumsAgree(null, null)).toBe(true);
  });

  it('is not fooled by float drift over thousands of multi-purpose 24h jobs', () => {
    const jobs: YieldJob[] = [];
    for (let i = 0; i < 5000; i++) {
      const served = RESEARCH_PURPOSES.slice(0, 1 + (i % RESEARCH_PURPOSES.length));
      jobs.push(job(`j${i}`, { purposes: [...served], startMs: T0, durationMs: 86_400_000 - (i % 7) / 3, costMinor: (i % 13) / 3 }));
    }
    const r = summarize(jobs);
    expect(r.costCountedOnce.holds).toBe(true);
    expect(r.costCountedOnce.jobs).toBe(5000);
  });
});

describe('researchYieldByPurpose on degenerate production rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('yields finite job time and holds when bin_events.at, a close time or duration_ms cannot be read', async () => {
    const db = getDb();
    const ev = (id: string, type: string, at: string, extra: { bin_id?: string; ms?: number | string | null; outcome?: string; reason?: string } = {}) =>
      db.run(`INSERT INTO bin_events (id, event_type, at, bin_id, duration_ms, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, type, at, extra.bin_id ?? null, extra.ms ?? null, extra.outcome ?? null, extra.reason ?? null]);
    const tag = Math.random().toString(36).slice(2, 8);
    // Free-lane items: a good one, a null duration, a non-numeric duration and an unreadable time.
    await ev(`fl1_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T10:00:00.000Z', { ms: 30_000, outcome: 'SUBMITTED', reason: 'runpod/m' });
    await ev(`fl2_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T10:05:00.000Z', { ms: null, outcome: 'SUBMITTED', reason: 'runpod/m' });
    await ev(`fl3_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T10:06:00.000Z', { ms: 'not-a-number', outcome: 'FAILED', reason: 'boom' });
    await ev(`fl4_${tag}`, 'FREE_LANE_ITEM', '2026-11-16T99:99:99.000Z', { ms: 5_000, outcome: 'SUBMITTED', reason: 'runpod/m' });
    // Bins: one assigned at an unreadable time, one whose close time is unreadable.
    await ev(`ba1_${tag}`, 'BIN_ASSIGNED', '2026-11-16T25:00:00.000Z', { bin_id: `bin_a_${tag}` });
    await ev(`bt1_${tag}`, 'BIN_TERMINAL', '2026-11-16T12:00:00.000Z', { bin_id: `bin_a_${tag}` });
    await ev(`ba2_${tag}`, 'BIN_ASSIGNED', '2026-11-16T11:00:00.000Z', { bin_id: `bin_b_${tag}` });
    await ev(`bt2_${tag}`, 'BIN_RELEASED', '2026-11-16T1x:00:00.000Z', { bin_id: `bin_b_${tag}` });
    const r = await researchYieldByPurpose({ since: SINCE, until: UNTIL });
    expect(r.costCountedOnce.holds).toBe(true);
    expect(Number.isFinite(r.costCountedOnce.totalJobMs)).toBe(true);
    expect(Number.isFinite(r.costCountedOnce.purposeJobMs)).toBe(true);
    expect(r.costCountedOnce.jobs).toBeGreaterThanOrEqual(6);
    expect(r.costCountedOnce.unmeasuredJobs ?? 0).toBeGreaterThanOrEqual(3);
    for (const b of [r.total, ...Object.values(r.lanes), ...Object.values(r.purposes)]) {
      expect(Number.isFinite(b.jobMs)).toBe(true);
      expect(Number.isFinite(b.utilization)).toBe(true);
      if (b.queueWait.medianMs !== null) expect(Number.isFinite(b.queueWait.medianMs)).toBe(true);
    }
    // The recorded form survives JSON (a NaN would become null and fail the probe).
    expect(JSON.parse(JSON.stringify(r.costCountedOnce)).holds).toBe(true);
  });
});

function goalView(id: string): GoalView {
  return { id, projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;
}

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

/** A window where purposes differ in yield, so a verified pass moves shares. */
function degenerateJobs(): YieldJob[] {
  const jobs: YieldJob[] = [];
  for (let i = 0; i < 40; i++) jobs.push(job(`tr${i}`, { purposes: ['TRANSACTION_ROUTES'], durationMs: 60_000 }));
  for (let i = 0; i < 120; i++) jobs.push(job(`bd${i}`, { purposes: ['BROAD_DISCOVERY'], durationMs: i % 10 === 0 ? Number.NaN : 60_000 }));
  for (let i = 0; i < 20; i++) jobs.push(job(`si${i}`, { purposes: ['SELF_IMPROVEMENT', 'OPERATING_SUPPORT'], startMs: i % 5 === 0 ? Number.NaN : T0 + 1000 }));
  return jobs;
}

function readingFrom(jobs: YieldJob[]): ResearchYieldReading {
  const outputs = Array.from({ length: 12 }, (_, i) => ({ kind: 'PACKET_FILED' as const, id: `p${i}`, lane: 'free-lane:m', purposes: ['TRANSACTION_ROUTES'] as PurposeKey[] }));
  return summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs });
}

describe('reallocateResearch records only decisions whose cost is counted once', () => {
  it('a pass over degenerate rows records a measured decision the probe accepts', async () => {
    const { ports, decisions } = memoryPorts(() => readingFrom(degenerateJobs()));
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, ports);
    expect(report.recorded).toBe(true);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.held).toBe(false);
    expect((d.costCountedOnce as { holds: unknown }).holds).toBe(true);
    expect(yieldAllocationHolds(decisions as never).ok).not.toBe(false);
  });

  it('holds the decision, moving no share, when a reading cannot show its cost counted once', async () => {
    const bad = (): ResearchYieldReading => {
      const r = readingFrom(degenerateJobs());
      return { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } };
    };
    const { ports, decisions } = memoryPorts(bad);
    const report = await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, ports);
    expect(report.held).toBe(true);
    const d = decisions[0]!;
    // Measured, so not `held` (nothing measured): recorded as held for cost.
    expect(d.held).toBe(false);
    expect(d.heldForCost).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.shares).toEqual(d.observed);
    expect((d.notes as string[])[0]).toMatch(/counted once/);
    expect(String(d.summary)).toMatch(/counted once/);
    // The allocation stage never applies it.
    expect(sharesInForceFrom(d)?.held).toBe(true);
  });

  it('a genuine double count fails the probe instead of hiding as a held decision (finding F2)', async () => {
    const doubled = (): ResearchYieldReading => {
      const r = readingFrom(degenerateJobs());
      return { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } };
    };
    const { ports, decisions } = memoryPorts(doubled);
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, ports);
    const verdict = yieldAllocationHolds(decisions as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/counted once/);
    // Beside good decisions it still surfaces.
    const good = memoryPorts(() => readingFrom(degenerateJobs()));
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, good.ports);
    expect(yieldAllocationHolds([...good.decisions, ...decisions] as never).ok).toBe(false);
    // A window with nothing measured is still held and not read by the probe.
    const empty = memoryPorts(() => summarizeResearchYield({ since: SINCE, until: UNTIL, jobs: [], outputs: [] }));
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, empty.ports);
    expect(empty.decisions[0]!.heldForCost).toBe(false);
    expect(yieldAllocationHolds(empty.decisions as never).ok).not.toBe(false);
  });

  it('treats a missing, null or malformed cost record as not holding', () => {
    expect(verifiedCostReading(undefined).holds).toBe(false);
    expect(verifiedCostReading({ holds: 'yes' }).holds).toBe(false);
    expect(verifiedCostReading({ holds: true, totalJobMs: null, purposeJobMs: 1 }).holds).toBe(false);
    expect(verifiedCostReading({ holds: true, totalJobMs: 5, purposeJobMs: 5, jobs: 1 }).holds).toBe(true);
  });

  it('every recorded measured decision across repeated passes passes the probe per row', async () => {
    let n = 0;
    const { ports, decisions } = memoryPorts(() => {
      n += 1;
      const jobs = degenerateJobs();
      if (n % 2 === 0) jobs.push(job(`extra${n}`, { durationMs: Number.NaN, purposes: ['FORWARD_EXPLORATION'] }));
      return n === 3
        ? { ...readingFrom(jobs), costCountedOnce: { jobs: 0, totalJobMs: Number.NaN, purposeJobMs: 0, totalCostMinor: null, purposeCostMinor: null, holds: true } }
        : readingFrom(jobs);
    });
    for (let i = 0; i < 4; i++) await reallocateResearch({ goals: [goalView('wst_a')], now: new Date(Date.parse(UNTIL) + i * 3_600_000).toISOString() }, ports);
    for (const d of decisions) {
      if (d.held === true || d.heldForCost === true) continue;
      expect((d.costCountedOnce as { holds: unknown }).holds).toBe(true);
      for (const c of d.changes as { reasons: string[] }[]) expect(c.reasons.length).toBeGreaterThan(0);
    }
    // Pass 3's reading cannot show its cost counted once: it is recorded measured and the probe flags it.
    expect(decisions.some((d) => d.heldForCost === true && d.held === false)).toBe(true);
    expect(yieldAllocationHolds(decisions as never).ok).toBe(false);
    // Every decision whose cost was shown counted once passes the probe.
    expect(yieldAllocationHolds(decisions.filter((d) => d.heldForCost !== true) as never).ok).not.toBe(false);
  });
});

/**
 * Review finding F3: the earlier repair asserted a NaN job time as the cause
 * without showing it. These tests make the cause something the row itself
 * demonstrates: every recorded decision now carries `costCountedOnce.cause`,
 * read from the reading's own sums before they are coerced, and a row recorded
 * before that field existed is classified from its numbers the same way.
 */
describe('a decision row demonstrates why its cost is or is not counted once', () => {
  it('names each cause from the numbers alone, and the causes do not overlap', () => {
    expect(diagnoseCostCountedOnce(undefined).cause).toBe('NOT_RECORDED');
    expect(diagnoseCostCountedOnce({ totalJobMs: Number.NaN, purposeJobMs: 5, holds: false }).cause).toBe('NON_FINITE_JOB_TIME');
    expect(diagnoseCostCountedOnce({ totalJobMs: 5, purposeJobMs: 5, totalCostMinor: 3, purposeCostMinor: null, holds: false }).cause).toBe('NON_FINITE_COST');
    expect(diagnoseCostCountedOnce({ totalJobMs: 60_000, purposeJobMs: 120_000, totalCostMinor: null, purposeCostMinor: null, holds: false }).cause).toBe('DOUBLE_COUNT');
    expect(diagnoseCostCountedOnce({ totalJobMs: 4e12, purposeJobMs: 4e12 + 0.3, totalCostMinor: null, purposeCostMinor: null, holds: false }).cause).toBe('FLOAT_DRIFT');
    expect(diagnoseCostCountedOnce({ totalJobMs: 5, purposeJobMs: 5, totalCostMinor: null, purposeCostMinor: null, holds: false }).cause).toBe('FLAG_DISAGREES');
    expect(diagnoseCostCountedOnce({ totalJobMs: 5, purposeJobMs: 5.001, totalCostMinor: 2, purposeCostMinor: 2, holds: true }).cause).toBe('HOLDS');
  });

  it('classifies a row written before the fix: NaN job time is stored as null and reads as NON_FINITE_JOB_TIME, never as drift', () => {
    // The pre-fix allocation pass recorded the reader's costCountedOnce as-is;
    // JSON (the improvement_events detail column) turns a NaN sum into null.
    const preFix = JSON.parse(JSON.stringify({ jobs: 40, totalJobMs: Number.NaN, purposeJobMs: Number.NaN, totalCostMinor: null, purposeCostMinor: null, holds: false }));
    expect(preFix.totalJobMs).toBeNull();
    const d = diagnoseCostCountedOnce(preFix);
    expect(d.cause).toBe('NON_FINITE_JOB_TIME');
    expect(d.detail).toMatch(/unreadable/);
  });

  it('float drift cannot exceed the old absolute 0.01 at any job time a 24h window can hold for a thousand always-busy workers', () => {
    // Total job time is bounded by window × concurrency. A thousand workers busy
    // for the whole window, split across one to five purposes with fractional
    // durations, is far above the fleet production runs, and still drifts by
    // under the 0.01 the pre-fix reader allowed — so the pre-fix failure could
    // not have been drift; it is the non-finite job time the row's null shows.
    const workers = 1000;
    const jobsPerWorker = 48;
    const each = RESEARCH_ALLOCATION_WINDOW_MS / jobsPerWorker;
    const jobs: YieldJob[] = [];
    for (let w = 0; w < workers; w++) {
      for (let k = 0; k < jobsPerWorker; k++) {
        const i = w * jobsPerWorker + k;
        jobs.push(job(`w${w}k${k}`, { purposes: [...RESEARCH_PURPOSES.slice(0, 1 + (i % RESEARCH_PURPOSES.length))], startMs: T0 + k * each, durationMs: each - (i % 7) / 3 }));
      }
    }
    const r = summarize(jobs);
    expect(r.costCountedOnce.totalJobMs).toBeLessThanOrEqual(workers * RESEARCH_ALLOCATION_WINDOW_MS);
    expect(r.costCountedOnce.jobMsGap).not.toBeNull();
    expect(r.costCountedOnce.jobMsGap!).toBeLessThan(0.01);
    expect(r.costCountedOnce.cause).toBe('HOLDS');
  });

  it('records the cause in the decision row: HOLDS on a measured reading, NON_FINITE_JOB_TIME on a NaN one, with the cause in the held note', async () => {
    const good = memoryPorts(() => readingFrom(degenerateJobs()));
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, good.ports);
    const ok = good.decisions[0]!.costCountedOnce as { cause: unknown; holds: unknown };
    expect(ok.holds).toBe(true);
    expect(ok.cause).toBe('HOLDS');

    const nan = memoryPorts(() => ({ ...readingFrom(degenerateJobs()), costCountedOnce: { jobs: 3, totalJobMs: Number.NaN, purposeJobMs: Number.NaN, totalCostMinor: null, purposeCostMinor: null, holds: false } }));
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, nan.ports);
    const row = JSON.parse(JSON.stringify(nan.decisions[0]!)) as Record<string, unknown>;
    const once = row.costCountedOnce as { cause: unknown; holds: unknown };
    // Measured but not counted once: heldForCost (never applied), not held, so the probe reads it.
    expect(row.held).toBe(false);
    expect(row.heldForCost).toBe(true);
    expect(sharesInForceFrom(row)?.held).toBe(true);
    expect(yieldAllocationHolds([row] as never).ok).toBe(false);
    expect(once.holds).toBe(false);
    expect(once.cause).toBe('NON_FINITE_JOB_TIME');
    expect((row.notes as string[])[0]).toMatch(/NON_FINITE_JOB_TIME/);
    // The recorded row, read back, diagnoses to the same cause it states.
    expect(diagnoseCostCountedOnce({ ...once, totalJobMs: null, purposeJobMs: null }).cause).toBe('NON_FINITE_JOB_TIME');

    const doubled = memoryPorts(() => {
      const r = readingFrom(degenerateJobs());
      return { ...r, costCountedOnce: { ...r.costCountedOnce, purposeJobMs: r.costCountedOnce.totalJobMs * 2, holds: false } };
    });
    await reallocateResearch({ goals: [goalView('wst_a')], now: UNTIL }, doubled.ports);
    expect((doubled.decisions[0]!.costCountedOnce as { cause: unknown }).cause).toBe('DOUBLE_COUNT');
  });
});
