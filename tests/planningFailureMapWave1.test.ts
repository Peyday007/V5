/**
 * Wave 1 of the planning failure map (docs/PLANNING-FAILURE-MAP.md): the route
 * path's root causes RC1 (an unchecked model turn), RC2 (an unchecked critic
 * veto), RC4 (findings lost on the way to the planner), RC5 (inquiry anchored
 * on one menu), RC8 (route arithmetic left to the model), RC9 (a field rule
 * dropping instead of repairing) and RC3 in discovery. Each case is the failure
 * as the intelligence test measured it on production (2026-11-26), not a
 * benchmark answer.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCritique,
  askModel,
  directMeansLine,
  directionPrompt,
  economicsLine,
  findingsOf,
  parseRoutes,
  routeEconomics,
  routePrompt,
  type RouteContext,
  type RouteCritique,
} from '../server/services/goals/routeProposal.ts';
import { discoveryFocusFor, REMOTE_AI_FOCUS } from '../server/services/cash/discovery.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';
import type { ResearchClaim } from '../server/domain/types.ts';

let seq = 0;
function claim(text: string, over: Partial<ResearchClaim> = {}): ResearchClaim {
  seq += 1;
  return { id: `clm_w1_${seq}`, claim: text, sourceUrl: `https://example.org/w1-${seq}`, sourceTitle: null, sourcePublisher: `Publisher ${seq}`, sourceDate: '2026-11-10', evidenceLane: 'price_evidence', retrievedAt: '2026-11-20T00:00:00Z', ...over } as unknown as ResearchClaim;
}
const ctxOf = (over: Partial<RouteContext> = {}): RouteContext => ({
  objective: 'I want a business that does $20,000 in the next 90 days. I have $5,000 and no hours.',
  currency: 'USD',
  remaining: 20000,
  daysLeft: 90,
  capitalLimit: 5000,
  hoursLimit: 0,
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
const route = (over: Record<string, unknown> = {}) => ({
  title: 'Retainer ad management for small firms', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'Marketing', payer: 'Small businesses running Meta ads',
  offer: 'Monthly Meta ad management', price: 1000, monthly: false, channel: 'Cold email to local firms', performer: 'SUBCONTRACTOR', fulfiller: 'An Upwork ads freelancer at $25/h',
  directCost: 300, acquisitionCostPerSale: 300, capital: 1500, ownerHoursPerDeal: 0, daysToFirstCash: 14, buyerCount: 5000, volumeBasis: 'city directory', assumptions: 'Firms pay upfront.', ownerFit: 'Subcontracted; the owner does nothing.',
  ...over,
});

describe('RC4: every distinct verified finding can reach the planner', () => {
  it('keeps two facts that share their first 160 characters and drop a refuted one', () => {
    const head = 'PropPhoto lists real estate drone video in Mesa, Arizona as typically $129 to $300 per shoot, and the same page lists add-on pricing for twilight aerials and ';
    const found = findingsOf([claim(`${head}a $100 rush fee.`), claim(`${head}a 30-second edited reel at $75.`), claim('A refuted figure that research later overturned completely.', { contradictionState: 'REFUTED' } as Partial<ResearchClaim>)]);
    expect(found.map((one) => one.text)).toEqual([`${head}a $100 rush fee.`, `${head}a 30-second edited reel at $75.`]);
  });

  it('past its budget takes every lane in turn, so the newest round cannot crowd the rest out', () => {
    const newest = Array.from({ length: 10 }, (_, i) => claim(`Shopify payout timing detail number ${i} for new stores in 2026.`, { evidenceLane: 'timing' }));
    const older = [claim('Agencies charge 10–20% of monthly ad spend or about $1,000 a month.', { evidenceLane: 'price_evidence' }), claim('Cold email costs about $153 per booked meeting with a small-business owner.', { evidenceLane: 'cost_evidence' })];
    const found = findingsOf([...newest, ...older], 4);
    expect(found).toHaveLength(4);
    expect(found.map((one) => one.lane)).toEqual(expect.arrayContaining(['timing', 'price_evidence', 'cost_evidence']));
  });
});

describe('RC8: a route is held to its own arithmetic by code', () => {
  it('refuses a route whose buyers cost more to win than a sale earns (the 445-beanies-from-$3,000 route)', () => {
    const { routes, rejected } = parseRoutes({ routes: [route({ title: 'Holiday beanie store', offer: 'Embroidered beanies', price: 45, directCost: 25.43, acquisitionCostPerSale: 38.99, capital: 3000 })] }, ctxOf());
    expect(routes).toHaveLength(0);
    expect(rejected[0]?.rule).toBe('ACQUISITION');
  });

  it('computes sales, buyer cost, hours and first-cash date for a sound route, and says them to the critic', () => {
    const { routes } = parseRoutes({ routes: [route()] }, ctxOf());
    expect(routes).toHaveLength(1);
    const e = routeEconomics(routes[0]!, ctxOf());
    expect(e.marginPerSale).toBe(400);
    expect(e.salesNeeded).toBe(50);
    expect(e.acquisitionSpend).toBe(15000);
    expect(e.firstCashBy).toBe('10 December 2026');
    expect(economicsLine(routes[0]!, ctxOf())).toMatch(/needs 50 sale\(s\).*first money by 10 December 2026 \(the window ends 24 February 2027\)/);
  });
});

describe('RC9: a missing description is a gap, not a lost route', () => {
  it('keeps a route without an owner-fit sentence and says it is unstated', () => {
    const { routes, rejected } = parseRoutes({ routes: [route({ ownerFit: undefined })] }, ctxOf());
    expect(rejected).toHaveLength(0);
    expect(routes[0]!.ownerFit).toMatch(/not stated by the proposer/);
  });
});

describe('RC2: the critic cannot veto on sums the code checked', () => {
  const p02 = ctxOf({ objective: "I have a DJI Mavic 3 and my FAA Part 107 license, I'm in Phoenix.", remaining: 4500, daysLeft: 60, capitalLimit: 1500, hoursLimit: 171 });
  const aerial = route({ title: 'Listing aerials for Phoenix agents', payer: 'Phoenix listing agents', offer: 'Drone photo package per listing', price: 250, directCost: 0, acquisitionCostPerSale: 14, capital: 200, performer: 'OWNER', fulfiller: 'The owner', ownerHoursPerDeal: 2, daysToFirstCash: 7 });
  const parsed = parseRoutes({ routes: [aerial, route({ title: 'Unlicensed topographic surveys', offer: 'Topographic survey maps', payer: 'Arizona builders' })] }, p02).routes;
  const critique = (verdicts: RouteCritique['reviews']): RouteCritique => ({ owner: null, reviews: verdicts, ranking: [2, 1] });

  it('keeps a route dropped only on WINDOW (net 30 inside 60 days), ranked after the routes it kept', () => {
    const out = applyCritique(parsed, critique([
      { index: 1, verdict: 'DROP', scores: { WINDOW: 1 }, failed: ['WINDOW'], why: 'agents may pay net 30, so first cash is unlikely within 60 days', repair: null },
      { index: 2, verdict: 'KEEP', scores: {}, failed: [], why: 'fine', repair: null },
    ]), p02);
    expect(out.ranked.map((one) => one.route.title)).toEqual(['Unlicensed topographic surveys', 'Listing aerials for Phoenix agents']);
    expect(out.ranked[1]!.why).toMatch(/kept against the critique/);
  });

  it('re-checks a disputed figure as a repair: 30 days to cash still fits a 60-day window', () => {
    const out = applyCritique(parsed, critique([
      { index: 1, verdict: 'DROP', scores: { WINDOW: 1 }, failed: ['WINDOW'], why: 'net 30', repair: { daysToFirstCash: 30 } },
      { index: 2, verdict: 'DROP', scores: { LAWFUL: 0 }, failed: ['LAWFUL'], why: 'aerial topographic mapping is registered land-surveying work in Arizona', repair: null },
    ]), p02);
    expect(out.ranked.map((one) => [one.route.title, one.route.daysToFirstCash])).toEqual([['Listing aerials for Phoenix agents', 30]]);
    expect(out.dropped.map((one) => one.title)).toEqual(['Unlicensed topographic surveys']);
  });
});

describe('RC1: an empty model turn is not an answer', () => {
  const reply = (content: string) => ({ content, toolCalls: [], ms: 1, completionTokens: 0, error: null });
  it('asks once more with twice the budget, and uses that answer', async () => {
    const budgets: number[] = [];
    const chat: ChatFn = async (_m, _t, max) => {
      budgets.push(max ?? 0);
      return reply(budgets.length === 1 ? '' : '{"routes":[]}');
    };
    expect(await askModel(chat, 'sys', 'ask', 4000)).toEqual({ content: '{"routes":[]}', error: null });
    expect(budgets).toEqual([4000, 8000]);
  });
  it('is an error when empty twice, so the next model is tried for a named reason', async () => {
    const chat: ChatFn = async () => reply('');
    expect((await askModel(chat, 'sys', 'ask', 4000)).error).toMatch(/empty reply twice/);
  });
});

describe('RC5 and RC3: the owner offering their own work is asked about first', () => {
  const offered = ctxOf({ objective: 'Seattle. I have zero money to invest and I need $500 within 7 days. I can put in 15 hours this week.', remaining: 500, daysLeft: 7, capitalLimit: 0, hoursLimit: 15, ownerLabour: { offered: true, evidence: 'I can put in 15 hours this week' } });
  it('the scouting and route asks put the owner\'s direct paid work before brokering', () => {
    expect(directMeansLine(offered)).toMatch(/paid directly for work they can do now/);
    expect(directionPrompt(offered)).toContain(directMeansLine(offered));
    expect(routePrompt(offered)).toContain(directMeansLine(offered));
  });
  it('says nothing of the kind when the owner gives no hours', () => {
    expect(directMeansLine(ctxOf())).toBe('');
    expect(directionPrompt(ctxOf())).not.toMatch(/paid directly for work they can do now/);
  });
  it('discovery keeps the online focus unless the goal\'s words offer the owner\'s work', () => {
    expect(discoveryFocusFor("I want $20,000 in 90 days and can't put any hours in myself")).toBe(REMOTE_AI_FOCUS);
    expect(discoveryFocusFor('Seattle. I need $500 within 7 days. I can put in 15 hours this week.')).toMatch(/^The owner offered their own work/);
  });
});
