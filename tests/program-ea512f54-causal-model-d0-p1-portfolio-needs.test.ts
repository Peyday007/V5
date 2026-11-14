/**
 * CAUSAL-14-4 / CAUSAL-14-7, review F2-2: the goal pass computed a portfolio's
 * decision unknowns and market-history gaps, labelled where each should go,
 * and sent none of them — only a person POSTing to `routes/causal.ts` reached
 * `sendNeeds` or `requestMarketHistory`. These pin that the goal pass now hands
 * them to those owners itself, idempotently, and skips what is not its own.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { forgetKnowledge, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { acquireMarketHistory } from '../server/services/quant/history.ts';
import { needKeyOf } from '../server/services/quant/needs.ts';
import { needOf, openingGraphScope, sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';
import type { DecisionUnknown, GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let opening: CashOpportunity;

beforeEach(async () => {
  forgetKnowledge();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `portfolio-needs-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

/** Only the parts of a portfolio the goal pass sends from. */
function portfolioWith(unknowns: DecisionUnknown[], history: GoalPortfolio['marketHistory']): GoalPortfolio {
  return { causal: { members: [], shared: [], account: null, decisionUnknowns: unknowns }, marketHistory: history } as unknown as GoalPortfolio;
}

describe('the goal pass sends the portfolio’s needs (CAUSAL-14-4, CAUSAL-14-7)', () => {
  it('raises each decision unknown and each history gap once, and nothing new on the next pass', async () => {
    const unknowns: DecisionUnknown[] = [
      { opportunityId: opening.id, unknown: 'whether the facility manager will pay in full before delivery', sendTo: 'authorized action' },
      { opportunityId: opening.id, unknown: 'what subcontracted cleaning crews charge per visit', sendTo: 'research' },
      // The same unknown twice is one need.
      { opportunityId: opening.id, unknown: 'what subcontracted cleaning crews charge per visit', sendTo: 'research' },
    ];
    const history = acquireMarketHistory(await loadCashKnowledge(projectId), opening);
    expect(history.gaps.length).toBeGreaterThan(0);
    const portfolio = portfolioWith(unknowns, [history]);

    const first = await sendPortfolioNeeds({ projectId, portfolio });
    expect(first.refused).toEqual([]);
    expect(first.created).toBe(2);
    expect(first.delivered).toBe(2 + history.gaps.length);

    const open = await listNeeds({ projectId, states: ['OPEN'] });
    const scope = openingGraphScope(opening.id);
    const research = open.find((one) => one.requestKey === needKeyOf(scope, needOf(unknowns[1]!)));
    const action = open.find((one) => one.requestKey === needKeyOf(scope, needOf(unknowns[0]!)));
    expect(research?.blockerKey).toMatch(/^EVIDENCE:causal-/);
    expect(research?.recommendedPath).toContain('what subcontracted cleaning crews charge per visit');
    expect(action?.blockerKey).toMatch(/^AUTHORITY:/);
    expect(open.filter((one) => one.requestKey?.startsWith(`market-history:${opening.id}:`))).toHaveLength(history.gaps.length);
    const total = open.length;

    const again = await sendPortfolioNeeds({ projectId, portfolio });
    expect(again.created).toBe(0);
    expect(again.refused).toEqual([]);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(total);
  });

  it('raises nothing for an estimated arrangement, another project’s opening, or no portfolio', async () => {
    const other = await createProject({ name: `other-${Math.random().toString(36).slice(2, 8)}` });
    const portfolio = portfolioWith(
      [
        { opportunityId: 'arr_constructed', unknown: 'whether anyone buys it', sendTo: 'research' },
        { opportunityId: opening.id, unknown: 'whether the payer prepays', sendTo: 'authorized action' },
      ],
      [],
    );
    const elsewhere = await sendPortfolioNeeds({ projectId: other.id, portfolio });
    expect(elsewhere).toEqual({ delivered: 0, created: 0, refused: [] });
    expect(await listNeeds({ projectId: other.id, states: ['OPEN'] })).toHaveLength(0);
    expect(await sendPortfolioNeeds({ projectId, portfolio: null })).toEqual({ delivered: 0, created: 0, refused: [] });

    const here = await sendPortfolioNeeds({ projectId, portfolio });
    expect(here.created).toBe(1);
  });

  it('is called by the goal plan pass on every reading, not only from a person’s request', () => {
    const source = readFileSync(new URL('../server/services/goals/plan.ts', import.meta.url), 'utf8');
    const pass = source.slice(source.indexOf('export async function advanceGoalPlans'));
    expect(pass).toContain('sendPortfolioNeeds({ projectId: reading.target.projectId, portfolio: reading.portfolio })');
  });
});
