/**
 * A net target is read net (planningReliability round 3, 2026-11-21).
 *
 * The plan gate compared GROSS revenue with the target even when the objective
 * said "net settled cash" (metric CONTRIBUTION), although the engine's own
 * `goal_met` subtracts cost. Fourteen agreements worth $23,560 read as "no new
 * deals needed" against $12,000 while keeping about $10,070; a play needing 147
 * net-positive deals read as needing 13. One rule (`server/services/cash/towardTarget.ts`)
 * now decides what a deal adds toward the target, for the gate, the engine and
 * the portfolio alike, and the grader fails a plan that passes on gross revenue
 * under a net target as UNSOUND_ECONOMICS.
 *
 * Every fixture here is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { conservative } from '../server/services/goals/plan.ts';
import { agreedCostUnits, agreedToward, bestCaseReach, buyersToOffer, costedDeals, countsNet, dealsForGoal, directCostTerm, perDealToward, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { grade, netObjective, type ObservedPlan } from '../bench/planningReliability/grade.ts';
import type { PlanningCase } from '../bench/planningReliability/case.ts';

const fixed = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: '' });

/** A wholesale lot: 14 shops signed at $1,700 each; each order costs $1,000 to land. */
function lot(over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id: 'opp_lot', title: 'Wholesale lot to independent shops' } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1700),
    capital: fixed(50),
    hours: fixed(0.5),
    daysToCash: fixed(40),
    close: { value: 0.35, low: 0.3, high: 0.4, provenance: 'HISTORICAL', source: null, note: '' },
    respond: fixed(1),
    directCost: fixed(1000),
    volume: fixed(100),
    agreed: true,
    agreedValue: 14 * 1700,
    agreedDeals: 14,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

describe('the target’s own metric decides what a deal adds', () => {
  it('reads CONTRIBUTION (the words "net", "profit", "contribution") as net, and every other metric as before', () => {
    expect(countsNet('CONTRIBUTION')).toBe(true);
    expect(countsNet('SETTLED_CASH')).toBe(false);
    expect(countsNet('COLLECTED_CASH')).toBe(false);
    expect(countsNet(undefined)).toBe(false);
  });

  it('counts a deal at its price less its cost on a net target, and the agreements less their deals’ cost', () => {
    const one = lot();
    expect(perDealToward(one, 1700, false)).toBe(1700);
    expect(perDealToward(one, 1700, true)).toBe(700);
    expect(agreedToward(one, false)).toBe(23_800);
    expect(agreedToward(one, true)).toBe(9800);
    // Agreed deals are work still to deliver: their cost is paid as a new deal's is.
    expect(costedDeals(3, one)).toBe(17);
    expect(directCostTerm('o1', one)).toBe('(o1_won + 14) * o1_cost');
  });

  it('costs agreements at the larger of the lots their value fills and their value in deals', () => {
    // Four stores taking $4,940 each of one $26,000 truckload: one truckload is bought, never four.
    expect(agreedCostUnits({ agreedDeals: 4, agreedValue: 4 * 4940, price: fixed(26_000) })).toBe(1);
    // A $7,200 and a $2,400 contract for a $2,700 service are 3.56 deals of work, not two.
    expect(agreedCostUnits({ agreedDeals: 2, agreedValue: 9600, price: fixed(2700) })).toBeCloseTo(9600 / 2700, 9);
    // With no price, one deal an agreement.
    expect(agreedCostUnits({ agreedDeals: 3, agreedValue: 900, price: { ...fixed(0), value: null, low: null } })).toBe(3);
    expect(agreedCostUnits({ agreedDeals: 0, agreedValue: 0, price: fixed(100) })).toBe(0);
  });
});

describe('agreements that cover a net target gross but not net', () => {
  // $12,000 net settled cash in 150 days; $23,800 gross agreed keeps $9,800.
  const target = { daysLeft: 150, remainingCents: 1_200_000 };

  it('before: read gross, the agreements alone met the target and no new deal was asked', () => {
    const one = lot();
    expect(dealsForGoal(one, 12_000)).toBe(0);
    expect(conservative([{ one, deals: 0 }], { ...target, metric: 'SETTLED_CASH' }).settled).toBe(23_800);
  });

  it('after: read net, the agreements keep $9,800 of $12,000, so the plan needs more deals', () => {
    const one = lot();
    const cons = conservative([{ one, deals: 0 }], { ...target, metric: 'CONTRIBUTION' });
    expect(cons.settled).toBe(9800);
    expect(cons.settled!).toBeLessThan(12_000);
    // $2,200 still needed at $700 kept a deal is 4 deals, offered at the cautious 30% close.
    const offers = dealsForGoal(one, 12_000, true);
    expect(offers).toBeGreaterThan(0);
    const withMore = conservative([{ one, deals: offers }], { ...target, metric: 'CONTRIBUTION' });
    expect(withMore.settled!).toBeGreaterThanOrEqual(12_000);
  });

  it('counts a cost whether or not its money settles in time', () => {
    const one = lot({ daysToCash: fixed(200) });
    expect(conservative([{ one, deals: 0 }], { ...target, metric: 'CONTRIBUTION' }).settled).toBe(-14_000);
    expect(conservative([{ one, deals: 0 }], { ...target, metric: 'SETTLED_CASH' }).settled).toBe(0);
  });
});

describe('deals needed are the remaining target ÷ money kept a deal on a net target', () => {
  // A broker's rental: $2,400 ticket, $2,190 passed through or spent — about $210 kept.
  const rental = lot({ price: fixed(2400), directCost: fixed(2190), agreed: false, agreedValue: 0, agreedDeals: 0, close: { value: 0.5, low: 0.5, high: 0.5, provenance: 'HISTORICAL', source: null, note: '' }, volume: fixed(10_000) });

  it('asks 13 deals’ worth of buyers gross and 143 net for $30,000', () => {
    // gross: ceil(30000 / 2400) = 13 deals, offered to the fixed 4× = 52 buyers;
    // net: ceil(30000 / 210) = 143 deals, offered at the measured 50% close = 286 buyers.
    expect(buyersToOffer(rental, 30_000)).toBe(52);
    expect(buyersToOffer(rental, 30_000, true)).toBe(286);
  });

  it('bounds the best case net too: the top price less the lowest cost', () => {
    expect(bestCaseReach(rental, 30_000, 180)).toBe(30_000);
    const few = { ...rental, volume: fixed(20) };
    expect(bestCaseReach(few, 30_000, 180, true)).toBe(30_000);
    expect(bestCaseReach(few, 30_000, 180, true, true)).toBe(20 * 210);
  });
});

describe('the grader sees net versus gross', () => {
  const words = 'Collect $12,000 of net settled cash within 150 days with at most $25,000 of capital.';
  const c: PlanningCase = {
    id: 'syn-net-lot',
    heldOut: false,
    description: 'Synthetic: fourteen agreements cover the target gross but not net.',
    dimensions: { capital: 'large', target: 'medium', deadline: 'long', industry: 'Wholesale', mechanism: 'RESALE_OR_ASSET', autonomy: 'unlimited', missingEvidence: 'none', contradictoryEvidence: false, objectiveChanged: false },
    objective: words,
    openings: [{ key: 'lot', title: 'Wholesale lot', mechanism: 'RESALE_OR_ASSET', industry: 'Wholesale', price: 1700, cost: 1000, capital: 50, daysToCash: 40, performer: 'SUBCONTRACTOR', agreements: Array(14).fill(1700) }],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 25_000 },
  };
  const plan = (dealsCounted: number): ObservedPlan => ({
    stance: 'EXECUTABLE', status: 'CANDIDATE_ONLY', verdict: 'IMPROVEMENT_REQUIRED', infeasible: null, broken: [],
    members: [{ key: 'lot', unestablished: [], capitalLow: 50, cashStructure: false, deals: 0, dealsCounted }],
    missing: {}, named: [], collectAfterDeadline: false, scope: { industry: null, recurring: null, hoursPerWeek: null }, targetCents: 1_200_000, gate: null,
  });

  it('reads the objective’s words for net, profit or contribution', () => {
    expect(netObjective(words)).toBe(true);
    expect(netObjective('Earn $5,000 in profit by March')).toBe(true);
    expect(netObjective('Collect $12,000 of settled cash within 150 days')).toBe(false);
    expect(netObjective('Reach $8,000 through the network')).toBe(false);
  });

  it('fails a plan that passes on gross revenue under a net target as UNSOUND_ECONOMICS', () => {
    const g = grade(c, plan(14));
    expect(g.pass).toBe(false);
    expect(g.failures).toContain('UNSOUND_ECONOMICS');
    expect(g.detail).toMatch(/keep 9800 net of direct cost \(23800 gross\) against a net target of 12000/);
  });

  it('does not judge a plan whose reading carries no deal count for a member', () => {
    const blind = { ...plan(14), members: [{ key: 'lot', unestablished: [], capitalLow: 50, cashStructure: false, deals: null }] };
    expect(grade(c, blind).failures).not.toContain('UNSOUND_ECONOMICS');
  });

  it('passes the same plan once the deals it counts keep the target, and a gross target on the agreements alone', () => {
    expect(grade(c, plan(18)).pass).toBe(true);
    expect(grade({ ...c, objective: 'Collect $12,000 of settled cash within 150 days with at most $25,000 of capital.' }, plan(14)).pass).toBe(true);
  });
});

describe('a cost is not the order it was worked out on (2026-11-25)', () => {
  it('drops the base of a worked example, and keeps a cost stated beside an order', async () => {
    const { withoutExampleBases } = await import('../server/services/cash/goalScenario.ts');
    const { readMoneyFigures } = await import('../server/services/cash/figures.ts');
    const figures = (text: string) => readMoneyFigures(withoutExampleBases(text), 'USD').filter((one) => !one.perUnit).map((one) => one.cents / 100);
    expect(figures('Stripe costs 2.9% + $0.30 per card payment (about $7.55 on a $250 order).')).toEqual([7.55]);
    expect(figures('The platform keeps $12 of a $99 sale.')).toEqual([12]);
    expect(figures('The supplier charges $40 for each kit.')).toEqual([40]);
    expect(figures('Printing costs $250 for an order of 500 cards.')).toEqual([250]);
  });
});

describe('a marketplace listing is offered to the market research counted, not to an outreach batch (planner residuals, 2026-11-25)', () => {
  const listing = (channel: string, volume: ModelInput) =>
    lot({ opportunity: { id: 'opp_listing', title: 'Replenishable resale', reachableChannel: channel } as ModelledOpportunity['opportunity'], price: fixed(20), directCost: fixed(15), close: { value: null, low: null, high: null, provenance: 'UNKNOWN', source: null, note: '' }, volume, agreed: false, agreedValue: 0, agreedDeals: 0 });

  it('offers a $20 listing to the 1,600 buyers an $8,000 target needs on a counted platform', () => {
    // ceil(8000 / 20) = 400 deals, offered to the fixed 4× = 1,600 buyers: under 130 million counted.
    expect(buyersToOffer(listing('Amazon FBA and eBay listings', fixed(130_000_000)), 8000)).toBe(1600);
    expect(bestCaseReach(listing('Amazon FBA and eBay listings', fixed(130_000_000)), 8000, 60)).toBe(8000);
  });

  it('keeps the outreach batch for an emailed offer, and for a listing whose market nobody counted', () => {
    expect(buyersToOffer(listing('Cold email through Instantly', fixed(130_000_000)), 8000)).toBe(200);
    expect(buyersToOffer(listing('Amazon FBA and eBay listings', { value: null, low: 1, high: 200, provenance: 'UNKNOWN', source: null, note: '' }), 8000)).toBe(200);
  });
});
