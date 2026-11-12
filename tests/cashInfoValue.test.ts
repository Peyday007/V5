import { describe, expect, it } from 'vitest';
import { orderFieldsByCost, planQuestions, questionDecision } from '../server/services/cash/infoValue.ts';
import type { ScreenFacts, ScreenLimits } from '../server/services/cash/screen.ts';

const now = '2026-10-30T00:00:00.000Z';
const limits: ScreenLimits = { metric: 'COLLECTED_CASH', daysLeft: 30, capitalCeilingCents: 50_000, capitalBeforeProofCents: null };
const facts: ScreenFacts = {
  capitalRequiredCents: null, noCapitalRoute: null, daysToPayment: null, expiresAt: null, duplicateOf: null,
  requirements: [], capabilities: [], exclusions: [], hasPayer: false, hasPrice: false, typeHasHistory: true,
  sourceObservedAt: now,
};

describe('value of information', () => {
  it('skips a question whose every answer leaves the decision unchanged, with the reason', () => {
    const rejected = { ...facts, duplicateOf: 'opp_1' };
    const d = questionDecision('PAYMENT_TIMING', rejected, limits, now);
    expect(d.ask).toBe(false);
    expect(d.why).toMatch(/every possible answer leaves the decision/);
    expect(questionDecision('PAYER', rejected, limits, now)).toMatchObject({ ask: false });
  });
  it('asks a decisive question, and puts it before others', () => {
    const f = { ...facts, capitalRequiredCents: 10_000_000 };
    const plan = planQuestions(['DEMAND', 'NO_CAPITAL_ROUTE', 'PAYER'], f, limits, now);
    expect(plan.ask[0]!.question).toBe('NO_CAPITAL_ROUTE');
    expect(plan.skipped.map((s) => s.question).sort()).toEqual(['DEMAND', 'PAYER']);
  });
  it('orders the rest cheapest-first when nothing is rejected', () => {
    const plan = planQuestions(['DEMAND', 'PRICE', 'ELIGIBILITY'], facts, limits, now);
    expect(plan.skipped).toEqual([]);
    const costs = plan.ask.map((a) => a.cost);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });
  it('orders card fields cheapest-first without dropping any', () => {
    const fields = [{ key: 'demand' }, { key: 'other' }, { key: 'price' }, { key: 'access' }];
    expect(orderFieldsByCost(fields).map((f) => f.key)).toEqual(['access', 'price', 'demand', 'other']);
  });
});
