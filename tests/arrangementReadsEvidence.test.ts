/**
 * F2 (2026-11-17): the $10K goal's plan (wst_7b4fcbb5f2384f31b6c3) is built
 * mostly from constructed arrangements, and every link of one was a hard-coded
 * sweep — price an ASSUMPTION, close, reply, days to cash, direct cost and
 * capital UNKNOWN — so accepted research could never move it. An arrangement's
 * links now read the project's evidence through the same inference found
 * openings use, and its price carries the reconstruction's distribution when
 * that is justified. Where nothing bears on a link, it stays what it was.
 */
import { describe, expect, it } from 'vitest';
import { valueEvidence, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { arrangementTarget, estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import type { CashKnowledge } from '../server/services/quant/knowledge.ts';
import type { QuantityNode } from '../server/domain/quant.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const now = new Date('2026-11-17T00:00:00Z');

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'landlord-broker',
    structure: 'BROKER',
    design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE_BUYER', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'property services',
    demand: { name: 'landlords', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_landlords' },
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
    relatedOpenings: ['opp_a', 'opp_b'],
    question: 'Do landlords buy brokered repairs?',
    ...over,
  } as ConstructedArrangement;
}

/** Two openings for the same buyers, sold the way a BROKER structure is held. */
function opening(id: string): CashOpportunity {
  return { id, title: `Landlord repairs ${id}`, mechanism: 'SUPPLY_DEMAND_MISMATCH', opportunitySignal: 'ACTIVE_BUYER_DEMAND', industry: 'property services', priceCents: 90_000, currency: 'USD', duplicateOfId: null } as unknown as CashOpportunity;
}

/** An accepted research claim on an opening's card: an EVIDENCE fact carrying its claim. */
function claim(id: string, opportunityId: string, value: string): CashCardFact {
  return { id, projectId: 'prj_f2', opportunityId, field: 'conversionRates', kind: 'EVIDENCE', value, claimId: `clm_${id}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } as unknown as CashCardFact;
}

function knowledgeOf(facts: CashCardFact[]): CashKnowledge {
  return {
    projectId: 'prj_f2',
    opportunities: new Map([opening('opp_a'), opening('opp_b')].map((one) => [one.id, one])),
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

const input = { projectId: 'prj_f2', currency: 'USD', beforeProofCents: null, now };

describe('an arrangement reads accepted evidence (F2)', () => {
  it('is inferred as the population its structure is sold to: its related openings’ mechanism', () => {
    const target = arrangementTarget(arrangement(), knowledgeOf([]), { value: null, low: 300, high: 2_000, provenance: 'ASSUMPTION', source: null, note: '', inferred: { tier: 'COMPARABLE', justified: false, p10: 300, p50: 800, p90: 2_000, observations: 3 } }, 'USD');
    expect(target).toMatchObject({ id: 'arr_landlord-broker', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'property services', priceCents: 80_000 });
  });

  it('without a claim, its close rate stays the honest unknown sweep', () => {
    const none = estimatedFromArrangement(arrangement(), { ...input, knowledge: knowledgeOf([]) })!;
    expect(none.close).toMatchObject({ value: null, low: 0.02, high: 0.5, provenance: 'UNKNOWN' });
    expect(none.close.inferred).toBeUndefined();
    expect(inputEvidence(none.close, 'close').establishes).toBe(false);
    // And with no knowledge at all, exactly as before.
    expect(estimatedFromArrangement(arrangement(), input)!.close).toMatchObject({ low: 0.02, high: 0.5, provenance: 'UNKNOWN' });
  });

  it('an accepted, sized claim about these buyers’ close rate makes the arrangement’s close evidence-backed', () => {
    const facts = [
      claim('f1', 'opp_a', 'Landlord repair brokers closed 40 of 200 qualified leads.'),
      claim('f2', 'opp_b', 'Of property managers pitched, 44 of 200 leads closed and signed.'),
    ];
    const one = estimatedFromArrangement(arrangement(), { ...input, knowledge: knowledgeOf(facts) })!;
    expect(one.close.provenance).toBe('EVIDENCE');
    expect(one.close.inferred).toMatchObject({ tier: 'COMPARABLE', justified: true });
    expect(one.close.distribution?.kind).toBe('EMPIRICAL');
    expect(one.close.source).toMatchObject({ kind: 'CLAIM' });
    // The engine reads it as an evidenced, drawable input, not a sweep.
    expect(inputEvidence(one.close, 'close')).toMatchObject({ drawable: true });
    // A link nothing speaks to is untouched.
    expect(one.daysToCash).toMatchObject({ low: 3, high: 60, provenance: 'UNKNOWN' });
  });

  it('a justified reconstruction of what these buyers pay makes the price evidence, not an assumption', () => {
    const node: QuantityNode = {
      key: 'a_value',
      label: 'price',
      unit: 'USD',
      kind: 'POSITIVE',
      min: 0,
      max: 1_000_000,
      context: { payer: 'landlords' },
      material: [],
      observations: ['c1', 'c2', 'c3', 'c4'].map((id, i) => ({
        id,
        value: { kind: 'POINT' as const, value: 700 + i * 100 },
        context: { payer: 'landlords' },
        lineage: [`claim:${id}`],
        source: { kind: 'CLAIM' as const, ref: id },
        broad: false,
        measures: 'what landlords paid for a brokered repair',
      })),
    };
    const est = reconstruct({ nodes: [node] }, 'a_value', now).estimates['a_value']!;
    const evidence = valueEvidence(est).evidence;
    expect(evidence).toBeDefined();
    const priced = estimatedFromArrangement(arrangement({ value: { tier: est.tier, p10: est.p10, p50: est.p50, p90: est.p90, observations: 4, evidence } }), input)!;
    expect(priced.price.provenance).toBe('EVIDENCE');
    expect(priced.price.inferred?.justified).toBe(true);
    expect(priced.price.distribution?.kind).toBe('EMPIRICAL');
    expect(inputEvidence(priced.price, 'price').drawable).toBe(true);
    // The same arrangement without that evidence is still the assumption it was.
    const assumed = estimatedFromArrangement(arrangement(), input)!;
    expect(assumed.price.provenance).toBe('ASSUMPTION');
    expect(assumed.price.inferred?.justified).toBe(false);
    // A transfer nobody has bridged never borrows it.
    const transfer = estimatedFromArrangement(arrangement({ origin: 'TRANSFER', precedent: { opportunityId: 'opp_a', title: 'x' }, differences: ['legal context'], value: { tier: est.tier, p10: est.p10, p50: est.p50, p90: est.p90, observations: 4, evidence } }), input)!;
    expect(transfer.price.provenance).toBe('ASSUMPTION');
  });
});
