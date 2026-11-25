/**
 * A goal's route limits are compared in the units the goal states them in, a
 * rejection says which rule it broke, and a goal left without routes is asked
 * again on any plan pass (production, 2026-11-25).
 *
 *   - "$5k a month … within 90 days … $500 … 10 hours a week": coding routes
 *     inside those limits are filed; a monthly route's hours are a monthly load
 *     against the owner's weekly time, never a share of the window's total;
 *   - a reply that writes `"monthly": "true"` or a price as "$300/month" is
 *     read as it means, never rejected for its spelling;
 *   - every rejected route keeps its rule in the event's detail, and the
 *     summary counts them by rule;
 *   - an ask whose every route was rejected is retried like one no model
 *     answered, and the plan pass arms that retry itself — with no reading
 *     held, no read in the pass and no search widened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { opportunitiesWithRecordPrefix } from '../server/repos/cashPortfolio.ts';
import { recordWorkstreamEvent, workstreamEventsOfKind } from '../server/repos/register.ts';
import { goalRoutePrefix } from '../server/domain/routeOrigin.ts';
import { advanceGoalPlans, forgetGoalReadings } from '../server/services/goals/plan.ts';
import {
  askYieldedNothing,
  parseRoutes,
  proposeGoalRoutes,
  ROUTE_EVENT,
  ROUTE_PROPOSAL_EVERY_MS,
  ROUTE_RETRY_AFTER_FAILURE_MS,
  routeAskDue,
  routeHours,
  settleRouteAsks,
  type RejectedRoute,
  type RouteContext,
  type RouteDeps,
} from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

const OBJECTIVE = "I write code (mostly JavaScript/React, some Python). I'd like $5k a month coming in on a recurring basis within 90 days. I have about $500 and can give it 10 hours a week.";

let projectId = '';
let goalId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`route-rej-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `route-rej-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: OBJECTIVE, actorRef: 'test', userId: owner.id });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
  // Creating a goal reads its plan, which may arm an ask of its own: let it finish and forget it.
  await settleRouteAsks();
  await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
  forgetGoalReadings();
});

const base = {
  mechanism: 'PRODUCTIZED_SERVICE', industry: 'Software', channel: 'Cold email to published contacts', capital: 0, daysToFirstCash: 14, buyerCount: 20000,
  volumeBasis: 'directory counts', assumptions: 'They pay monthly for this.', ownerFit: "Uses the owner's React and Python skills.",
  searches: { price: ['react maintenance retainer price'], demand: ['hiring react maintenance contractor'], volume: ['number of small saas companies'] },
};
const CODING_ROUTES = [
  { ...base, title: 'React maintenance retainer', payer: 'Small SaaS companies on React', offer: 'Monthly React bug fixes and upgrades', price: 1500, monthly: true, performer: 'OWNER', fulfiller: 'The owner', directCost: 0, ownerHoursPerDeal: 8 },
  { ...base, title: 'Python reporting automation', payer: 'Accounting firms', offer: 'Maintained Python reporting scripts', price: 800, monthly: true, performer: 'SUBCONTRACTOR', fulfiller: 'A freelance Python developer', directCost: 300, ownerHoursPerDeal: 1 },
  // Spelled loosely: a string flag and a price written per month.
  { ...base, title: 'WordPress care plan', payer: 'Local restaurants with WordPress sites', offer: 'Monthly site updates and backups', price: '$300/month', monthly: 'true', performer: 'SUBCONTRACTOR', fulfiller: 'A freelance WordPress developer', directCost: 60, ownerHoursPerDeal: 0.25 },
  // 3 buyers × 40 hours = 120 hours a month against about 43: over the owner's weekly time.
  { ...base, title: 'On-call developer for agencies', payer: 'Marketing agencies', offer: 'Overflow front-end development', price: 2000, monthly: true, performer: 'OWNER', fulfiller: 'The owner', directCost: 0, ownerHoursPerDeal: 40 },
  { ...base, title: 'One-off landing page builds', payer: 'Startup founders', offer: 'A landing page build', price: 3000, monthly: false, performer: 'OWNER', fulfiller: 'The owner', directCost: 0, ownerHoursPerDeal: 10 },
  { ...base, title: 'Paid-ads managed app', payer: 'E-commerce stores', offer: 'A managed ads dashboard', price: 900, monthly: true, performer: 'SUBCONTRACTOR', fulfiller: 'A freelance developer', directCost: 100, capital: 2000, ownerHoursPerDeal: 1 },
];

function stub(answer: unknown): { deps: RouteDeps; prompts: string[] } {
  const prompts: string[] = [];
  const chat: ChatFn = async (messages) => {
    // The proposals only: the critique's ask is a second turn, and this answer is no critique, so the proposal stands.
    if (/strategist/.test(String((messages[0] as { content: string }).content))) prompts.push(String((messages[1] as { content: string }).content));
    return { content: JSON.stringify(answer), toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return { prompts, deps: { chats: async () => [{ label: 'stub', chat }], delivers: async () => [], startDives: async () => [] } };
}

describe("a recurring goal's routes are held to its limits in the goal's own units", () => {
  it('files the coding routes inside "$5k a month, $500, 10 hours a week" and records each rejection with its rule', async () => {
    const { deps, prompts } = stub({ routes: CODING_ROUTES });
    const outcome = await proposeGoalRoutes({ goalId, now: new Date() }, deps);
    expect(outcome.kind).toBe('PROPOSED');
    if (outcome.kind !== 'PROPOSED') return;
    expect(outcome.rejected.map((one) => [one.title, one.rule])).toEqual([
      ['On-call developer for agencies', 'HOURS'],
      ['One-off landing page builds', 'NOT_MONTHLY'],
      ['Paid-ads managed app', 'CAPITAL'],
    ]);
    expect(outcome.filed).toHaveLength(3);
    const filed = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
    expect(filed.map((one) => one.title).sort()).toEqual(['Python reporting automation', 'React maintenance retainer', 'WordPress care plan']);
    expect(filed.find((one) => one.title === 'WordPress care plan')!.priceCents).toBe(30_000);
    expect(outcome.rejected[0]!.why).toMatch(/120 owner hour\(s\) a month for the 3 buyer\(s\).*43 allowed a month/);

    // The prompt states the owner's time as the goal does, and what a monthly route's hours mean.
    expect(prompts[0]).toMatch(/at most 10 hour\(s\) a week/);
    expect(prompts[0]).toMatch(/per buyer per month/);

    const [event] = await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5);
    expect(event!.summary).toMatch(/3 proposed .*3 rejected \(1 over the owner hours, 1 not billed monthly, 1 over the capital limit\)/);
    const rejected = event!.detail['rejected'] as RejectedRoute[];
    expect(rejected.map((one) => one.rule)).toEqual(['HOURS', 'NOT_MONTHLY', 'CAPITAL']);
    expect(rejected.every((one) => one.why.length > 0)).toBe(true);
    expect(event!.detail['rejectedByRule']).toEqual({ HOURS: 1, NOT_MONTHLY: 1, CAPITAL: 1 });
  });

  it('compares a monthly route with monthly time and a one-off sale with the window total', () => {
    const ctx: RouteContext = { objective: 'x', currency: 'USD', remaining: 5000, daysLeft: 90, capitalLimit: 500, hoursLimit: 129, hoursPerWeek: 10, resources: null, industry: null, recurring: true, exclusions: [], delivers: [], held: [], refuted: [] };
    // 4 retainers × 8 h = 32 h a month, inside about 43.
    expect(routeHours({ price: 1500, directCost: 0, ownerHoursPerDeal: 8, monthly: true }, ctx)).toMatchObject({ needed: 32, unit: 'a month', deals: 4 });
    expect(routeHours({ price: 1500, directCost: 0, ownerHoursPerDeal: 8, monthly: true }, ctx)!.allowed).toBeCloseTo(43.3, 1);
    // A one-off sale's hours add up over the window, against its total.
    expect(routeHours({ price: 1000, directCost: 0, ownerHoursPerDeal: 20, monthly: false }, ctx)).toMatchObject({ needed: 100, allowed: 129, unit: 'in the window' });
    // No weekly figure: the window's total spread over its months.
    expect(routeHours({ price: 1500, directCost: 0, ownerHoursPerDeal: 8, monthly: true }, { ...ctx, hoursPerWeek: null })!.allowed).toBeCloseTo(129 / (90 / (365 / 12)), 5);
    expect(routeHours({ price: 1500, directCost: 0, ownerHoursPerDeal: 8, monthly: true }, { ...ctx, hoursPerWeek: null, hoursLimit: null })).toBeNull();
    const { routes, rejected } = parseRoutes({ routes: CODING_ROUTES }, ctx);
    expect(routes).toHaveLength(3);
    expect(rejected.map((one) => one.rule)).toEqual(['HOURS', 'NOT_MONTHLY', 'CAPITAL']);
  });
});

describe('a goal left without routes is asked again within half an hour on any plan pass', () => {
  const at = (now: Date, msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  it('an ask whose every route was rejected is retried like a failed one; the pass retries only those', () => {
    const now = new Date();
    const empty = { outcome: 'PROPOSED', filed: [], existing: [], rejected: [{ title: 'x', why: 'y', rule: 'HOURS' }] };
    expect(askYieldedNothing(empty)).toBe(true);
    expect(askYieldedNothing({ outcome: 'PROPOSED', filed: [], existing: ['held'] })).toBe(false);
    expect(askYieldedNothing({ outcome: 'PROPOSED', filed: ['cop_1'] })).toBe(false);
    expect(routeAskDue([{ createdAt: at(now, ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: empty }], now).due).toBe(true);
    expect(routeAskDue([{ createdAt: at(now, ROUTE_RETRY_AFTER_FAILURE_MS - 60_000), detail: empty }], now).due).toBe(false);
    // The pass's retry-only check: a goal never asked, or whose last ask yielded nothing.
    expect(routeAskDue([], now, { retryOnly: true }).due).toBe(true);
    expect(routeAskDue([{ createdAt: at(now, ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: { outcome: 'NO_ANSWER' } }], now, { retryOnly: true }).due).toBe(true);
    expect(routeAskDue([{ createdAt: at(now, ROUTE_PROPOSAL_EVERY_MS + 60_000), detail: { outcome: 'PROPOSED', filed: ['cop_1'] } }], now, { retryOnly: true }).due).toBe(false);
    expect(routeAskDue([{ createdAt: at(now, ROUTE_PROPOSAL_EVERY_MS + 60_000), detail: { outcome: 'NO_MODEL' } }], now, { retryOnly: true }).due).toBe(false);
  });

  it('the plan pass arms the retry with no reading held and no read taken, and not before its time', async () => {
    await recordWorkstreamEvent({ workstreamId: goalId, kind: ROUTE_EVENT, summary: 'Routes: none proposed — no model answered (timeout).', detail: { outcome: 'NO_ANSWER', reason: 'timeout' }, actorRef: 'BRAIN' });
    const asks = () => workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 10);
    const t0 = Date.now();

    // Inside the half hour: nothing is asked.
    await advanceGoalPlans(new Date(t0 + ROUTE_RETRY_AFTER_FAILURE_MS - 5 * 60_000), { maxReads: 0 });
    await settleRouteAsks();
    expect(await asks()).toHaveLength(1);

    // Past it, on a pass that reads no plan and widens nothing (as after a restart, or under a read cap), the goal is asked.
    // No operator model is configured in tests, so the ask's outcome is NO_MODEL — and it is on the record.
    await advanceGoalPlans(new Date(t0 + ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), { maxReads: 0 });
    await settleRouteAsks();
    const after = await asks();
    expect(after).toHaveLength(2);
    expect(after[0]!.detail['outcome']).toBe('NO_MODEL');

    // A NO_MODEL ask is configuration, not a failed answer: the pass does not retry it.
    await advanceGoalPlans(new Date(t0 + 2 * ROUTE_RETRY_AFTER_FAILURE_MS + 2 * 60_000), { maxReads: 0 });
    await settleRouteAsks();
    expect(await asks()).toHaveLength(2);
  });

  it('a goal that already holds live routes is left to the search pass', async () => {
    await proposeGoalRoutes({ goalId, now: new Date() }, stub({ routes: CODING_ROUTES.slice(0, 1) }).deps);
    // Even with a failed ask last on the record, the pass leaves the goal alone while its routes are live.
    await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
    await recordWorkstreamEvent({ workstreamId: goalId, kind: ROUTE_EVENT, summary: 'Routes: none proposed — no model answered.', detail: { outcome: 'NO_ANSWER', reason: 'timeout' }, actorRef: 'BRAIN' });
    const outcome = await proposeGoalRoutes({ goalId, now: new Date(Date.now() + ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), retryOnly: true }, stub({ routes: CODING_ROUTES }).deps);
    expect(outcome).toMatchObject({ kind: 'NOT_DUE', reason: expect.stringMatching(/already holds live routes/) });
  });
});
