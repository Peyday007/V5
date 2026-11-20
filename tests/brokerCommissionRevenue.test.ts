/**
 * Invariant 39 (found while fixing #1190): a constructed BROKER or REFERRAL
 * design was modelled at the BUYER's full price per deal. A broker or referrer
 * keeps only a commission or fee — a share of the deal — and the supplier
 * fulfils and keeps the rest, so the buyer's whole price as Brain's revenue
 * overstated these designs many times over and ranked them above designs Brain
 * produces itself, on money Brain would never collect. The commission was an
 * unknown read as 100%.
 *
 * The rule (`commissionRevenue`, goalScenario.ts): a broker's or referrer's
 * revenue per deal is the share it keeps. A take rate filed for these buyers
 * (`broker_take_rate`) is that share, with its claims as provenance; with none
 * filed the share is swept 5%–20% of the buyer's price as an unestablished
 * assumption, and the plan asks for the commission. Its direct cost and capital
 * are an intermediary's: the supplier's cost and run are never subtracted from
 * the commission a second time. Designs paid the buyer's price are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { COMMISSION_SWEEP, estimatedFromArrangement, modelledTwinKey, populationMarket, screenArrangement, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { inputEvidence, needsOf, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import type { Design } from '../server/services/cash/properties.ts';

const ONE_OFF = (base: Design['base']): Design => ({ base, funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' });

function arrangement(key: string, design: Design, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key,
    structure: design.base,
    design,
    origin: 'FORWARD',
    precedent: null,
    sector: 'Facilities services',
    demand: { name: 'Property managers', claimId: null, from: 'INDUSTRY_MAP', ref: `ind_${key}` },
    need: null,
    supply: null,
    label: `Property managers: ${design.base}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    // These buyers are published paying $1,000 a deal.
    value: { tier: 'DIRECT', p10: 1_000, p50: 1_000, p90: 1_000, observations: 3, sources: ['claim:clm_price'] },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    ...over,
  } as ConstructedArrangement;
}

const input = { projectId: 'prj_broker', currency: 'USD', beforeProofCents: 100_000, daysLeft: 30, remaining: 10_000 };
const fit = { remaining: 10_000, daysLeft: 30, contactsPerDay: 30 };
/** A take rate filed for these buyers from an accepted, sourced claim: 10% of the price. */
const TEN_PERCENT: NonNullable<ConstructedArrangement['commission']> = { tier: 'DIRECT', p10: 0.1, p50: 0.1, p90: 0.1, observations: 1, sources: ['claim:clm_take'] };

describe('a broker or referrer is paid its commission, never the buyer’s price', () => {
  it('(1) with no evidenced commission, a $1,000 deal models well below $1,000, swept conservatively and unestablished', () => {
    for (const base of ['BROKER', 'REFERRAL'] as const) {
      const one = estimatedFromArrangement(arrangement(`no-take-${base}`, ONE_OFF(base)), input)!;
      expect(one).not.toBeNull();
      // The share it keeps: 5%–20% of the buyer's $1,000, never the whole of it.
      expect(one.price.low!).toBeCloseTo(1_000 * COMMISSION_SWEEP.low, 1);
      expect(one.price.high!).toBeCloseTo(1_000 * COMMISSION_SWEEP.high, 1);
      expect(one.price.high!).toBeLessThanOrEqual(200.01);
      expect(one.price.provenance).not.toBe('EVIDENCE');
      expect(one.price.inferred).toMatchObject({ tier: 'ASSUMED', justified: false });
      expect(one.commission).toMatchObject({ basis: 'ASSUMPTION', established: false, low: 0.05, high: 0.2, sources: [] });
      expect(one.commission!.buyerPrice.low).toBeCloseTo(1_000, 6);
      expect(one.price.note).toMatch(/swept 5%–20% of the buyer's price as an assumption/);
      // Every draw is a commission, none of them the buyer's price.
      const values = one.price.distribution?.kind === 'EMPIRICAL' ? one.price.distribution.values : [];
      expect(values.length).toBeGreaterThan(10);
      expect(Math.max(...values)).toBeLessThanOrEqual(200.01);
      // The commission, not the buyer's price, is the research the plan asks.
      const evidence = inputEvidence(one.price, 'price');
      expect(evidence.establishes).toBe(false);
      expect(evidence.need).toMatch(/^commission rate:/);
      expect(needsOf(one).some((need) => /^commission rate:/.test(need))).toBe(true);
      // An intermediary's cost and capital: the supplier fulfils from the buyer's money.
      expect(one.directCost.high!).toBeLessThanOrEqual(200 * 0.6 + 0.01);
      expect(one.capital).toMatchObject({ low: 0, high: 0.01, provenance: 'ASSUMPTION' });
    }
  });

  it('(2) with an evidenced 10% commission, revenue is $100 a deal, carrying that claim', () => {
    const one = estimatedFromArrangement(arrangement('take-10', ONE_OFF('BROKER'), { commission: TEN_PERCENT }), input)!;
    expect(one.price.low!).toBeCloseTo(100, 6);
    expect(one.price.high!).toBeCloseTo(100, 2);
    expect(one.commission).toMatchObject({ basis: 'FILED', established: true, low: 0.1, p50: 0.1, high: 0.1, sources: ['claim:clm_take'] });
    expect(one.price.takeShare).toMatchObject({ established: true });
    expect(one.price.note).toContain('claim:clm_take');
    expect(one.price.note).toMatch(/10% of the buyer's \$1,000/);
    // A filed commission is no commission question.
    expect(inputEvidence(one.price, 'price').need ?? '').not.toMatch(/commission rate/);
    // A commission justified as a distribution, on an evidenced price, is evidence.
    const evidencedPrice = { ...arrangement('take-ev', ONE_OFF('BROKER')).value, evidence: { values: [1_000], low: 1_000, high: 1_000, events: 30, populations: 1, sizedPopulations: 1 } };
    const evidenced = estimatedFromArrangement(
      arrangement('take-ev', ONE_OFF('BROKER'), { value: evidencedPrice, commission: { ...TEN_PERCENT, evidence: { values: [0.1], low: 0.1, high: 0.1, events: 30, populations: 1, sizedPopulations: 1 } } }),
      input,
    )!;
    expect(evidenced.price).toMatchObject({ provenance: 'EVIDENCE' });
    expect(evidenced.price.low!).toBeCloseTo(100, 6);
    expect(evidenced.commission).toMatchObject({ basis: 'EVIDENCE', established: true });
    // Without evidence of the commission, the evidenced price is no evidence of Brain's revenue.
    expect(estimatedFromArrangement(arrangement('take-none-ev', ONE_OFF('BROKER'), { value: evidencedPrice }), input)!.price.provenance).toBe('ASSUMPTION');
  });

  it('(3) designs paid the buyer’s price are unchanged', () => {
    for (const base of ['PRODUCE', 'SUBCONTRACT'] as const) {
      const one = estimatedFromArrangement(arrangement(`paid-${base}`, ONE_OFF(base)), input)!;
      expect(one.commission).toBeUndefined();
      expect(one.price.takeShare).toBeUndefined();
      expect(one.price).toMatchObject({ value: null, low: 1_000, provenance: 'ASSUMPTION' });
      expect(one.price.high!).toBeCloseTo(1_000.01, 6);
      expect(one.directCost).toMatchObject({ provenance: 'UNKNOWN', low: 0 });
      expect(one.directCost.high!).toBeCloseTo(1_000.01 * 0.6, 6);
    }
    // A pooled design that buys the run still bears its observed cost per slot.
    const pooled: Design = { base: 'POOL', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' };
    const run: NonNullable<ConstructedArrangement['fixedCost']> = { tier: 'DIRECT', p10: 4_675, p50: 4_675, p90: 4_675, observations: 1, sources: ['claim:clm_run'] };
    const pool = estimatedFromArrangement(arrangement('pool-run', pooled, { fixedCost: run }), input)!;
    expect(pool.directCost.source?.note).toContain('claim:clm_run');
    // A broker over the same pooled run is not charged the supplier's run out of its commission.
    const broker = estimatedFromArrangement(arrangement('broker-run', { ...pooled, base: 'BROKER' }, { fixedCost: run }), input)!;
    expect(broker.directCost.source?.note ?? '').not.toContain('claim:clm_run');
    expect(broker.directCost.high!).toBeLessThanOrEqual(200 * 0.6 + 0.01);
  });

  it('ranks a broker on its commission, below the same buyers’ produced design, and never as the produced design’s twin', () => {
    const produce = arrangement('rank-produce', ONE_OFF('PRODUCE'));
    const broker = arrangement('rank-broker', ONE_OFF('BROKER'));
    const read = (a: ConstructedArrangement) => {
      const one = estimatedFromArrangement(a, input)! as ModelledOpportunity;
      return { one, screen: screenArrangement(one, a, fit) };
    };
    const p = read(produce);
    const b = read(broker);
    expect(b.screen.value).toBeLessThan(p.screen.value);
    expect(b.screen.upside).toBeLessThanOrEqual(p.screen.upside * COMMISSION_SWEEP.high + 1e-6);
    expect(b.screen.basis).toMatch(/commission \(assumption\)/);
    // One population, one market: the twin key still tells them apart on their economics.
    const market = populationMarket('ind_same');
    expect(modelledTwinKey({ ...b.one, marketKey: market } as PlannedOpening)).not.toBe(modelledTwinKey({ ...p.one, marketKey: market } as PlannedOpening));
  });
});
