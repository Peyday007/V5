/**
 * F4 and F6 (adversarial review of the Surge B release, 2026-11-15).
 *
 * F4: an unpriced constructed arrangement was admitted on "comparable" prices
 * that fell back to every price in the project — on production $15 to $325K —
 * swept uniformly, so a dog-groomer arrangement averaged ~$160K a deal and led
 * reach, the leading combination and research priority. Comparable now means
 * comparable (sector, structure, buyer kind, or a pool within one order of
 * magnitude), and an admitted sweep is log-uniform between p10 and p90.
 *
 * F6: the money an opening ties up was inferred from other openings and
 * treated as established, refusing a $15K opening for "tying up" $14,985.
 * Only the opening's own evidence refuses it now.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { comparablePricesFor, ownMechanismCapital, selectEstimatedArrangements, type ComparablePrice, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio, inputEvidence, sampler, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS } from './fixtures/goal10k.ts';

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'groomer',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Pet Care Services',
    demand: { name: 'independent dog groomers', claimId: null, from: 'INDUSTRY_MAP', ref: 'pop_groomers' },
    need: null,
    supply: null,
    label: 'Dog groomers: booking-reminder service',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value', 'conversion'],
    relatedOpenings: [],
    question: 'Who buys booking reminders?',
    ...over,
  } as ConstructedArrangement;
}

/** Production's published prices (plan-0008): free-text industries, nothing in the arrangement's sector. */
const production: ComparablePrice[] = [
  { value: 15, industry: 'online education' },
  { value: 40, industry: 'stock media' },
  { value: 100, industry: 'grant writing' },
  { value: 250, industry: 'residential home improvement, PA' },
  { value: 1_000, industry: 'event tickets' },
  { value: 15_000, industry: 'federal grants' },
  { value: 325_000, industry: 'government RFP' },
  { value: 325_000, industry: 'government RFP (state)' },
  { value: 325_000, industry: 'municipal procurement' },
];
const input = { projectId: 'prj_prod', currency: 'USD', beforeProofCents: 37_500, remaining: 10_000, exclusions: [], daysLeft: 30 };

describe('F4: an unpriced arrangement is admitted only on comparable prices, swept on a log scale', () => {
  it("excludes a sector-less arrangement against production's $15–$325K spread, with the reason recorded", () => {
    const got = comparablePricesFor(arrangement(), production);
    expect(got).toEqual({ refused: 'no comparable price: published prices for other buyers span $15–$325,000' });
    const selected = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: production });
    expect(selected.openings).toHaveLength(0);
    expect(selected.reserve).toHaveLength(0);
    expect(selected.selection.cut[0]!.reason).toBe('nothing reconstructs its value, and no comparable price: published prices for other buyers span $15–$325,000');
  });

  it('admits on same-sector prices, sampled log-uniformly with its median at the geometric middle, never certifiable', () => {
    // Within one order of magnitude (p10 ≈ 122, p90 ≈ 949): a sector wider than that is no comparable either (sameSectorSpread.test.ts).
    const sector: ComparablePrice[] = [100, 150, 300, 600, 900, 1_000].map((value) => ({ value, industry: 'pet care services' }));
    const selected = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: [...production, ...sector] });
    const one = selected.openings[0]!;
    expect(one.estimated?.tier).toBe('MECHANISM');
    expect(one.price).toMatchObject({ value: null, provenance: 'UNKNOWN' });
    expect(one.price.note).toMatch(/same sector \(Pet Care Services\)/);
    for (const field of ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost', 'capital'] as const) expect(inputEvidence(one[field], field).establishes, field).toBe(false);
    const { low, high } = one.price as { low: number; high: number };
    expect(low).toBeGreaterThan(100);
    expect(high).toBeLessThan(1_000);
    const geometric = Math.sqrt(low * high);
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const draw = sampler(one.price, rng);
    const draws = Array.from({ length: 4000 }, draw).sort((a, b) => a - b);
    const median = draws[2000]!;
    expect(median / geometric).toBeGreaterThan(0.9);
    expect(median / geometric).toBeLessThan(1.1);
    // A uniform sweep's median would sit at the arithmetic middle, far above.
    expect(median).toBeLessThan(((low + high) / 2) * 0.75);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(low - 1e-9);
    expect(Math.max(...draws)).toBeLessThanOrEqual(high + 1e-9);
  });

  it('admits on the same structure when its prices lie within an order of magnitude, and not across one', () => {
    const tagged: ComparablePrice[] = [
      { value: 300, industry: 'x', mechanism: 'PRODUCTIZED_SERVICE' },
      { value: 900, industry: 'y', mechanism: 'CAPABILITY_ARBITRAGE' },
      { value: 1_500, industry: 'z', mechanism: 'PRODUCTIZED_SERVICE' },
    ];
    expect(comparablePricesFor(arrangement(), [...production, ...tagged])).toMatchObject({ prices: [300, 900, 1_500], scope: 'with the same structure (PRODUCE)' });
    const wide = [...tagged, { value: 325_000, industry: 'w', mechanism: 'PRODUCTIZED_SERVICE' as const }];
    expect(comparablePricesFor(arrangement(), [...production, ...wide])).toMatchObject({ refused: expect.stringMatching(/^no comparable price/) });
  });

  it('does not inflate reach: the production-spread arrangement adds nothing, where the old uniform sweep did', () => {
    const run = (openings: ModelledOpportunity[]) => evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, openings: openings as PlannedOpening[], worlds: 150, seed: 11 });
    const baseline = run(GOAL_10K_OPENINGS);
    const selected = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: production });
    const now = run([...GOAL_10K_OPENINGS, ...selected.openings]);
    expect(now.best?.reach ?? 0).toBeLessThanOrEqual((baseline.best?.reach ?? 0) + 1e-9);
    expect(now.demand.some((d) => d.opportunityId.startsWith('arr_groomer'))).toBe(false);
    // The pre-fix shape: the same arrangement swept uniformly $15–$325K, capital and cost from its top.
    const sector: ComparablePrice[] = [100, 200].map((value) => ({ value, industry: 'pet care services' }));
    const admitted = selectEstimatedArrangements([arrangement()], { ...input, otherPrices: sector }).openings[0]!;
    const uniform = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
    const old = { ...admitted, price: { ...admitted.price, low: 15, high: 325_000, distribution: undefined }, directCost: uniform(0, 195_000), capital: uniform(0, 325_000) };
    const inflated = run([...GOAL_10K_OPENINGS, old]);
    expect(inflated.demand.find((d) => d.opportunityId === 'arr_groomer')!.price.p50).toBeGreaterThan(100_000);
  });
});

describe('F6: only the opening’s own evidence refuses it for the money it ties up', () => {
  const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
  /** Capital inferred at ~99.9% of a $15,000 price, as production read it. */
  const inferredCapital = (tier: 'DIRECT' | 'COMPARABLE'): ModelInput => ({
    value: null,
    low: 14_900,
    high: 15_000,
    provenance: 'EVIDENCE',
    source: null,
    note: 'inferred as a share of the top price',
    distribution: { kind: 'EMPIRICAL', values: [14_900, 14_985, 15_000] },
    inferred: { tier, justified: true, p10: 14_900, p50: 14_985, p90: 15_000, observations: 3 },
  });
  const grant = (capital: ModelInput) => ({ ...GOAL_10K_OPENINGS[4]!, opportunity: { id: 'cop_grant', title: 'Federal grant application' } as ModelledOpportunity['opportunity'], repeatable: false, price: fixed(15_000), capital });
  const read = (capital: ModelInput) =>
    evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, openings: [grant(capital)] as PlannedOpening[], worlds: 60, seed: 5 }).demand.find((d) => d.opportunityId === 'cop_grant')!;

  it('an outlay inferred from other openings neither refuses nor floors it, and stays unestablished', () => {
    const d = read(inferredCapital('COMPARABLE'));
    expect(d.refused).toBeNull();
    expect(d.capitalAtStart).toBe(GOAL_10K_LIMITS.beforeProof / 2);
    expect(d.unestablished).toContain('money tied up');
    expect(d.justified).toBe(false);
    // NO_FAVOURABLE_UNKNOWN (2026-11-19): that midpoint is exploration only. An estimate held over the limit is never a member.
    expect(d.heldOut).toMatch(/^held out of every combination/);
  });

  it('an estimate held inside the limit is the floor of the range it enters in, never entered below it', () => {
    const inside: ModelInput = { ...inferredCapital('COMPARABLE'), provenance: 'UNKNOWN', low: 280, high: 600, distribution: undefined, inferred: { tier: 'COMPARABLE', justified: false, p10: 300, p50: 420, p90: 600, observations: 3 } };
    const d = read(inside);
    expect(d.heldOut).toBeNull();
    expect(d.refused).toBeNull();
    expect(d.capitalAtStart).toBe((300 + GOAL_10K_LIMITS.beforeProof) / 2);
  });

  it("refuses on the opening's own evidence: its own facts (DIRECT) or a figure on its card", () => {
    expect(read(inferredCapital('DIRECT')).refused).toMatch(/^ties up 14985 at its start/);
    expect(read(fixed(15_000)).refused).toMatch(/^ties up 15000 at its start/);
  });

  it('an inference resting only on other mechanisms is UNKNOWN and swept from nothing', () => {
    const broad: ModelInput = { ...inferredCapital('COMPARABLE'), provenance: 'UNKNOWN', distribution: { kind: 'RANGE', min: 14_000, max: 15_000 }, inferred: { tier: 'MECHANISM', justified: false, p10: 14_000, p50: 14_985, p90: 15_000, observations: 4 } };
    const swept = ownMechanismCapital(broad, 15_000);
    expect(swept).toMatchObject({ value: null, low: 0, high: 15_000, provenance: 'UNKNOWN' });
    expect(swept.inferred).toBeUndefined();
    expect(read(swept).refused).toBeNull();
    // Same-mechanism inferences pass through unchanged.
    expect(ownMechanismCapital(inferredCapital('COMPARABLE'), 15_000)).toEqual(inferredCapital('COMPARABLE'));
  });
});
