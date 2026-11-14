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
 * - A reservation needs the commercial authority the existing owner grants
 *   (`services/cash/authority.ts`): by default `ENGAGE_CONTRACTOR`, "Commit
 *   contractor or supplier capacity against a named obligation". Whether it is
 *   held is never something a caller says. The pure decisions take an
 *   `AuthorityReading`, and on recorded rows the only thing that makes one is
 *   `authorityFor`, which asks `checkCommercialAuthority` about the business's
 *   live grant at the moment the row is written. There is no second authority
 *   vocabulary and no second authority store here (§10.3, §20.4). A refusal is
 *   the answer, naming the action; it is never downgraded to a softer hold.
 * - A logical reservation key counts once. The same key with different terms is
 *   a conflict, not a second reservation (invariant 27).
 * - A failed primary transfers to the named alternative only on a reported
 *   FAILED, only when the alternative has room, releasing the primary in the
 *   same plan. A hold with no report is UNKNOWN: it is not released, not
 *   transferred, and keeps its capacity (invariant 26).
 */

import { serializeCash } from '../../../repos/cashLock.ts';
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';
import { checkCommercialAuthority, isCommercialAction, type CommercialAction } from '../../cash/authority.ts';

/**
 * The commercial action that commits a counterparty's capacity, in the
 * authority owner's own closed vocabulary.
 */
export const RESERVE_ACTION: CommercialAction = 'ENGAGE_CONTRACTOR';

/**
 * The authority owner's answer about one business and one commercial action,
 * carried into the pure decisions below so they stay functions of their input.
 *
 * It is a reading, not a claim. On recorded rows it comes only from
 * `authorityFor`, which reads the business's live commercial grant; no recorded
 * entry point accepts one from its caller, so no caller can assert an
 * authority it was not granted.
 */
export interface AuthorityReading {
  businessId: string;
  action: CommercialAction;
  held: boolean;
  /** The owner's reason, safe to show a person (no credential, no id). */
  reason: string;
  /** The grant the answer was read from, when one was live. */
  authorityId: string | null;
  policyVersion: number | null;
}

/** The live grant's answer for this business and action, from `checkCommercialAuthority` and nothing else. */
export async function authorityFor(businessId: string, action: CommercialAction = RESERVE_ACTION): Promise<AuthorityReading> {
  if (!isCommercialAction(action)) return withoutAuthority(businessId, action, `"${String(action)}" is not a commercial action`);
  // Judged now, when the row is written: a grant revoked or expired since the request was made does not count.
  const decision = await checkCommercialAuthority({ projectId: businessId, action });
  return {
    businessId,
    action,
    held: decision.ok,
    reason: decision.reason,
    authorityId: decision.ok ? decision.authority?.id ?? null : null,
    policyVersion: decision.policyVersion,
  };
}

/** A reading that holds nothing: what a proposal with no grant behind it is judged with. */
export function withoutAuthority(businessId: string, action: CommercialAction = RESERVE_ACTION, reason = 'no commercial authority was read'): AuthorityReading {
  return { businessId, action, held: false, reason, authorityId: null, policyVersion: null };
}

/** Null when the reading authorizes committing this business's capacity; otherwise why not. */
function authorityRefusal(authority: AuthorityReading, businessId: string): string | null {
  if (authority.businessId !== businessId) return `the authority read is for ${authority.businessId}, not ${businessId}`;
  if (!authority.held) return authority.reason;
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
  /** The commercial action the live grant covered when the hold was taken (empty when none was read). */
  authorityHeld: string[];
  /** The grant the hold was taken under, when one was read. */
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
  /** The authority the hold was taken under, carried onto its outcome events. */
  authorityHeld: string[];
  authorityId: string | null;
}

/** A hold in any state but these still takes the counterparty's capacity. */
const FREES_CAPACITY: ReadonlySet<HoldState> = new Set(['RELEASED', 'PERFORMED']);

/**
 * The holds, folded from the events. Nothing is stored; the same events give the same holds.
 *
 * Every hold is opened before any outcome is applied. An outcome can only be
 * recorded against a hold that already exists (the arbiter refuses one for an
 * unknown key), but rows written in the same millisecond can come back in
 * either order, and an outcome read before its own RESERVED must not be lost —
 * that once read a FAILED hold as still HELD.
 */
export function holdsFrom(events: readonly ReservationEvent[]): Hold[] {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i));
  const holds = new Map<string, Hold>();
  for (const { e } of ordered) {
    if (e.kind !== 'RESERVED' || holds.has(e.key)) continue; // a repeat of the same logical key counts once
    holds.set(e.key, {
      key: e.key, counterpartyId: e.counterpartyId, commitmentId: e.commitmentId, businessId: e.businessId,
      units: e.units, windowStart: e.windowStart, windowEnd: e.windowEnd, state: 'HELD',
      authorityHeld: [...e.authorityHeld], authorityId: e.authorityId ?? null,
    });
  }
  for (const { e } of ordered) {
    if (e.kind === 'RESERVED') continue;
    const existing = holds.get(e.key);
    if (existing && existing.state !== 'RELEASED' && existing.state !== 'PERFORMED') {
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
  at: string;
}

export type ReservationAnswer =
  | { ok: true; duplicate: boolean; event: ReservationEvent | null }
  | { ok: false; reason: 'MISSING_AUTHORITY'; missing: string[]; detail: string }
  | { ok: false; reason: 'CAPACITY_UNKNOWN' }
  | { ok: false; reason: 'INVALID'; detail: string }
  | { ok: false; reason: 'KEY_CONFLICT'; detail: string }
  | { ok: false; reason: 'CAPACITY'; remaining: number; holders: Array<{ commitmentId: string; businessId: string; units: number }> };

/**
 * Whether a hold may be taken, from a snapshot of the events and the authority
 * owner's reading. The reading must be about the business the hold is for and
 * must say the grant is held; nothing else in the request can stand in for it.
 */
export function reserve(events: readonly ReservationEvent[], request: ReservationRequest, authority: AuthorityReading): ReservationAnswer {
  if (!request.key.trim()) return { ok: false, reason: 'INVALID', detail: 'a reservation has a logical key' };
  if (!(request.units > 0) || !Number.isFinite(request.units)) return { ok: false, reason: 'INVALID', detail: 'units are a positive number' };
  if (!(request.windowStart < request.windowEnd)) return { ok: false, reason: 'INVALID', detail: 'the window runs start to end' };
  const prior = holdsFrom(events).find((h) => h.key === request.key);
  if (prior) {
    const same = prior.counterpartyId === request.counterpartyId && prior.commitmentId === request.commitmentId && prior.businessId === request.businessId
      && prior.units === request.units && prior.windowStart === request.windowStart && prior.windowEnd === request.windowEnd;
    return same ? { ok: true, duplicate: true, event: null } : { ok: false, reason: 'KEY_CONFLICT', detail: `key ${request.key} already names a different reservation` };
  }
  const refusal = authorityRefusal(authority, request.businessId);
  if (refusal !== null) return { ok: false, reason: 'MISSING_AUTHORITY', missing: [authority.action], detail: refusal };
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
      authorityHeld: [authority.action], authorityId: authority.authorityId, at: request.at,
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
  at: string;
}

export type TransferPlan =
  | { action: 'TRANSFER'; events: ReservationEvent[] }
  | { action: 'UNKNOWN'; detail: string }
  | { action: 'REFUSED'; reason: string; detail: string };

/** After a reported failure only. Releases the primary and holds the alternative, or does nothing at all. */
export function planTransfer(events: readonly ReservationEvent[], request: TransferRequest, authority: AuthorityReading): TransferPlan {
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
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd,
    authorityHeld: [authority.action], authorityId: authority.authorityId, at: request.at,
  };
  const next = reserve([...events, release], {
    key: request.alternativeKey, counterpartyId: request.alternativeCounterpartyId, commitmentId: primary.commitmentId, businessId: primary.businessId,
    units: primary.units, windowStart: primary.windowStart, windowEnd: primary.windowEnd, capacityUnits: request.alternativeCapacityUnits,
    at: request.at,
  }, authority);
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

type Decision<T> = { result: T; append: readonly ReservationEvent[] };

/**
 * The arbiter. Takes every named counterparty's capacity lock (`serializeCash`
 * on its own `cash_locks` row, in one fixed order so two callers cannot
 * deadlock), re-reads their ledgers across every business, lets `decide`
 * choose from that fresh snapshot, and appends exactly the events it returns —
 * in the same transaction, so a decision and its rows land together or not at
 * all. This is the only path by which a reservation event is written.
 */
export async function decideRecorded<T>(
  counterpartyIds: readonly string[],
  actorRef: string,
  decide: (events: ReservationEvent[]) => Decision<T> | Promise<Decision<T>>,
): Promise<T> {
  const ids = [...new Set(counterpartyIds)].sort();
  const locked = new Set(ids);
  const step = (i: number): Promise<T> =>
    i < ids.length
      ? serializeCash(counterpartyLedger(ids[i]!), CAPACITY_LOCK, () => step(i + 1))
      : (async () => {
          const { result, append: events } = await decide(await recordedReservationEvents(ids));
          for (const event of events) {
            if (!locked.has(event.counterpartyId)) throw new Error(`${event.counterpartyId} was not locked for this decision`);
            await append(event, actorRef);
          }
          return result;
        })();
  return step(0);
}

/**
 * Reserve, recorded. A repeat of the same logical key is answered as a
 * duplicate and writes nothing; a refusal writes nothing.
 *
 * The authority is read here, under the capacity lock, from the business's
 * live grant for `action` — `ENGAGE_CONTRACTOR` unless the caller names the
 * commercial action of an effect the counterparty performs (a provider sending
 * a message holds under `CONTACT_BUYER`). The action is from the owner's closed
 * set; whether it is held is never the caller's to say.
 */
export async function recordReservation(request: ReservationRequest, actorRef: string, action: CommercialAction = RESERVE_ACTION): Promise<ReservationAnswer> {
  return decideRecorded([request.counterpartyId], actorRef, async (events) => {
    const answer = reserve(events, request, await authorityFor(request.businessId, action));
    return { result: answer, append: answer.ok && answer.event ? [answer.event] : [] };
  });
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
      units: hold.units, windowStart: hold.windowStart, windowEnd: hold.windowEnd,
      // A report is not a commitment: it carries the authority the hold was taken under, and asserts none.
      authorityHeld: hold.authorityHeld, authorityId: hold.authorityId, at: input.at,
    };
    return { result: { recorded: true, event }, append: [event] };
  });
}

/**
 * Transfer, recorded. Holds both counterparties' locks, re-reads both ledgers,
 * reads the live grant of the business the failed hold belongs to, plans with
 * `planTransfer`, and appends the release and the new hold in the same
 * transaction — both rows or neither.
 */
export async function recordTransfer(
  request: TransferRequest & { primaryCounterpartyId: string },
  actorRef: string,
  action: CommercialAction = RESERVE_ACTION,
): Promise<TransferPlan> {
  return decideRecorded([request.primaryCounterpartyId, request.alternativeCounterpartyId], actorRef, async (events) => {
    const primary = holdsFrom(events).find((h) => h.key === request.primaryKey);
    const authority = primary ? await authorityFor(primary.businessId, action) : withoutAuthority('', action, 'no such hold');
    const plan = planTransfer(events, request, authority);
    return { result: plan, append: plan.action === 'TRANSFER' ? plan.events : [] };
  });
}
