/**
 * Which openings are whole commercial routes Brain proposed for a goal.
 *
 * A route opening is filed by `goals/routeProposal.ts` from the goal's
 * objective alone: a hypothesis — buyer, offer, price, channel, fulfiller,
 * cost, settlement, volume — that nothing published has established yet. Its
 * origin is the opening's own `external_record_id`, written once at filing
 * (`route:<goalId>:<key>`), so every reader decides "is this a proposed route"
 * from a row, never from its title. Pure.
 */

/** The prefix of a route opening's `external_record_id`. */
export const ROUTE_RECORD_PREFIX = 'route:';

/** The stable record id of one route proposed for one goal. */
export function routeRecordId(goalId: string, key: string): string {
  return `${ROUTE_RECORD_PREFIX}${goalId}:${key}`;
}

/** The prefix every route opening of one goal carries. */
export function goalRoutePrefix(goalId: string): string {
  return `${ROUTE_RECORD_PREFIX}${goalId}:`;
}

/** Whether this opening is a route Brain proposed for a goal. */
export function isRouteOpening(opportunity: { externalRecordId?: string | null }): boolean {
  return (opportunity.externalRecordId ?? '').startsWith(ROUTE_RECORD_PREFIX);
}

/** The goal a route opening was proposed for, or null when it is not one. */
export function routeGoalOf(opportunity: { externalRecordId?: string | null }): string | null {
  const id = opportunity.externalRecordId ?? '';
  if (!id.startsWith(ROUTE_RECORD_PREFIX)) return null;
  const rest = id.slice(ROUTE_RECORD_PREFIX.length);
  const at = rest.lastIndexOf(':');
  return at > 0 ? rest.slice(0, at) : null;
}

/** The card fact that carries the searches a route's research should run (a RECOMMENDATION). */
export const ROUTE_SEARCHES_FIELD = 'routeSearches';

/**
 * The card fact that carries the place a route's critique gave it among the
 * routes of the same ask (a RECOMMENDATION, "1 of 4: why"). The plan reads it
 * to choose among routes nobody has researched yet (`routeRankOf`).
 */
export const ROUTE_RANK_FIELD = 'routeRank';

/** The rank a `ROUTE_RANK_FIELD` value states (1 is best), or null when it states none. Pure. */
export function routeRankOf(value: string | null | undefined): number | null {
  const m = /^\s*(\d+)\b/.exec(value ?? '');
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The card fact that says which step of the research-informed loop a route
 * opening is (a RECOMMENDATION): `SCOUT` — a direction Brain wants checked
 * before it prices anything, filed with no price, count or cost; `ROUTE` — a
 * route built from what research found, whose sourced figures are EVIDENCE
 * facts resting on the claims it cited. An opening without it predates the
 * loop and is read as a ROUTE.
 */
export const ROUTE_STAGE_FIELD = 'routeStage';
export type RouteStage = 'SCOUT' | 'ROUTE';
/** The stage a `ROUTE_STAGE_FIELD` value states; ROUTE when it states none. Pure. */
export function routeStageOf(value: string | null | undefined): RouteStage {
  return (value ?? '').trim().toUpperCase().startsWith('SCOUT') ? 'SCOUT' : 'ROUTE';
}

/** The one unknown most likely to rule a scouted direction out: what its research asks first (a RECOMMENDATION). */
export const DECISIVE_UNKNOWN_FIELD = 'decisiveUnknown';
/** The buyer's problem or need a direction answers, as Brain reasoned it (a RECOMMENDATION). */
export const BUYER_PROBLEM_FIELD = 'buyerProblem';
/** What such buyers already pay for comparable things, as Brain expects it before research (a RECOMMENDATION). */
export const COMPARABLE_SPEND_FIELD = 'comparableSpend';
/**
 * The card fact of a dated sign that buyers of this kind spend on, or seek,
 * offers comparable to this one now — EVIDENCE about the market, never about
 * this exact offer. `buyingEvidence` stays the sign that buyers want this very
 * offer; the plan reads the two apart (`plan.ts` CURRENT_DEMAND).
 */
export const COMPARABLE_DEMAND_FIELD = 'comparableDemand';
/** Which of a route's figures research sourced, and from which claims (a RECOMMENDATION, for a reader). */
export const ROUTE_GROUNDS_FIELD = 'routeGrounds';
/** The archive reason prefix of a scouted direction a grounded route replaced: not a refutation. */
export const SUPERSEDED_PREFIX = 'superseded:';
