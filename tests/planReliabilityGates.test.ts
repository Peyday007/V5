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
 *   6. Under a capital ceiling, lots are recycled: as many run at once as the
 *      ceiling holds, and only those that settle in time count (round 7).
 *   7. An agreed lot whose own evidence is incomplete, that the plan does not
 *      need, is left out of the strategy and of the candidate (round 7).
 */
import { describe, expect, it } from 'vitest';
import { agreedLots, candidateSentence, conservative, dealsFromOffers, economicsState, everyCaseInfeasible, judgeAcceptance, lotsUnderCeiling, peakConcurrentLots, withoutSpareOwnerWork, withoutUnestablishedLots, type StrategyReading } from '../server/services/goals/plan.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { internalKeyIn } from '../server/domain/planIntegrity.ts';
import { buyerTermsOf } from '../server/services/cash/construct.ts';

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

  /*
   * planMetamorphic P6 (Postgres suite, 2026-11-22): the reading keeps four
   * alternatives, and a looser capital limit fills them with combinations that
   * still count the unpriced member, so no priced one survived the cut and the
   * candidate fell to the strategy's sweep share (0.06 → 0.50 for $10,000 →
   * $1,000). The engine's own search over priced members decides.
   */
  it('holds the engine’s priced combination even when no priced one is among the kept alternatives', () => {
    const p = portfolio(['price']);
    p.alternatives = [
      { members: [{ opportunityId: 'arr_constructed', title: 'A constructed arrangement', share: 1 }], reach: 0.9, settledP10: 0, settledP50: 7000, settledP90: 9000, capitalShort: 0, overSpend: 0 },
    ] as GoalPortfolio['alternatives'];
    p.pricedBest = { members: [{ opportunityId: 'cleaning', title: 'Post-construction cleanup', share: 1 }], reach: 0.06, settledP10: 0, settledP50: 3000, settledP90: 6000, capitalShort: 0, overSpend: 0 };
    const a = judgeAcceptance({ achieved: false, chosen: strategy, portfolio: p, measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
    expect(a.candidate?.opportunityIds).toEqual(['cleaning']);
    expect(a.candidate?.reach).toBe(0.06);
    // No priced combination runs at all: the strategy judged on its chain, as before.
    p.pricedBest = null;
    expect(judgeAcceptance({ achieved: false, chosen: strategy, portfolio: p, measuredChance: null, considered }).candidate?.source).toBe('STRATEGY');
  });

  it('keeps the combination as the candidate when every member’s price is established', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy, portfolio: portfolio(['close rate']), measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
    expect(a.candidate?.opportunityIds).toEqual(['cleaning', 'arr_constructed']);
  });
});

/*
 * NO_INTERNAL_KEYS (production goal wst_7b4fcbb5f2384f31b6c3, release check
 * 44986740566). With no priced combination and every strategy NOT_VIABLE, the
 * candidate is the pathways' leading combination, whose members are ids: its
 * label and sentence read "arr_6f3b7a404ca5 + …". And an arrangement inheriting
 * its buyers' arrears from an awarded opening carried "opening cop_…" into
 * three of its steps. A person reads titles.
 */
describe('a candidate and an arrangement\'s terms name openings by title, never by id', () => {
  const viable = (id: string, title: string) => ({ opportunityId: id, title });
  it('labels a pathways candidate by its members\' titles', () => {
    const a = judgeAcceptance({
      achieved: false,
      chosen: null,
      portfolio: null,
      measuredChance: null,
      considered: [],
      pathways: {
        portfolio: { leading: { members: ['arr_6f3b7a404ca5', 'cop_0a51c2259f2f4a04b5fe', 'arr_unknown00000'], net: { p10: 0, p50: 10_000, p90: 20_000 } } },
        pathways: [viable('arr_6f3b7a404ca5', 'Constructed: GitHub bug bounty triage'), viable('cop_0a51c2259f2f4a04b5fe', 'Market: GitHub public bug bounty program')],
      } as never,
    });
    expect(a.candidate?.source).toBe('PATHWAYS');
    expect(a.candidate?.opportunityIds).toEqual(['arr_6f3b7a404ca5', 'cop_0a51c2259f2f4a04b5fe', 'arr_unknown00000']);
    expect(a.candidate?.label).toBe('Constructed: GitHub bug bounty triage + Market: GitHub public bug bounty program + a constructed arrangement');
    expect(candidateSentence(a.candidate, 0.9)).toContain('Constructed: GitHub bug bounty triage');
    for (const text of [a.candidate!.label, a.sentence, candidateSentence(a.candidate, 0.9)]) expect(internalKeyIn(text), text).toBeNull();
  });

  it('reads an awarded opening\'s arrears into an arrangement\'s terms by its title', () => {
    const awarded = { id: 'cop_0a51c2259f2f4a04b5fe', title: 'GitHub public bug bounty program solicitation', source: null, buyingSignal: null, paymentTerms: null } as never;
    const { buyerTerms } = buyerTermsOf({} as never, [awarded]);
    expect(buyerTerms?.timing).toBe('ARREARS');
    expect(buyerTerms!.basis).toContain('GitHub public bug bounty program solicitation');
    expect(internalKeyIn(buyerTerms!.basis), buyerTerms!.basis).toBeNull();
  });
});

describe('6. under a capital ceiling, lots are recycled', () => {
  it('runs as many lots at once as the ceiling holds, and counts only those that settle in time', () => {
    // Three $2,000 lots paid in 12 days, $2,500 ceiling, 30 days: one at a time, two settle in the window.
    expect(lotsUnderCeiling(3, 12, 30, 2000, 2500)).toEqual({ atOnce: 1, inWindow: 2 });
    // Everything fits as the timing allows: the ceiling changes nothing.
    expect(lotsUnderCeiling(2, 12, 30, 2000, 2500)).toEqual({ atOnce: 1, inWindow: 2 });
    expect(lotsUnderCeiling(3, 12, 30, 2000, null)).toEqual({ atOnce: 2, inWindow: 3 });
    // No lot fits under the ceiling, or the timing is unknown: every lot counts, and the limit breaks where it is checked.
    expect(lotsUnderCeiling(3, 12, 30, 3000, 2500)).toEqual({ atOnce: 2, inWindow: 3 });
    expect(lotsUnderCeiling(3, null, 30, 2000, 2500)).toEqual({ atOnce: 3, inWindow: 3 });
  });

  it('reads agreed lots that cannot all run inside the ceiling at the money the ones that settle bring', () => {
    const one = opening('lots', { price: fixed(1000), directCost: fixed(600), capital: fixed(600), daysToCash: fixed(10), agreedValue: 4000, agreedDeals: 4 });
    // $1,000 ceiling, 20 days: one lot at a time, two settle in the window.
    const read = conservative([{ one, deals: 0 }], { daysLeft: 20, capitalCeilingCents: 100_000 });
    expect(read.exposure).toBe(600);
    expect(read.settled).toBe(2000);
    // Without the ceiling every lot is read as settling, two at a time.
    expect(conservative([{ one, deals: 0 }], { daysLeft: 20 })).toMatchObject({ exposure: 1200, settled: 4000 });
  });
});

describe('7. an unneeded agreed lot with incomplete evidence is left out', () => {
  const clean = opening('clean', { price: fixed(1500), agreedValue: 6000, agreedDeals: 4, directCost: fixed(900) });
  const uncosted = opening('uncosted', { price: fixed(2000), agreedValue: 4000, agreedDeals: 2, directCost: unknown(0, 2000) });
  const target = { daysLeft: 30, remainingCents: 500_000 };

  it('drops it when the rest reach the target at their cautious numbers', () => {
    const kept = withoutUnestablishedLots([{ one: clean, deals: 0 }, { one: uncosted, deals: 0 }], target, () => false);
    expect(kept.map(({ one }) => one.opportunity.id)).toEqual(['clean']);
    // A failing link the caller reads is reason enough, though every number is known.
    const flagged = withoutUnestablishedLots([{ one: clean, deals: 0 }, { one: opening('noFulfiller', { agreedValue: 2000 }), deals: 0 }], target, ({ one }) => one.opportunity.id === 'noFulfiller');
    expect(flagged.map(({ one }) => one.opportunity.id)).toEqual(['clean']);
  });

  it('keeps every member when the rest do not reach the target, so the gap stays named', () => {
    const kept = withoutUnestablishedLots([{ one: clean, deals: 0 }, { one: uncosted, deals: 0 }], { daysLeft: 30, remainingCents: 800_000 }, () => false);
    expect(kept).toHaveLength(2);
  });

  it('holds the qualified strategy, not a combination that counts the lot it was judged without', () => {
    const chosen: StrategyReading = {
      key: 'combine_fast', label: 'Clean agreements', verdict: 'RECOMMENDABLE', opportunityIds: ['clean'], links: [], constraintsFailed: [],
      sweep: { goalMetShare: 0, settledP50: 6000, settledP90: 6000, infeasibleShare: 0, probabilistic: false }, conservativeSettled: 6000, chainComplete: true, nextTest: null,
    };
    const portfolio = {
      basis: 'COVERAGE', worlds: 400,
      best: { members: [{ opportunityId: 'clean', title: 'Clean', share: 1 }, { opportunityId: 'uncosted', title: 'Uncosted', share: 1 }], reach: 0, settledP10: 0, settledP50: 10_000, settledP90: 10_000, capitalShort: 0, overSpend: 0 },
      alternatives: [], demand: [{ opportunityId: 'clean', title: 'Clean', unestablished: [] }, { opportunityId: 'uncosted', title: 'Uncosted', unestablished: ['direct cost'] }],
      limits: { target: 5000, deadlineDays: 30, startingCapital: 0, perArrangement: null, spendCeiling: null, contactsPerDay: { value: null, low: 10, high: 60, source: 'swept' }, correlation: 0.5 },
      missing: [], searched: 2,
    } as unknown as GoalPortfolio;
    const considered = [{ opportunityId: 'clean', missing: [] }, { opportunityId: 'uncosted', missing: ['ECONOMICS' as const] }];
    const a = judgeAcceptance({ achieved: false, chosen, portfolio, measuredChance: null, considered });
    expect(a.candidate?.source).toBe('STRATEGY');
    expect(a.candidate?.opportunityIds).toEqual(['clean']);
    // Without a qualified strategy the combination is still the candidate, its gap named.
    expect(judgeAcceptance({ achieved: false, chosen: { ...chosen, chainComplete: false, verdict: 'NEEDS_EVIDENCE' }, portfolio, measuredChance: null, considered }).candidate?.source).toBe('QUANT_PORTFOLIO');
  });
});
