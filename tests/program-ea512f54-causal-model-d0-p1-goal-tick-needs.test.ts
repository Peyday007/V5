/**
 * Review F2-2 (CAUSAL-14-4, CAUSAL-14-7), against a real database: the goal
 * tick sends what its portfolio could not establish. A decision unknown routed
 * to research or to an authorized action, and the market history the best
 * combination lacks, each become a row an owner holds — not only a line of
 * text in `GoalPortfolio.missing` — and a second tick raises nothing new.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { forgetKnowledge, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { acquireMarketHistory } from '../server/services/quant/history.ts';
import { needKeyOf } from '../server/services/quant/needs.ts';
import { COUNTERPARTY_PERMISSION, goalGraphScope, needOf, sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let opening: CashOpportunity;

beforeEach(async () => {
  forgetKnowledge();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `tick-needs-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  const activated = await activate({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(activated.ok).toBe(true);
  const captured = await capture({
    projectId,
    actorRef: user.id,
    ownerUserId: user.id,
    title: 'Subcontracted office cleaning',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    industry: 'commercial cleaning',
  });
  if (!captured.ok) throw new Error(captured.reason);
  opening = (await getOpportunity(captured.value.id))!;
});

afterAll(async () => {
  await teardown();
});

async function portfolioFor(op: CashOpportunity): Promise<GoalPortfolio> {
  const history = acquireMarketHistory(await loadCashKnowledge(projectId), op);
  return {
    best: { members: [{ opportunityId: op.id }] },
    marketHistory: [history],
    causal: {
      decisionUnknowns: [
        { opportunityId: op.id, unknown: 'whether the buyer will pay in full before delivery', sendTo: 'authorized action' },
        { opportunityId: op.id, unknown: 'the direct cost per deal', sendTo: 'research' },
      ],
    },
  } as unknown as GoalPortfolio;
}

describe('the goal tick sends its portfolio needs (review F2-2)', () => {
  it('turns every decision unknown and every history gap into a row an owner holds, once', async () => {
    const portfolio = await portfolioFor(opening);
    const first = await sendPortfolioNeeds({ goalId: 'goal_tick_test', projectId, portfolio });
    expect(first.refused).toEqual([]);
    expect(first.historyRequested).toBe(3);
    expect(first.sent).toBe(5);
    expect(first.created).toBe(2);

    const scope = goalGraphScope('goal_tick_test', opening.id);
    const keys = portfolio.causal!.decisionUnknowns.map((one) => needKeyOf(scope, needOf(one)));
    const needs = await listNeeds({ projectId });
    for (const key of keys) expect(needs.filter((n) => n.requestKey === key)).toHaveLength(1);
    const action = needs.find((n) => n.requestKey === keys[0]);
    expect(action?.blockerKey).toBe(`AUTHORITY:${COUNTERPARTY_PERMISSION}`);
    // The research unknown is researched, not parked for a person: its need points at an idea the research path runs.
    const research = needs.find((n) => n.requestKey === keys[1]);
    expect(research?.candidateId).toBeTruthy();
    const idea = await getCandidate(research!.candidateId!);
    expect(idea?.projectId).toBe(projectId);
    expect(idea?.statement).toContain('the direct cost per deal');
    expect(needs.filter((n) => n.requestKey?.startsWith(`market-history:${opening.id}:`))).toHaveLength(3);

    // The next tick reads the open rows back; the review is not flooded.
    const second = await sendPortfolioNeeds({ goalId: 'goal_tick_test', projectId, portfolio });
    expect(second.refused).toEqual([]);
    expect(second.created).toBe(0);
    expect((await listNeeds({ projectId })).length).toBe(needs.length);
  });

  it('asks history only for the best combination, and skips an estimate with no opening row', async () => {
    const portfolio = await portfolioFor(opening);
    const none = { ...portfolio, best: null, causal: null } as unknown as GoalPortfolio;
    expect((await sendPortfolioNeeds({ goalId: 'g', projectId, portfolio: none })).sent).toBe(0);
    const estimate = { ...portfolio, best: { members: [{ opportunityId: 'arr_not_an_opening' }] }, marketHistory: [{ ...portfolio.marketHistory![0]!, opportunityId: 'arr_not_an_opening' }], causal: null } as unknown as GoalPortfolio;
    expect((await sendPortfolioNeeds({ goalId: 'g', projectId, portfolio: estimate })).historyRequested).toBe(0);
    expect(await listNeeds({ projectId })).toHaveLength(0);
  });

  it('is called from the goal tick, not only from a route a person must POST', () => {
    const plan = readFileSync(new URL('../server/services/goals/plan.ts', import.meta.url), 'utf8');
    const tick = plan.slice(plan.indexOf('export async function advanceGoalPlans'));
    expect(tick).toContain('sendPortfolioNeeds(');
  });
});
