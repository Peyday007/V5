/**
 * Production 2026-11-20 (plan read run 44779626301, goal
 * wst_db2e2e0e5204477692d5, "$5K/month recurring in 60 days, $1,500
 * capital"): the best combination was a QUANT_PORTFOLIO of three constructed
 * arrangements over "Local businesses buying a slot on a shared direct-mail
 * postcard" — arr_dd8c03dc647c (50% of outreach), arr_b1eb99139fbd (25%) and
 * arr_387d4be79ce1 (25%) — with byte-identical demand estimates.
 *
 * They were different designs (`keyOf([designKey(design), demand.ref, …])`,
 * construct.ts): PRODUCE prepaid, BROKER threshold presale, POOL threshold
 * presale, all recurring. But `arrangementOpening` reads a design only through
 * its exposure, whether it repeats and a pooled run's observed cost; all three
 * were SAFE, recurring and unpriced (one MECHANISM sweep over the same
 * comparables), so every input the engine reads was the same draw. The plan
 * split outreach across indistinguishable offers, and the three took every
 * design slot their buyers had ("its buyers already have 3 designs in the
 * model").
 *
 * The rule: designs over one population the model reads identically are one
 * strategy. The first-ranked enters; the others are recorded on it as
 * alternatives, with what differs, and cut with that reason — never
 * discarded unseen (invariant 47). A design the model tells apart still enters.
 *
 * The BROKER sibling was a twin only because the model read its price as the
 * buyer's whole price. A broker keeps a commission (`commissionRevenue`), so
 * its economics differ and it is now told apart; PRODUCE and POOL, both paid
 * the buyer's price, stay one strategy.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { DESIGNS_PER_POPULATION, modelledTwinKey, populationMarket, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio, type PlannedOpening } from '../server/services/goals/portfolio.ts';

type Base = 'PRODUCE' | 'BROKER' | 'REFERRAL' | 'SUBCONTRACT' | 'POOL';
type Funding = 'ON_DELIVERY' | 'PREPAID' | 'THRESHOLD_PRESALE';

const POSTCARD = 'ind_postcard_slot_buyers';

function design(key: string, base: Base, funding: Funding, aggregation: 'SINGLE' | 'POOLED_BUYERS', population = POSTCARD, stress: ConstructedArrangement['stress'] = { exposure: 'SAFE', worstCaseCents: 0, failures: [] }): ConstructedArrangement {
  return {
    key,
    structure: base,
    design: { base, funding, aggregation, repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Shared-cost local advertising',
    demand: { name: 'Local businesses buying a slot on a shared direct-mail postcard', claimId: null, from: 'INDUSTRY_MAP', ref: population },
    need: null,
    supply: null,
    label: `Local businesses buying a slot on a shared direct-mail postcard: ${base} ${funding} ${aggregation}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress,
    evidenced: 1,
    // Nothing prices these buyers: the selection sweeps them over comparable prices (MECHANISM), as production did.
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
  } as unknown as ConstructedArrangement;
}

const siblings = [
  design('dd8c03dc647c', 'PRODUCE', 'PREPAID', 'SINGLE'),
  design('b1eb99139fbd', 'BROKER', 'THRESHOLD_PRESALE', 'POOLED_BUYERS'),
  design('387d4be79ce1', 'POOL', 'THRESHOLD_PRESALE', 'POOLED_BUYERS'),
];
const input = {
  projectId: 'prj_postcard',
  currency: 'USD',
  beforeProofCents: 150_000,
  remaining: 5_000,
  exclusions: [],
  daysLeft: 58,
  otherPrices: [250, 300, 345, 400, 475].map((value) => ({ value, industry: 'Shared-cost local advertising' })),
};
const limits = { remaining: 5_000, daysLeft: 58, capitalCeiling: 1_500, beforeProof: 1_500, perWeek: null, resources: null, worlds: 400 };
const arrangementKey = (o: PlannedOpening) => o.estimated!.arrangementKey;

describe('designs the model reads identically are one strategy', () => {
  it('the production siblings paid the buyer\'s price are different designs with one modelled reading; the broker is told apart', () => {
    // Different construction keys and designs …
    expect(new Set(siblings.map((s) => `${s.design.base}/${s.design.funding}/${s.design.aggregation}`)).size).toBe(3);
    // … and, each read alone, nothing the engine reads tells PRODUCE and POOL apart: only the identity differs.
    const alone = siblings.map((s) => selectEstimatedArrangements([s], input).openings[0]!);
    expect(alone.map(arrangementKey)).toEqual(siblings.map((s) => s.key));
    const [produce, broker, pool] = alone as [PlannedOpening, PlannedOpening, PlannedOpening];
    expect(modelledTwinKey(pool)).toBe(modelledTwinKey(produce));
    // The broker keeps only a commission on the same buyers' price: a different reading, a different strategy.
    expect(modelledTwinKey(broker)).not.toBe(modelledTwinKey(produce));
    expect(broker.commission).toMatchObject({ basis: 'ASSUMPTION', established: false });
    expect(broker.price.high!).toBeLessThan(produce.price.high!);
    // A design with different exposure is read differently.
    const atRisk = design('subcontract01', 'SUBCONTRACT', 'ON_DELIVERY', 'SINGLE', POSTCARD, { exposure: 'BOUNDED', worstCaseCents: 40_000, failures: [] });
    expect(modelledTwinKey(selectEstimatedArrangements([atRisk], input).openings[0]!)).not.toBe(modelledTwinKey(alone[0]!));
  });

  it('enters one member for the twins, not copies splitting outreach, and records the copy as an alternative with what differs', () => {
    const picked = selectEstimatedArrangements(siblings, input);
    const postcard = picked.openings.filter((o) => (o as PlannedOpening).marketKey === populationMarket(POSTCARD));
    // PRODUCE enters; POOL is its copy; the broker, read on its commission, is a strategy of its own.
    expect(postcard.map(arrangementKey)).toContain('dd8c03dc647c');
    expect(postcard.map(arrangementKey)).not.toContain('387d4be79ce1');

    const pick = picked.selection.picked.find((p) => p.arrangementKey === 'dd8c03dc647c')!;
    expect(pick.alternatives!.map((a) => a.arrangementKey)).toEqual(['387d4be79ce1']);
    expect(pick.alternatives![0]!.differs).toMatch(/pool several buyers’ purchases with one supplier and keep part of the volume discount \(a supplier fulfils\) rather than Brain produces it/);
    // The broker is not a copy of it: it is never recorded as one.
    expect(picked.selection.cut.find((c) => c.arrangementKey === 'b1eb99139fbd')?.sameModelAs).toBeUndefined();
    for (const key of ['387d4be79ce1']) {
      const cut = picked.selection.cut.find((c) => c.arrangementKey === key)!;
      expect(cut.sameModelAs).toBe('dd8c03dc647c');
      expect(cut.reason).toMatch(/reads it exactly as dd8c03dc647c/);
    }
    // Never held as a reserve to be brought back as a second copy of itself.
    expect(picked.reserve.map(arrangementKey)).not.toContain('387d4be79ce1');

    const portfolio = evaluateGoalPortfolio({ ...limits, openings: picked.openings });
    const members = portfolio.best!.members.map((m) => m.opportunityId);
    expect(members.filter((id) => id.startsWith('arr_'))).toHaveLength(new Set(members).size);
    expect(members).not.toContain('arr_387d4be79ce1');
  });

  it('frees the design slots for a design the model does tell apart', () => {
    // A SUBCONTRACT design ties money up first: its capital is a different input, so it is a different strategy.
    const atRisk = design('subcontract01', 'SUBCONTRACT', 'ON_DELIVERY', 'SINGLE', POSTCARD, { exposure: 'BOUNDED', worstCaseCents: 40_000, failures: [] });
    const picked = selectEstimatedArrangements([...siblings, atRisk], input);
    const keys = picked.openings.map(arrangementKey);
    expect(keys).toContain('dd8c03dc647c');
    expect(keys).toContain('subcontract01');
    expect(keys.length).toBeLessThanOrEqual(DESIGNS_PER_POPULATION);
    expect(picked.selection.cut.find((c) => c.arrangementKey === 'subcontract01')).toBeUndefined();
  });
});
