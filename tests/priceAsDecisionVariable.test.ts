/**
 * P5, production 4730acd7, goal wst_7b4fcbb5f2384f31b6c3, read 2026-11-18 19:20Z.
 *
 * 1. An arrangement whose value is UNKNOWN was dropped from the goal model
 *    (`estimatedFromArrangement` returned null), so the postcard broker
 *    2821cce3c372 — whose one observed number is its supply cost, a run at
 *    $4,675 (clm_9cf1f15c, cfa_ca236ebb) — was never modelled. Its price is
 *    now the decision variable: the break-even and the price the target needs
 *    are computed, the price is swept between them as an assumption, and
 *    nothing is certified.
 * 2. The openings' strategies read NOT_VIABLE ("at most 265") beside an
 *    arrangement candidate at 55.85% coverage, p50 $27,410 on ASSUMED prices.
 *    The candidate now stands in the strategies list with its basis stated.
 * 3. `planSet.collections.modelledP50` summed 82 alternative plans' medians
 *    into 38,735,256 on a $10K goal. It is one plan's median.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { estimatedFromArrangement, priceAsVariable, RUN_SLOT_GRID, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';
import { candidateStrategyReading, composeGoalReadings, type PlanAcceptance, type StrategyReading } from '../server/services/goals/plan.ts';
import { buildPlanSet, type PlanCandidate } from '../server/services/goals/planSet.ts';
import { goalObjective } from '../server/services/goals/objective.ts';
import type { TargetReading } from '../server/services/goals/target.ts';

const KEY = '2821cce3c372';
const REMAINING = 10_000;

/** The postcard broker as production composed it: pooled slots, threshold presale, price UNKNOWN, run cost observed. */
function postcard(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: KEY,
    structure: 'BROKER',
    design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Local marketing',
    demand: { name: 'Local service businesses', claimId: null, from: 'INDUSTRY_MAP', ref: 'map_local_service' },
    need: null,
    supply: { name: 'Commercial printers and mail houses that print and enter EDDM mailings on order', claimId: 'clm_9cf1f15c', from: 'CLAIM', ref: 'clm_9cf1f15c' },
    label: 'Local service businesses: EDDM postcard runs, brokered',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    fixedCost: { tier: 'COMPARABLE', p10: 3_740, p50: 4_675, p90: 5_843.75, observations: 1, sources: ['claim:clm_9cf1f15c', 'fact:cfa_ca236ebb'] },
    unknownParts: ['value'],
    relatedOpenings: [],
    question: 'What do local businesses pay for a slot on a shared postcard?',
    ...over,
  } as ConstructedArrangement;
}

/** An ordinary priced arrangement, for the selection. */
function priced(key: string, p50: number): ConstructedArrangement {
  return postcard({
    key,
    label: `Arrangement ${key}`,
    demand: { name: `buyers of ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: `ind_${key}` },
    design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    value: { tier: 'COMPONENT', p10: p50 / 4, p50, p90: p50 * 3, observations: 12 },
    fixedCost: undefined,
  });
}

const input = { projectId: 'prj_x', currency: 'USD', beforeProofCents: 37_500, daysLeft: 21, remaining: REMAINING };

describe('P5-1: an arrangement with an unknown price and an observed supply cost enters the model with price as its variable', () => {
  it('enters with a break-even price and the price the $10K target needs, the price ASSUMED and swept', () => {
    const one = estimatedFromArrangement(postcard(), input);
    expect(one).not.toBeNull();
    const pv = one!.priceVariable!;
    expect(pv).toMatchObject({ arrangementKey: KEY, blocking: 'PRICE', basis: 'ASSUMPTION', remaining: REMAINING });
    expect(pv.prices.map((p) => p.slots)).toEqual([...RUN_SLOT_GRID]);
    const twelve = pv.prices.find((p) => p.slots === 12)!;
    // 4675 ÷ 12: twelve slots need ≥ $390 each just to cover the run.
    expect(twelve.breakEven).toBeCloseTo(389.58, 2);
    // (10,000 + 4,675) ÷ 12: one run of twelve needs $1,223 a slot to collect the target.
    expect(twelve.forTarget).toBeCloseTo(1_222.92, 2);
    // The price is the variable: an assumption swept from the break-even at 48 slots to the target price at 6.
    expect(one!.price).toMatchObject({ value: null, provenance: 'ASSUMPTION' });
    expect(one!.price.inferred).toMatchObject({ tier: 'ASSUMED', justified: false, observations: 0 });
    expect(one!.price.low).toBeCloseTo(4_675 / 48, 6);
    expect(one!.price.high).toBeCloseTo((REMAINING + 4_675) / 6, 6);
    // Certifies nothing.
    expect(inputEvidence(one!.price, 'price').establishes).toBe(false);
    // Its run cost still reaches the per-slot cost (D4), citing the claim.
    expect(one!.directCost.source?.note).toContain('clm_9cf1f15c');
  });

  it('its verdict says price is the blocking assumption, with the break-even and the target price', () => {
    const pv = estimatedFromArrangement(postcard(), input)!.priceVariable!;
    expect(pv.sentence).toMatch(/^Price is the blocking assumption/);
    expect(pv.sentence).toContain('12 slots need ≥ $390');
    expect(pv.sentence).toContain('12 slots need $1,223 each');
    expect(pv.sentence).toContain('nothing is certified');
  });

  it('without the remaining amount it still reports the break-even', () => {
    const pv = priceAsVariable(postcard(), { projectId: 'prj_x', currency: 'USD' })!.priceVariable!;
    expect(pv.remaining).toBeNull();
    expect(pv.prices.every((p) => p.forTarget === null)).toBe(true);
    expect(pv.prices.find((p) => p.slots === 12)!.breakEven).toBeCloseTo(389.58, 2);
  });

  it('an unknown price with no observed cost, or a design that is not pooled, stays a research question', () => {
    expect(estimatedFromArrangement(postcard({ fixedCost: undefined }), input)).toBeNull();
    expect(estimatedFromArrangement(postcard({ design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' } as ConstructedArrangement['design'] }), input)).toBeNull();
    expect(estimatedFromArrangement(postcard({ stress: { exposure: 'EXCEEDS', worstCaseCents: null, failures: [] } as ConstructedArrangement['stress'] }), input)).toBeNull();
  });

  it('a priced arrangement is read exactly as before (no price variable)', () => {
    const one = estimatedFromArrangement(priced('p1', 300), input)!;
    expect(one.priceVariable).toBeUndefined();
    expect(one.price.inferred?.p50).toBe(300);
  });

  it('takes a model slot among thirty priced designs, and the pick says why price blocks it', () => {
    const ordinary = Array.from({ length: 30 }, (_, i) => priced(`ord${String(i).padStart(2, '0')}`, 300));
    const { openings, selection } = selectEstimatedArrangements([...ordinary, postcard()], { ...input, exclusions: [] });
    expect(openings.map((o) => o.estimated!.arrangementKey)).toContain(KEY);
    const pick = selection.picked.find((p) => p.arrangementKey === KEY)!;
    expect(pick.slot).toBe('PRICE_VARIABLE');
    expect(pick.basis).toContain('Price is the blocking assumption');
    // Screened at its break-even floor, never inside the swept range (invariant 39).
    expect(pick.screen).toBeGreaterThanOrEqual(0);
    expect(selection.cut.find((c) => c.arrangementKey === KEY)).toBeUndefined();
  });
});

const acceptance = (over: Partial<PlanAcceptance> = {}): PlanAcceptance =>
  ({
    status: 'CANDIDATE_ONLY',
    required: 0.9,
    probability: null,
    accepted: null,
    candidate: { label: 'Constructed: Puzzle Society + Constructed: homeowner', opportunityIds: ['arr_da6aaea7f4cc', 'arr_f4b3a07f6715'], source: 'QUANT_PORTFOLIO', settledP50: 27_409.95, reach: 0.5585, reachBasis: 'COVERAGE' },
    shortfalls: [],
    sentence: 'NOT ACCEPTED: …',
    construction: {
      label: 'x', opportunityIds: [], reach: 0.5585, basis: 'COVERAGE', interval: null, assumptions: [], improve: [],
      evidence: [
        { opportunityId: 'arr_da6aaea7f4cc', input: 'price', tier: 'ASSUMED', events: 0, populations: 1, sizedPopulations: 0, establishes: false },
        { opportunityId: 'arr_da6aaea7f4cc', input: 'reply rate', tier: 'UNKNOWN', events: null, populations: 0, sizedPopulations: 0, establishes: false },
        { opportunityId: 'arr_f4b3a07f6715', input: 'price', tier: 'ASSUMED', events: 0, populations: 1, sizedPopulations: 0, establishes: false },
      ],
    },
    ...over,
  }) as unknown as PlanAcceptance;

const notViable: StrategyReading = {
  key: 'only_o1', label: 'Only: Market: US residential home improvement', verdict: 'NOT_VIABLE', opportunityIds: ['opp_1'], links: [],
  constraintsFailed: ['cannot reach the 10000 USD still needed at prices buyers are shown to pay, even if every buyer it offers to agreed (at most 265)'],
  sweep: { goalMetShare: null, settledP50: null, settledP90: null, infeasibleShare: 1, probabilistic: false }, conservativeSettled: null, chainComplete: false, nextTest: null,
};

describe('P5-2: one reading, one economic picture', () => {
  it('the adopted candidate stands among the strategies, NEEDS_EVIDENCE, with the inputs it assumes stated', () => {
    const s = candidateStrategyReading(acceptance(), [notViable])!;
    expect(s).toMatchObject({ key: 'candidate:quant_portfolio', verdict: 'NEEDS_EVIDENCE', chainComplete: false, constraintsFailed: [] });
    expect(s.sweep).toMatchObject({ goalMetShare: 0.5585, settledP50: 27_409.95, probabilistic: false });
    expect(s.basis).toContain('55.9% of worlds, coverage of assumed inputs, not a probability');
    expect(s.basis).toContain('assumed, not established: price, reply rate');
  });

  it('names a member whose price is the decision variable, with its break-even', () => {
    const pv = estimatedFromArrangement(postcard(), input)!.priceVariable!;
    const s = candidateStrategyReading(acceptance({ candidate: { ...acceptance().candidate!, opportunityIds: [`arr_${KEY}`, 'arr_f4b3a07f6715'] } }), [notViable], [pv])!;
    expect(s.basis).toContain('Price is the blocking assumption');
    expect(s.basis).toContain('12 slots need ≥ $390');
  });

  it('adds nothing when there is no candidate, the plan is accepted, or a strategy already holds its openings', () => {
    expect(candidateStrategyReading(acceptance({ candidate: null }), [notViable])).toBeNull();
    expect(candidateStrategyReading(acceptance({ status: 'ACCEPTED' }), [notViable])).toBeNull();
    expect(candidateStrategyReading(acceptance(), [{ ...notViable, opportunityIds: ['arr_f4b3a07f6715', 'arr_da6aaea7f4cc'] }])).toBeNull();
  });
});

function plan(id: string, p50: number): PlanCandidate {
  return {
    id, title: `Plan ${id}`, source: 'STRATEGY', opportunityIds: [id],
    dimensions: { mechanism: `m ${id}`, channel: `c ${id}`, fulfilment: `f ${id}`, risk: `r ${id}`, revenue: 'one-off' },
    customers: [`buyers ${id}`], cashSources: [`payer ${id}`], channels: [`channel ${id}`], suppliers: [`supplier ${id}`],
    model: Object.fromEntries(['acquisitionRoute', 'fulfilmentRoute', 'costs', 'capital', 'timing', 'controls', 'evidence'].map((f) => [f, { value: null, low: null, high: null, status: 'UNKNOWN', basis: 'x' }])) as unknown as PlanCandidate['model'],
    modelled: { p10: p50 / 4, p50, p90: p50 * 2 }, observedCollections: 0, enforceableCommitments: 0, capitalRequired: 0, daysToCash: 20,
    attempts: { researched: true, authorized: false, executed: false }, whyItWorks: [], transfers: [], stopsTransferringWhen: [],
  };
}

describe('P5-3: no impossible aggregate', () => {
  it('82 alternative plans report one plan\'s median, never their sum', () => {
    // Shaped like the production reading: 82 distinct alternatives averaging ~$472K each summed to 38,735,256.
    const plans = Array.from({ length: 82 }, (_, i) => plan(`p${String(i).padStart(2, '0')}`, 472_381 + i));
    const set = buildPlanSet(plans, { amount: REMAINING, daysLeft: 21, confidence: 0.9, capitalCeiling: 3_000 });
    const sum = plans.reduce((s, p) => s + p.modelled!.p50, 0);
    expect(sum).toBeGreaterThan(38_000_000);
    expect(set.collections.modelledP50).toBeLessThanOrEqual(Math.max(...plans.map((p) => p.modelled!.p50)));
    expect(set.collections.modelledOf).toBe(set.plans[0]!.id);
    expect(set.collections.modelledP50).toBe(set.plans[0]!.modelled!.p50);
  });

  it('the reading\'s modelled median is the adopted candidate\'s, so it agrees with the acceptance', () => {
    const target = {
      metric: 'COLLECTED', metricLabel: 'collected', currency: 'USD', projectId: 'prj_1', targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000,
      achieved: false, daysLeft: 21, counted: [], notCounted: [], since: '2026-11-18T00:00:00Z', capitalCeilingCents: 300_000, capitalBeforeProofCents: null,
    } as unknown as TargetReading;
    const objective = goalObjective({ title: 'Cash goal', intent: 'Collect $10K', outcome: null, dueAt: '2026-12-09T00:00:00Z', target: { amountCents: 1_000_000 } }, new Date('2026-11-18T00:00:00Z'));
    const { planSet } = composeGoalReadings({ objective, target, portfolio: null, pathways: null, arrangements: [], reconstruction: null, acceptance: acceptance() });
    expect(planSet.collections.modelledP50).toBeCloseTo(27_409.95, 2);
    expect(planSet.collections.modelledOf).toContain('Puzzle Society');
  });
});
