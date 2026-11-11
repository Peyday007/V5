/**
 * CAUSAL-14-2 / CAUSAL-14-5: a signed contract is not settled cash, and a
 * claim of at least 90% rests only on calibrated evidence. An opening whose
 * value a buyer already agreed still draws whether its counterparty pays, so a
 * fixed days-to-cash term is not an infinite sample of settlements.
 */
import { describe, expect, it } from 'vitest';
import { assess, effectiveSample, type Activity, type PortfolioReading } from '../server/services/quant/portfolio.ts';
import { evaluateGoalPortfolio, sampleSizeOf } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
const opp = { id: 'a', projectId: 'prj_a', title: 'Signed job', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning', currency: 'USD', priceCents: 400_000, duplicateOfId: null } as CashOpportunity;
const agreed = (daysToCash: ModelInput): ModelledOpportunity =>
  ({
    opportunity: opp, index: 1, tier: 'QUALIFIED', repeatable: false, price: fixed(4000), capital: fixed(0), hours: fixed(2), daysToCash,
    close: fixed(1), respond: fixed(1), directCost: fixed(500), volume: fixed(1), agreed: true, agreedValue: 4000, agreedDeals: 1, fulfilledBy: null, competitiveAward: false,
  }) as ModelledOpportunity;

describe('an agreed value is not settled cash', () => {
  it('a fixed days-to-cash term states no sample of settlements', () => {
    expect(sampleSizeOf(agreed(fixed(14)))).toBeUndefined();
  });

  it('settlements actually observed are the sample', () => {
    const inferred: ModelInput = { ...fixed(14), inferred: { observations: 37 } } as ModelInput;
    expect(sampleSizeOf(agreed(inferred))).toBe(37);
  });

  it('assess never reads an infinite sample as calibration', () => {
    const reading: PortfolioReading = { keys: ['a'], reach: 0.91, settledP10: 10, settledP50: 50, settledP90: 90, capitalShort: 0, overSpend: 0, feasible: true, infeasibleBecause: null, basis: 'PROBABILITY' };
    const one: Activity = { key: 'a', label: 'a', cash: [100], days: [1], justified: true, evidence: { sampleSize: Number.POSITIVE_INFINITY } };
    expect(effectiveSample(one).from).toBe('NONE');
    const result = assess({ activities: [one], target: 100, deadlineDays: 10 }, reading);
    expect(result.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(result.claimsAtLeast90).toBe(false);
    expect(result.range).toBeNull();
  });

  it('a goal met only by a signed contract does not claim at least 90%', () => {
    const out = evaluateGoalPortfolio({ remaining: 3000, daysLeft: 30, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 200, seed: 1, openings: [agreed(fixed(14))], knowledge: null });
    expect(out.assurance!.status).not.toBe('CLAIMS_AT_LEAST_90');
    expect(out.assurance!.claimsAtLeast90).toBe(false);
  });
});
