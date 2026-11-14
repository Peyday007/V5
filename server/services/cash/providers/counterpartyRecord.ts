/**
 * The commercial providers' real operations, recorded as counterparty rows (CP-31).
 *
 * A software service is one of the parties that performs a commercial
 * commitment — the messaging provider mails the buyer, the billing provider
 * issues the invoice — and until this module the counterparty model had no
 * producer in the running Brain: its facts, holds and outcomes existed only in
 * tests. Every registered provider adapter is wrapped here, once, at boot
 * (`register.ts`), so every effect Brain actually performs through one writes
 * the rows the model reads, through the model's own recorders and nothing
 * beside them:
 *
 *   - **before the send**, a hold on the provider's capacity for this one
 *     commitment (`recordReservation`), taken under the cross-business capacity
 *     lock against the capacity the provider itself reports — Instantly's
 *     healthy sending accounts' daily limits, shared by every business on the
 *     workspace, so two projects cannot both book the last send of a day. A
 *     provider that reports no capacity is not given an invented one: the hold
 *     is refused as CAPACITY_UNKNOWN and nothing is written (§39). The authority
 *     a hold needs is the effect's own commercial action, and whether it is
 *     held is read by the recorder itself from the project's live grant
 *     (`authorityFor`, under the capacity lock) — this module supplies none;
 *   - **after the send**, the provider's answer as the hold's outcome: a
 *     confirmed receipt is PERFORMED, a definite refusal is FAILED, and an
 *     uncertain outcome leaves the hold HELD — an unknown is never read as
 *     "it did not happen" (invariant 26);
 *   - **after a definite refusal**, the commitment moves to an alternative
 *     fulfiller: the other providers the deployment named for the same area
 *     (`BRAIN_MESSAGING_ALTERNATES`, `register.ts`), never the one that just
 *     refused. They are ranked by the model (`compareFulfillers` over their
 *     recorded facts and performance), and the best one is held through the
 *     model's own recorders — `recordTransfer`, which releases the failed hold
 *     and holds the alternative in one statement under both capacity locks, or
 *     `recordReservation` when the refused provider never held it (capacity it
 *     did not report). The alternative is held against the capacity it reports
 *     itself and the same live grant, so it is never double-committed and never
 *     held without authority; only once that hold is written is the effect sent
 *     through it, and its answer is recorded on its own hold. Only a refusal
 *     the provider marks retryable — it definitely did nothing — moves the
 *     commitment: anything less certain could mail the buyer twice;
 *   - **facts** a receipt establishes — the provider took the work (willingness),
 *     was able to now (availability), within the capability it was asked for
 *     (scope), with the capacity it reported — each VERIFIED with the receipt
 *     or the capacity reading as its evidence, recorded once per change
 *     (`recordCounterpartyFacts`). A refusal establishes nothing about
 *     willingness and records none.
 *
 * A hold the model definitely refuses stops the send (`gatingRefusal`): when
 * the window's capacity is already held by other commitments — across every
 * business on the provider — or the business holds no live grant for the
 * action, the provider is never called and the effect is answered with a
 * definite rejection, so scarce capacity is not double-booked by a send that
 * carries no hold. Otherwise recording never changes the effect: the send's
 * answer is returned exactly as the provider gave it, and a recording failure
 * is reported on the log (no payload, no credential) rather than turned into a
 * failed or repeated send.
 */
import type { EffectAdapter, EffectRequest, SendOutcome } from '../../effects/adapter.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { getInvoice } from '../../../repos/cashInvoices.ts';
import { compareFulfillers } from '../../labor/counterparties/compare.ts';
import { factFor, recordCounterpartyFacts, recordedCounterparty, type Counterparty, type Fact } from '../../labor/counterparties/ladder.ts';
import {
  recordedReservationEvents,
  recordHoldOutcome,
  recordReservation,
  recordTransfer,
  type ReservationAnswer,
} from '../../labor/counterparties/reservations.ts';
import { reservationKey, withPerformance } from '../../labor/counterparties/transaction.ts';

const BRAIN = 'BRAIN';

/** Which commercial area a provider serves, in `status.ts`' words, and the action that authorizes it. */
export interface ProviderSeat {
  area: 'MESSAGING' | 'INVOICES';
  provider: string;
  capability: string;
  /** The commercial action whose grant a hold on this provider needs. */
  action: 'CONTACT_BUYER' | 'QUOTE_AND_INVOICE';
  /** The capacity the provider reports for one UTC day, or null when it reports none. */
  capacityPerDay: () => Promise<number | null>;
}

/** The counterparty id `counterparty.ts`' `providerCounterparty` gives the same provider. */
export function providerCounterpartyId(seat: Pick<ProviderSeat, 'area' | 'provider'>): string {
  return `provider:${seat.area.toLowerCase()}:${seat.provider}`;
}

/** The commitment one effect is for, and the business (project) it belongs to. */
interface EffectSubject {
  projectId: string;
  /** Stable across retries of the same effect: retries are attempts at one commitment. */
  commitmentId: string;
  /** The attempt, so each attempt's hold has its own logical key. */
  attempt: number;
}

async function subjectOf(seat: ProviderSeat, businessId: string): Promise<EffectSubject | null> {
  if (seat.area === 'MESSAGING') {
    // `effects.ts` `effectCorrelation`: cash:<opportunity>:<action>:<occurrence>[:<retry>]
    const parts = businessId.split(':');
    if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== 'cash' || !parts[1]) return null;
    const opportunity = await getOpportunity(parts[1]);
    if (!opportunity) return null;
    const retry = parts[4] === undefined ? 0 : Number(parts[4]);
    return { projectId: opportunity.projectId, commitmentId: parts.slice(0, 4).join(':'), attempt: Number.isInteger(retry) ? retry : 0 };
  }
  const invoice = await getInvoice(businessId);
  if (!invoice) return null;
  return { projectId: invoice.projectId, commitmentId: `invoice:${invoice.id}`, attempt: 0 };
}

/** The UTC day containing `at`: the window a provider's daily capacity is counted over. */
export function dayWindow(at: string): { windowStart: string; windowEnd: string } {
  const start = new Date(`${at.slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

/** Facts whose latest recorded word differs from the one proposed: recorded once per change. */
async function changedFacts(counterpartyId: string, proposed: readonly Fact[]): Promise<Fact[]> {
  const known = (await recordedCounterparty(counterpartyId))?.facts ?? [];
  return proposed.filter((fact) => {
    const latest = factFor(known, fact.dimension);
    return !latest || latest.status !== fact.status || latest.value !== fact.value;
  });
}

export interface RecordedAttempt {
  counterpartyId: string;
  subject: EffectSubject | null;
  hold: ReservationAnswer | null;
  outcome: 'PERFORMED' | 'FAILED' | 'UNKNOWN' | null;
  facts: number;
  transferred: boolean;
  /** Set when a refused hold stopped the send: the provider was never called. */
  gated: 'CAPACITY' | 'MISSING_AUTHORITY' | null;
  /** The counterparty whose answer the effect returns: the refused primary's, or the alternative's that took it over. */
  fulfilledBy: string;
  /** Every move after a definite refusal, in order, with what the model decided. */
  transfers: Array<{ from: string; to: string | null; decision: string }>;
}

/** An alternative fulfiller of the same area: its seat and the adapter that sends through it. */
export interface SeatedAdapter {
  seat: ProviderSeat;
  adapter: EffectAdapter;
}

/**
 * The refusals that stop a send, and the definite rejection the effect records instead. Only
 * these two: they are the model saying the capacity is not this commitment's to use. A provider
 * that reports no capacity (CAPACITY_UNKNOWN) has nothing to over-book and is not stopped; a
 * hold that could not be recorded at all is reported, never turned into a refused send.
 */
export function gatingRefusal(hold: ReservationAnswer | null): { reason: 'CAPACITY' | 'MISSING_AUTHORITY'; outcome: SendOutcome } | null {
  if (!hold || hold.ok) return null;
  if (hold.reason === 'CAPACITY') {
    return {
      reason: 'CAPACITY',
      outcome: {
        kind: 'REJECTED',
        category: 'DEPENDENCY_UNAVAILABLE',
        // Nothing was sent, and the window's capacity frees as holds settle or the day turns.
        retryable: true,
        detail: `the provider's capacity for this window is held by other commitments (${hold.remaining} left); nothing was sent`,
      },
    };
  }
  if (hold.reason === 'MISSING_AUTHORITY') {
    return {
      reason: 'MISSING_AUTHORITY',
      outcome: {
        kind: 'REJECTED',
        category: 'NOT_AUTHORIZED',
        retryable: false,
        detail: `no live commercial grant for ${hold.missing.join(', ')}; nothing was sent`,
      },
    };
  }
  return null;
}

/**
 * Record one effect's commitment around the provider's own answer. Exported so
 * the wrapper and its tests drive the same code; `send` is the provider call.
 * `alternatives` are the other fulfillers the deployment named for the same
 * area; a definite, retryable refusal moves the commitment to the best of them.
 */
export async function recordProviderAttempt(
  seat: ProviderSeat,
  request: EffectRequest,
  send: () => Promise<SendOutcome>,
  now: () => string = () => new Date().toISOString(),
  alternatives: readonly SeatedAdapter[] = [],
): Promise<{ outcome: SendOutcome; recorded: RecordedAttempt }> {
  const counterpartyId = providerCounterpartyId(seat);
  const recorded: RecordedAttempt = {
    counterpartyId, subject: null, hold: null, outcome: null, facts: 0, transferred: false, fulfilledBy: counterpartyId, transfers: [], gated: null,
  };
  // Never the same counterparty twice, and only alternatives that accept this very payload.
  const others = alternatives.filter((one) => providerCounterpartyId(one.seat) !== counterpartyId && accepts(one.adapter, request));
  const group = [seat, ...others.map((one) => one.seat)];
  let key: string | null = null;
  let capacity: number | null = null;
  try {
    const subject = await subjectOf(seat, request.businessId);
    recorded.subject = subject;
    if (subject) {
      const at = now();
      capacity = await seat.capacityPerDay().catch(() => null);
      key = attemptKey(subject, counterpartyId);
      // A retry exists only because a person closed the earlier attempts as not having happened
      // (`effects.ts`), so their holds — on whichever fulfiller carried them — are released rather
      // than left to read as a second commitment.
      for (let earlier = 0; earlier < subject.attempt; earlier += 1) {
        for (const member of group) {
          const id = providerCounterpartyId(member);
          await recordHoldOutcome({ counterpartyId: id, key: attemptKey({ ...subject, attempt: earlier }, id), kind: 'RELEASED', at, actorRef: BRAIN });
        }
      }
      recorded.hold = await recordReservation(
        {
          key,
          counterpartyId,
          commitmentId: subject.commitmentId,
          businessId: subject.projectId,
          units: 1,
          ...dayWindow(at),
          capacityUnits: capacity,
          at,
        },
        BRAIN,
        seat.action,
      );
    }
  } catch (error) {
    reportRecordingFailure(seat, 'hold', error);
  }

  // A hold the model definitely refused gates the send: capacity another commitment already
  // holds, or a business without the grant to commit it, is not booked anyway and left for a
  // reading to discover — the over-booking would carry no hold for any reading to see.
  // A gated CAPACITY refusal is definite and retryable, so the commitment may still move to an
  // alternative below (held on the alternative's own capacity); MISSING_AUTHORITY is not
  // retryable and moves nothing. Either way the refused provider is never called.
  const refusal = gatingRefusal(recorded.hold);
  if (refusal) recorded.gated = refusal.reason;

  // The provider call itself, untouched by anything above.
  let outcome = refusal ? refusal.outcome : await send();

  let current: { seat: ProviderSeat; key: string | null; held: boolean; capacity: number | null } = {
    seat, key, held: recorded.hold?.ok === true && key !== null, capacity,
  };
  const tried = new Set<string>([counterpartyId]);
  for (;;) {
    let next: { seated: SeatedAdapter; key: string; capacity: number | null } | null = null;
    try {
      const subject = recorded.subject;
      if (!subject) break;
      const at = now();
      const currentId = providerCounterpartyId(current.seat);
      const kind = await recordAnswer(current.seat, subject, outcome, current.capacity, current.held ? current.key : null, at, recorded);
      if (currentId === counterpartyId) recorded.outcome = kind;
      // Only a refusal the provider says left nothing behind moves the commitment (invariant 26).
      if (outcome.kind !== 'REJECTED' || outcome.retryable !== true) break;
      const remaining = others.filter((one) => !tried.has(providerCounterpartyId(one.seat)));
      if (remaining.length === 0) break;
      const chosen = await bestAlternative(remaining, subject, at);
      if (!chosen) {
        recorded.transfers.push({ from: currentId, to: null, decision: 'no alternative is eligible for this commitment' });
        break;
      }
      const toId = providerCounterpartyId(chosen.seat);
      tried.add(toId);
      const toKey = attemptKey(subject, toId);
      const toCapacity = await chosen.seat.capacityPerDay().catch(() => null);
      const held = await holdAlternative(current, chosen.seat, subject, toKey, toCapacity, at);
      recorded.transfers.push({ from: currentId, to: toId, decision: held.decision });
      if (!held.ok) break;
      recorded.transferred = true;
      next = { seated: chosen, key: toKey, capacity: toCapacity };
    } catch (error) {
      reportRecordingFailure(current.seat, 'outcome', error);
      break;
    }
    // The alternative is held for this commitment: only now is the effect sent through it.
    outcome = withFulfiller(await next.seated.adapter.send(request), next.seated.seat.provider);
    recorded.fulfilledBy = providerCounterpartyId(next.seated.seat);
    current = { seat: next.seated.seat, key: next.key, held: true, capacity: next.capacity };
  }
  return { outcome, recorded };
}

/** The hold key of one attempt at one commitment on one fulfiller. */
function attemptKey(subject: EffectSubject, counterpartyId: string): string {
  return `${reservationKey(subject.commitmentId, counterpartyId)}#${subject.attempt}`;
}

/** Whether an alternative's own validation accepts the payload: one that would refuse it is no alternative. */
function accepts(adapter: EffectAdapter, request: EffectRequest): boolean {
  try {
    adapter.validate(request.payload);
    return true;
  } catch {
    return false;
  }
}

/** The receipt names who performed it, so the record and the stored receipt agree. */
function withFulfiller(outcome: SendOutcome, provider: string): SendOutcome {
  return outcome.kind === 'CONFIRMED' ? { ...outcome, receiptMeta: { ...(outcome.receiptMeta ?? {}), fulfilledBy: provider } } : outcome;
}

/**
 * One fulfiller's answer, recorded: the facts a receipt establishes, and the
 * hold's outcome — PERFORMED on a receipt, FAILED on a refusal, nothing on an
 * unknown (the hold stays HELD and reads UNKNOWN).
 */
async function recordAnswer(
  seat: ProviderSeat,
  subject: EffectSubject,
  outcome: SendOutcome,
  capacity: number | null,
  heldKey: string | null,
  at: string,
  recorded: RecordedAttempt,
): Promise<'PERFORMED' | 'FAILED' | 'UNKNOWN' | null> {
  const id = providerCounterpartyId(seat);
  if (outcome.kind === 'CONFIRMED') {
    const evidence = `${seat.provider} receipt ${outcome.receiptRef} for ${subject.commitmentId}`;
    const proposed: Fact[] = [
      { dimension: 'listing', status: 'VERIFIED', evidence, value: seat.provider },
      { dimension: 'willingness', status: 'VERIFIED', evidence, value: null },
      { dimension: 'availability', status: 'VERIFIED', evidence, value: null },
      { dimension: 'scope', status: 'VERIFIED', evidence, value: seat.capability },
      ...(capacity !== null
        ? [{ dimension: 'availableCapacity', status: 'VERIFIED' as const, evidence: `${seat.provider} reported ${capacity} a day`, value: capacity }]
        : []),
    ];
    const changed = await changedFacts(id, proposed);
    if (changed.length > 0) {
      recorded.facts += await recordCounterpartyFacts({
        projectId: subject.projectId,
        counterparty: { id, kind: 'software service', geography: null, humanOperator: false },
        facts: changed,
        actorRef: BRAIN,
      });
    }
  }
  if (heldKey === null) return null;
  if (outcome.kind === 'UNCERTAIN') return 'UNKNOWN';
  const kind = outcome.kind === 'CONFIRMED' ? 'PERFORMED' : 'FAILED';
  const done = await recordHoldOutcome({ counterpartyId: id, key: heldKey, kind, at, actorRef: BRAIN });
  return done.recorded ? kind : null;
}

/** An alternative as the model reads it: its recorded facts, or — never used yet — its listing alone. */
async function alternativeCounterparty(seat: ProviderSeat): Promise<Counterparty> {
  const id = providerCounterpartyId(seat);
  const listing: Fact = { dimension: 'listing', status: 'VERIFIED', evidence: `the deployment names ${seat.provider} as an alternative for ${seat.area}`, value: seat.provider };
  const known = await recordedCounterparty(id);
  return { id, kind: 'software service', geography: null, humanOperator: false, facts: [listing, ...(known?.facts ?? [])] };
}

/**
 * The best remaining alternative by the model's own comparison — stage, verified
 * figures, cost, timing, then the reliability its recorded outcomes show — or
 * null when none is eligible for one unit of this commitment.
 */
async function bestAlternative(remaining: readonly SeatedAdapter[], subject: EffectSubject, at: string): Promise<SeatedAdapter | null> {
  const ids = remaining.map((one) => providerCounterpartyId(one.seat));
  const events = await recordedReservationEvents(ids);
  const candidates = await Promise.all(remaining.map(async (one) => withPerformance(await alternativeCounterparty(one.seat), events, at)));
  const comparison = compareFulfillers({ id: subject.commitmentId, capacityUnits: 1 }, candidates);
  const best = comparison.primary;
  return best ? remaining.find((one) => providerCounterpartyId(one.seat) === best.counterpartyId) ?? null : null;
}

/**
 * Hold the alternative for the commitment the current fulfiller refused. A
 * FAILED hold is transferred (release and new hold in one statement); a
 * commitment nobody held is reserved on the alternative. Either way the
 * alternative's own reported capacity and the live grant decide, and a refusal
 * is the answer — the effect is then not sent through it.
 */
async function holdAlternative(
  current: { seat: ProviderSeat; key: string | null; held: boolean },
  to: ProviderSeat,
  subject: EffectSubject,
  toKey: string,
  toCapacity: number | null,
  at: string,
): Promise<{ ok: boolean; decision: string }> {
  const toId = providerCounterpartyId(to);
  if (current.held && current.key) {
    const plan = await recordTransfer(
      {
        primaryCounterpartyId: providerCounterpartyId(current.seat),
        primaryKey: current.key,
        alternativeKey: toKey,
        alternativeCounterpartyId: toId,
        alternativeCapacityUnits: toCapacity,
        at,
      },
      BRAIN,
      to.action,
    );
    return plan.action === 'TRANSFER'
      ? { ok: true, decision: `TRANSFER: ${current.seat.provider} refused ${subject.commitmentId}; released and held on ${to.provider}` }
      : { ok: false, decision: plan.action === 'UNKNOWN' ? `UNKNOWN: ${plan.detail}` : `REFUSED ${plan.reason}: ${plan.detail}` };
  }
  const answer = await recordReservation(
    { key: toKey, counterpartyId: toId, commitmentId: subject.commitmentId, businessId: subject.projectId, units: 1, ...dayWindow(at), capacityUnits: toCapacity, at },
    BRAIN,
    to.action,
  );
  return answer.ok
    ? { ok: true, decision: `RESERVED: ${current.seat.provider} refused ${subject.commitmentId} without a hold; held on ${to.provider}` }
    : { ok: false, decision: `REFUSED ${answer.reason}${'detail' in answer ? `: ${answer.detail}` : ''}` };
}

function reportRecordingFailure(seat: ProviderSeat, stage: string, error: unknown): void {
  // Never the payload or a setting: the provider, the stage and the error's own message.
  console.error(`[counterparty] ${seat.provider} ${stage} not recorded: ${error instanceof Error ? error.message : 'unknown error'}`);
}

/** Carried by a wrapped adapter, naming the counterparty its sends are recorded against. */
export const RECORDS_COUNTERPARTY: unique symbol = Symbol.for('brain.cash.recordsCounterparty');

/** The same adapter, whose every send is recorded as a counterparty commitment. */
export function recordingCounterparty(adapter: EffectAdapter, seat: ProviderSeat): EffectAdapter & { [RECORDS_COUNTERPARTY]: string } {
  return failoverCounterparty({ adapter, seat }, []);
}

/** Carried by a failover adapter, naming every alternative counterparty behind its primary. */
export const ALTERNATIVE_COUNTERPARTIES: unique symbol = Symbol.for('brain.cash.alternativeCounterparties');

/**
 * One adapter for one operation namespace, fulfilled by the chosen provider and,
 * after its definite refusal, by the alternatives the deployment named — each
 * send recorded as a counterparty commitment. It presents the primary's identity
 * and contract to the engine (one adapter per namespace); an alternative whose
 * effect class differs is not seated, because the engine's promise about a
 * retry is the primary's and an alternative must keep the same one.
 */
export function failoverCounterparty(
  primary: SeatedAdapter,
  alternatives: readonly SeatedAdapter[],
): EffectAdapter & { [RECORDS_COUNTERPARTY]: string; [ALTERNATIVE_COUNTERPARTIES]: string[] } {
  const seated = alternatives.filter(
    (one) => one.adapter.effectClass === primary.adapter.effectClass && providerCounterpartyId(one.seat) !== providerCounterpartyId(primary.seat),
  );
  const redactors = new Map<string, EffectAdapter>([[primary.seat.provider, primary.adapter], ...seated.map((one) => [one.seat.provider, one.adapter] as const)]);
  return {
    ...primary.adapter,
    [RECORDS_COUNTERPARTY]: providerCounterpartyId(primary.seat),
    [ALTERNATIVE_COUNTERPARTIES]: seated.map((one) => providerCounterpartyId(one.seat)),
    ...(primary.adapter.redactReceipt || seated.some((one) => one.adapter.redactReceipt)
      ? {
          redactReceipt(meta: Record<string, unknown>): Record<string, unknown> {
            // A receipt is redacted by the provider that issued it, and keeps naming that provider.
            const by = typeof meta.fulfilledBy === 'string' ? meta.fulfilledBy : null;
            const issuer = (by && redactors.get(by)) || primary.adapter;
            const redacted = issuer.redactReceipt ? issuer.redactReceipt(meta) : meta;
            return by && redactors.has(by) ? { ...redacted, fulfilledBy: by } : redacted;
          },
        }
      : {}),
    async send(request: EffectRequest): Promise<SendOutcome> {
      return (await recordProviderAttempt(primary.seat, request, () => primary.adapter.send(request), undefined, seated)).outcome;
    },
  };
}
