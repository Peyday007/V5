/**
 * Brain's routes are reasoned from research, not guessed and then researched
 * (owner, 2026-11-25: "Brain proposes complete business routes with guessed
 * prices, demand, buyer counts and costs, critiques those guesses, and only
 * afterward tries to research whether they are true"). The loop:
 *
 *   - with nothing researched, Brain names DIRECTIONS — buyer problem, offer,
 *     comparable spending expected, reach, fulfilment, and the one unknown that
 *     would kill each — and files none of them with a price, count or cost;
 *   - each direction's dive asks its decisive unknown first, so a dead one costs
 *     one short question;
 *   - once findings are back, the next ask is due at once, the proposer and its
 *     critic are shown them, every figure says which finding it rests on, and a
 *     cited claim is filed as the route's EVIDENCE through the research writer;
 *   - demand shown for comparable offers is filed apart from demand for the
 *     exact offer, and the plan's CURRENT_DEMAND link says which it rests on;
 *   - no count of buyer kinds or routes is forced, and a contradicted direction
 *     is rethought rather than restated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { opportunitiesWithRecordPrefix } from '../server/repos/cashPortfolio.ts';
import { cardFact, recordRecommendationFact } from '../server/repos/cashCardFacts.ts';
import { DISQUALIFIED_FIELD } from '../server/services/cash/engineCard.ts';
import { workstreamEventsOfKind } from '../server/repos/register.ts';
import {
  COMPARABLE_DEMAND_FIELD,
  DECISIVE_UNKNOWN_FIELD,
  goalRoutePrefix,
  ROUTE_GROUNDS_FIELD,
  ROUTE_STAGE_FIELD,
  SUPERSEDED_PREFIX,
} from '../server/domain/routeOrigin.ts';
import { routeValidationQuestion } from '../server/services/cash/validation.ts';
import { currentDemandCheck } from '../server/services/goals/plan.ts';
import {
  directionPrompt,
  findingsOf,
  groundsOf,
  NEW_FINDINGS_FOR_REASK,
  parseDirections,
  parseRoutes,
  proposeGoalRoutes,
  ROUTE_EVENT,
  ROUTE_RETRY_AFTER_FAILURE_MS,
  routeAskDue,
  routePrompt,
  settleRouteAsks,
  type RouteContext,
  type RouteDeps,
} from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';
import type { CashCardFact, CashOpportunity, ResearchClaim } from '../server/domain/types.ts';

const OBJECTIVE = 'I run two embroidery machines at home in Tucson. I want $2,000 in the next 40 days, can put in $300 and about 12 hours a week.';

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return { objective: OBJECTIVE, currency: 'USD', remaining: 2000, daysLeft: 40, capitalLimit: 300, hoursLimit: null, hoursPerWeek: 12, resources: null, industry: null, recurring: false, exclusions: [], delivers: [], held: [], refuted: [], today: '2026-11-25', ...over };
}

let seq = 0;
function claim(text: string, over: Partial<ResearchClaim> = {}): ResearchClaim {
  seq += 1;
  return { id: `clm_test_${seq}`, claim: text, sourceUrl: `https://example.org/source-${seq}`, sourceTitle: null, sourcePublisher: `Publisher ${seq}`, sourceDate: '2026-11-10', evidenceLane: 'price_evidence', retrievedAt: '2026-11-20T00:00:00Z', ...over } as unknown as ResearchClaim;
}

const direction = {
  title: 'Embroidered staff uniforms for local cafés',
  buyerKind: 'LOCAL_BUSINESS',
  mechanism: 'PRODUCTIZED_SERVICE',
  industry: 'Apparel',
  payer: 'Independent cafés and restaurants in Tucson',
  problem: 'need branded staff shirts and aprons in small runs that big print shops will not take',
  offer: 'Logo-embroidered aprons and polos in runs of 10–30',
  comparableSpend: 'small runs of embroidered aprons, about $15–25 each',
  channel: 'Walking in and emailing owners from the city business directory',
  performer: 'OWNER',
  fulfiller: 'The owner on their two machines',
  decisiveUnknown: 'whether Tucson cafés buy small embroidered runs locally rather than online',
  ownerFit: 'uses the two embroidery machines and the Tucson location',
  assumptions: 'Blanks can be bought wholesale.',
  searches: { price: ['custom embroidered aprons small order price'], demand: ['Tucson cafe branded aprons'], volume: ['Tucson cafes count'] },
};

describe('scouting: directions before anything is priced', () => {
  it('asks for directions with a decisive unknown and no figure stated as known', () => {
    const prompt = directionPrompt(ctx());
    expect(prompt.startsWith("THE OWNER'S OWN WORDS")).toBe(true);
    expect(prompt).toMatch(/do not price anything/);
    expect(prompt).toMatch(/single unknown most likely to rule it out/);
    expect(prompt).toMatch(/no spread of buyer kinds or business models is required/);
    expect(prompt).not.toMatch(/"price":number/);
    expect(prompt).toMatch(/"decisiveUnknown"/);
    // A stated licence, certification or trade is sold directly by at least one direction and one route.
    expect(prompt).toMatch(/licence, certification or trade, at least one direction sells that licensed or trade work itself/);
    expect(routePrompt(ctx())).toMatch(/licence, certification or trade, at least one route sells that licensed or trade work itself/);
  });

  it('keeps a whole direction and refuses one without a decisive unknown', () => {
    const { directions, rejected } = parseDirections(JSON.stringify({ directions: [direction, { ...direction, title: 'Vague', payer: 'Anyone', decisiveUnknown: '' }] }), ctx({ ownerLabour: { offered: true, evidence: 'I run two embroidery machines' } as never }));
    expect(directions.map((one) => one.title)).toEqual(['Embroidered staff uniforms for local cafés']);
    expect(directions[0]!.decisiveUnknown).toMatch(/Tucson cafés/);
    expect(rejected[0]).toMatchObject({ title: 'Vague', rule: 'INCOMPLETE' });
  });

  it("a scouted direction's dive asks its decisive unknown first, then comparable spending and demand", () => {
    const facts: Record<string, string> = { [ROUTE_STAGE_FIELD]: 'SCOUT', [DECISIVE_UNKNOWN_FIELD]: direction.decisiveUnknown, buyerProblem: direction.problem, comparableSpend: direction.comparableSpend };
    const fact = (field: string) => (facts[field] ? ({ field, value: facts[field], kind: 'RECOMMENDATION' } as CashCardFact) : null);
    const q = routeValidationQuestion({ title: direction.title, offerScope: direction.offer, payer: direction.payer, reachableChannel: direction.channel, fulfillmentOwner: 'The owner, personally' } as CashOpportunity, fact);
    expect(q).toMatch(/before pricing anything/);
    expect(q.indexOf('Check first')).toBeLessThan(q.indexOf('price_evidence'));
    expect(q).toMatch(/Tucson cafés buy small embroidered runs locally/);
    expect(q).toMatch(/comparable_demand/);
    expect(q).toMatch(/which is not evidence/);
  });
});

describe('routes from findings', () => {
  const findings = findingsOf([
    claim('Custom embroidered aprons cost $18–$24 each for orders of 12 from online embroidery shops.', { evidenceLane: 'price_evidence' }),
    claim('Tucson has 640 licensed restaurants and cafés listed in the city food-establishment register.', { evidenceLane: 'buyer_volume' }),
    claim('A Tucson coffee chain posted in October 2026 that it is refreshing staff uniforms for its new locations.', { evidenceLane: 'current_demand', sourceDate: '2026-10-28' }),
    claim('Custom embroidered aprons cost $18–$24 each for orders of 12 from online embroidery shops.'),
    claim('too short'),
    claim('A sourceless claim that nobody read should never be a finding at all.', { sourceUrl: null }),
  ]);

  it('lists each read finding once, with a ref', () => {
    expect(findings.map((one) => one.ref)).toEqual(['F1', 'F2', 'F3']);
    expect(findings[1]!.lane).toBe('buyer_volume');
  });

  it('shows the findings to the proposer, asks for citations and forces no spread', () => {
    const prompt = routePrompt(ctx({ findings }));
    expect(prompt).toMatch(/FINDINGS — what research has established[\s\S]*F2 \[buyer_volume\] Tucson has 640/);
    expect(prompt).toMatch(/BUILD FROM THE FINDINGS/);
    expect(prompt).toMatch(/demandScope COMPARABLE/);
    expect(prompt).toMatch(/"grounds":\{"channel":"F#"\|null,"price":"F#"\|null/);
    expect(prompt).toMatch(/Propose up to 6/);
    expect(prompt).not.toMatch(/at least three/);
    expect(prompt).toMatch(/"rethink"/);
  });

  it('keeps only cited refs the prompt showed, and reads demand as comparable unless the reply says exact', () => {
    const grounds = groundsOf({ price: 'F1', volume: 'F2', demand: 'F3', cost: 'F9', channel: 'none' }, findings);
    expect(grounds.claims).toEqual({ price: findings[0]!.claimId, volume: findings[1]!.claimId, demand: findings[2]!.claimId });
    expect(grounds.demandScope).toBe('COMPARABLE');
    expect(groundsOf({ demand: 'F3', demandScope: 'EXACT' }, findings).demandScope).toBe('EXACT');
    expect(groundsOf(null, findings)).toEqual({ claims: {}, demandScope: null });
  });

  it('no longer rejects two routes to the same kind of buyer', () => {
    const route = (offer: string) => ({ ...direction, offer, title: offer, price: 300, directCost: 120, capital: 100, ownerHoursPerDeal: 2, daysToFirstCash: 10, buyerCount: 640, volumeBasis: 'register', grounds: {} });
    const { routes } = parseRoutes({ routes: [route('Aprons'), route('Polos')] }, ctx({ ownerLabour: { offered: true, evidence: 'I run two embroidery machines' } as never }));
    expect(routes.map((one) => one.title)).toEqual(['Aprons', 'Polos']);
  });

  it('makes the next ask due as soon as research comes back', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const asked = [{ createdAt: new Date(now.getTime() - ROUTE_RETRY_AFTER_FAILURE_MS - 1000).toISOString(), detail: { outcome: 'PROPOSED', filed: ['x'], findingsSeen: 2 } }];
    expect(routeAskDue(asked, now, { findings: 2 }).due).toBe(false);
    expect(routeAskDue(asked, now, { findings: 2 + NEW_FINDINGS_FOR_REASK })).toEqual({ due: true, onFindings: true });
    const tooSoon = [{ ...asked[0]!, createdAt: new Date(now.getTime() - 60_000).toISOString() }];
    expect(routeAskDue(tooSoon, now, { findings: 50 }).due).toBe(false);
  });
});

describe('comparable demand is not verified demand', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const opening = (over: Partial<CashOpportunity> = {}) => ({ buyingSignal: null, signalObservedAt: null, ...over }) as CashOpportunity;
  it('a fresh buying signal is VERIFIED; a fresh comparable sign establishes the link as COMPARABLE and says so; a stale one does not', () => {
    expect(currentDemandCheck({ opportunity: opening({ buyingSignal: 'posted RFQ', signalObservedAt: '2026-11-20' }), comparableDemand: null }, true, now)).toMatchObject({ ok: true, basis: expect.stringMatching(/^VERIFIED/) });
    const comparable = currentDemandCheck({ opportunity: opening(), comparableDemand: { text: 'cafés refreshing uniforms', observedAt: '2026-10-28' } }, false, now);
    expect(comparable.ok).toBe(true);
    expect(comparable.basis).toMatch(/^COMPARABLE[\s\S]*demand for this exact offer is not verified/);
    expect(currentDemandCheck({ opportunity: opening(), comparableDemand: { text: 'old', observedAt: '2024-01-01' } }, false, now)).toMatchObject({ ok: false });
    expect(currentDemandCheck({ opportunity: opening(), comparableDemand: null }, false, now)).toMatchObject({ ok: false, basis: 'no buying signal recorded' });
  });
});

let projectId = '';
let goalId = '';
beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`rir-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `rir-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: OBJECTIVE, actorRef: 'test', userId: owner.id });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
  await settleRouteAsks();
  await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
});

function scripted(answers: unknown[], critiques: unknown[], claims: () => ResearchClaim[], written: { field: string; claimId: string }[]): { deps: RouteDeps; asked: string[]; critic: string[] } {
  const asked: string[] = [];
  const critic: string[] = [];
  const chat: ChatFn = async (messages) => {
    const isCritic = /reviewer/.test(String((messages[0] as { content: string }).content));
    const queue = isCritic ? critic : asked;
    queue.push(String((messages[1] as { content: string }).content));
    const answer = (isCritic ? critiques : answers)[queue.length - 1];
    if (answer === undefined) return { content: '', toolCalls: [], ms: 1, completionTokens: 0, error: 'the model timed out' };
    return { content: JSON.stringify(answer), toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return {
    asked,
    critic,
    deps: {
      chats: async () => [{ label: 'stub', chat }],
      delivers: async () => [],
      startDives: async () => [],
      claims: async () => claims(),
      writeEvidence: async (input) => {
        written.push({ field: input.field, claimId: input.claim.id });
        return true;
      },
    },
  };
}

describe('the loop on a goal', () => {
  it('scouts first, waits for research, then proposes grounded routes, files their evidence and retires the scouts', async () => {
    let held: ResearchClaim[] = [];
    const written: { field: string; claimId: string }[] = [];
    const priced = {
      ...direction, title: 'Café apron runs', price: 260, directCost: 110, capital: 120, ownerHoursPerDeal: 2, daysToFirstCash: 9, buyerCount: 640, volumeBasis: 'city register',
      grounds: { price: 'F1', volume: 'F2', demand: 'F3', demandScope: 'COMPARABLE' },
    };
    const { deps, asked, critic } = scripted(
      [{ owner: { skills: ['embroidery'], assets: ['two embroidery machines'], location: 'Tucson' }, directions: [direction] }, { rethink: null, routes: [priced] }],
      [{ reviews: [{ index: 1, verdict: 'KEEP', scores: { OWNER_FIT: 5, WINDOW: 4, CHANNEL: 4, FULFILLER: 5, PRICE: 4, CAPITAL: 5, MARKET: 4, EVIDENCE: 5 }, why: 'priced from F1, sized from F2' }], ranking: [1] }],
      () => held,
      written,
    );
    // Nothing researched: a direction, no price.
    const t0 = new Date();
    expect(await proposeGoalRoutes({ goalId, now: t0 }, deps)).toMatchObject({ kind: 'PROPOSED', critique: 'SKIPPED' });
    let openings = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
    expect(openings).toHaveLength(1);
    expect(openings[0]!.priceCents).toBeNull();
    expect((await cardFact(openings[0]!.id, ROUTE_STAGE_FIELD))?.value).toBe('SCOUT');
    expect(asked[0]).toMatch(/DIRECTIONS TO CHECK/);
    let event = (await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5))[0]!;
    expect(event.detail).toMatchObject({ stage: 'SCOUT', findingsSeen: 0 });

    // While the direction is researched, no second guess.
    const t1 = new Date(t0.getTime() + ROUTE_RETRY_AFTER_FAILURE_MS + 60_000);
    expect(await proposeGoalRoutes({ goalId, now: t1 }, deps)).toMatchObject({ kind: 'NOT_DUE' });

    // Research comes back: the ask is due at once, and reasons from the findings.
    held = [
      claim('Custom embroidered aprons cost $18–$24 each for orders of 12 from online embroidery shops.'),
      claim('Tucson has 640 licensed restaurants and cafés listed in the city food-establishment register.', { evidenceLane: 'buyer_volume' }),
      claim('A Tucson coffee chain posted in October 2026 that it is refreshing staff uniforms for its new locations.', { evidenceLane: 'comparable_demand', sourceDate: '2026-10-28' }),
    ];
    expect(await proposeGoalRoutes({ goalId, now: t1 }, deps)).toMatchObject({ kind: 'PROPOSED', critique: 'CRITIQUED' });
    expect(asked[1]).toMatch(/FINDINGS — what research has established/);
    expect(asked[1]).toMatch(/DIRECTIONS ALREADY SCOUTED[\s\S]*Embroidered staff uniforms for local cafés/);
    expect(critic[0]).toMatch(/FINDINGS research holds for this goal/);
    expect(critic[0]).toMatch(/cites price: F1, volume: F2, demand: F3 \(demand COMPARABLE\)/);

    openings = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
    const route = openings.find((one) => one.title === 'Café apron runs')!;
    if (!route) throw new Error(JSON.stringify((await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5))[0]));
    expect((await cardFact(route.id, ROUTE_STAGE_FIELD))?.value).toBe('ROUTE');
    // Each cited claim reaches the research writer as the route's evidence; comparable demand in its own field.
    expect(written).toEqual([
      { field: 'price', claimId: held[0]!.id },
      { field: 'buyerVolume', claimId: held[1]!.id },
      { field: COMPARABLE_DEMAND_FIELD, claimId: held[2]!.id },
    ]);
    expect((await cardFact(route.id, ROUTE_GROUNDS_FIELD))?.value).toMatch(/Filed as evidence: price, buyerVolume, comparableDemand/);
    // The scouted direction steps aside, as superseded, not refuted.
    const scout = openings.find((one) => one.title === direction.title)!;
    expect(scout.state).toBe('ARCHIVED');
    expect(scout.archivedReason!.startsWith(SUPERSEDED_PREFIX)).toBe(true);
    event = (await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5))[0]!;
    expect(event.detail).toMatchObject({ stage: 'ROUTE', grounded: 1, superseded: 1, findingsSeen: 3 });
    expect(event.summary).toMatch(/1 proposed from 3 research finding\(s\)[\s\S]*1 citing findings[\s\S]*1 scouted direction\(s\) superseded/);
  });

  it('a direction research ruled out is shown with its evidence, and the next scouting rethinks rather than restates', async () => {
    const written: { field: string; claimId: string }[] = [];
    const { deps, asked } = scripted([{ directions: [direction] }, { directions: [{ ...direction, title: 'Embroidered patches for Tucson youth sports teams', payer: 'Youth sports clubs in Tucson', offer: 'Embroidered team patches' }] }], [], () => [], written);
    const t0 = new Date();
    await proposeGoalRoutes({ goalId, now: t0 }, deps);
    const [scout] = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
    await recordRecommendationFact({ projectId, opportunityId: scout!.id, field: DISQUALIFIED_FIELD, value: 'Tucson cafés order uniforms from national online suppliers; local runs are not bought.', basis: 'test', assumptions: '', uncertainty: '' });
    const later = new Date(t0.getTime() + 7 * 60 * 60_000);
    expect(await proposeGoalRoutes({ goalId, now: later }, deps)).toMatchObject({ kind: 'PROPOSED' });
    expect(asked[1]).toMatch(/DIRECTIONS TO CHECK/);
    expect(asked[1]).toMatch(/RULED OUT: Tucson cafés order uniforms from national online suppliers/);
  });
});
