/**
 * Four root causes the planningReliability benchmark found in round 5, each
 * pinned as a general rule on synthetic openings:
 *
 *  1. Orders per member offered ("14 orders from 520 members") are a measured
 *     close, like agreements per contact: each member is an identified buyer on
 *     a list the offer went to. A membership already saturated is still bounded
 *     by the prospects that exist.
 *  2. The noun an opening's industry ends on counts its buyers: "210 member
 *     courses" for golf courses, "900 member washes" for car washes.
 *  3. An opening on which every deal loses money never enters a combination,
 *     signed or not, and an agreed loss-making lot the plan does not need is
 *     left out of a strategy.
 *  4. Agreed work is committed owner hours: agreed work that alone exceeds the
 *     goal's hours enters no combination, and when every member of a strategy is
 *     agreed work, the members that cost the most hours per unit of money are
 *     left out while the rest still reach the target.
 */
import { describe, expect, it } from 'vitest';
import { readOfferWins, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { industryBuyerWords, readVolume } from '../server/services/cash/volume.ts';
import { evaluateGoalPortfolio, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { prospectsAsked, withoutLossMakingLots, withoutSpareOwnerWork } from '../server/services/goals/plan.ts';

const known = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: 'test' });

describe('rule 1: orders per member offered are a measured close', () => {
  it('reads orders against members, and still not the size of a group', () => {
    expect(readOfferWins('14 orders from 520 members')).toEqual({ won: 14, offers: 520, unit: 'members' });
    expect(readOfferWins('46 orders from 380 association members')).toEqual({ won: 46, offers: 380, unit: 'members' });
    for (const other of ['18 orders from a 14,000-member group', '4 paid pre-orders from 1600 unique visitors', '520 members', '600 orders from 520 members']) {
      expect(readOfferWins(other), other).toBeNull();
    }
  });

  it('bounds a saturated membership by the members that exist', () => {
    // 22 of 1,900 members ordered: 36 more orders would need far more members than the 1,900 there are.
    const one = { close: measuredRateInput({ trials: 1900, low: 22, high: 22 }), prospects: 1900 } as Pick<ModelledOpportunity, 'close' | 'prospects'>;
    expect(prospectsAsked(one, 36)!).toBeGreaterThan(1900);
    // 14 of 520 members ordered: five orders from 900 members fit.
    const fits = { close: measuredRateInput({ trials: 520, low: 14, high: 14 }), prospects: 900 } as Pick<ModelledOpportunity, 'close' | 'prospects'>;
    expect(prospectsAsked(fits, 5)!).toBeLessThanOrEqual(900);
  });
});

describe('rule 2: the industry names the buyer a count counts', () => {
  it('takes the industry’s last plural noun, never a word for what is sold', () => {
    expect(industryBuyerWords('golf courses')).toEqual(['course', 'courses']);
    expect(industryBuyerWords('car washes')).toEqual(['wash', 'washes']);
    expect(industryBuyerWords('houses of worship (AV)')).toEqual([]);
    expect(industryBuyerWords('auto parts')).toEqual([]);
    expect(industryBuyerWords('event rentals')).toEqual([]);
    expect(industryBuyerWords('fitness')).toEqual([]);
    expect(industryBuyerWords(null)).toEqual([]);
  });

  it('counts the industry’s own noun as buyers only for that industry', () => {
    const text = '210 member courses are listed in the state golf association directory; each hosts three or more tournaments a season.';
    expect(readVolume(text, 40, 'Golf course tournament directors')).toBeNull();
    expect(readVolume(text, 40, 'Golf course tournament directors', 'golf courses')).toMatchObject({ buyers: 210, counted: 'BUYERS' });
    expect(readVolume('The association has 900 member washes; each reorders monthly.', 30, 'Car wash owners', 'car washes')).toMatchObject({ buyers: 900, deals: 900, counted: 'BUYERS' });
  });
});

function opening(id: string, over: Partial<ModelledOpportunity> = {}, index = 1): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index, tier: 'QUALIFIED', repeatable: false,
    price: known(900), capital: known(0), hours: known(1), daysToCash: known(14), close: known(0, 'UNKNOWN'), respond: known(0, 'UNKNOWN'),
    directCost: known(100), volume: known(1), prospects: null, agreed: true, agreedValue: 5400, agreedDeals: 6, fulfilledBy: null, competitiveAward: false,
    ...over,
  } as ModelledOpportunity;
}
const limits = { remaining: 5000, daysLeft: 40, capitalCeiling: null, beforeProof: null, perWeek: null, resources: null, worlds: 300, seed: 7 };

describe('rule 3: a deal that loses money is no way to the target', () => {
  it('refuses a signed lot whose cost is at least its price from every combination', () => {
    const losing = opening('losing', { directCost: known(950) });
    const result = evaluateGoalPortfolio({ ...limits, openings: [losing] });
    expect(result.demand.find((d) => d.opportunityId === 'losing')?.refused).toMatch(/loses money/);
    expect(result.best?.members.some((m) => m.opportunityId === 'losing') ?? false).toBe(false);
    // The same lot at a margin is a member.
    const earning = evaluateGoalPortfolio({ ...limits, openings: [opening('earning', { directCost: known(500) })] });
    expect(earning.demand[0]!.refused).toBeNull();
  });

  it('leaves an agreed loss-making lot out of a strategy only when the rest reaches the target', () => {
    const lot = { one: opening('lot', { directCost: known(950) }), deals: 0 };
    const reaching = { one: opening('rental', { price: known(1800), directCost: known(1100), agreedValue: 0, agreedDeals: 0, agreed: false, repeatable: true, volume: known(210), close: measuredRateInput({ trials: 45, low: 6, high: 6 }), respond: known(1, 'HISTORICAL') }), deals: 100 };
    const target = { daysLeft: 40, remainingCents: 500_000 };
    expect(withoutLossMakingLots([lot, reaching], target).map((m) => m.one.opportunity.id)).toEqual(['rental']);
    const short = { ...reaching, deals: 2 };
    expect(withoutLossMakingLots([lot, short], target)).toHaveLength(2);
  });
});

describe('rule 4: agreed work is committed owner hours', () => {
  const reports = { one: opening('reports', { price: known(200), directCost: known(5), hours: known(0.5), agreedValue: 1800, agreedDeals: 9 }), deals: 0 };
  const events = { one: opening('events', { price: known(600), directCost: known(50), hours: known(8), agreedValue: 1800, agreedDeals: 3 }), deals: 0 };

  it('keeps the agreements that fit the hours when every member is agreed work', () => {
    const target = { daysLeft: 30, remainingCents: 150_000, hoursCeiling: 9 };
    expect(withoutSpareOwnerWork([reports, events], target).map((m) => m.one.opportunity.id)).toEqual(['reports']);
    // Nothing is left out when the hours already fit, or when what would stay falls short.
    expect(withoutSpareOwnerWork([reports, events], { ...target, hoursCeiling: 40 })).toHaveLength(2);
    expect(withoutSpareOwnerWork([reports, events], { ...target, remainingCents: 300_000 })).toHaveLength(2);
  });

  it('refuses agreed work that alone exceeds the goal’s hours from every combination', () => {
    const result = evaluateGoalPortfolio({ ...limits, remaining: 1500, daysLeft: 30, hours: 9, openings: [reports.one, { ...events.one, index: 2 }] });
    expect(result.demand.find((d) => d.opportunityId === 'events')?.refused).toMatch(/agreed deal/);
    expect(result.demand.find((d) => d.opportunityId === 'reports')?.refused).toBeNull();
  });
});
