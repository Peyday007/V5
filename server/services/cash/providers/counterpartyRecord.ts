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
 * Recording never changes the effect: the send's answer is returned exactly as
 * the provider gave it, and a recording failure is reported on the log (no
 * payload, no credential) rather than turned into a failed or repeated send.
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
  /** The alternative the model moved the commitment to, when it did. */
  transferredTo: string | null;
}

/**
 * The facts a provider's confirmed receipt establishes, recorded once per
 * change. Shared by the first attempt and by an alternative that took the
 * commitment over, so both are evidenced the same way.
 */
async function recordReceiptFacts(
  seat: ProviderSeat,
  subject: EffectSubject,
  receiptRef: string,
  capacity: number | null,
): Promise<number> {
  const counterpartyId = providerCounterpartyId(seat);
  const evidence = `${seat.provider} receipt ${receiptRef} for ${subject.commitmentId}`;
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
  if (changed.length === 0) return 0;
  return recordCounterpartyFacts({
    projectId: subject.projectId,
    counterparty: { id: counterpartyId, kind: 'software service', geography: null, humanOperator: false },
    facts: changed,
    actorRef: BRAIN,
  });
}

/**
 * Record one effect's commitment around the provider's own answer. Exported so
 * the wrapper and its tests drive the same code; `send` is the provider call.
 *
 * `alternativeIds` are the other counterparties the deployment registered for
 * the same commitment (`fulfillingCounterparties`). They are the candidates the
 * model's transfer chooses among after a refusal — the failed provider is
 * never its own alternative — and, on a retry, any hold an earlier transfer
 * left on one of them is released with the earlier attempts.
 */
export async function recordProviderAttempt(
  seat: ProviderSeat,
  request: EffectRequest,
  send: () => Promise<SendOutcome>,
  now: () => string = () => new Date().toISOString(),
  alternativeIds: readonly string[] = [],
): Promise<{ outcome: SendOutcome; recorded: RecordedAttempt }> {
  const counterpartyId = providerCounterpartyId(seat);
  const alternatives = [...new Set(alternativeIds)].filter((id) => id !== counterpartyId);
  const recorded: RecordedAttempt = { counterpartyId, subject: null, hold: null, outcome: null, facts: 0, transferred: false, transferredTo: null };
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
      if (subject.attempt > 0) {
        // A transfer holds the alternative under the commitment's own key (`reservationKey`), so a
        // retry releases that hold too; an absent or settled one is refused by the recorder, harmlessly.
        for (const alternative of alternatives) {
          await recordHoldOutcome({ counterpartyId: alternative, key: reservationKey(subject.commitmentId, alternative), kind: 'RELEASED', at, actorRef: BRAIN });
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

  // The provider call itself, untouched by anything above.
  const outcome = await send();

  try {
    const subject = recorded.subject;
    if (subject) {
      const at = now();
      const held = recorded.hold?.ok === true && key !== null;
      if (outcome.kind === 'CONFIRMED') {
        recorded.facts = await recordReceiptFacts(seat, subject, outcome.receiptRef, capacity);
      }
      if (held && outcome.kind !== 'UNCERTAIN') {
        const kind = outcome.kind === 'CONFIRMED' ? 'PERFORMED' : 'FAILED';
        const done = await recordHoldOutcome({ counterpartyId, key: key!, kind, at, actorRef: BRAIN });
        if (done.recorded) recorded.outcome = kind;
        if (kind === 'FAILED') {
          // The model's own transfer: to an alternative with evidenced capacity, or nothing at all.
          // The candidates are every fulfiller registered for this commitment, the failed one among
          // them so the model ranks it, and never picks it (`readTransfer` excludes the failed hold's party).
          const reading = await transferRecordedTransaction(
            {
              commitment: { id: subject.commitmentId, capacityUnits: 1 },
              candidateIds: [counterpartyId, ...alternatives],
              businessId: subject.projectId,
              window: dayWindow(at),
              action: seat.action,
              at,
              source: `${seat.provider} refused ${subject.commitmentId}`,
            },
            BRAIN,
          );
          recorded.transferred = reading.transfer.plan?.action === 'TRANSFER';
          recorded.transferredTo = recorded.transferred ? reading.transfer.to : null;
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

/** One registered provider for a commitment: the seat its sends are recorded under, and its adapter. */
export interface ProviderFulfiller {
  seat: ProviderSeat;
  adapter: EffectAdapter;
}

/** Whether a fulfiller can carry this request at all: its own validation, which sends nothing. */
function accepts(adapter: EffectAdapter, payload: Record<string, unknown>): boolean {
  try {
    adapter.validate(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commitment carried by the alternative the model transferred it to: the
 * alternative's own send, and its answer recorded on the hold the transfer
 * took (`reservationKey(commitment, alternative)`). An uncertain answer leaves
 * that hold HELD (invariant 26); the facts a receipt establishes are recorded
 * exactly as for a first attempt.
 */
async function carryTransferred(
  alternative: ProviderFulfiller,
  subject: EffectSubject,
  request: EffectRequest,
  now: () => string,
): Promise<SendOutcome> {
  const counterpartyId = providerCounterpartyId(alternative.seat);
  const capacity = await alternative.seat.capacityPerDay().catch(() => null);
  const outcome = await alternative.adapter.send(request);
  try {
    if (outcome.kind === 'CONFIRMED') await recordReceiptFacts(alternative.seat, subject, outcome.receiptRef, capacity);
    if (outcome.kind !== 'UNCERTAIN') {
      await recordHoldOutcome({
        counterpartyId,
        key: reservationKey(subject.commitmentId, counterpartyId),
        kind: outcome.kind === 'CONFIRMED' ? 'PERFORMED' : 'FAILED',
        at: now(),
        actorRef: BRAIN,
      });
    }
  } catch (error) {
    reportRecordingFailure(alternative.seat, 'transferred outcome', error);
  }
  return outcome;
}

/**
 * Every fulfiller a deployment registered for one commitment, as the one
 * adapter its operation namespace resolves to (`effects.ts` `adapterFor`).
 *
 * The first is the deployment's chosen provider and is sent to first; the rest
 * are its alternatives. A definite refusal from the first is offered to the
 * model's transfer with every fulfiller that can carry the request as a
 * candidate, and when the model moves the commitment — only to an alternative
 * that has quoted, has evidenced capacity, and only under the live grant,
 * releasing the failed hold in the same write — the alternative carries it and
 * its answer is the effect's answer. No transfer, no second send: an uncertain
 * first answer, a refusal the model would not move, or an alternative that
 * cannot carry the payload returns the first provider's answer unchanged, so
 * nothing is ever sent twice on an unknown (invariant 26).
 *
 * The fulfillers must share one namespace and one effect class, since the
 * engine treats the composite as one adapter of that class; a reconcilable
 * composite answers ABSENT only when every fulfiller does.
 */
export function fulfillingCounterparties(
  fulfillers: readonly ProviderFulfiller[],
  now: () => string = () => new Date().toISOString(),
): EffectAdapter & { [RECORDS_COUNTERPARTY]: string } {
  const [primary, ...alternatives] = fulfillers;
  if (!primary) throw new Error('fulfillingCounterparties needs at least one fulfiller');
  if (alternatives.length === 0) return recordingCounterparty(primary.adapter, primary.seat);
  for (const one of alternatives) {
    if (one.adapter.namespace !== primary.adapter.namespace || one.adapter.effectClass !== primary.adapter.effectClass) {
      throw new Error(`${one.adapter.name} cannot be an alternative to ${primary.adapter.name}: it serves another namespace or effect class`);
    }
  }
  const limits = fulfillers.map((f) => f.adapter.providerKeyLimit).filter((n): n is number => typeof n === 'number');
  const composite: EffectAdapter & { [RECORDS_COUNTERPARTY]: string } = {
    ...primary.adapter,
    ...(limits.length > 0 ? { providerKeyLimit: Math.min(...limits) } : {}),
    [RECORDS_COUNTERPARTY]: providerCounterpartyId(primary.seat),
    async send(request: EffectRequest): Promise<SendOutcome> {
      const able = alternatives.filter((one) => accepts(one.adapter, request.payload));
      const first = await recordProviderAttempt(
        primary.seat,
        request,
        () => primary.adapter.send(request),
        now,
        able.map((one) => providerCounterpartyId(one.seat)),
      );
      const to = first.recorded.transferredTo;
      const alternative = to ? able.find((one) => providerCounterpartyId(one.seat) === to) : undefined;
      if (!alternative || !first.recorded.subject) return first.outcome;
      return carryTransferred(alternative, first.recorded.subject, request, now);
    },
  };
  if (primary.adapter.reconcile) {
    composite.reconcile = async (businessId: string) => {
      let inconclusive: string | null = null;
      for (const one of fulfillers) {
        const answer = one.adapter.reconcile ? await one.adapter.reconcile(businessId) : { kind: 'INCONCLUSIVE' as const, reason: `${one.adapter.name} cannot be asked` };
        if (answer.kind === 'FOUND') return answer;
        if (answer.kind === 'INCONCLUSIVE') inconclusive ??= answer.reason;
      }
      return inconclusive ? { kind: 'INCONCLUSIVE', reason: inconclusive } : { kind: 'ABSENT' };
    };
  }
  return composite;
}
