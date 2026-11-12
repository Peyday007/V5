import { describe, expect, it } from 'vitest';
import { deprioritization, LESSON_MIN_SAMPLE } from '../server/services/cash/journey/learning.ts';
import { asReason, reasonBinds, reasonClass, OUTCOME_REASONS } from '../server/domain/cashOutcomeReasons.ts';
import type { CashOutcome } from '../server/domain/cashJourney.ts';

const row = (i: number, text: string, over: Partial<CashOutcome> = {}): CashOutcome => ({
  id: `o${i}`, projectId: 'p', opportunityId: `opp${i}`, kind: 'FAILURE_REASON', mechanism: 'RESALE', channel: 'email',
  valueCents: null, valueMs: null, valueText: text, currency: null, basis: '', requestKey: `k${i}`, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});
const capitalGoal = { hasCapitalLimit: true, hasDeadline: true, timedCashMetric: true };
const looseGoal = { hasCapitalLimit: false, hasDeadline: false, timedCashMetric: false };
const many = (n: number, text: string) => Array.from({ length: n }, (_, i) => row(i, text));

describe('outcome reasons', () => {
  it('has a closed vocabulary that separates opportunity from method failures', () => {
    expect(asReason('capital_too_high')).toBe('CAPITAL_TOO_HIGH');
    expect(asReason('they just said no')).toBeNull();
    expect(reasonClass('SOURCE_UNREADABLE')).toBe('METHOD');
    expect(reasonClass('NO_BUYER_FOUND')).toBe('OPPORTUNITY');
    expect(OUTCOME_REASONS).toHaveLength(9);
  });
  it('ranks a similar candidate lower after LESSON_MIN_SAMPLE same-reason failures, in proportion', () => {
    const below = deprioritization({ outcomes: many(LESSON_MIN_SAMPLE - 1, 'CAPITAL_TOO_HIGH'), mechanism: 'RESALE', channel: 'email', goal: capitalGoal });
    expect(below.demotion).toBe(0);
    const at = deprioritization({ outcomes: many(LESSON_MIN_SAMPLE, 'CAPITAL_TOO_HIGH'), mechanism: 'RESALE', channel: 'email', goal: capitalGoal });
    const more = deprioritization({ outcomes: many(LESSON_MIN_SAMPLE + 2, 'CAPITAL_TOO_HIGH'), mechanism: 'RESALE', channel: 'email', goal: capitalGoal });
    expect(at.demotion).toBe(LESSON_MIN_SAMPLE);
    expect(more.demotion).toBeGreaterThan(at.demotion);
  });
  it('does not demote under a goal where the reason does not bind, and never for another kind of candidate', () => {
    const outcomes = many(5, 'CAPITAL_TOO_HIGH');
    expect(deprioritization({ outcomes, mechanism: 'RESALE', channel: 'email', goal: looseGoal }).demotion).toBe(0);
    expect(deprioritization({ outcomes, mechanism: 'SERVICE', channel: 'email', goal: capitalGoal }).demotion).toBe(0);
    expect(reasonBinds('PAID_TOO_LATE', { ...capitalGoal, timedCashMetric: false })).toBe(false);
  });
  it('never lets a method failure mark a candidate down, and a new method lifts it', () => {
    const out = deprioritization({ outcomes: many(6, 'SOURCE_UNREADABLE'), mechanism: 'RESALE', channel: 'email', goal: capitalGoal });
    expect(out.demotion).toBe(0);
    expect(out.methodFailures).toEqual([{ reason: 'SOURCE_UNREADABLE', repeats: 6 }]);
    const lifted = deprioritization({ outcomes: many(6, 'SOURCE_UNREADABLE'), mechanism: 'RESALE', channel: 'email', goal: capitalGoal, methodChangedAt: '2026-11-01T00:00:00.000Z' });
    expect(lifted.methodFailures).toEqual([]);
  });
  it('bans nothing: the effect is a finite ordering input that vanishes with the goal', () => {
    const outcomes = many(50, 'NO_BUYER_FOUND');
    const d = deprioritization({ outcomes, mechanism: 'RESALE', channel: 'email', goal: capitalGoal });
    expect(Number.isFinite(d.demotion)).toBe(true);
    expect(d.words).toMatch(/stays eligible/);
  });
});
