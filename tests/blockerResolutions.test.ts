import { describe, expect, it } from 'vitest';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { relaxAlso, type InfeasibleConclusion } from '../server/services/goals/plan.ts';
import { blockerResolutions, type ResolutionInput } from '../server/services/goals/resolution.ts';
import { priorityLink } from '../bench/planningReliability/grade.ts';

/** A modelled opening with only the figures a resolution reads; every other input is unknown. */
function opening(id: string, figures: { price?: number; cost?: number; days?: number; hours?: number; capital?: number; repeatable?: boolean }): ModelledOpportunity {
  const input = (value: number | undefined) => ({ value: value ?? null, low: value ?? null, high: value ?? null, provenance: value === undefined ? 'UNKNOWN' : 'EVIDENCE', source: null, note: '' });
  return {
    opportunity: { id, title: `Opening ${id}` },
    index: 0,
    tier: 'QUALIFIED',
    repeatable: figures.repeatable ?? false,
    price: input(figures.price),
    directCost: input(figures.cost),
    daysToCash: input(figures.days),
    hours: input(figures.hours),
    capital: input(figures.capital),
    close: input(undefined),
    respond: input(undefined),
    volume: input(undefined),
    agreed: true,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
  } as unknown as ModelledOpportunity;
}

const base: Omit<ResolutionInput, 'strategies'> = {
  remaining: 8000,
  currency: 'USD',
  daysLeft: 30,
  hoursCeiling: null,
  capitalCeiling: null,
  net: false,
  researchDays: 2,
  value: 0.9,
};

const researched = (d: string) => d === 'RESEARCH_FIRST' || d === 'LEARN_WHILE_EXECUTING';

describe('blockerResolutions: a no-plan conclusion names what would resolve its blocker, with the number it must reach', () => {
  it('a deal that costs more than it pays: the direct cost must fall below the price', () => {
    const [r, ...rest] = blockerResolutions({ ...base, strategies: [[{ one: opening('a', { price: 2000, cost: 2300 }), deals: 5 }]] });
    expect(rest).toHaveLength(0);
    expect(r!.priority.field).toBe('directCosts');
    expect(priorityLink(r!.priority)).toBe('ECONOMICS');
    expect(researched(r!.priority.decision)).toBe(true);
    expect(r!.priority.reason).toMatch(/must fall below 2,000 USD a deal/);
    expect(r!.priority.reason).toMatch(/cheaper|fulfiller/);
    expect(r!.priority.opportunityId).toBeNull();
    expect(r!.priority.variable.startsWith('resolve:')).toBe(true);
  });

  it('a net target the margin cannot reach: the cost ceiling is the price less the margin each deal must keep', () => {
    const [r] = blockerResolutions({ ...base, net: true, remaining: 3000, strategies: [[{ one: opening('a', { price: 1000, cost: 800 }), deals: 10 }]] });
    // 3,000 net over 10 deals is 300 each: the cost must fall below 1,000 − 300 = 700.
    expect(priorityLink(r!.priority)).toBe('ECONOMICS');
    expect(r!.priority.reason).toMatch(/keep 300 USD each/);
    expect(r!.priority.reason).toMatch(/must fall below 700 USD a deal/);
    expect(r!.priority.reason).toMatch(/rise to at least 1,100/);
  });

  it('cash after the deadline: it must arrive within the days left, or the deadline move to when it settles', () => {
    const [r] = blockerResolutions({ ...base, daysLeft: 14, strategies: [[{ one: opening('a', { price: 1800, days: 60 }), deals: 4 }]] });
    expect(priorityLink(r!.priority)).toBe('SETTLES_IN_TIME');
    expect(r!.priority.reason).toMatch(/46 after the 14 left/);
    expect(r!.priority.reason).toMatch(/within 14 days/);
    expect(r!.relax).toEqual({ constraint: 'DEADLINE', suggestion: expect.stringMatching(/at least 60 days/) });
  });

  it('owner hours over the limit: hours a deal must fall to the limit over the deals, or the limit rise to what they need', () => {
    const [r] = blockerResolutions({ ...base, remaining: 4000, hoursCeiling: 13, strategies: [[{ one: opening('a', { price: 400, hours: 6 }), deals: 10 }]] });
    expect(priorityLink(r!.priority)).toBe('FULFILMENT');
    expect(researched(r!.priority.decision)).toBe(true);
    expect(r!.priority.reason).toMatch(/need 60 owner hours against the 13/);
    expect(r!.priority.reason).toMatch(/fall to 1\.3 a deal \(from 6/);
    expect(r!.relax).toEqual({ constraint: 'OWNER_HOURS', suggestion: expect.stringMatching(/at least 60 owner hours/) });
  });

  it('a lot that ties up more than the goal may commit: what a deal ties up must fall to the ceiling', () => {
    const [r] = blockerResolutions({ ...base, capitalCeiling: 500, strategies: [[{ one: opening('a', { price: 3000, capital: 1200 }), deals: 3 }]] });
    expect(priorityLink(r!.priority)).toBe('ECONOMICS');
    expect(r!.priority.reason).toMatch(/ties up 1,200 USD/);
    expect(r!.priority.reason).toMatch(/fall to 500 USD or less/);
    expect(r!.relax?.constraint).toBe('CAPITAL');
  });

  it('a market too small for the target: how many more deals, or what price, would close the gap', () => {
    const [r] = blockerResolutions({ ...base, remaining: 10000, strategies: [[{ one: opening('a', { price: 500, repeatable: true }), deals: 8 }]] });
    // 8 × 500 = 4,000 of 10,000: 12 more deals at 500, or 500 + 6,000 / 8 = 1,250 a deal.
    expect(priorityLink(r!.priority)).toBe('MARKET_VOLUME');
    expect(r!.priority.reason).toMatch(/at least 20 deals at 500/);
    expect(r!.priority.reason).toMatch(/12 more buyers/);
    expect(r!.priority.reason).toMatch(/at least 1,250/);
    expect(r!.relax).toEqual({ constraint: 'TARGET', suggestion: expect.stringMatching(/about 4,000 USD/) });
  });

  it('a strategy no limit breaks names nothing', () => {
    expect(blockerResolutions({ ...base, remaining: 1000, strategies: [[{ one: opening('a', { price: 500, cost: 100, days: 10, hours: 1 }), deals: 4 }]] })).toEqual([]);
  });

  it('relaxAlso adds a constraint the arithmetic did not name, once', () => {
    const inf: InfeasibleConclusion = { reason: 'r', relax: [{ constraint: 'TARGET', suggestion: 'lower it' }], headroomReach: 0, required: 0.9, instantOnly: false };
    const rs = blockerResolutions({ ...base, remaining: 4000, hoursCeiling: 13, strategies: [[{ one: opening('a', { price: 400, hours: 6 }), deals: 10 }], [{ one: opening('b', { price: 400, hours: 6 }), deals: 10 }]] });
    relaxAlso(inf, rs);
    expect(inf.relax.map((one) => one.constraint)).toEqual(['TARGET', 'OWNER_HOURS']);
  });
});
