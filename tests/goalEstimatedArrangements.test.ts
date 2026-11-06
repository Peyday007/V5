/**
 * Commercial selection (owner, 2026-11-06): constructed arrangements compete in
 * the $10K portfolio on their reconstructed estimates, a high price with an
 * unknown outlay is not refused for the unknown, and the estimate never counts
 * as evidence. Production read 404 constructed arrangements and a plan built
 * from one-off $50 openings, because none of the arrangements could reach the
 * model and every opening priced above $375 was refused for an outlay nobody
 * had measured.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import {
  estimatedFromArrangement,
  isArrangementId,
  pickEstimatedArrangements,
  priceSupported,
  type ModelledOpportunity,
} from '../server/services/cash/goalScenario.ts';
import { capitalAtStart, evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';

function arrangement(over: Partial<ConstructedArrangement> & { key: string; p50: number; repeat?: 'ONE_OFF' | 'RECURRING_COHORT' | 'SUBSCRIPTION' }): ConstructedArrangement {
  const { p50, repeat = 'ONE_OFF', ...rest } = over;
  return {
    structure: 'BROKER',
    design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat },
    origin: 'FORWARD',
    precedent: null,
    sector: 'property services',
    demand: { name: 'landlords', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_1' },
    need: null,
    supply: null,
    label: `Broker work for ${over.key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier: 'MECHANISM', p10: p50 / 4, p50, p90: p50 * 3, observations: 12 },
    unknownParts: ['buyers', 'conversion'],
    relatedOpenings: [],
    question: `Who buys brokered work for ${over.key}?`,
    ...rest,
  } as ConstructedArrangement;
}

const base = { projectId: 'prj_x', currency: 'USD', beforeProofCents: 37_500 };

describe('a constructed arrangement as an estimate', () => {
  it('enters on its reconstruction, labelled, never as a supported price', () => {
    const one = estimatedFromArrangement(arrangement({ key: 'k1', p50: 400, repeat: 'SUBSCRIPTION' }), base)!;
    expect(isArrangementId(one.opportunity.id)).toBe(true);
    expect(one.estimated).toMatchObject({ arrangementKey: 'k1', tier: 'MECHANISM', observations: 12 });
    expect(one.price).toMatchObject({ value: null, low: 100, high: 1200, provenance: 'ASSUMPTION' });
    expect(one.price.inferred?.justified).toBe(false);
    expect(priceSupported(one)).toBe(false);
    // Recurring by design: repeatable, its volume a range from one deal, never assumed.
    expect(one.repeatable).toBe(true);
    expect(one.volume).toMatchObject({ value: null, low: 1, provenance: 'UNKNOWN' });
    // Nothing about a buyer is established.
    expect(one.opportunity.reachableChannel).toBeNull();
    expect(one.opportunity.buyingSignal).toBeNull();
  });

  it('is left out when nothing reconstructs its value or its known worst case breaks the limits', () => {
    expect(estimatedFromArrangement(arrangement({ key: 'u', p50: 0, value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 } }), base)).toBeNull();
    expect(estimatedFromArrangement(arrangement({ key: 'x', p50: 300, stress: { exposure: 'EXCEEDS', worstCaseCents: 90_000, failures: [] } }), base)).toBeNull();
  });

  it('is picked by what it could put toward the whole goal, not by how small or easy it is', () => {
    const picked = pickEstimatedArrangements(
      [
        arrangement({ key: 'tiny-oneoff', p50: 50 }),
        arrangement({ key: 'mid-oneoff', p50: 2_000 }),
        arrangement({ key: 'recurring', p50: 300, repeat: 'RECURRING_COHORT' }),
      ],
      { ...base, remaining: 10_000, exclusions: [] },
    );
    expect(picked.map((one) => one.estimated!.arrangementKey)).toEqual(['recurring', 'mid-oneoff', 'tiny-oneoff']);
  });

  it('keeps the owner’s exclusions and the operating rule', () => {
    const picked = pickEstimatedArrangements(
      [
        arrangement({ key: 'gov', p50: 5_000, label: 'Broker federal procurement bids for agencies', demand: { name: 'federal agencies', claimId: null, from: 'INDUSTRY_MAP', ref: 'g' } }),
        arrangement({ key: 'mow', p50: 5_000, label: 'Lawn mowing for homeowners', question: 'Who wants mowing?' }),
        arrangement({ key: 'moves', p50: 600, label: 'Book moves online and dispatch the jobs to independent movers for a commission', question: 'Who books moves?' }),
      ],
      { ...base, remaining: 10_000, exclusions: ['GOVERNMENT_CONTRACTING'] },
    );
    expect(picked.map((one) => one.estimated!.arrangementKey)).toEqual(['moves']);
  });
});

describe('judged on what it is, not on the instructions in its question', () => {
  it('is not excluded by the exclusion sentence and operating rule its own research question carries', () => {
    const question =
      'Who buys brokered tenant screening for landlords? Leave out government and public-sector contracts: the goal’s owner excluded them. ' +
      'The owner does no physical work — no travel, no deliveries, no meeting customers in person.';
    const picked = pickEstimatedArrangements([arrangement({ key: 'screening', p50: 120, repeat: 'SUBSCRIPTION', question })], {
      ...base,
      remaining: 10_000,
      exclusions: ['GOVERNMENT_CONTRACTING'],
    });
    expect(picked.map((one) => one.estimated!.arrangementKey)).toEqual(['screening']);
  });
});

describe('the portfolio compares them with what was found', () => {
  const found = (id: string, price: number, capitalHigh: number | null): ModelledOpportunity => {
    const one = estimatedFromArrangement(arrangement({ key: id, p50: price }), base)!;
    return {
      ...one,
      estimated: undefined,
      opportunity: { ...one.opportunity, id: `cop_${id}`, title: id },
      tier: 'EVIDENCED',
      price: { value: price, low: price, high: price, provenance: 'EVIDENCE', source: null, note: 'card' },
      capital:
        capitalHigh === null
          ? { value: 500, low: 500, high: 500, provenance: 'EVIDENCE', source: null, note: 'established' }
          : { value: null, low: 0, high: capitalHigh, provenance: 'UNKNOWN', source: null, note: 'swept' },
    };
  };

  it('does not refuse a high-priced opening for an outlay nobody has measured, and still refuses a measured one', () => {
    const unknownOutlay = found('service-1500', 1_500, 1_500);
    const measured = found('needs-500', 3_450, null);
    const portfolio = evaluateGoalPortfolio({ openings: [unknownOutlay, measured], remaining: 10_000, daysLeft: 21, capitalCeiling: 3_000, beforeProof: 375, perWeek: 750, resources: null, worlds: 400 });
    const byId = new Map(portfolio.demand.map((one) => [one.opportunityId, one]));
    expect(byId.get('cop_service-1500')!.refused).toBeNull();
    // Within the per-arrangement limit (the middle of what it allows) and still unestablished.
    expect(byId.get('cop_service-1500')!.capitalAtStart).toBe(187.5);
    expect(byId.get('cop_service-1500')!.unestablished).toContain('money tied up');
    expect(byId.get('cop_needs-500')!.refused).toMatch(/ties up 500 at its start, more than the 375/);
    expect(capitalAtStart(unknownOutlay)).toEqual({ amount: 1_500, established: false });
  });

  it('chooses members by contribution to the whole goal, and calls the result coverage while estimates are in it', () => {
    const tiny = found('sudoku-50', 50, 50);
    const recurring = estimatedFromArrangement(arrangement({ key: 'recurring', p50: 400, repeat: 'SUBSCRIPTION' }), base)!;
    const portfolio = evaluateGoalPortfolio({ openings: [tiny, recurring], remaining: 10_000, daysLeft: 21, capitalCeiling: 3_000, beforeProof: 375, perWeek: 750, resources: null, worlds: 400 });
    const best = portfolio.best!.members.map((one) => one.opportunityId);
    expect(best.some(isArrangementId)).toBe(true);
    const settledP90 = portfolio.best!.settledP90;
    const tinyOnly = evaluateGoalPortfolio({ openings: [tiny], remaining: 10_000, daysLeft: 21, capitalCeiling: 3_000, beforeProof: 375, perWeek: 750, resources: null, worlds: 400 });
    expect(settledP90).toBeGreaterThan(tinyOnly.best?.settledP90 ?? 0);
    // An estimate is never a probability.
    expect(portfolio.basis).toBe('COVERAGE');
  });
});
