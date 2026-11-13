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
 * - A reservation needs every authority its caller says it requires. A missing
 *   one is the answer, naming it; it is never downgraded to a softer hold.
 * - What a caller says it holds is not authority. Committing a counterparty's
 *   capacity is the owner's ENGAGE_CONTRACTOR grant ("Commit contractor or
 *   supplier capacity against a named obligation"), so the arbiter refuses to
 *   write any RESERVED event unless `checkCommercialAuthority` finds that action
 *   in the business's live commercial authority row, re-read inside the same
 *   transaction that writes it, and files the grant beside the row. There is
 *   one authority path (§10.3, §20.4): the caller-supplied arrays only ever
 *   narrow what the pure decision allows, never widen what is written.
 * - A logical reservation key counts once. The same key with different terms is
 *   a conflict, not a second reservation (invariant 27).
 * - A failed primary transfers to the named alternative only on a reported
 *   FAILED, only when the alternative has room, releasing the primary in the
 *   same plan. A hold with no report is UNKNOWN: it is not released, not
 *   transferred, and keeps its capacity (invariant 26).
 */

import { serializeCash } from '../../../repos/cashLock.ts';
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';
import { checkCommercialAuthority, type CommercialAction, type CommercialDecision } from '../../cash/authority.ts';

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
  | { ok: false; reason: 'MISSING_AUTHORITY'; missing: string[]; detail?: string }
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

/**
 * The commercial action that commits a counterparty's capacity. Read from the owner's live grant, never
 * from what a caller says it holds.
 */
export const RESERVE_AUTHORITY: CommercialAction = 'ENGAGE_CONTRACTOR';

/** A RESERVED event the business's live commercial authority does not cover. Nothing was written. */
export class ReservationAuthorityRefused extends Error {
  readonly businessId: string;
  readonly reason: string;
  constructor(businessId: string, reason: string) {
    super(`not reserved: ${reason} (${RESERVE_AUTHORITY} is required to commit counterparty capacity)`);
    this.name = 'ReservationAuthorityRefused';
    this.businessId = businessId;
    this.reason = reason;
  }
}

async function append(event: ReservationEvent, actorRef: string, grant: CommercialDecision | null): Promise<void> {
  await recordCashEvent({
    projectId: event.businessId,
    opportunityId: counterpartyLedger(event.counterpartyId),
    kind: RESERVATION_EVENT_KIND,
    actorRef,
    summary: `${event.kind} ${event.units} unit(s) of ${event.counterpartyId} for ${event.commitmentId}`,
    detail: grant?.authority
      ? { event, authority: { action: RESERVE_AUTHORITY, authorityId: grant.authority.id, policyVersion: grant.policyVersion } }
      : { event },
  });
}

/**
 * The arbiter. Takes every named counterparty's capacity lock (`serializeCash`
 * on its own `cash_locks` row, in one fixed order so two callers cannot
 * deadlock), re-reads their ledgers across every business, lets `decide`
 * choose from that fresh snapshot, and appends exactly the events it returns —
 * in the same transaction, so a decision and its rows land together or not at
 * all. This is the only path by which a reservation event is written, so it is
 * where authority is enforced: every RESERVED event must be covered by its
 * business's live ENGAGE_CONTRACTOR grant, checked before anything is appended;
 * one that is not throws `ReservationAuthorityRefused` and nothing is written.
 */
export async function decideRecorded<T>(
  counterpartyIds: readonly string[],
  actorRef: string,
  decide: (events: ReservationEvent[]) => { result: T; append: readonly ReservationEvent[] },
): Promise<T> {
  const ids = [...new Set(counterpartyIds)].sort();
  const locked = new Set(ids);
  const step = (i: number): Promise<T> =>
    i < ids.length
      ? serializeCash(counterpartyLedger(ids[i]!), CAPACITY_LOCK, () => step(i + 1))
      : (async () => {
          const { result, append: events } = decide(await recordedReservationEvents(ids));
          const grants = new Map<string, CommercialDecision>();
          for (const event of events) {
            if (!locked.has(event.counterpartyId)) throw new Error(`${event.counterpartyId} was not locked for this decision`);
            if (event.kind !== 'RESERVED') continue;
            let grant = grants.get(event.businessId);
            if (!grant) {
              grant = await checkCommercialAuthority({ projectId: event.businessId, action: RESERVE_AUTHORITY });
              grants.set(event.businessId, grant);
            }
            if (!grant.ok) throw new ReservationAuthorityRefused(event.businessId, grant.reason);
          }
          for (const event of events) await append(event, actorRef, event.kind === 'RESERVED' ? grants.get(event.businessId) ?? null : null);
          return result;
        })();
  return step(0);
}

/**
 * Reserve, recorded. A repeat of the same logical key is answered as a
 * duplicate and writes nothing; a refusal writes nothing.
 */
export async function recordReservation(request: ReservationRequest, actorRef: string): Promise<ReservationAnswer> {
  try {
    return await decideRecorded([request.counterpartyId], actorRef, (events) => {
      const answer = reserve(events, request);
      return { result: answer, append: answer.ok && answer.event ? [answer.event] : [] };
    });
  } catch (error) {
    if (error instanceof ReservationAuthorityRefused) return { ok: false, reason: 'MISSING_AUTHORITY', missing: [RESERVE_AUTHORITY], detail: error.reason };
    throw error;
  }
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
  authorityHeld: string[];
  at: string;
  actorRef: string;
}): Promise<OutcomeAnswer> {
  return decideRecorded<OutcomeAnswer>([input.counterpartyId], input.actorRef, (events) => {
    const hold = holdsFrom(events).find((h) => h.key === input.key);
    if (!hold) return { result: { recorded: false, reason: 'NO_SUCH_HOLD', detail: `no reservation ${input.key} on ${input.counterpartyId}` }, append: [] };
    if (FREES_CAPACITY.has(hold.state)) return { result: { recorded: false, reason: 'ALREADY_SETTLED', detail: `the hold is already ${hold.state.toLowerCase()}` }, append: [] };
    const event: ReservationEvent = {
      kind: input.kind, key: hold.key, counterpartyId: hold.counterpartyId, commitmentId: hold.commitmentId, businessId: hold.businessId,
      units: hold.units, windowStart: hold.windowStart, windowEnd: hold.windowEnd, authorityHeld: input.authorityHeld, at: input.at,
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
  request: TransferRequest & { primaryCounterpartyId: string },
  actorRef: string,
): Promise<TransferPlan> {
  try {
    return await decideRecorded([request.primaryCounterpartyId, request.alternativeCounterpartyId], actorRef, (events) => {
      const plan = planTransfer(events, request);
      return { result: plan, append: plan.action === 'TRANSFER' ? plan.events : [] };
    });
  } catch (error) {
    if (error instanceof ReservationAuthorityRefused) {
      return { action: 'REFUSED', reason: 'MISSING_AUTHORITY', detail: `the alternative cannot be held: ${error.reason}` };
    }
    throw error;
  }
}
