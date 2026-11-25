/**
 * A goal whose only openings are route proposals awaiting their deep dive is
 * waiting on research, not refuted (production, 2026-11-25: such goals read
 * NOT_VIABLE "cannot reach … at prices buyers are shown to pay (at most 0)").
 *
 *   - while the dives have not settled the reading is NEEDS_EVIDENCE, no
 *     strategy is NOT_VIABLE, and the next step names the pending research;
 *   - nothing downstream treats that reading as the routes' failure: they are
 *     not excluded, archived, declined or ruled out, the next route ask does
 *     not name them as refuted, and their dives stay eligible;
 *   - once a dive has settled without a price buyers are shown to pay, the
 *     arithmetic stands again: the same openings read NOT_VIABLE.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { getOpportunity, opportunitiesWithRecordPrefix } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { goalRoutePrefix } from '../server/domain/routeOrigin.ts';
import { DISQUALIFIED_FIELD } from '../server/services/cash/engineCard.ts';
import { whyNotDiving } from '../server/services/cash/validation.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { readTarget } from '../server/services/goals/target.ts';
import { proposeGoalRoutes, routeContext, ROUTE_EVENT, settleRouteAsks } from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

let projectId = '';
let goalId = '';

const route = (i: number) => ({
  title: `Route ${i} retainer`, mechanism: 'PRODUCTIZED_SERVICE', industry: 'Software', payer: `Buyer segment ${'abc'[i]}`, offer: `Monthly service ${i}`, price: 1500, monthly: true,
  channel: 'Cold email to published contacts', performer: 'SUBCONTRACTOR', fulfiller: 'A freelance developer', directCost: 300, capital: 0, ownerHoursPerDeal: 1, daysToFirstCash: 14, buyerCount: 20000,
  volumeBasis: 'directory counts', assumptions: 'They pay monthly.', ownerFit: "Uses the owner's React skills.", searches: { price: ['p'], demand: ['d'], volume: ['v'] },
});

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`route-wait-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `route-wait-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({
    projectId,
    objective: "I write code (mostly JavaScript/React, some Python). I'd like $5k a month coming in on a recurring basis within 90 days. I have about $500 and can give it 10 hours a week.",
    actorRef: 'test',
    userId: owner.id,
  });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
  await settleRouteAsks();
  await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
  const chat: ChatFn = async () => ({ content: JSON.stringify({ routes: [route(0), route(1), route(2)] }), toolCalls: [], ms: 1, completionTokens: 1, error: null });
  const filed = await proposeGoalRoutes({ goalId }, { chats: async () => [{ label: 'stub', chat }], delivers: async () => [], startDives: async () => [] });
  if (filed.kind !== 'PROPOSED' || filed.filed.length !== 3) throw new Error(`routes not filed: ${JSON.stringify(filed)}`);
});

const routes = () => opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));

describe('a goal whose routes await their dives', () => {
  it('reads NEEDS_EVIDENCE naming the pending research, and no strategy reads NOT_VIABLE', async () => {
    await getDb().run("UPDATE cash_opportunities SET validation_state = 'PENDING' WHERE project_id = ?", [projectId]);
    const reading = (await readGoalPlan({ goalId, now: new Date(), evaluations: 50 }))!;
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    expect(reading.infeasible).toBeNull();
    expect(reading.strategies.filter((one) => one.verdict === 'NOT_VIABLE').map((one) => one.constraintsFailed)).toEqual([]);
    expect(reading.summary).not.toMatch(/at most 0/);
    expect(reading.summary).toMatch(/Research first: the deep dives? on "Route \d retainer"/);
    const chosen = reading.strategies.find((one) => one.key === reading.chosen)!;
    expect(chosen.nextTest?.by).toBe('BRAIN');
    expect(chosen.nextTest?.test).toMatch(/Research first: the deep dives? on "Route \d retainer"/);

    // Nothing downstream reads that as the routes' failure.
    const held = await routes();
    expect(held).toHaveLength(3);
    expect(reading.excluded.filter((one) => held.some((o) => o.id === one.opportunityId))).toEqual([]);
    for (const o of held) {
      const now = (await getOpportunity(o.id))!;
      expect(now.state).not.toMatch(/ARCHIVED|DECLINED/);
      expect((await cardFactsFor(o.id)).some((fact) => fact.field === DISQUALIFIED_FIELD)).toBe(false);
    }
    const goal = (await getWorkstream(goalId))!;
    const read = (await routeContext(goal, (await readTarget(goal, new Date()))!, [], { delivers: async () => [] }))!;
    expect(read.ctx.refuted).toEqual([]);
    // A dive not yet started stays eligible to start.
    await getDb().run('UPDATE cash_opportunities SET validation_state = NULL, candidate_id = NULL WHERE project_id = ?', [projectId]);
    expect((await whyNotDiving((await getOpportunity(held[0]!.id))!)).kind).toBe('ELIGIBLE');
  }, 60_000);

  it('once the dives settle without a price buyers are shown to pay, the arithmetic stands: NOT_VIABLE', async () => {
    await getDb().run("UPDATE cash_opportunities SET validation_state = 'BLOCKED', validation_settled_at = ? WHERE project_id = ?", [new Date().toISOString(), projectId]);
    const reading = (await readGoalPlan({ goalId, now: new Date(), evaluations: 50 }))!;
    expect(reading.strategies.some((one) => one.constraintsFailed.some((c) => /at prices buyers are shown to pay/.test(c)))).toBe(true);
  }, 60_000);
});
