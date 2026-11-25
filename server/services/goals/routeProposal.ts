/**
 * Whole commercial routes for a goal, proposed from its objective alone.
 *
 * Measured cause (docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md §2–§4): given
 * only the objective, Brain produced 0 usable plans in 46 fresh requests,
 * because nothing reasoned about the objective — construction combines industry
 * fragments and goal discovery files one opening per claim — so no coherent
 * route (buyer, offer, price, channel, fulfiller, cost, settlement, volume,
 * dated demand) ever reached the planner. Given a whole route, the planner
 * yields a usable plan 80–90% of the time. This is that missing step.
 *
 * Brain's operator model is asked for a few concrete, diverse routes inside the
 * owner's limits (capital, hours, deadline, scope, exclusions), told what Brain
 * proves it delivers, what the goal already holds and which earlier routes
 * research refuted. Each route that respects the limits is filed as ONE opening:
 *
 *   - its figures are RECOMMENDATION card facts — Brain's hypothesis, with its
 *     basis, assumptions and uncertainty — never EVIDENCE, never a buying
 *     signal and never an observation date: nothing published stands behind it;
 *   - its origin is its row (`external_record_id` = `route:<goal>:<key>`,
 *     `domain/routeOrigin.ts`), so filing is idempotent per goal and route, and
 *     the deep dive admits it by that origin and asks the whole route as one
 *     question (`validation.ts` `routeValidationQuestion`);
 *   - it is linked to the goal (`workstream_links`, SOURCE), so the goal's
 *     spending limits bind it (`spending.ts`).
 *
 * Independent judge, 2026-11-25 (12 fresh goals, 3 of 67 routes credible):
 * the same digital-product menu answered unrelated requests, the owner's own
 * skills, assets and place were dropped, and channels and fulfilment could not
 * work inside the window. So the owner's words lead the prompt and are read
 * first into a profile; the feasibility rules (`ROUTE_RULES`) and a spread of
 * buyer kinds are stated; and a second turn critiques the answer against those
 * rules (`critiqueAndRevise`), repairs or drops what fails, asks once for
 * replacements when fewer than `ROUTES_MIN_SURVIVING` survive, and ranks the
 * rest. The rank is filed on each opening (`ROUTE_RANK_FIELD`) and decides the
 * plan's choice among routes nobody has researched yet (`plan.ts`).
 *
 * Nothing here is a new scheduler or a new model path (rule 6). The models are
 * the operator's (`modelsFor`), ordered and asked exactly as the committee's
 * specialists are (`challengerModels`, `chatFor`; the reply read by `routesJson`); the cadence is
 * the goal search pass that already runs when a goal has no accepted plan
 * (`plan.ts` `widenGoalSearch`), bounded by the goal's own recorded events:
 * at most one ask per `ROUTE_PROPOSAL_EVERY_MS` and at most `ROUTES_PER_DAY`
 * routes filed per goal per day. With no model configured nothing is filed,
 * and the goal's record says why (`GOAL_ROUTES_PROPOSED`, outcome NO_MODEL).
 */
import { createHash } from 'node:crypto';
import type { OperatorModel } from '../../domain/operator.ts';
import type { Workstream } from '../../domain/register.ts';
import { CASH_MECHANISMS, type CashMechanism, type CashOpportunity } from '../../domain/types.ts';
import { breaksOperatingModel, OPERATING_MODEL_SENTENCE, operatingFactsOf, operatingFit, ownerLabourOffer, type OwnerLabour } from '../../domain/operatingModel.ts';
import {
  BUYER_PROBLEM_FIELD,
  COMPARABLE_DEMAND_FIELD,
  COMPARABLE_SPEND_FIELD,
  DECISIVE_UNKNOWN_FIELD,
  goalRoutePrefix,
  ROUTE_GROUNDS_FIELD,
  routeRecordId,
  ROUTE_RANK_FIELD,
  ROUTE_SEARCHES_FIELD,
  ROUTE_STAGE_FIELD,
  routeStageOf,
  SUPERSEDED_PREFIX,
  type RouteStage,
} from '../../domain/routeOrigin.ts';
import type { ResearchClaim } from '../../domain/types.ts';
import { chatFor, type ChatFn } from '../cheap/modelBench.ts';
import { challengerModels } from '../operator/decisions.ts';
import { getWorkstream, linkWorkstream, recordWorkstreamEvent, workstreamEventsOfKind } from '../../repos/register.ts';
import { createOpportunity, getOpportunity, opportunitiesWithRecordPrefix, transitionOpportunity, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { claimsByIds, projectEvidenceClaimCount, projectEvidenceClaims } from '../../repos/research.ts';
import { cardFactsFor, recordRecommendationFact } from '../../repos/cashCardFacts.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { executionFrame } from '../cash/discovery.ts';
import { DISQUALIFIED_FIELD } from '../cash/engineCard.ts';
import { excludedBy, exclusionLabel, goalExclusions } from '../cash/exclusions.ts';
import { DELIVERABLE_KINDS, DELIVERABLE_LABEL } from '../cash/deliverables/spec.ts';
import { deliverableCapabilityId } from '../cash/capabilities.ts';
import { readTarget, type TargetReading } from './target.ts';

/** The workstream event every proposal pass records on the goal, filed or not. */
export const ROUTE_EVENT = 'GOAL_ROUTES_PROPOSED';
/** A goal's routes are asked for at most once in this long after an ask a model answered. */
export const ROUTE_PROPOSAL_EVERY_MS = 6 * 60 * 60_000;
/**
 * After an ask no model answered with routes, the next is this soon — the
 * failure was the models', not the goal's, and a goal with no routes has no
 * plan to research. Production, 2026-11-25: a fresh goal's one ask timed out
 * on the GPU model and was unparseable on the free one, and it was next asked
 * six hours later.
 */
export const ROUTE_RETRY_AFTER_FAILURE_MS = 30 * 60_000;
/** Failed asks per goal in any 24 hours; past it the ordinary interval applies. */
export const ROUTE_FAILED_ASKS_PER_DAY = 6;
/** Routes asked for in one proposal. */
export const ROUTES_PER_ASK = 6;
/** Routes filed for one goal in any 24 hours. */
export const ROUTES_PER_DAY = 6;
/**
 * One model's longest turn at proposing. Six whole routes are a few thousand
 * tokens from a reasoning model, and the GPU model's answer was cut off by the
 * earlier 90 s ("The operation was aborted due to timeout", production
 * 2026-11-25). The pass never waits on it: the ask runs in the background.
 */
export const ROUTE_ATTEMPT_MS = 240_000;
/** All the models' turns together end inside this: each turn is given what is left, at most `ROUTE_ATTEMPT_MS`. */
export const ROUTE_BUDGET_MS = 360_000;
/** Goals whose routes are being asked for at once, across the process. */
export const ROUTE_MAX_IN_FLIGHT = 2;

const DAY = 86_400_000;
const PERFORMERS = ['BRAIN', 'SUBCONTRACTOR', 'OWNER'] as const;
type Performer = (typeof PERFORMERS)[number];

/** One route as the model proposed it, after the parse kept it. */
export interface ProposedRoute {
  key: string;
  title: string;
  /** Which kind of buyer it sells to (`BUYER_KINDS`), or null when the reply did not say. */
  buyerKind: BuyerKind | null;
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  offer: string;
  price: number;
  /** What such buyers typically pay for this today, as the model anchored the price. */
  priceAnchor: string;
  monthly: boolean;
  channel: string;
  performer: Performer;
  fulfiller: string;
  /** The proved deliverable Brain would produce, when Brain performs it. */
  brainDeliverable: string | null;
  directCost: number;
  capital: number;
  ownerHoursPerDeal: number;
  daysToFirstCash: number;
  buyerCount: number | null;
  volumeBasis: string;
  assumptions: string;
  /** How the route uses or respects what the owner said they have, can do, where they are and what they refuse. */
  ownerFit: string;
  searches: { price: string[]; demand: string[]; volume: string[] };
  /**
   * Which of this route's figures rest on a finding research holds
   * (`RouteFinding`), by the claim id the reply cited; a field absent is the
   * model's estimate. Filed as EVIDENCE facts from the claims themselves
   * (`groundRoute`), never from the model's restatement of them.
   */
  grounds: RouteGrounds;
}

/** The figures a route can rest on a finding for, and the card field each one is filed as. */
export const GROUND_FIELDS = {
  channel: 'access',
  price: 'price',
  volume: 'buyerVolume',
  cost: 'directCosts',
  settlement: 'timeToFirstCash',
  fulfiller: 'fulfillment',
  demand: 'buyingEvidence',
} as const;
export type GroundKey = keyof typeof GROUND_FIELDS;
export interface RouteGrounds {
  /** Claim id per grounded figure. */
  claims: Partial<Record<GroundKey, string>>;
  /**
   * Whether the demand finding shows buyers wanting this very offer (EXACT) or
   * buyers of this kind spending on comparable offers now (COMPARABLE). A new
   * offer rests on comparable demand; only a finding about this exact offer is
   * verified demand for it, and the two are filed in different fields.
   */
  demandScope: 'EXACT' | 'COMPARABLE' | null;
}

/**
 * One sourced finding the goal's research holds, as the proposer and its
 * critic are shown it: an accepted claim whose source was read. `ref` is the
 * short name the prompt uses ("F3"); the claim id is what is filed.
 */
export interface RouteFinding {
  ref: string;
  claimId: string;
  lane: string | null;
  text: string;
  source: string;
  date: string | null;
}
/** Findings shown to one proposal, newest first. */
export const FINDINGS_SHOWN = 40;
/** A goal with fewer findings than this scouts directions before it proposes priced routes. */
export const FINDINGS_FOR_ROUTES = 3;
/** New findings since the last ask that make a fresh, grounded ask due without waiting the ordinary interval. */
export const NEW_FINDINGS_FOR_REASK = 3;
/** Scouted directions asked for in one pass: the cheap first step, so each is one short question. */
export const DIRECTIONS_PER_ASK = 5;

/** A direction research scouted, and what it found: the proposer's memory of what it already learned. */
export interface ScoutedDirection {
  title: string;
  payer: string;
  offer: string;
  decisiveUnknown: string;
  /** Refs of findings filed on it. */
  findings: string[];
  /** Why research ruled it out, when it did. */
  refutedBy: string | null;
}

/** What the prompt is built from. Every field is a row or a limit, never prose Brain wrote. */
export interface RouteContext {
  /** The owner's own words, verbatim: the goal's intent, and its title where that says something more. */
  objective: string;
  currency: string;
  remaining: number;
  daysLeft: number;
  /** Most that may be tied up before money comes back; null when nobody set a limit. */
  capitalLimit: number | null;
  /** The owner's hours for the whole window; null when nobody set a limit. */
  hoursLimit: number | null;
  /**
   * The owner's hours a week, when the goal states them that way ("10 hours a
   * week"); `hoursLimit` is then this over the window. A monthly route's hours
   * recur every month, so they are compared with this, never with the total.
   */
  hoursPerWeek?: number | null;
  resources: string | null;
  industry: string | null;
  recurring: boolean;
  exclusions: string[];
  delivers: string[];
  held: string[];
  refuted: { title: string; why: string }[];
  /** Today's date (ISO), so the season and calendar reach the routes; absent in a context built without a clock. */
  today?: string;
  /** Whether this goal's own words offer the requester's labour or assets (`ownerLabourOffer`); absent reads as not offered. */
  ownerLabour?: OwnerLabour | null;
  /** What research has established for this goal so far (`routeFindings`); absent or empty before any. */
  findings?: RouteFinding[];
  /** The directions scouted for this goal and what their research found. */
  scouted?: ScoutedDirection[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const strs = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((one) => str(one, 160)).filter((one): one is string => !!one).slice(0, n) : []);
const money = (n: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${Math.round(n).toLocaleString('en-US')}`;
/** Weeks in a month, on average: a weekly figure and a monthly one are compared in one unit. */
const WEEKS_PER_MONTH = 52 / 12;
const DAYS_PER_MONTH = 365 / 12;
const weeklyToMonthly = (perWeek: number) => perWeek * WEEKS_PER_MONTH;
/**
 * A figure as a model writes it: a number, or text such as "$1,500/month",
 * "1500 per month" or "1000-2000" — its first figure, so a range reads as its
 * lower end and nothing is read larger than the model wrote. Null when there
 * is none.
 */
const amount = (v: unknown): number | null => {
  const whole = num(v);
  if (whole !== null || typeof v !== 'string') return whole;
  const first = /\d[\d,]*(?:\.\d+)?/.exec(v);
  return first ? num(first[0]) : null;
};
/**
 * Whether a reply says a route is billed monthly: `true`, the text "true",
 * "yes" or "monthly", or — when the flag is absent — a price written per month.
 */
const isMonthly = (v: unknown, price: unknown): boolean =>
  v === true ||
  (typeof v === 'string' && /^(true|yes|monthly|per month)$/i.test(v.trim())) ||
  ((v === undefined || v === null) && typeof price === 'string' && /monthly|(?:\ba|\bper|\/)\s*(?:month|mo)\b/i.test(price));

/** The stable key of a route within a goal: who pays for what, never its wording. Pure. */
export function routeKey(payer: string, offer: string): string {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${norm(payer)}|${norm(offer)}`).digest('hex').slice(0, 16);
}

/**
 * The kinds of buyer a goal's routes are spread across. A route list that
 * stays inside one kind (in production, 2026-11-25: digital products sold
 * online, whatever the request said) is one idea written several ways.
 */
export const BUYER_KINDS = ['LOCAL_CONSUMER', 'LOCAL_BUSINESS', 'ONLINE_MARKETPLACE', 'ONLINE_CONSUMER', 'B2B'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];

/**
 * The feasibility rules every route is held to, by the proposal and again by
 * its critique. Each is general — about time, money, channels, fulfilment and
 * prices — never about an industry. Independent judge, 2026-11-25 (12 fresh
 * goals, 3 of 67 routes credible): routes failed on exactly these, most often
 * on owner fit, then channels that cannot produce buyers inside the window,
 * then fulfilment nobody can perform, then prices no such buyer pays.
 */
export const ROUTE_RULES = {
  OWNER_FIT: "uses what the owner said they have — skills, assets, location, free time — or a priced subcontractor; never expertise the owner did not claim, and never a menu that would fit any request; when the owner states a licence, certification or trade, at least one route sells that licensed or trade work itself to the buyers who pay for it, rather than only products around it",
  WINDOW: 'the first money settles inside the window',
  CHANNEL: "the channel produces paying buyers inside the window with the stated budget: a channel that compounds slowly (search ranking, a new content or video channel, a newsletter, a course, a new marketplace profile with no reviews, enterprise procurement) cannot do that in a short window, and paid advertising needs a budget that buys enough reach to close the sales needed",
  FULFILLER: 'a named fulfiller with a known cost who can start now: the owner, within the stated hours and skills they actually have; a subcontractor whose price fits the capital; or Brain, only for a deliverable it has proved',
  PRICE: 'the price is anchored to what this kind of buyer typically pays for this today; commodity work is priced at its market rate, never far above it; the buyer count is built from the bottom up (a place, a directory, a marketplace category), never a top-down guess',
  CAPITAL: "the capital is read as the owner gave it: a small budget rules out spend-heavy channels; a large one may fund inventory, equipment or paid labour where that is what earns the money; few owner hours rule out labour-per-unit work that does not scale; a recurring target needs recurring billing",
  MARKET: 'the market exists and is buying now, in this season; no invented or dead markets',
  VALUE:
    "the owner's side adds something the buyer pays for: reselling gigs, services or products another platform already sells to the same buyers at a markup, or a referral commission without a named partner programme that publishes what it pays, is not a route",
  LAWFUL:
    "lawful, and inside the terms of every platform it uses: nothing deceptive (fake, paid or incentivised reviews, fake engagement or testimonials), nothing that breaks a marketplace's or platform's rules, no licensed work done without the licence, and no regulated claim made without the right to make it",
  EVIDENCE:
    "every figure that cites a finding says what that finding says, for buyers like these; a route a finding contradicts is not proposed again in another wording; with findings available, a route resting on none of them is weaker than one that rests on them; demand shown only for comparable offers is comparable demand, never proof that buyers want this exact offer",
} as const;
export type RouteRule = keyof typeof ROUTE_RULES;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Today's date and where in the month it falls, for the season and calendar a route must respect. Pure. */
export function calendarLine(today: string): string {
  const d = new Date(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  const part = day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late';
  return `Today is ${today.slice(0, 10)} (${part} ${MONTHS[d.getUTCMonth()]}). Use the season and the calendar where the owner and the buyers are — weather, holidays, school terms, year-end budgets and closures — when choosing buyers, channels and timing, and keep any constraint the owner set for part of the window.`;
}

/** The owner's limits, stated as hard rules. Pure. */
function limitLines(ctx: RouteContext): string[] {
  return [
    `The money still needed: ${money(ctx.remaining, ctx.currency)} (${ctx.currency}), collected within ${ctx.daysLeft} day(s).`,
    ctx.capitalLimit !== null ? `Capital: at most ${money(ctx.capitalLimit, ctx.currency)} may be tied up before money comes back. A route needing more is not allowed.` : 'Capital: the owner set no figure; prefer routes that tie up little.',
    ctx.hoursPerWeek
      ? `Owner's time: at most ${ctx.hoursPerWeek} hour(s) a week of the owner's own work (about ${Math.round(weeklyToMonthly(ctx.hoursPerWeek))} a month), every route's work together. Routes must fit inside it.`
      : ctx.hoursLimit !== null
        ? `Owner's time: at most ${ctx.hoursLimit} hour(s) of the owner's own work in the whole window. Routes must fit inside it.`
        : "Owner's time: no figure set; the owner does no routine personal work.",
    ctx.resources ? `What the owner said they have, verbatim: ${ctx.resources}` : '',
    `Time: the first money must settle inside ${ctx.daysLeft} day(s). A buyer who pays in arrears, on invoice terms or after a long sales cycle that would land later is not allowed.`,
    ctx.industry ? `The owner confined this goal to: ${ctx.industry}. Every route must be in it.` : 'No industry is excluded: choose on economics, time to cash and whether it can be done.',
    ctx.recurring ? 'The target is monthly recurring revenue: every route must be billed monthly.' : '',
    ctx.exclusions.length ? `The owner excluded: ${ctx.exclusions.join('; ')}.` : '',
    OPERATING_MODEL_SENTENCE,
    ctx.ownerLabour?.offered
      ? `For this goal only, the owner offered their own work ("${ctx.ownerLabour.evidence}"): routes the owner personally performs — in person included — are allowed, using only the skills and assets their words state and inside their stated hours. Set performer OWNER and count every one of those hours.`
      : '',
  ].filter(Boolean);
}

/** The findings, as the prompt lists them: "F3 [price_evidence] text (source, date)". Pure. */
export function findingLines(findings: readonly RouteFinding[]): string[] {
  return findings.map((one) => `${one.ref}${one.lane ? ` [${one.lane}]` : ''} ${one.text} (${one.source}${one.date ? `, ${one.date.slice(0, 10)}` : ''})`);
}

/** What was scouted and what research found on each: supported, refuted, or still open. Pure. */
export function scoutedLines(scouted: readonly ScoutedDirection[]): string[] {
  return scouted.map((one) =>
    one.refutedBy
      ? `${one.title} (${one.payer}; ${one.offer}) — RULED OUT: ${one.refutedBy}`
      : one.findings.length
        ? `${one.title} (${one.payer}; ${one.offer}) — research found ${one.findings.join(', ')}; it asked first: ${one.decisiveUnknown}`
        : `${one.title} (${one.payer}; ${one.offer}) — not answered yet; it asks first: ${one.decisiveUnknown}`,
  );
}

/** The research-informed part of a route ask: what was found, what was scouted, and how to use both. Pure. */
function evidenceSections(ctx: RouteContext): string[] {
  const findings = ctx.findings ?? [];
  const scouted = ctx.scouted ?? [];
  if (findings.length === 0 && scouted.length === 0) return [];
  return [
    findings.length
      ? `FINDINGS — what research has established for this goal, each from a source that was read (cite by ref; they are the only facts here):\n- ${findingLines(findings).join('\n- ')}`
      : '',
    scouted.length ? `DIRECTIONS ALREADY SCOUTED for this goal, and what their research found:\n- ${scoutedLines(scouted).join('\n- ')}` : '',
    'BUILD FROM THE FINDINGS. Start from the real buyer problems, the spending on comparable offers, the reachable channels, the fulfilment options, the costs and the payment terms the findings show, and design routes that use them. A new offer may rest on comparable demand: buyers of this kind shown paying for comparable things now. For every figure, say in "grounds" which finding supports it (its ref), or null where it is your estimate; never cite a finding for a figure it does not state. Set demandScope COMPARABLE when the demand finding is about comparable offers and EXACT only when it shows buyers asking for this very offer. Where a finding contradicts a direction or a route, do not restate it in other words: say in "rethink" what the evidence teaches about the buyer, the offer, the price or the channel, and change the approach accordingly.',
  ].filter(Boolean);
}

const ROUTE_SHAPE = (currency: string) =>
  `{"title":"short name","buyerKind":one of ${JSON.stringify(BUYER_KINDS)},"mechanism":one of ${JSON.stringify(CASH_MECHANISMS)},"industry":"industry","payer":"the buyer segment who pays","offer":"what is sold","price":number per sale in ${currency} (per month when billed monthly),"priceAnchor":"what this kind of buyer typically pays for this today, and where that is seen","monthly":true|false,"channel":"how buyers are reached, and why it yields paying buyers inside the window on the stated budget","performer":"BRAIN"|"SUBCONTRACTOR"|"OWNER","fulfiller":"who delivers it, named, and what they cost","brainDeliverable":"one of the proved deliverables when performer is BRAIN, else null","directCost":number per sale,"capital":number tied up before the first payment,"ownerHoursPerDeal":number of the owner's own hours per sale (for a route billed monthly, per buyer per month),"daysToFirstCash":number,"buyerCount":number of such buyers that exist,"volumeBasis":"how that count was built, from the bottom up","assumptions":"what this route assumes that research must check","ownerFit":"which of the owner's stated skills, assets, location, time or refusals it uses or respects","searches":{"price":["search terms or sources that would show the price"],"demand":["... a dated sign of current demand"],"volume":["... how many such buyers exist"]},"grounds":{"channel":"F#"|null,"price":"F#"|null,"volume":"F#"|null,"cost":"F#"|null,"settlement":"F#"|null,"fulfiller":"F#"|null,"demand":"F#"|null,"demandScope":"EXACT"|"COMPARABLE"|null}}`;

/**
 * The prompt. The owner's own words lead, and the model reads them first into
 * an owner profile (skills, assets, location, hours, capital, refusals) that
 * every route must use. Then the date, the limits, the feasibility rules and
 * the spread of buyer kinds. What Brain proves it delivers is one possible
 * fulfilment, offered last — never the frame, which is how one menu of
 * digital products came to answer every request. No industry template: the
 * routes are the model's to reason. Pure.
 */
export function routePrompt(ctx: RouteContext, k: number = ROUTES_PER_ASK): string {
  return [
    `THE OWNER'S OWN WORDS (verbatim — they lead; every skill, asset, place, amount of time and refusal in them binds every route): ${ctx.objective}`,
    'STEP 1 — READ THE OWNER. Before any route, write in "owner" what those words say about: skills (what they can do, languages they speak), assets (equipment, a vehicle, space, accounts, an audience, contacts), location, hours (and when they are free), capital, and refusals. Write "not stated" for anything the words do not say; never invent it.',
    ctx.today ? `DATE: ${calendarLine(ctx.today)}` : '',
    `LIMITS (hard rules):\n- ${limitLines(ctx).join('\n- ')}`,
    `FEASIBILITY (every route must pass every one):\n- ${Object.values(ROUTE_RULES).join('\n- ')}`,
    ...evidenceSections(ctx),
    `STEP 2 — ROUTES. Propose up to ${k} concrete commercial routes built from the owner profile${(ctx.findings ?? []).length ? ' and the findings' : ''}, each able to collect real money for this objective inside every limit above. Each is one whole transaction: a specific kind of buyer who pays, a specific offer, a price such buyers pay today, how they are reached, who delivers it and at what direct cost, how long until the first money settles, and how many such buyers exist. Propose only as many as are genuinely worth researching: one well-founded route is better than several weak ones, routes differ where the owner's means and the evidence point different ways, and no count of buyer kinds (${BUYER_KINDS.join(', ')}) or mechanisms is required. When the owner names a place, an asset or a hands-on skill, and the target is small or the window short, buyers near them (households and local businesses, reached directly) are usually the fastest money — the in-person work done by the owner where this goal's words offer it, otherwise by a local provider the owner books and pays, as the operating rule above allows: consider them before anything sold to the whole internet. A route that would fit any request equally — a report, an audit, a template, a dashboard, a course or an "AI" product offered to everyone — is a poor route unless the owner's own words point to it. Each route says in ownerFit which of the owner's stated facts it uses.`,
    `WHAT BRAIN ITSELF PROVABLY PRODUCES (one possible fulfilment, never the reason for a route; performer BRAIN may only sell one of these): ${ctx.delivers.length ? ctx.delivers.join(', ') : 'nothing proved yet — use OWNER or SUBCONTRACTOR routes'}.`,
    ctx.held.length ? `ALREADY HELD for this goal (propose different routes): ${ctx.held.slice(0, 20).join(' | ')}` : '',
    ctx.refuted.length ? `REFUTED OR STOPPED by research or a person (do not propose these again or near-copies; reason about why they failed):\n- ${ctx.refuted.slice(0, 12).map((one) => `${one.title}: ${one.why}`).join('\n- ')}` : '',
    'Reply with exactly one JSON object and nothing else:',
    `{"owner":{"skills":["..."],"assets":["..."],"location":"...","hours":"...","capital":"...","refusals":["..."]},"rethink":"what the findings and scouted directions taught, in one or two sentences, or null","routes":[${ROUTE_SHAPE(ctx.currency)}]}`,
    'A figure is a fact only where a finding states it; every other figure is your estimate and will be researched — never present it as a fact.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One direction worth checking before anything is priced: the scouting step of the loop. */
export interface ProposedDirection {
  key: string;
  title: string;
  buyerKind: BuyerKind | null;
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  /** The buyer's problem or need, as Brain reasons it — a hypothesis research checks. */
  problem: string;
  offer: string;
  /** What such buyers already pay for comparable things, as Brain expects it: never a figure filed as a price. */
  comparableSpend: string;
  channel: string;
  performer: Performer;
  fulfiller: string;
  brainDeliverable: string | null;
  /** The one unknown most likely to rule it out: what its research asks first. */
  decisiveUnknown: string;
  ownerFit: string;
  assumptions: string;
  searches: { price: string[]; demand: string[]; volume: string[] };
}

const DIRECTION_SHAPE = `{"title":"short name","buyerKind":one of ${JSON.stringify(BUYER_KINDS)},"mechanism":one of ${JSON.stringify(CASH_MECHANISMS)},"industry":"industry","payer":"the kind of buyer","problem":"the real problem or need these buyers have that they already spend money on","offer":"what would be sold, from the owner's means","comparableSpend":"what such buyers already pay for comparable things, as you expect it (to be checked)","channel":"how they could be reached inside the window","performer":"BRAIN"|"SUBCONTRACTOR"|"OWNER","fulfiller":"who could deliver it","brainDeliverable":"one of the proved deliverables when performer is BRAIN, else null","decisiveUnknown":"the single fact most likely to rule this direction out, which research should check first","ownerFit":"which of the owner's stated skills, assets, location, time or refusals it uses","assumptions":"what else it assumes","searches":{"price":["searches that would show what such buyers pay for comparable offers"],"demand":["... that they spend on or seek this now"],"volume":["... how many such buyers there are"]}}`;

/**
 * The scouting ask: directions, not routes. Before anything is priced, the
 * model names the buyer problems the owner's means could answer, what such
 * buyers already spend on, how they could be reached and delivered to, and the
 * one unknown that would kill each — and states no price, count or cost as
 * known, because nothing yet stands behind one. Each direction's research asks
 * that unknown first (`validation.ts` `routeValidationQuestion`), so a dead
 * direction costs one short question, and the priced routes are proposed from
 * what came back (`routePrompt` with `findings`). Pure.
 */
export function directionPrompt(ctx: RouteContext, k: number = DIRECTIONS_PER_ASK): string {
  return [
    `THE OWNER'S OWN WORDS (verbatim — they lead; every skill, asset, place, amount of time and refusal in them binds every direction): ${ctx.objective}`,
    'STEP 1 — READ THE OWNER. Before any direction, write in "owner" what those words say about: skills, assets, location, hours, capital and refusals. Write "not stated" for anything the words do not say; never invent it.',
    ctx.today ? `DATE: ${calendarLine(ctx.today)}` : '',
    `LIMITS (hard rules):\n- ${limitLines(ctx).join('\n- ')}`,
    `FEASIBILITY (a direction must be able to pass these once researched):\n- ${RULE_KEYS.filter((rule) => rule !== 'PRICE' && rule !== 'EVIDENCE').map((rule) => ROUTE_RULES[rule]).join('\n- ')}`,
    ...evidenceSections(ctx),
    `STEP 2 — DIRECTIONS TO CHECK. Nothing has been researched for this goal yet, so do not price anything. Name up to ${k} directions worth one short piece of research each: a kind of buyer with a real problem or need they already spend money on, the offer that would answer it from the owner's own means, what such buyers already pay for comparable things (your expectation, to be checked — never a figure stated as known), how they could be reached inside the window, who could deliver it, and the single unknown most likely to rule it out. Name fewer when fewer are genuinely different; no spread of buyer kinds or business models is required. A direction that would fit any request equally (a report, an audit, a template, a course or an "AI" product offered to everyone) is a poor one unless the owner's words point to it. When the owner states a licence, certification or trade, at least one direction sells that licensed or trade work itself to the buyers who pay for it.`,
    `WHAT BRAIN ITSELF PROVABLY PRODUCES (one possible fulfilment, never the reason for a direction; performer BRAIN may only sell one of these): ${ctx.delivers.length ? ctx.delivers.join(', ') : 'nothing proved yet — use OWNER or SUBCONTRACTOR directions'}.`,
    ctx.held.length ? `ALREADY HELD for this goal (name different directions): ${ctx.held.slice(0, 20).join(' | ')}` : '',
    ctx.refuted.length ? `REFUTED OR STOPPED by research or a person (do not name these again or near-copies; reason about why they failed):\n- ${ctx.refuted.slice(0, 12).map((one) => `${one.title}: ${one.why}`).join('\n- ')}` : '',
    'Reply with exactly one JSON object and nothing else:',
    `{"owner":{"skills":["..."],"assets":["..."],"location":"...","hours":"...","capital":"...","refusals":["..."]},"directions":[${DIRECTION_SHAPE}]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The directions in a model's reply, each held to the limits a direction can
 * already be held to before it is priced: a whole description, a mechanism
 * Brain records, a proved deliverable when Brain performs it, the owner's
 * physical work only where the goal offers it, the owner's exclusions, a stated
 * owner fit and a decisive unknown. Pure.
 */
export function parseDirections(text: string, ctx: RouteContext): { directions: ProposedDirection[]; rejected: RejectedRoute[] } {
  const directions: ProposedDirection[] = [];
  const rejected: RejectedRoute[] = [];
  let raw: unknown[] = [];
  for (const obj of objectsIn(text)) {
    const list = Object.entries(obj).find(([key, v]) => /^(directions?|routes?)$/i.test(key) && Array.isArray(v))?.[1] as unknown[] | undefined;
    if (list) {
      raw = list;
      break;
    }
  }
  /*
   * Read as tolerantly as a route reply (production, dec1125c p04, 2026-11-25:
   * both models answered and neither reply was readable): a bare list, one
   * object at a time, or a list cut off mid-way keeps every direction finished.
   */
  if (raw.length === 0) raw = routesJson(text.replace(/"directions"\s*:/gi, '"routes":'))?.routes ?? [];
  for (const item of raw.slice(0, DIRECTIONS_PER_ASK * 2)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = str(r['title'], 120);
    // A buyer kind in the payer field names nobody (production, dec1125c: payer "LOCAL_BUSINESS").
    const payerRaw = str(r['payer'], 200);
    const payer = payerRaw && !(BUYER_KINDS as readonly string[]).includes(payerRaw.toUpperCase().replace(/[^A-Z]+/g, '_')) ? payerRaw : null;
    const offer = str(r['offer'], 300);
    const channel = str(r['channel'], 200);
    const problem = str(r['problem'] ?? r['buyerProblem'] ?? r['need'], 300);
    const decisiveUnknown = str(r['decisiveUnknown'] ?? r['decisive_unknown'] ?? r['killer'], 300);
    const name = title ?? offer ?? '(untitled)';
    const reject = (why: string, rule: RouteRejectionRule) => rejected.push({ title: name, why, rule });
    if (!title || !payer || !offer || !channel || !problem || !decisiveUnknown) {
      reject('a direction needs a title, a payer, a problem, an offer, a channel and a decisive unknown', 'INCOMPLETE');
      continue;
    }
    const mechanism = str(r['mechanism'], 40)?.toUpperCase();
    if (!mechanism || !(CASH_MECHANISMS as readonly string[]).includes(mechanism)) {
      reject(`mechanism "${mechanism ?? ''}" is not one Brain records`, 'MECHANISM');
      continue;
    }
    const performerRaw = str(r['performer'], 20)?.toUpperCase();
    const performer: Performer = (PERFORMERS as readonly string[]).includes(performerRaw ?? '') ? (performerRaw as Performer) : 'SUBCONTRACTOR';
    const delivered = str(r['brainDeliverable'], 60);
    const brainDeliverable = performer === 'BRAIN' ? (ctx.delivers.find((one) => one.toLowerCase() === (delivered ?? '').toLowerCase()) ?? null) : null;
    if (performer === 'BRAIN' && !brainDeliverable) {
      reject('Brain performs it, but it is none of the deliverables Brain has proved', 'BRAIN_DELIVERABLE');
      continue;
    }
    const fulfiller = str(r['fulfiller'], 200) ?? (performer === 'BRAIN' ? `Brain (${brainDeliverable})` : performer === 'OWNER' ? 'The owner' : 'A subcontractor to be named');
    const industry = str(r['industry'], 80) ?? 'unspecified';
    const fit = operatingFit(operatingFactsOf({ title, offerScope: offer, fulfillmentOwner: performer === 'OWNER' ? 'The owner, personally' : fulfiller, mechanism }));
    if (breaksOperatingModel(fit, ctx.ownerLabour ?? null)) {
      reject(`needs the owner's physical work: ${fit.because}`, 'PHYSICAL');
      continue;
    }
    const excluded = excludedBy(`${title} ${payer} ${offer} ${industry}`, ctx.exclusions);
    if (excluded) {
      reject(`the owner excluded ${exclusionLabel(excluded)}`, 'EXCLUDED');
      continue;
    }
    /*
     * A direction that does not say how it uses the owner is kept for its
     * review (`critiqueDirections`) to judge rather than refused here: in
     * production (dec1125c p02) four of five directions for a licensed drone
     * pilot were refused for the missing field alone, and the goal had none.
     */
    const ownerFit = str(r['ownerFit'] ?? r['owner_fit'] ?? r['fit'], 300) ?? '';
    // Its own key space: the priced route research builds from it, to the same buyer and offer, is filed beside it, not refused as held.
    const key = routeKey(`scouted ${payer}`, offer);
    if (directions.some((one) => one.key === key)) {
      reject('the same buyer and offer as another direction in this answer', 'DUPLICATE');
      continue;
    }
    const searches = (r['searches'] && typeof r['searches'] === 'object' ? r['searches'] : {}) as Record<string, unknown>;
    const kind = str(r['buyerKind'], 40)?.toUpperCase().replace(/[^A-Z]+/g, '_');
    directions.push({
      key,
      title,
      buyerKind: (BUYER_KINDS as readonly string[]).includes(kind ?? '') ? (kind as BuyerKind) : null,
      mechanism: mechanism as CashMechanism,
      industry,
      payer,
      problem,
      offer,
      comparableSpend: str(r['comparableSpend'], 240) ?? '',
      channel,
      performer,
      fulfiller,
      brainDeliverable,
      decisiveUnknown,
      ownerFit,
      assumptions: str(r['assumptions'], 400) ?? '',
      searches: { price: strs(searches['price'], 4), demand: strs(searches['demand'], 4), volume: strs(searches['volume'], 4) },
    });
  }
  return { directions, rejected };
}

/** The rules a direction is reviewed against before any research is spent on it: every rule a direction can meet unpriced. */
export const DIRECTION_RULES: readonly RouteRule[] = ['OWNER_FIT', 'WINDOW', 'CHANNEL', 'FULFILLER', 'CAPITAL', 'MARKET', 'VALUE', 'LAWFUL'];

/** The review of scouted directions: keep or drop each against the rules, and rank what is kept. Pure. */
export function directionCritiquePrompt(ctx: RouteContext, directions: readonly ProposedDirection[]): string {
  const listed = directions.map((one, i) => `${i + 1}. ${JSON.stringify({ title: one.title, payer: one.payer, problem: one.problem, offer: one.offer, comparableSpend: one.comparableSpend, channel: one.channel, performer: one.performer, fulfiller: one.fulfiller, decisiveUnknown: one.decisiveUnknown, ownerFit: one.ownerFit || '(not stated)' })}`);
  return [
    `THE OWNER'S OWN WORDS (verbatim): ${ctx.objective}`,
    ctx.today ? `DATE: ${calendarLine(ctx.today)}` : '',
    `LIMITS (hard rules):\n- ${limitLines(ctx).join('\n- ')}`,
    `RULES (score each direction 0–5 on each; ${CRITIQUE_FAIL_SCORE} or less is a failure):\n${DIRECTION_RULES.map((rule) => `- ${rule}: ${ROUTE_RULES[rule]}`).join('\n')}`,
    ...evidenceSections(ctx),
    `DIRECTIONS NAMED, before anything is priced or researched:\n${listed.join('\n')}`,
    'Judge each as a sceptical operator deciding which are worth one short piece of research. KEEP a direction that could pass every rule once researched; DROP one that fails a rule no research could fix — it ignores the owner\'s stated skills, assets or place for something that would fit any request, it resells what a platform already sells, it is unlawful or against a platform\'s terms, or its channel cannot produce a buyer inside the window. Rank the kept ones, best first: the one most likely to put the owner\'s first money in their hand inside the window first.',
    'Reply with exactly one JSON object and nothing else:',
    `{"reviews":[{"index":1,"verdict":"KEEP"|"DROP","scores":{${DIRECTION_RULES.map((rule) => `"${rule}":0-5`).join(',')}},"failed":["rule names it fails"],"why":"one sentence"}],"ranking":[indices of kept directions, best first]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Apply a direction review: drop what it dropped or what fails a rule, order
 * the rest by its ranking. With no readable review every direction stands, in
 * the order proposed. Pure.
 */
export function applyDirectionCritique(directions: readonly ProposedDirection[], critique: RouteCritique | null): { kept: ProposedDirection[]; dropped: RejectedRoute[] } {
  if (!critique) return { kept: [...directions], dropped: [] };
  const dropped: RejectedRoute[] = [];
  const kept: { one: ProposedDirection; index: number }[] = [];
  directions.forEach((one, i) => {
    const review = critique.reviews.find((r) => r.index === i + 1);
    if (!review) {
      dropped.push({ title: one.title, why: 'the review did not judge it', rule: 'CRITIQUE' });
      return;
    }
    if (review.verdict === 'DROP' || review.failed.length > 0) {
      dropped.push({ title: one.title, why: `the review dropped it${review.failed.length ? ` (fails ${review.failed.join(', ')})` : ''}: ${review.why}`.slice(0, 400), rule: 'CRITIQUE' });
      return;
    }
    kept.push({ one, index: i + 1 });
  });
  const placeOf = (index: number) => {
    const at = critique.ranking.indexOf(index);
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  kept.sort((a, b) => placeOf(a.index) - placeOf(b.index) || a.index - b.index);
  return { kept: kept.map((k) => k.one), dropped };
}

/** The balanced JSON value starting at `start` (an object or an array), or null when it never closes. */
function balancedAt(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parsed(segment: string | null): unknown {
  if (segment === null) return undefined;
  try {
    return JSON.parse(segment) as unknown;
  } catch {
    return undefined;
  }
}

/** The route list a parsed JSON value carries: `{routes: [...]}` in any letter case, a bare array, or one route. */
function routeList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value.some((one) => one && typeof one === 'object') ? value : null;
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const [key, inner] of Object.entries(obj)) {
    if (/^routes?$/i.test(key) && Array.isArray(inner)) return inner;
  }
  if (typeof obj['payer'] === 'string' && typeof obj['offer'] === 'string') return [obj];
  return null;
}

/**
 * The routes in a model's reply, read as tolerantly as the reply is written.
 *
 * Production, 2026-11-25: the free model answered and its reply was refused as
 * "no parseable routes" — the reader took only the first `{…}` in the text and
 * only under a lower-case `routes` key. Now: fenced or bare, a top-level array,
 * `Routes`, prose around it or a stray brace before it, and an answer cut off
 * mid-list keeps every route it completed. Each route is still checked against
 * every limit by `parseRoutes`; nothing here makes a figure up. Pure.
 */
export function routesJson(text: string): { routes: unknown[] } | null {
  const cleaned = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  if (!cleaned) return null;
  const whole = routeList(parsed(cleaned));
  if (whole) return { routes: whole };
  let tries = 0;
  // Routes written one object at a time, outside any list ("1. {…} 2. {…}").
  const singles: unknown[] = [];
  for (let i = 0; i < cleaned.length && tries < 60; i += 1) {
    const ch = cleaned[i];
    if (ch !== '{' && ch !== '[') continue;
    tries += 1;
    const segment = balancedAt(cleaned, i);
    const value = parsed(segment);
    const list = routeList(value);
    if (!list || segment === null) continue;
    const single = !Array.isArray(value) && list.length === 1 && list[0] === value;
    if (!single) return { routes: list };
    singles.push(value);
    i += segment.length - 1;
  }
  if (singles.length > 0) return { routes: singles };
  // Cut off mid-list: every complete object after the `routes` key is a route the model finished.
  const key = /"routes"\s*:\s*\[/i.exec(cleaned);
  if (!key) return null;
  const salvaged: unknown[] = [];
  let i = key.index + key[0].length;
  while (i < cleaned.length) {
    const open = cleaned.indexOf('{', i);
    if (open < 0) break;
    const segment = balancedAt(cleaned, open);
    if (segment === null) break;
    const value = parsed(segment);
    if (value && typeof value === 'object') salvaged.push(value);
    i = open + segment.length;
  }
  return salvaged.length > 0 ? { routes: salvaged } : null;
}

/** The rule a rejected route broke, so a reader of the goal's record can count why. */
export const ROUTE_REJECTION_RULES = {
  INCOMPLETE: 'incomplete',
  MECHANISM: 'unknown mechanism',
  PRICE: 'no price',
  BRAIN_DELIVERABLE: 'not a proved deliverable',
  DAYS: 'no days to first cash',
  DEADLINE: 'first cash after the deadline',
  CAPITAL: 'over the capital limit',
  NOT_MONTHLY: 'not billed monthly',
  MARGIN: 'cost not below price',
  HOURS: 'over the owner hours',
  PHYSICAL: "owner's physical work",
  EXCLUDED: 'excluded by the owner',
  OWNER_FIT: 'no owner fit',
  DUPLICATE: 'duplicate buyer or offer',
  CRITIQUE: 'failed the critique',
} as const;
export type RouteRejectionRule = keyof typeof ROUTE_REJECTION_RULES;
export interface RejectedRoute {
  title: string;
  why: string;
  rule: RouteRejectionRule;
}

/** How many rejected routes broke each rule, most first. Pure. */
export function rejectionCounts(rejected: readonly RejectedRoute[]): Partial<Record<RouteRejectionRule, number>> {
  const counts = new Map<RouteRejectionRule, number>();
  for (const one of rejected) counts.set(one.rule, (counts.get(one.rule) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])) as Partial<Record<RouteRejectionRule, number>>;
}

/** "3 over the owner hours, 2 not billed monthly". Pure. */
export function rejectionSummary(rejected: readonly RejectedRoute[]): string {
  return Object.entries(rejectionCounts(rejected))
    .map(([rule, n]) => `${n} ${ROUTE_REJECTION_RULES[rule as RouteRejectionRule]}`)
    .join(', ');
}

/**
 * The owner hours a route needs and the limit they are held to, both in the
 * unit the goal states its limit in, or null when nobody set one. A route
 * billed monthly recurs: every buyer the run-rate takes is served every month
 * at once, so its hours are a monthly load against the owner's monthly time
 * (from the weekly figure when the goal gave one, else the window's total
 * spread over its months). A one-off sale's hours add up over the window
 * against the window's total. Pure.
 */
export function routeHours(
  route: { price: number; directCost: number; ownerHoursPerDeal: number; monthly: boolean },
  ctx: RouteContext,
): { needed: number; allowed: number; unit: string; deals: number } | null {
  const perWeek = ctx.hoursPerWeek && ctx.hoursPerWeek > 0 ? ctx.hoursPerWeek : null;
  if (ctx.hoursLimit === null && perWeek === null) return null;
  const deals = Math.max(1, Math.ceil(ctx.remaining / Math.max(1, route.price - route.directCost)));
  const needed = route.ownerHoursPerDeal * deals;
  const months = Math.max(1, ctx.daysLeft / DAYS_PER_MONTH);
  if (route.monthly) return { needed, allowed: perWeek !== null ? weeklyToMonthly(perWeek) : ctx.hoursLimit! / months, unit: 'a month', deals };
  return { needed, allowed: ctx.hoursLimit ?? weeklyToMonthly(perWeek!) * months, unit: 'in the window', deals };
}

/**
 * The routes a model's answer proposes, each checked against the limits; a
 * route that breaks one is rejected with the reason and the rule it broke,
 * never adjusted to fit. Every limit is compared in the unit the goal states
 * it in (`routeHours`). Pure.
 */
export function parseRoutes(obj: Record<string, unknown> | null, ctx: RouteContext): { routes: ProposedRoute[]; rejected: RejectedRoute[] } {
  const routes: ProposedRoute[] = [];
  const rejected: RejectedRoute[] = [];
  const raw = obj && Array.isArray(obj['routes']) ? (obj['routes'] as unknown[]) : [];
  const exclusions = ctx.exclusions;
  for (const item of raw.slice(0, ROUTES_PER_ASK * 2)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = str(r['title'], 120);
    const payer = str(r['payer'], 200);
    const offer = str(r['offer'], 300);
    const channel = str(r['channel'], 200);
    const name = title ?? offer ?? '(untitled)';
    const reject = (why: string, rule: RouteRejectionRule) => rejected.push({ title: name, why, rule });
    if (!title || !payer || !offer || !channel) {
      reject('a route needs a title, a payer, an offer and a channel', 'INCOMPLETE');
      continue;
    }
    const mechanism = str(r['mechanism'], 40)?.toUpperCase();
    if (!mechanism || !(CASH_MECHANISMS as readonly string[]).includes(mechanism)) {
      reject(`mechanism "${mechanism ?? ''}" is not one Brain records`, 'MECHANISM');
      continue;
    }
    const price = amount(r['price']);
    if (price === null || price <= 0) {
      reject('no positive price', 'PRICE');
      continue;
    }
    const performerRaw = str(r['performer'], 20)?.toUpperCase();
    const performer: Performer = (PERFORMERS as readonly string[]).includes(performerRaw ?? '') ? (performerRaw as Performer) : 'SUBCONTRACTOR';
    const monthly = isMonthly(r['monthly'], r['price']);
    const directCost = Math.max(0, amount(r['directCost']) ?? 0);
    const capital = Math.max(0, amount(r['capital']) ?? 0);
    const ownerHoursPerDeal = Math.max(0, amount(r['ownerHoursPerDeal']) ?? (performer === 'OWNER' ? 1 : 0));
    const days = amount(r['daysToFirstCash']);
    const buyerCount = amount(r['buyerCount']);
    const delivered = str(r['brainDeliverable'], 60);
    const brainDeliverable = performer === 'BRAIN' ? (ctx.delivers.find((one) => one.toLowerCase() === (delivered ?? '').toLowerCase()) ?? null) : null;
    if (performer === 'BRAIN' && !brainDeliverable) {
      reject('Brain performs it, but it is none of the deliverables Brain has proved', 'BRAIN_DELIVERABLE');
      continue;
    }
    if (days === null || days < 0) {
      reject('no days to first cash', 'DAYS');
      continue;
    }
    if (days >= ctx.daysLeft) {
      reject(`the first money settles after ${days} day(s), beyond the ${ctx.daysLeft} left`, 'DEADLINE');
      continue;
    }
    if (ctx.capitalLimit !== null && capital > ctx.capitalLimit) {
      reject(`ties up ${money(capital, ctx.currency)}, more than the ${money(ctx.capitalLimit, ctx.currency)} allowed`, 'CAPITAL');
      continue;
    }
    if (ctx.recurring && !monthly) {
      reject('the target is monthly recurring revenue and this is not billed monthly', 'NOT_MONTHLY');
      continue;
    }
    if (directCost >= price) {
      reject('its direct cost is not below its price', 'MARGIN');
      continue;
    }
    const hours = routeHours({ price, directCost, ownerHoursPerDeal, monthly }, ctx);
    if (hours && hours.needed > hours.allowed) {
      reject(
        `needs about ${Math.round(hours.needed)} owner hour(s) ${hours.unit} for the ${hours.deals} ${monthly ? 'buyer(s)' : 'sale(s)'} the target takes, more than the ${Math.round(hours.allowed)} allowed ${hours.unit}`,
        'HOURS',
      );
      continue;
    }
    const fulfiller = str(r['fulfiller'], 200) ?? (performer === 'BRAIN' ? `Brain (${brainDeliverable})` : performer === 'OWNER' ? 'The owner' : 'A subcontractor to be named');
    const industry = str(r['industry'], 80) ?? 'unspecified';
    const fit = operatingFit(operatingFactsOf({ title, offerScope: offer, fulfillmentOwner: performer === 'OWNER' ? 'The owner, personally' : fulfiller, mechanism }));
    if (breaksOperatingModel(fit, ctx.ownerLabour ?? null)) {
      reject(`needs the owner's physical work: ${fit.because}`, 'PHYSICAL');
      continue;
    }
    const excluded = excludedBy(`${title} ${payer} ${offer} ${industry}`, exclusions);
    if (excluded) {
      reject(`the owner excluded ${exclusionLabel(excluded)}`, 'EXCLUDED');
      continue;
    }
    const ownerFit = str(r['ownerFit'], 300);
    if (!ownerFit) {
      reject("it does not say how it uses or respects the owner's stated skills, assets, location and refusals", 'OWNER_FIT');
      continue;
    }
    const key = routeKey(payer, offer);
    if (routes.some((one) => one.key === key)) {
      reject('the same buyer and offer as another route in this answer', 'DUPLICATE');
      continue;
    }
    const searches = (r['searches'] && typeof r['searches'] === 'object' ? r['searches'] : {}) as Record<string, unknown>;
    const kind = str(r['buyerKind'], 40)?.toUpperCase().replace(/[^A-Z]+/g, '_');
    routes.push({
      key,
      title,
      buyerKind: (BUYER_KINDS as readonly string[]).includes(kind ?? '') ? (kind as BuyerKind) : null,
      mechanism: mechanism as CashMechanism,
      industry,
      payer,
      offer,
      price,
      priceAnchor: str(r['priceAnchor'], 240) ?? '',
      monthly,
      channel,
      performer,
      fulfiller,
      brainDeliverable,
      directCost,
      capital,
      ownerHoursPerDeal,
      daysToFirstCash: Math.round(days),
      buyerCount: buyerCount !== null && buyerCount > 0 ? Math.round(buyerCount) : null,
      volumeBasis: str(r['volumeBasis'], 240) ?? '',
      assumptions: str(r['assumptions'], 400) ?? '',
      ownerFit,
      searches: { price: strs(searches['price'], 4), demand: strs(searches['demand'], 4), volume: strs(searches['volume'], 4) },
      grounds: groundsOf(r['grounds'], ctx.findings ?? []),
    });
  }
  return { routes, rejected };
}

/**
 * The findings a route's reply cited for its figures, by claim id: only refs
 * the prompt actually showed survive, so a model cannot cite a source nobody
 * read. Pure.
 */
export function groundsOf(value: unknown, findings: readonly RouteFinding[]): RouteGrounds {
  const out: RouteGrounds = { claims: {}, demandScope: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  const byRef = new Map(findings.map((one) => [one.ref.toUpperCase(), one.claimId] as const));
  for (const key of Object.keys(GROUND_FIELDS) as GroundKey[]) {
    const cited = str(raw[key], 40);
    const ref = cited ? /F\d+/i.exec(cited)?.[0]?.toUpperCase() : undefined;
    const claimId = ref ? byRef.get(ref) : undefined;
    if (claimId) out.claims[key] = claimId;
  }
  const scope = str(raw['demandScope'], 20)?.toUpperCase();
  if (out.claims.demand) out.demandScope = scope === 'EXACT' ? 'EXACT' : 'COMPARABLE';
  return out;
}

/** What the owner's words say, as a model read them: the profile every route must use. */
export interface OwnerProfile {
  skills: string[];
  assets: string[];
  location: string | null;
  hours: string | null;
  capital: string | null;
  refusals: string[];
}

const NOT_STATED = /^(not stated|none|n\/a|unknown|unspecified|-)$/i;
const stated = (v: unknown, max: number): string | null => {
  const one = str(v, max);
  return one && !NOT_STATED.test(one) ? one : null;
};
const statedList = (v: unknown): string[] => (Array.isArray(v) ? strs(v, 12) : typeof v === 'string' ? [v] : []).filter((one) => !NOT_STATED.test(one.trim()));

/** Every balanced JSON object in a reply, the whole reply first. */
function objectsIn(text: string): Record<string, unknown>[] {
  const cleaned = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  const out: Record<string, unknown>[] = [];
  const whole = parsed(cleaned);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) out.push(whole as Record<string, unknown>);
  let tries = 0;
  for (let i = 0; i < cleaned.length && tries < 40; i += 1) {
    if (cleaned[i] !== '{') continue;
    tries += 1;
    const value = parsed(balancedAt(cleaned, i));
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
  }
  return out;
}

/** The owner profile a reply carries under `owner`, or null when it carries none that says anything. Pure. */
export function ownerProfileOf(text: string): OwnerProfile | null {
  for (const obj of objectsIn(text)) {
    const raw = obj['owner'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const profile: OwnerProfile = {
      skills: statedList(o['skills']),
      assets: statedList(o['assets']),
      location: stated(o['location'], 160),
      hours: stated(o['hours'], 160),
      capital: stated(o['capital'], 160),
      refusals: statedList(o['refusals']),
    };
    if (profile.skills.length || profile.assets.length || profile.location || profile.hours || profile.capital || profile.refusals.length) return profile;
  }
  return null;
}

/** "skills: Spanish; assets: a van; location: Columbus, Ohio". Pure. */
export function ownerProfileLine(profile: OwnerProfile): string {
  return [
    `skills: ${profile.skills.join(', ') || 'not stated'}`,
    `assets: ${profile.assets.join(', ') || 'not stated'}`,
    `location: ${profile.location ?? 'not stated'}`,
    `hours: ${profile.hours ?? 'not stated'}`,
    `capital: ${profile.capital ?? 'not stated'}`,
    `refusals: ${profile.refusals.join(', ') || 'not stated'}`,
  ].join('; ');
}

/** One route as the critique judged it. */
export interface RouteReview {
  /** 1-based, as the routes were numbered to the critic. */
  index: number;
  verdict: 'KEEP' | 'REPAIR' | 'DROP';
  /** 0–5 per rule (`ROUTE_RULES`); a rule it did not score is absent. */
  scores: Partial<Record<RouteRule, number>>;
  failed: RouteRule[];
  why: string;
  /** Fields that replace the route's own when it is repaired. */
  repair: Record<string, unknown> | null;
}

export interface RouteCritique {
  owner: OwnerProfile | null;
  reviews: RouteReview[];
  /** 1-based indices, best first. */
  ranking: number[];
}

/** A score at or under this, on any rule, is that rule failed, whatever verdict the critic wrote. */
export const CRITIQUE_FAIL_SCORE = 1;
const RULE_KEYS = Object.keys(ROUTE_RULES) as RouteRule[];
const ruleOf = (v: unknown): RouteRule | null => {
  const key = typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '') : '';
  return (RULE_KEYS as string[]).includes(key) ? (key as RouteRule) : null;
};

/** A critic's reply, read as tolerantly as `routesJson` reads a proposal; null when it holds no review. Pure. */
export function critiqueJson(text: string, routeCount: number): RouteCritique | null {
  for (const obj of objectsIn(text)) {
    const list = Object.entries(obj).find(([key, v]) => /^reviews?$/i.test(key) && Array.isArray(v))?.[1] as unknown[] | undefined;
    if (!list) continue;
    const reviews: RouteReview[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const index = amount(r['index'] ?? r['route']);
      if (index === null || index < 1 || index > routeCount || reviews.some((one) => one.index === Math.round(index))) continue;
      const scoresRaw = (r['scores'] && typeof r['scores'] === 'object' ? r['scores'] : {}) as Record<string, unknown>;
      const scores: Partial<Record<RouteRule, number>> = {};
      for (const [key, v] of Object.entries(scoresRaw)) {
        const rule = ruleOf(key);
        const n = amount(v);
        if (rule && n !== null) scores[rule] = Math.max(0, Math.min(5, n));
      }
      const failed = [...new Set([...(Array.isArray(r['failed']) ? r['failed'] : []).map(ruleOf).filter((one): one is RouteRule => !!one), ...RULE_KEYS.filter((rule) => (scores[rule] ?? 5) <= CRITIQUE_FAIL_SCORE)])];
      const verdictRaw = str(r['verdict'], 20)?.toUpperCase() ?? '';
      const repair = r['repair'] && typeof r['repair'] === 'object' && !Array.isArray(r['repair']) && Object.keys(r['repair'] as object).length > 0 ? (r['repair'] as Record<string, unknown>) : null;
      const verdict: RouteReview['verdict'] = verdictRaw.startsWith('DROP') ? 'DROP' : verdictRaw.startsWith('REPAIR') && repair ? 'REPAIR' : verdictRaw.startsWith('KEEP') ? 'KEEP' : repair ? 'REPAIR' : 'DROP';
      reviews.push({ index: Math.round(index), verdict, scores, failed, why: str(r['why'], 300) ?? '', repair });
    }
    if (reviews.length === 0) continue;
    const rankingRaw = Object.entries(obj).find(([key, v]) => /^rank(ing|ed)?$/i.test(key) && Array.isArray(v))?.[1] as unknown[] | undefined;
    const ranking = [...new Set((rankingRaw ?? []).map(amount).filter((n): n is number => n !== null && n >= 1 && n <= routeCount).map(Math.round))];
    return { owner: ownerProfileOf(text), reviews, ranking };
  }
  return null;
}

/** The critic's prompt: the owner's words, their profile, the limits and rules, and the routes, numbered. Pure. */
export function critiquePrompt(ctx: RouteContext, routes: readonly ProposedRoute[], owner: OwnerProfile | null): string {
  const refOf = new Map((ctx.findings ?? []).map((one) => [one.claimId, one.ref] as const));
  const listed = routes.map((route, i) => {
    const { key: _key, searches: _searches, grounds, ...rest } = route;
    const cited = Object.entries(grounds.claims).map(([field, claimId]) => `${field}: ${refOf.get(claimId) ?? '?'}`);
    return `${i + 1}. ${JSON.stringify(rest)}${cited.length ? ` — cites ${cited.join(', ')}${grounds.demandScope ? ` (demand ${grounds.demandScope})` : ''}` : ' — cites no finding'}`;
  });
  return [
    `THE OWNER'S OWN WORDS (verbatim): ${ctx.objective}`,
    (ctx.findings ?? []).length ? `FINDINGS research holds for this goal (check each route's cited figures against them; a route they contradict is dropped):\n- ${findingLines(ctx.findings!).join('\n- ')}` : '',
    (ctx.scouted ?? []).length ? `DIRECTIONS ALREADY SCOUTED, and what research found:\n- ${scoutedLines(ctx.scouted!).join('\n- ')}` : '',
    owner ? `OWNER PROFILE (as the proposer read those words; correct it in "owner" where it misreads them): ${ownerProfileLine(owner)}` : 'OWNER PROFILE: none was given; read the words above yourself and write it in "owner".',
    ctx.today ? `DATE: ${calendarLine(ctx.today)}` : '',
    `LIMITS (hard rules):\n- ${limitLines(ctx).join('\n- ')}`,
    `RULES (score each route 0–5 on each; ${CRITIQUE_FAIL_SCORE} or less is a failure):\n${RULE_KEYS.map((rule) => `- ${rule}: ${ROUTE_RULES[rule]}`).join('\n')}`,
    `ROUTES PROPOSED:\n${listed.join('\n')}`,
    "Judge each route as a sceptical operator who must make it pay inside the window. KEEP a route that passes every rule; REPAIR one that fails a rule a changed field fixes (a market price, a channel that works in time, a named fulfiller with a cost) and give only the changed fields in \"repair\", using the route's own field names; DROP one that cannot be made to pass, or that ignores the owner's stated skills, assets and location for a product that would fit any request. Then rank the routes you keep or repair, best first: the one most likely to put the owner's first money in their hand inside the window ranks first, and between two close ones, the one more of whose figures rest on findings.",
    'Reply with exactly one JSON object and nothing else:',
    `{"owner":{"skills":["..."],"assets":["..."],"location":"...","hours":"...","capital":"...","refusals":["..."]},"reviews":[{"index":1,"verdict":"KEEP"|"REPAIR"|"DROP","scores":{${RULE_KEYS.map((rule) => `"${rule}":0-5`).join(',')}},"failed":["rule names it fails"],"why":"one sentence","repair":{"field":"new value"}|null}],"ranking":[indices of kept or repaired routes, best first]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A route that survived its critique, with the place the critique gave it. */
export interface RankedRoute {
  route: ProposedRoute;
  /** 1 is best. */
  rank: number;
  /** The critique's scores summed, or null for a replacement nobody critiqued. */
  score: number | null;
  why: string;
  repaired: boolean;
}

/**
 * Apply a critique to the routes it judged: a dropped route is rejected with
 * the rules it failed; a repaired one is re-read through `parseRoutes`, so a
 * repair is held to every limit exactly as the original was; the survivors
 * are ordered by the critic's ranking, then by score. Pure.
 */
export function applyCritique(routes: readonly ProposedRoute[], critique: RouteCritique, ctx: RouteContext): { ranked: RankedRoute[]; dropped: RejectedRoute[] } {
  const dropped: RejectedRoute[] = [];
  const survivors: { route: ProposedRoute; index: number; score: number; why: string; repaired: boolean }[] = [];
  routes.forEach((route, i) => {
    const review = critique.reviews.find((one) => one.index === i + 1);
    if (!review) {
      dropped.push({ title: route.title, why: 'the critique did not review it', rule: 'CRITIQUE' });
      return;
    }
    const failing = review.failed.length ? ` (fails ${review.failed.join(', ')})` : '';
    if (review.verdict === 'DROP' || (review.verdict === 'KEEP' && review.failed.length > 0)) {
      dropped.push({ title: route.title, why: `the critique dropped it${failing}: ${review.why}`.slice(0, 400), rule: 'CRITIQUE' });
      return;
    }
    let kept = route;
    if (review.verdict === 'REPAIR' && review.repair) {
      const { key: _key, ...raw } = route;
      const again = parseRoutes({ routes: [{ ...raw, ...review.repair }] }, ctx);
      if (!again.routes[0]) {
        dropped.push({ title: route.title, why: `its repair${failing} broke a limit: ${again.rejected[0]?.why ?? 'unreadable'}`.slice(0, 400), rule: 'CRITIQUE' });
        return;
      }
      // A repair changes fields the critic named; the findings the route cited stay with it.
      kept = { ...again.routes[0], grounds: route.grounds };
    }
    const score = RULE_KEYS.reduce((sum, rule) => sum + (review.scores[rule] ?? 0), 0);
    survivors.push({ route: kept, index: i + 1, score, why: review.why, repaired: kept !== route });
  });
  const placeOf = (index: number) => {
    const at = critique.ranking.indexOf(index);
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  survivors.sort((a, b) => placeOf(a.index) - placeOf(b.index) || b.score - a.score || a.index - b.index);
  return { ranked: survivors.map((one, i) => ({ route: one.route, rank: i + 1, score: one.score, why: one.why, repaired: one.repaired })), dropped };
}

/** The ask for replacements, naming what failed and what is kept. Pure. */
export function replacementPrompt(ctx: RouteContext, k: number, kept: readonly ProposedRoute[], failed: readonly RejectedRoute[]): string {
  return [
    routePrompt(ctx, k),
    `AN EARLIER ANSWER FAILED REVIEW — do not propose these again or near-copies; fix what made them fail:\n- ${failed.slice(0, 12).map((one) => `${one.title}: ${one.why}`).join('\n- ')}`,
    kept.length ? `KEPT (propose routes to different buyers): ${kept.map((one) => `${one.title} (${one.payer})`).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface RouteDeps {
  /** The chat to ask; production: each operator model in the challenger's order (`modelsFor`). */
  chats?: () => Promise<{ label: string; chat: ChatFn }[]>;
  models?: () => Promise<OperatorModel[]>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** The proved deliverables; production: the capability frame (`executionFrame`). */
  delivers?: (projectId: string, currency: string) => Promise<string[]>;
  /** Start the project's deep dives once routes are filed; production: `startValidations`. */
  startDives?: (projectId: string) => Promise<{ opportunityId: string }[]>;
  /** The project's gated, sourced claims, newest first; production: `projectEvidenceClaims`. */
  claims?: (projectId: string) => Promise<ResearchClaim[]>;
  /** File one cited claim as a route's EVIDENCE fact; production: `writeEvidenceAnswer`. */
  writeEvidence?: (input: { opportunity: CashOpportunity; field: string; claim: ResearchClaim; needId: string | null }) => Promise<boolean>;
}

export type RouteOutcome =
  | { kind: 'NOT_DUE'; reason: string }
  | { kind: 'NO_MODEL'; reason: string }
  | { kind: 'NO_ANSWER'; reason: string }
  | { kind: 'PROPOSED'; filed: string[]; existing: string[]; rejected: RejectedRoute[]; model: string; dived: string[]; critique: CritiqueRecord['outcome'] };

/**
 * Whether a recorded ask yielded no route: no model answered (NO_ANSWER), or
 * one answered and every route it gave was rejected (PROPOSED with nothing
 * filed and nothing already held). Production, 2026-11-25: a fresh goal's one
 * answer had all six routes rejected, and that read as answered — the next ask
 * was six hours away for a goal with nothing to research.
 */
export function askYieldedNothing(detail: Record<string, unknown>): boolean {
  if (detail['outcome'] === 'NO_ANSWER') return true;
  const filed = detail['filed'];
  const existing = detail['existing'];
  return detail['outcome'] === 'PROPOSED' && Array.isArray(filed) && filed.length === 0 && (!Array.isArray(existing) || existing.length === 0);
}

/**
 * Whether a goal's routes may be asked for now, from its own recorded asks
 * (newest first). After an ask that filed or held routes: once per
 * `ROUTE_PROPOSAL_EVERY_MS`. After one that yielded none (`askYieldedNothing`):
 * again after `ROUTE_RETRY_AFTER_FAILURE_MS`, at most
 * `ROUTE_FAILED_ASKS_PER_DAY` in any day, then the ordinary interval. NO_MODEL
 * is configuration, not a failed answer, and waits the ordinary interval.
 *
 * `retryOnly` is the plan pass's own check, made for every goal on every pass:
 * due only for a goal never asked or whose last ask yielded nothing — the
 * ordinary interval stays the search pass's (`widenGoalSearch`). Pure.
 */
export function routeAskDue(
  asks: readonly { createdAt: string; detail: Record<string, unknown> }[],
  now: Date,
  options: { retryOnly?: boolean; findings?: number } = {},
): { due: true; onFindings?: boolean } | { due: false; reason: string } {
  const last = asks[0];
  if (!last) return { due: true };
  const since = now.getTime() - Date.parse(last.createdAt);
  /*
   * Research came back: the next ask reasons from it now rather than at the
   * ordinary interval. The research-informed loop's step — what research
   * found reaches the proposer and its critic before the next routes are
   * chosen — waits only out the short retry spacing.
   */
  // An ask recorded before the loop counted findings says nothing about what was new since; it waits the ordinary interval.
  const seen = typeof last.detail['findingsSeen'] === 'number' ? (last.detail['findingsSeen'] as number) : Number.POSITIVE_INFINITY;
  if (options.findings !== undefined && options.findings - seen >= NEW_FINDINGS_FOR_REASK && since >= ROUTE_RETRY_AFTER_FAILURE_MS) return { due: true, onFindings: true };
  const failed = askYieldedNothing(last.detail);
  if (options.retryOnly && !failed) return { due: false, reason: `routes were last asked for at ${last.createdAt} and that ask yielded routes or found no model` };
  const failedToday = asks.filter((one) => askYieldedNothing(one.detail) && now.getTime() - Date.parse(one.createdAt) < DAY).length;
  const wait = failed && failedToday < ROUTE_FAILED_ASKS_PER_DAY ? ROUTE_RETRY_AFTER_FAILURE_MS : ROUTE_PROPOSAL_EVERY_MS;
  if (since >= wait) return { due: true };
  return {
    due: false,
    reason: failed
      ? `routes were last asked for at ${last.createdAt} and it yielded no route (${failedToday} such ask(s) today); asked again ${Math.round(wait / 60_000)} minutes after`
      : `routes were last asked for at ${last.createdAt}`,
  };
}

async function operatorChats(deps: RouteDeps, timeoutMs: () => number): Promise<{ label: string; chat: ChatFn }[]> {
  const models = await (deps.models ?? (async () => (await import('../operator/run.ts')).modelsFor()))().catch(() => [] as OperatorModel[]);
  return challengerModels(models).map((model) => ({
    label: model.label,
    // Each turn is given what the budget has left, never more than one attempt's bound.
    chat: (messages, tools, maxTokens) =>
      chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, deps.fetchImpl ?? fetch, timeoutMs())(messages, tools, maxTokens),
  }));
}

/** Whether an opening was archived because a grounded route replaced it — a step of the loop, not a refutation. */
export const supersededOpening = (one: Pick<CashOpportunity, 'state' | 'archivedReason'>): boolean =>
  one.state === 'ARCHIVED' && (one.archivedReason ?? '').startsWith(SUPERSEDED_PREFIX);

/**
 * The goal's own route openings; those research or a person refuted or
 * stopped, with the evidence that did it; and the directions it scouted with
 * what their research found — what the next ask reasons from.
 */
async function goalRoutes(
  projectId: string,
  goalId: string,
  findings: readonly RouteFinding[] = [],
): Promise<{ all: CashOpportunity[]; refuted: { title: string; why: string }[]; scouted: ScoutedDirection[]; liveScouts: CashOpportunity[]; scoutIds: Set<string> }> {
  const all = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
  const refuted: { title: string; why: string }[] = [];
  const scouted: ScoutedDirection[] = [];
  const liveScouts: CashOpportunity[] = [];
  const scoutIds = new Set<string>();
  const refOf = new Map(findings.map((one) => [one.claimId, one.ref] as const));
  for (const one of all) {
    const facts = await cardFactsFor(one.id);
    const factOf = (field: string) => facts.find((fact) => fact.field === field && fact.value.trim()) ?? null;
    const stage = routeStageOf(factOf(ROUTE_STAGE_FIELD)?.value);
    const ruledOut = factOf(DISQUALIFIED_FIELD);
    const stopped = (one.state === 'ARCHIVED' || one.state === 'DECLINED') && !supersededOpening(one);
    if (stopped) {
      refuted.push({ title: one.title, why: `${one.state === 'ARCHIVED' ? 'stopped' : 'declined'}${(one.archivedReason ?? one.declinedReason) ? `: ${(one.archivedReason ?? one.declinedReason)!.slice(0, 160)}` : ''}` });
    } else if (ruledOut) {
      refuted.push({ title: one.title, why: `research found it ruled out: ${ruledOut.value.slice(0, 160)}` });
    }
    if (stage !== 'SCOUT') continue;
    scoutIds.add(one.id);
    if (!stopped && !supersededOpening(one) && !ruledOut) liveScouts.push(one);
    scouted.push({
      title: one.title,
      payer: one.payer ?? '',
      offer: one.offerScope ?? '',
      decisiveUnknown: factOf(DECISIVE_UNKNOWN_FIELD)?.value ?? '',
      findings: [...new Set(facts.filter((fact) => fact.kind === 'EVIDENCE' && fact.claimId && refOf.has(fact.claimId)).map((fact) => refOf.get(fact.claimId!)!))],
      refutedBy: ruledOut ? ruledOut.value.slice(0, 200) : stopped ? (one.archivedReason ?? one.declinedReason ?? 'stopped').slice(0, 200) : null,
    });
  }
  return { all, refuted, scouted, liveScouts, scoutIds };
}

/**
 * What research has established for a goal, as the proposer is shown it: the
 * project's gated claims whose source was read, newest first, near-duplicates
 * once, each given a short ref. Pure.
 */
export function findingsOf(claims: readonly ResearchClaim[], max: number = FINDINGS_SHOWN): RouteFinding[] {
  const seen = new Set<string>();
  const out: RouteFinding[] = [];
  for (const claim of claims) {
    const text = claim.claim.replace(/\s+/g, ' ').trim();
    if (text.length < 25 || !claim.sourceUrl) continue;
    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
    if (seen.has(norm)) continue;
    seen.add(norm);
    let source = claim.sourcePublisher ?? claim.sourceTitle ?? '';
    if (!source) {
      try {
        source = new URL(claim.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        source = claim.sourceUrl.slice(0, 60);
      }
    }
    out.push({ ref: `F${out.length + 1}`, claimId: claim.id, lane: claim.evidenceLane, text: text.slice(0, 280), source: source.slice(0, 80), date: claim.sourceDate ?? claim.retrievedAt ?? null });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The owner's own words, verbatim. The structured target keeps the amount,
 * window and ceilings and loses what decides a route: a skill ("I speak
 * Spanish"), an asset ("a pickup truck"), a place ("outside Columbus, Ohio"),
 * a refusal ("no physical work"). Production, 2026-11-25: 0 of 12 goal-only
 * requests judged usable, with plans reusing stock buyers across unrelated
 * objectives because none of that reached them. Pure.
 */
export function ownerWords(goal: { title: string; intent?: string | null }): string {
  const intent = (goal.intent ?? '').trim();
  const title = goal.title.trim();
  const words = !intent ? title : !title || intent.includes(title) ? intent : `${title}\n${intent}`;
  return words.slice(0, 2000);
}

/** The context a goal's routes are proposed in, read from its rows. */
export async function routeContext(goal: Workstream, target: TargetReading, heldTitles: readonly string[], deps: RouteDeps = {}): Promise<{ ctx: RouteContext; routes: CashOpportunity[]; liveScouts: CashOpportunity[]; scoutIds: Set<string> } | null> {
  if (target.daysLeft === null || target.daysLeft <= 0 || target.remainingCents <= 0) return null;
  const delivers = await (deps.delivers ?? (async (projectId: string, currency: string) => (await executionFrame(projectId, currency))?.delivers ?? []))(target.projectId, target.currency).catch(() => [] as string[]);
  const exclusions = await goalExclusions(goal).catch(() => []);
  const findings = findingsOf(await (deps.claims ?? ((projectId: string) => projectEvidenceClaims(projectId, FINDINGS_SHOWN * 3)))(target.projectId).catch(() => [] as ResearchClaim[]));
  const { all, refuted, scouted, liveScouts, scoutIds } = await goalRoutes(target.projectId, goal.id, findings);
  const live = all.filter((one) => one.state !== 'ARCHIVED' && one.state !== 'DECLINED').map((one) => one.title);
  const capitalCents = target.capitalBeforeProofCents ?? target.capitalCeilingCents ?? target.scope?.capitalStatedCents ?? target.scope?.capitalAssumed?.cents ?? null;
  return {
    routes: all,
    liveScouts,
    scoutIds,
    ctx: {
      objective: ownerWords(goal),
      currency: target.currency,
      remaining: target.remainingCents / 100,
      daysLeft: target.daysLeft,
      capitalLimit: capitalCents === null ? null : capitalCents / 100,
      hoursLimit: target.hoursCeiling,
      hoursPerWeek: target.scope?.hoursPerWeek ?? null,
      resources: target.resources,
      ownerLabour: ownerLabourOffer(ownerWords(goal), target.resources),
      industry: target.scope?.industry ?? null,
      recurring: target.scope?.recurring === 'MONTHLY',
      exclusions: exclusions.map((one) => exclusionLabel(one)),
      delivers,
      held: [...new Set([...live, ...heldTitles])],
      refuted,
      findings,
      scouted,
    },
  };
}

/** One route, filed as one goal-scoped opening with RECOMMENDATION facts only. Returns its id. */
async function fileRoute(
  goal: Workstream,
  target: TargetReading,
  cashModeId: string,
  ownerUserId: string,
  route: ProposedRoute,
  model: string,
  place: { rank: number; of: number; why: string } | null,
  deps: RouteDeps = {},
  known: ReadonlyMap<string, ResearchClaim> = new Map(),
): Promise<string> {
  const kind = DELIVERABLE_KINDS.find((one) => DELIVERABLE_LABEL[one] === route.brainDeliverable);
  const created = await createOpportunity({
    projectId: target.projectId,
    cashModeId,
    ownerUserId,
    title: route.title,
    mechanism: route.mechanism,
    currency: target.currency,
    industry: route.industry,
    source: 'Brain route proposal for a goal (a hypothesis; no published source yet)',
    externalRecordId: routeRecordId(goal.id, route.key),
    requiredCapabilities: kind ? [deliverableCapabilityId(kind)] : [],
  });
  const id = created.id;
  // The route's own design: who it sells to, what, how they are reached and who delivers. No signal, no observation date.
  await updateOpportunity(id, {
    payer: route.payer,
    offer_scope: route.offer,
    reachable_channel: route.channel,
    price_cents: Math.round(route.price * 100),
    peak_funding_cents: Math.round(route.capital * 100),
    human_hours: route.ownerHoursPerDeal,
    fulfillment_owner: route.performer === 'BRAIN' ? null : route.performer === 'OWNER' ? 'The owner, personally' : route.fulfiller,
  });
  const c = target.currency;
  const per = route.monthly ? ' a month' : '';
  const basis = `Brain's route proposal for goal ${goal.id} (model ${model}), reasoned from the objective and the owner's limits; no published source.`;
  const assumptions = `${route.assumptions || 'The buyer, price and volume are estimates.'} Owner fit: ${route.ownerFit}`.slice(0, 800);
  const uncertainty = 'Not researched yet: the deep dive on this route establishes or refutes it.';
  const facts: [string, string][] = [
    ['captureMechanism', `Sell ${route.offer} to ${route.payer}, reached through ${route.channel}, at ${money(route.price, c)}${per}; ${route.performer === 'BRAIN' ? `Brain produces it (${route.brainDeliverable})` : `${route.fulfiller} delivers it`}.`],
    ['payer', route.payer],
    ['offer', route.offer],
    ['access', route.channel],
    ['price', `${money(route.price, c)}${per}`],
    ['revenueRange', `${money(route.price, c)}${per}`],
    ['directCosts', `${money(route.directCost, c)}`],
    ['exposure', `${money(route.capital, c)}`],
    ['timeToFirstCash', `${route.daysToFirstCash} days`],
    ['hours', `${route.ownerHoursPerDeal} owner hours per sale`],
    ['fulfillment', route.performer === 'BRAIN' ? `Brain produces it: ${route.brainDeliverable}.` : `${route.fulfiller}.`],
    ...(route.performer === 'BRAIN' ? [['delivery', `A ${route.brainDeliverable} Brain produces.`] as [string, string]] : []),
    ...(route.buyerCount !== null ? [['buyerVolume', `${route.buyerCount.toLocaleString('en-US')} ${route.payer}${route.volumeBasis ? ` (${route.volumeBasis})` : ''}`] as [string, string]] : []),
    [ROUTE_SEARCHES_FIELD, [...route.searches.price, ...route.searches.demand, ...route.searches.volume].join('; ')],
    ...(route.priceAnchor ? [['priceAnchor', route.priceAnchor] as [string, string]] : []),
    // The critique's place for it among this ask's routes: what the plan prefers before any route is researched.
    ...(place ? [[ROUTE_RANK_FIELD, `${place.rank} of ${place.of}${place.why ? `: ${place.why}` : ''}`] as [string, string]] : []),
    [ROUTE_STAGE_FIELD, 'ROUTE'],
  ];
  for (const [field, value] of facts) {
    if (!value.trim()) continue;
    await recordRecommendationFact({ projectId: target.projectId, opportunityId: id, field, value: value.slice(0, 600), basis, assumptions, uncertainty });
  }
  await groundRoute(id, route, deps, known);
  await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: id, relation: 'SOURCE', label: 'proposed route', detail: { origin: 'ROUTE_PROPOSAL', key: route.key }, recordedBy: 'BRAIN', recordedByUserId: null });
  await recordCashEvent({
    projectId: target.projectId,
    opportunityId: id,
    kind: 'CASH_ROUTE_PROPOSED',
    actorRef: 'BRAIN',
    summary: `Brain proposed this route for a goal from its objective: ${route.title}. Every figure on it is a hypothesis until research establishes or refutes it.`.slice(0, 400),
    detail: { goalId: goal.id, key: route.key, model, performer: route.performer, price: route.price, monthly: route.monthly, ownerFit: route.ownerFit, buyerKind: route.buyerKind, rank: place?.rank ?? null },
  });
  return id;
}

/**
 * The route's cited findings, filed as its EVIDENCE: each cited claim through
 * the same writer a deep dive's answer goes through (`writeEvidenceAnswer`), so
 * the card states what the source says — its words and its figure, never the
 * model's restatement — and every rule that writer keeps (a money field needs a
 * figure, a demand sign needs a date, a person's fact is never replaced) holds
 * here too. Demand a finding shows only for comparable offers is filed as
 * `comparableDemand`, never as the buying signal for this exact offer. A cited
 * figure the writer refuses stays Brain's estimate. Returns the fields filed.
 */
export async function groundRoute(opportunityId: string, route: Pick<ProposedRoute, 'grounds'>, deps: RouteDeps = {}, known: ReadonlyMap<string, ResearchClaim> = new Map()): Promise<string[]> {
  const cited = Object.entries(route.grounds.claims) as [GroundKey, string][];
  if (cited.length === 0) return [];
  // The claims the proposer was shown are already read; any other is read from its row.
  const missing = [...new Set(cited.map(([, id]) => id))].filter((id) => !known.has(id));
  const claims = new Map([...known, ...(missing.length ? await claimsByIds(missing).catch(() => [] as ResearchClaim[]) : []).map((one) => [one.id, one] as const)]);
  const write = deps.writeEvidence ?? (async (input: Parameters<NonNullable<RouteDeps['writeEvidence']>>[0]) => (await import('../cash/answers.ts')).writeEvidenceAnswer(input));
  const filed: string[] = [];
  for (const [key, claimId] of cited) {
    const claim = claims.get(claimId);
    const opportunity = await getOpportunity(opportunityId);
    if (!claim || !opportunity) continue;
    const field = key === 'demand' && route.grounds.demandScope !== 'EXACT' ? COMPARABLE_DEMAND_FIELD : GROUND_FIELDS[key];
    if (await write({ opportunity, field, claim, needId: null }).catch(() => false)) filed.push(field);
  }
  const all = Object.entries(route.grounds.claims).map(([key, claimId]) => `${key}: ${claimId}${key === 'demand' && route.grounds.demandScope ? ` (${route.grounds.demandScope})` : ''}`);
  const opportunity = await getOpportunity(opportunityId);
  if (opportunity) {
    await recordRecommendationFact({
      projectId: opportunity.projectId,
      opportunityId,
      field: ROUTE_GROUNDS_FIELD,
      value: `Cited findings: ${all.join('; ')}. Filed as evidence: ${filed.join(', ') || 'none'}.`.slice(0, 600),
      basis: "The route proposer's citations, checked against the claims research holds.",
      assumptions: 'A cited figure the evidence writer refused stays the proposal’s estimate.',
      uncertainty: 'A comparable finding is evidence about the market, not about this exact offer.',
    });
  }
  return filed;
}

/** One scouted direction, filed as a goal-scoped opening with no price, count or cost: only what research must check. */
async function fileDirection(goal: Workstream, target: TargetReading, cashModeId: string, ownerUserId: string, direction: ProposedDirection, model: string): Promise<string> {
  const kind = DELIVERABLE_KINDS.find((one) => DELIVERABLE_LABEL[one] === direction.brainDeliverable);
  const created = await createOpportunity({
    projectId: target.projectId,
    cashModeId,
    ownerUserId,
    title: direction.title,
    mechanism: direction.mechanism,
    currency: target.currency,
    industry: direction.industry,
    source: 'Brain direction to scout for a goal (a hypothesis to check before anything is priced; no published source yet)',
    externalRecordId: routeRecordId(goal.id, direction.key),
    requiredCapabilities: kind ? [deliverableCapabilityId(kind)] : [],
  });
  const id = created.id;
  await updateOpportunity(id, {
    payer: direction.payer,
    offer_scope: direction.offer,
    reachable_channel: direction.channel,
    fulfillment_owner: direction.performer === 'BRAIN' ? null : direction.performer === 'OWNER' ? 'The owner, personally' : direction.fulfiller,
  });
  const basis = `Brain's scouting direction for goal ${goal.id} (model ${model}), reasoned from the objective and the owner's limits; nothing priced, nothing published behind it.`;
  const assumptions = `${direction.assumptions || 'The buyer problem and the comparable spending are expectations.'} Owner fit: ${direction.ownerFit}`.slice(0, 800);
  const uncertainty = 'Not researched yet: its first question is its decisive unknown.';
  const facts: [string, string][] = [
    [ROUTE_STAGE_FIELD, 'SCOUT'],
    ['payer', direction.payer],
    ['offer', direction.offer],
    ['access', direction.channel],
    ['fulfillment', direction.performer === 'BRAIN' ? `Brain produces it: ${direction.brainDeliverable}.` : `${direction.fulfiller}.`],
    [BUYER_PROBLEM_FIELD, direction.problem],
    [COMPARABLE_SPEND_FIELD, direction.comparableSpend],
    [DECISIVE_UNKNOWN_FIELD, direction.decisiveUnknown],
    [ROUTE_SEARCHES_FIELD, [...direction.searches.price, ...direction.searches.demand, ...direction.searches.volume].join('; ')],
  ];
  for (const [field, value] of facts) {
    if (!value.trim()) continue;
    await recordRecommendationFact({ projectId: target.projectId, opportunityId: id, field, value: value.slice(0, 600), basis, assumptions, uncertainty });
  }
  await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: id, relation: 'SOURCE', label: 'scouted direction', detail: { origin: 'ROUTE_PROPOSAL', stage: 'SCOUT', key: direction.key }, recordedBy: 'BRAIN', recordedByUserId: null });
  await recordCashEvent({
    projectId: target.projectId,
    opportunityId: id,
    kind: 'CASH_ROUTE_PROPOSED',
    actorRef: 'BRAIN',
    summary: `Brain named a direction to check for a goal before pricing anything: ${direction.title}. Its research asks first: ${direction.decisiveUnknown}`.slice(0, 400),
    detail: { goalId: goal.id, key: direction.key, model, stage: 'SCOUT', performer: direction.performer, buyerKind: direction.buyerKind },
  });
  return id;
}

/**
 * Scouted directions a grounded proposal replaced: archived as superseded (not
 * refuted — their findings are the project's and the routes were built from
 * them), so the plan weighs the priced routes rather than unpriced guesses.
 */
async function supersedeScouts(scouts: readonly CashOpportunity[], filedTitles: readonly string[]): Promise<number> {
  let n = 0;
  for (const one of scouts) {
    const moved = await transitionOpportunity({
      id: one.id,
      from: ['DISCOVERED', 'EVIDENCE_CARD'],
      to: 'ARCHIVED',
      archivedReason: `${SUPERSEDED_PREFIX} its research informed the routes proposed next (${filedTitles.slice(0, 4).join('; ')})`.slice(0, 400),
    }).catch(() => false);
    if (moved) n += 1;
  }
  return n;
}

const PROPOSER_SYSTEM =
  "You are Brain's commercial strategist. You read the owner first and propose whole, concrete routes to money built from what they have, inside their limits. Answer with exactly one JSON object.";
const CRITIC_SYSTEM =
  "You are Brain's sceptical commercial reviewer. You judge whether each proposed route can really put money in this owner's hand inside their limits, repair what a changed field fixes, drop the rest and rank the survivors. Answer with exactly one JSON object.";
/**
 * Routes a critique must leave standing; with fewer, replacements are asked for once. One: a
 * critique that keeps one well-grounded route has answered, and asking for more only to reach a
 * count is the forced variety the evidence did not support.
 */
export const ROUTES_MIN_SURVIVING = 1;

/** What the critique pass did, as the goal's record keeps it. */
export interface CritiqueRecord {
  /** CRITIQUED: a critic judged and ranked the routes. FAILED: no critic answered, so the single pass stands. SKIPPED: nothing to judge. */
  outcome: 'CRITIQUED' | 'FAILED' | 'SKIPPED';
  model: string | null;
  reason: string | null;
  reviews: { title: string; verdict: RouteReview['verdict']; score: number; failed: RouteRule[]; why: string }[];
  /** Route titles, best first, as filed. */
  ranking: string[];
  replacementsAsked: boolean;
  replacements: number;
}

type Ask = (chat: ChatFn, system: string, content: string, maxTokens: number) => Promise<{ content: string; error?: string | null }>;

/**
 * The second look at a proposal: a critic scores every route against
 * `ROUTE_RULES` and the owner's profile, repairs or drops what fails and ranks
 * the rest; with fewer than `ROUTES_MIN_SURVIVING` left, replacements are asked
 * for once, naming what failed. Inside the same budget and chat path as the
 * proposal; when no critic answers in time the proposal stands as it was,
 * unranked, and the record says why.
 */
async function critiqueAndRevise(
  ctx: RouteContext,
  first: { routes: ProposedRoute[]; model: string; owner: OwnerProfile | null },
  chats: readonly { label: string; chat: ChatFn }[],
  ask: Ask,
  left: () => number,
): Promise<{ ranked: RankedRoute[]; rejected: RejectedRoute[]; owner: OwnerProfile | null; critique: CritiqueRecord }> {
  const record = (outcome: CritiqueRecord['outcome'], fields: Partial<CritiqueRecord>): CritiqueRecord => ({ outcome, model: null, reason: null, reviews: [], ranking: [], replacementsAsked: false, replacements: 0, ...fields });
  const asProposed = (outcome: CritiqueRecord['outcome'], reason: string) => ({
    ranked: first.routes.map((route, i) => ({ route, rank: i + 1, score: null, why: '', repaired: false })),
    rejected: [] as RejectedRoute[],
    owner: first.owner,
    critique: record(outcome, { reason }),
  });
  if (first.routes.length === 0) return asProposed('SKIPPED', 'no route passed the limits to critique');
  // The model that proposed critiques first; the others after it, in their order.
  const order = [...chats.filter((one) => one.label === first.model), ...chats.filter((one) => one.label !== first.model)];
  const failures: string[] = [];
  let critique: RouteCritique | null = null;
  let critic: string | null = null;
  for (const { label, chat } of order) {
    if (left() < 5_000) {
      failures.push('out of time');
      break;
    }
    const r = await ask(chat, CRITIC_SYSTEM, critiquePrompt(ctx, first.routes, first.owner), 3000);
    if (r.error) {
      failures.push(`${label}: ${r.error.slice(0, 80)}`);
      continue;
    }
    critique = critiqueJson(r.content, first.routes.length);
    if (critique) {
      critic = label;
      break;
    }
    failures.push(`${label}: no parseable critique`);
  }
  if (!critique) return asProposed('FAILED', failures.join('; ').slice(0, 240) || 'out of time');
  const owner = critique.owner ?? first.owner;
  const applied = applyCritique(first.routes, critique, ctx);
  const ranked = [...applied.ranked];
  const rejected = [...applied.dropped];
  let replacementsAsked = false;
  let replacements = 0;
  if (ranked.length < ROUTES_MIN_SURVIVING && left() >= 5_000) {
    replacementsAsked = true;
    const content = replacementPrompt(ctx, ROUTES_PER_ASK - ranked.length, ranked.map((one) => one.route), applied.dropped);
    for (const { label, chat } of order) {
      if (left() < 5_000) break;
      const r = await ask(chat, PROPOSER_SYSTEM, content, 4000);
      if (r.error) {
        failures.push(`replacements, ${label}: ${r.error.slice(0, 80)}`);
        continue;
      }
      const more = parseRoutes(routesJson(r.content), ctx);
      if (more.routes.length === 0 && more.rejected.length === 0) {
        failures.push(`replacements, ${label}: no parseable routes`);
        continue;
      }
      rejected.push(...more.rejected);
      for (const route of more.routes) {
        if (ranked.some((one) => one.route.key === route.key)) {
          rejected.push({ title: route.title, why: 'a replacement with the same buyer and offer as a route the critique kept', rule: 'DUPLICATE' });
          continue;
        }
        ranked.push({ route, rank: ranked.length + 1, score: null, why: 'a replacement asked for after the critique, ranked after the routes it kept', repaired: false });
        replacements += 1;
      }
      break;
    }
  }
  const titleOf = (index: number) => first.routes[index - 1]?.title ?? `#${index}`;
  return {
    ranked,
    rejected,
    owner,
    critique: record('CRITIQUED', {
      model: critic,
      reason: failures.length ? failures.join('; ').slice(0, 240) : null,
      reviews: critique.reviews.map((one) => ({ title: titleOf(one.index), verdict: one.verdict, score: RULE_KEYS.reduce((sum, rule) => sum + (one.scores[rule] ?? 0), 0), failed: one.failed, why: one.why })),
      ranking: ranked.map((one) => one.route.title),
      replacementsAsked,
      replacements,
    }),
  };
}

/**
 * Propose and file a goal's routes, once per interval and within the daily
 * bound. Never throws on a model failure; records what happened on the goal.
 */
export async function proposeGoalRoutes(input: { goalId: string; now?: Date; heldTitles?: readonly string[]; retryOnly?: boolean }, deps: RouteDeps = {}): Promise<RouteOutcome> {
  const now = input.now ?? new Date(deps.clock?.() ?? Date.now());
  const goal = await getWorkstream(input.goalId);
  if (!goal || goal.archivedAt || goal.cancelledAt) return { kind: 'NOT_DUE', reason: 'no live goal' };
  if (goal.pausedAt) return { kind: 'NOT_DUE', reason: 'the goal is paused' };
  // The goal's own record first: it is the cheap answer on most passes, and the target is read only when an ask is due.
  const asks = await workstreamEventsOfKind(goal.id, ROUTE_EVENT, new Date(now.getTime() - Math.max(DAY, ROUTE_PROPOSAL_EVERY_MS)).toISOString(), 50);
  /*
   * The cheap answer first, from the goal's own record alone; the project's
   * research is counted only when that says no and the last ask recorded how
   * much it had seen — new findings can then make a fresh, grounded ask due.
   * Production, 2026-11-25 (ec0131a): reading the claims before this check, on
   * every plan pass for every live goal, put a claim query per goal per pass on
   * a database already contended, and fresh goals went 75 minutes unplanned.
   */
  let due = routeAskDue(asks, now, { retryOnly: input.retryOnly === true });
  const last = asks[0];
  if (!due.due && goal.projectId && last && typeof last.detail['findingsSeen'] === 'number' && now.getTime() - Date.parse(last.createdAt) >= ROUTE_RETRY_AFTER_FAILURE_MS) {
    const count = deps.claims
      ? (await deps.claims(goal.projectId).catch(() => [] as ResearchClaim[])).length
      : await projectEvidenceClaimCount(goal.projectId).catch(() => 0);
    due = routeAskDue(asks, now, { retryOnly: input.retryOnly === true, findings: count });
  }
  if (!due.due) return { kind: 'NOT_DUE', reason: due.reason };
  const claimsOf = deps.claims ?? ((projectId: string) => projectEvidenceClaims(projectId, FINDINGS_COUNTED));
  const claims = goal.projectId ? await claimsOf(goal.projectId).catch(() => [] as ResearchClaim[]) : [];
  // What this ask has seen, counted the way the next due check counts it (the listing above is capped).
  const seenCount = deps.claims || !goal.projectId ? claims.length : await projectEvidenceClaimCount(goal.projectId).catch(() => claims.length);
  const target = await readTarget(goal, now);
  if (!target || target.achieved) return { kind: 'NOT_DUE', reason: 'no target still open' };
  const gate = await discoveryAllowed(target.projectId);
  if (!gate.allowed || !gate.mode) return { kind: 'NOT_DUE', reason: gate.reason ?? 'the project is not searching' };
  const read = await routeContext(goal, target, input.heldTitles ?? [], { ...deps, claims: async () => claims });
  if (!read) return { kind: 'NOT_DUE', reason: 'no time or money left to plan for' };
  const liveRoutes = read.routes.filter((one) => one.state !== 'ARCHIVED' && one.state !== 'DECLINED');
  if (input.retryOnly && !due.onFindings && liveRoutes.length > 0) {
    return { kind: 'NOT_DUE', reason: 'the goal already holds live routes; the search pass asks on the ordinary interval' };
  }
  const findings = read.ctx.findings ?? [];
  /*
   * Which step of the loop this ask is. With too little research to reason
   * from and nothing priced yet, Brain scouts: directions, no figures, each
   * asking its decisive unknown first. Once research has come back — or the
   * goal already holds priced routes — it proposes routes from the findings.
   * While its scouted directions are still being researched, it waits for them
   * rather than guessing again, until the ordinary interval has passed.
   */
  const pricedLive = liveRoutes.filter((one) => !read.scoutIds.has(one.id));
  const enoughFindings = findings.length >= FINDINGS_FOR_ROUTES;
  if (!enoughFindings && read.liveScouts.length > 0 && !due.onFindings) {
    const last = asks[0];
    if (last && now.getTime() - Date.parse(last.createdAt) < ROUTE_PROPOSAL_EVERY_MS) {
      return { kind: 'NOT_DUE', reason: `${read.liveScouts.length} scouted direction(s) are being researched; routes are proposed from what they find` };
    }
  }
  const stage: RouteStage = !enoughFindings && pricedLive.length === 0 && read.liveScouts.length === 0 ? 'SCOUT' : 'ROUTE';
  const filedToday = read.routes.filter((one) => !read.scoutIds.has(one.id) && now.getTime() - Date.parse(one.createdAt) < DAY).length;
  const room = stage === 'SCOUT' ? DIRECTIONS_PER_ASK : ROUTES_PER_DAY - filedToday;
  if (room <= 0) return { kind: 'NOT_DUE', reason: `${filedToday} routes were filed for this goal in the last day` };

  // The ask is stamped at the moment it was judged due, the same clock the next due check reads it against.
  const record = (summary: string, detail: Record<string, unknown>) =>
    recordWorkstreamEvent({ workstreamId: goal.id, kind: ROUTE_EVENT, summary: summary.slice(0, 400), detail: { ...detail, stage, findingsSeen: seenCount, findingsShown: findings.length }, actorRef: 'BRAIN', at: now.toISOString() });
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + ROUTE_BUDGET_MS;
  const chats = await (deps.chats ?? (() => operatorChats(deps, () => Math.max(5_000, Math.min(ROUTE_ATTEMPT_MS, deadline - clock())))))().catch(() => []);
  if (chats.length === 0) {
    const reason = 'no operator model is configured, so no route was proposed from the objective';
    await record(`Routes: none proposed — ${reason}.`, { outcome: 'NO_MODEL', reason });
    return { kind: 'NO_MODEL', reason };
  }
  read.ctx.today = now.toISOString().slice(0, 10);
  // What the last ask's review dropped is not offered again as if new: the next ask sees why.
  const reviewDropped = ((asks[0]?.detail['rejected'] as RejectedRoute[] | undefined) ?? []).filter((one) => one && one.rule === 'CRITIQUE');
  if (reviewDropped.length) read.ctx.refuted = [...read.ctx.refuted, ...reviewDropped.slice(0, 8).map((one) => ({ title: one.title, why: one.why }))];
  const failures: string[] = [];
  const ask = (chat: ChatFn, system: string, content: string, maxTokens: number) =>
    chat([{ role: 'system', content: system }, { role: 'user', content }], undefined, maxTokens).catch((error: unknown) => ({ content: '', error: String((error as Error)?.message ?? error) }));
  const startDives = async (): Promise<string[]> => {
    const start = deps.startDives ?? (async (projectId: string) => (await import('../cash/validation.ts')).startValidations({ projectId }));
    return (await start(target.projectId).catch(() => [])).map((one) => one.opportunityId);
  };

  if (stage === 'SCOUT') {
    const prompt = directionPrompt(read.ctx);
    let got: { directions: ProposedDirection[]; rejected: RejectedRoute[]; model: string; owner: OwnerProfile | null } | null = null;
    for (const { label, chat } of chats) {
      if (deadline - clock() < 5_000) break;
      const r = await ask(chat, PROPOSER_SYSTEM, prompt, 3500);
      if (r.error) {
        failures.push(`${label}: ${r.error.slice(0, 80)}`);
        continue;
      }
      const one = parseDirections(r.content, read.ctx);
      if (one.directions.length === 0 && one.rejected.length === 0) {
        failures.push(`${label}: no parseable directions`);
        continue;
      }
      got = { ...one, model: label, owner: ownerProfileOf(r.content) };
      break;
    }
    if (!got) {
      const reason = `no model answered with directions (${failures.join('; ').slice(0, 240) || 'out of time'})`;
      await record(`Routes: none proposed — ${reason}.`, { outcome: 'NO_ANSWER', reason });
      return { kind: 'NO_ANSWER', reason };
    }
    // A review before research is spent: what fails a rule no research could fix is dropped, the rest ranked.
    let review: RouteCritique | null = null;
    let reviewer: string | null = null;
    if (got.directions.length > 0) {
      const order = [...chats.filter((one) => one.label === got!.model), ...chats.filter((one) => one.label !== got!.model)];
      for (const { label, chat } of order) {
        if (deadline - clock() < 5_000) break;
        const r = await ask(chat, CRITIC_SYSTEM, directionCritiquePrompt(read.ctx, got.directions), 2500);
        if (r.error) continue;
        review = critiqueJson(r.content, got.directions.length);
        if (review) {
          reviewer = label;
          break;
        }
      }
    }
    const reviewed = applyDirectionCritique(got.directions, review);
    got.rejected.push(...reviewed.dropped);
    const existingKeys = new Set(read.routes.map((one) => (one.externalRecordId ?? '').slice(goalRoutePrefix(goal.id).length)));
    const filed: string[] = [];
    const existing: string[] = [];
    for (const direction of reviewed.kept) {
      if (existingKeys.has(direction.key)) {
        existing.push(direction.title);
        continue;
      }
      if (filed.length >= room) break;
      filed.push(await fileDirection(goal, target, gate.mode.id, gate.mode.ownerUserId, direction, got.model));
      existingKeys.add(direction.key);
    }
    await record(
      `Routes: ${filed.length} direction(s) named to scout before anything is priced${existing.length ? `, ${existing.length} already held` : ''}${got.rejected.length ? `, ${got.rejected.length} rejected (${rejectionSummary(got.rejected)})` : ''}; each one's research asks its decisive unknown first.`,
      { outcome: 'PROPOSED', model: got.model, filed, existing, rejected: got.rejected, rejectedByRule: rejectionCounts(got.rejected), owner: got.owner, directions: got.directions.map((one) => ({ title: one.title, decisiveUnknown: one.decisiveUnknown })), reviewer, reviewed: !!review },
    );
    const dived = filed.length > 0 ? await startDives() : [];
    return { kind: 'PROPOSED', filed, existing, rejected: got.rejected, model: got.model, dived, critique: review ? 'CRITIQUED' : 'SKIPPED' };
  }

  const prompt = routePrompt(read.ctx);
  let parsed: { routes: ProposedRoute[]; rejected: RejectedRoute[]; model: string; owner: OwnerProfile | null; rethink: string | null } | null = null;
  for (const { label, chat } of chats) {
    if (deadline - clock() < 5_000) break;
    const r = await ask(chat, PROPOSER_SYSTEM, prompt, 4000);
    if (r.error) {
      failures.push(`${label}: ${r.error.slice(0, 80)}`);
      continue;
    }
    const one = parseRoutes(routesJson(r.content), read.ctx);
    if (one.routes.length === 0 && one.rejected.length === 0) {
      failures.push(`${label}: no parseable routes`);
      continue;
    }
    parsed = { ...one, model: label, owner: ownerProfileOf(r.content), rethink: rethinkOf(r.content) };
    break;
  }
  if (!parsed) {
    const reason = `no model answered with routes (${failures.join('; ').slice(0, 240) || 'out of time'})`;
    await record(`Routes: none proposed — ${reason}.`, { outcome: 'NO_ANSWER', reason });
    return { kind: 'NO_ANSWER', reason };
  }
  const reviewed = await critiqueAndRevise(read.ctx, parsed, chats, ask, () => deadline - clock());
  const rejected = [...parsed.rejected, ...reviewed.rejected];
  const claimById = new Map(claims.map((one) => [one.id, one] as const));
  const existingKeys = new Set(read.routes.map((one) => (one.externalRecordId ?? '').slice(goalRoutePrefix(goal.id).length)));
  const filed: string[] = [];
  const filedTitles: string[] = [];
  const existing: string[] = [];
  for (const one of reviewed.ranked) {
    if (existingKeys.has(one.route.key)) {
      existing.push(one.route.title);
      continue;
    }
    if (filed.length >= room) break;
    const place = reviewed.critique.outcome === 'CRITIQUED' ? { rank: one.rank, of: reviewed.ranked.length, why: one.why } : null;
    filed.push(await fileRoute(goal, target, gate.mode.id, gate.mode.ownerUserId, one.route, parsed.model, place, deps, claimById));
    filedTitles.push(one.route.title);
    existingKeys.add(one.route.key);
  }
  // The directions whose research informed these routes step aside for them; their findings stay the project's.
  const superseded = filed.length > 0 ? await supersedeScouts(read.liveScouts, filedTitles) : 0;
  const grounded = reviewed.ranked.filter((one) => filedTitles.includes(one.route.title) && Object.keys(one.route.grounds.claims).length > 0).length;
  // What the evidence taught, kept where the goal's learning is kept, so the next ask and a reader both have it.
  if (parsed.rethink && (read.ctx.refuted.length > 0 || (read.ctx.scouted ?? []).some((one) => one.refutedBy))) {
    await recordOperatorLearningSafe(goal.id, parsed.rethink, read.ctx.refuted.map((one) => `${one.title}: ${one.why}`).join(' | '));
  }
  // Each rejected route keeps its rule and reason in the detail, and the summary counts them by rule, so a later read shows why.
  await record(
    `Routes: ${filed.length} proposed${findings.length ? ` from ${findings.length} research finding(s)` : ' from the objective'} and filed as openings${grounded ? ` (${grounded} citing findings)` : ''}${existing.length ? `, ${existing.length} already held` : ''}${rejected.length ? `, ${rejected.length} rejected (${rejectionSummary(rejected)})` : ''}${reviewed.critique.outcome === 'CRITIQUED' ? ', ranked by a critique' : `; no critique (${reviewed.critique.reason ?? 'unavailable'})`}${superseded ? `; ${superseded} scouted direction(s) superseded` : ''}.`,
    {
      outcome: 'PROPOSED',
      model: parsed.model,
      filed,
      existing,
      rejected,
      rejectedByRule: rejectionCounts(rejected),
      refutedShown: read.ctx.refuted.length,
      owner: reviewed.owner,
      critique: reviewed.critique,
      grounded,
      superseded,
      rethink: parsed.rethink,
    },
  );
  /*
   * The routes' deep dives start now, inside the project's dive room, rather
   * than when the tick's serial project walk next reaches this project.
   * Production, 2026-11-25: nine fresh goals held six route openings each and
   * no dive had started 75 minutes later; the walk that would start them had
   * been running for 38 minutes and these projects were last in it.
   */
  const dived = filed.length > 0 ? await startDives() : [];
  return { kind: 'PROPOSED', filed, existing, rejected, model: parsed.model, dived, critique: reviewed.critique.outcome };
}

/** Claims counted to tell whether research has come back since the last ask. */
export const FINDINGS_COUNTED = FINDINGS_SHOWN * 5;

/** The "rethink" a reply carries: what the evidence taught, or null. Pure. */
export function rethinkOf(text: string): string | null {
  for (const obj of objectsIn(text)) {
    const value = str(obj['rethink'], 600);
    if (value && !/^(null|none|n\/a)$/i.test(value)) return value;
  }
  return null;
}

async function recordOperatorLearningSafe(goalId: string, lesson: string, evidence: string): Promise<void> {
  const { recordOperatorLearning } = await import('../../repos/operator.ts');
  await recordOperatorLearning({ goalId, runId: null, lesson: `Route rethink: ${lesson}`, evidence: evidence.slice(0, 2000) || 'research findings on this goal' }).catch(() => undefined);
}

const inFlight = new Map<string, Promise<RouteOutcome | null>>();
/** Goals waiting for a place, in the order they asked: each asks when one frees. */
const waiting = new Map<string, { heldTitles: readonly string[]; deps: RouteDeps; retryOnly: boolean; resolve: (outcome: RouteOutcome | null) => void; ask: Promise<RouteOutcome | null> }>();

/** Tests: every ask running or waiting in this process, settled. */
export async function settleRouteAsks(): Promise<void> {
  while (inFlight.size > 0 || waiting.size > 0) {
    await Promise.all([...inFlight.values(), ...[...waiting.values()].map((one) => one.ask)]);
  }
}

function startAsk(goalId: string, heldTitles: readonly string[], now: Date | null, deps: RouteDeps, retryOnly: boolean): Promise<RouteOutcome | null> {
  const run = proposeGoalRoutes({ goalId, ...(now ? { now } : {}), heldTitles, retryOnly }, deps)
    .catch((error: unknown) => {
      console.warn(`goal ${goalId}: route proposal: ${String((error as Error)?.message ?? error)}`);
      return null;
    })
    .finally(() => {
      inFlight.delete(goalId);
      const next = waiting.entries().next();
      if (!next.done) {
        const [nextId, held] = next.value;
        waiting.delete(nextId);
        // Asked when its place frees, so it reads its own clock then.
        void startAsk(nextId, held.heldTitles, null, held.deps, held.retryOnly).then(held.resolve);
      }
    });
  inFlight.set(goalId, run);
  return run;
}

/**
 * From the goal search pass: ask in the background (the pass never waits on a
 * model), at most one ask per goal and `ROUTE_MAX_IN_FLIGHT` across the
 * process. A goal that finds every place taken waits for the next one in the
 * order it asked, rather than being turned away until its next plan read.
 * Production, 2026-11-25: twelve goals created together, two places, and two
 * of the goals had no route ask recorded 70 minutes later. Returns the ask
 * (waiting included), for a caller that wants to wait. Never throws.
 *
 * `retryOnly`: the plan pass's own call, made for every live goal on every
 * pass whatever it reads or widens (`advanceGoalPlans`) — an ask only for a
 * goal never asked, or with no live route and a last ask that yielded none
 * (`routeAskDue`).
 */
export function armRouteProposal(goalId: string, heldTitles: readonly string[], now: Date, deps: RouteDeps = {}, options: { retryOnly?: boolean } = {}): Promise<RouteOutcome | null> {
  const retryOnly = options.retryOnly === true;
  const running = inFlight.get(goalId);
  if (running) return running;
  const queued = waiting.get(goalId);
  if (queued) {
    // The search pass's ordinary ask outranks the plan pass's retry-only one for the same goal.
    if (!retryOnly) queued.retryOnly = false;
    return queued.ask;
  }
  if (inFlight.size < ROUTE_MAX_IN_FLIGHT) return startAsk(goalId, heldTitles, now, deps, retryOnly);
  let resolve: (outcome: RouteOutcome | null) => void = () => undefined;
  const ask = new Promise<RouteOutcome | null>((done) => {
    resolve = done;
  });
  waiting.set(goalId, { heldTitles, deps, retryOnly, resolve, ask });
  return ask;
}
