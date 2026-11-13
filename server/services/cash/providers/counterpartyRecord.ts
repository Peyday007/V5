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
 *     "it did not happen" (invariant 26). A FAILED hold is offered to the
 *     transfer the model plans (`transferRecordedTransaction`), which moves the
 *     commitment only to an alternative with evidenced capacity and never
 *     double-commits it;
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
import { factFor, recordCounterpartyFacts, recordedCounterparty, type Fact } from '../../labor/counterparties/ladder.ts';
import { recordHoldOutcome, recordReservation, type ReservationAnswer } from '../../labor/counterparties/reservations.ts';
import { reservationKey, transferRecordedTransaction } from '../../labor/counterparties/transaction.ts';

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
 */
export async function recordProviderAttempt(
  seat: ProviderSeat,
  request: EffectRequest,
  send: () => Promise<SendOutcome>,
  now: () => string = () => new Date().toISOString(),
): Promise<{ outcome: SendOutcome; recorded: RecordedAttempt }> {
  const counterpartyId = providerCounterpartyId(seat);
  const recorded: RecordedAttempt = { counterpartyId, subject: null, hold: null, outcome: null, facts: 0, transferred: false, gated: null };
  let key: string | null = null;
  let capacity: number | null = null;
  try {
    const subject = await subjectOf(seat, request.businessId);
    recorded.subject = subject;
    if (subject) {
      const at = now();
      capacity = await seat.capacityPerDay().catch(() => null);
      key = `${reservationKey(subject.commitmentId, counterpartyId)}#${subject.attempt}`;
      // A retry exists only because a person closed the earlier attempts as not having happened
      // (`effects.ts`), so their holds are released rather than left to read as a second commitment.
      for (let earlier = 0; earlier < subject.attempt; earlier += 1) {
        await recordHoldOutcome({
          counterpartyId,
          key: `${reservationKey(subject.commitmentId, counterpartyId)}#${earlier}`,
          kind: 'RELEASED',
          at,
          actorRef: BRAIN,
        });
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
  const refusal = gatingRefusal(recorded.hold);
  if (refusal) {
    recorded.gated = refusal.reason;
    return { outcome: refusal.outcome, recorded };
  }

  // The provider call itself, untouched by anything above.
  const outcome = await send();

  try {
    const subject = recorded.subject;
    if (subject) {
      const at = now();
      const held = recorded.hold?.ok === true && key !== null;
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
        const changed = await changedFacts(counterpartyId, proposed);
        if (changed.length > 0) {
          recorded.facts = await recordCounterpartyFacts({
            projectId: subject.projectId,
            counterparty: { id: counterpartyId, kind: 'software service', geography: null, humanOperator: false },
            facts: changed,
            actorRef: BRAIN,
          });
        }
      }
      if (held && outcome.kind !== 'UNCERTAIN') {
        const kind = outcome.kind === 'CONFIRMED' ? 'PERFORMED' : 'FAILED';
        const done = await recordHoldOutcome({ counterpartyId, key: key!, kind, at, actorRef: BRAIN });
        if (done.recorded) recorded.outcome = kind;
        if (kind === 'FAILED') {
          // The model's own transfer: to an alternative with evidenced capacity, or nothing at all.
          const reading = await transferRecordedTransaction(
            {
              commitment: { id: subject.commitmentId, capacityUnits: 1 },
              candidateIds: [counterpartyId],
              businessId: subject.projectId,
              window: dayWindow(at),
              action: seat.action,
              at,
              source: `${seat.provider} refused ${subject.commitmentId}`,
            },
            BRAIN,
          );
          recorded.transferred = reading.transfer.plan?.action === 'TRANSFER';
        }
      } else if (held) {
        recorded.outcome = 'UNKNOWN';
      }
    }
  } catch (error) {
    reportRecordingFailure(seat, 'outcome', error);
  }
  return { outcome, recorded };
}

function reportRecordingFailure(seat: ProviderSeat, stage: string, error: unknown): void {
  // Never the payload or a setting: the provider, the stage and the error's own message.
  console.error(`[counterparty] ${seat.provider} ${stage} not recorded: ${error instanceof Error ? error.message : 'unknown error'}`);
}

/** Carried by a wrapped adapter, naming the counterparty its sends are recorded against. */
export const RECORDS_COUNTERPARTY: unique symbol = Symbol.for('brain.cash.recordsCounterparty');

/** The same adapter, whose every send is recorded as a counterparty commitment. */
export function recordingCounterparty(adapter: EffectAdapter, seat: ProviderSeat): EffectAdapter & { [RECORDS_COUNTERPARTY]: string } {
  return {
    ...adapter,
    [RECORDS_COUNTERPARTY]: providerCounterpartyId(seat),
    async send(request: EffectRequest): Promise<SendOutcome> {
      return (await recordProviderAttempt(seat, request, () => adapter.send(request))).outcome;
    },
  };
}
