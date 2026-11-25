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
