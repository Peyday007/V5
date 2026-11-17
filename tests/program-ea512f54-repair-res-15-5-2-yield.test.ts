/**
 * RES-15-5 repair, episode 2: a research yield reading counts each job's cost
 * once by construction, and every lane reports its useful yield per window.
 *
 * Earliest cause, as read from the pinned commit (0bde597): the summarizer at
 * that commit already held its counted-once check on every input these tests
 * and a 3000-window randomized sweep gave it — so the failing decision rows
 * probe r01.res-15-5 named (whose fingerprints carry no `held` key, i.e. were
 * recorded before episode 1's fingerprint change) were written by earlier code,
 * upstream of this reader. What remained fragile here is that the check
 * compared a total with a sum of six separately rounded buckets of `1/n`
 * splits; it now compares the exact charges, split by remainder so the parts of
 * one job sum back to that job's charge.
 */
import { describe, expect, it } from 'vitest';
import {
  RESEARCH_YIELD_WINDOWS,
  diagnoseCostCountedOnce,
  splitCharge,
  summarizeResearchYield,
  type PurposeKey,
  type YieldJob,
  type YieldOutput,
} from '../server/services/goals/researchYield.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);
const PURPOSES: PurposeKey[] = ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'OPERATING_SUPPORT', 'SELF_IMPROVEMENT', 'FORWARD_EXPLORATION', 'UNATTRIBUTED'];

function job(id: string, over: Partial<YieldJob> = {}): YieldJob {
  return {
    id, lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: ['b'], startMs: T0 + 1000, durationMs: 60_000,
    queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over,
  };
}

const summarize = (jobs: readonly YieldJob[], outputs: readonly YieldOutput[] = []) => summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs });

describe('splitCharge', () => {
  it('splits a charge into parts that sum back to the charge exactly', () => {
    for (const charge of [0, 1, 0.1, 1 / 3, 99_999_999.7, 12_345.678_9, 7e7 + 0.3]) {
      for (const n of [1, 2, 3, 5, 6, 7]) {
        const parts = splitCharge(charge, n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((s, x) => s + x, 0)).toBe(charge);
      }
    }
  });
});

describe('summarizeResearchYield counts each job cost once by construction', () => {
  it('holds with cause HOLDS across degenerate rows, duplicate ids and multi-purpose jobs', () => {
    const r = summarize([
      job('a', { costMinor: 30 }),
      job('nan', { durationMs: Number.NaN }),
      job('inf', { durationMs: Number.POSITIVE_INFINITY }),
      job('neg', { durationMs: -5 }),
      job('nostart', { startMs: Number.NaN }),
      job('nancost', { costMinor: Number.NaN }),
      job('multi', { purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'SELF_IMPROVEMENT'], costMinor: 10, durationMs: 100_000_000 / 3 }),
      job('a', { durationMs: 999_999, costMinor: 9999 }), // duplicate id: counted once
    ]);
    const once = r.costCountedOnce;
    expect(once.holds).toBe(true);
    expect(once.cause).toBe('HOLDS');
    expect(once.jobs).toBe(7);
    expect(once.unmeasuredJobs).toBe(4);
    expect(once.purposeJobMs).toBe(once.totalJobMs);
    expect(once.purposeCostMinor).toBe(once.totalCostMinor);
    expect(once.totalCostMinor).toBe(40);
    expect(diagnoseCostCountedOnce(once).cause).toBe('HOLDS');
  });

  it('holds on large randomized windows: hundreds of jobs, durations up to 1e8 ms, split up to six ways', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 400);
      const jobs: YieldJob[] = [];
      for (let i = 0; i < n; i++) {
        const k = 1 + Math.floor(rnd() * 6);
        const purposes = Array.from({ length: k }, (_, j) => PURPOSES[(i + j) % PURPOSES.length]!);
        jobs.push(job(`j${i}`, { purposes, durationMs: rnd() * (rnd() < 0.5 ? 1e8 : 1e4), costMinor: rnd() < 0.3 ? rnd() * 1000 : null }));
      }
      const once = summarize(jobs).costCountedOnce;
      expect(once.holds).toBe(true);
      expect(diagnoseCostCountedOnce(once).cause).toBe('HOLDS');
      expect(Math.abs(once.totalJobMs - once.purposeJobMs)).toBeLessThan(0.01);
    }
  });

  it('charges a multi-purpose job once to the total and in parts that sum to it across purposes', () => {
    const r = summarize([job('m', { purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'], durationMs: 100, costMinor: 10 })]);
    expect(r.total.jobMs).toBe(100);
    expect(r.total.costMinor).toBe(10);
    const parts = (['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'] as const).map((p) => r.purposes[p]);
    expect(parts.every((b) => b.submissions === 1)).toBe(true);
    expect(Math.abs(parts.reduce((s, b) => s + b.jobMs, 0) - 100)).toBeLessThan(0.01);
    expect(Math.abs(parts.reduce((s, b) => s + (b.costMinor ?? 0), 0) - 10)).toBeLessThan(0.01);
  });
});

describe('per-lane useful yield per window', () => {
  it('reports useful results per job hour for each lane, null where no time was measured', () => {
    const r = summarize(
      [
        job('g1', { lane: 'free-lane:gpu', durationMs: 1_800_000 }),
        job('g2', { lane: 'free-lane:gpu', durationMs: 1_800_000 }),
        job('b1', { lane: 'bin:claude-routine', durationMs: 3_600_000 }),
        job('u1', { lane: 'bin:unmeasured', durationMs: Number.NaN }),
      ],
      [
        { kind: 'PACKET_FILED', id: 'p1', lane: 'free-lane:gpu', purposes: ['BROAD_DISCOVERY'] },
        { kind: 'QUALIFIED_POSITION', id: 'q1', lane: 'free-lane:gpu', purposes: ['TRANSACTION_ROUTES'] },
        { kind: 'ACCEPTED_CLAIM', id: 'c1', lane: 'bin:claude-routine', purposes: ['BROAD_DISCOVERY'] },
      ],
    );
    expect(r.lanes['free-lane:gpu']!.usefulPerJobHour).toBe(2);
    // An accepted claim is an intermediate, not a useful result.
    expect(r.lanes['bin:claude-routine']!.usefulPerJobHour).toBe(0);
    expect(r.lanes['bin:unmeasured']!.usefulPerJobHour).toBeNull();
    expect(r.total.usefulPerJobHour).toBe(1);
  });

  it('reads the same consistent windows TEL-07-1 reads', () => {
    expect(RESEARCH_YIELD_WINDOWS.map((w) => [w.key, w.ms])).toEqual([['1h', 3_600_000], ['6h', 21_600_000], ['24h', 86_400_000]]);
  });
});
