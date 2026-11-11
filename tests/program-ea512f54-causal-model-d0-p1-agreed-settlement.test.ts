/**
 * A signed agreement is not settled cash (CAUSAL-14-2), and at least 90% is
 * claimed only from calibrated evidence (CAUSAL-14-5). An opening whose money
 * a buyer already agreed still draws whether the counterparty pays; a fixed
 * days-to-cash term says when payment is due, not that it arrives, so it is no
 * sample — and an infinite sample, wherever it comes from, is no sample either.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, sampleSizeOf } from '../server/services/goals/portfolio.ts';
import { assess, effectiveSample, type Activity, type PortfolioReading } from '../server/services/quant/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function agreed(id: string, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Signed ${id}` } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(12_000),
    capital: fixed(0),
    hours: fixed(2),
    daysToCash: fixed(5),
    close: fixed(1),
    respond: fixed(1),
    directCost: fixed(0),
    volume: fixed(1),
    agreed: true,
    agreedValue: 12_000,
    agreedDeals: 1,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

describe('agreed money still draws whether it settles', () => {
  it('a fixed days-to-cash term states no sample of counterparty payment', () => {
    const n = sampleSizeOf(agreed('a'));
    expect(n).toBeUndefined();
  });

  it('a reconstructed record of real collections is a finite sample', () => {
    const one = agreed('a', { daysToCash: { ...fixed(5), inferred: { observations: 37 } } as ModelInput });
    expect(sampleSizeOf(one)).toBe(37);
  });

  it('does not claim at least 90% for a signed agreement nobody calibrated', () => {
    const result = evaluateGoalPortfolio({ remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: null, worlds: 500, seed: 3, openings: [agreed('a')] });
    expect(result.best?.reach ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(result.assurance?.status).not.toBe('CLAIMS_AT_LEAST_90');
    expect(result.assurance?.claimsAtLeast90).toBe(false);
  });
});

describe('the assurance judgment refuses an infinite sample', () => {
  const reading = (keys: string[], reach: number): PortfolioReading => ({ keys, reach, settledP10: 10, settledP50: 50, settledP90: 90, capitalShort: 0, overSpend: 0, feasible: true, infeasibleBecause: null, basis: 'PROBABILITY' });
  const act = (key: string, over: Partial<Activity> = {}): Activity => ({ key, label: key, cash: [100], days: [1], justified: true, ...over });

  it('reads Infinity as no stated sample, so a 91% point reading is not a zero-width 90% claim', () => {
    const a = act('t', { evidence: { sampleSize: Number.POSITIVE_INFINITY } });
    expect(effectiveSample(a)).toEqual({ size: undefined, from: 'NONE' });
    const result = assess({ activities: [a], target: 100, deadlineDays: 10 }, reading(['t'], 0.91));
    expect(result.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(result.claimsAtLeast90).toBe(false);
    expect(result.range).toBeNull();
  });

  it('still claims from a large real sample', () => {
    const result = assess({ activities: [act('t', { evidence: { sampleSize: 5000 } })], target: 100, deadlineDays: 10 }, reading(['t'], 0.999));
    expect(result.status).toBe('CLAIMS_AT_LEAST_90');
    expect(result.range!.high - result.range!.low).toBeGreaterThan(0);
  });
});
