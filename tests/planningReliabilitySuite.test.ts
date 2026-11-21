/**
 * The planningReliability suite (docs/COMPLETION-SPEC.md; §114): its grader judges a
 * planning result in code — correct plans and justified no-plan conclusions pass, a false
 * executable plan and an unjustified refusal fail — its public cases cover every coverage
 * dimension, and it is registered with the 90% target and the critical-failure guard.
 *
 * The suite's runner drives the real planner on databases of its own (`npm run bench --
 * --suite planningReliability`); this file tests the grader and the declarations only, so it
 * never imports the harness (which sets the bench's process environment).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSuite } from '../server/domain/evolutionSuites.ts';
import { caseProblem, CONVERSION_UNITS, conversionSentence, LINKS, type ConversionUnit, type PlanningCase } from '../bench/planningReliability/case.ts';
import { readInboundCommitments } from '../server/services/cash/goalScenario.ts';
import { PUBLIC_CASES } from '../bench/planningReliability/cases.ts';
import { constraintsNamed, CRITICAL, grade, observe, ownerHours, type ObservedPlan } from '../bench/planningReliability/grade.ts';
import type { PlanReading } from '../server/services/goals/plan.ts';

const byId = (id: string): PlanningCase => {
  const c = PUBLIC_CASES.find((one) => one.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

const observed = (over: Partial<ObservedPlan>): ObservedPlan => ({
  stance: 'NO_PLAN',
  status: 'CANDIDATE_ONLY',
  verdict: 'IMPROVEMENT_REQUIRED',
  infeasible: null,
  broken: [],
  members: [],
  missing: {},
  named: [],
  collectAfterDeadline: false,
  scope: { industry: null, recurring: null, hoursPerWeek: null },
  targetCents: 500_000,
  gate: null,
  ...over,
});

const member = (key: string, over: Partial<ObservedPlan['members'][number]> = {}) => ({ key, unestablished: [], capitalLow: 0, cashStructure: false, deals: 10, ...over });

describe('the grader', () => {
  it('marks a known-correct executable plan correct', () => {
    const g = grade(byId('fam-01-property-executable'), observed({ stance: 'EXECUTABLE', verdict: 'QUANTITATIVELY_CONSTRUCTED', members: [member('property')] }));
    expect(g).toMatchObject({ pass: true, outcome: 'EXECUTABLE_PLAN_CORRECT', failures: [] });
  });

  it('marks a no-plan conclusion correct only when it names the decisive blocker', () => {
    const c = byId('fam-03-cleaning-no-fulfiller');
    expect(grade(c, observed({ missing: { cleaning: ['FULFILMENT'] }, named: ['FULFILMENT'] }))).toMatchObject({ pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT' });
    const infeasible = byId('fam-04-out-of-reach-target');
    expect(grade(infeasible, observed({ status: 'NOT_SUPPORTED', infeasible: ['TARGET'] }))).toMatchObject({ pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT' });
    // A capital limit named as the strategy's broken constraint, or as the economics link, is the same blocker.
    const capital = byId('fam-05-restaurant-capital-limit');
    expect(grade(capital, observed({ broken: ['CAPITAL'] })).pass).toBe(true);
    expect(grade(capital, observed({ named: ['ECONOMICS'] })).pass).toBe(true);
    // The planner's own constraint sentences name the limit they break.
    expect(constraintsNamed('cannot reach the 2000000 USD still needed at prices buyers are shown to pay, even if every buyer it offers to agreed (at most 90000)')).toEqual(['TARGET']);
    expect(constraintsNamed('"Resale" ties up 16000 USD, more than the 10000 the owner said this goal may commit')).toEqual(['CAPITAL']);
  });

  it('marks a false executable plan incorrect, with what else is wrong with it', () => {
    const g = grade(byId('fam-03-cleaning-no-fulfiller'), observed({ stance: 'EXECUTABLE', members: [member('cleaning')] }));
    expect(g.pass).toBe(false);
    expect(g.failures).toContain('FALSE_EXECUTABLE');
    expect(CRITICAL.has('FALSE_EXECUTABLE')).toBe(true);
    // A contested price planned as if established is also uncertainty read as favourable.
    const contested = grade(byId('fam-07-property-price-contradicted'), observed({ stance: 'EXECUTABLE', members: [member('property')] }));
    expect(contested.failures).toEqual(expect.arrayContaining(['FALSE_EXECUTABLE', 'UNCERTAINTY_AS_FAVOURABLE']));
    // A plan that loses money on every deal is unsound economics as well.
    expect(grade(byId('ho-10-localisation-loses-money'), observed({ stance: 'EXECUTABLE', members: [member('localisation')] })).failures).toEqual(
      expect.arrayContaining(['FALSE_EXECUTABLE', 'UNSOUND_ECONOMICS']),
    );
  });

  it('marks an unjustified refusal incorrect: no plan where one exists, or a no-plan naming the wrong blocker', () => {
    const refused = grade(byId('fam-01-property-executable'), observed({ named: ['CONVERSION'] }));
    expect(refused).toMatchObject({ pass: false, failures: ['UNJUSTIFIED_REFUSAL'] });
    expect(CRITICAL.has('UNJUSTIFIED_REFUSAL')).toBe(false);
    // A generic refusal: no plan, nothing named.
    expect(grade(byId('fam-03-cleaning-no-fulfiller'), observed({})).failures).toEqual(['UNJUSTIFIED_REFUSAL']);
    // The wrong reason: price named where fulfilment is the gap.
    expect(grade(byId('fam-03-cleaning-no-fulfiller'), observed({ missing: { cleaning: ['OFFER_AND_PRICE'] }, named: ['OFFER_AND_PRICE'] })).pass).toBe(false);
    // Missing evidence declared arithmetic infeasibility.
    expect(grade(byId('fam-10-gifts-cost-unknown'), observed({ status: 'NOT_SUPPORTED', infeasible: ['TARGET'], named: ['ECONOMICS'] })).failures).toEqual(['UNJUSTIFIED_REFUSAL']);
  });

  it('holds an executable plan to the objective: scope, capital, assumptions, owner hours, a changed objective', () => {
    expect(grade(byId('fam-08-cleaning-industry-scope'), observed({ stance: 'EXECUTABLE', members: [member('cleaning'), member('property')] })).failures).toEqual(['CONSTRAINT_VIOLATED']);
    expect(grade(byId('fam-12-credit-union-agreed'), observed({ stance: 'EXECUTABLE', members: [member('creditUnion', { capitalLow: 900 })] })).failures).toEqual(['CONSTRAINT_VIOLATED']);
    expect(grade(byId('fam-01-property-executable'), observed({ stance: 'EXECUTABLE', members: [member('property', { unestablished: ['price'] })] })).failures).toEqual(['UNCERTAINTY_AS_FAVOURABLE']);
    expect(grade(byId('fam-01-property-executable'), observed({ stance: 'EXECUTABLE', members: [member('property')], collectAfterDeadline: true })).failures).toEqual(['CONSTRAINT_VIOLATED']);
    const hours = byId('fam-09-owner-hours');
    expect(ownerHours(hours, [member('ownerConsulting', { deals: 4 })])).toBe(40);
    expect(grade(hours, observed({ stance: 'EXECUTABLE', members: [member('property'), member('ownerConsulting', { deals: 4 })] })).failures).toEqual(['OWNER_LABOR_EXCEEDED']);
    expect(grade(hours, observed({ stance: 'EXECUTABLE', members: [member('property')] })).pass).toBe(true);
    expect(grade(byId('fam-14-objective-changed-industry'), observed({ stance: 'EXECUTABLE', members: [member('property')] })).failures).toEqual(['OBJECTIVE_CHANGE_IGNORED']);
    // The changed words state a new target; a plan still read against the old one ignored the change.
    const recurring = byId('ho-14-objective-changed-to-recurring');
    expect(grade(recurring, observed({ stance: 'EXECUTABLE', members: [member('brewery')], targetCents: 150_000 })).pass).toBe(true);
    expect(grade(recurring, observed({ stance: 'EXECUTABLE', members: [member('brewery')], targetCents: 300_000 })).failures).toEqual(['OBJECTIVE_CHANGE_IGNORED']);
  });

  it('reads the stance from the planner’s own verdicts, never from reach against 90%', () => {
    const reading = (over: Record<string, unknown>) =>
      ({
        acceptance: { status: 'CANDIDATE_ONLY', verdict: 'IMPROVEMENT_REQUIRED', candidate: { label: 'x', opportunityIds: ['o1'], source: 'QUANT_PORTFOLIO', settledP50: 1, reach: 0.12, reachBasis: 'COVERAGE' } },
        chosen: 's1',
        strategies: [{ key: 's1', verdict: 'NEEDS_EVIDENCE', opportunityIds: ['o1'], links: [{ link: 'CONVERSION', ok: false, basis: '' }], constraintsFailed: [], chainComplete: false, conservativeSettled: null }],
        considered: [{ opportunityId: 'o1', missing: ['CONVERSION'] }],
        portfolio: null,
        steps: [],
        infeasible: null,
        target: { targetCents: 500_000 },
        ...over,
      }) as unknown as PlanReading;
    const keyOf = (id: string) => (id === 'o1' ? 'property' : id);
    // A 12% reach with every link established is an executable plan: reach is a financial reading.
    const complete = observe(
      reading({ strategies: [{ key: 's1', verdict: 'NEEDS_EVIDENCE', opportunityIds: ['o1'], links: [], constraintsFailed: [], chainComplete: true, conservativeSettled: 6000 }], considered: [{ opportunityId: 'o1', missing: [] }] }),
      keyOf,
    );
    expect(complete.stance).toBe('EXECUTABLE');
    // A 99% reach on an incomplete chain is not.
    const incomplete = observe(reading({ acceptance: { status: 'CANDIDATE_ONLY', verdict: 'IMPROVEMENT_REQUIRED', candidate: { label: 'x', opportunityIds: ['o1'], source: 'QUANT_PORTFOLIO', settledP50: 1, reach: 0.99, reachBasis: 'COVERAGE' } } }), keyOf);
    expect(incomplete).toMatchObject({ stance: 'NO_PLAN', named: ['CONVERSION'], missing: { property: ['CONVERSION'] } });
    const notSupported = observe(reading({ acceptance: { status: 'NOT_SUPPORTED', verdict: 'NOT_SUPPORTED', candidate: null }, infeasible: { reason: 'r', relax: [{ constraint: 'DEADLINE', suggestion: '' }], headroomReach: 0, required: 0.9, instantOnly: false } }), keyOf);
    expect(notSupported).toMatchObject({ stance: 'NO_PLAN', infeasible: ['DEADLINE'] });
  });
});

describe('the public cases', () => {
  it('are at least 30 well-formed cases, at least 10 held out, expecting both kinds of correct result', () => {
    expect(PUBLIC_CASES.length).toBeGreaterThanOrEqual(30);
    for (const c of PUBLIC_CASES) expect(caseProblem(c), c.id).toBeNull();
    expect(new Set(PUBLIC_CASES.map((c) => c.id)).size).toBe(PUBLIC_CASES.length);
    expect(PUBLIC_CASES.filter((c) => c.heldOut).length).toBeGreaterThanOrEqual(10);
    expect(PUBLIC_CASES.filter((c) => c.expect.verdict === 'EXECUTABLE_PLAN').length).toBeGreaterThanOrEqual(10);
    expect(PUBLIC_CASES.filter((c) => c.expect.verdict === 'NO_PLAN').length).toBeGreaterThanOrEqual(10);
  });

  it('cover every coverage dimension', () => {
    const values = <K extends keyof PlanningCase['dimensions']>(k: K) => new Set(PUBLIC_CASES.map((c) => c.dimensions[k]));
    expect(values('capital')).toEqual(new Set(['none', 'small', 'large']));
    expect(values('target')).toEqual(new Set(['small', 'medium', 'large', 'out-of-reach']));
    expect(values('deadline')).toEqual(new Set(['short', 'long']));
    expect(values('autonomy')).toEqual(new Set(['unlimited', 'owner-hours-limited']));
    expect(values('contradictoryEvidence')).toEqual(new Set([true, false]));
    expect(values('objectiveChanged')).toEqual(new Set([true, false]));
    expect(values('industry').size).toBeGreaterThanOrEqual(20);
    expect(values('mechanism').size).toBeGreaterThanOrEqual(7);
    const missing = values('missingEvidence');
    for (const link of LINKS.filter((l) => l !== 'CURRENT_DEMAND')) expect(missing.has(link), link).toBe(true);
    // Held-out industries are ones no familiar case (and so no existing transfer fixture) uses.
    const familiar = new Set(PUBLIC_CASES.filter((c) => !c.heldOut).flatMap((c) => c.openings.map((o) => o.industry)));
    for (const c of PUBLIC_CASES.filter((one) => one.heldOut)) expect(c.openings.some((o) => !familiar.has(o.industry)), c.id).toBe(true);
  });

  it('refuses a malformed case rather than skipping it', () => {
    expect(caseProblem({ id: 'x' })).toBe('no objective');
    expect(caseProblem({ ...byId('fam-03-cleaning-no-fulfiller'), expect: { verdict: 'NO_PLAN' } })).toBe('a NO_PLAN rubric names no blocker');
    expect(caseProblem({ ...byId('fam-01-property-executable'), expect: { verdict: 'EXECUTABLE_PLAN', mustNotUse: ['nothing'] } })).toMatch(/does not hold/);
  });
});

describe('a conversion is written in its own unit', () => {
  // The world once wrote every conversion as "paid pre-orders from N unique visitors", so
  // "6 wins from 40 quotes" reached the planner as 40 visitors, under the landing-page floor.
  const SENTENCES: Record<ConversionUnit, [number, number, string]> = {
    VISITORS: [40, 400, '40 paid pre-orders from 400 unique visitors'],
    QUOTES: [6, 40, '6 wins from 40 quotes'],
    PROPOSALS: [3, 18, '3 bookings from 18 proposals'],
    BIDS: [2, 15, '2 contracts won from 15 bids'],
    CLICKS: [11, 138, '11 bookings from 138 clicks'],
    CONTACTS: [5, 60, '5 agreements from 60 contacts'],
    MEMBERS: [18, 14000, '18 orders from 14,000 members'],
  };

  it.each(CONVERSION_UNITS)('writes %s in its natural wording', (unit) => {
    const [paid, of, sentence] = SENTENCES[unit];
    expect(conversionSentence({ paid, of, unit })).toBe(sentence);
    // Only a visitor count is a landing page's measure; no other unit is ever read as visitors.
    expect(readInboundCommitments(sentence) !== null).toBe(unit === 'VISITORS');
  });

  it('defaults a conversion without a unit, in either spelling, to the sentence every case wrote before', () => {
    expect(conversionSentence({ paid: 40, of: 400 })).toBe('40 paid pre-orders from 400 unique visitors');
    expect(conversionSentence({ paid: 40, visitors: 400 })).toBe('40 paid pre-orders from 400 unique visitors');
    for (const c of PUBLIC_CASES) for (const o of c.openings) {
      if (!o.conversion) continue;
      expect('unit' in o.conversion, `${c.id}/${o.key}`).toBe(false);
      expect(readInboundCommitments(conversionSentence(o.conversion)), `${c.id}/${o.key}`).toMatchObject({ paid: o.conversion.paid });
    }
  });

  it('refuses a case whose conversion unit or counts are not a conversion', () => {
    const base = byId('fam-01-property-executable');
    const withConversion = (conversion: unknown) => ({ ...base, openings: [{ ...base.openings[0]!, conversion }] });
    expect(caseProblem(withConversion({ paid: 6, of: 40, unit: 'QUOTES' }))).toBeNull();
    expect(caseProblem(withConversion({ paid: 6, visitors: 40 }))).toBeNull();
    expect(caseProblem(withConversion({ paid: 6, of: 40, unit: 'LEADS' }))).toMatch(/unknown conversion unit/);
    expect(caseProblem(withConversion({ paid: 6, visitors: 40, unit: 'QUOTES' }))).toMatch(/without "of"/);
    expect(caseProblem(withConversion({ paid: 50, of: 40 }))).toMatch(/paid ≤ of/);
  });
});

describe('the registration', () => {
  it('declares planningReliability on accuracy, higher, target 0.90, guarded by zero critical failures, with a runner', () => {
    const s = findSuite('planningReliability')!;
    expect(s).toMatchObject({ primaryMetric: 'accuracy', direction: 'HIGHER', target: 0.9 });
    expect(s.guards).toEqual([{ metric: 'criticalFailures', direction: 'LOWER', tolerance: 0 }]);
    expect(s.measures.deficiencies).toEqual(expect.arrayContaining(['PLANNING_ASSUMPTION', 'CAPABILITY_BELOW_TARGET']));
    const registry = /export const SUITES: Record<string, Suite> = \{([^}]*)\}/.exec(readFileSync(new URL('../bench/run.ts', import.meta.url), 'utf8'))![1]!;
    expect(registry.split(',').map((x) => x.trim())).toContain('planningReliability');
  });

  it('is the completion standard the spec names, and the spec keeps reach out of it', () => {
    const spec = readFileSync(new URL('../docs/COMPLETION-SPEC.md', import.meta.url), 'utf8');
    expect(spec).toMatch(/^# Completion specification — version 1/m);
    expect(spec).toContain('planningReliability');
    expect(spec).toMatch(/Wilson/);
    expect(spec).toMatch(/is a financial-outcome reading and NOT the\s+completion standard/);
  });
});
