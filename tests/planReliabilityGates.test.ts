/**
 * The plan gate's arithmetic, read against the deals a strategy actually takes
 * (planningReliability, bench/planningReliability/BASELINE.md, 2026-11-21).
 * Each rule is general; the case it was found on is named beside it.
 *
 *   1. Agreed deals are established volume: agreements that cover the target
 *      give a conservative figure even when the market's volume for new deals
 *      is unestablished (fam-12, ho-09, ho-16).
 *   2. Money tied up is the peak held at once, lots run one after another as
 *      their cash settles — never their sum (fam-16).
 *   3. Agreed deals the owner performs are owner hours (ho-07).
 *   4. A stated cost at or over the price is unsound economics (ho-10).
 *   5. A combination counting a member whose price nobody established is not
 *      the plan's candidate (fam-08, fam-14, ho-02).
 */
import { describe, expect, it } from 'vitest';
import { agreedLots, conservative, dealsFromOffers, economicsState, everyCaseInfeasible, judgeAcceptance, peakConcurrentLots, withoutSpareOwnerWork, type StrategyReading } from '../server/services/goals/plan.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const fixed = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: '' });
const unknown = (low: number, high: number, provenance: ModelInput['provenance'] = 'UNKNOWN'): ModelInput => ({ value: null, low, high, provenance, source: null, note: '' });

function opening(id: string, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(2500),
    capital: fixed(0),
    hours: fixed(0),
    daysToCash: fixed(7),
    // Nobody has measured how many new buyers agree.
    close: unknown(0, 1),
    respond: fixed(1),
    directCost: fixed(50),
    volume: fixed(1, 'ASSUMPTION'),
    agreed: true,
    agreedValue: 2500,
    agreedDeals: 1,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

describe('1. agreed deals are established volume', () => {
  it('a one-off whose buyer signed reads its agreement, though no new deal’s volume or close is established (fam-12)', () => {
    const one = opening('creditUnion', { volume: unknown(0, 1, 'ASSUMPTION') });
    expect(conservative([{ one, deals: 0 }], { daysLeft: 14 }).settled).toBe(2500);
    expect(conservative([{ one, deals: 1 }], { daysLeft: 14 }).settled).toBe(2500);
  });

  it('a repeatable play with agreements and no new deals reads them, its unestablished volume notwithstanding (ho-09, ho-16)', () => {
    const one = opening('grooming', { repeatable: true, price: fixed(250), volume: unknown(1, 50), agreedValue: 1250, agreedDeals: 5, daysToCash: fixed(3) });
    expect(conservative([{ one, deals: 0 }], { daysLeft: 7 }).settled).toBe(1250);
  });

  it('still refuses a figure when new deals are taken and the market’s volume is not established', () => {
    const one = opening('roofing', { repeatable: true, agreed: false, agreedValue: 0, agreedDeals: 0, close: fixed(0.08, 'HISTORICAL'), volume: unknown(1, 50) });
    expect(conservative([{ one, deals: 20 }], { daysLeft: 30 }).settled).toBeNull();
  });
});

describe('2. money tied up is the peak held at once', () => {
  it('runs lots one after another as their cash settles', () => {
    expect(peakConcurrentLots(2, 21, 60)).toBe(1);
    expect(peakConcurrentLots(4, 21, 60)).toBe(2);
    expect(peakConcurrentLots(2, 21, 20)).toBe(2);
    expect(peakConcurrentLots(2, null, 60)).toBe(2);
    expect(peakConcurrentLots(0, 21, 60)).toBe(0);
    // A cautious fractional count is never rounded up past itself.
    expect(peakConcurrentLots(0.4, 21, 10)).toBe(0.4);
  });

  it('two signed $8,000 lots paid in 21 days hold $8,000 at once over 60 days, inside a $10,000 limit (fam-16)', () => {
    const one = opening('restaurant', { price: fixed(14_000), directCost: fixed(8000), capital: fixed(8000), daysToCash: fixed(21), hours: fixed(0), agreedValue: 28_000, agreedDeals: 2 });
    const cons = conservative([{ one, deals: 0 }], { daysLeft: 60 });
    expect(cons.exposure).toBe(8000);
    expect(cons.settled).toBe(28_000);
    // The engine sums both lots in every world; the peak held at once fits, so no limit is broken.
    const target = { hoursCeiling: null, capitalCeilingCents: 1_000_000, currency: 'USD' };
    expect(everyCaseInfeasible({ capital: 400 }, 400, [{ one, deals: 0 }], target, { exposure: cons.exposure })).toEqual([]);
    // When the peak itself breaks the limit, it is still named.
    expect(everyCaseInfeasible({ capital: 400 }, 400, [{ one, deals: 0 }], { ...target, capitalCeilingCents: 500_000 }, { exposure: cons.exposure })).toEqual([
      'ties up more than the 5000 USD the owner said this goal may commit in every tested case',
    ]);
  });
});

describe('2b. agreements smaller than a lot share it', () => {
  it('three buyers taking $3,000 each of one $10,000 container tie up one container, not three', () => {
    const one = opening('container', { price: fixed(10_000), directCost: fixed(6000), capital: fixed(6000), daysToCash: fixed(10), agreedValue: 9000, agreedDeals: 3 });
    expect(agreedLots(one)).toBe(1);
    // Fewer days than one lot needs, so no lot runs after another: the count is the lots themselves.
    const cons = conservative([{ one, deals: 0 }], { daysLeft: 5 });
    expect(cons.exposure).toBe(6000);
    // Agreements each worth a whole lot are a lot each; with no price, one lot an agreement.
    expect(agreedLots(opening('whole', { price: fixed(2000), agreedValue: 6000, agreedDeals: 3 }))).toBe(3);
    expect(agreedLots(opening('unpriced', { price: unknown(100, 5000), agreedValue: 6000, agreedDeals: 3 }))).toBe(3);
  });
});

describe('2c. the deals a play needs follow its measured close, as its offers do', () => {
  it('reads 200 buyers offered at a measured 10% as 20 deals needed, not 50', () => {
    expect(dealsFromOffers(opening('measured', { close: fixed(0.1, 'HISTORICAL') }), 200)).toBe(20);
    // At or over 1 in 4, the fixed multiple governed the offers.
    expect(dealsFromOffers(opening('high', { close: fixed(0.5, 'HISTORICAL') }), 200)).toBe(50);
    // No measured close: the fixed multiple, as before.
    expect(dealsFromOffers(opening('unmeasured'), 200)).toBe(50);
    expect(dealsFromOffers(opening('none'), 0)).toBe(0);
  });
});

describe('3. agreed deals the owner performs are owner hours', () => {
  it('ten signed translations at 6 owner hours each are 60 hours (ho-07)', () => {
    const one = opening('translation', { price: fixed(400), directCost: fixed(0), hours: fixed(6), agreedValue: 4000, agreedDeals: 10 });
    expect(conservative([{ one, deals: 0 }], { daysLeft: 30 }).labour).toBe(60);
  });

  it('leaves out agreed owner work a strategy does not need, and keeps it when it does (fam-09, ho-07)', () => {
    const target = { daysLeft: 30, hoursCeiling: 21, remainingCents: 400_000 };
    const consulting = { one: opening('consulting', { price: fixed(1000), directCost: fixed(0), hours: fixed(10), agreedValue: 4000, agreedDeals: 4 }), deals: 0 };
    const spreadsheet = {
      one: opening('spreadsheet', { repeatable: true, price: fixed(600), directCost: fixed(10), volume: fixed(400), close: fixed(0.1, 'HISTORICAL'), agreed: false, agreedValue: 0, agreedDeals: 0 }),
      deals: 100,
    };
    expect(withoutSpareOwnerWork([spreadsheet, consulting], target).map((m) => m.one.opportunity.id)).toEqual(['spreadsheet']);
    const translation = { one: opening('translation', { price: fixed(400), directCost: fixed(0), hours: fixed(6), agreedValue: 4000, agreedDeals: 10 }), deals: 0 };
    expect(withoutSpareOwnerWork([translation], { ...target, hoursCeiling: 13 })).toEqual([translation]);
    // Inside the owner's hours, nothing is left out.
    expect(withoutSpareOwnerWork([spreadsheet, consulting], { ...target, hoursCeiling: 40 })).toHaveLength(2);
  });
});

describe('4. a negative unit margin is unsound economics', () => {
  it('fails ECONOMICS on a $2,300 cost against a $2,000 price, though the cost is evidenced (ho-10)', () => {
    const loses = opening('localisation', { price: fixed(2000), directCost: fixed(2300) });
    const state = economicsState(loses, { capitalBeforeProofCents: null });
    expect(state.ok).toBe(false);
    expect(state.basis).toMatch(/loses money/);
    expect(economicsState(opening('sound', { price: fixed(2000), directCost: fixed(1500) }), { capitalBeforeProofCents: null }).ok).toBe(true);
  });
});

describe('5. an unestablished price never makes a candidate', () => {
  const strategy: StrategyReading = {
    key: 'only_o1',
    label: 'Post-construction cleanup',
    verdict: 'RECOMMENDABLE',
    opportunityIds: ['cleaning'],
    links: [],
    constraintsFailed: [],
    sweep: { goalMetShare: 1, settledP50: 6000, settledP90: 6000, infeasibleShare: 0, probabilistic: false },
    conservativeSettled: 6000,
    chainComplete: true,
    nextTest: null,
  };
  const portfolio = (unestablished: string[]): GoalPortfolio =>
    ({
      basis: 'COVERAGE',
      worlds: 400,
      best: {
        members: [
          { opportunityId: 'cleaning', title: 'Post-construction cleanup', share: 1 },
          { opportunityId: 'arr_constructed', title: 'A constructed arrangement', share: 1 },
        ],
        reach: 1,
        settledP10: 6000,
        settledP50: 9000,
        settledP90: 12_000,
        capitalShort: 0,
        overSpend: 0,
      },
      alternatives: [],
      demand: [
        { opportunityId: 'cleaning', title: 'Post-construction cleanup', unestablished: ['reply rate', 'close rate'] },
        { opportunityId: 'arr_constructed', title: 'A constructed arrangement', unestablished },
      ],
      limits: { target: 5000, deadlineDays: 45, startingCapital: 0, perArrangement: null, spendCeiling: null, contactsPerDay: { value: null, low: 10, high: 60, source: 'swept' }, correlation: 0.5 },
      missing: [],
      searched: 2,
    }) as unknown as GoalPortfolio;
  const considered = [
    { opportunityId: 'cleaning', missing: [] },
    { opportunityId: 'arr_constructed', missing: [] },
  ];

  it('falls to the strategy judged on its chain when a member’s price is not established (fam-08, fam-14, ho-02)', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy, portfolio: portfolio(['price', 'close rate']), measuredChance: null, considered });
    expect(a.status).not.toBe('ACCEPTED');
    expect(a.candidate?.source).toBe('STRATEGY');
    expect(a.candidate?.opportunityIds).toEqual(['cleaning']);
    expect(a.shortfalls.join(' ')).toMatch(/arr_constructed, whose price nobody has established/);
  });

  it('holds the best priced alternative on the portfolio’s own measure, before falling to the strategy', () => {
    const p = portfolio(['price']);
    p.alternatives = [
      { members: [{ opportunityId: 'arr_constructed', title: 'A constructed arrangement', share: 1 }], reach: 0.9, settledP10: 0, settledP50: 7000, settledP90: 9000, capitalShort: 0, overSpend: 0 },
      { members: [{ opportunityId: 'cleaning', title: 'Post-construction cleanup', share: 1 }], reach: 0.6, settledP10: 3000, settledP50: 6000, settledP90: 6000, capitalShort: 0, overSpend: 0 },
    ] as GoalPortfolio['alternatives'];
    const a = judgeAcceptance({ achieved: false, chosen: strategy, portfolio: p, measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
    expect(a.candidate?.opportunityIds).toEqual(['cleaning']);
    expect(a.candidate?.reach).toBe(0.6);
  });

  it('keeps the combination as the candidate when every member’s price is established', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy, portfolio: portfolio(['close rate']), measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
    expect(a.candidate?.opportunityIds).toEqual(['cleaning', 'arr_constructed']);
  });
});
