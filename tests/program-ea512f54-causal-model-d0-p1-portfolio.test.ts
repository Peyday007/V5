/**
 * The portfolio optimizer's assurance (CAUSAL-14-5, 14-7): a probability is
 * claimed only from calibrated evidence, a safeguard's effect is measured on the
 * identical worlds, and combinations that cannot run are refused, not trimmed.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_THRESHOLD,
  MIN_EVIDENCE_SAMPLE,
  assess,
  optimizePortfolio,
  type Activity,
  type PortfolioProblem,
  type PortfolioReading,
} from '../server/services/quant/portfolio.ts';

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [100], days: [1], justified: true, evidence: { sampleSize: 1000 }, ...over,
});

const reading = (keys: string[], reach: number): PortfolioReading => ({
  keys, reach, settledP10: 10, settledP50: 50, settledP90: 90, capitalShort: 0, overSpend: 0, feasible: true, infeasibleBecause: null, basis: 'PROBABILITY',
});

const problem = (activities: Activity[], over: Partial<PortfolioProblem> = {}): PortfolioProblem => ({ activities, target: 100, deadlineDays: 10, worlds: 200, ...over });

describe('assess: what a number may be called', () => {
  it('no feasible combination means nothing to calibrate', () => {
    const a = assess(problem([act('a')]), null);
    expect(a.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(a.range).toBeNull();
    expect(a.claimsAtLeast90).toBe(false);
    expect(a.coverage).toBeNull();
  });

  it('claims at least 90% only when the lower bound clears it', () => {
    const a = assess(problem([act('a')]), reading(['a'], 0.999));
    expect(a.status).toBe('CLAIMS_AT_LEAST_90');
    expect(a.claimsAtLeast90).toBe(true);
    expect(a.range!.low).toBeGreaterThanOrEqual(CLAIM_THRESHOLD);
    expect(a.range!.high).toBeLessThanOrEqual(1);
    expect(a.reason).toContain('above 90%');
  });

  it('a point estimate above 90% with a thin sample is a RANGE, not a claim', () => {
    const a = assess(problem([act('a', { evidence: { sampleSize: MIN_EVIDENCE_SAMPLE } })]), reading(['a'], 1));
    expect(a.status).toBe('RANGE');
    expect(a.claimsAtLeast90).toBe(false);
    expect(a.range!.low).toBeLessThan(CLAIM_THRESHOLD);
    expect(a.range!.high).toBe(1);
    expect(a.reason).toContain('does not reach 90%');
  });

  it('a reach under 90% is a RANGE even with a large sample', () => {
    const a = assess(problem([act('a')]), reading(['a'], 0.8));
    expect(a.status).toBe('RANGE');
    expect(a.range!.low).toBeLessThan(0.8);
    expect(a.range!.high).toBeGreaterThan(0.8);
  });

  it('the weakest link bounds the claim: one small sample among large ones', () => {
    const strong = problem([act('a'), act('b')]);
    expect(assess(strong, reading(['a', 'b'], 1)).status).toBe('CLAIMS_AT_LEAST_90');
    const weak = problem([act('a'), act('b', { evidence: { sampleSize: MIN_EVIDENCE_SAMPLE } })]);
    expect(assess(weak, reading(['a', 'b'], 1)).status).toBe('RANGE');
  });

  it('a wider interval at 0% and 100% than a normal approximation would give', () => {
    const top = assess(problem([act('a', { evidence: { sampleSize: 50 } })]), reading(['a'], 1));
    expect(top.range!.low).toBeLessThan(1);
    const bottom = assess(problem([act('a', { evidence: { sampleSize: 50 } })]), reading(['a'], 0));
    expect(bottom.range!.high).toBeGreaterThan(0);
  });

  it('only members of the best combination are judged', () => {
    const p = problem([act('a'), act('bad', { justified: false })]);
    expect(assess(p, reading(['a'], 0.999)).status).toBe('CLAIMS_AT_LEAST_90');
    expect(assess(p, reading(['a', 'bad'], 0.999)).status).toBe('CALIBRATION_UNAVAILABLE');
  });

  it.each([
    ['invented inputs', act('a', { justified: false }), 'not evidence-backed'],
    ['no stated sample size', act('a', { evidence: undefined }), 'is not stated'],
    ['a sample under the minimum', act('a', { evidence: { sampleSize: MIN_EVIDENCE_SAMPLE - 1 } }), `is under ${MIN_EVIDENCE_SAMPLE}`],
    ['changed conditions', act('a', { evidence: { sampleSize: 1000, conditionsChanged: true } }), 'conditions changed'],
  ])('calibration is unavailable for %s, never read as favourable', (_name, activity, text) => {
    const a = assess(problem([activity]), reading(['a'], 1));
    expect(a.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(a.range).toBeNull();
    expect(a.claimsAtLeast90).toBe(false);
    expect(a.validationProblems.join(' ')).toContain(text);
    // The coverage is still shown, as coverage of scenarios and not a probability.
    expect(a.coverage).toBe(1);
    expect(a.reason).toContain('not a probability');
    expect(a.tailSettledP10).toBe(10);
  });
});

describe('optimizePortfolio attaches the assurance to the best combination', () => {
  it('evidence-backed samples give a claim; the same numbers without evidence give coverage', () => {
    const backed = optimizePortfolio(problem([act('a')]));
    expect(backed.best?.basis).toBe('PROBABILITY');
    expect(backed.assurance?.status).toBe('CLAIMS_AT_LEAST_90');
    const invented = optimizePortfolio(problem([act('a', { justified: false })]));
    expect(invented.best?.basis).toBe('COVERAGE');
    expect(invented.assurance?.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(invented.best?.reach).toBe(backed.best?.reach);
  });

  it('nothing to choose from is an empty result with nothing calibrated', () => {
    const r = optimizePortfolio(problem([]));
    expect(r).toEqual({ best: null, ranked: [], singles: [], refused: [], searched: 0 });
  });

  it('is reproducible from its seed', () => {
    const p = problem([act('a', { cash: [50, 120, 200], days: [3, 5, 12], riskGroup: 'g' }), act('b', { cash: [10, 80, 150], days: [2, 4, 9], riskGroup: 'g' })], { seed: 5, target: 150 });
    expect(optimizePortfolio(p)).toEqual(optimizePortfolio(p));
  });
});

describe('combinations that cannot run are refused, not trimmed', () => {
  it('refuses over-capacity and mutual exclusion with the reason', () => {
    const r = optimizePortfolio(
      problem(
        [act('a', { uses: { hours: 30 } }), act('b', { uses: { hours: 30 } }), act('c', { excludes: ['a'] })],
        { capacity: { hours: 40 } },
      ),
    );
    const reasons = Object.fromEntries(r.refused.map((one) => [one.keys.join('+'), one.reason]));
    expect(reasons['a+b']).toBe('needs 60 hours and only 40 is available');
    expect(reasons['a+c']).toBe('"c" and "a" cannot run together');
    expect(r.best?.feasible).toBe(true);
    expect(r.ranked.every((one) => one.feasible || one.reach === 0)).toBe(true);
  });

  it('a combination over the spending ceiling in a world does not reach the target', () => {
    const r = optimizePortfolio(problem([act('a', { spend: [100] })], { spendCeiling: 50 }));
    expect(r.best?.reach).toBe(0);
    expect(r.best?.overSpend).toBe(1);
    const free = optimizePortfolio(problem([act('a', { spend: [100] })], { spendCeiling: 500 }));
    expect(free.best?.reach).toBe(1);
    expect(free.best?.overSpend).toBe(0);
  });

  it('only cash that settles by the deadline counts', () => {
    const r = optimizePortfolio(problem([act('a', { days: [30] })], { deadlineDays: 10 }));
    expect(r.best?.reach).toBe(0);
    expect(r.best?.settledP50).toBe(0);
  });

  it('rejects activities whose samples are not paired', () => {
    expect(() => optimizePortfolio(problem([act('a', { days: [1, 2] })]))).toThrow(/paired cash and days/);
    expect(() => optimizePortfolio(problem([act('a', { spend: [1, 2] })]))).toThrow(/spend samples paired/);
  });
});

describe('withSafeguard: each control is measured on the identical worlds', () => {
  it('a faster cash cycle moves cash inside the deadline and lifts the bad-world outcome', () => {
    const r = optimizePortfolio(
      problem([act('a', { days: [10] })], {
        deadlineDays: 6,
        safeguards: [{ key: 'prepay', kind: 'FASTER_CASH_CYCLE', daysFactor: { activities: ['a'], factor: 0.5 } }],
      }),
    );
    const [effect] = r.safeguardEffects!;
    expect(effect).toMatchObject({ key: 'prepay', kind: 'FASTER_CASH_CYCLE', reachBefore: 0, reachAfter: 1, reachChange: 1, downsideChange: 100, capitalShortChange: 0 });
  });

  it('a factor above one cannot slow cash, and below zero cannot make it negative', () => {
    const slow = optimizePortfolio(problem([act('a', { days: [5] })], { deadlineDays: 6, safeguards: [{ key: 'x', kind: 'FASTER_CASH_CYCLE', daysFactor: { activities: ['a'], factor: 9 } }] }));
    expect(slow.safeguardEffects![0]!.reachChange).toBe(0);
    const zero = optimizePortfolio(problem([act('a', { days: [10] })], { deadlineDays: 6, safeguards: [{ key: 'x', kind: 'FASTER_CASH_CYCLE', daysFactor: { activities: ['a'], factor: -3 } }] }));
    expect(zero.safeguardEffects![0]!.reachAfter).toBe(1);
  });

  it('reserve capital lets a member start that otherwise could not', () => {
    const r = optimizePortfolio(
      problem([act('a', { capital: 100 })], {
        startingCapital: 50,
        safeguards: [{ key: 'reserve', kind: 'CONTINGENCY', capitalBonus: 50 }],
      }),
    );
    expect(r.best?.reach).toBe(0);
    expect(r.best?.capitalShort).toBe(1);
    expect(r.safeguardEffects![0]).toMatchObject({ reachBefore: 0, reachAfter: 1, reachChange: 1, capitalShortChange: -1 });
  });

  it('a control that changes nothing shows no effect', () => {
    const r = optimizePortfolio(problem([act('a', { cash: [10, 200], days: [2, 3] })], { safeguards: [{ key: 'noop', kind: 'CONTINGENCY' }] }));
    expect(r.safeguardEffects![0]).toMatchObject({ reachChange: 0, downsideChange: 0, capitalShortChange: 0 });
    expect(r.safeguardEffects![0]!.reachBefore).toBe(r.best?.reach);
  });

  it('reserve capacity is applied to the capacity table without changing the feasible best', () => {
    const r = optimizePortfolio(problem([act('a', { uses: { hours: 10 } })], { capacity: { hours: 10 }, safeguards: [{ key: 'spare', kind: 'RESERVE_CAPACITY', capacityBonus: { hours: 5 } }] }));
    expect(r.safeguardEffects![0]!.reachChange).toBe(0);
  });

  it('decorrelating a shared risk redraws the worlds and reports the change', () => {
    const shared = { cash: [0, 0, 0, 100, 100, 100], days: [1, 1, 1, 1, 1, 1], riskGroup: 'market' };
    const r = optimizePortfolio(
      problem([act('a', shared), act('b', shared)], {
        target: 200,
        worlds: 600,
        riskCorrelation: { market: 0.95 },
        safeguards: [{ key: 'diversify', kind: 'INDEPENDENT_CHANNEL', decorrelate: ['a', 'b'] }],
      }),
    );
    const effect = r.safeguardEffects![0]!;
    expect(r.best?.keys.sort()).toEqual(['a', 'b']);
    expect(effect.reachAfter).toBeLessThan(effect.reachBefore);
    expect(effect.reachChange).toBeCloseTo(effect.reachAfter - effect.reachBefore);
  });

  it('there is no effect row when nothing is feasible or no safeguard is given', () => {
    expect(optimizePortfolio(problem([act('a')])).safeguardEffects).toBeUndefined();
  });
});
