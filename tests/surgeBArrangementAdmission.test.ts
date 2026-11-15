/**
 * Surge B (production plan read, 2026-11-15): "estimated arrangements: 0 of
 * 404 (404 cut, 0 in reserve)" and "compared 11 found opening(s) + 0
 * constructed estimate(s)".
 *
 * PRICE-POOL (2026-11-14) rightly stopped handing every held price to every
 * arrangement's own reconstruction, so an arrangement whose buyers have no
 * published price of their own reads value UNKNOWN (or, from the old library,
 * a MECHANISM pool). `estimatedFromArrangement` refuses both, and
 * `selectEstimatedArrangements` cut every such arrangement as "nothing
 * reconstructs its value" — on production that was all 404, so the plan was
 * starved of every constructed strategy. Now such an arrangement enters swept
 * across the prices comparable buyers are published as paying (MECHANISM
 * bounds, provenance UNKNOWN, never certifiable), the S-11 path; one with no
 * price evidence anywhere stays out with its reason.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { comparablePricesFor, selectEstimatedArrangements, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio, inputEvidence, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { GOAL_10K_LIMITS } from './fixtures/goal10k.ts';

type Base = 'PRODUCE' | 'BROKER' | 'SUBCONTRACT' | 'POOL';
function arrangement(i: number, base: Base, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  const key = `${base.toLowerCase()}${String(i).padStart(3, '0')}`;
  return {
    key,
    structure: base,
    design: { base, funding: base === 'POOL' ? 'THRESHOLD_PRESALE' : 'ON_DELIVERY', aggregation: base === 'POOL' ? 'POOLED_BUYERS' : 'SINGLE', repeat: i % 2 ? 'RECURRING_COHORT' : 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: i % 3 === 0 ? 'home improvement' : 'professional services',
    demand: { name: `buyer population ${i % 11}`, claimId: null, from: 'INDUSTRY_MAP', ref: `pop_${i % 11}` },
    need: null,
    supply: null,
    label: `Population ${i % 11}: ${base} design ${i}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
    evidenced: 0,
    // The production shape: nothing prices these buyers themselves.
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value', 'conversion'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    ...over,
  } as ConstructedArrangement;
}

/** 404 arrangements in production's proportions: BROKER 17, PRODUCE 360, SUBCONTRACT 16, POOL 11. */
const mix: Array<[Base, number]> = [
  ['BROKER', 17],
  ['PRODUCE', 360],
  ['SUBCONTRACT', 16],
  ['POOL', 11],
];
let n = 0;
const production: ConstructedArrangement[] = mix.flatMap(([base, count]) =>
  Array.from({ length: count }, () => {
    n += 1;
    // A few library rows still carry the old project-wide MECHANISM pool PRICE-POOL refused as their price.
    return n % 50 === 0 ? arrangement(n, base, { value: { tier: 'MECHANISM', p10: 10, p50: 281, p90: 72_769, observations: 31 } }) : arrangement(n, base);
  }),
);
/**
 * Priced openings held elsewhere in the project — other buyers, not these. The
 * project-wide pool spans 15–15 000, three orders of magnitude, so it is no
 * comparable price (F4); each structure has openings of its own mechanism
 * within one order of magnitude, and home improvement has its sector's.
 */
const held: ComparablePrice[] = [
  { value: 15, industry: 'education' },
  { value: 100, industry: 'grants' },
  { value: 250, industry: 'home improvement' },
  { value: 1_800, industry: 'home improvement' },
  { value: 15_000, industry: 'agriculture' },
  { value: 400, industry: 'marketing', mechanism: 'PRODUCTIZED_SERVICE' },
  { value: 1_500, industry: 'bookkeeping', mechanism: 'PRODUCTIZED_SERVICE' },
  { value: 600, industry: 'staffing', mechanism: 'SUPPLY_DEMAND_MISMATCH' },
  { value: 2_000, industry: 'equipment', mechanism: 'INFORMATION_ASYMMETRY' },
  { value: 1_000, industry: 'cleaning', mechanism: 'SUBCONTRACTED_FULFILMENT' },
  { value: 3_000, industry: 'landscaping', mechanism: 'SUBCONTRACTED_FULFILMENT' },
  { value: 800, industry: 'supplies', mechanism: 'JIGSAW_COMBINATION' },
  { value: 2_500, industry: 'printing', mechanism: 'JIGSAW_COMBINATION' },
];
const input = { projectId: 'prj_prod', currency: 'USD', beforeProofCents: 37_500, remaining: 10_000, exclusions: [], daysLeft: 25 };

describe('Surge B: constructed arrangements with no price of their own are admitted on comparable prices', () => {
  it('reproduces production: with no comparable price, all 404 are cut with a recorded reason', () => {
    const none = selectEstimatedArrangements(production, input);
    expect(none.openings).toHaveLength(0);
    expect(none.reserve).toHaveLength(0);
    expect(none.selection.cutCount).toBe(404);
    for (const c of none.selection.cut) expect(c.reason).toMatch(/nothing reconstructs its value, and nothing bounds what these buyers pay/);
  });

  it('admits them swept over comparable buyers’ published prices, across structures, inside the slot limit', () => {
    const got = selectEstimatedArrangements(production, { ...input, otherPrices: held });
    expect(got.openings.length).toBeGreaterThan(0);
    expect(got.openings.length).toBeLessThanOrEqual(12);
    expect(got.reserve.length).toBeGreaterThan(0);
    // Diversity: more than one base structure takes a slot, not 12 variants of PRODUCE.
    const structures = new Set(got.selection.picked.map((p) => p.slot).filter((s) => s.startsWith('STRUCTURE:')));
    expect(structures.size).toBeGreaterThanOrEqual(3);
    for (const one of got.openings) {
      expect(one.opportunity.id.startsWith('arr_')).toBe(true);
      expect(one.estimated?.tier).toBe('MECHANISM');
      expect(one.estimated?.invented).toBeUndefined();
      expect(one.price).toMatchObject({ value: null, provenance: 'UNKNOWN' });
      // Swept log-uniformly between the comparables' p10 and p90 (F4): a sweep's shape, never evidence.
      expect(one.price.distribution?.kind).toBe('EMPIRICAL');
      // Never certifiable on assumption: no input establishes its link.
      for (const field of ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost', 'capital'] as const) expect(inputEvidence(one[field], field).establishes, field).toBe(false);
    }
    // A home-improvement arrangement is swept over its own sector's prices; others over the project's.
    const home = got.openings.find((o) => /home improvement/.test(o.price.note));
    if (home) {
      expect(home.price.low!).toBeGreaterThanOrEqual(250);
      expect(home.price.high!).toBeLessThanOrEqual(1_800);
    }
    expect(comparablePricesFor({ sector: 'home improvement' }, held)).toMatchObject({ prices: [250, 1_800] });
    expect(comparablePricesFor({ sector: 'professional services', structure: 'SUBCONTRACT' }, held)).toMatchObject({ prices: [1_000, 3_000] });
    // With no sector, structure or buyer in common, a pool spanning 15–15 000 is no comparable price.
    expect(comparablePricesFor({ sector: 'professional services' }, held)).toMatchObject({ refused: expect.stringMatching(/^no comparable price: published prices for other buyers span \$15–\$15,000/) });

    // The plan's `compared` line: N > 0 constructed estimates reach the quant engine, and a combination holding one is coverage only.
    const p = evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, daysLeft: 25, openings: got.openings as PlannedOpening[], worlds: 120, seed: 3 });
    const estimates = p.demand.filter((d) => d.opportunityId.startsWith('arr_'));
    expect(estimates.length).toBeGreaterThan(0);
    expect(p.basis).toBe('COVERAGE');
  });

  it('keeps a priced arrangement ahead of a swept one (weaker evidence never ranks higher)', () => {
    const priced = arrangement(999, 'BROKER', { key: 'priced', value: { tier: 'COMPARABLE', p10: 400, p50: 900, p90: 1_600, observations: 4 }, demand: { name: 'priced buyers', claimId: null, from: 'INDUSTRY_MAP', ref: 'pop_priced' } });
    const got = selectEstimatedArrangements([...production.slice(0, 40), priced], { ...input, otherPrices: held });
    const p = got.openings.find((o) => o.estimated?.arrangementKey === 'priced');
    expect(p?.estimated?.tier).toBe('COMPARABLE');
    expect(got.selection.picked[0]!.arrangementKey).toBe('priced');
  });

  it('still leaves out a design whose known worst case exceeds the limits', () => {
    const over = arrangement(1, 'PRODUCE', { stress: { exposure: 'EXCEEDS', worstCaseCents: 900_000, failures: [] } });
    const got = selectEstimatedArrangements([over], { ...input, otherPrices: held });
    expect(got.openings).toHaveLength(0);
    expect(got.selection.cut[0]!.reason).toMatch(/worst case exceeds/);
  });
});
