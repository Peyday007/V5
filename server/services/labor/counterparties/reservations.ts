/**
 * Reserved capacity of a counterparty, derived from recorded events (CP-31).
 *
 * Pure, for the reason `services/dispatch/router.ts` is pure: a function over a
 * snapshot, so "why was this refused" is answerable afterwards from an input.
 * Being pure it is not an exclusion mechanism. Two callers that both read a
 * snapshot with room can both be told yes; the arbiter is the database in the
 * caller, which must append the returned event under a constraint or a
 * transaction that re-reads. This module only decides from what it is given.
 *
 * - Capacity is never a stored counter. It is the sum of the units of the holds
 *   the events say are still held, over ALL businesses, in an overlapping window.
 *   Overlap is judged conservatively (the sum of overlapping holds, not their
 *   peak): a scarce resource is never booked on the strength of an optimistic
 *   reading of its schedule.
 * - A reservation needs every authority its caller says it requires. A missing
 *   one is the answer, naming it; it is never downgraded to a softer hold.
 * - A logical reservation key counts once. The same key with different terms is
 *   a conflict, not a second reservation (invariant 27).
 * - A failed primary transfers to the named alternative only on a reported
 *   FAILED, only when the alternative has room, releasing the primary in the
 *   same plan. A hold with no report is UNKNOWN: it is not released, not
 *   transferred, and keeps its capacity (invariant 26).
 */

export type ReservationKind = 'RESERVED' | 'RELEASED' | 'FAILED' | 'PERFORMED';

export interface ReservationEvent {
  kind: ReservationKind;
  /** The logical key of the reservation this event is about (and, for RESERVED, the idempotency key). */
  key: string;
  counterpartyId: string;
  commitmentId: string;
  businessId: string;
  /** Capacity units held; a positive number. Meaningful on RESERVED. */
  units: number;
  /** ISO-8601 UTC; the window is [start, end). */
  windowStart: string;
  windowEnd: string;
  /** Authorities the actor held when the event was recorded. */
  authorityHeld: string[];
  /** ISO-8601 UTC when recorded; events are applied in this order, ties in array order. */
  at: string;
}

export type HoldState = 'HELD' | 'FAILED' | 'RELEASED' | 'PERFORMED';

export interface Hold {
  key: string;
  counterpartyId: string;
  commitmentId: string;
  businessId: string;
  units: number;
  windowStart: string;
  windowEnd: string;
  state: HoldState;
}

/** A hold in any state but these still takes the counterparty's capacity. */
const FREES_CAPACITY: ReadonlySet<HoldState> = new Set(['RELEASED', 'PERFORMED']);

/** The holds, folded from the events. Nothing is stored; the same events give the same holds. */
export function holdsFrom(events: readonly ReservationEvent[]): Hold[] {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i));
  const holds = new Map<string, Hold>();
  for (const { e } of ordered) {
    const existing = holds.get(e.key);
    if (e.kind === 'RESERVED') {
      if (existing) continue; // a repeat of the same logical key counts once
      holds.set(e.key, {
        key: e.key, counterpartyId: e.counterpartyId, commitmentId: e.commitmentId, businessId: e.businessId,
        units: e.units, windowStart: e.windowStart, windowEnd: e.windowEnd, state: 'HELD',
      });
    } else if (existing && existing.state !== 'RELEASED' && existing.state !== 'PERFORMED') {
      existing.state = e.kind === 'RELEASED' ? 'RELEASED' : e.kind === 'PERFORMED' ? 'PERFORMED' : 'FAILED';
    }
  }
  return [...holds.values()];
}

const overlaps = (a: { windowStart: string; windowEnd: string }, b: { windowStart: string; windowEnd: string }): boolean =>
  a.windowStart < b.windowEnd && b.windowStart < a.windowEnd;

/** Units of a counterparty still free in a window, from the events alone. Negative if it is already over-held. */
export function remainingCapacity(
  events: readonly ReservationEvent[],
  counterpartyId: string,
  capacityUnits: number,
  window: { windowStart: string; windowEnd: string },
): { remaining: number; holders: Hold[] } {
  const holders = holdsFrom(events).filter((h) => h.counterpartyId === counterpartyId && !FREES_CAPACITY.has(h.state) && overlaps(h, window));
  return { remaining: capacityUnits - holders.reduce((sum, h) => sum + h.units, 0), holders };
}

export interface ReservationRequest {
  key: string;
  counterpartyId: string;
  commitmentId: string;
  businessId: string;
  units: number;
  windowStart: string;
  windowEnd: string;
  /** Total capacity the counterparty has in the window, as evidenced; unknown capacity is not a number and cannot be reserved against. */
  capacityUnits: number | null;
  /** What this reservation requires, and what the actor holds. */
  authorityRequired: string[];
  authorityHeld: string[];
  at: string;
}

export type ReservationAnswer =
  | { ok: true; duplicate: boolean; event: ReservationEvent | null }
  | { ok: false; reason: 'MISSING_AUTHORITY'; missing: string[] }
  | { ok: false; reason: 'CAPACITY_UNKNOWN' }
  | { ok: false; reason: 'INVALID'; detail: string }
  | { ok: false; reason: 'KEY_CONFLICT'; detail: string }
  | { ok: false; reason: 'CAPACITY'; remaining: number; holders: Array<{ commitmentId: string; businessId: string; units: number }> };

export function reserve(events: readonly ReservationEvent[], request: ReservationRequest): ReservationAnswer {
  if (!request.key.trim()) return { ok: false, reason: 'INVALID', detail: 'a reservation has a logical key' };
  if (!(request.units > 0) || !Number.isFinite(request.units)) return { ok: false, reason: 'INVALID', detail: 'units are a positive number' };
  if (!(request.windowStart < request.windowEnd)) return { ok: false, reason: 'INVALID', detail: 'the window runs start to end' };
  const prior = holdsFrom(events).find((h) => h.key === request.key);
  if (prior) {
    const same = prior.counterpartyId === request.counterpartyId && prior.commitmentId === request.commitmentId && prior.businessId === request.businessId
      && prior.units === request.units && prior.windowStart === request.windowStart && prior.windowEnd === request.windowEnd;
    return same ? { ok: true, duplicate: true, event: null } : { ok: false, reason: 'KEY_CONFLICT', detail: `key ${request.key} already names a different reservation` };
  }
  const missing = request.authorityRequired.filter((one) => !request.authorityHeld.includes(one));
  if (missing.length > 0) return { ok: false, reason: 'MISSING_AUTHORITY', missing };
  if (request.capacityUnits === null) return { ok: false, reason: 'CAPACITY_UNKNOWN' };
  const { remaining, holders } = remainingCapacity(events, request.counterpartyId, request.capacityUnits, request);
  if (request.units > remaining) {
    return { ok: false, reason: 'CAPACITY', remaining: Math.max(0, remaining), holders: holders.map((h) => ({ commitmentId: h.commitmentId, businessId: h.businessId, units: h.units })) };
  }
  return {
    ok: true,
    duplicate: false,
    event: {
      kind: 'RESERVED', key: request.key, counterpartyId: request.counterpartyId, commitmentId: request.commitmentId, businessId: request.businessId,
      units: request.units, windowStart: request.windowStart, windowEnd: request.windowEnd, authorityHeld: request.authorityHeld, at: request.at,
    },
  };
}

export interface TransferRequest {
  /** The key of the primary's hold. */
  primaryKey: string;
  /** Key for the alternative's new hold (its own logical key). */
  alternativeKey: string;
  alternativeCounterpartyId: string;
  alternativeCapacityUnits: number | null;
  authorityRequired: string[];
  authorityHeld: string[];
  at: string;
}

export type TransferPlan =
  | { action: 'TRANSFER'; events: ReservationEvent[] }
  | { action: 'UNKNOWN'; detail: string }
  | { action: 'REFUSED'; reason: string; detail: string };

/** After a reported failure only. Releases the primary and holds the alternative, or does nothing at all. */
export function planTransfer(events: readonly ReservationEvent[], request: TransferRequest): TransferPlan {
  const primary = holdsFrom(events).find((h) => h.key === request.primaryKey);
  if (!primary) return { action: 'REFUSED', reason: 'NO_SUCH_HOLD', detail: `no reservation ${request.primaryKey}` };
  if (primary.state === 'HELD') {
    return { action: 'UNKNOWN', detail: `${primary.counterpartyId} has not reported; the outcome is unknown, so its hold stays and nothing is transferred` };
  }
  if (primary.state !== 'FAILED') return { action: 'REFUSED', reason: 'NOT_FAILED', detail: `the primary hold is ${primary.state.toLowerCase()}, not failed` };
  if (request.alternativeCounterpartyId === primary.counterpartyId) return { action: 'REFUSED', reason: 'SAME_COUNTERPARTY', detail: 'the alternative is the primary' };
  // The primary is released in the same plan, so its units are not counted against the alternative's window.
  const release: ReservationEvent = {
    kind: 'RELEASED', key: primary.key, counterpartyId: primary.counterpartyId, commitmentId: primary.commitmentId, businessId: primary.businessId,
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd, authorityHeld: request.authorityHeld, at: request.at,
  };
  const next = reserve([...events, release], {
    key: request.alternativeKey, counterpartyId: request.alternativeCounterpartyId, commitmentId: primary.commitmentId, businessId: primary.businessId,
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd, capacityUnits: request.alternativeCapacityUnits,
    authorityRequired: request.authorityRequired, authorityHeld: request.authorityHeld, at: request.at,
  });
  if (!next.ok) return { action: 'REFUSED', reason: next.reason, detail: `the alternative cannot take the commitment: ${next.reason}` };
  return { action: 'TRANSFER', events: next.event ? [release, next.event] : [release] };
}

/** Commitments with more than one live hold: the state this module exists to prevent, readable from events. */
export function doubleCommitted(events: readonly ReservationEvent[]): string[] {
  const live = new Map<string, number>();
  for (const h of holdsFrom(events)) if (!FREES_CAPACITY.has(h.state) && h.state === 'HELD') live.set(h.commitmentId, (live.get(h.commitmentId) ?? 0) + 1);
  return [...live].filter(([, n]) => n > 1).map(([id]) => id);
}
