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
import { breaksOperatingModel, OPERATING_MODEL_SENTENCE, operatingFactsOf, operatingFit } from '../../domain/operatingModel.ts';
import { goalRoutePrefix, routeRecordId, ROUTE_SEARCHES_FIELD } from '../../domain/routeOrigin.ts';
import { chatFor, type ChatFn } from '../cheap/modelBench.ts';
import { challengerModels } from '../operator/decisions.ts';
import { getWorkstream, linkWorkstream, recordWorkstreamEvent, workstreamEventsOfKind } from '../../repos/register.ts';
import { createOpportunity, opportunitiesWithRecordPrefix, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { cardFactsFor, recordRecommendationFact } from '../../repos/cashCardFacts.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { executionFrame } from '../cash/discovery.ts';
import { DISQUALIFIED_FIELD } from '../cash/engineCard.ts';
import { EXCLUSION_CLASSES, excludedBy, goalExclusions } from '../cash/exclusions.ts';
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
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  offer: string;
  price: number;
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
  resources: string | null;
  industry: string | null;
  recurring: boolean;
  exclusions: string[];
  delivers: string[];
  held: string[];
  refuted: { title: string; why: string }[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const strs = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((one) => str(one, 160)).filter((one): one is string => !!one).slice(0, n) : []);
const money = (n: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${Math.round(n).toLocaleString('en-US')}`;

/** The stable key of a route within a goal: who pays for what, never its wording. Pure. */
export function routeKey(payer: string, offer: string): string {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${norm(payer)}|${norm(offer)}`).digest('hex').slice(0, 16);
}

/**
 * The prompt: the objective, the owner's limits stated as hard rules, what
 * Brain proves it delivers, what the goal already holds and what research
 * refuted. No industry template: the routes are the model's to reason. Pure.
 */
export function routePrompt(ctx: RouteContext, k: number = ROUTES_PER_ASK): string {
  const limits = [
    `The money still needed: ${money(ctx.remaining, ctx.currency)} (${ctx.currency}), collected within ${ctx.daysLeft} day(s).`,
    ctx.capitalLimit !== null ? `Capital: at most ${money(ctx.capitalLimit, ctx.currency)} may be tied up before money comes back. A route needing more is not allowed.` : 'Capital: the owner set no figure; prefer routes that tie up little.',
    ctx.hoursLimit !== null ? `Owner's time: at most ${ctx.hoursLimit} hour(s) of the owner's own work in the whole window. Routes must fit inside it.` : 'Owner\'s time: no figure set; the owner does no routine personal work.',
    ctx.resources ? `What the owner said they have, verbatim: ${ctx.resources}` : '',
    `Time: the first money must settle inside ${ctx.daysLeft} day(s). A buyer who pays in arrears, on invoice terms or after a long sales cycle that would land later is not allowed.`,
    ctx.industry ? `The owner confined this goal to: ${ctx.industry}. Every route must be in it.` : 'No industry is excluded: choose on economics, time to cash and whether it can be done.',
    ctx.recurring ? 'The target is monthly recurring revenue: every route must be billed monthly.' : '',
    ctx.exclusions.length ? `The owner excluded: ${ctx.exclusions.join('; ')}.` : '',
    OPERATING_MODEL_SENTENCE,
  ].filter(Boolean);
  return [
    `OBJECTIVE (the owner's own words, verbatim — every skill, asset, place and refusal in them binds every route): ${ctx.objective}`,
    `LIMITS (hard rules):\n- ${limits.join('\n- ')}`,
    `WHAT BRAIN ITSELF PROVABLY PRODUCES (performer BRAIN may only sell one of these): ${ctx.delivers.length ? ctx.delivers.join(', ') : 'nothing proved yet — use SUBCONTRACTOR routes'}.`,
    ctx.held.length ? `ALREADY HELD for this goal (propose different routes): ${ctx.held.slice(0, 20).join(' | ')}` : '',
    ctx.refuted.length ? `REFUTED OR STOPPED by research or a person (do not propose these again or near-copies; reason about why they failed):\n- ${ctx.refuted.slice(0, 12).map((one) => `${one.title}: ${one.why}`).join('\n- ')}` : '',
    `Propose ${k} concrete, different commercial routes that could each collect real money for this objective inside every limit above. Each is one whole transaction: a specific kind of buyer who pays, a specific offer, a price such buyers plausibly pay, how they are reached, who delivers it and at what direct cost, how long until the first money settles, and roughly how many such buyers exist. No two routes may share a buyer type, and use at least three different mechanisms — not variations of one idea. Derive the buyers from the owner's own words (their skills, assets, location and refusals) rather than from buyers you would propose for any objective; a route that would fit any request equally is a poor route. Each route states in ownerFit how it uses or respects what the owner said (skills, assets, location, what they will not do). Prefer fast cash, repeat buyers, and work Brain or a paid subcontractor does.`,
    'Reply with exactly one JSON object and nothing else:',
    `{"routes":[{"title":"short name","mechanism":one of ${JSON.stringify(CASH_MECHANISMS)},"industry":"industry","payer":"the buyer segment who pays","offer":"what is sold","price":number per sale in ${ctx.currency},"monthly":true|false,"channel":"how buyers are reached","performer":"BRAIN"|"SUBCONTRACTOR"|"OWNER","fulfiller":"who delivers it","brainDeliverable":"one of the proved deliverables when performer is BRAIN, else null","directCost":number per sale,"capital":number tied up before the first payment,"ownerHoursPerDeal":number,"daysToFirstCash":number,"buyerCount":number of such buyers that exist,"volumeBasis":"why that count","assumptions":"what this route assumes that research must check","ownerFit":"how it uses or respects the owner's stated skills, assets, location and refusals","searches":{"price":["search terms or sources that would show the price"],"demand":["... a dated sign of current demand"],"volume":["... how many such buyers exist"]}}]}`,
    'Figures are your estimates and will be researched; never present them as facts.',
  ]
    .filter(Boolean)
    .join('\n\n');
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

/**
 * The routes a model's answer proposes, each checked against the limits; a
 * route that breaks one is rejected with the reason, never adjusted to fit.
 * Pure.
 */
export function parseRoutes(obj: Record<string, unknown> | null, ctx: RouteContext): { routes: ProposedRoute[]; rejected: { title: string; why: string }[] } {
  const routes: ProposedRoute[] = [];
  const rejected: { title: string; why: string }[] = [];
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
    const reject = (why: string) => rejected.push({ title: name, why });
    if (!title || !payer || !offer || !channel) {
      reject('a route needs a title, a payer, an offer and a channel');
      continue;
    }
    const mechanism = str(r['mechanism'], 40)?.toUpperCase();
    if (!mechanism || !(CASH_MECHANISMS as readonly string[]).includes(mechanism)) {
      reject(`mechanism "${mechanism ?? ''}" is not one Brain records`);
      continue;
    }
    const price = num(r['price']);
    if (price === null || price <= 0) {
      reject('no positive price');
      continue;
    }
    const performerRaw = str(r['performer'], 20)?.toUpperCase();
    const performer: Performer = (PERFORMERS as readonly string[]).includes(performerRaw ?? '') ? (performerRaw as Performer) : 'SUBCONTRACTOR';
    const monthly = r['monthly'] === true;
    const directCost = Math.max(0, num(r['directCost']) ?? 0);
    const capital = Math.max(0, num(r['capital']) ?? 0);
    const ownerHoursPerDeal = Math.max(0, num(r['ownerHoursPerDeal']) ?? (performer === 'OWNER' ? 1 : 0));
    const days = num(r['daysToFirstCash']);
    const buyerCount = num(r['buyerCount']);
    const delivered = str(r['brainDeliverable'], 60);
    const brainDeliverable = performer === 'BRAIN' ? (ctx.delivers.find((one) => one.toLowerCase() === (delivered ?? '').toLowerCase()) ?? null) : null;
    if (performer === 'BRAIN' && !brainDeliverable) {
      reject('Brain performs it, but it is none of the deliverables Brain has proved');
      continue;
    }
    if (days === null || days < 0) {
      reject('no days to first cash');
      continue;
    }
    if (days >= ctx.daysLeft) {
      reject(`the first money settles after ${days} day(s), beyond the ${ctx.daysLeft} left`);
      continue;
    }
    if (ctx.capitalLimit !== null && capital > ctx.capitalLimit) {
      reject(`ties up ${money(capital, ctx.currency)}, more than the ${money(ctx.capitalLimit, ctx.currency)} allowed`);
      continue;
    }
    if (ctx.recurring && !monthly) {
      reject('the target is monthly recurring revenue and this is not billed monthly');
      continue;
    }
    if (directCost >= price) {
      reject('its direct cost is not below its price');
      continue;
    }
    if (ctx.hoursLimit !== null) {
      const deals = Math.max(1, Math.ceil(ctx.remaining / Math.max(1, price - directCost)));
      const hours = ownerHoursPerDeal * deals;
      if (hours > ctx.hoursLimit) {
        reject(`needs about ${Math.round(hours)} owner hour(s) for the ${deals} sale(s) the target takes, more than the ${ctx.hoursLimit} allowed`);
        continue;
      }
    }
    const fulfiller = str(r['fulfiller'], 200) ?? (performer === 'BRAIN' ? `Brain (${brainDeliverable})` : performer === 'OWNER' ? 'The owner' : 'A subcontractor to be named');
    const industry = str(r['industry'], 80) ?? 'unspecified';
    const fit = operatingFit(operatingFactsOf({ title, offerScope: offer, fulfillmentOwner: performer === 'OWNER' ? 'The owner, personally' : fulfiller, mechanism }));
    if (breaksOperatingModel(fit)) {
      reject(`needs the owner's physical work: ${fit.because}`);
      continue;
    }
    const excluded = excludedBy(`${title} ${payer} ${offer} ${industry}`, exclusions as never);
    if (excluded) {
      reject(`the owner excluded ${EXCLUSION_CLASSES[excluded].label}`);
      continue;
    }
    const ownerFit = str(r['ownerFit'], 300);
    if (!ownerFit) {
      reject("it does not say how it uses or respects the owner's stated skills, assets, location and refusals");
      continue;
    }
    const key = routeKey(payer, offer);
    if (routes.some((one) => one.key === key)) {
      reject('the same buyer and offer as another route in this answer');
      continue;
    }
    if (routes.some((one) => routeKey(one.payer, '') === routeKey(payer, ''))) {
      reject('the same buyer type as another route in this answer');
      continue;
    }
    const searches = (r['searches'] && typeof r['searches'] === 'object' ? r['searches'] : {}) as Record<string, unknown>;
    routes.push({
      key,
      title,
      mechanism: mechanism as CashMechanism,
      industry,
      payer,
      offer,
      price,
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
    });
  }
  return { routes, rejected };
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
}

export type RouteOutcome =
  | { kind: 'NOT_DUE'; reason: string }
  | { kind: 'NO_MODEL'; reason: string }
  | { kind: 'NO_ANSWER'; reason: string }
  | { kind: 'PROPOSED'; filed: string[]; existing: string[]; rejected: { title: string; why: string }[]; model: string; dived: string[] };

/**
 * Whether a goal's routes may be asked for now, from its own recorded asks
 * (newest first). After an ask a model answered: once per
 * `ROUTE_PROPOSAL_EVERY_MS`. After one no model answered (NO_ANSWER): again
 * after `ROUTE_RETRY_AFTER_FAILURE_MS`, at most `ROUTE_FAILED_ASKS_PER_DAY` in
 * any day, then the ordinary interval. NO_MODEL is configuration, not a
 * failed answer, and waits the ordinary interval. Pure.
 */
export function routeAskDue(asks: readonly { createdAt: string; detail: Record<string, unknown> }[], now: Date): { due: true } | { due: false; reason: string } {
  const last = asks[0];
  if (!last) return { due: true };
  const since = now.getTime() - Date.parse(last.createdAt);
  const failed = last.detail['outcome'] === 'NO_ANSWER';
  const failedToday = asks.filter((one) => one.detail['outcome'] === 'NO_ANSWER' && now.getTime() - Date.parse(one.createdAt) < DAY).length;
  const wait = failed && failedToday < ROUTE_FAILED_ASKS_PER_DAY ? ROUTE_RETRY_AFTER_FAILURE_MS : ROUTE_PROPOSAL_EVERY_MS;
  if (since >= wait) return { due: true };
  return {
    due: false,
    reason: failed
      ? `routes were last asked for at ${last.createdAt} and no model answered (${failedToday} failed ask(s) today); asked again ${Math.round(wait / 60_000)} minutes after`
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

/** The goal's own route openings, and those research or a person refuted or stopped. */
async function goalRoutes(projectId: string, goalId: string): Promise<{ all: CashOpportunity[]; refuted: { title: string; why: string }[] }> {
  const all = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));
  const refuted: { title: string; why: string }[] = [];
  for (const one of all) {
    if (one.state === 'ARCHIVED' || one.state === 'DECLINED') {
      refuted.push({ title: one.title, why: `${one.state === 'ARCHIVED' ? 'stopped' : 'declined'}${(one.archivedReason ?? one.declinedReason) ? `: ${(one.archivedReason ?? one.declinedReason)!.slice(0, 160)}` : ''}` });
      continue;
    }
    const ruledOut = (await cardFactsFor(one.id)).find((fact) => fact.field === DISQUALIFIED_FIELD && fact.value.trim());
    if (ruledOut) refuted.push({ title: one.title, why: `research found it ruled out: ${ruledOut.value.slice(0, 160)}` });
  }
  return { all, refuted };
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
export async function routeContext(goal: Workstream, target: TargetReading, heldTitles: readonly string[], deps: RouteDeps = {}): Promise<{ ctx: RouteContext; routes: CashOpportunity[] } | null> {
  if (target.daysLeft === null || target.daysLeft <= 0 || target.remainingCents <= 0) return null;
  const delivers = await (deps.delivers ?? (async (projectId: string, currency: string) => (await executionFrame(projectId, currency))?.delivers ?? []))(target.projectId, target.currency).catch(() => [] as string[]);
  const exclusions = await goalExclusions(goal).catch(() => []);
  const { all, refuted } = await goalRoutes(target.projectId, goal.id);
  const live = all.filter((one) => one.state !== 'ARCHIVED' && one.state !== 'DECLINED').map((one) => one.title);
  const capitalCents = target.capitalBeforeProofCents ?? target.capitalCeilingCents ?? target.scope?.capitalStatedCents ?? target.scope?.capitalAssumed?.cents ?? null;
  return {
    routes: all,
    ctx: {
      objective: ownerWords(goal),
      currency: target.currency,
      remaining: target.remainingCents / 100,
      daysLeft: target.daysLeft,
      capitalLimit: capitalCents === null ? null : capitalCents / 100,
      hoursLimit: target.hoursCeiling,
      resources: target.resources,
      industry: target.scope?.industry ?? null,
      recurring: target.scope?.recurring === 'MONTHLY',
      exclusions: exclusions.map((one) => EXCLUSION_CLASSES[one].label),
      delivers,
      held: [...new Set([...live, ...heldTitles])],
      refuted,
    },
  };
}

/** One route, filed as one goal-scoped opening with RECOMMENDATION facts only. Returns its id. */
async function fileRoute(goal: Workstream, target: TargetReading, cashModeId: string, ownerUserId: string, route: ProposedRoute, model: string): Promise<string> {
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
  ];
  for (const [field, value] of facts) {
    if (!value.trim()) continue;
    await recordRecommendationFact({ projectId: target.projectId, opportunityId: id, field, value: value.slice(0, 600), basis, assumptions, uncertainty });
  }
  await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: id, relation: 'SOURCE', label: 'proposed route', detail: { origin: 'ROUTE_PROPOSAL', key: route.key }, recordedBy: 'BRAIN', recordedByUserId: null });
  await recordCashEvent({
    projectId: target.projectId,
    opportunityId: id,
    kind: 'CASH_ROUTE_PROPOSED',
    actorRef: 'BRAIN',
    summary: `Brain proposed this route for a goal from its objective: ${route.title}. Every figure on it is a hypothesis until research establishes or refutes it.`.slice(0, 400),
    detail: { goalId: goal.id, key: route.key, model, performer: route.performer, price: route.price, monthly: route.monthly, ownerFit: route.ownerFit },
  });
  return id;
}

/**
 * Propose and file a goal's routes, once per interval and within the daily
 * bound. Never throws on a model failure; records what happened on the goal.
 */
export async function proposeGoalRoutes(input: { goalId: string; now?: Date; heldTitles?: readonly string[] }, deps: RouteDeps = {}): Promise<RouteOutcome> {
  const now = input.now ?? new Date(deps.clock?.() ?? Date.now());
  const goal = await getWorkstream(input.goalId);
  if (!goal || goal.archivedAt || goal.cancelledAt) return { kind: 'NOT_DUE', reason: 'no live goal' };
  if (goal.pausedAt) return { kind: 'NOT_DUE', reason: 'the goal is paused' };
  const target = await readTarget(goal, now);
  if (!target || target.achieved) return { kind: 'NOT_DUE', reason: 'no target still open' };
  const gate = await discoveryAllowed(target.projectId);
  if (!gate.allowed || !gate.mode) return { kind: 'NOT_DUE', reason: gate.reason ?? 'the project is not searching' };
  const asks = await workstreamEventsOfKind(goal.id, ROUTE_EVENT, new Date(now.getTime() - Math.max(DAY, ROUTE_PROPOSAL_EVERY_MS)).toISOString(), 50);
  const due = routeAskDue(asks, now);
  if (!due.due) return { kind: 'NOT_DUE', reason: due.reason };
  const read = await routeContext(goal, target, input.heldTitles ?? [], deps);
  if (!read) return { kind: 'NOT_DUE', reason: 'no time or money left to plan for' };
  const filedToday = read.routes.filter((one) => now.getTime() - Date.parse(one.createdAt) < DAY).length;
  const room = ROUTES_PER_DAY - filedToday;
  if (room <= 0) return { kind: 'NOT_DUE', reason: `${filedToday} routes were filed for this goal in the last day` };

  const record = (summary: string, detail: Record<string, unknown>) =>
    recordWorkstreamEvent({ workstreamId: goal.id, kind: ROUTE_EVENT, summary: summary.slice(0, 400), detail, actorRef: 'BRAIN' });
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + ROUTE_BUDGET_MS;
  const chats = await (deps.chats ?? (() => operatorChats(deps, () => Math.max(5_000, Math.min(ROUTE_ATTEMPT_MS, deadline - clock())))))().catch(() => []);
  if (chats.length === 0) {
    const reason = 'no operator model is configured, so no route was proposed from the objective';
    await record(`Routes: none proposed — ${reason}.`, { outcome: 'NO_MODEL', reason });
    return { kind: 'NO_MODEL', reason };
  }
  const prompt = routePrompt(read.ctx);
  const failures: string[] = [];
  let parsed: { routes: ProposedRoute[]; rejected: { title: string; why: string }[]; model: string } | null = null;
  for (const { label, chat } of chats) {
    if (deadline - clock() < 5_000) break;
    const r = await chat(
      [
        { role: 'system', content: "You are Brain's commercial strategist. You propose whole, concrete routes to money inside the owner's limits. Answer with exactly one JSON object." },
        { role: 'user', content: prompt },
      ],
      undefined,
      4000,
    ).catch((error: unknown) => ({ content: '', error: String((error as Error)?.message ?? error) }));
    if (r.error) {
      failures.push(`${label}: ${r.error.slice(0, 80)}`);
      continue;
    }
    const one = parseRoutes(routesJson(r.content), read.ctx);
    if (one.routes.length === 0 && one.rejected.length === 0) {
      failures.push(`${label}: no parseable routes`);
      continue;
    }
    parsed = { ...one, model: label };
    break;
  }
  if (!parsed) {
    const reason = `no model answered with routes (${failures.join('; ').slice(0, 240) || 'out of time'})`;
    await record(`Routes: none proposed — ${reason}.`, { outcome: 'NO_ANSWER', reason });
    return { kind: 'NO_ANSWER', reason };
  }
  const existingKeys = new Set(read.routes.map((one) => (one.externalRecordId ?? '').slice(goalRoutePrefix(goal.id).length)));
  const filed: string[] = [];
  const existing: string[] = [];
  for (const route of parsed.routes) {
    if (existingKeys.has(route.key)) {
      existing.push(route.title);
      continue;
    }
    if (filed.length >= room) break;
    filed.push(await fileRoute(goal, target, gate.mode.id, gate.mode.ownerUserId, route, parsed.model));
    existingKeys.add(route.key);
  }
  await record(
    `Routes: ${filed.length} proposed from the objective and filed as openings${existing.length ? `, ${existing.length} already held` : ''}${parsed.rejected.length ? `, ${parsed.rejected.length} rejected for breaking a limit` : ''}.`,
    { outcome: 'PROPOSED', model: parsed.model, filed, existing, rejected: parsed.rejected, refutedShown: read.ctx.refuted.length },
  );
  /*
   * The routes' deep dives start now, inside the project's dive room, rather
   * than when the tick's serial project walk next reaches this project.
   * Production, 2026-11-25: nine fresh goals held six route openings each and
   * no dive had started 75 minutes later; the walk that would start them had
   * been running for 38 minutes and these projects were last in it.
   */
  let dived: string[] = [];
  if (filed.length > 0) {
    const start = deps.startDives ?? (async (projectId: string) => (await import('../cash/validation.ts')).startValidations({ projectId }));
    dived = (await start(target.projectId).catch(() => [])).map((one) => one.opportunityId);
  }
  return { kind: 'PROPOSED', filed, existing, rejected: parsed.rejected, model: parsed.model, dived };
}

const inFlight = new Map<string, Promise<RouteOutcome | null>>();
/** Goals waiting for a place, in the order they asked: each asks when one frees. */
const waiting = new Map<string, { heldTitles: readonly string[]; deps: RouteDeps; resolve: (outcome: RouteOutcome | null) => void; ask: Promise<RouteOutcome | null> }>();

/** Tests: every ask running or waiting in this process, settled. */
export async function settleRouteAsks(): Promise<void> {
  while (inFlight.size > 0 || waiting.size > 0) {
    await Promise.all([...inFlight.values(), ...[...waiting.values()].map((one) => one.ask)]);
  }
}

function startAsk(goalId: string, heldTitles: readonly string[], now: Date | null, deps: RouteDeps): Promise<RouteOutcome | null> {
  const run = proposeGoalRoutes({ goalId, ...(now ? { now } : {}), heldTitles }, deps)
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
        void startAsk(nextId, held.heldTitles, null, held.deps).then(held.resolve);
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
 */
export function armRouteProposal(goalId: string, heldTitles: readonly string[], now: Date, deps: RouteDeps = {}): Promise<RouteOutcome | null> {
  const running = inFlight.get(goalId);
  if (running) return running;
  const queued = waiting.get(goalId);
  if (queued) return queued.ask;
  if (inFlight.size < ROUTE_MAX_IN_FLIGHT) return startAsk(goalId, heldTitles, now, deps);
  let resolve: (outcome: RouteOutcome | null) => void = () => undefined;
  const ask = new Promise<RouteOutcome | null>((done) => {
    resolve = done;
  });
  waiting.set(goalId, { heldTitles, deps, resolve, ask });
  return ask;
}
