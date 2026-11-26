/**
 * A goal's routes are built from the owner's own words, critiqued, repaired or
 * replaced, and ranked — and the rank decides which route the plan pursues
 * before any of them is researched (independent judge, 2026-11-25: 3 of 67
 * routes credible across 12 fresh goals, the same digital-product menu for
 * unrelated requests, and in all 3 goals with a credible route the plan chose
 * a weaker one).
 *
 *   - the prompt leads with the owner's words, asks for their profile first,
 *     gives today's date, the feasibility rules and the spread of buyer kinds,
 *     and offers Brain's proved deliverables only after all of that;
 *   - the profile the proposer read reaches the critic's prompt;
 *   - a digital-product-only answer is dropped by the critique, replacements
 *     are asked for once naming what failed, and what is filed is ranked;
 *   - the rank reaches the opening, and the plan's choice among unresearched
 *     routes follows it;
 *   - with no readable critique the single pass stands, unranked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, researchedFindings } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { opportunitiesWithRecordPrefix } from '../server/repos/cashPortfolio.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { workstreamEventsOfKind } from '../server/repos/register.ts';
import { goalRoutePrefix, ROUTE_RANK_FIELD, routeRankOf } from '../server/domain/routeOrigin.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import {
  applyCritique,
  calendarLine,
  critiqueJson,
  ownerProfileOf,
  parseRoutes,
  proposeGoalRoutes,
  ROUTE_EVENT,
  routePrompt,
  settleRouteAsks,
  type CritiqueRecord,
  type RejectedRoute,
  type RouteContext,
  type RouteDeps,
} from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

const OBJECTIVE = 'I speak fluent Spanish, live in Columbus, Ohio, own a cargo van and have weekends free. I need $1,500 within 21 days and can put in $200.';
const OWNER = { skills: ['fluent Spanish'], assets: ['a cargo van'], location: 'Columbus, Ohio', hours: 'weekends', capital: '$200', refusals: ['not stated'] };

const base = {
  mechanism: 'PRODUCTIZED_SERVICE', industry: 'Services', monthly: false, performer: 'SUBCONTRACTOR', directCost: 40, capital: 0, ownerHoursPerDeal: 0.5, daysToFirstCash: 5,
  buyerCount: 2000, volumeBasis: 'directory listings', assumptions: 'They buy this.', searches: { price: ['p'], demand: ['d'], volume: ['v'] },
};
/** The menu the judge found everywhere: digital products that would fit any request. */
const MENU = [
  { ...base, title: 'Market research reports', buyerKind: 'B2B', payer: 'Small businesses anywhere', offer: 'A market research report', price: 300, channel: 'SEO blog', fulfiller: 'A freelance writer, $40', ownerFit: 'none in particular' },
  { ...base, title: 'Notion templates', buyerKind: 'ONLINE_CONSUMER', payer: 'Productivity enthusiasts', offer: 'A template pack', price: 30, channel: 'A new YouTube channel', fulfiller: 'A designer, $10', directCost: 10, ownerFit: 'none in particular' },
  { ...base, title: 'KPI dashboards', buyerKind: 'B2B', payer: 'Startups', offer: 'A KPI dashboard', price: 500, channel: 'Paid ads', fulfiller: 'A freelance analyst, $40', ownerFit: 'none in particular' },
  { ...base, title: 'Spanish-English menu translation', buyerKind: 'LOCAL_BUSINESS', payer: 'Columbus restaurants', offer: 'A translated menu', price: 120, channel: 'Walking in and emailing local restaurants', fulfiller: 'The owner translates remotely', performer: 'OWNER', directCost: 0, ownerHoursPerDeal: 2, ownerFit: 'Uses the owner\'s fluent Spanish and Columbus location' },
];
const LOCAL = [
  { ...base, title: 'Weekend van moves', buyerKind: 'LOCAL_CONSUMER', mechanism: 'SUBCONTRACTED_FULFILMENT', payer: 'Columbus households moving a few items', offer: 'A small move with a hired helper driving the owner\'s van', price: 150, channel: 'Local marketplace listings and neighbourhood groups', fulfiller: 'A hired local helper, $60 a job', directCost: 60, ownerHoursPerDeal: 0.5, ownerFit: 'Uses the cargo van and the Columbus location' },
  { ...base, title: 'Spanish document interpreting online', buyerKind: 'ONLINE_MARKETPLACE', mechanism: 'EXPLICIT_PAID_REQUEST', payer: 'People needing Spanish letters explained', offer: 'A written explanation of a Spanish document', price: 40, channel: 'An existing translation marketplace with open requests', fulfiller: 'The owner, remotely', performer: 'OWNER', directCost: 4, ownerHoursPerDeal: 0.5, ownerFit: 'Uses the owner\'s fluent Spanish' },
];

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return { objective: OBJECTIVE, currency: 'USD', remaining: 1500, daysLeft: 21, capitalLimit: 200, hoursLimit: null, resources: null, industry: null, recurring: false, exclusions: [], delivers: ['spreadsheet'], held: [], refuted: [], today: '2026-11-25', ...over };
}

describe('the proposal prompt is built from the owner', () => {
  it('leads with their words, asks for their profile, dates the ask and states the rules before Brain\'s deliverables', () => {
    const prompt = routePrompt(ctx());
    expect(prompt.startsWith("THE OWNER'S OWN WORDS")).toBe(true);
    expect(prompt.indexOf(OBJECTIVE)).toBeLessThan(200);
    expect(prompt).toMatch(/STEP 1 — READ THE OWNER[^\n]*skills[^\n]*assets[^\n]*location[^\n]*hours[^\n]*capital[^\n]*refusals/);
    expect(prompt).toMatch(/Today is 2026-11-25 \(late November\)/);
    expect(prompt).toMatch(/first money settles inside the window/);
    expect(prompt).toMatch(/channel produces paying buyers inside the window with the stated budget/);
    expect(prompt).toMatch(/named fulfiller with a known cost who can start now/);
    expect(prompt).toMatch(/typically pays/);
    expect(prompt).toMatch(/LOCAL_CONSUMER, LOCAL_BUSINESS, ONLINE_MARKETPLACE/);
    expect(prompt.indexOf('PROVABLY PRODUCES')).toBeGreaterThan(prompt.indexOf('STEP 2'));
    expect(prompt).toMatch(/"owner":\{"skills"/);
    expect(calendarLine('2026-03-04')).toMatch(/early March/);
  });

  it('reads the owner profile and the critique tolerantly, and holds a repair to every limit', () => {
    expect(ownerProfileOf(JSON.stringify({ owner: OWNER, routes: [] }))).toMatchObject({ skills: ['fluent Spanish'], location: 'Columbus, Ohio', refusals: [] });
    expect(ownerProfileOf(JSON.stringify({ routes: [] }))).toBeNull();
    const { routes } = parseRoutes({ routes: LOCAL }, ctx());
    expect(routes.map((one) => one.buyerKind)).toEqual(['LOCAL_CONSUMER', 'ONLINE_MARKETPLACE']);
    const critique = critiqueJson(
      '```json\n' +
        JSON.stringify({
          reviews: [
            { index: 1, verdict: 'KEEP', scores: { OWNER_FIT: 5, WINDOW: 4, CHANNEL: 4, FULFILLER: 4, PRICE: 4, CAPITAL: 5, MARKET: 4 }, why: 'uses the van locally' },
            { index: 2, verdict: 'REPAIR', scores: { OWNER_FIT: 5, PRICE: 2 }, failed: ['price'], why: 'priced above market', repair: { capital: 900 } },
          ],
          ranking: [2, 1],
        }) +
        '\n```',
      routes.length,
    )!;
    expect(critique.reviews[1]!.failed).toEqual(['PRICE']);
    const applied = applyCritique(routes, critique, ctx());
    // The repair ties up more than the owner allows, so it is dropped rather than filed.
    expect(applied.ranked.map((one) => one.route.title)).toEqual(['Weekend van moves']);
    expect(applied.dropped[0]).toMatchObject({ title: 'Spanish document interpreting online', rule: 'CRITIQUE' });
    expect(applied.dropped[0]!.why).toMatch(/repair .*broke a limit/);
  });
});

let projectId = '';
let goalId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`route-crit-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `route-crit-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: OBJECTIVE, actorRef: 'test', userId: owner.id });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
  await settleRouteAsks();
  await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
});

/** A stub answering the proposer and the critic from their own queues, recording what each was asked. */
function scripted(proposals: unknown[], critiques: unknown[]): { deps: RouteDeps; asked: { proposer: string[]; critic: string[] } } {
  const asked = { proposer: [] as string[], critic: [] as string[] };
  const chat: ChatFn = async (messages) => {
    const critic = /reviewer/.test(String((messages[0] as { content: string }).content));
    const queue = critic ? asked.critic : asked.proposer;
    queue.push(String((messages[1] as { content: string }).content));
    const answer = (critic ? critiques : proposals)[queue.length - 1];
    if (answer === undefined) return { content: '', toolCalls: [], ms: 1, completionTokens: 0, error: 'the model timed out' };
    return { content: typeof answer === 'string' ? answer : JSON.stringify(answer), toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return { asked, deps: { chats: async () => [{ label: 'stub', chat }], claims: researchedFindings, delivers: async () => [], startDives: async () => [] } };
}

const routes = () => opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
const lastEvent = async () => (await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5))[0]!;

describe('a proposal is critiqued, replaced where it fails and ranked', () => {
  it('keeps one well-founded route without asking for more to reach a count', async () => {
    const fails = (index: number, rule: string) => ({ index, verdict: 'DROP', scores: { OWNER_FIT: 0, [rule]: 1 }, failed: ['OWNER_FIT', rule], why: 'ignores the owner\'s Spanish, van and Columbus for a product that fits anyone' });
    const { deps, asked } = scripted(
      [{ owner: OWNER, routes: MENU }],
      [{ owner: OWNER, reviews: [fails(1, 'CHANNEL'), fails(2, 'CHANNEL'), fails(3, 'CAPITAL'), { index: 4, verdict: 'KEEP', scores: { OWNER_FIT: 5, WINDOW: 5, CHANNEL: 4, FULFILLER: 4, PRICE: 4, CAPITAL: 5, MARKET: 4 }, why: 'uses the Spanish locally, paid on delivery' }], ranking: [4] }],
    );
    expect(await proposeGoalRoutes({ goalId, now: new Date() }, deps)).toMatchObject({ kind: 'PROPOSED', critique: 'CRITIQUED' });
    expect(asked.proposer).toHaveLength(1);
    expect((await routes()).map((one) => one.title)).toEqual(['Spanish-English menu translation']);
    expect(((await lastEvent()).detail['critique'] as CritiqueRecord)).toMatchObject({ replacementsAsked: false, replacements: 0 });
  });

  it('drops a digital-product menu, asks once for replacements naming what failed when none survives, and files ranked routes', async () => {
    const fails = (index: number, rule: string) => ({ index, verdict: 'DROP', scores: { OWNER_FIT: 0, [rule]: 1 }, failed: ['OWNER_FIT', rule], why: 'ignores the owner\'s Spanish, van and Columbus for a product that fits anyone' });
    const { deps, asked } = scripted(
      [{ owner: OWNER, routes: MENU.slice(0, 3) }, { routes: [...LOCAL, MENU[3]] }],
      [{ owner: OWNER, reviews: [fails(1, 'CHANNEL'), fails(2, 'CHANNEL'), fails(3, 'CAPITAL')], ranking: [] }],
    );
    const outcome = await proposeGoalRoutes({ goalId, now: new Date() }, deps);
    expect(outcome).toMatchObject({ kind: 'PROPOSED', critique: 'CRITIQUED' });

    // The owner facts the proposer read reach the critic.
    expect(asked.critic[0]).toMatch(/OWNER PROFILE[^\n]*fluent Spanish[^\n]*a cargo van[^\n]*Columbus, Ohio/);
    expect(asked.critic[0]).toMatch(/1\. \{"title":"Market research reports"/);
    // One replacement ask, naming what failed.
    expect(asked.proposer).toHaveLength(2);
    expect(asked.proposer[1]).toMatch(/FAILED REVIEW[\s\S]*Market research reports: the critique dropped it \(fails OWNER_FIT, CHANNEL\)/);

    const filed = await routes();
    expect(filed.map((one) => one.title).sort()).toEqual(['Spanish document interpreting online', 'Spanish-English menu translation', 'Weekend van moves']);
    const rankOf = async (title: string) => routeRankOf((await cardFact(filed.find((one) => one.title === title)!.id, ROUTE_RANK_FIELD))?.value);
    // Replacements nobody critiqued are ranked in the order they came.
    expect(await rankOf('Weekend van moves')).toBe(1);
    expect(await rankOf('Spanish document interpreting online')).toBe(2);
    expect(await rankOf('Spanish-English menu translation')).toBe(3);
    expect((await cardFact(filed.find((one) => one.title === 'Weekend van moves')!.id, ROUTE_RANK_FIELD))!.kind).toBe('RECOMMENDATION');

    const event = await lastEvent();
    const critique = event.detail['critique'] as CritiqueRecord;
    expect(critique).toMatchObject({ outcome: 'CRITIQUED', model: 'stub', replacementsAsked: true, replacements: 3 });
    expect(critique.ranking).toEqual(['Weekend van moves', 'Spanish document interpreting online', 'Spanish-English menu translation']);
    expect(critique.reviews.map((one) => one.verdict)).toEqual(['DROP', 'DROP', 'DROP']);
    expect(event.detail['owner']).toMatchObject({ location: 'Columbus, Ohio' });
    expect((event.detail['rejected'] as RejectedRoute[]).filter((one) => one.rule === 'CRITIQUE')).toHaveLength(3);
    expect(event.summary).toMatch(/3 rejected \(3 failed the critique\), ranked by a critique/);
  });

  it('with no critic answering, the single pass stands unranked and the record says so', async () => {
    const { deps, asked } = scripted([{ owner: OWNER, routes: LOCAL }], ['I would rather not judge these.']);
    const outcome = await proposeGoalRoutes({ goalId, now: new Date() }, deps);
    expect(outcome).toMatchObject({ kind: 'PROPOSED', critique: 'FAILED' });
    expect(asked.critic).toHaveLength(1);
    const filed = await routes();
    expect(filed).toHaveLength(2);
    for (const one of filed) expect(await cardFact(one.id, ROUTE_RANK_FIELD)).toBeNull();
    const event = await lastEvent();
    expect((event.detail['critique'] as CritiqueRecord)).toMatchObject({ outcome: 'FAILED', reason: 'stub: no parseable critique' });
    expect(event.summary).toMatch(/no critique \(stub: no parseable critique\)/);

    // A critic that errors degrades the same way.
    await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
    const erring = scripted([{ routes: [{ ...LOCAL[0]!, title: 'Other', payer: 'Other buyers', offer: 'Other offer' }] }], []);
    expect(await proposeGoalRoutes({ goalId, now: new Date() }, erring.deps)).toMatchObject({ kind: 'PROPOSED', critique: 'FAILED' });
    expect(((await lastEvent()).detail['critique'] as CritiqueRecord).reason).toMatch(/timed out/);
  });
});

/*
 * Each case reads a whole goal plan (readGoalPlan, 50 evaluations). On the
 * release runners it measured 26.0 s and 29.5 s (Deploys 45788180566 and
 * 45774248643) and 31.8 s on 45796709343, which failed only on the suite's
 * 30 s default, while it takes 10-14 s locally. The bound is the work's, not a
 * loosened assertion.
 */
describe("the plan's choice among unresearched routes follows the critique's rank", { timeout: 90_000 }, () => {
  const retainer = (i: number) => ({
    ...base, title: `Route ${i} retainer`, buyerKind: 'B2B', payer: `Buyer segment ${'abc'[i]}`, offer: `Monthly service ${i}`, price: 900, monthly: true, channel: 'Direct email to published contacts',
    fulfiller: 'A freelancer, $100 a month', directCost: 100, ownerHoursPerDeal: 0.5, daysToFirstCash: 7, ownerFit: 'Uses the owner\'s Spanish',
  });
  const review = (index: number) => ({ index, verdict: 'KEEP', scores: { OWNER_FIT: 4, WINDOW: 4, CHANNEL: 4, FULFILLER: 4, PRICE: 4, CAPITAL: 4, MARKET: 4 }, why: `route ${index}` });

  async function chosenTitles(ranking: number[]): Promise<string[]> {
    const { deps } = scripted([{ owner: OWNER, routes: [retainer(0), retainer(1), retainer(2)] }], [{ reviews: [review(1), review(2), review(3)], ranking }]);
    const outcome = await proposeGoalRoutes({ goalId, now: new Date() }, deps);
    if (outcome.kind !== 'PROPOSED' || outcome.filed.length !== 3) throw new Error(`routes not filed: ${JSON.stringify(outcome)}`);
    await getDb().run("UPDATE cash_opportunities SET validation_state = 'PENDING' WHERE project_id = ?", [projectId]);
    const reading = (await readGoalPlan({ goalId, now: new Date(), evaluations: 50 }))!;
    const chosen = reading.strategies.find((one) => one.key === reading.chosen)!;
    const held = await routes();
    return chosen.opportunityIds.map((id) => held.find((one) => one.id === id)!.title);
  }

  it('pursues the best-ranked route first, wherever the proposal listed it', async () => {
    expect(await chosenTitles([3, 1, 2])).toEqual(['Route 2 retainer']);
  });

  it('and another route when the critique ranks that one best', async () => {
    expect(await chosenTitles([2, 3, 1])).toEqual(['Route 1 retainer']);
  });
});
