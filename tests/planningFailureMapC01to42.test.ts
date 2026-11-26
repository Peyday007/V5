/**
 * Sensitivity proofs for the planning failure map's capabilities C01–C42
 * (docs/planning-failure-map/map.json): each case is one diagnostic the map
 * held UNPROVEN, written so that reintroducing the failure the diagnostic
 * names makes it fail. The title carries the diagnostic's id. Every case runs
 * on the pure route-proposal path — objective and owner reading, the route and
 * critic prompts, the parser's limits, the critique's application, the
 * findings the proposer is shown and the re-ask schedule — with production-
 * shaped owner words and routes.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCritique,
  applyDirectionCritique,
  askModel,
  critiqueJson,
  critiquePrompt,
  directionPrompt,
  economicsLine,
  findingsOf,
  FINDINGS_SHOWN,
  groundsOf,
  ownerProfileOf,
  parseDirections,
  parseRoutes,
  replacementPrompt,
  rethinkOf,
  routeAskDue,
  routeEconomics,
  routePrompt,
  routesJson,
  ROUTE_FAILED_ASKS_PER_DAY,
  ROUTE_PROPOSAL_EVERY_MS,
  ROUTE_RETRY_AFTER_FAILURE_MS,
  strongRouteModels,
  type ProposedRoute,
  type RouteContext,
  type RouteCritique,
  type RouteFinding,
} from '../server/services/goals/routeProposal.ts';
import { ownerLabourOffer } from '../server/domain/operatingModel.ts';
import { discoveryFocusFor, REMOTE_AI_FOCUS } from '../server/services/cash/discovery.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';
import type { ResearchClaim } from '../server/domain/types.ts';

const OBJECTIVE = 'I speak fluent Spanish, live in Columbus, Ohio, own a cargo van and have weekends free. I need $1,500 within 21 days and can put in $200.';
const OWNER = { skills: ['fluent Spanish'], assets: ['a cargo van'], location: 'Columbus, Ohio', hours: 'weekends', capital: '$200', refusals: [] };

const ctxOf = (over: Partial<RouteContext> = {}): RouteContext => ({
  objective: 'I want a business that does $20,000 in the next 90 days. I have $5,000 and no hours.',
  currency: 'USD',
  remaining: 20000,
  daysLeft: 90,
  capitalLimit: 5000,
  hoursLimit: null,
  resources: null,
  industry: null,
  recurring: false,
  exclusions: [],
  delivers: [],
  held: [],
  refuted: [],
  today: '2026-11-26',
  ...over,
});
const raw = (over: Record<string, unknown> = {}) => ({
  title: 'Retainer ad management for small firms', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'Marketing', payer: 'Small businesses running Meta ads',
  offer: 'Monthly Meta ad management', price: 1000, monthly: false, channel: 'Cold email to local firms', performer: 'SUBCONTRACTOR', fulfiller: 'An Upwork ads freelancer at $25/h',
  directCost: 300, acquisitionCostPerSale: 60, capital: 1500, ownerHoursPerDeal: 0, daysToFirstCash: 14, buyerCount: 5000, volumeBasis: 'city directory', assumptions: 'Firms pay upfront.', ownerFit: 'Subcontracted; the owner does nothing.',
  ...over,
});
const second = (over: Record<string, unknown> = {}) =>
  raw({ title: 'Bookkeeping catch-up for contractors', payer: 'Local trade contractors behind on their books', offer: 'A one-off bookkeeping catch-up', fulfiller: 'A freelance bookkeeper at $30/h', price: 900, directCost: 250, ...over });
const parsedRoutes = (items: Record<string, unknown>[], ctx: RouteContext = ctxOf()): ProposedRoute[] => parseRoutes({ routes: items }, ctx).routes;

let seq = 0;
function claim(text: string, over: Partial<ResearchClaim> = {}): ResearchClaim {
  seq += 1;
  return { id: `clm_c42_${seq}`, claim: text, sourceUrl: `https://example.org/c42-${seq}`, sourceTitle: null, sourcePublisher: `Publisher ${seq}`, sourceDate: '2026-11-10', evidenceLane: 'price_evidence', retrievedAt: '2026-11-20T00:00:00Z', ...over } as unknown as ResearchClaim;
}
const finding = (ref: string, lane: string | null, text = 'Columbus movers charge $120 to $180 for a two-hour small move, per three local listings.'): RouteFinding => ({ ref, claimId: `clm_${ref}`, lane, text, source: 'Thumbtack', date: '2026-11-10' });
const review = (index: number, over: Partial<RouteCritique['reviews'][number]> = {}): RouteCritique['reviews'][number] => ({ index, verdict: 'KEEP', scores: {}, failed: [], why: 'fits', repair: null, ...over });

describe('the owner is read from their own words', () => {
  it('C02-P the route prompt asks for every profile field and "not stated" where the words say nothing', () => {
    const prompt = routePrompt(ctxOf({ objective: OBJECTIVE }));
    expect(prompt).toMatch(/STEP 1 — READ THE OWNER[^\n]*skills[^\n]*assets[^\n]*location[^\n]*hours[^\n]*capital[^\n]*refusals/);
    expect(prompt).toMatch(/Write "not stated" for anything the words do not say; never invent it/);
  });

  it('C02-R the profile the proposer read is the profile the critic is shown', () => {
    const routes = parsedRoutes([raw()], ctxOf({ objective: OBJECTIVE }));
    const prompt = critiquePrompt(ctxOf({ objective: OBJECTIVE }), routes, OWNER);
    expect(prompt).toMatch(/OWNER PROFILE \(as the proposer read those words[^\n]*skills: fluent Spanish; assets: a cargo van; location: Columbus, Ohio/);
  });

  it('C02-I an owner who states a licence is owed a route that sells the licensed work itself', () => {
    const licensed = ctxOf({ objective: 'I am an FAA Part 107 licensed drone pilot near Tampa with my own drone. I need $3,000 in 30 days.' });
    for (const prompt of [routePrompt(licensed), critiquePrompt(licensed, parsedRoutes([raw()], licensed), null)]) {
      expect(prompt).toMatch(/when the owner states a licence, certification or trade, at least one route sells that licensed or trade work itself/);
    }
  });

  it('C02-F a profile field the reply marks "not stated" is dropped, never kept as a stated fact', () => {
    const profile = ownerProfileOf('{"owner":{"skills":["not stated"],"assets":["N/A"],"location":"Columbus, Ohio","hours":"unknown","capital":"$200","refusals":["none"]},"routes":[]}');
    expect(profile).toEqual({ skills: [], assets: [], location: 'Columbus, Ohio', hours: null, capital: '$200', refusals: [] });
  });

  it('C02-X an owner with no stated skill and no money is told their time and place are the means', () => {
    const prompt = directionPrompt(ctxOf({ objective: 'I live in Austin, Texas and need $500 in 14 days. I have no money to put in.', capitalLimit: 0, remaining: 500, daysLeft: 14 }));
    expect(prompt).toMatch(/When the owner states no skill or asset, their capital, time and place are the means/);
    expect(prompt).toMatch(/a local service delivered by a provider the owner books and pays/);
  });
});

describe("the owner's own labour is read once and binds every gate", () => {
  const installation = { title: 'Holiday light installation for Columbus homes', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'Home services', payer: 'Columbus homeowners', problem: 'They want lights up before December', offer: 'Holiday light installation', channel: 'Nextdoor posts and door-to-door', performer: 'OWNER', fulfiller: 'The owner, in person', decisiveUnknown: 'Whether homeowners book in late November', ownerFit: 'The van and weekends', price: 250, directCost: 40, capital: 100, ownerHoursPerDeal: 3, daysToFirstCash: 5, acquisitionCostPerSale: 0 };

  it('C03-F an owner who says "I can fly about 20 hours a week" has offered their work', () => {
    const labour = ownerLabourOffer('I am a licensed drone pilot near Tampa and I can fly about 20 hours a week. I need $3,000 in 30 days.');
    expect(labour.offered).toBe(true);
  });

  it('C03-R the route parser and the direction parser read the same offer the same way', () => {
    const offered = ctxOf({ objective: OBJECTIVE, ownerLabour: ownerLabourOffer(OBJECTIVE), remaining: 1500, daysLeft: 21, capitalLimit: 200 });
    const silent = { ...offered, ownerLabour: { offered: false as const, refused: null } };
    const text = JSON.stringify({ directions: [installation] });
    // Silent: both refuse the owner's physical work.
    expect(parseRoutes({ routes: [installation] }, silent).rejected.map((one) => one.rule)).toEqual(['PHYSICAL']);
    expect(parseDirections(text, silent).rejected.map((one) => one.rule)).toEqual(['PHYSICAL']);
    // Offered: both keep it.
    expect(parseRoutes({ routes: [installation] }, offered).routes.map((one) => one.title)).toEqual([installation.title]);
    expect(parseDirections(text, offered).directions.map((one) => one.title)).toEqual([installation.title]);
  });

  it('C03-X an owner who offers their work is told owner-performed routes are allowed and come first', () => {
    const prompt = routePrompt(ctxOf({ objective: 'I live in Seattle, have $0 and need $500 in 7 days. I can work 15 hours this week.', ownerLabour: ownerLabourOffer('I can work 15 hours this week'), capitalLimit: 0, remaining: 500, daysLeft: 7 }));
    expect(prompt).toMatch(/the standing rule that the owner does no physical work does not apply to it/);
    expect(prompt).toMatch(/first consider how they are paid directly for work they can do now/);
  });
});

describe('what earlier asks and research ruled out reaches the next ask', () => {
  it('C04-I a refuted direction is named to the next route ask as not to be proposed again', () => {
    const prompt = routePrompt(ctxOf({ refuted: [{ title: 'Snow removal subscriptions', why: 'research found it ruled out: no snowfall forecast before February' }] }));
    expect(prompt).toMatch(/REFUTED OR STOPPED by research or a person \(do not propose these again or near-copies[^\n]*\n- Snow removal subscriptions: research found it ruled out: no snowfall/);
  });

  it('C37-R a lesson an earlier ask drew from the evidence is in the next ask', () => {
    const prompt = routePrompt(ctxOf({ lessons: ['Agencies here bill net-60, so only prepaid buyers settle inside the window.'] }));
    expect(prompt).toMatch(/WHAT EARLIER ASKS FOR THIS GOAL LEARNED FROM THE EVIDENCE[^\n]*\n- Agencies here bill net-60/);
  });

  it('C37-P the "rethink" a reply carries is read so it can be recorded', () => {
    expect(rethinkOf('{"owner":{},"rethink":"Buyers prepay only through the platform.","routes":[]}')).toBe('Buyers prepay only through the platform.');
    expect(rethinkOf('{"rethink":"null","routes":[]}')).toBeNull();
  });
});

describe('the window is stated and the code, not the critic, judges dates', () => {
  it('C05-R the window end date is written out in every prompt', () => {
    const ctx = ctxOf();
    const routes = parsedRoutes([raw()], ctx);
    for (const prompt of [routePrompt(ctx), directionPrompt(ctx), critiquePrompt(ctx, routes, null)]) expect(prompt).toMatch(/collected within 90 day\(s\), by 24 February 2027/);
  });

  it('C05-I a window drop with a repair that moves first cash inside the window keeps the repaired route', () => {
    const ctx = ctxOf();
    const routes = parsedRoutes([raw()], ctx);
    const out = applyCritique(routes, { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['WINDOW'], why: 'net 30', repair: { daysToFirstCash: 30 } })], ranking: [1] }, ctx);
    expect(out.ranked.map((one) => [one.route.daysToFirstCash, one.repaired])).toEqual([[30, true]]);
  });

  it('C05-F a critic that drops a route on a wrong window claim alone is overruled by the code', () => {
    const ctx = ctxOf();
    const routes = parsedRoutes([raw()], ctx);
    const out = applyCritique(routes, { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['WINDOW'], why: 'net 30 is outside a 60-day window' })], ranking: [] }, ctx);
    expect(out.dropped).toEqual([]);
    expect(out.ranked[0]!.why).toMatch(/kept against the critique, which objected only on WINDOW/);
  });

  it('C05-X the critic is given the computed first-cash day beside the window end', () => {
    const ctx = ctxOf();
    const prompt = critiquePrompt(ctx, parsedRoutes([raw()], ctx), null);
    expect(prompt).toMatch(/first money by 10 December 2026 \(the window ends 24 February 2027\)/);
  });

  it('C26-P the collected-cash day is computed from the route\'s own days to first cash', () => {
    const ctx = ctxOf();
    expect(routeEconomics(parsedRoutes([raw({ daysToFirstCash: 14 })], ctx)[0]!, ctx).firstCashBy).toBe('10 December 2026');
  });

  it('C09-X a numeric-only drop is not a second verdict on limits the parser already passed', () => {
    const ctx = ctxOf();
    const routes = parsedRoutes([raw(), second()], ctx);
    const out = applyCritique(routes, { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['CAPITAL'], why: 'too expensive' }), review(2)], ranking: [2] }, ctx);
    expect(out.dropped).toEqual([]);
    expect(out.ranked.map((one) => one.route.title)).toEqual(['Bookkeeping catch-up for contractors', 'Retainer ad management for small firms']);
  });
});

describe('findings reach the proposer and the critic, and are cited honestly', () => {
  it('C06-R a local fact from an older lane is still shown when the findings exceed the budget', () => {
    const local = claim('Columbus households post about forty small-move requests a week on Thumbtack in November.', { evidenceLane: 'current_demand', sourceDate: '2026-10-01' });
    const recent = Array.from({ length: 200 }, (_, i) => claim(`E-commerce supplier ${i} lists wholesale beanie prices at $${4 + (i % 7)} a unit with a 50-unit minimum.`, { evidenceLane: 'price_evidence' }));
    const shown = findingsOf([...recent, local], 160);
    expect(shown).toHaveLength(160);
    expect(shown.some((one) => one.claimId === local.id)).toBe(true);
  });

  it('C21-F the findings shown are budgeted, never every claim the project holds', () => {
    const many = Array.from({ length: 600 }, (_, i) => claim(`Agency ${i} publishes a retainer price of $${900 + i} a month for small-firm ad management.`, { evidenceLane: i % 2 ? 'price_evidence' : 'cost_evidence' }));
    const shown = findingsOf(many);
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(FINDINGS_SHOWN).toBeLessThanOrEqual(160);
    expect(routePrompt(ctxOf({ findings: shown })).length).toBeLessThan(120_000);
  });

  it('C16-F a claim without a source never becomes a finding', () => {
    const shown = findingsOf([claim('Columbus movers charge $150 for a two-hour small move in November.', { sourceUrl: '' as never }), claim('Columbus cleaners charge $120 for a standard two-bedroom clean in November.')]);
    expect(shown.map((one) => one.text)).toEqual(['Columbus cleaners charge $120 for a standard two-bedroom clean in November.']);
  });

  it('C19-R a claim knowledge marked refuted never reaches planning as a finding', () => {
    const shown = findingsOf([claim('Snow removal contracts in Columbus are signed in early November at $400 a season.', { contradictionState: 'REFUTED' } as never), claim('Columbus homeowners pay $45 a visit for a driveway clearing after each snowfall.')]);
    expect(shown.map((one) => one.text)).toEqual(['Columbus homeowners pay $45 a visit for a driveway clearing after each snowfall.']);
  });

  it('C18-R the lane a claim was researched under reaches groundsOf through findingsOf', () => {
    const shown = findingsOf([claim('There are about 3,400 restaurants in Franklin County, per the county health department list.', { evidenceLane: 'buyer_volume' })]);
    expect(shown[0]!.lane).toBe('buyer_volume');
    expect(groundsOf({ price: shown[0]!.ref, volume: shown[0]!.ref }, shown).claims).toEqual({ volume: shown[0]!.claimId });
  });

  it('C16-I the lane decides which figure a finding can ground', () => {
    const findings = [finding('F1', 'buyer_volume'), finding('F2', 'price_evidence')];
    expect(groundsOf({ price: 'F1', volume: 'F1', channel: 'F2' }, findings).claims).toEqual({ volume: 'clm_F1' });
  });

  it('C18-I demand cited without a scope is comparable demand, never exact', () => {
    const grounds = groundsOf({ demand: 'F1' }, [finding('F1', 'comparable_demand')]);
    expect(grounds.demandScope).toBe('COMPARABLE');
  });

  it('C24-P a route cannot cite a finding the prompt never showed', () => {
    expect(groundsOf({ price: 'F99', cost: 'F1' }, [finding('F1', 'cost_evidence')]).claims).toEqual({ cost: 'clm_F1' });
  });

  it('C26-R a payout-timing finding grounds the settlement figure', () => {
    expect(groundsOf({ settlement: 'F1' }, [finding('F1', 'timing', 'Thumbtack pays providers within two business days of a completed job.')]).claims).toEqual({ settlement: 'clm_F1' });
  });

  it('C27-R a channel-cost finding from the acquisition lane grounds the channel', () => {
    expect(groundsOf({ channel: 'F1' }, [finding('F1', 'acquisition_access', 'Thumbtack charges $15 to $40 per lead for movers in Columbus.')]).claims).toEqual({ channel: 'clm_F1' });
  });

  it('C21-R the findings reach the critic as well as the proposer', () => {
    const ctx = ctxOf({ findings: [finding('F1', 'price_evidence')] });
    expect(critiquePrompt(ctx, parsedRoutes([raw()], ctx), null)).toMatch(/FINDINGS research holds for this goal[^\n]*\n- F1 \[price_evidence\] Columbus movers charge/);
  });

  it('C31-R the critic sees the computed economics of every route', () => {
    const ctx = ctxOf();
    expect(critiquePrompt(ctx, parsedRoutes([raw()], ctx), null)).toMatch(/COMPUTED \(exact\): each sale earns \$640/);
  });
});

describe('the prompt points the proposer at local, direct and different routes', () => {
  it('C06-X local buyers near an owner with a place and means are considered first', () => {
    expect(routePrompt(ctxOf({ objective: OBJECTIVE }))).toMatch(/buyers near them \(households and local businesses, reached directly\) are usually the fastest money/);
  });

  it('C08-P routes must differ in who pays, for what and through which channel', () => {
    for (const prompt of [routePrompt(ctxOf()), directionPrompt(ctxOf())]) expect(prompt).toMatch(/they must differ in who pays, for what, and through which channel/);
  });

  it('C07-X discovery for an owner with physical means is not confined to online work', () => {
    const focus = discoveryFocusFor('I own a pickup truck in Dayton and need $800 in 10 days.');
    expect(focus).not.toBe(REMOTE_AI_FOCUS);
    expect(focus).toMatch(/work buyers book and pay the owner for directly, in person included/);
  });
});

describe('the parser holds routes to the limits, and only to the limits', () => {
  it('C08-R two routes to different buyers both survive the parse', () => {
    expect(parsedRoutes([raw(), second()]).map((one) => one.title)).toEqual(['Retainer ad management for small firms', 'Bookkeeping catch-up for contractors']);
  });

  it('C09-P a route tying up more than the capital limit is rejected', () => {
    const out = parseRoutes({ routes: [raw({ capital: 6000, acquisitionCostPerSale: undefined })] }, ctxOf());
    expect(out.rejected.map((one) => one.rule)).toEqual(['CAPITAL']);
  });

  it('C09-F a route whose single sale fits the hours is kept even if the whole target would not', () => {
    const ctx = ctxOf({ hoursLimit: 15, remaining: 1500, capitalLimit: 500, objective: OBJECTIVE, ownerLabour: ownerLabourOffer(OBJECTIVE) });
    const out = parseRoutes({ routes: [raw({ price: 200, directCost: 0, acquisitionCostPerSale: 0, capital: 0, ownerHoursPerDeal: 5, performer: 'SUBCONTRACTOR' })] }, ctx);
    expect(out.rejected).toEqual([]);
    expect(out.routes).toHaveLength(1);
  });

  it('C28-I a fulfiller who costs more than the price leaves no margin and is rejected', () => {
    expect(parseRoutes({ routes: [raw({ price: 150, directCost: 200, acquisitionCostPerSale: undefined })] }, ctxOf()).rejected.map((one) => one.rule)).toEqual(['MARGIN']);
  });

  it('C30-P a route whose buyers cost more to win than a sale earns is rejected', () => {
    expect(parseRoutes({ routes: [raw({ price: 45, directCost: 25, acquisitionCostPerSale: 39 })] }, ctxOf()).rejected.map((one) => one.rule)).toEqual(['ACQUISITION']);
  });

  it('C27-X the first buyer\'s cost and the capital together are held to the capital limit', () => {
    const out = parseRoutes({ routes: [raw({ capital: 150, acquisitionCostPerSale: 100, price: 400, directCost: 50 })] }, ctxOf({ capitalLimit: 200 }));
    expect(out.rejected.map((one) => one.rule)).toEqual(['CAPITAL']);
  });

  it('C28-X an owner-performed route with no hours stated is not free when the owner has no hours', () => {
    const out = parseRoutes({ routes: [raw({ performer: 'OWNER', ownerHoursPerDeal: undefined, fulfiller: 'The owner, remotely' })] }, ctxOf({ hoursLimit: 0 }));
    expect(out.rejected.map((one) => one.rule)).toEqual(['HOURS']);
  });

  it('C34-P each kept route names what it assumes', () => {
    expect(parsedRoutes([raw({ assumptions: 'Firms prepay the first month.' })])[0]!.assumptions).toBe('Firms prepay the first month.');
  });

  it('C10-P a direction without a decisive unknown is not scouted', () => {
    const direction = { title: 'Menu translation', mechanism: 'EXPLICIT_PAID_REQUEST', payer: 'Columbus taquerias', problem: 'English-only menus lose customers', offer: 'A translated menu', channel: 'Walking in', performer: 'SUBCONTRACTOR', fulfiller: 'A translator' };
    const out = parseDirections(JSON.stringify({ directions: [direction] }), ctxOf());
    expect(out.directions).toEqual([]);
    expect(out.rejected.map((one) => one.rule)).toEqual(['INCOMPLETE']);
  });
});

describe('the economics are computed by code', () => {
  it('C08-I the margin a route is compared on includes what winning a buyer costs', () => {
    const e = routeEconomics(parsedRoutes([raw()])[0]!, ctxOf());
    expect(e.marginPerSale).toBe(640);
  });

  it('C25-F the sales a route needs are the remaining money over its margin, not its price', () => {
    expect(routeEconomics(parsedRoutes([raw()])[0]!, ctxOf()).salesNeeded).toBe(32);
  });

  it('C25-I a route whose buyer count is below the sales it needs is flagged', () => {
    const ctx = ctxOf();
    const route = parsedRoutes([raw({ buyerCount: 10 })], ctx)[0]!;
    expect(routeEconomics(route, ctx).buyersShort).toBe(true);
    expect(economicsLine(route, ctx)).toMatch(/it counts only 10 such buyers, fewer than it needs alone/);
  });

  it('C27-I the channel\'s cost per buyer scales with the sales needed', () => {
    expect(routeEconomics(parsedRoutes([raw()])[0]!, ctxOf()).acquisitionSpend).toBe(60 * 32);
  });
});

describe('the critique is applied by code', () => {
  it('C24-F a route the critic drops because a finding contradicts it is dropped', () => {
    const ctx = ctxOf();
    const out = applyCritique(parsedRoutes([raw()], ctx), { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['EVIDENCE'], why: 'F2 shows these firms pay net-60' })], ranking: [] }, ctx);
    expect(out.ranked).toEqual([]);
    expect(out.dropped.map((one) => one.rule)).toEqual(['CRITIQUE']);
  });

  it('C30-I a repair that breaks a limit is dropped, not kept', () => {
    const ctx = ctxOf();
    const out = applyCritique(parsedRoutes([raw()], ctx), { owner: null, reviews: [review(1, { verdict: 'REPAIR', failed: ['PRICE'], why: 'market rate', repair: { capital: 9000 } })], ranking: [1] }, ctx);
    expect(out.ranked).toEqual([]);
    expect(out.dropped[0]!.why).toMatch(/its repair \(fails PRICE\) broke a limit/);
  });

  it('C31-P a "KEEP" that scores a rule at the failure score is read as a failure and dropped', () => {
    const ctx = ctxOf();
    const text = JSON.stringify({ reviews: [{ index: 1, verdict: 'KEEP', scores: { VALUE: 1, OWNER_FIT: 4 }, failed: [], why: 'resells a platform gig' }], ranking: [1] });
    const critique = critiqueJson(text, 1)!;
    expect(critique.reviews[0]!.failed).toEqual(['VALUE']);
    expect(applyCritique(parsedRoutes([raw()], ctx), critique, ctx).ranked).toEqual([]);
  });

  it('C33-P the survivors follow the critic\'s ranking', () => {
    const ctx = ctxOf();
    const out = applyCritique(parsedRoutes([raw(), second()], ctx), { owner: null, reviews: [review(1, { scores: { VALUE: 5 } }), review(2, { scores: { VALUE: 1, OWNER_FIT: 2 }, failed: [] })], ranking: [2, 1] }, ctx);
    expect(out.ranked.map((one) => one.route.title)).toEqual(['Bookkeeping catch-up for contractors', 'Retainer ad management for small firms']);
  });

  it('C33-X a route kept against the critique ranks after every route the critic kept', () => {
    const ctx = ctxOf();
    const out = applyCritique(parsedRoutes([raw(), second()], ctx), { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['WINDOW'], why: 'dates' }), review(2)], ranking: [1, 2] }, ctx);
    expect(out.ranked.map((one) => one.route.title)).toEqual(['Bookkeeping catch-up for contractors', 'Retainer ad management for small firms']);
  });

  it('C07-I a direction the review drops is not kept for research', () => {
    const direction = { title: 'Menu translation', mechanism: 'EXPLICIT_PAID_REQUEST', payer: 'Columbus taquerias', problem: 'English-only menus lose customers', offer: 'A translated menu', channel: 'Walking in', performer: 'SUBCONTRACTOR', fulfiller: 'A translator', decisiveUnknown: 'Whether owners pay $100' };
    const { directions } = parseDirections(JSON.stringify({ directions: [direction] }), ctxOf());
    const out = applyDirectionCritique(directions, { owner: null, reviews: [review(1, { verdict: 'DROP', failed: ['MARKET'], why: 'research found no buyers' })], ranking: [] });
    expect(out.kept).toEqual([]);
    expect(out.dropped.map((one) => one.rule)).toEqual(['CRITIQUE']);
  });
});

describe('a failed answer is replaced, and what failed reaches the replacement ask', () => {
  const failed = [{ title: 'Notion templates', why: 'the critique dropped it (fails VALUE): fits any request', rule: 'CRITIQUE' as const }];

  it('C09-R why each route failed reaches the next ask', () => {
    expect(replacementPrompt(ctxOf(), 3, [], failed)).toMatch(/AN EARLIER ANSWER FAILED REVIEW[^\n]*\n- Notion templates: the critique dropped it \(fails VALUE\): fits any request/);
  });

  it('C08-F the replacement ask names the kept routes so it proposes different buyers', () => {
    const kept = parsedRoutes([raw()]);
    expect(replacementPrompt(ctxOf(), 3, kept, failed)).toMatch(/KEPT \(propose routes to different buyers\): Retainer ad management for small firms \(Small businesses running Meta ads\)/);
  });
});

describe('a failed model turn is retried and a cut reply salvaged', () => {
  it('C11-F an empty reply is asked once more with twice the budget before it counts as failed', async () => {
    const budgets: number[] = [];
    const chat: ChatFn = async (_messages, _tools, maxTokens) => {
      budgets.push(maxTokens ?? 0);
      return { content: budgets.length === 1 ? '' : '{"routes":[]}', error: null } as never;
    };
    expect((await askModel(chat, 'sys', 'ask', 3000)).content).toBe('{"routes":[]}');
    expect(budgets).toEqual([3000, 6000]);
  });

  it('C39-P a reply cut off mid-list keeps every route it finished', () => {
    const one = JSON.stringify(raw());
    const two = JSON.stringify(second());
    const out = routesJson(`{"owner":{},"routes":[${one},${two},{"title":"Cut off`);
    expect(out?.routes).toHaveLength(2);
  });
});

describe('the re-ask schedule follows research and failure', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  it('C38-P three new findings make a grounded re-ask due before the ordinary interval', () => {
    const asks = [{ createdAt: at(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: { outcome: 'PROPOSED', filed: ['a'], findingsSeen: 4 } }];
    expect(routeAskDue(asks, now, { findings: 7 })).toEqual({ due: true, onFindings: true });
  });

  it('C38-F an ask that yielded nothing is retried after the short spacing, not the ordinary interval', () => {
    const asks = [{ createdAt: at(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000), detail: { outcome: 'NO_ANSWER' } }];
    expect(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000).toBeLessThan(ROUTE_PROPOSAL_EVERY_MS);
    expect(routeAskDue(asks, now).due).toBe(true);
  });

  it('C39-F repeated failures stop the fast retries at the daily cap', () => {
    const asks = Array.from({ length: ROUTE_FAILED_ASKS_PER_DAY }, (_, i) => ({ createdAt: at(ROUTE_RETRY_AFTER_FAILURE_MS + 60_000 + i * 60_000), detail: { outcome: 'NO_ANSWER' } }));
    expect(routeAskDue(asks, now).due).toBe(false);
  });
});

describe('the strong model is used only when the deployment selects it', () => {
  it('C41-I a held key alone does not route asks to a model nobody named', () => {
    expect(strongRouteModels({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toEqual([]);
    expect(strongRouteModels({ ANTHROPIC_API_KEY: 'sk-ant-test', BRAIN_ROUTE_MODEL: 'claude-sonnet-5-5' })).toHaveLength(1);
  });
});
