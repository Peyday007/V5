/**
 * planningReliability round 12.
 *
 * - A payer named as a kind of buyer ("Grain farm owners", "Orchard growers")
 *   is its own fulfiller only where the fulfiller names that kind. A supplier
 *   whose name carries the buyers' trade ("Valley Grain Supply") is a supplier,
 *   and reading it as the buyer left its delivery with nobody to perform it.
 * - A win rate measured per bid applies to the work posted for bidders: "N
 *   contracts are posted on the bid board for award" is N trials of it.
 * - A payer named for what it buys ("Used-tractor buyers") is one buyer per
 *   thing bought, so a count of those things sizes the market.
 * - A constructed arrangement added beside a qualified strategy is not held
 *   over that strategy: its chain is estimates, so the plan would reach buyers
 *   nobody found and deliver work nobody specified.
 * - A deal whose card says it ties up less than its direct cost (a deposit,
 *   the rest settled from the buyer's payment) is not refused for a cost over
 *   the goal's ceiling: the goal spends what the deal ties up.
 */
import { describe, expect, it } from 'vitest';
import { namesThePayer } from '../server/services/goals/pathways.ts';
import { readTrialVolume, readVolume } from '../server/services/cash/volume.ts';
import { judgeAcceptance, type StrategyReading } from '../server/services/goals/plan.ts';
import { evaluateGoalPortfolio, type GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

describe('namesThePayer: the buyer, not the trade it is in', () => {
  it('reads a supplier named for the buyers\' trade as a supplier', () => {
    expect(namesThePayer('Valley Grain Supply (quoted, ships on prepayment)', 'Grain farm owners')).toBe(false);
    expect(namesThePayer('PressFruit Mobile (quoted)', 'Fruit growers')).toBe(false);
    expect(namesThePayer('Lakeside Kitchen Coffee (wholesale roaster)', 'Kitchen managers of mid-size restaurants')).toBe(false);
    expect(namesThePayer('ReWheel Scooter Refurbishers (quoted)', 'Scooter-share fleet managers')).toBe(false);
  });
  it('still reads the buyer kind named as fulfiller as the buyer', () => {
    expect(namesThePayer('Dental practices', 'Dental practices')).toBe(true);
    expect(namesThePayer('the growers themselves', 'Fruit growers')).toBe(true);
  });
  it('keeps the first-word reading for a payer that is one named party', () => {
    expect(namesThePayer('Puzzle Weekly (newsletter) states contributors are paid', 'Puzzle Weekly, editor jdoe')).toBe(true);
    expect(namesThePayer('Northline Couriers (quoted)', 'Puzzle Weekly, editor jdoe')).toBe(false);
  });
});

describe('readTrialVolume: work posted for bidders is a trial of a per-bid rate', () => {
  it('counts contracts posted on a bid board for award', () => {
    const v = readTrialVolume('38 county road-salting contracts are posted on the state bid board for award this season.', 60, 'BIDS');
    expect(v?.deals).toBe(38);
    expect(v?.counted).toBe('BUYERS');
  });
  it('reads a period after the count as a rate over the window', () => {
    expect(readTrialVolume('20 janitorial contracts are put out to bid each month.', 45, 'BIDS')?.deals).toBe(30);
  });
  it('never counts work already won or a count with no bidding in its sentence', () => {
    expect(readTrialVolume('We won 6 contracts last season.', 60, 'BIDS')).toBeNull();
    expect(readTrialVolume('The county maintains 38 road contracts.', 60, 'BIDS')).toBeNull();
    expect(readTrialVolume('38 county contracts are posted for award.', 60, 'CONTACTS')).toBeNull();
  });
});

describe('readVolume: a buyer named for what it buys', () => {
  it('counts the things bought as buyers', () => {
    const v = readVolume('640 used tractors are under signed purchase agreements this month; each sale requires one inspection.', 30, 'Used-tractor buyers', 'farm equipment');
    expect(v?.buyers).toBe(640);
  });
  it('still reads nothing where no count of them is stated', () => {
    expect(readVolume('Many used tractors change hands each spring.', 30, 'Used-tractor buyers', 'farm equipment')).toBeNull();
  });
});

describe('judgeAcceptance: a constructed arrangement beside a qualified strategy', () => {
  const portfolio = (ids: string[]): GoalPortfolio => ({
    basis: 'COVERAGE',
    worlds: 2_000,
    best: { members: ids.map((id) => ({ opportunityId: id, title: id, share: 1 })), reach: 0.99, settledP10: 5_000, settledP50: 7_000, settledP90: 9_000, capitalShort: 0, overSpend: 0 },
    alternatives: [],
    demand: [],
    limits: { target: 5_000, deadlineDays: 30, startingCapital: 0, perArrangement: 0, spendCeiling: 0, contactsPerDay: { value: null, low: 10, high: 60, source: 'swept' }, correlation: 0.5 },
    missing: [],
    searched: 1,
  });
  const qualified: StrategyReading = {
    key: 'only_o1',
    label: 'Only: signed filings',
    verdict: 'NEEDS_EVIDENCE',
    opportunityIds: ['cop_filings'],
    links: [],
    constraintsFailed: [],
    sweep: { goalMetShare: 1, settledP50: 6_000, settledP90: 6_000, infeasibleShare: 0, probabilistic: false },
    conservativeSettled: 6_000,
    chainComplete: true,
    nextTest: null,
  };
  const considered = [{ opportunityId: 'cop_filings', missing: [] as never[] }];

  it('holds the qualified strategy, not the combination that adds the arrangement', () => {
    const a = judgeAcceptance({ achieved: false, chosen: qualified, portfolio: portfolio(['cop_filings', 'arr_abc123']), measuredChance: null, considered });
    expect(a.candidate?.source).toBe('STRATEGY');
    expect(a.candidate?.opportunityIds).toEqual(['cop_filings']);
  });
  it('keeps an arrangement the qualified strategy itself counts', () => {
    const a = judgeAcceptance({ achieved: false, chosen: { ...qualified, arrangementIds: ['arr_abc123'] }, portfolio: portfolio(['cop_filings', 'arr_abc123']), measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
  });
  it('keeps the combination when no strategy is qualified', () => {
    const a = judgeAcceptance({ achieved: false, chosen: { ...qualified, chainComplete: false }, portfolio: portfolio(['cop_filings', 'arr_abc123']), measuredChance: null, considered });
    expect(a.candidate?.source).toBe('QUANT_PORTFOLIO');
  });
});

describe('evaluateGoalPortfolio: a deposit is what a deal spends, not its whole cost', () => {
  const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
  const opening = (id: string, capital: number): ModelledOpportunity => ({
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(2_400),
    capital: fixed(capital),
    hours: fixed(0),
    daysToCash: fixed(6),
    close: fixed(0.9),
    respond: fixed(1),
    directCost: fixed(1_500),
    volume: fixed(1),
    agreed: true,
    agreedValue: 7_200,
    agreedDeals: 3,
    fulfilledBy: null,
    competitiveAward: false,
  });
  const limits = { remaining: 6_000, daysLeft: 40, capitalCeiling: 1_200, beforeProof: null, perWeek: null, resources: null, worlds: 400, seed: 3 };

  it('keeps a deal that ties up a deposit inside the ceiling', () => {
    const d = evaluateGoalPortfolio({ ...limits, openings: [opening('deposit', 700)] }).demand[0]!;
    expect(d.refused ?? null).toBeNull();
  });
  it('still refuses a deal whose own figure ties up the whole cost', () => {
    const d = evaluateGoalPortfolio({ ...limits, openings: [opening('whole', 1_500)] }).demand[0]!;
    expect(d.refused ?? '').not.toBe('');
  });
});
