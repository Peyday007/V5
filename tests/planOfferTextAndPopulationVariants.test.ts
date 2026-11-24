/**
 * Independent audit of the production plan read for the $10K goal
 * (wst_7b4fcbb5f2384f31b6c3), 2026-11-24. Two defects:
 *
 * 1. OFFER-TEXT SPLICING. Steps read Offer "what this buyer pays per unit of
 *    work as published The NameExperts blog page 'domain-name-", Brain
 *    produces "business document for …" that, and a buyer label became
 *    "domain buyer or seller — what this buyer pays per unit of wo…". A price
 *    fact's whole `measures` — the back-fill's framing plus the claim's words
 *    about its source — was read as what the buyers pay for
 *    (`paidForParts`). Only the object of a stated payment is an offer now;
 *    a sentence naming none leaves the need unknown, said plainly.
 *
 * 2. DUPLICATE BUYER GROUPS. arr_7c86bd58f732 (one-off) and arr_41db2c7bf63f
 *    (subscription) were one buyer kind, one demand row and one price, and
 *    both were counted as legs. Designs that are one offer to one population
 *    at one price differing only in repeat are one leg: the better enters and
 *    the other is recorded as its variant.
 */
import { describe, expect, it } from 'vitest';
import { paidForParts, paidForUnit, type ConstructedArrangement, type PaidFor } from '../server/services/cash/construct.ts';
import { populationMarket, samePopulationOfferKey, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import type { PlannedOpening } from '../server/services/goals/portfolio.ts';

const SPLICED = "what this buyer pays per unit of work, as published: The NameExperts blog page 'domain-name-pricing-guide' lists premium domain names at $2,500 to $10,000";

describe('an offer is what a price buys, never the evidence that priced it', () => {
  it('reads the object of a stated payment out of a fact sentence', () => {
    expect(paidForUnit('a dental practice pays $220 per compliance report')).toBe('compliance report');
    expect(paidForUnit('a homeowner pays $6,000 to replace an asphalt roof')).toBe('replace an asphalt roof');
    expect(paidForUnit('what this buyer pays per unit of work, as published: Small law firms pay $1,500 for a website redesign, according to Clio')).toBe('website redesign');
  });

  it('never reads a back-fill framing, a source description or a rate unit as the offer', () => {
    expect(paidForUnit(SPLICED)).toBeNull();
    expect(paidForUnit('what this buyer pays per unit of work, as published')).toBeNull();
    expect(paidForUnit(`answering Brain's price question about "domain buyer or seller": The NameExperts blog page says brokers charge $50 per the published rate card`)).toBeNull();
    expect(paidForUnit('Agencies charge $500 per month')).toBeNull();
    expect(paidForUnit('')).toBeNull();
    expect(paidForUnit(null)).toBeNull();
  });

  it('a population shown only by a spliced fact has no need named, so its design says it is not yet specified', () => {
    const facts: PaidFor[] = [
      { payer: 'domain buyer or seller', name: SPLICED, claimId: 'clm_ne', ref: 'fact:1' },
      { payer: 'Dental practices', name: 'a dental practice pays $220 per compliance report', claimId: 'clm_d', ref: 'fact:2' },
    ];
    const parts = new Map(paidForParts([], facts));
    const every = [...parts.values()].flat();
    for (const one of every) {
      expect(one.name).not.toMatch(/what this buyer pays|per unit of work|NameExperts|blog page/i);
    }
    expect([...parts.keys()].some((k) => k.includes('domain'))).toBe(false);
    expect(every.map((one) => one.name)).toEqual(['compliance report']);
  });
});

const DOMAINS = 'ind_domain_buyer_or_seller';

function design(key: string, repeat: 'ONE_OFF' | 'RECURRING_COHORT'): ConstructedArrangement {
  return {
    key,
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Domain names',
    demand: { name: 'domain buyer or seller', claimId: null, from: 'INDUSTRY_MAP', ref: DOMAINS },
    need: null,
    supply: null,
    label: `domain buyer or seller: Brain produces it and charges a fee (${repeat})`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
  } as unknown as ConstructedArrangement;
}

const input = {
  projectId: 'prj_domains',
  currency: 'USD',
  beforeProofCents: 300_000,
  remaining: 10_000,
  exclusions: [],
  daysLeft: 60,
  otherPrices: [250, 300, 345, 400, 475].map((value) => ({ value, industry: 'Domain names' })),
};
const arrangementKey = (o: PlannedOpening) => o.estimated!.arrangementKey;

describe('one buyer population at one price is one leg, whatever its repeat', () => {
  const oneOff = design('7c86bd58f732', 'ONE_OFF');
  const subscription = design('41db2c7bf63f', 'RECURRING_COHORT');

  it('the one-off and the subscription share one offer key', () => {
    const [a] = selectEstimatedArrangements([oneOff], input).openings as PlannedOpening[];
    const [b] = selectEstimatedArrangements([subscription], input).openings as PlannedOpening[];
    expect(a && b).toBeTruthy();
    expect(a!.repeatable).not.toBe(b!.repeatable);
    expect(samePopulationOfferKey(oneOff, a!)).toBe(samePopulationOfferKey(subscription, b!));
  });

  it('enters one of them and records the other as its variant, never a second leg or a reserve', () => {
    const picked = selectEstimatedArrangements([oneOff, subscription], input);
    const domains = picked.openings.filter((o) => (o as PlannedOpening).marketKey === populationMarket(DOMAINS));
    expect(domains).toHaveLength(1);
    const kept = arrangementKey(domains[0] as PlannedOpening);
    const other = kept === oneOff.key ? subscription.key : oneOff.key;
    const cut = picked.selection.cut.find((c) => c.arrangementKey === other)!;
    expect(cut.variantOf).toBe(kept);
    expect(cut.reason).toMatch(/same offer to the same buyers at the same price/);
    const pick = picked.selection.picked.find((p) => p.arrangementKey === kept)!;
    expect(pick.alternatives!.map((a) => a.arrangementKey)).toEqual([other]);
    expect(pick.alternatives![0]!.differs).toMatch(/repeats/);
    expect(picked.reserve.map((o) => arrangementKey(o as PlannedOpening))).not.toContain(other);
  });

  it('a different buyer population with the same design is still its own leg', () => {
    const elsewhere = { ...design('a1b2c3d4e5f6', 'RECURRING_COHORT'), demand: { name: 'dental practices', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_dental' } } as unknown as ConstructedArrangement;
    const picked = selectEstimatedArrangements([oneOff, elsewhere], input);
    expect(picked.openings.map((o) => arrangementKey(o as PlannedOpening)).sort()).toEqual([oneOff.key, elsewhere.key].sort());
  });
});
