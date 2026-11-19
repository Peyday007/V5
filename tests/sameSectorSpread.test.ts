/**
 * Production 2026-11-19: nearly every constructed arrangement with no price of
 * its own was modelled at price p50 ≈ $2,569 — the geometric middle of a
 * log-uniform sweep over one sector's published prices, p10 $42 to p90
 * $156,737 — because the same-sector scope of `comparablePricesFor` was the
 * one scope with no spread check. The blind direct cost was then "nothing to
 * 60% of the top price", so each such arrangement carried a cost p50 of
 * $47,021 against its $2,569 price, and a $100K goal read p50 $185,840 at 0.4%
 * reach.
 *
 * A sector is held to one order of magnitude like every other scope, and a
 * swept price's blind cost is a share of that price's own middle.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { COMPARABLE_SPREAD_MAX, comparablePricesFor, selectEstimatedArrangements, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'svc',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Professional Services',
    demand: { name: 'regional accounting firms', claimId: null, from: 'INDUSTRY_MAP', ref: 'pop_acct' },
    need: null,
    supply: null,
    label: 'Accounting firms: client onboarding packets',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value', 'conversion'],
    relatedOpenings: [],
    question: 'What do accounting firms pay for onboarding packets?',
    ...over,
  } as ConstructedArrangement;
}

/** Production's shape: one sector whose published prices put p10 at $42 and p90 at $156,737 (11 prices, so both quantiles land on a price). */
const PRODUCTION_SECTOR = [20, 42, 100, 300, 900, 2_569, 8_000, 25_000, 60_000, 156_737, 300_000];
const productionPrices: ComparablePrice[] = PRODUCTION_SECTOR.map((value) => ({ value, industry: 'professional services' }));
const input = { projectId: 'prj_prod', currency: 'USD', beforeProofCents: 300_000, remaining: 100_000, exclusions: [], daysLeft: 60 };

describe('a sector spanning orders of magnitude is no comparable price', () => {
  it("refuses the production pool ($42–$156,737 at p10–p90): the price stays the research question, with the sector's span in the reason", () => {
    expect(156_737 / 42).toBeGreaterThan(COMPARABLE_SPREAD_MAX);
    const got = comparablePricesFor(arrangement(), productionPrices);
    expect(got).toEqual({ refused: 'no comparable price: published prices for other buyers span $20–$300,000; in the same sector (Professional Services) they span $20–$300,000' });
    const selected = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: productionPrices });
    expect(selected.openings).toHaveLength(0);
    expect(selected.reserve).toHaveLength(0);
    expect(selected.selection.cut[0]!.reason).toMatch(/^nothing reconstructs its value, and no comparable price: .*same sector \(Professional Services\) they span \$20–\$300,000$/);
  });

  it('a wide sector falls through to a narrower comparable scope that is within one order of magnitude', () => {
    const structure: ComparablePrice[] = [
      { value: 400, industry: 'a', mechanism: 'PRODUCTIZED_SERVICE' },
      { value: 900, industry: 'b', mechanism: 'PRODUCTIZED_SERVICE' },
      { value: 1_500, industry: 'c', mechanism: 'PRODUCTIZED_SERVICE' },
    ];
    expect(comparablePricesFor(arrangement(), [...productionPrices, ...structure])).toEqual({ prices: [400, 900, 1_500], scope: 'with the same structure (PRODUCE)' });
  });

  it('a sector within one order of magnitude is still admitted, swept over its p10–p90, never certifiable', () => {
    const tight: ComparablePrice[] = [800, 1_000, 1_500, 2_000, 3_000, 4_000].map((value) => ({ value, industry: 'professional services' }));
    expect(comparablePricesFor(arrangement(), tight)).toMatchObject({ scope: 'in the same sector (Professional Services)' });
    const one = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: tight }).openings[0]!;
    expect(one.price).toMatchObject({ value: null, provenance: 'UNKNOWN' });
    expect(one.price.high! / one.price.low!).toBeLessThanOrEqual(COMPARABLE_SPREAD_MAX);
    for (const field of ['price', 'directCost', 'capital'] as const) expect(inputEvidence(one[field], field).establishes, field).toBe(false);
  });
});

describe("a swept price's blind direct cost is a share of that price, not of the pool's top", () => {
  it('reads the cost at nothing to 60% of the swept price’s geometric middle, so its median is 30% of the price’s', () => {
    const tight: ComparablePrice[] = [800, 1_000, 1_500, 2_000, 3_000, 4_000].map((value) => ({ value, industry: 'professional services' }));
    const one = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: tight }).openings[0]!;
    const priceP50 = one.price.inferred!.p50;
    expect(priceP50).toBeCloseTo(Math.sqrt(one.price.low! * one.price.high!), 6);
    expect(one.directCost).toMatchObject({ value: null, low: 0, provenance: 'UNKNOWN' });
    expect(one.directCost.high).toBeCloseTo(priceP50 * 0.6, 6);
    expect(one.directCost.note).toMatch(/60% of the swept price's geometric middle/);
    // Before: 60% of the top price, a cost median of 0.3 × p90 against a price median of √(p10·p90).
    expect(((one.directCost.low! + one.directCost.high!) / 2) / priceP50).toBeCloseTo(0.3, 6);
    // Capital still bounds exposure at the top of the price's range.
    expect(one.capital.high).toBeCloseTo(one.price.high!, 6);
  });
});
