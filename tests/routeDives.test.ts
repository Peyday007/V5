/**
 * A goal's proposed routes are researched promptly, before anything is sold
 * (production, 2026-11-25: twelve fresh evaluation goals; nine held six route
 * openings each and, 75 minutes on, no deep dive had started on any of them).
 *
 *   - filing a goal's routes starts their dives at once, inside the project's
 *     dive room, rather than waiting for the tick's serial project walk —
 *     which had been running 38 minutes with these projects last in it; and
 *     the walk now takes a live goal's projects first, newest first;
 *   - a route's dive idea is linked to its goal, so judging and launching rank
 *     it with the goal's work rather than behind every unjudged idea;
 *   - two callers starting dives at once never capture two ideas for one opening;
 *   - a route whose price is still the proposal's hypothesis is not sold while
 *     its dive has not settled, and the goal records why it waits;
 *   - an ask no model answered is retried within the hour, bounded per day,
 *     and the reply is read tolerantly (fenced, a top-level array, cut off);
 *   - goals that find every proposal place taken wait for one instead of being
 *     turned away silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { getOpportunity, opportunitiesWithRecordPrefix } from '../server/repos/cashPortfolio.ts';
import { listLinks, workstreamEventsOfKind } from '../server/repos/register.ts';
import { startValidations } from '../server/services/cash/validation.ts';
import { goalRoutePrefix } from '../server/domain/routeOrigin.ts';
import { GOAL_TIER_NONE, goalFirstSql, goalIdeaSql, goalProjectsFirst, liveGoalProjectIds } from '../server/services/goals/goalWork.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { createNeed } from '../server/repos/cashPortfolio.ts';
import { pauseGoal } from '../server/repos/goals.ts';
import { unjudgedGoalIdeas } from '../server/services/russell/loop.ts';
import { heldForResearch, readGoalPlan, researchBeforeSale, SALE_WAITS_FOR_RESEARCH } from '../server/services/goals/plan.ts';
import {
  armRouteProposal,
  parseRoutes,
  proposeGoalRoutes,
  ROUTE_EVENT,
  ROUTE_FAILED_ASKS_PER_DAY,
  ROUTE_PROPOSAL_EVERY_MS,
  ROUTE_RETRY_AFTER_FAILURE_MS,
  routeAskDue,
  routesJson,
  settleRouteAsks,
  type RouteContext,
  type RouteDeps,
} from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

let projectId = '';
let goalId = '';
const now = new Date();

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`route-dives-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `route-dives-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: 'Collect 3000 dollars of settled cash within 30 days using at most $500', actorRef: 'test', userId: owner.id, now: new Date(now.getTime() - 60_000) });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
});

const ROUTE_A = {
  title: 'Monthly bookkeeping spreadsheets for dental practices', mechanism: 'PRODUCTIZED_SERVICE', industry: 'Dental', payer: 'Independent dental practices',
  offer: 'A monthly cash-flow spreadsheet', price: 400, monthly: true, channel: 'Published practice email addresses', performer: 'BRAIN', fulfiller: 'Brain', brainDeliverable: 'spreadsheet',
  directCost: 20, capital: 0, ownerHoursPerDeal: 0, daysToFirstCash: 7, buyerCount: 120000, volumeBasis: 'ADA practice counts', assumptions: 'Practices pay monthly for this.', ownerFit: 'Brain produces it; no owner work.',
  searches: { price: ['dental bookkeeping monthly price'], demand: ['dental practice hiring bookkeeper 2026'], volume: ['number of dental practices US'] },
};
const ROUTE_B = {
  title: 'Subcontracted podcast editing for agencies', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'Media', payer: 'Marketing agencies with podcasts',
  offer: 'Edited podcast episodes', price: 250, monthly: false, channel: 'Agency directory contact forms', performer: 'SUBCONTRACTOR', fulfiller: 'A freelance audio editor',
  directCost: 90, capital: 100, ownerHoursPerDeal: 0.5, daysToFirstCash: 10, buyerCount: 5000, volumeBasis: 'directory listing', assumptions: 'Agencies outsource editing.', ownerFit: 'Subcontracted; the owner only approves.',
  searches: { price: ['podcast editing rates'], demand: ['agency podcast editor wanted'], volume: ['marketing agencies with podcasts count'] },
};

function replying(...contents: string[]): { deps: Omit<RouteDeps, 'startDives'>; asked: () => number } {
  let n = 0;
  const chat: ChatFn = async () => {
    const content = contents[Math.min(n, contents.length - 1)]!;
    n += 1;
    return { content, toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return { asked: () => n, deps: { chats: async () => [{ label: 'stub', chat }], delivers: async () => ['spreadsheet'] } };
}

const routes = () => opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
const ctx: RouteContext = { objective: 'x', currency: 'USD', remaining: 3000, daysLeft: 30, capitalLimit: 500, hoursLimit: null, resources: null, industry: null, recurring: false, exclusions: [], delivers: ['spreadsheet'], held: [], refuted: [] };

describe("a goal's routes dive when they are filed", () => {
  it('starts the dives at filing, inside the room, and links each dive idea to the goal', async () => {
    const { deps } = replying(JSON.stringify({ routes: [ROUTE_A, ROUTE_B] }));
    const outcome = await proposeGoalRoutes({ goalId, now }, deps);
    expect(outcome.kind).toBe('PROPOSED');
    if (outcome.kind !== 'PROPOSED') return;
    expect(outcome.filed).toHaveLength(2);
    // No research surface is registered: the room is its floor of one, and that one starts now.
    expect(outcome.dived.length).toBeGreaterThanOrEqual(1);
    const dived = (await getOpportunity(outcome.dived[0]!))!;
    expect(dived.validationState).toBe('PENDING');
    const started = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_VALIDATION_STARTED'", [dived.id]);
    expect(Number(started[0]!.n)).toBe(1);

    // The dive idea is the goal's own work for every reader of the goal tier.
    const link = (await listLinks(goalId)).find((one) => one.kind === 'CANDIDATE' && one.ref === dived.candidateId);
    expect(link?.relation).toBe('PURSUES');
    const tier = await getDb().all<{ id: string }>(`SELECT c.id FROM russell_candidates c WHERE ${goalIdeaSql('c')}`);
    expect(tier.map((one) => one.id)).toContain(dived.candidateId);
  });

  it('a route dive with no link of its own, and the questions raised about its opening, are the goal’s work; the dive goes first', async () => {
    // Production 2026-11-25: dives started before the dive link existed, and every
    // narrow question about a route opening, sat unjudged in the untargeted tier.
    const { deps } = replying(JSON.stringify({ routes: [ROUTE_A, ROUTE_B] }));
    const outcome = await proposeGoalRoutes({ goalId, now }, deps);
    if (outcome.kind !== 'PROPOSED') throw new Error('not proposed');
    const dived = (await getOpportunity(outcome.dived[0]!))!;
    await getDb().run(`DELETE FROM workstream_links WHERE workstream_id = ? AND kind = 'CANDIDATE'`, [goalId]);
    const question = await createCandidate({ projectId, title: 'Who signs for bookkeeping', statement: 'who at a dental practice signs for bookkeeping spend' });
    await getDb().run(`UPDATE russell_candidates SET created_at = ? WHERE id = ?`, ['2026-01-01T00:00:00.000Z', question.id]);
    await createNeed({
      projectId, opportunityId: dived.id, blockedAction: 'qualify the opening', whyItMatters: 'the buyer', recommendedPath: 'research',
      setupEffort: 'none', nextStep: 'ask', completionCondition: 'answered', candidateId: question.id, requestKey: 'causal-test-signer',
    });
    const tier = async (id: string) =>
      Number((await getDb().get<{ k: number }>(`SELECT ${goalFirstSql('c')} AS k FROM russell_candidates c WHERE c.id = ?`, [id]))!.k);
    expect(await tier(dived.candidateId!)).toBe(2);
    expect(await tier(question.id)).toBe(3);
    // Older though the question is, the goal's judging takes the dive first.
    const picked = (await unjudgedGoalIdeas(1)).map((one) => one.id);
    expect(picked).toEqual([dived.candidateId]);

    // A paused goal's openings are nobody's goal work.
    await pauseGoal(goalId, 'not now');
    expect(await tier(dived.candidateId!)).toBe(GOAL_TIER_NONE);
    expect(await tier(question.id)).toBe(GOAL_TIER_NONE);
  });

  it('two callers starting dives at once capture one idea per opening', async () => {
    const { deps } = replying(JSON.stringify({ routes: [ROUTE_A, ROUTE_B] }));
    await proposeGoalRoutes({ goalId, now }, { ...deps, startDives: async () => [] });
    const results = await Promise.all([startValidations({ projectId }), startValidations({ projectId }), startValidations({ projectId })]);
    const ids = results.flat().map((one) => one.opportunityId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of await routes()) {
      const rows = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_VALIDATION_STARTED'", [o.id]);
      expect(Number(rows[0]!.n)).toBeLessThanOrEqual(1);
    }
  });

  it("the project walk takes a live goal's projects first, newest first", async () => {
    const live = await liveGoalProjectIds();
    expect(live.has(projectId)).toBe(true);
    const order = goalProjectsFirst(
      [
        { id: 'old-plain', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'old-goal', createdAt: '2026-02-01T00:00:00Z' },
        { id: 'plain', createdAt: '2026-03-01T00:00:00Z' },
        { id: 'new-goal', createdAt: '2026-11-25T03:29:00Z' },
      ],
      new Set(['old-goal', 'new-goal']),
    );
    expect(order.map((one) => one.id)).toEqual(['new-goal', 'old-goal', 'old-plain', 'plain']);
  });
});

describe('a route is researched before it is sold', () => {
  it('is not sold while its price is a hypothesis and its dive has not settled, and the goal says why', async () => {
    const { deps } = replying(JSON.stringify({ routes: [ROUTE_A, ROUTE_B] }));
    await proposeGoalRoutes({ goalId, now }, { ...deps, startDives: async () => [] });
    const reading = (await readGoalPlan({ goalId, now: new Date(), evaluations: 50, persist: true }))!;
    const routeIds = new Set((await routes()).map((one) => one.id));
    expect(reading.sales.filter((one) => routeIds.has(one.opportunityId))).toEqual([]);
    const pursued = await getDb().all("SELECT id FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_SALE_PURSUED'", [goalId]);
    expect(pursued).toHaveLength(0);
    // Each route a sale would have taken is named, with why it waits.
    // Both stand at C (a reachable buyer, an offer, a price) on hypotheses alone: what a sale used to be made of.
    expect(reading.researchFirst?.map((one) => one.opportunityId).sort()).toEqual([...routeIds].sort());
    for (const one of reading.researchFirst ?? []) {
      expect(routeIds.has(one.opportunityId)).toBe(true);
      expect(one.reason).toMatch(/research first/);
    }
    const waits = await workstreamEventsOfKind(goalId, SALE_WAITS_FOR_RESEARCH, new Date(0).toISOString(), 50);
    expect(waits.length).toBe((reading.researchFirst ?? []).length);
    // A second reading records nothing new.
    await readGoalPlan({ goalId, now: new Date(), evaluations: 50, persist: true });
    expect(await workstreamEventsOfKind(goalId, SALE_WAITS_FOR_RESEARCH, new Date(0).toISOString(), 50)).toHaveLength(waits.length);
  }, 60_000);

  it('the rule: a proposed route waits for its dive; evidence, an agreement or a settled dive ends the wait', () => {
    const route = { externalRecordId: `route:${'wst_x'}:k`, validationSettledAt: null, validationState: null } as never;
    const hypothesis = { value: 400, provenance: 'ASSUMPTION' } as never;
    expect(researchBeforeSale({ opportunity: route, price: hypothesis, agreed: 0 } as never)).toMatch(/deep dive has not started/);
    expect(researchBeforeSale({ opportunity: { ...(route as object), validationState: 'RUNNING' }, price: hypothesis, agreed: 0 } as never)).toMatch(/under way/);
    expect(researchBeforeSale({ opportunity: { ...(route as object), validationSettledAt: '2026-11-25T05:00:00Z' }, price: hypothesis, agreed: 0 } as never)).toBeNull();
    expect(researchBeforeSale({ opportunity: route, price: { value: 400, provenance: 'EVIDENCE' }, agreed: 0 } as never)).toBeNull();
    expect(researchBeforeSale({ opportunity: route, price: hypothesis, agreed: 1 } as never)).toBeNull();
    // Not a proposed route: the ordinary sale rule applies.
    expect(researchBeforeSale({ opportunity: { externalRecordId: null, validationSettledAt: null }, price: hypothesis, agreed: 0 } as never)).toBeNull();
    const held = heldForResearch(
      [{ opportunityId: 'cop_1', title: 'A', stage: 'C_MARKET_TEST_READY' } as never, { opportunityId: 'cop_2', title: 'B', stage: 'A_THEORETICAL' } as never],
      new Map([
        ['cop_1', { opportunity: route, price: hypothesis, agreed: 0 } as never],
        ['cop_2', { opportunity: route, price: hypothesis, agreed: 0 } as never],
      ]),
    );
    expect(held.map((one) => one.opportunityId)).toEqual(['cop_1']);
  });
});

describe('a route ask no model answered is asked again soon', () => {
  it('retries after the short interval when no model answered, the ordinary one after a filing, and stops retrying past the daily bound', () => {
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const failed = (msAgo: number) => ({ createdAt: at(msAgo), detail: { outcome: 'NO_ANSWER' } });
    expect(routeAskDue([], now).due).toBe(true);
    expect(routeAskDue([failed(ROUTE_RETRY_AFTER_FAILURE_MS - 60_000)], now).due).toBe(false);
    expect(routeAskDue([failed(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000)], now).due).toBe(true);
    expect(routeAskDue([{ createdAt: at(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: { outcome: 'PROPOSED' } }], now).due).toBe(false);
    expect(routeAskDue([{ createdAt: at(ROUTE_PROPOSAL_EVERY_MS + 60_000), detail: { outcome: 'PROPOSED' } }], now).due).toBe(true);
    expect(routeAskDue([{ createdAt: at(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: { outcome: 'NO_MODEL' } }], now).due).toBe(false);
    const many = Array.from({ length: ROUTE_FAILED_ASKS_PER_DAY }, (_, i) => failed(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000 + i * 60_000));
    expect(routeAskDue(many, now).due).toBe(false);
  });

  it('a failed ask is followed by a real one half an hour later, which files the routes', async () => {
    const { deps, asked } = replying('I could not think of anything useful.', JSON.stringify({ routes: [ROUTE_A] }));
    const first = await proposeGoalRoutes({ goalId, now }, { ...deps, startDives: async () => [] });
    expect(first.kind).toBe('NO_ANSWER');
    expect((await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + 60_000) }, { ...deps, startDives: async () => [] })).kind).toBe('NOT_DUE');
    const second = await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + ROUTE_RETRY_AFTER_FAILURE_MS + 60_000) }, { ...deps, startDives: async () => [] });
    expect(second.kind).toBe('PROPOSED');
    // Two proposals and one critique of the second, which reads as no critique, so the proposal stands.
    expect(asked()).toBe(3);
    const events = await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5);
    expect(events.map((one) => one.detail['outcome'])).toEqual(['PROPOSED', 'NO_ANSWER']);
  });

  it('reads a reply fenced, as a top-level array, under another letter case, after a stray brace, or cut off mid-list', () => {
    const kept = (text: string) => parseRoutes(routesJson(text), ctx).routes.map((one) => one.title);
    const both = [ROUTE_A.title, ROUTE_B.title];
    expect(kept('```json\n' + JSON.stringify({ routes: [ROUTE_A, ROUTE_B] }) + '\n```')).toEqual(both);
    expect(kept(JSON.stringify([ROUTE_A, ROUTE_B]))).toEqual(both);
    expect(kept(`Here they are:\n${JSON.stringify([ROUTE_A, ROUTE_B])}`)).toEqual(both);
    expect(kept(JSON.stringify({ Routes: [ROUTE_A, ROUTE_B] }))).toEqual(both);
    expect(kept(`Each route fills {title} and {payer}.\n${JSON.stringify({ routes: [ROUTE_A, ROUTE_B] })}`)).toEqual(both);
    expect(kept(`1. ${JSON.stringify(ROUTE_A)}\n2. ${JSON.stringify(ROUTE_B)}`)).toEqual(both);
    const full = JSON.stringify({ routes: [ROUTE_A, ROUTE_B, ROUTE_A] });
    expect(kept(full.slice(0, full.length - 40))).toEqual(both);
    expect(routesJson('no json here')).toBeNull();
  });
});

describe('goals that find every proposal place taken', () => {
  it('wait for a place and are asked, rather than turned away', async () => {
    // Three asks against two places: the third waits and still resolves to an outcome.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const slow: ChatFn = async () => {
      await gate;
      return { content: JSON.stringify({ routes: [] }), toolCalls: [], ms: 1, completionTokens: 1, error: null };
    };
    let asked = 0;
    const counting: ChatFn = async (...args) => {
      asked += 1;
      return slow(...args);
    };
    const deps: RouteDeps = { chats: async () => [{ label: 'slow', chat: counting }], delivers: async () => [], startDives: async () => [] };
    // A second goal in a project of its own, so two asks hold both places.
    const other = await createProject({ name: `Route dives second ${projectId.slice(-6)}` });
    const owner = await createUser({ email: `route-dives-b-${other.id.slice(-6)}@example.com`, displayName: 'Owner B', password: 'a-long-enough-password', isBrainAdmin: true });
    const activated = await activate({ projectId: other.id, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
    if (!activated.ok) throw new Error('could not activate');
    const second = await createGoal({ projectId: other.id, objective: 'Collect 2000 dollars of settled cash within 30 days', actorRef: 'test', userId: owner.id, now: new Date(now.getTime() - 60_000) });
    if (!second.ok) throw new Error(second.reason);

    // Creating a goal reads its plan, which arms an ask of its own: let those finish and forget them.
    await settleRouteAsks();
    await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);

    const one = armRouteProposal(goalId, [], now, deps);
    const two = armRouteProposal(second.goal.id, [], now, deps);
    const three = armRouteProposal('wst_absent', [], now, deps);
    // Both places are taken until a model answers; the third is waiting, not refused.
    for (let i = 0; i < 400 && asked < 2; i += 1) await new Promise((done) => setTimeout(done, 25));
    expect(asked).toBe(2);
    expect(armRouteProposal('wst_absent', [], now, deps)).toBe(three);
    release();
    const outcomes = await Promise.all([one, two, three]);
    expect(outcomes[0]).toMatchObject({ kind: 'NO_ANSWER' });
    expect(outcomes[1]).toMatchObject({ kind: 'NO_ANSWER' });
    expect(outcomes[2]).toMatchObject({ kind: 'NOT_DUE', reason: 'no live goal' });
    expect((await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5)).length).toBe(1);
  });
});
