/**
 * The planningReliability grader's mechanism-validity classes (audit 2026-11-23,
 * docs/audits/2026-11-23-10k-plan-audit.md): a non-purchase payment counted as a price, one
 * payer swept as a population, reach reported from members that cannot transact, a plan
 * certified without acquisition/fulfilment/payment, and contradictory downside estimates.
 * Each is read from structured fields only; a conclusion that names the gap is not failed for it.
 *
 * Grader and declarations only: the harness (which sets the bench's process environment) is
 * never imported.
 */
import { describe, expect, it } from 'vitest';
import { caseProblem, type PlanningCase } from '../bench/planningReliability/case.ts';
import { PUBLIC_CASES } from '../bench/planningReliability/cases.ts';
import { CRITICAL, E2E_FAILURE_CLASSES, estimatesContradict, FAILURE_CLASSES, grade, mechanismFailures, observeMechanism, type ObservedMechanism, type ObservedPlan } from '../bench/planningReliability/grade.ts';
import { MECHANISM_CASES } from '../bench/planningReliability/mechanismCases.ts';
import type { PlanReading } from '../server/services/goals/plan.ts';

const byId = (id: string): PlanningCase => {
  const c = PUBLIC_CASES.find((one) => one.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

const mechanism = (over: Partial<ObservedMechanism> = {}): ObservedMechanism => ({
  counted: [],
  priceHeld: {},
  dealsModelled: {},
  reach: null,
  untransactable: [],
  infeasible: [],
  certified: false,
  adverse: null,
  pathwayP10: null,
  gap: 10_000,
  ...over,
});

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
  targetCents: 1_000_000,
  gate: null,
  ...over,
});
const member = (key: string, over: Partial<ObservedPlan['members'][number]> = {}) => ({ key, unestablished: [], capitalLow: 0, cashStructure: false, deals: 1, ...over });

describe('the mechanism-validity cases', () => {
  it('are well-formed public cases, held out, and state what they test in the rubric', () => {
    for (const c of MECHANISM_CASES) {
      expect(caseProblem(c), c.id).toBeNull();
      expect(PUBLIC_CASES).toContain(c);
      expect(c.heldOut).toBe(true);
    }
    expect(MECHANISM_CASES.some((c) => (c.expect.notAPurchasePrice ?? []).length > 0)).toBe(true);
    expect(MECHANISM_CASES.some((c) => Object.keys(c.expect.payerDealsMax ?? {}).length > 0)).toBe(true);
    expect(MECHANISM_CASES.some((c) => c.expect.verdict === 'EXECUTABLE_PLAN')).toBe(true);
  });

  it('refuses a rubric naming an opening the case does not hold, or a deal cap that is not a count', () => {
    const c = byId('mv-03-one-payer-swept-as-population');
    expect(caseProblem({ ...c, expect: { ...c.expect, notAPurchasePrice: ['nothing'] } })).toMatch(/does not hold/);
    expect(caseProblem({ ...c, expect: { ...c.expect, payerDealsMax: { nothing: 1 } } })).toMatch(/does not hold/);
    expect(caseProblem({ ...c, expect: { ...c.expect, payerDealsMax: { meridian: 1.5 } } })).toMatch(/whole number/);
  });

  it('declares the classes, critical where the plan would act on the wrong money', () => {
    for (const k of ['NON_PURCHASE_PRICE', 'PAYER_POPULATION_INFLATED', 'UNSUPPORTED_REACH', 'ACCEPTANCE_UNFEASIBLE'] as const) expect(FAILURE_CLASSES).toContain(k);
    // A contradiction between two estimators is graded beside the verdict, on the end-to-end level.
    expect(E2E_FAILURE_CLASSES).toContain('ESTIMATES_CONTRADICT');
    expect((FAILURE_CLASSES as readonly string[]).includes('ESTIMATES_CONTRADICT')).toBe(false);
    expect(CRITICAL.has('NON_PURCHASE_PRICE')).toBe(true);
    expect(CRITICAL.has('PAYER_POPULATION_INFLATED')).toBe(true);
    expect(CRITICAL.has('ACCEPTANCE_UNFEASIBLE')).toBe(true);
    expect(CRITICAL.has('UNSUPPORTED_REACH')).toBe(false);
  });
});

describe('NON_PURCHASE_PRICE', () => {
  const c = byId('mv-01-github-bounty-audit');

  it('fails a no-plan reading that still counts the bounty reward as an established price', () => {
    // The audit's reading: no plan, for other reasons, while its leading combination counts GitHub at $10,000.
    const o = observed({ missing: { github: ['REACHABLE_BUYER', 'OFFER_AND_PRICE'] }, named: ['OFFER_AND_PRICE'], mechanism: mechanism({ counted: ['github', 'templates'], priceHeld: { github: 10_000 } }) });
    const g = grade(c, o);
    expect(g.pass).toBe(false);
    expect(g.failures).toContain('NON_PURCHASE_PRICE');
  });

  it('passes the same conclusion once the reward is no longer held as a price, or no longer counted', () => {
    expect(grade(c, observed({ missing: { github: ['OFFER_AND_PRICE'] }, named: ['OFFER_AND_PRICE'], mechanism: mechanism({ counted: ['github'] }) })).pass).toBe(true);
    expect(grade(c, observed({ missing: { github: ['OFFER_AND_PRICE'] }, named: ['OFFER_AND_PRICE'], mechanism: mechanism({ counted: ['templates'], priceHeld: { github: 10_000 } }) })).pass).toBe(true);
  });

  it('adds to a false executable plan on the reward, and is never judged without the observation', () => {
    const iso = byId('mv-02-bounty-payout-as-price');
    const g = grade(iso, observed({ stance: 'EXECUTABLE', members: [member('ossAudit')], mechanism: mechanism({ counted: ['ossAudit'], priceHeld: { ossAudit: 500 } }) }));
    expect(g.failures).toEqual(expect.arrayContaining(['FALSE_EXECUTABLE', 'NON_PURCHASE_PRICE', 'ACCEPTANCE_UNFEASIBLE']));
    expect(mechanismFailures(iso, observed({ stance: 'EXECUTABLE', members: [member('ossAudit')] })).failures).toEqual([]);
  });
});

describe('PAYER_POPULATION_INFLATED', () => {
  const c = byId('mv-03-one-payer-swept-as-population');

  it('fails a reading that models a single payer as many deals, even when its conclusion names the volume gap', () => {
    const o = observed({ missing: { meridian: ['MARKET_VOLUME'] }, named: ['MARKET_VOLUME'], members: [member('meridian')], mechanism: mechanism({ counted: ['meridian'], dealsModelled: { meridian: 14 } }) });
    const g = grade(c, o);
    expect(g.failures).toEqual(['PAYER_POPULATION_INFLATED']);
    expect(g.detail).toMatch(/up to 14 deals from meridian/);
  });

  it('passes a reading that holds the payer to its one purchase', () => {
    const o = observed({ missing: { meridian: ['MARKET_VOLUME'] }, named: ['MARKET_VOLUME'], members: [member('meridian')], mechanism: mechanism({ counted: ['meridian'], dealsModelled: { meridian: 1 } }) });
    expect(grade(c, o)).toMatchObject({ pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT' });
  });

  it('reads the deals the plan counts as well as the deals it models', () => {
    const o = observed({ named: ['MARKET_VOLUME'], members: [member('meridian', { dealsCounted: 3 })], mechanism: mechanism({ counted: ['meridian'], dealsModelled: { meridian: 0 } }) });
    expect(mechanismFailures(c, o).failures).toEqual(['PAYER_POPULATION_INFLATED']);
  });
});

describe('UNSUPPORTED_REACH, ACCEPTANCE_UNFEASIBLE and ESTIMATES_CONTRADICT', () => {
  const c = byId('fam-03-cleaning-no-fulfiller');

  it('flags reach reported from a member the reading says cannot transact, but not zero reach', () => {
    const base = { missing: { cleaning: ['FULFILMENT' as const] }, named: ['FULFILMENT' as const] };
    expect(grade(c, observed({ ...base, mechanism: mechanism({ reach: 0.98, untransactable: ['cleaning'] }) })).failures).toEqual(['UNSUPPORTED_REACH']);
    expect(grade(c, observed({ ...base, mechanism: mechanism({ reach: 0, untransactable: ['cleaning'] }) })).pass).toBe(true);
  });

  it('flags a certified plan holding a member that cannot be acquired, fulfilled or paid', () => {
    const o = observed({ status: 'ACCEPTED', missing: { cleaning: ['FULFILMENT'] }, named: ['FULFILMENT'], mechanism: mechanism({ certified: true, infeasible: ['cleaning'] }) });
    expect(grade(c, o).failures).toContain('ACCEPTANCE_UNFEASIBLE');
    expect(mechanismFailures(c, observed({ mechanism: mechanism({ certified: false, infeasible: ['cleaning'] }) })).failures).toEqual([]);
  });

  it('flags two downside estimates that disagree by more than twofold and a tenth of the gap, on the end-to-end level only', () => {
    // The audit's figures: adverse $32,266 against a pathway p10 of $368, on a $10,000 gap.
    expect(estimatesContradict(mechanism({ adverse: 32_266, pathwayP10: 368, gap: 10_000 }))).toMatch(/adverse case collects 32266 while its pathway portfolio's p10 nets 368/);
    // Agreeing figures, a disagreement too small to matter against the gap, and a missing figure are not a contradiction.
    expect(estimatesContradict(mechanism({ adverse: 472, pathwayP10: 446, gap: 1000 }))).toBeNull();
    expect(estimatesContradict(mechanism({ adverse: 30, pathwayP10: 5, gap: 10_000 }))).toBeNull();
    expect(estimatesContradict(mechanism({ adverse: 32_266, pathwayP10: null }))).toBeNull();
    expect(estimatesContradict(undefined)).toBeNull();
    const fam = byId('fam-01-property-executable');
    const g = grade(fam, observed({ stance: 'EXECUTABLE', verdict: 'QUANTITATIVELY_CONSTRUCTED', members: [member('property', { deals: 10 })], mechanism: mechanism({ adverse: 32_266, pathwayP10: 368, gap: 10_000 }), execution: { steps: [], daysLeft: 30, hoursCeiling: null, strategies: 1, considered: ['property'], excluded: [], resolves: [], relax: [], researchFirst: 0, economics: {} } }));
    expect(g.pass).toBe(true);
    expect(g.e2e.failures).toContain('ESTIMATES_CONTRADICT');
  });
});

describe('observeMechanism', () => {
  const keyOf = (id: string) => ({ o1: 'github', o2: 'templates' })[id] ?? id;
  const demand = (id: string, price: number, unestablished: string[], deals: number) => ({ opportunityId: id, price: { p10: price, p50: price, p90: price }, deals: { p10: 0, p50: deals, p90: deals }, unestablished });
  const reading = (over: Record<string, unknown> = {}) =>
    ({
      acceptance: { status: 'CANDIDATE_ONLY', verdict: 'IMPROVEMENT_REQUIRED', probability: null, candidate: { label: 'x', opportunityIds: ['o2'], source: 'QUANT_PORTFOLIO', settledP50: 0, reach: 0.4, reachBasis: 'COVERAGE' } },
      considered: [
        { opportunityId: 'o1', missing: ['REACHABLE_BUYER', 'CONVERSION'] },
        { opportunityId: 'o2', missing: ['CONVERSION'] },
      ],
      portfolio: { best: { members: [{ opportunityId: 'o2' }] }, demand: [demand('o1', 10_000, ['days to usable cash'], 0), demand('o2', 9, ['price'], 40)] },
      pathways: {
        pathways: [
          { opportunityId: 'arr_x', channel: { status: 'UNKNOWN' }, offer: { status: 'UNKNOWN' }, fulfiller: { status: 'UNKNOWN' }, daysToCash: { status: 'UNKNOWN' }, revenuePerDeal: { status: 'ESTIMATED', value: 500 }, failurePoints: [] },
        ],
        portfolio: { leading: { members: ['o1', 'arr_x'], net: { p10: 368, p50: 10_000, p90: 10_000 } } },
      },
      objective: { outcome: { adverse: 32_266 } },
      target: { targetCents: 1_000_000, remainingCents: 1_000_000 },
      ...over,
    }) as unknown as PlanReading;

  it('reads what the reading counts, at what price, from its own structured fields', () => {
    const m = observeMechanism(reading(), keyOf);
    expect(new Set(m.counted)).toEqual(new Set(['templates', 'github', 'arr_x']));
    // The reward is held as an established price; the template's price is not (unestablished); a constructed leg's estimated revenue is.
    expect(m.priceHeld).toEqual({ github: 10_000, arr_x: 500 });
    expect(m.dealsModelled).toEqual({ github: 0, templates: 40 });
    expect(m).toMatchObject({ reach: 0.4, untransactable: [], infeasible: [], certified: false, adverse: 32_266, pathwayP10: 368, gap: 10_000 });
  });

  it('takes a constructed member’s gaps from its pathway, and a price judged missing is not held', () => {
    const m = observeMechanism(
      reading({
        acceptance: { status: 'ACCEPTED', verdict: 'CONFIDENCE_VERIFIED', probability: null, candidate: { label: 'x', opportunityIds: ['arr_x', 'o1'], source: 'QUANT_PORTFOLIO', settledP50: 0, reach: 0.98, reachBasis: 'COVERAGE' } },
        considered: [{ opportunityId: 'o1', missing: ['OFFER_AND_PRICE'] }],
      }),
      keyOf,
    );
    expect(m.untransactable).toEqual(['arr_x', 'github']);
    expect(m.infeasible).toEqual(['arr_x']);
    expect(m.certified).toBe(true);
    expect(m.priceHeld['github']).toBeUndefined();
  });

  it('reads a partial reading as counting nothing', () => {
    const m = observeMechanism({ acceptance: { candidate: null }, target: { targetCents: 0 } } as unknown as PlanReading, keyOf);
    expect(m).toMatchObject({ counted: [], priceHeld: {}, dealsModelled: {}, reach: null, adverse: null, pathwayP10: null, gap: 0 });
  });
});
