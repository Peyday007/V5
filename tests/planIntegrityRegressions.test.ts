/**
 * Every commercial-planning failure confirmed on production (plan reads,
 * 2026-11-19), as a permanent regression: the general rule it broke
 * (`planIntegrity`; the architecture record's "Plan integrity"), the old output built from the exact failing
 * labels, names and keys — which the checker must flag — and the current
 * pipeline, which must not produce it.
 *
 *   1  PAYER_IS_POPULATION       "GitHub", "Dutch cleaning company De Po…",
 *                                "the production committee's investo…" sold to as populations
 *   2  LEAD_STEPS_AGREE          lead cop_8015, steps "Reach GitHub" from arr_53ae6fed770b
 *   3  NO_INTERNAL_KEYS          "focus:4", "price×2.50@SMALL_TICKET",
 *                                "referral-partner>arr_53ae6fed770b", "bundle"
 *   4  NO_FABRICATED_FIGURE      every step cost 0 while the model held no cost
 *   5  STEPS_SCHEDULED           Collect, Deliver and Renew had no day
 *   6  PRICE_GROUNDED            $2,569 pooled from a 47× spread of unrelated prices
 *   7  UNKNOWN_BECOMES_RESEARCH  a goal with no portfolio raised no price research
 *   8  reconstructed plans (plan reads at 18:00Z on 62214360):
 *      NO_INTERNAL_KEYS          "Raise price ×4.00 on 4 opening(s) (ALL)"
 *      NO_FABRICATED_FIGURE      "Sell and collect · cost 0"
 *      NO_DUPLICATE_STEPS        `Bring in "Constructed` six times
 *      STEPS_SCHEDULED           "Establish an offer and a price · day 0" after "Run the next group · day 12–56"
 *
 * And the gate: a reading that breaks any rule is never ACCEPTED, and planReady
 * refuses it.
 */
import { describe, expect, it } from 'vitest';
import { planIntegrity, type IntegrityStep, type PlanIntegrityInput, type PlanIntegrityRule } from '../server/domain/planIntegrity.ts';
import { planReady, type PlanReadyFacts } from '../server/domain/planReady.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { comparablePricesFor, COMPARABLE_SPREAD_MAX, selectEstimatedArrangements, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { arrangementSteps } from '../server/services/goals/arrangementSteps.ts';
import { adoptReconstruction, gateIntegrity, inGoalScope, leadingArrangement, planSteps, refuseForIntegrity, unpricedForPlan, type PlanAcceptance, type PlanReading, type PlanStep } from '../server/services/goals/plan.ts';
import { integrityInput, integrityLines, leadOf, leadPrice } from '../server/services/goals/planIntegrityInput.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { Reconstruction, StrategyChange, VariantReading } from '../server/services/goals/reconstruction.ts';
import { applyProgram, scopeWords, type Transform } from '../server/services/goals/reasoning/directions.ts';
import { buildOperators, type StrategyState } from '../server/services/goals/reconstruction.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { NextTest } from '../server/services/goals/plan.ts';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function arrangement(key: string, buyers: string, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key,
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Software',
    demand: { name: buyers, claimId: null, from: 'INDUSTRY_MAP', ref: `pop_${key}` },
    need: { name: 'maintenance reports', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_reports' },
    supply: null,
    label: `${buyers}: maintenance reports`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value', 'conversion'],
    relatedOpenings: [],
    question: 'What do they pay?',
    ...over,
  } as unknown as ConstructedArrangement;
}

const ctx = { currency: 'USD', daysLeft: 60, capitalBeforeProof: 500 };
const swept = (low: number, high: number) => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
/** A model with no portfolio: what the screen read the arrangement on, swept. */
const sweptModel = { daysToCash: swept(5, 15), directCost: swept(40, 90), capital: swept(0, 0) } as unknown as ModelledOpportunity;

/** The checker's input for a plan made only of these steps, leading with `lead` when given. */
function checked(steps: IntegrityStep[], over: Partial<PlanIntegrityInput> = {}): PlanIntegrityInput {
  return { leadIds: [], arrangementIdPrefix: 'arr_', steps, lead: null, unpriced: [], texts: [], spreadMax: COMPARABLE_SPREAD_MAX, ...over };
}
const rules = (input: PlanIntegrityInput): PlanIntegrityRule[] => [...new Set(planIntegrity(input).violations.map((v) => v.rule))];
const step = (order: number, label: string, over: Partial<IntegrityStep> = {}): IntegrityStep => ({ order, label, detail: '', cost: null, startDay: { low: 0, high: 0 }, dependsOn: null, kind: 'EXECUTE', ...over });

/** A reading as the gate reads it: a slice of a real PlanReading, the rest absent. */
function reading(over: Partial<PlanReading>): PlanReading {
  return {
    goalId: 'wst_regression',
    verdict: 'NEEDS_EVIDENCE',
    summary: 'A plan.',
    acceptance: { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: null, shortfalls: [], sentence: 'A candidate.' },
    steps: [],
    nextTest: null,
    portfolio: null,
    ...over,
  } as PlanReading;
}
const fromSteps = (steps: PlanStep[], over: Partial<PlanReading> = {}) => integrityInput(reading({ steps, ...over }));

/* ------------------------------------------------------------------ */
/* 1. PAYER_IS_POPULATION                                              */
/* ------------------------------------------------------------------ */

const ONE_ORGANISATION = ['GitHub', 'Dutch cleaning company De Po…', "the production committee's investo…"];

describe('1. PAYER_IS_POPULATION: one organisation is never the buyer population a plan sells to', () => {
  it('the checker flags steps sold to each production name', () => {
    for (const buyers of ONE_ORGANISATION) {
      const input = checked([step(1, `Reach ${buyers}`, { arrangementKey: '53ae6fed770b', stage: 'REACH', costSource: 'NONE_HELD' })], {
        lead: { arrangementKey: '53ae6fed770b', buyers, population: 'pop_x', price: { basis: 'OWN', spread: null } },
      });
      expect(rules(input), buyers).toEqual(['PAYER_IS_POPULATION']);
    }
  });

  it('the pipeline: none of them is selected, and none leads a plan', () => {
    const arrangements = ONE_ORGANISATION.map((buyers, i) => arrangement(`org${i}`, buyers));
    expect(leadingArrangement(arrangements, { portfolio: null })).toBeNull();
    const selected = selectEstimatedArrangements(arrangements, { projectId: 'p', currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], knowledge: null, now: new Date() } as never);
    expect(selected.openings).toEqual([]);
    expect(selected.selection.cut.map((c) => c.reason).every((r) => /name one organisation/.test(r))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. LEAD_STEPS_AGREE                                                 */
/* ------------------------------------------------------------------ */

describe('2. LEAD_STEPS_AGREE: steps come from the lead the plan names', () => {
  it('the checker flags lead cop_8015 with steps "Reach GitHub" from arr_53ae6fed770b', () => {
    const input = checked([step(1, 'Reach GitHub', { arrangementKey: '53ae6fed770b', stage: 'REACH', costSource: 'NONE_HELD' })], { leadIds: ['cop_8015'] });
    expect(rules(input)).toContain('LEAD_STEPS_AGREE');
  });

  it('the pipeline: a lead naming only cop_8015 takes no arrangement\'s steps, however much one contributes', () => {
    const homes = arrangement('53ae6fed770b', 'homeowners');
    const contributes = { best: null, demand: [{ opportunityId: 'arr_53ae6fed770b', refused: false, revenue: { p50: 9_000 } }] } as unknown as GoalPortfolio;
    const lead = leadingArrangement([homes], { portfolio: contributes, candidateIds: ['cop_8015'] });
    expect(lead).toBeNull();
    const steps = planSteps({
      adoption: { source: 'BASELINE', hypothetical: false, reason: 'held' },
      reconstruction: null,
      sales: [],
      nextTest: { link: 'CONVERSION', test: 'Offer the Pennsylvania opening to its payer and measure the reply.', by: 'BRAIN', blocker: null },
      permissionsMissing: [],
      arrangement: lead ? { arrangement: lead, context: ctx } : null,
    });
    expect(steps.some((s) => /^Reach /.test(s.label))).toBe(false);
    const acceptance = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, shortfalls: [], sentence: 'A candidate.', candidate: { label: 'Pennsylvania opening', opportunityIds: ['cop_8015'], source: 'QUANT_PORTFOLIO', settledP50: null, reach: null, reachBasis: null } } as PlanAcceptance;
    expect(planIntegrity(fromSteps(steps, { acceptance })).violations.filter((v) => v.rule === 'LEAD_STEPS_AGREE')).toEqual([]);
  });
});

describe('2b. LEAD_STEPS_AGREE: a plan never leads with an arrangement outside the goal\'s own scope', () => {
  it('the checker flags a lead outside the scope; the pipeline leads only within it (transfer test: a "developer tools" goal read "Reach Dental practices")', () => {
    const dental = arrangement('dent', 'Dental practices');
    const s = [step(1, 'Reach Dental practices', { arrangementKey: 'dent', stage: 'REACH', costSource: 'NONE_HELD' })];
    expect(rules(checked(s, { lead: { ...leadOf(dental, null)!, inScope: false }, unpriced: [{ population: 'pop_dent' }] }))).toEqual(['LEAD_STEPS_AGREE']);
    // Every arrangement out of the goal's scope: no lead, so no arrangement's steps.
    expect(leadingArrangement(inGoalScope([dental], { arrangementsInScope: [] }), { portfolio: null })).toBeNull();
    expect(leadingArrangement(inGoalScope([dental], { arrangementsInScope: ['dent'] }), { portfolio: null })?.key).toBe('dent');
    expect(inGoalScope([dental], {})).toEqual([dental]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. NO_INTERNAL_KEYS                                                 */
/* ------------------------------------------------------------------ */

const PRODUCTION_CHANGES: StrategyChange[] = [
  { dimension: 'PORTFOLIO', label: 'focus:4', detail: 'concentrate outreach and money on the 4 opening(s) that settle most per interested buyer, and drop 3', cost: 0, basis: 'ESTIMATE', startDay: { low: 0, high: 0 } },
  { dimension: 'PRICE', label: 'price×2.50@SMALL_TICKET', detail: "raise price ×2.50 on 4 opening(s) (SMALL_TICKET), each held within ×0.25–×4 of its card's unit price; close rate and the deals the market takes assumed to move ×0.33 until selling measures it", cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } },
  { dimension: 'PARTNER', label: 'referral-partner>arr_53ae6fed770b', detail: 'sell Homeowner move-out checklists through a partner who already serves its buyers (a supplier or complementary vendor), paying 10–30%', cost: 0, basis: 'ASSUMPTION', startDay: { low: 2, high: 5 } },
  { dimension: 'TRANSACTION', label: 'bundle', detail: 'sell a bundle of 3 unit(s) at 10% off (×2.7 the unit price, ×3.0 its direct cost); close rate assumed ×0.8 until measured', cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } },
];

function productionReconstruction(): Reconstruction {
  const v = (over: Partial<VariantReading>): VariantReading => ({ key: 'as planned', changes: [], reach: 0.01, settledP10: 0, settledP50: 650, settledP90: 2000, basis: 'COVERAGE', committed: 0, feasible: true, why: null, members: ['cop_8015'], ...over }) as VariantReading;
  return {
    required: 0.9,
    baseline: v({}),
    best: v({ key: 'best', reach: 0.6, settledP50: 14_000, changes: PRODUCTION_CHANGES, members: ['cop_8015', 'arr_53ae6fed770b'] }),
    diagnosis: [],
    headroom: { reach: 0.6, settledP50: 9000 },
    structural: true,
    challenges: [],
    rounds: [],
    floor: v({ reach: 0.2 }),
    requiredReply: 0.012,
    volumePlans: [],
    limitation: null,
    confidence: { basis: 'COVERAGE', measured: [], assumed: [], statement: '' },
    searchBrief: '',
    evaluations: 10,
    exploration: null,
    flags: [],
  } as unknown as Reconstruction;
}

describe('3. NO_INTERNAL_KEYS: no text a person reads carries an internal id or key', () => {
  it('the checker flags each production step label', () => {
    for (const label of ['focus:4', 'price×2.50@SMALL_TICKET', 'referral-partner>arr_53ae6fed770b', 'bundle']) {
      expect(rules(checked([step(1, label)])), label).toEqual(['NO_INTERNAL_KEYS']);
    }
    expect(rules(checked([], { texts: [{ where: 'the summary', text: 'by focus:4, price×2.50@SMALL_TICKET' }] }))).toEqual(['NO_INTERNAL_KEYS']);
  });

  it('the pipeline (#1144): a reconstruction\'s steps are titled by what the change does, never by its key', () => {
    const steps = planSteps({ adoption: { source: 'RECONSTRUCTED', hypothetical: false, reason: 'beats the plan as held' }, reconstruction: productionReconstruction(), sales: [], nextTest: null, permissionsMissing: [] });
    // Each change, then the sale and the collection.
    expect(steps).toHaveLength(PRODUCTION_CHANGES.length + 2);
    for (const s of steps) expect(s.label, s.label).not.toMatch(/focus:4|×2\.50@|>arr_|^bundle$/);
    expect(planIntegrity(checked(steps.map((s) => step(s.order, s.label)))).violations).toEqual([]);
  });

  it('the pipeline: its sale step, its candidate and its reason name openings and changes by title', () => {
    const r = productionReconstruction();
    const titles = new Map([['cop_8015', 'Pennsylvania permit filings'], ['arr_53ae6fed770b', 'Homeowner move-out checklists']]);
    const steps = planSteps({ adoption: { source: 'RECONSTRUCTED', hypothetical: false, reason: 'beats the plan as held' }, reconstruction: r, sales: [], nextTest: null, permissionsMissing: [], titles });
    for (const s of steps) expect(`${s.label} ${s.detail}`).not.toMatch(/\b(?:arr|cop)_[0-9a-z]{4,}/);
    expect(steps.find((s) => s.label === "Sell the plan's openings")!.detail).toContain('Pennsylvania permit filings; Homeowner move-out checklists');
    expect(planIntegrity(fromSteps(steps)).violations).toEqual([]);
    const adopted = adoptReconstruction({
      reconstruction: r,
      baseline: null,
      openings: [{ opportunity: { id: 'cop_8015', title: 'Pennsylvania permit filings' } }, { opportunity: { id: 'arr_53ae6fed770b', title: 'Homeowner move-out checklists' } }],
    });
    expect(adopted.candidate?.opportunityIds).toEqual(['cop_8015', 'arr_53ae6fed770b']);
    expect(rules(checked([], { texts: [{ where: 'the candidate', text: adopted.candidate!.label }, { where: 'the reason', text: adopted.adoption.reason }] }))).toEqual([]);
  });

  it('a reasoning move names its openings by title, never by id (transfer test: "Leave out 1 opening(s) (id:arr_71e8904fcb7c)")', () => {
    const openings = [{ opportunity: { id: 'arr_71e8904fcb7c', title: 'Constructed: dental reports' } }] as unknown as ModelledOpportunity[];
    expect(scopeWords('id:arr_71e8904fcb7c', openings)).toBe('"Constructed: dental reports"');
    expect(scopeWords('id:arr_gone', openings)).toBe('one named opening');
    expect(scopeWords('SMALL_TICKET', openings)).toBe('the small tickets');
  });
});

/* ------------------------------------------------------------------ */
/* 4. NO_FABRICATED_FIGURE and 5. STEPS_SCHEDULED                      */
/* ------------------------------------------------------------------ */

/** The production steps of a leading arrangement: every cost 0, and nothing after the offer with a day. */
const OLD_STEPS: IntegrityStep[] = [
  step(1, 'Reach homeowners', { cost: 0, arrangementKey: 'k', stage: 'REACH' }),
  step(2, 'Offer it to homeowners', { cost: 0, dependsOn: 1, arrangementKey: 'k', stage: 'OFFER' }),
  step(3, 'Collect payment', { cost: 0, startDay: null, dependsOn: 2, arrangementKey: 'k', stage: 'COLLECT' }),
  step(4, 'Deliver and confirm', { cost: 0, startDay: null, dependsOn: 3, arrangementKey: 'k', stage: 'DELIVER' }),
  step(5, 'Renew', { cost: 0, startDay: null, dependsOn: 4, arrangementKey: 'k', stage: 'REPEAT' }),
];

describe('4. NO_FABRICATED_FIGURE: a stage that commits money carries the model\'s figure or null, never a written 0', () => {
  it('the checker flags the production steps\' 0 costs', () => {
    const fabricated = planIntegrity(checked(OLD_STEPS)).violations.filter((v) => v.rule === 'NO_FABRICATED_FIGURE');
    expect(fabricated.map((v) => v.detail.match(/step (\d)/)![1])).toEqual(['1', '2', '3', '4', '5']);
    // A 0 a stage that moves no money states, or one the buyers pay, is no figure.
    expect(rules(checked([step(1, 'Research the price', { cost: 0, kind: 'RESEARCH', arrangementKey: 'k', stage: 'RESEARCH', costSource: 'NOT_SPENT' }), step(2, 'Deliver and confirm', { cost: 0, arrangementKey: 'k', stage: 'DELIVER', costSource: 'NOT_OWNERS' })]))).toEqual([]);
  });

  it('the pipeline: with no portfolio, Reach, Offer, Collect and Renew carry null and Deliver the model\'s cost', () => {
    const a = arrangement('k', 'Dental practices', { value: { tier: 'COMPARABLE', p10: 200, p50: 300, p90: 450, observations: 3 }, unknownParts: [] } as never);
    for (const modelled of [sweptModel, null]) {
      const steps = arrangementSteps(a, { ...ctx, modelled, send: [], collect: [] });
      const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
      for (const label of ['Reach', 'Validate the offer', 'Collect payment', 'Renew']) expect(by(label).cost, label).toBeNull();
      expect(by('Deliver and confirm').cost).toBe(modelled ? 90 : null);
      expect(planIntegrity(fromSteps(steps, { lead: leadOf(a, modelled) })).violations.filter((v) => v.rule === 'NO_FABRICATED_FIGURE')).toEqual([]);
    }
  });
});

describe('5. STEPS_SCHEDULED: every step that is not research has a day, follows one that has, or says why not', () => {
  it('the checker flags Deliver and Renew of the production steps', () => {
    const unscheduled = planIntegrity(checked(OLD_STEPS)).violations.filter((v) => v.rule === 'STEPS_SCHEDULED');
    expect(unscheduled.map((v) => v.detail.match(/"([^"]+)"/)![1])).toEqual(['Deliver and confirm', 'Renew']);
  });

  it('the pipeline: a model with no portfolio gives Collect, Deliver and Renew their days', () => {
    const a = arrangement('k', 'Dental practices', { value: { tier: 'COMPARABLE', p10: 200, p50: 300, p90: 450, observations: 3 }, unknownParts: [] } as never);
    const steps = arrangementSteps(a, { ...ctx, modelled: sweptModel, send: [], collect: [] });
    for (const label of ['Collect payment', 'Deliver and confirm', 'Renew']) expect(steps.find((s) => s.label.startsWith(label))!.startDay, label).not.toBeNull();
    expect(planIntegrity(fromSteps(steps)).violations).toEqual([]);
  });

  it('the pipeline (this branch): with no model at all, a step after the offer names why it has no day', () => {
    const a = arrangement('k', 'Dental practices', { value: { tier: 'COMPARABLE', p10: 200, p50: 300, p90: 450, observations: 3 }, unknownParts: [] } as never);
    const unknown = arrangementSteps(a, { ...ctx, modelled: null, send: [], collect: [] });
    const collect = unknown.find((s) => s.label === 'Collect payment')!;
    expect(collect.startDay).toBeNull();
    expect(collect.arrangement?.unscheduled).toBe('NO_MODEL_DAYS');
    expect(planIntegrity(fromSteps(unknown)).violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. PRICE_GROUNDED                                                   */
/* ------------------------------------------------------------------ */

describe('6. PRICE_GROUNDED: a comparable price spans at most COMPARABLE_SPREAD_MAX', () => {
  // The production sweep: $2,569 the geometric middle of $42 and $156,737; its p10–p90 spread 47×.
  const pooled = { price: { value: null, low: 140, high: 47 * 140, provenance: 'UNKNOWN', source: null, note: 'swept', inferred: { tier: 'MECHANISM', justified: false, p10: 140, p50: 960, p90: 47 * 140, observations: 9 } } } as unknown as ModelledOpportunity;

  it('the checker flags a lead swept across a 47× spread', () => {
    const a = arrangement('k', 'Dental practices');
    expect(leadPrice(a, pooled)).toEqual({ basis: 'COMPARABLE', spread: 47 });
    const input = checked([step(1, 'Reach Dental practices', { arrangementKey: 'k', stage: 'REACH', costSource: 'NONE_HELD' })], { lead: leadOf(a, pooled) });
    expect(rules(input)).toEqual(['PRICE_GROUNDED']);
  });

  it('the pipeline: a sector pool spanning $42–$156,737 is no comparable price', () => {
    const prices = [42, 180, 900, 2_569, 12_000, 60_000, 156_737].map((value) => ({ value, industry: 'Software' }));
    const read = comparablePricesFor({ sector: 'Software', demand: { name: 'Dental practices', claimId: null, from: 'INDUSTRY_MAP', ref: 'n' } }, prices);
    expect('refused' in read).toBe(true);
    const tight = comparablePricesFor({ sector: 'Software' }, [200, 260, 300].map((value) => ({ value, industry: 'Software' })));
    expect('prices' in tight && tight.prices).toEqual([200, 260, 300]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. UNKNOWN_BECOMES_RESEARCH                                         */
/* ------------------------------------------------------------------ */

describe('7. UNKNOWN_BECOMES_RESEARCH: an unpriced lead population is sent as price research', () => {
  const a = arrangement('homes', 'homeowners');
  const steps = [step(1, 'Reach homeowners', { arrangementKey: 'homes', stage: 'REACH', costSource: 'NONE_HELD' })];

  it('the checker flags an unpriced lead with no price research raised, and passes one with it', () => {
    expect(leadPrice(a, null)).toEqual({ basis: 'UNPRICED', spread: null });
    expect(rules(checked(steps, { lead: leadOf(a, null), unpriced: [] }))).toEqual(['UNKNOWN_BECOMES_RESEARCH']);
    expect(rules(checked(steps, { lead: leadOf(a, null), unpriced: [{ population: 'pop_homes' }] }))).toEqual([]);
  });

  it('the pipeline: with no portfolio, the reading carries the lead\'s population first among its price questions', () => {
    const others = [arrangement('a1', 'dental practices'), arrangement('a2', 'school districts')];
    const selected = selectEstimatedArrangements([...others, a], { projectId: 'p', currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], knowledge: null, now: new Date(), otherPrices: [] } as never);
    expect(selected.openings).toEqual([]);
    const { unpriced } = unpricedForPlan(selected.selection.unpriced, a);
    expect(unpriced?.[0]?.population).toBe('pop_homes');
    expect(rules(checked(steps, { lead: leadOf(a, null), unpriced: unpriced ?? [] }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Reconstructed plans                                              */
/* ------------------------------------------------------------------ */

/**
 * Production plan reads, 18:00Z on 62214360. A reconstructed plan's steps
 * come from the reconstruction's changes, not from an arrangement, and none
 * of them said where its cost or its day came from.
 */
describe('8. a reconstructed plan: its scope in words, its sale and collection costed and scheduled, one step per move, read in order', () => {
  const recon = (changes: StrategyChange[], members: string[]): Reconstruction => {
    const r = productionReconstruction();
    return { ...r, best: { ...r.best, changes, members } } as Reconstruction;
  };
  const adoption = { source: 'RECONSTRUCTED' as const, hypothetical: false, reason: 'beats the plan as held' };
  const titles = new Map(GOAL_10K_OPENINGS.map((o) => [o.opportunity.id, o.opportunity.title]));
  /** Days to usable cash as the model holds them: the fixture's swept ranges (`modelledCashSpan` reads the same). */
  const daysOf = (o: ModelledOpportunity) => ({ span: { low: o.daysToCash.low!, high: o.daysToCash.high! }, standing: 'the range the model swept: an assumption, not established' });
  const cashDays = new Map(GOAL_10K_OPENINGS.map((o) => [o.opportunity.id, daysOf(o)]));
  const base: StrategyState = { openings: GOAL_10K_OPENINGS, committed: 0, changes: [] };
  const limits = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 50, seed: 3 };
  const input = { openings: GOAL_10K_OPENINGS, portfolio: limits, baseline: evaluateGoalPortfolio({ ...limits, openings: GOAL_10K_OPENINGS }), required: 0.9 };
  const moves = (program: Transform[], reserve: ModelledOpportunity[] = []) =>
    applyProgram(base, program, { operators: buildOperators({ input, base }), operatorsFor: (t: string) => buildOperators({ input, base, target: t }), remaining: 10_000, reserve: reserve as never }).state.changes;
  const days = (l: number, h = l) => ({ startDay: { low: l, high: h } });

  it('the checker flags goal $5K\'s steps: the scope key, and "Sell and collect" costed 0 with nothing holding it', () => {
    const old = [
      step(1, 'Raise price ×4.00 on 4 opening(s) (ALL)', { cost: 0, stage: 'OFFER', costSource: 'MODEL' }),
      step(2, 'Sell Constructed', { cost: 0, ...days(3, 10), stage: 'REACH', costSource: 'MODEL' }),
      step(3, 'Sell and collect', { cost: 0, ...days(10), dependsOn: 2, stage: 'COLLECT' }),
    ];
    expect(rules(checked(old))).toEqual(['NO_INTERNAL_KEYS', 'NO_FABRICATED_FIGURE']);
    expect(planIntegrity(checked(old)).violations.find((v) => v.rule === 'NO_FABRICATED_FIGURE')!.detail).toMatch(/^step 3 \("Sell and collect"\)/);
    // A null where the model holds nothing is no figure.
    expect(rules(checked([{ ...old[2]!, cost: null, costSource: 'NONE_HELD' }]))).toEqual([]);
  });

  it('the checker flags goal B\'s steps: `Bring in "Constructed` six times, and "Sell and collect" costed 0', () => {
    const old = [
      step(1, 'Ask for a deposit of 30–50% at signing (assumed accepted)', { cost: 0, stage: 'OFFER', costSource: 'MODEL' }),
      ...[2, 3, 4, 5, 6, 7].map((n) => step(n, 'Bring in "Constructed', { cost: 0, stage: 'OFFER', costSource: 'MODEL' })),
      step(8, 'Sell and collect', { cost: 0, stage: 'COLLECT' }),
    ];
    expect(rules(checked(old))).toEqual(['NO_FABRICATED_FIGURE', 'NO_DUPLICATE_STEPS']);
    expect(planIntegrity(checked(old)).violations.filter((v) => v.rule === 'NO_DUPLICATE_STEPS').map((v) => v.detail.match(/^step (\d)/)![1])).toEqual(['3', '4', '5', '6', '7']);
  });

  it('the checker flags goals $100K and A: "Establish an offer and a price · day 0" after "Run the next group · day 12–56", depending on nothing', () => {
    const old = [
      step(1, 'Research the buyers', { kind: 'RESEARCH', cost: 0, arrangementKey: 'k', stage: 'RESEARCH', costSource: 'NOT_SPENT' }),
      step(2, 'Reach Dental practices', { ...days(2), arrangementKey: 'k', stage: 'REACH', costSource: 'NONE_HELD' }),
      step(3, 'Validate the offer with Dental practices', { ...days(2), dependsOn: 2, kind: 'VALIDATE', arrangementKey: 'k', stage: 'OFFER', costSource: 'NONE_HELD' }),
      step(10, 'Run the next group', { ...days(12, 56), dependsOn: 3, arrangementKey: 'k', stage: 'REPEAT', costSource: 'NONE_HELD' }),
      step(11, 'Establish an offer and a price', { kind: 'RESEARCH', cost: 0 }),
    ];
    expect(rules(checked(old))).toEqual(['STEPS_SCHEDULED']);
    expect(planIntegrity(checked(old)).violations[0]!.detail).toMatch(/^step 11 \("Establish an offer and a price", day 0\) comes after step 10 \("Run the next group", day 12\)/);
    // The same step first, or naming the step it follows, is in order.
    expect(rules(checked([{ ...old[4]!, order: 0 }, ...old.slice(0, 4)]))).toEqual([]);
    expect(rules(checked([...old.slice(0, 4), { ...old[4]!, dependsOn: 10 }]))).toEqual([]);
  });

  it('the pipeline, goal $5K: the price move\'s scope in words, the partner titled by its opening, the sale and collection costed null and dated from days to usable cash', () => {
    const changes = moves([{ op: 'PRICE', factor: 4, scope: 'ALL' }, { op: 'OPERATOR', key: 'partner:', target: 'arr_ai_reception' }]);
    expect(changes.map((c) => c.dimension)).toEqual(['PRICE', 'PARTNER']);
    // A change written before the move wrote words (production: "(ALL)") reads the same.
    const held = { ...changes[0]!, detail: changes[0]!.detail.replace('(all of them)', '(ALL)') };
    for (const c of [changes, [held, changes[1]!]]) {
      const steps = planSteps({ adoption, reconstruction: recon(c, ['arr_ai_reception', 'arr_gifts']), sales: [], nextTest: null, permissionsMissing: [], titles, cashDays, daysLeft: 30 });
      expect(steps.map((s) => s.label)).toEqual([
        'Raise price ×4.00 on 8 opening(s) (all of them)',
        'Sell "Constructed: AI receptionist setups for home-service firms" through a partner who already serves its buyers (a…',
        "Sell the plan's openings",
        'Collect payment',
      ]);
      const [price, partner, sell, collect] = steps;
      // A move that commits nothing carries the reconstruction's own 0; selling and collecting, which the model prices nothing for, carry null.
      expect(price).toMatchObject({ cost: 0, startDay: { low: 0, high: 0 }, stage: { stage: 'OFFER', costSource: 'MODEL' } });
      // The partner's setup, 3–10 days, as production read it.
      expect(partner).toMatchObject({ cost: 0, startDay: { low: 3, high: 10 } });
      expect(sell).toMatchObject({ cost: null, startDay: { low: 10, high: 10 }, dependsOn: 2, stage: { stage: 'OFFER', costSource: 'NONE_HELD' } });
      // The sale's day plus the members' swept days to usable cash (5–15 and 10–20), as an arrangement's Collect reads them.
      expect(collect).toMatchObject({ cost: null, startDay: { low: 15, high: 30 }, dependsOn: 3, withinLimits: true, stage: { stage: 'COLLECT', costSource: 'NONE_HELD' } });
      expect(collect!.when).toMatch(/^day 15–30: the sale's day plus 5–20 days to usable cash \(the range the model swept: an assumption, not established\)/);
      expect(planIntegrity(fromSteps(steps)).violations).toEqual([]);
    }
  });

  it('the pipeline, goal B: six openings brought in are one step naming each, and nothing is pinned to day 0 that settles later', () => {
    const reserve = Array.from({ length: 6 }, (_, i) => ({ ...GOAL_10K_OPENINGS[i % 3]!, opportunity: { id: `arr_b${i}`, title: `Constructed: ${['VA', 'school', 'clinic', 'county', 'library', 'port'][i]} reports for public buyers` } })) as ModelledOpportunity[];
    const changes = moves([{ op: 'OPERATOR', key: 'timing:deposit' }, ...reserve.map((o) => ({ op: 'INCLUDE' as const, key: o.opportunity.id }))], reserve);
    expect(changes.filter((c) => c.label.startsWith('include:'))).toHaveLength(6);
    const t = new Map([...titles, ...reserve.map((o) => [o.opportunity.id, o.opportunity.title] as const)]);
    const steps = planSteps({ adoption, reconstruction: recon(changes, reserve.map((o) => o.opportunity.id)), sales: [], nextTest: null, permissionsMissing: [], titles: t, cashDays: new Map(reserve.map((o) => [o.opportunity.id, daysOf(o)])), daysLeft: 60 });
    expect(steps.map((s) => s.label)).toEqual(['Ask for a deposit of 30–50% at signing (assumed accepted)', 'Bring in 6 openings', "Sell the plan's openings", 'Collect payment']);
    const bring = steps[1]!;
    for (const o of reserve) expect(bring.detail).toContain(`"${o.opportunity.title}"`);
    expect(bring).toMatchObject({ cost: 0, startDay: { low: 0, high: 0 } });
    // Selling starts now; cash does not: it lands on the members' days to usable cash.
    expect(steps[2]).toMatchObject({ startDay: { low: 0, high: 0 }, cost: null });
    // (5–15, 10–20 and 10–25 days: the three constructed cards the reserve was cut from.)
    expect(steps[3]).toMatchObject({ startDay: { low: 5, high: 25 }, cost: null });
    expect(planIntegrity(fromSteps(steps)).violations).toEqual([]);
  });

  it('the pipeline, goals $100K and A: an arrangement\'s full sequence ends with its own last step, not a repeated "Establish an offer and a price"', () => {
    const a = arrangement('k', 'Dental practices', { design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' }, unknownParts: ['buyers', 'value', 'conversion'] } as never);
    const generic: NextTest = { link: 'OFFER_AND_PRICE', test: 'Discover, construct and research openings that can reach the 100000 USD still needed — the openings held reach at most 9000 USD — and establish each one\'s buyer, price, fulfilment, costs and settlement so the quant engine can combine them.', by: 'BRAIN', blocker: null };
    const steps = planSteps({ adoption: { source: 'BASELINE', hypothetical: false, reason: 'held' }, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: [], arrangement: { arrangement: a, context: { ...ctx, modelled: { daysToCash: swept(10, 54) } as unknown as ModelledOpportunity } } });
    expect(steps.at(-1)).toMatchObject({ label: 'Run the next group', startDay: { low: 12, high: 56 } });
    expect(steps.filter((s) => s.label === 'Establish an offer and a price')).toEqual([]);
    expect(steps.map((s) => s.label)).toContain('Research the price');
    expect(planIntegrity({ ...fromSteps(steps, { lead: leadOf(a, null) }), unpriced: [{ population: 'pop_k' }] }).violations).toEqual([]);
  });

  it('the pipeline, goal $10K: an opening with no price leads with "Establish an offer and a price", research that spends nothing, and it is no violation', () => {
    const generic: NextTest = { link: 'OFFER_AND_PRICE', test: 'Discover, construct and research openings that can reach the 10000 USD still needed — the openings held reach at most 3249 USD — and establish each one\'s buyer, price, fulfilment, costs and settlement so the quant engine can combine them.', by: 'BRAIN', blocker: null };
    const steps = planSteps({ adoption: { source: 'BASELINE', hypothetical: false, reason: 'held' }, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: [], arrangement: null });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label: 'Establish an offer and a price', startDay: { low: 0, high: 0 }, cost: 0, dependsOn: null, stage: { stage: 'RESEARCH', costSource: 'NOT_SPENT' } });
    const acceptance = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, shortfalls: [], sentence: 'A candidate.', candidate: { label: 'Pennsylvania opening', opportunityIds: ['cop_8015'], source: 'QUANT_PORTFOLIO', settledP50: null, reach: null, reachBasis: null } } as PlanAcceptance;
    expect(planIntegrity(fromSteps(steps, { acceptance })).violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

describe('a plan that breaks a rule is never accepted', () => {
  const accepted: PlanAcceptance = {
    status: 'ACCEPTED',
    required: 0.9,
    probability: { value: 0.95, lowerBound: 0.91, basis: 'EVIDENCED_PORTFOLIO', sample: 40, note: 'n' },
    accepted: { label: 'Homeowner checklists', opportunityIds: ['arr_homes'] },
    candidate: { label: 'Homeowner checklists', opportunityIds: ['arr_homes'], source: 'QUANT_PORTFOLIO', settledP50: 12_000, reach: 0.95, reachBasis: 'PROBABILITY' },
    shortfalls: [],
    sentence: 'Accepted: the evidenced combination collects the target.',
    verdict: 'CONFIDENCE_VERIFIED',
  };
  const keyed: PlanStep = { order: 1, label: 'focus:4', detail: 'concentrate outreach', startDay: { low: 0, high: 0 }, cost: 0, basis: 'ESTIMATE', owner: 'BRAIN', ownerReason: null, dependsOn: null, kill: 'k', execution: [] };

  it('downgrades ACCEPTED to a candidate, with each violation a shortfall and no probability or accepted plan', () => {
    let recomposed = 0;
    const out = gateIntegrity(reading({ acceptance: accepted, verdict: 'RECOMMENDABLE', summary: accepted.sentence, steps: [keyed] }), () => {
      recomposed += 1;
      return { continuation: { continues: true, reason: 'no plan is accepted yet', surplusForSuccessors: 0 } };
    });
    expect(recomposed).toBe(1);
    expect(out.integrity!.map((v) => v.rule)).toEqual(['NO_INTERNAL_KEYS']);
    expect(out.acceptance).toMatchObject({ status: 'CANDIDATE_ONLY', probability: null, accepted: null, verdict: 'IMPROVEMENT_REQUIRED' });
    expect(out.acceptance.shortfalls[0]).toMatch(/^NO_INTERNAL_KEYS: step 1/);
    expect(out.verdict).toBe('NEEDS_EVIDENCE');
    expect(out.summary).toMatch(/^Not accepted: the plan breaks 1 integrity rule/);
    expect(out.summary).not.toMatch(/Accepted:/);
  });

  it('leaves a clean or unaccepted reading as it is, and always exposes its integrity', () => {
    const clean = gateIntegrity(reading({ acceptance: accepted, verdict: 'RECOMMENDABLE' }), () => {
      throw new Error('not recomposed');
    });
    expect(clean.acceptance.status).toBe('ACCEPTED');
    expect(clean.integrity).toEqual([]);
    const candidate = gateIntegrity(reading({ steps: [keyed] }), () => {
      throw new Error('not recomposed');
    });
    expect(candidate.acceptance.status).toBe('CANDIDATE_ONLY');
    expect(candidate.integrity!.length).toBe(1);
    expect(refuseForIntegrity(accepted, [])).toBe(accepted);
  });

  it('planReady refuses a plan with integrity violations', () => {
    const facts = { acceptance: accepted, members: [], steps: [], portfolio: null, hermes: null, integrity: [{ rule: 'NO_INTERNAL_KEYS', detail: 'step 1 is titled with the key "bundle"' }] } as unknown as PlanReadyFacts;
    expect(planReady(facts).conditions.PLAN_INTEGRITY).toMatch(/breaks 1 integrity rule/);
    expect(planReady({ ...facts, integrity: [] }).conditions.PLAN_INTEGRITY).toBeNull();
  });

  it('the release check prints one line per goal, or one per violation', () => {
    expect(integrityLines('wst_a', { acceptance: { ...accepted, status: 'CANDIDATE_ONLY', probability: null }, integrity: [] })).toEqual({ ok: true, lines: ['INTEGRITY wst_a OK CANDIDATE_ONLY reach 95%'] });
    expect(integrityLines('wst_b', { acceptance: { ...accepted, candidate: null, probability: null, status: 'NO_CANDIDATE' }, integrity: [] }).lines).toEqual(['INTEGRITY wst_b OK NO_CANDIDATE reach n/a']);
    const bad = integrityLines('wst_c', { acceptance: { ...accepted, status: 'CANDIDATE_ONLY' }, integrity: [{ rule: 'NO_INTERNAL_KEYS', detail: 'step 1 is titled with the key "bundle"' }, { rule: 'STEPS_SCHEDULED', detail: 'step 4 has no day' }] });
    expect(bad).toEqual({ ok: false, lines: ['INTEGRITY wst_c VIOLATED CANDIDATE_ONLY NO_INTERNAL_KEYS: step 1 is titled with the key "bundle"', 'INTEGRITY wst_c VIOLATED CANDIDATE_ONLY STEPS_SCHEDULED: step 4 has no day'] });
  });
});
