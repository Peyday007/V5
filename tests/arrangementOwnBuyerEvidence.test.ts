/**
 * W2b (2026-11-17), review of #1031: an arrangement's links were inferred on a
 * synthetic id only, so evidence about its own buyers never applied; its hours
 * and volume stayed sweeps; and its plan candidate kept costs, capital, timing
 * and the way to the buyer UNKNOWN whatever the evidence said. Every bar stays:
 * a lone published rate is still bounds, another market's volume never
 * transfers, and a swept input never becomes a candidate's field.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { arrangementTarget, estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
import { candidateFromArrangement } from '../server/services/goals/planSet.ts';
import type { CashKnowledge } from '../server/services/quant/knowledge.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const now = new Date('2026-11-17T00:00:00Z');

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'landlord-broker',
    structure: 'BROKER',
    design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE_BUYER', repeat: 'SUBSCRIPTION' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'property services',
    demand: { name: 'Landlords', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_landlords' },
    need: null,
    supply: null,
    label: 'Broker repairs for landlords',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'BOUNDED', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'COMPARABLE', p10: 300, p50: 800, p90: 2_000, observations: 3 },
    unknownParts: ['conversion'],
    // Nothing construction linked: the buyers' own openings are found by who pays.
    relatedOpenings: [],
    question: 'Do landlords buy brokered repairs?',
    ...over,
  } as ConstructedArrangement;
}

/** An opening whose payer is these buyers, sold the second way a BROKER structure is held. */
function opening(id: string, payer: string): CashOpportunity {
  return { id, title: `Repairs ${id}`, mechanism: 'INFORMATION_ASYMMETRY', opportunitySignal: 'ACTIVE_BUYER_DEMAND', industry: 'real estate', payer, priceCents: 90_000, currency: 'USD', duplicateOfId: null } as unknown as CashOpportunity;
}

/** An accepted research claim on an opening's card: an EVIDENCE fact carrying its claim. */
function claim(id: string, opportunityId: string, value: string, field = 'conversionRates'): CashCardFact {
  return { id, projectId: 'prj_w2b', opportunityId, field, kind: 'EVIDENCE', value, claimId: `clm_${id}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } as unknown as CashCardFact;
}

function knowledgeOf(opportunities: CashOpportunity[], facts: CashCardFact[]): CashKnowledge {
  return {
    projectId: 'prj_w2b',
    opportunities: new Map(opportunities.map((one) => [one.id, one])),
    facts,
    lessons: [],
    sources: new Map(),
    watermark: '',
    routeMoney: new Map(),
    routeScores: new Map(),
    routeMoneyError: null,
    estimates: new Map(),
    learning: null,
  } as unknown as CashKnowledge;
}

const input = { projectId: 'prj_w2b', currency: 'USD', beforeProofCents: null, now, daysLeft: 30 };

const rates = (opp: string, tag: string) => [
  claim(`${tag}c`, opp, `Repair brokers closed ${tag === 'a' ? 40 : 46} of 200 qualified landlord leads.`),
  claim(`${tag}r`, opp, `Of 1,000 landlords contacted, ${tag === 'a' ? 60 : 70} of 1000 replied with interest.`),
];

describe('evidence about the arrangement’s own buyers (W2b)', () => {
  it('finds the buyers’ own openings by who pays, and reads them as these buyers', () => {
    const k = knowledgeOf([opening('own_a', 'landlords'), opening('other', 'Dentists')], []);
    const target = arrangementTarget(arrangement(), k, { value: null, low: 300, high: 2_000, provenance: 'ASSUMPTION', source: null, note: '', inferred: { tier: 'COMPARABLE', justified: false, p10: 300, p50: 800, p90: 2_000, observations: 3 } }, 'USD');
    expect(target.sameBuyer).toEqual(['own_a']);
    // The structure's held mechanism its own buyers are sold through, not merely the structure's first.
    expect(target.mechanism).toBe('INFORMATION_ASYMMETRY');
    expect(target.opportunitySignal).toBe('ACTIVE_BUYER_DEMAND');
  });

  it('accepted claims about its own buyers move close and respond to evidence', () => {
    const k = knowledgeOf([opening('own_a', 'Landlords'), opening('own_b', 'landlord')], [...rates('own_a', 'a'), ...rates('own_b', 'b')]);
    const one = estimatedFromArrangement(arrangement(), { ...input, knowledge: k })!;
    for (const field of ['close', 'respond'] as const) {
      expect(one[field].provenance, field).toBe('EVIDENCE');
      expect(one[field].inferred?.justified, field).toBe(true);
      expect(one[field].source, field).toMatchObject({ kind: 'CLAIM' });
    }
  });

  it('the same claims about other buyers do not: the arrangement stays the honest unknown', () => {
    const k = knowledgeOf([opening('other_a', 'Dentists'), opening('other_b', 'Dentists')], [...rates('other_a', 'a'), ...rates('other_b', 'b')]);
    const one = estimatedFromArrangement(arrangement(), { ...input, knowledge: k })!;
    // No opening of these buyers, so the structure's first mechanism: the dentists' evidence is another mechanism, bounds only.
    for (const field of ['close', 'respond'] as const) {
      expect(one[field].provenance, field).not.toBe('EVIDENCE');
      expect(one[field].inferred?.justified ?? false, field).toBe(false);
    }
  });

  it('hours and volume read these buyers’ evidence; another market’s volume never transfers', () => {
    const own = knowledgeOf([opening('own_a', 'Landlords')], [claim('v', 'own_a', 'Landlords place about 20 repair jobs a month.', 'buyerVolume'), claim('h', 'own_a', 'Each repair takes 3 hours to coordinate.', 'hours')]);
    const one = estimatedFromArrangement(arrangement(), { ...input, knowledge: own })!;
    expect(one.volume.provenance).toBe('EVIDENCE');
    expect(one.volume.inferred?.p50).toBeCloseTo(20, 0);
    expect(one.hours.inferred).toBeDefined();
    expect(one.hours.high!).toBeLessThan(40);

    const other = knowledgeOf([opening('other_a', 'Dentists')], [claim('v', 'other_a', 'Dentists place about 20 repair jobs a month.', 'buyerVolume')]);
    const none = estimatedFromArrangement(arrangement(), { ...input, knowledge: other })!;
    expect(none.volume).toMatchObject({ low: 1, provenance: 'UNKNOWN' });
    expect(none.volume.inferred).toBeUndefined();
  });
});

describe('an arrangement’s plan candidate reads its evidenced inputs (W2b)', () => {
  it('takes costs, capital and timing from evidence, and leaves them unknown without it', () => {
    const facts = [
      claim('c1', 'own_a', 'The contractor is paid $200 for the job.', 'directCosts'),
      claim('c2', 'own_b', 'The contractor is paid $220 for the job.', 'directCosts'),
      claim('k1', 'own_a', 'Required capital: $300 before the landlord pays.', 'requiredCapital'),
      claim('k2', 'own_b', 'Required capital: $330 before the landlord pays.', 'requiredCapital'),
      claim('d1', 'own_a', 'Paid within 14 days of completion.', 'timeToFirstCash'),
      claim('d2', 'own_b', 'Paid within 21 days of completion.', 'timeToFirstCash'),
    ];
    const k = knowledgeOf([opening('own_a', 'Landlords'), opening('own_b', 'Landlords')], facts);
    const a = arrangement();
    const modelled = estimatedFromArrangement(a, { ...input, knowledge: k })!;
    const with_ = candidateFromArrangement(a, modelled);
    expect(with_.model.costs.status).not.toBe('UNKNOWN');
    expect(with_.model.costs.basis).toMatch(/direct cost/);
    expect(with_.model.capital.status).not.toBe('UNKNOWN');
    expect(with_.capitalRequired).not.toBeNull();
    expect(with_.model.timing.status).not.toBe('UNKNOWN');
    expect(with_.daysToCash).not.toBeNull();

    const without = candidateFromArrangement(a, estimatedFromArrangement(a, { ...input, knowledge: knowledgeOf([], []) }));
    expect(without.model.costs.status).toBe('UNKNOWN');
    expect(without.model.capital.status).toBe('UNKNOWN');
    expect(without.model.acquisitionRoute.status).toBe('UNKNOWN');
    expect(without.model.controls.status).toBe('UNKNOWN');
    expect(without.daysToCash).toBeNull();
    // And with no conversion at all, exactly as before.
    expect(candidateFromArrangement(a).model.costs.status).toBe('UNKNOWN');
  });
});
