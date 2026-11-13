/**
 * Reserved capacity of a counterparty, derived from recorded events (CP-31).
 *
 * Two halves. The decisions (`holdsFrom`, `reserve`, `planTransfer` …) are
 * pure, for the reason `services/dispatch/router.ts` is pure: a function over a
 * snapshot, so "why was this refused" is answerable afterwards from an input.
 * A pure decision is not an exclusion mechanism — two callers that both read a
 * snapshot with room could both be told yes — so the recorded half at the foot
 * of this file is the arbiter, and it is the only way an event reaches a row:
 *
 * - Every event is one append-only `cash_events` row (kind
 *   `COUNTERPARTY_RESERVATION`), written under the business's project and
 *   filed on the counterparty's own ledger (`counterparty:<id>`), so one read
 *   returns that counterparty's holds across EVERY business. No new table and
 *   no second store: `cash_events` is already the append-only record of what
 *   Brain committed and on whose authority.
 * - A write re-reads that ledger and decides inside `serializeCash` on the
 *   counterparty's own lock row, the primitive every cash decision already
 *   uses, so on Postgres the second of two concurrent reservations blocks until
 *   the first one's row is visible and is then refused on capacity. A transfer
 *   takes both counterparties' locks, in a fixed order.
 *
 * - Capacity is never a stored counter. It is the sum of the units of the holds
 *   the events say are still held, over ALL businesses, in an overlapping window.
 *   Overlap is judged conservatively (the sum of overlapping holds, not their
 *   peak): a scarce resource is never booked on the strength of an optimistic
 *   reading of its schedule.
 * - A reservation is the commercial action `ENGAGE_CONTRACTOR` ("commit
 *   contractor or supplier capacity against a named obligation"), and the only
 *   thing that authorizes it is the business's live commercial authority row,
 *   read through the existing owner (`checkCommercialAuthority`,
 *   `services/cash/authority.ts`). No caller names what it holds: the pure
 *   decision takes that owner's `CommercialDecision` and checks it covers this
 *   action for this business, and the arbiter ignores whatever a caller read
 *   and re-reads the grant itself, inside the lock, at the moment of the write.
 *   A refusal names the action; it is never downgraded to a softer hold.
 * - A logical reservation key counts once. The same key with different terms is
 *   a conflict, not a second reservation (invariant 27).
 * - A failed primary transfers to the named alternative only on a reported
 *   FAILED, only when the alternative has room, releasing the primary in the
 *   same plan. A hold with no report is UNKNOWN: it is not released, not
 *   transferred, and keeps its capacity (invariant 26).
 */

import { cashAuthorityNow } from '../../../repos/cashAuthority.ts';
import { serializeCash } from '../../../repos/cashLock.ts';
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';
import { checkCommercialAuthority, type CommercialAction, type CommercialDecision } from '../../cash/authority.ts';

// ---------------------------------------------------------------------------
// Authority: the owner's live grant, never a caller's assertion
// ---------------------------------------------------------------------------

/** The one commercial action a reservation (and a transfer's new hold) is. */
export const RESERVATION_ACTION: CommercialAction = 'ENGAGE_CONTRACTOR';

/**
 * The business's live commercial authority for a reservation, read from the
 * owner of commercial authority (`checkCommercialAuthority`). This is the only
 * way an authority reaches this module; a business is a project.
 */
export function reservationAuthority(businessId: string, at?: string): Promise<CommercialDecision> {
  return checkCommercialAuthority({ projectId: businessId, action: RESERVATION_ACTION, at });
}

/**
 * Null when this decision authorizes reserving capacity for this business;
 * otherwise the sentence saying why it does not. A decision about another
 * project, another action, a revoked grant or no grant at all authorizes
 * nothing — the check reads the grant the decision carries, not its `ok` alone.
 */
export function authorityRefusal(decision: CommercialDecision | null | undefined, businessId: string): string | null {
  if (!decision) return `no commercial authority was read for ${RESERVATION_ACTION}`;
  if (!decision.ok || !decision.authority) return decision.reason;
  const grant = decision.authority;
  if (grant.projectId !== businessId) return 'no standing commercial authority exists for this business';
  if (grant.state !== 'ACTIVE') return 'the commercial authority is not active';
  if (grant.prohibitions.includes(RESERVATION_ACTION)) return `the commercial authority prohibits ${RESERVATION_ACTION}`;
  if (!grant.allowedActions.includes(RESERVATION_ACTION)) return `the commercial authority does not cover ${RESERVATION_ACTION}`;
  return null;
}

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
  /** The commercial action the grant covered when the event was recorded ([] on an outcome report). */
  authorityHeld: string[];
  /** The `cash_authorities` row that authorized a RESERVED (or a transfer's RELEASED); null otherwise. */
  authorityId?: string | null;
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
  /** The business's live grant, from `reservationAuthority` — never a list the caller wrote. */
  authority: CommercialDecision | null;
  at: string;
}

export type ReservationAnswer =
  | { ok: true; duplicate: boolean; event: ReservationEvent | null }
  | { ok: false; reason: 'MISSING_AUTHORITY'; missing: string[]; detail: string }
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
  const refusal = authorityRefusal(request.authority, request.businessId);
  if (refusal !== null) return { ok: false, reason: 'MISSING_AUTHORITY', missing: [RESERVATION_ACTION], detail: refusal };
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
      units: request.units, windowStart: request.windowStart, windowEnd: request.windowEnd,
      authorityHeld: [RESERVATION_ACTION], authorityId: request.authority!.authority!.id, at: request.at,
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
  /** The primary's business's live grant, from `reservationAuthority`. */
  authority: CommercialDecision | null;
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
  const refusal = authorityRefusal(request.authority, primary.businessId);
  if (refusal !== null) return { action: 'REFUSED', reason: 'MISSING_AUTHORITY', detail: `the alternative cannot take the commitment: ${refusal}` };
  // The primary is released in the same plan, so its units are not counted against the alternative's window.
  const release: ReservationEvent = {
    kind: 'RELEASED', key: primary.key, counterpartyId: primary.counterpartyId, commitmentId: primary.commitmentId, businessId: primary.businessId,
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd,
    authorityHeld: [RESERVATION_ACTION], authorityId: request.authority!.authority!.id, at: request.at,
  };
  const next = reserve([...events, release], {
    key: request.alternativeKey, counterpartyId: request.alternativeCounterpartyId, commitmentId: primary.commitmentId, businessId: primary.businessId,
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd, capacityUnits: request.alternativeCapacityUnits,
    authority: request.authority, at: request.at,
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

/**
 * What the recorded outcomes say about how a counterparty actually performs
 * (CP-31: "learn which counterparties actually perform").
 *
 * Read from the same events, never stored: a PERFORMED or FAILED report counts,
 * a hold with no report counts as neither (invariant 26 — an unknown outcome is
 * not a failure and not a success). `reliability` is null until at least one
 * outcome was reported, so a counterparty nobody has used never looks reliable
 * or unreliable by default.
 */
export interface PerformanceReading {
  counterpartyId: string;
  performed: number;
  failed: number;
  /** Holds still HELD whose window has ended with no report. Carried as a task, never scored. */
  unreported: number;
  /** performed / (performed + failed), or null with no reported outcome. */
  reliability: number | null;
  /** The reservation keys the figures come from, so the reading resolves to records. */
  evidence: string[];
}

export function performanceFrom(events: readonly ReservationEvent[], counterpartyId: string, asOf: string): PerformanceReading {
  const mine = holdsFrom(events).filter((h) => h.counterpartyId === counterpartyId);
  const performed = mine.filter((h) => h.state === 'PERFORMED');
  const failed = mine.filter((h) => h.state === 'FAILED');
  const unreported = mine.filter((h) => h.state === 'HELD' && h.windowEnd <= asOf);
  const reported = performed.length + failed.length;
  return {
    counterpartyId,
    performed: performed.length,
    failed: failed.length,
    unreported: unreported.length,
    reliability: reported === 0 ? null : performed.length / reported,
    evidence: [...performed, ...failed].map((h) => h.key).sort(),
  };
}

/**
 * The performance reading as ladder facts. With no reported outcome the facts are
 * UNKNOWN (a task), never a favourable default. With outcomes they are VERIFIED,
 * naming the reservation keys they were read from.
 */
export function performanceFacts(reading: PerformanceReading): Array<{ dimension: string; status: 'VERIFIED' | 'UNKNOWN'; evidence: string | null; value: number | string | null }> {
  if (reading.reliability === null) {
    return [
      { dimension: 'performanceHistory', status: 'UNKNOWN', evidence: null, value: null },
      { dimension: 'reliability', status: 'UNKNOWN', evidence: null, value: null },
    ];
  }
  const evidence = `reservation events: ${reading.evidence.join(', ')}`;
  return [
    { dimension: 'performanceHistory', status: 'VERIFIED', evidence, value: `${reading.performed} performed, ${reading.failed} failed` },
    { dimension: 'reliability', status: 'VERIFIED', evidence, value: reading.reliability },
  ];
}

// ---------------------------------------------------------------------------
// The recorded half: the rows, and the one arbiter that writes them
// ---------------------------------------------------------------------------

/** The `cash_events.kind` every reservation event is recorded under. */
export const RESERVATION_EVENT_KIND = 'COUNTERPARTY_RESERVATION';

/**
 * The ledger a counterparty's rows are filed on (`cash_events.opportunity_id`,
 * served by its `(opportunity_id, kind, created_at)` index). A logical
 * reservation key is unique within one counterparty's ledger; the keys
 * `transaction.ts` builds name the counterparty, so they are unique overall.
 */
export function counterpartyLedger(counterpartyId: string): string {
  return `counterparty:${counterpartyId}`;
}

/** The lock row (`cash_locks`) a counterparty's capacity decisions serialize on. */
const CAPACITY_LOCK = 'CAPACITY';

const KINDS: ReadonlySet<string> = new Set<ReservationKind>(['RESERVED', 'RELEASED', 'FAILED', 'PERFORMED']);

function eventFromRow(detail: Record<string, unknown>): ReservationEvent | null {
  const e = detail['event'] as Partial<ReservationEvent> | undefined;
  if (!e || typeof e !== 'object' || !KINDS.has(String(e.kind)) || typeof e.key !== 'string' || typeof e.counterpartyId !== 'string') return null;
  return {
    kind: e.kind as ReservationKind,
    key: e.key,
    counterpartyId: e.counterpartyId,
    commitmentId: String(e.commitmentId ?? ''),
    businessId: String(e.businessId ?? ''),
    units: Number(e.units ?? 0),
    windowStart: String(e.windowStart ?? ''),
    windowEnd: String(e.windowEnd ?? ''),
    authorityHeld: Array.isArray(e.authorityHeld) ? e.authorityHeld.map(String) : [],
    authorityId: typeof e.authorityId === 'string' ? e.authorityId : null,
    at: String(e.at ?? ''),
  };
}

/** Every recorded reservation event about these counterparties, from every business, in recorded order. */
export async function recordedReservationEvents(counterpartyIds: readonly string[]): Promise<ReservationEvent[]> {
  const out: ReservationEvent[] = [];
  for (const id of [...new Set(counterpartyIds)].sort()) {
    for (const row of await cashEventsOfKind(counterpartyLedger(id), RESERVATION_EVENT_KIND)) {
      const event = eventFromRow(row.detail);
      if (event && event.counterpartyId === id) out.push(event);
    }
  }
  return out;
}

async function append(event: ReservationEvent, actorRef: string): Promise<void> {
  await recordCashEvent({
    projectId: event.businessId,
    opportunityId: counterpartyLedger(event.counterpartyId),
    kind: RESERVATION_EVENT_KIND,
    actorRef,
    summary: `${event.kind} ${event.units} unit(s) of ${event.counterpartyId} for ${event.commitmentId}`,
    detail: { event },
  });
}

/** The live grant of a business, as the arbiter read it inside the lock. */
export type AuthorityOf = (businessId: string) => CommercialDecision | null;

/**
 * The arbiter. Takes every named counterparty's capacity lock (`serializeCash`
 * on its own `cash_locks` row, in one fixed order so two callers cannot
 * deadlock), re-reads their ledgers across every business, reads the live
 * commercial authority of every business involved (the named ones and every
 * business that already holds on these ledgers) at the moment of the write,
 * lets `decide` choose from that fresh snapshot, and appends exactly the events
 * it returns — in the same transaction, so a decision and its rows land
 * together or not at all. This is the only path by which a reservation event is
 * written, and it refuses to write a RESERVED event (or a transfer's release)
 * that the business's live grant does not cover, whatever `decide` proposed:
 * the authority is the arbiter's reading, never the caller's.
 */
export async function decideRecorded<T>(
  counterpartyIds: readonly string[],
  actorRef: string,
  decide: (events: ReservationEvent[], authorityOf: AuthorityOf) => { result: T; append: readonly ReservationEvent[] },
  businessIds: readonly string[] = [],
): Promise<T> {
  const ids = [...new Set(counterpartyIds)].sort();
  const locked = new Set(ids);
  const step = (i: number): Promise<T> =>
    i < ids.length
      ? serializeCash(counterpartyLedger(ids[i]!), CAPACITY_LOCK, () => step(i + 1))
      : (async () => {
          const snapshot = await recordedReservationEvents(ids);
          // The clock is the arbiter's, not the caller's: a grant is read as it stands when the row is written.
          const now = cashAuthorityNow();
          const grants = new Map<string, CommercialDecision>();
          for (const business of [...new Set([...businessIds, ...snapshot.map((e) => e.businessId)])].sort()) {
            grants.set(business, await reservationAuthority(business, now));
          }
          const authorityOf: AuthorityOf = (business) => grants.get(business) ?? null;
          const { result, append: events } = decide(snapshot, authorityOf);
          for (const event of events) {
            if (!locked.has(event.counterpartyId)) throw new Error(`${event.counterpartyId} was not locked for this decision`);
            if (event.kind === 'RESERVED' || event.authorityHeld.length > 0) {
              const grant = authorityOf(event.businessId);
              const refusal = authorityRefusal(grant, event.businessId);
              if (refusal !== null) throw new Error(`refused to record ${event.kind} ${event.key}: ${refusal}`);
              if (event.authorityId !== grant!.authority!.id) throw new Error(`refused to record ${event.kind} ${event.key}: it does not name the live commercial authority`);
            }
            await append(event, actorRef);
          }
          return result;
        })();
  return step(0);
}

/**
 * Reserve, recorded. A repeat of the same logical key is answered as a
 * duplicate and writes nothing; a refusal writes nothing.
 */
export async function recordReservation(request: Omit<ReservationRequest, 'authority'>, actorRef: string): Promise<ReservationAnswer> {
  return decideRecorded([request.counterpartyId], actorRef, (events, authorityOf) => {
    const answer = reserve(events, { ...request, authority: authorityOf(request.businessId) });
    return { result: answer, append: answer.ok && answer.event ? [answer.event] : [] };
  }, [request.businessId]);
}

export type OutcomeAnswer =
  | { recorded: true; event: ReservationEvent }
  | { recorded: false; reason: 'NO_SUCH_HOLD' | 'ALREADY_SETTLED'; detail: string };

/**
 * A reported outcome of a hold: the counterparty FAILED, PERFORMED, or the hold
 * was RELEASED. Only a report is recorded; silence is never turned into one.
 */
export async function recordHoldOutcome(input: {
  counterpartyId: string;
  key: string;
  kind: Exclude<ReservationKind, 'RESERVED'>;
  at: string;
  actorRef: string;
}): Promise<OutcomeAnswer> {
  return decideRecorded<OutcomeAnswer>([input.counterpartyId], input.actorRef, (events) => {
    const hold = holdsFrom(events).find((h) => h.key === input.key);
    if (!hold) return { result: { recorded: false, reason: 'NO_SUCH_HOLD', detail: `no reservation ${input.key} on ${input.counterpartyId}` }, append: [] };
    if (FREES_CAPACITY.has(hold.state)) return { result: { recorded: false, reason: 'ALREADY_SETTLED', detail: `the hold is already ${hold.state.toLowerCase()}` }, append: [] };
    const event: ReservationEvent = {
      kind: input.kind, key: hold.key, counterpartyId: hold.counterpartyId, commitmentId: hold.commitmentId, businessId: hold.businessId,
      units: hold.units, windowStart: hold.windowStart, windowEnd: hold.windowEnd, authorityHeld: [], authorityId: null, at: input.at,
    };
    return { result: { recorded: true, event }, append: [event] };
  });
}

/**
 * Transfer, recorded. Holds both counterparties' locks, re-reads both ledgers,
 * plans with `planTransfer`, and appends the release and the new hold in the
 * same transaction — both rows or neither.
 */
export async function recordTransfer(
  request: Omit<TransferRequest, 'authority'> & { primaryCounterpartyId: string },
  actorRef: string,
): Promise<TransferPlan> {
  return decideRecorded([request.primaryCounterpartyId, request.alternativeCounterpartyId], actorRef, (events, authorityOf) => {
    const primary = holdsFrom(events).find((h) => h.key === request.primaryKey);
    const plan = planTransfer(events, { ...request, authority: primary ? authorityOf(primary.businessId) : null });
    return { result: plan, append: plan.action === 'TRANSFER' ? plan.events : [] };
  });
}
