/**
 * Production, 2026-11-19: a goal whose constructed arrangements were all
 * unpriced evaluated no portfolio, and its unpriced populations rode only on
 * that portfolio (`portfolio.unpriced`, #1140). The goal tick sent nothing,
 * so no price research ever launched for the population the plan led with.
 *
 * The reading now carries its unpriced populations itself, the lead's first
 * (`unpricedForPlan`), and `sendPortfolioNeeds` sends them as the same
 * `goal-price-` research needs with or without a portfolio.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { GOAL_PRICE_KEY_PREFIX } from '../server/services/goals/goalWork.ts';
import { unpricedForPlan } from '../server/services/goals/plan.ts';
import type { UnpricedPopulation } from '../server/services/goals/portfolio.ts';
import { PRICE_ASKS_PER_READ, sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';

function population(n: number): UnpricedPopulation {
  return {
    population: `pop_${n}`,
    buyer: `buyers number ${n}`,
    designs: 10 - n,
    arrangementKey: `k${n}`,
    label: `Design ${n}`,
    question: `What does one buyer described as "buyers number ${n}" pay, in USD, for one purchase? Declare it: structural_subject price_per_unit.`,
  };
}

const lead = (ref: string) => ({ demand: { name: 'buyers', claimId: null, from: 'INDUSTRY_MAP', ref } }) as unknown as Pick<ConstructedArrangement, 'demand'>;

describe('the plan\'s unpriced populations, its lead\'s first', () => {
  it('puts the leading arrangement\'s population first, and keeps the rest in order', () => {
    const unpriced = [1, 2, 3, 4].map(population);
    expect(unpricedForPlan(unpriced, lead('pop_4')).unpriced!.map((one) => one.population)).toEqual(['pop_4', 'pop_1', 'pop_2', 'pop_3']);
    expect(unpricedForPlan(unpriced, null).unpriced!.map((one) => one.population)).toEqual(['pop_1', 'pop_2', 'pop_3', 'pop_4']);
    expect(unpricedForPlan(unpriced, lead('pop_elsewhere')).unpriced).toEqual(unpriced);
    expect(unpricedForPlan([], lead('pop_1'))).toEqual({});
    expect(unpricedForPlan(undefined, null)).toEqual({});
  });
});

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

afterAll(async () => {
  await teardown();
});

describe('a goal with no portfolio still asks what its buyers pay', () => {
  it('sends the goal-price research need for the lead\'s population although no portfolio was evaluated', async () => {
    const { unpriced } = unpricedForPlan([1, 2, 3, 4].map(population), lead('pop_4'));
    const sent = await sendPortfolioNeeds({ goalId: 'wst_no_portfolio', projectId, portfolio: null, unpriced });
    expect(sent.refused).toEqual([]);
    expect(sent.created).toBe(PRICE_ASKS_PER_READ);
    const needs = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`));
    expect(needs).toHaveLength(PRICE_ASKS_PER_READ);
    // The lead's population, last by design count, is asked within the read's cap.
    const asked = await Promise.all(needs.map(async (n) => (await getCandidate(n.candidateId!))?.statement ?? ''));
    expect(asked.some((one) => /buyers number 4" pay/.test(one))).toBe(true);
  });

  it('with neither a portfolio nor an unpriced population, sends nothing', async () => {
    const sent = await sendPortfolioNeeds({ goalId: 'wst_no_portfolio', projectId, portfolio: null });
    expect(sent).toEqual({ sent: 0, created: 0, historyRequested: 0, refused: [] });
  });
});
