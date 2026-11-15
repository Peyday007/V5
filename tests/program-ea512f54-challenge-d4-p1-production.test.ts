/**
 * CHAL-33 repair F2: the running Brain supplies its own challenge facts and its
 * own independent check.
 *
 * The production callers of `optimizePortfolio` (the goal compose and the
 * problem reconstruction) pass no `challenge` options. Before this repair that
 * meant every plan was challenged with no facts and no checks, so every deep
 * step was permanently held by "no independent check has agreed" and every
 * fact-based failure mode could only fire as "fact absent". These tests call
 * `optimizePortfolio` exactly the way those callers do — no `challenge` — and
 * require both states to be reachable from what the activities carry.
 */
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_HISTORY_PRODUCER,
  factsFromProblem,
  productionHistoryCheck,
} from '../server/services/quant/challenge.ts';
import { optimizePortfolio, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';

/** What the goal compose attaches from an acquired market history (`historyEvidence`). */
const history = (wins: number, bids: number, priceObservations = 4) => ({
  sampleSize: bids,
  winRate: { wins, bids },
  priceObservations,
  sources: ['lineage-a'],
  researchNeeds: [],
});

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [60], days: [2], justified: true, capital: 10, evidence: { sampleSize: 30 }, ...over,
});

/** A deep step (the large member) inside a two-member plan, built the way a production caller builds it: no `challenge`. */
function plan(bigHistory: ReturnType<typeof history> | undefined, tinyHistory: ReturnType<typeof history> | undefined): PortfolioProblem {
  const big = act('big', { cash: [1500], capital: 600, evidence: { sampleSize: 10_000, ...(bigHistory ? { history: bigHistory } : {}) } });
  const tiny = act('tiny', { cash: [150], capital: 1, evidence: { sampleSize: 10_000, ...(tinyHistory ? { history: tinyHistory } : {}) } });
  return { target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 400, activities: [big, tiny] };
}

describe('the plan read derives its facts from what the activities carry', () => {
  it('actual paid prices and a bid/win record become facts; nothing else is invented', () => {
    const facts = factsFromProblem(plan(history(95, 100), undefined));
    expect(facts['big']).toEqual({ priceKind: 'PAID', conversion: { rate: 0.95, attempts: 100 } });
    // No history, no facts: absence stays absence (invariant 39).
    expect(facts['tiny']).toBeUndefined();
    // Never asserted from a history: reachability, refunds, payout holds, legal review.
    for (const field of ['buyersReached', 'refundRate', 'payoutHoldDays', 'counterpartyReviewed', 'obligationsAccounted', 'priceObservedAt'] as const) {
      expect(facts['big']![field]).toBeUndefined();
    }
  });

  it('a failure mode is measured from a real fact in the running Brain: posted-vs-paid clears where paid prices were observed and fires where not', () => {
    const r = optimizePortfolio(plan(history(95, 100), history(95, 100, 0)));
    const c = r.assurance!.challenge!;
    expect(c.scrutiny.tier).toBe('DEEP');
    const postedVsPaid = c.findings.filter((f) => f.mode === 'POSTED_VS_PAID_PRICE').map((f) => f.subject);
    expect(postedVsPaid).not.toContain('big');
    expect(postedVsPaid).toContain('tiny');
  });

  it('a caller\'s facts refine the derived ones field by field rather than replacing them', () => {
    const r = optimizePortfolio({ ...plan(history(95, 100), history(95, 100)), challenge: { facts: { big: { refundRate: 0 } } } });
    const modes = r.assurance!.challenge!.findings.filter((f) => f.subject === 'big').map((f) => f.mode);
    expect(modes).not.toContain('POSTED_VS_PAID_PRICE');
    expect(modes).not.toContain('REFUNDS');
  });
});

describe('the plan read carries an independent check from production history', () => {
  it('a deep step is cleared after independent validation in the running Brain, with no caller-supplied check', () => {
    // Facts the history cannot supply are still a finding; supply only those, and no check.
    const others = { priceObservedAt: '2026-11-10T00:00:00Z', buyersReached: true, obligationsAccounted: true, payoutHoldDays: 0, refundRate: 0, counterpartyReviewed: true };
    const r = optimizePortfolio({ ...plan(history(95, 100), history(95, 100)), challenge: { facts: { big: others, tiny: others }, now: '2026-11-14T00:00:00Z' } });
    const c = r.assurance!.challenge!;
    expect(c.independentValidation).toEqual({ counted: 1, refusedAsSelfAgreement: 0, disagreeing: 0 });
    expect(c.ran).toContain('PRODUCTION_HISTORY');
    const big = c.steps.find((s) => s.key === 'big')!;
    expect(big.scrutiny.tier).toBe('DEEP');
    expect(big.heldBy).toEqual([]);
    expect(big.mayProceed).toBe(true);
  });

  it('exactly as a production caller calls it (no `challenge` at all), the check is counted and the "no independent check" hold is gone', () => {
    const r = optimizePortfolio(plan(history(95, 100), history(95, 100)));
    const c = r.assurance!.challenge!;
    expect(c.independentValidation.counted).toBe(1);
    const big = c.steps.find((s) => s.key === 'big')!;
    expect(big.heldBy.some((h) => h.includes('no independent check has agreed'))).toBe(false);
  });

  it('a history the samples are far more optimistic than disagrees, becomes a finding and holds the deep step', () => {
    // Samples settle in every world; the market wins 5 of 100 bids.
    const r = optimizePortfolio(plan(history(5, 100), history(95, 100)));
    const c = r.assurance!.challenge!;
    expect(c.independentValidation).toMatchObject({ counted: 1, disagreeing: 1 });
    const check = productionHistoryCheck(plan(history(5, 100), history(95, 100)), r)!;
    expect(check.agrees).toBe(false);
    expect(check.reach).toBeLessThan(r.best!.reach - 0.5);
    expect(c.findings.some((f) => f.mode === 'SELF_AGREEMENT' && f.assumption.includes(PRODUCTION_HISTORY_PRODUCER.model))).toBe(true);
    const big = c.steps.find((s) => s.key === 'big')!;
    expect(big.mayProceed).toBe(false);
    expect(big.heldBy.some((h) => h.includes('disagree'))).toBe(true);
  });

  it('is a different model over different data from the optimizer, so it is never refused as self-agreement', () => {
    const r = optimizePortfolio(plan(history(95, 100), history(95, 100)));
    expect(r.assurance!.challenge!.independentValidation.refusedAsSelfAgreement).toBe(0);
    expect(PRODUCTION_HISTORY_PRODUCER.model).not.toBe('quant/portfolio optimizePortfolio');
    expect(PRODUCTION_HISTORY_PRODUCER.dataSource).not.toBe('portfolio problem samples');
  });

  it('speaks only where it can: a member without a bid/win record means no check — never a passing one', () => {
    const p = plan(history(95, 100), undefined);
    const r = optimizePortfolio(p);
    expect(productionHistoryCheck(p, r)).toBeNull();
    const c = r.assurance!.challenge!;
    expect(c.independentValidation.counted).toBe(0);
    expect(c.steps.find((s) => s.key === 'big')!.heldBy.some((h) => h.includes('no independent check has agreed'))).toBe(true);
  });

  it('a member that closes several deals in a world is not compared to a per-bid rate', () => {
    const p = plan(history(95, 100), history(95, 100));
    p.activities = p.activities.map((a) => (a.key === 'big' ? { ...a, deals: [3] } : a));
    expect(productionHistoryCheck(p, optimizePortfolio(p))).toBeNull();
  });

  it('a short sample list is thinned at fine resolution, not in whole steps', () => {
    // One sample settling in every world, history allowing ~98%: a whole-step thinning would zero it entirely.
    const p = plan(history(95, 100), history(95, 100));
    const check = productionHistoryCheck(p, optimizePortfolio(p))!;
    expect(check.reach).toBeGreaterThan(0.9);
    expect(check.agrees).toBe(true);
  });
});
