/**
 * CAUSAL-14-7 (S-0136..S-0141): for an established market Brain acquires and
 * uses the historical record that already exists — transaction counts, actual
 * prices and spreads, bid/win rates — from the research and outcomes it holds,
 * and the assurance of a plan rests on that record rather than only on a sample
 * size a caller typed. What the archive lacks is a named research need.
 */
import { describe, expect, it } from 'vitest';
import {
  acquireMarketHistory,
  historyEvidence,
  readBidWin,
  readPrices,
  readSpreads,
  readTransactionCounts,
} from '../server/services/quant/history.ts';
import { MIN_EVIDENCE_SAMPLE, assess, effectiveSample, type Activity, type PortfolioReading } from '../server/services/quant/portfolio.ts';
import type { CashKnowledge } from '../server/services/quant/knowledge.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const opp = (id: string, over: Partial<CashOpportunity> = {}): CashOpportunity =>
  ({ id, projectId: 'prj_h', title: `Opening ${id}`, mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning', currency: 'USD', priceCents: 150_000, duplicateOfId: null, ...over }) as CashOpportunity;

const fact = (id: string, opportunityId: string, value: string, claimId: string | null = `clm_${id}`): CashCardFact => ({
  id, projectId: 'prj_h', opportunityId, field: 'buyingEvidence', kind: 'EVIDENCE', value, claimId, needId: null, basis: null, assumptions: null, uncertainty: null, decidedBy: 'research', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});

function knowledgeOf(opps: CashOpportunity[], facts: CashCardFact[], sources: Record<string, string> = {}, lessons: CashKnowledge['lessons'] = []): CashKnowledge {
  return {
    projectId: 'prj_h',
    opportunities: new Map(opps.map((one) => [one.id, one])),
    facts,
    lessons,
    sources: new Map(Object.entries(sources).map(([claim, url]) => [claim, { sourceUrl: url, sourcePublisher: null, sourceDate: '2026-09-01' }])),
    watermark: '',
    routeMoney: new Map(),
    routeScores: new Map(),
    routeMoneyError: null,
    estimates: new Map(),
    learning: null,
  };
}

describe('reading the historical record from researched passages', () => {
  it('reads bid/win records as wins over bids, and a rate only with its count of bids', () => {
    expect(readBidWin('The firm won 14 of 60 bids last year.').map(({ wins, bids }) => [wins, bids])).toEqual([[14, 60]]);
    expect(readBidWin('Contractors report a 25% win rate across 200 tenders.').map(({ wins, bids }) => [wins, bids])).toEqual([[50, 200]]);
    expect(readBidWin('They had 1,200 wins out of 4,000 proposals.').map(({ wins, bids }) => [wins, bids])).toEqual([[1200, 4000]]);
    // A rate with no count of bids is not a sample.
    expect(readBidWin('Win rates are about 25%.')).toEqual([]);
    // Wins over bids cannot exceed the bids.
    expect(readBidWin('won 70 of 60 bids')).toEqual([]);
  });

  it('reads transaction counts, prices actually paid, and spreads', () => {
    expect(readTransactionCounts('The county let 1,240 contracts awarded in 2025.').map((one) => one.count)).toContain(1240);
    expect(readTransactionCounts('Founded in 2019 transactions grew.').map((one) => one.count)).not.toContain(2019);
    expect(readPrices('Buildings paid $1,450 per month on average.', 'USD').map((one) => one.cents)).toEqual([145_000]);
    expect(readSpreads('Subcontractors keep a margin of 15–20% on each job.').map((one) => one.share)).toEqual([0.15, 0.2]);
  });
});

describe('acquiring one market history from what the project holds', () => {
  const target = opp('t');
  const peer = opp('p');
  const otherMechanism = opp('x', { mechanism: 'PRODUCTIZED_SERVICE' });

  it('pools bid/win records by source page, so one report cited twice is one sample', () => {
    const k = knowledgeOf(
      [target, peer, otherMechanism],
      [
        fact('f1', 'p', 'Regional cleaning subcontractors won 30 of 120 bids in 2025.', 'c1'),
        fact('f2', 't', 'Regional cleaning subcontractors won 30 of 120 bids in 2025.', 'c2'),
        fact('f3', 'p', 'A second survey found members won 18 of 80 tenders.', 'c3'),
        fact('f4', 'x', 'Resellers won 90 of 100 bids.', 'c4'),
        fact('f5', 'p', 'The metro area let 640 contracts awarded last year; buildings paid $1,450 per month.', 'c5'),
      ],
      { c1: 'https://example.org/report', c2: 'https://www.example.org/report/', c3: 'https://survey.example.com/a', c4: 'https://resale.example/x', c5: 'https://county.example.gov/awards' },
    );
    const h = acquireMarketHistory(k, target);
    // c1 and c2 are the same page: 120 + 80 bids, never 120 + 120 + 80; the resale record is broad.
    expect(h.winRate).toEqual({ wins: 48, bids: 200, rate: 48 / 200 });
    expect(h.sampleSize).toBe(200);
    expect(h.bidWin.find((one) => one.opportunityId === 'x')!.broad).toBe(true);
    expect(h.marketTransactions).toBe(640);
    expect(h.priceBand).toEqual({ low: 1450, median: 1450, high: 1450, observations: 1 });
    expect(h.sources).toContain('url:example.org/report');
    expect(h.researchNeeds).toEqual([]);
  });

  it('counts this Brain’s own outcomes as first-hand bid/win history', () => {
    const k = knowledgeOf([target], [], {}, [
      { mechanism: 'SUBCONTRACTED_FULFILMENT', channel: 'email', contacts: 40, answered: 10, agreements: 6, medianTimeToAgreementMs: null, medianAcceptedOverOfferedBp: null, completed: 4, realizedContributionCents: 0, failures: [], anecdote: false },
    ]);
    const h = acquireMarketHistory(k, target);
    expect(h.winRate).toEqual({ wins: 6, bids: 40, rate: 0.15 });
    expect(h.marketTransactions).toBe(4);
  });

  it('names what the archive lacks as research, never as a favourable assumption', () => {
    const h = acquireMarketHistory(knowledgeOf([target], []), target);
    expect(h.sampleSize).toBeUndefined();
    expect(h.winRate).toBeNull();
    expect(h.researchNeeds.join(' | ')).toMatch(/bid\/win history.*transaction counts.*actual prices/);
  });
});

describe('assurance uses the acquired history', () => {
  const reading = (keys: string[], reach: number): PortfolioReading => ({ keys, reach, settledP10: 10, settledP50: 50, settledP90: 90, capitalShort: 0, overSpend: 0, contribution: 0, capitalTurnover: 0, feasible: true, infeasibleBecause: null, basis: 'PROBABILITY' });
  const act = (key: string, over: Partial<Activity> = {}): Activity => ({ key, label: key, cash: [100], days: [1], justified: true, ...over });

  it('with no stated sample, the bids of the acquired bid/win record are the sample', () => {
    const h = acquireMarketHistory(knowledgeOf([opp('t')], [fact('f', 't', 'Cleaning subcontractors won 400 of 2,000 bids.', 'c')], { c: 'https://example.org/r' }), opp('t'));
    const a = act('t', { evidence: { history: historyEvidence(h) } });
    expect(effectiveSample(a)).toEqual({ size: 2000, from: 'HISTORY' });
    const result = assess({ activities: [a], target: 100, deadlineDays: 10 }, reading(['t'], 0.999));
    expect(result.status).toBe('CLAIMS_AT_LEAST_90');
    expect(result.history![0]).toMatchObject({ key: 't', sampleFrom: 'HISTORY', sampleSize: 2000, winRate: { wins: 400, bids: 2000, rate: 0.2 } });
    expect(result.researchNeeds).toEqual(expect.arrayContaining([expect.stringMatching(/transaction counts/)]));
  });

  it('a thin acquired history is a RANGE, and none at all is unavailable calibration with research named', () => {
    const thin = acquireMarketHistory(knowledgeOf([opp('t')], [fact('f', 't', 'They won 3 of 10 bids.', 'c')]), opp('t'));
    expect(thin.sampleSize).toBeLessThan(MIN_EVIDENCE_SAMPLE);
    const r1 = assess({ activities: [act('t', { evidence: { history: historyEvidence(thin) } })], target: 100, deadlineDays: 10 }, reading(['t'], 0.99));
    expect(r1.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(r1.validationProblems.join(' ')).toMatch(/from acquired bid\/win history/);
    const r2 = assess({ activities: [act('t', { evidence: {} })], target: 100, deadlineDays: 10 }, reading(['t'], 0.99));
    expect(r2.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(r2.validationProblems.join(' ')).toMatch(/no bid\/win history was acquired/);
    expect(r2.researchNeeds!.join(' ')).toMatch(/historical record/);
  });
});

describe('the goal portfolio acquires history for every opening it models', () => {
  const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
  const modelled = (o: CashOpportunity): ModelledOpportunity => ({
    opportunity: o, index: 1, tier: 'QUALIFIED', repeatable: true, price: fixed(1500), capital: fixed(60), hours: fixed(2), daysToCash: fixed(3),
    close: fixed(0.2), respond: fixed(0.05), directCost: fixed(100), volume: fixed(500), agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false,
  }) as ModelledOpportunity;
  const limits = { remaining: 3000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 400, seed: 3 };

  it('a fixed close rate nobody sampled is calibrated by the market’s bid/win record, and the record is reported', () => {
    const t = opp('t');
    const without = evaluateGoalPortfolio({ ...limits, openings: [modelled(t)], knowledge: null });
    expect(without.assurance!.status).toBe('CALIBRATION_UNAVAILABLE');
    expect(without.missing.join(' ')).toMatch(/research: .*historical record/);

    const k = knowledgeOf([t], [fact('f', 't', 'Cleaning subcontractors won 400 of 2,000 bids; the county let 900 contracts awarded.', 'c')], { c: 'https://example.org/r' });
    const withHistory = evaluateGoalPortfolio({ ...limits, openings: [modelled(t)], knowledge: k });
    expect(withHistory.marketHistory![0]!.winRate).toEqual({ wins: 400, bids: 2000, rate: 0.2 });
    expect(withHistory.marketHistory![0]!.marketTransactions).toBe(900);
    expect(withHistory.assurance!.history![0]).toMatchObject({ sampleFrom: 'HISTORY', sampleSize: 2000 });
    expect(withHistory.assurance!.status).not.toBe('CALIBRATION_UNAVAILABLE');
  });
});
