/**
 * Finding repair-agreed-value-infinite-sample: money a buyer agreed was read as
 * an infinite sample, so the quant engine's Wilson interval collapsed to the
 * point reading and claimed at least 90% with no calibration of whether the
 * counterparty pays. A signed contract is not settled cash (CAUSAL-14-2), and
 * at least 90% is claimed only from calibrated evidence (CAUSAL-14-5).
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, sampleSizeOf } from '../server/services/goals/portfolio.ts';
import { assess, type Activity, type PortfolioProblem, type PortfolioReading } from '../server/services/quant/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
const inferred = (p50: number, observations: number): ModelInput => ({
  value: null, low: p50 / 2, high: p50 * 2, provenance: 'UNKNOWN', source: null, note: '',
  inferred: { tier: 'COMPARABLE', justified: true, p10: p50 / 2, p50, p90: p50 * 2, observations },
});

function opening(id: string, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index: 1, tier: 'QUALIFIED', repeatable: false,
    price: fixed(1500), capital: fixed(0), hours: fixed(2), daysToCash: fixed(3), close: fixed(0.2), respond: fixed(1),
    directCost: fixed(0), volume: fixed(1), agreed: true, agreedValue: 12_000, agreedDeals: 1,
    fulfilledBy: null, competitiveAward: false,
    ...over,
  };
}

describe('an agreement is not an infinite sample', () => {
  it('states no sample for agreed money with a fixed days-to-cash', () => {
    expect(sampleSizeOf(opening('a'))).toBeUndefined();
  });

  it('states no sample even when days-to-cash was inferred: timing observations say nothing of default', () => {
    expect(sampleSizeOf(opening('a', { daysToCash: inferred(10, 500) }))).toBeUndefined();
  });

  it('never returns an infinite sample for any opening', () => {
    const cases: ModelledOpportunity[] = [
      opening('a'),
      opening('b', { agreed: false, agreedValue: 0, agreedDeals: 0 }),
      opening('c', { agreed: false, agreedValue: 0, agreedDeals: 0, close: inferred(0.2, 40) }),
      opening('d', { agreed: false, agreedValue: 0, agreedDeals: 0, repeatable: true, close: inferred(0.2, 40), respond: inferred(0.02, 60), volume: inferred(100, 30) }),
    ];
    for (const one of cases) {
      const n = sampleSizeOf(one);
      expect(n === undefined || Number.isFinite(n)).toBe(true);
    }
    // Real observations still bound a sample: the weakest one.
    expect(sampleSizeOf(cases[2]!)).toBe(40);
  });

  it('a goal met by agreed money alone is coverage, never a calibrated claim of at least 90%', () => {
    const result = evaluateGoalPortfolio({
      remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: null, worlds: 500, seed: 7,
      openings: [opening('a')],
    });
    expect(result.best?.reach).toBeGreaterThanOrEqual(0.9);
    expect(result.assurance?.claimsAtLeast90).toBe(false);
    expect(result.assurance?.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(result.assurance?.range).toBeNull();
  });
});

describe('the quant engine refuses an infinite sample whoever supplies it', () => {
  const act = (sampleSize: number): Activity => ({ key: 'a', label: 'a', cash: [100], days: [1], justified: true, evidence: { sampleSize } });
  const reading: PortfolioReading = { keys: ['a'], reach: 0.91, settledP10: 10, settledP50: 50, settledP90: 90, capitalShort: 0, overSpend: 0, feasible: true, infeasibleBecause: null, basis: 'PROBABILITY' };
  const problem = (a: Activity): PortfolioProblem => ({ activities: [a], target: 100, deadlineDays: 10, worlds: 200 });

  it('Infinity is not a sample: calibration is unavailable, with no zero-width range', () => {
    const a = assess(problem(act(Number.POSITIVE_INFINITY)), reading);
    expect(a.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(a.claimsAtLeast90).toBe(false);
    expect(a.range).toBeNull();
    expect(a.validationProblems.join(' ')).toMatch(/finite count of observations/);
  });

  it('NaN is not a sample either', () => {
    expect(assess(problem(act(Number.NaN)), reading).status).toBe('CALIBRATION_UNAVAILABLE');
  });
});
