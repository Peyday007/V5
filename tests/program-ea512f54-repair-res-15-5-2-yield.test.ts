/**
 * RES-15-5 repair, episode 2, the yield reading: `costCountedOnce` holds by
 * construction. Each job's time and money is charged in exact integer
 * thousandths; the total and every lane take it whole and its purposes take
 * parts that sum back to it exactly (the last purpose taking the remainder),
 * so purposeJobMs === totalJobMs and purposeCostMinor === totalCostMinor with
 * no tolerance, for any mix of splits, magnitudes and window lengths.
 *
 * On the earliest cause: at the pinned commit the old floating split (1/n per
 * purpose, six buckets each rounded to thousandths) stayed inside `sumsAgree`'s
 * tolerance for every case below — a gap of at most a few thousandths, or one
 * part in a billion — so the rounding/split case does not reproduce a failing
 * `holds` there; the probe failure's earliest cause is upstream, in how the
 * allocation pass recorded decision rows (only on a fingerprint change, so an
 * old held-for-cost row never left the probe's window; the
 * `allocation-record-per-window` unit of this campaign). The cases here pin
 * that the reading itself can never be the cause: what was a tolerance is now
 * an identity.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_READABLE_JOB_MS,
  RESEARCH_YIELD_WINDOWS,
  splitCharge,
  summarizeResearchYield,
  type PurposeKey,
  type YieldJob,
  type YieldOutput,
} from '../server/services/goals/researchYield.ts';
import { verifiedCostReading } from '../server/services/goals/tick.ts';

const SINCE = '2026-11-16T00:00:00.000Z';
const UNTIL = '2026-11-17T00:00:00.000Z';
const T0 = Date.parse(SINCE);
const ALL: PurposeKey[] = ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'OPERATING_SUPPORT', 'SELF_IMPROVEMENT', 'FORWARD_EXPLORATION', 'UNATTRIBUTED'];

function job(id: string, purposes: PurposeKey[], over: Partial<YieldJob> = {}): YieldJob {
  return { id, lane: 'free-lane:m', purposes, basis: ['b'], startMs: T0 + 1000, durationMs: 60_000, queueWaitMs: null, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over };
}

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function mixedJobs(n: number, seed: number): YieldJob[] {
  const r = rng(seed);
  const out: YieldJob[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = 1 + Math.floor(r() * ALL.length);
    const purposes = [...ALL].sort(() => r() - 0.5).slice(0, k);
    const pick = r();
    const durationMs = pick < 0.05 ? Number.NaN : pick < 0.08 ? Number.POSITIVE_INFINITY : pick < 0.1 ? -5 : r() * 1e8;
    const costMinor = r() < 0.3 ? null : r() < 0.05 ? Number.NaN : r() * 1e6 / 7;
    out.push(job(`j${i}`, purposes, { durationMs, costMinor, lane: `lane-${i % 4}`, timeMeasured: r() < 0.03 ? false : undefined }));
    if (r() < 0.1) out.push(job(`j${i}`, purposes, { durationMs: 1e8 }));
  }
  return out;
}

const holdsExactly = (jobs: YieldJob[]) => {
  const reading = summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs: [] });
  const once = reading.costCountedOnce;
  expect(once.holds).toBe(true);
  expect(once.cause).toBe('HOLDS');
  expect(once.purposeJobMs).toBe(once.totalJobMs);
  expect(once.purposeCostMinor).toBe(once.totalCostMinor);
  expect(once.jobMsGap).toBe(0);
  // What the allocation pass would record from it.
  expect(verifiedCostReading(JSON.parse(JSON.stringify(once))).holds).toBe(true);
  return reading;
};

describe('cost is counted once by construction', () => {
  it('splits a charge into parts that sum to it exactly, the last taking the remainder', () => {
    expect(splitCharge(10n, 3)).toEqual([3n, 3n, 4n]);
    expect(splitCharge(7n, 1)).toEqual([7n]);
    expect(splitCharge(0n, 6)).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    for (const [u, n] of [[100_000_000_001n, 6], [1n, 5], [99999999999999n, 4]] as const) {
      expect(splitCharge(u, n).reduce((a, b) => a + b, 0n)).toBe(u);
    }
  });

  it('holds exactly for thirds and sixths of awkward durations and money (the rounding/split case)', () => {
    const jobs = Array.from({ length: 300 }, (_, i) => job(`s${i}`, ALL.slice(0, 1 + (i % 6)), { durationMs: 1e8 / 3 + i * 0.0007, costMinor: i % 2 ? 1 / 3 + i : null }));
    holdsExactly(jobs);
  });

  it('holds for hundreds of mixed jobs over a 24h window, with duplicates, unmeasured times, NaN/Infinity/negative durations and null or recorded money', () => {
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const jobs = mixedJobs(600, seed);
      const reading = holdsExactly(jobs);
      // Each distinct job is counted once, unreadable times included.
      expect(reading.costCountedOnce.jobs).toBe(new Set(jobs.map((j) => j.id)).size);
      expect(reading.total.submissions).toBe(reading.costCountedOnce.jobs);
      expect(reading.costCountedOnce.unmeasuredJobs).toBeGreaterThan(0);
    }
  });

  it('charges a duplicated job id once, to the total and to its purposes', () => {
    const r = holdsExactly([job('a', ['BROAD_DISCOVERY', 'SELF_IMPROVEMENT'], { durationMs: 1e8 }), job('a', ['BROAD_DISCOVERY', 'SELF_IMPROVEMENT'], { durationMs: 1e8 })]);
    expect(r.total.jobMs).toBe(1e8);
    expect(r.purposes.BROAD_DISCOVERY.jobMs + r.purposes.SELF_IMPROVEMENT.jobMs).toBe(1e8);
  });

  it('keeps an unreadable time counted once as unmeasured, never dropped and never guessed', () => {
    const r = holdsExactly([
      job('nan', ['BROAD_DISCOVERY'], { durationMs: Number.NaN }),
      job('inf', ['BROAD_DISCOVERY'], { durationMs: Number.POSITIVE_INFINITY }),
      job('neg', ['BROAD_DISCOVERY'], { durationMs: -1 }),
      job('huge', ['BROAD_DISCOVERY'], { durationMs: MAX_READABLE_JOB_MS * 10 }),
      job('badstart', ['BROAD_DISCOVERY'], { startMs: Number.NaN }),
      job('ok', ['BROAD_DISCOVERY'], { durationMs: 5 }),
    ]);
    expect(r.costCountedOnce.jobs).toBe(6);
    expect(r.costCountedOnce.unmeasuredJobs).toBe(5);
    expect(r.total.jobMs).toBe(5);
  });

  it('a window with no job holds with zero on both sides and no money', () => {
    const r = holdsExactly([]);
    expect(r.costCountedOnce.totalJobMs).toBe(0);
    expect(r.costCountedOnce.totalCostMinor).toBeNull();
  });
});

describe('per-lane useful yield per window', () => {
  it('reports each lane useful results per hour of job time, null when no time was measured', () => {
    const jobs = [
      job('a', ['TRANSACTION_ROUTES'], { lane: 'free-lane:a', durationMs: 3_600_000 }),
      job('b', ['BROAD_DISCOVERY'], { lane: 'free-lane:b', durationMs: 7_200_000 }),
      job('c', ['BROAD_DISCOVERY'], { lane: 'bin:x', durationMs: Number.NaN }),
    ];
    const outputs: YieldOutput[] = [
      { kind: 'QUALIFIED_POSITION', id: 'p1', lane: 'free-lane:a', purposes: ['TRANSACTION_ROUTES'] },
      { kind: 'EXECUTABLE_OFFER', id: 'o1', lane: 'free-lane:a', purposes: ['TRANSACTION_ROUTES'] },
      { kind: 'PACKET_FILED', id: 'k1', lane: 'free-lane:b', purposes: ['BROAD_DISCOVERY'] },
      { kind: 'ACCEPTED_CLAIM', id: 'c1', lane: 'free-lane:b', purposes: ['BROAD_DISCOVERY'] },
    ];
    const r = summarizeResearchYield({ since: SINCE, until: UNTIL, jobs, outputs });
    expect(r.lanes['free-lane:a']!.usefulPerJobHour).toBe(2);
    expect(r.lanes['free-lane:b']!.usefulPerJobHour).toBe(0.5);
    expect(r.lanes['bin:x']!.usefulPerJobHour).toBeNull();
    expect(r.total.usefulPerJobHour).toBe(1);
    expect(r.costCountedOnce.holds).toBe(true);
  });

  it('reads the same 1h/6h/24h windows as TEL-07-1', () => {
    expect(RESEARCH_YIELD_WINDOWS.map((w) => [w.key, w.ms])).toEqual([['1h', 3_600_000], ['6h', 21_600_000], ['24h', 86_400_000]]);
  });
});
