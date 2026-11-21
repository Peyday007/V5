/**
 * Lens S (Surge B, 2026-11-14): a plan must not fail because its strongest
 * strategy was excluded by an arbitrary early cutoff.
 *
 * Before, `pickEstimatedArrangements` scored every repeatable design
 * `min(remaining, p50 × deals)`, which saturates at the remaining amount for
 * any design priced above remaining/200, and broke the tie on the opportunity
 * id (`arr_` + a sha256 of the key). Which 12 of up to 404 constructed
 * arrangements a plan could ever use was decided by the hash, a $9,000 DIRECT
 * one-off lost to every $300 repeatable design, and the engine's preferred
 * arrangement was cut before any later stage could see it. These are lens S's
 * experiment, kept as the regression, plus the repairs around it (S-5, S-6,
 * S-7, S-8, S-12, S-17).
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import {
  ARRANGEMENT_ID_PREFIX,
  DESIGNS_PER_POPULATION,
  estimatedFromArrangement,
  MAX_BUYERS_OFFERED,
  MAX_ESTIMATED_ARRANGEMENTS,
  pickEstimatedArrangements,
  populationMarket,
  screenArrangement,
  selectEstimatedArrangements,
  type ModelInput,
  type ModelledOpportunity,
} from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { abstractDirection, applyProgram, inScope, makeDirection, parseInvented, resolveRoles, rolesOf, seedDirections, type Direction, type Exploration } from '../server/services/goals/reasoning/directions.ts';
import { rankValue, valuePerInterested } from '../server/services/goals/reasoning/rank.ts';
import { lessonOf } from '../server/services/goals/reasoning/learning.ts';
import type { StrategyState, VariantReading } from '../server/services/goals/reconstruction.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS } from './fixtures/goal10k.ts';

type Over = Partial<ConstructedArrangement> & {
  key: string;
  p50: number;
  p10?: number;
  p90?: number;
  tier?: string;
  observations?: number;
  repeat?: 'ONE_OFF' | 'RECURRING_COHORT' | 'SUBSCRIPTION';
  base?: 'PRODUCE' | 'BROKER' | 'REFERRAL' | 'SUBCONTRACT' | 'POOL';
  funding?: 'ON_DELIVERY' | 'PREPAID' | 'THRESHOLD_PRESALE';
  population?: string;
};

/** A pooled design paid the buyer's price unless a case says otherwise: a broker keeps only its commission (`commissionRevenue`). */
function arrangement(over: Over): ConstructedArrangement {
  const { key, p50, p10 = p50 / 4, p90 = p50 * 3, tier = 'COMPONENT', observations = 12, repeat = 'RECURRING_COHORT', base = 'POOL', funding = 'THRESHOLD_PRESALE', population, ...rest } = over;
  return {
    key,
    structure: base,
    design: { base, funding, aggregation: 'POOLED_BUYERS', repeat },
    origin: 'FORWARD',
    precedent: null,
    sector: 'services',
    demand: { name: `buyers of ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: population ?? `ind_${key}` },
    need: null,
    supply: null,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier, p10, p50, p90, observations },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    ...rest,
  } as ConstructedArrangement;
}

const base = { projectId: 'prj_x', currency: 'USD', beforeProofCents: 37_500, remaining: 10_000, exclusions: [], daysLeft: 30 };
const ordinary = Array.from({ length: 30 }, (_, i) => arrangement({ key: `ord${String(i).padStart(2, '0')}`, p50: 300 }));
const strong = (key: string) => arrangement({ key, p50: 3_000, p10: 1_500, p90: 4_500, tier: 'DIRECT', observations: 20 });
const keys = (xs: ModelledOpportunity[]) => xs.map((o) => o.estimated!.arrangementKey);

/** The selection as it was before lens S, reproduced to measure against. */
function oldPick(arrangements: ConstructedArrangement[], remaining: number): ModelledOpportunity[] {
  const scored = arrangements
    .map((a) => {
      const one = estimatedFromArrangement(a, base)!;
      const deals = one.repeatable ? Math.min(MAX_BUYERS_OFFERED, Math.ceil(remaining / Math.max(1, a.value.p50))) : 1;
      return { one, score: Math.min(remaining, a.value.p50 * deals), population: a.demand.ref };
    })
    .sort((a, b) => b.score - a.score || a.one.opportunity.id.localeCompare(b.one.opportunity.id));
  const seen = new Set<string>();
  return scored.filter((e) => !seen.has(e.population) && seen.add(e.population)).slice(0, MAX_ESTIMATED_ARRANGEMENTS).map((e) => e.one);
}

describe('S-1: the strongest arrangement is kept whatever its key string', () => {
  it('keeps a strong DIRECT design among 30 ordinary ones, for every key — where the old pick kept it only when its key sorted first', () => {
    for (const key of ['aa-strong', 'zz-strong', 'strong-1', 'strong-6', 'f3a9c0d1e2b4']) {
      const all = [...ordinary, strong(key)];
      expect(keys(pickEstimatedArrangements(all, base))).toContain(key);
      expect(keys(pickEstimatedArrangements([strong(key), ...ordinary], base))[0]).toBe(key);
    }
    // The defect, measured: the old score read every design as "the whole goal" and the hash decided.
    expect(keys(oldPick([...ordinary, strong('aa-strong')], 10_000))).toContain('aa-strong');
    expect(keys(oldPick([...ordinary, strong('zz-strong')], 10_000))).not.toContain('zz-strong');
  });

  it('S-14: a $9,000 DIRECT one-off does not lose to every $300 repeatable design by formula saturation', () => {
    const oneOff = arrangement({ key: 'zz-big-oneoff', p50: 9_000, p10: 6_000, p90: 12_000, tier: 'DIRECT', observations: 6, repeat: 'ONE_OFF' });
    const picked = selectEstimatedArrangements([...ordinary, oneOff], base);
    expect(keys(picked.openings)).toContain('zz-big-oneoff');
    expect(picked.selection.picked.find((p) => p.arrangementKey === 'zz-big-oneoff')!.screen).toBeGreaterThan(picked.selection.picked.find((p) => p.arrangementKey === 'ord00')!.screen);
    expect(keys(oldPick([...ordinary, oneOff], 10_000))).not.toContain('zz-big-oneoff');
  });

  it('orders by the screen, then tier, observations, exposure and the constructor’s order — never by id', () => {
    const twins = [arrangement({ key: 'zz', p50: 300 }), arrangement({ key: 'aa', p50: 300 })];
    expect(keys(pickEstimatedArrangements(twins, base))).toEqual(['zz', 'aa']);
    expect(keys(pickEstimatedArrangements([...twins].reverse(), base))).toEqual(['aa', 'zz']);
    const evidenced = arrangement({ key: 'zz-direct', p50: 300, p10: 300, p90: 300, tier: 'DIRECT' });
    expect(keys(pickEstimatedArrangements([...twins, evidenced], base))[0]).toBe('zz-direct');
  });

  it('the engine’s best combination is never weaker than the old pick', () => {
    const all = [...ordinary, strong('zz-strong')];
    // Lens S's setting: the fixture's openings, no measured sending capacity (outreach swept 10–60 a day), 2,000 worlds.
    const limits = { ...GOAL_10K_LIMITS, measuredCapacity: null, worlds: 2_000, seed: 7 };
    const before = evaluateGoalPortfolio({ ...limits, openings: [...GOAL_10K_OPENINGS, ...oldPick(all, 10_000)] });
    const after = evaluateGoalPortfolio({ ...limits, openings: [...GOAL_10K_OPENINGS, ...pickEstimatedArrangements(all, base)] });
    const reach = (p: typeof before) => p.best?.reach ?? 0;
    console.log(`lens S experiment: best reach ${(reach(before) * 100).toFixed(2)}% (old pick, p50 ${Math.round(before.best?.settledP50 ?? 0)}) -> ${(reach(after) * 100).toFixed(2)}% (new, p50 ${Math.round(after.best?.settledP50 ?? 0)}); members ${after.best?.members.map((m) => m.opportunityId).join(', ')}`);
    // Until 2026-11-20 strictly greater, with zz-strong in the best combination: 1.75% → 5.65% at a settled p50 of 50, all of it
    // from the estimates' unknown favourable tails, which invariant 39 no longer counts (`sampler`). The pick is never weaker, and it keeps the strong design.
    expect(reach(after)).toBeGreaterThanOrEqual(reach(before));
    expect(after.demand.some((d) => d.opportunityId === `${ARRANGEMENT_ID_PREFIX}zz-strong` && !d.refused && !d.heldOut)).toBe(true);
  }, 120_000);
});

describe('S-1/S-2: different strategies are preserved, and one population is one market', () => {
  it('keeps the strongest design of every structure and way of being paid, and protects the largest upside', () => {
    const brokers = Array.from({ length: 20 }, (_, i) => arrangement({ key: `b${i}`, p50: 600 }));
    const produce = arrangement({ key: 'produce', p50: 400, base: 'PRODUCE' });
    // Priced below the pooled presales it competes with: a prepaid design's days to cash is read from its own
    // structure (`structuralDaysToCash`), sooner than a presale's, so at 400 it out-screens them for the POOL slot
    // itself. Here it must lose that slot and still be kept as the strongest design paid this way.
    const prepaid = arrangement({ key: 'prepaid', p50: 200, funding: 'PREPAID' });
    const longShot = arrangement({ key: 'long-shot', p50: 200, p10: 50, p90: 20_000 });
    const selected = selectEstimatedArrangements([...brokers, produce, prepaid, longShot], base);
    const slot = (k: string) => selected.selection.picked.find((p) => p.arrangementKey === k)?.slot;
    expect(slot('produce')).toBe('STRUCTURE:PRODUCE');
    expect(slot('prepaid')).toBe('PAID:PREPAID/RECURRING_COHORT');
    expect(slot('long-shot')).toBe('UPSIDE');
    expect(selected.openings).toHaveLength(MAX_ESTIMATED_ARRANGEMENTS);
    // S-17: what was cut is recorded with its reading and why.
    expect(selected.selection.cutCount).toBe(23 - MAX_ESTIMATED_ARRANGEMENTS);
    expect(selected.selection.cut.every((c) => c.reason.length > 0 && c.screen !== null)).toBe(true);
    expect(selected.selection.cut[0]!.reason).toMatch(/below the cut/);
    // The next-best cut ones are kept for a reasoning move that brings one in.
    expect(selected.reserve.length).toBeGreaterThan(0);
  });

  it('enters several designs of one buyer population on one shared market, never the same design twice', () => {
    const pop = 'ind_landlords';
    const designs = [
      arrangement({ key: 'presale', p50: 500, population: pop }),
      arrangement({ key: 'presale-again', p50: 500, population: pop }),
      // Priced apart, so the model tells the designs apart (identical readings are one strategy: portfolioModelledTwins).
      arrangement({ key: 'prepaid', p50: 600, funding: 'PREPAID', population: pop }),
      arrangement({ key: 'subscription', p50: 700, repeat: 'SUBSCRIPTION', population: pop }),
      arrangement({ key: 'on-delivery', p50: 800, funding: 'ON_DELIVERY', population: pop }),
    ];
    const selected = selectEstimatedArrangements(designs, base);
    expect(selected.openings).toHaveLength(DESIGNS_PER_POPULATION);
    expect(new Set(selected.openings.map((o) => (o as PlannedOpening).marketKey))).toEqual(new Set([populationMarket(pop)]));
    expect(keys(selected.openings)).not.toContain('presale-again');
    expect(selected.selection.cut.find((c) => c.arrangementKey === 'presale-again')!.reason).toMatch(/same design over the same buyers/);
    // The engine caps their deals together: one market, however many designs reach it.
    const p = evaluateGoalPortfolio({ ...GOAL_10K_LIMITS, openings: selected.openings, worlds: 300 });
    expect(p.best).not.toBeNull();
  });
});

describe('S-5: an unknown never ranks higher', () => {
  const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
  const evidenced = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'EVIDENCE', source: null, note: '' });
  const opening = (id: string, close: ModelInput): PlannedOpening =>
    ({ ...estimatedFromArrangement(arrangement({ key: id, p50: 300 }), base)!, opportunity: { id, title: id } as ModelledOpportunity['opportunity'], price: evidenced(300, 300), close }) as PlannedOpening;

  it('reads an unknown 2–50% close below an evidenced 5–25% one', () => {
    expect(rankValue(swept(0.02, 0.5))!).toBeLessThan(rankValue(evidenced(0.05, 0.25))!);
    expect(rankValue(evidenced(0.05, 0.25))).toBeCloseTo(0.15);
    const unknown = opening('unknown', swept(0.02, 0.5));
    const known = opening('known', evidenced(0.05, 0.25));
    expect(valuePerInterested(known)).toBeGreaterThan(valuePerInterested(unknown));
    // §101's TOP scope and the role ranking put the evidenced opening first.
    expect([...inScope([unknown, known], 'TOP', 10_000)]).toEqual(['known']);
    expect(rolesOf({ base: { openings: [unknown, known], committed: 0, changes: [] } })['known']).toBe('@RANK:1');
  });
});

describe('S-6/S-11: a reasoning move can bring in an arrangement the cut left out', () => {
  const all = [...ordinary, strong('zz-strong')];
  const selected = selectEstimatedArrangements(all.slice(0, 20), { ...base, limit: 4 });
  const state: StrategyState = { openings: selected.openings, committed: 0, changes: [] };
  const ctx = { operators: [], operatorsFor: () => [], remaining: 10_000, reserve: selected.reserve };

  it('INCLUDE adds a reserve arrangement on its estimates, once', () => {
    const key = selected.reserve[0]!.opportunity.id;
    const { state: next, skipped } = applyProgram(state, [{ op: 'INCLUDE', key }], ctx);
    expect(skipped).toBe(0);
    expect(next.openings.map((o) => o.opportunity.id)).toContain(key);
    expect(next.changes.at(-1)!.basis).toBe('ESTIMATE');
    expect(applyProgram(next, [{ op: 'INCLUDE', key }], ctx).skipped).toBe(1);
    expect(applyProgram(state, [{ op: 'INCLUDE', key: 'arr_nowhere' }], ctx).skipped).toBe(1);
  });

  it('seeds INCLUSION directions, and accepts a model’s INCLUDE only for an arrangement in reserve', () => {
    const seeds = seedDirections({ base: state, greedy: state, operators: [], binding: [], remaining: 10_000, structural: false, reserve: selected.reserve });
    expect(seeds.filter((d) => d.stance === 'INCLUSION').length).toBeGreaterThanOrEqual(selected.reserve.length);
    const brief = { operators: [], openings: [], reserve: selected.reserve.map((o) => ({ id: o.opportunity.id, title: o.opportunity.title, price: 1, repeatable: true })) };
    const ok = parseInvented(JSON.stringify({ methods: [{ name: 'n', stance: 'NEW_BUYER', thinking: 't', program: [{ op: 'INCLUDE', key: selected.reserve[0]!.opportunity.id }] }] }), brief);
    expect(ok.directions).toHaveLength(1);
    const bad = parseInvented(JSON.stringify({ methods: [{ name: 'n', stance: 'NEW_BUYER', thinking: 't', program: [{ op: 'INCLUDE', key: 'arr_invented' }] }] }), brief);
    expect(bad.refused).toBe(1);
  });
});

describe('S-7/S-8: the library learns from what holds, in roles that transfer', () => {
  const reading = (reach: number, implausible = false): VariantReading => ({ key: 'k', changes: [], reach, settledP10: 0, settledP50: 0, settledP90: 0, basis: 'COVERAGE', committed: 0, feasible: true, why: null, members: [], ...(implausible ? { implausible: [{ kind: 'RETURN', detail: 'x' }] } : {}) });
  const direction = makeDirection({ name: 'partner on the top opening', stance: 'FORWARD', origin: 'ALGORITHM', thinking: 't', from: 'GREEDY', program: [{ op: 'OPERATOR', key: 'partner:', target: 'cop_a' }] });
  const x = { greedy: { reach: 0.3, settledP50: 0, score: 0.3, challengedReach: 0.3 }, winner: null, roles: { cop_a: '@RANK:1', cop_b: '@RANK:2' } } as unknown as Pick<Exploration, 'greedy' | 'winner' | 'roles'>;

  it('credits challenged reach, not coverage of assumptions, and skips a flagged reading', () => {
    // 90% if every assumption holds, 5% once challenged: a raw reach lift of +0.6 over the greedy plan, but it holds less.
    const fragile = { direction, reading: reading(0.9), challenged: reading(0.05), score: 0.5 * 0.9 + 0.5 * 0.05, generation: 1, applied: true };
    const lesson = lessonOf(x, fragile)!;
    expect(lesson.lift).toBeCloseTo(0.475 - 0.3);
    const robust = { ...fragile, challenged: reading(0.6), score: 0.75 };
    expect(lessonOf(x, robust)!.lift).toBeGreaterThan(lesson.lift);
    expect(lessonOf(x, { ...fragile, reading: reading(0.9, true) })).toBeNull();
  });

  it('records the method in roles and resolves it onto another goal’s openings', () => {
    const lesson = lessonOf(x, { direction, reading: reading(0.5), challenged: reading(0.5), score: 0.5, generation: 1, applied: true })!;
    expect(lesson.direction.program).toEqual([{ op: 'OPERATOR', key: 'partner:', target: '@RANK:1' }]);
    expect(lesson.direction.signature).not.toContain('cop_a');
    // The same method learned on a goal whose openings had other ids is one method.
    expect(abstractDirection({ ...direction, program: [{ op: 'OPERATOR', key: 'partner:', target: 'cop_z' }] } as Direction, { cop_z: '@RANK:1' })!.signature).toBe(lesson.direction.signature);
    const elsewhere = resolveRoles(lesson.direction, new Map([['@RANK:1', 'cop_other_goal']]))!;
    expect(elsewhere.program).toEqual([{ op: 'OPERATOR', key: 'partner:', target: 'cop_other_goal' }]);
    // A method naming a role this problem lacks is not given a slot.
    expect(resolveRoles(makeDirection({ ...direction, program: [{ op: 'OPERATOR', key: 'partner:', target: '@RANK:3' }] }), new Map([['@RANK:1', 'cop_x']]))).toBeNull();
    // An older method recorded with another goal's ids does not apply here.
    expect(resolveRoles(direction, new Map([['@RANK:1', 'cop_x']]))).toBeNull();
  });
});

describe('S-12: a transfer declares what it must bridge, and its range widens until it is bridged', () => {
  it('lists the material dimensions, widens the price and screens lower than the same design built forward', () => {
    const forward = arrangement({ key: 'fwd', p50: 1_000, p10: 600, p90: 1_500, tier: 'COMPARABLE' });
    const transfer = { ...forward, key: 'xfer', origin: 'TRANSFER', precedent: { opportunityId: 'cop_p', title: 'Lists sold to roofers' } } as ConstructedArrangement;
    const f = estimatedFromArrangement(forward, base)!;
    const t = estimatedFromArrangement(transfer, base)!;
    expect(t.estimated!.transfer).toMatchObject({ precedent: 'Lists sold to roofers', bridged: [], unbridged: ['legal context', 'payment terms', 'sales cycle', 'capital', 'buyer behaviour'] });
    expect(t.price.low!).toBeLessThan(f.price.low!);
    expect(t.price.high!).toBeGreaterThan(f.price.high!);
    expect(t.price.note).toMatch(/not bridged/);
    const limits = { remaining: 10_000, daysLeft: 30, contactsPerDay: 10 };
    expect(screenArrangement(t, transfer, limits).value).toBeLessThan(screenArrangement(f, forward, limits).value);
  });
});
