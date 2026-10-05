/**
 * The transitions of a deal after its first real action: what the buyer said
 * and what was agreed. What was billed is `invoicing.ts`; the obligation an
 * agreement creates is `fulfillment.ts`.
 *
 * Every function here is a guarded, idempotent write with a named refusal, and
 * none of them sends anything. Contacting a buyer, issuing an invoice through a
 * provider and taking a payment are `perform.ts`' and go through
 * `runExternalEffect` and nothing beside it; what this module adds is the
 * structure those effects act on and the record of what came back.
 *
 * Three rules hold throughout, and each one is the shortcut this file could
 * most easily have taken:
 *
 *   - **No agreement from interest.** An agreement needs the deliverable, the
 *     acceptance condition, an amount and evidence somebody can point at. A
 *     buyer replying is an observation, never an agreement.
 *  *   - **No figure composed.** An invoice is for what is still invoiceable
 *     against a live agreement; nothing here chooses a price.
 */
import { createHash } from 'node:crypto';
import { getOpportunity, transitionOpportunity } from '../../../repos/cashPortfolio.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import {
  agreementsFor,
  getAgreement,
  getObservation,
  insertAgreement,
  insertObservation,
  releaseAgreementRow,
} from '../../../repos/cashJourney.ts';
import { serializeCash } from '../../../repos/cashLock.ts';
import { recordMoneyEvent, refuse, type Outcome } from '../opportunities.ts';
import {
  AGREEMENT_EVIDENCE_KINDS,
  OBSERVATION_KINDS,
  isOneOf,
  type AgreementEvidenceKind,
  type CashAgreement,
  type CashObservation,
  type ObservationSource,
} from '../../../domain/cashJourney.ts';
import { agreementLedgerKey } from './position.ts';
import { getInvoice, listInvoices, moveInvoice } from '../../../repos/cashInvoices.ts';
import { moneyEntryByKey } from '../../../repos/cashLedger.ts';
import { raiseNeed } from '../needs.ts';

const AFTER_FIRST_ACTION = new Set(['EXECUTING', 'DELIVERING']);

function digest(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((one) => String(one ?? '')).join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 20);
}

function required(value: unknown, label: string): string | null {
  return typeof value === 'string' && value.trim() ? null : `${label} is required.`;
}

/* ------------------------------------------------------------------------- */
/* Observations                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Something the buyer or the world said about this deal, kept as evidence.
 *
 * `BUYER_SILENT` is refused here: silence is derived by the tick from a
 * contact and the absence of a reply, never asserted.
 */
export async function recordObservation(input: {
  opportunityId: string;
  kind: string;
  source: ObservationSource;
  evidenceRef: string;
  channel?: string | null;
  amountCents?: number | null;
  note?: string | null;
  observedAt?: string;
  actorRef: string;
  requestKey?: string;
}): Promise<Outcome<CashObservation>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  if (!isOneOf(OBSERVATION_KINDS, input.kind)) {
    return refuse(`"${input.kind}" is not an observation Brain records. It records one of: ${OBSERVATION_KINDS.join(', ')}.`);
  }
  if (input.kind === 'BUYER_SILENT' && input.source !== 'BRAIN') {
    return refuse('Silence is derived by Brain from a contact with no reply; it is not recorded by hand.');
  }
  const missing = required(input.evidenceRef, 'A reference somebody can check (a message id, a document, a provider record)');
  if (missing) return refuse(missing);
  if (input.amountCents !== undefined && input.amountCents !== null) {
    if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
      return refuse('An amount is a whole, non-negative number of cents.');
    }
  }
  if (input.kind === 'BUYER_COUNTERED' && !input.amountCents) {
    return refuse('A counter-offer carries the amount the buyer stated.');
  }
  const mode = await getCashMode(opportunity.projectId);
  const key =
    input.requestKey ?? `observation:${opportunity.id}:${input.kind}:${digest(input.evidenceRef)}`;
  const written = await insertObservation({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: input.kind,
    source: input.source,
    channel: input.channel ?? opportunity.reachableChannel,
    evidenceRef: input.evidenceRef.trim(),
    amountCents: input.amountCents ?? null,
    currency: input.amountCents ? (mode?.currency ?? null) : null,
    note: input.note ?? null,
    observedAt: input.observedAt,
    recordedBy: input.actorRef,
    requestKey: key,
  });
  if (written.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_OBSERVATION_RECORDED',
      actorRef: input.actorRef,
      summary: `Observed ${input.kind.toLowerCase().replace(/_/g, ' ')} (${input.source.toLowerCase()}).`,
      detail: { observationId: written.row.id, kind: input.kind, evidenceRef: written.row.evidenceRef },
    });
  }
  return {
    ok: true,
    value: written.row,
    message: written.created ? 'Recorded.' : 'This observation was already recorded.',
  };
}

/* ------------------------------------------------------------------------- */
/* Agreements                                                                 */
/* ------------------------------------------------------------------------- */

export { agreementLedgerKey };
export function releaseLedgerKey(agreementId: string): string {
  return `agreement-released:${agreementId}`;
}

/**
 * Write the ledger entry an agreement implies, once. Called straight after the
 * agreement and again by the tick, so a crash between the two is finished on
 * the next pass rather than leaving an agreement the ledger does not count.
 */
export async function ensureAgreementLedger(agreement: CashAgreement): Promise<Outcome<null>> {
  const agreed = await recordMoneyEvent({
    projectId: agreement.projectId,
    opportunityId: agreement.opportunityId,
    kind: 'PIPELINE_AGREED',
    amountCents: agreement.amountCents,
    currency: agreement.currency,
    note: `Agreement ${agreement.id}: ${agreement.deliverable}`,
    idempotencyKey: agreementLedgerKey(agreement.id),
    actorRef: agreement.recordedBy,
  });
  if (!agreed.ok) return agreed;
  if (agreement.state === 'RELEASED') {
    const released = await recordMoneyEvent({
      projectId: agreement.projectId,
      opportunityId: agreement.opportunityId,
      kind: 'PIPELINE_RELEASED',
      amountCents: agreement.amountCents,
      currency: agreement.currency,
      note: `Agreement ${agreement.id} released: ${agreement.releasedReason ?? ''}`,
      idempotencyKey: releaseLedgerKey(agreement.id),
      actorRef: agreement.releasedBy ?? agreement.recordedBy,
    });
    if (!released.ok) return released;
  }
  return { ok: true, value: null, message: 'The ledger counts this agreement.' };
}

/** A refusal inside the cash lock, thrown so the transaction rolls back whole. */
class RefusedInLock extends Error {}

/**
 * The buyer agreed: an amount, a deliverable, an acceptance condition, and the
 * evidence that they agreed.
 *
 * Only after a real action exists (EXECUTING or DELIVERING), because an
 * agreement on a piece nobody has contacted is an agreement nobody made. An
 * observation it is drawn from must be this piece's, and must be one that can
 * carry agreement — an acceptance or a counter — never a reply.
 */
export async function recordAgreement(input: {
  opportunityId: string;
  amountCents: number;
  currency: string;
  deliverable: string;
  acceptanceCondition: string;
  evidenceKind: string;
  evidenceRef: string;
  observationId?: string | null;
  actorRef: string;
}): Promise<Outcome<CashAgreement>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  if (!AFTER_FIRST_ACTION.has(opportunity.state)) {
    return refuse(
      `This is ${opportunity.state.toLowerCase()}. An agreement follows a real action — the buyer ` +
        'reached, an offer sent — so execution has to have begun first.',
    );
  }
  for (const [value, label] of [
    [input.deliverable, 'What is being delivered'],
    [input.acceptanceCondition, 'What counts as acceptance'],
    [input.evidenceRef, 'The evidence that the buyer agreed'],
  ] as const) {
    const missing = required(value, label);
    if (missing) return refuse(missing);
  }
  if (!isOneOf(AGREEMENT_EVIDENCE_KINDS, input.evidenceKind)) {
    return refuse(
      `An agreement is evidenced by one of: ${AGREEMENT_EVIDENCE_KINDS.join(', ')}. Interest is an ` +
        'observation, not an agreement.',
    );
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse('An agreed amount is a whole number of cents greater than zero.');
  }
  const mode = await getCashMode(opportunity.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  if (mode.currency !== input.currency) {
    return refuse(`This sprint keeps its money in ${mode.currency}; Brain does not convert an agreement in ${input.currency}.`);
  }
  if (input.observationId) {
    const seen = await getObservation(input.observationId);
    if (!seen || seen.opportunityId !== opportunity.id) return refuse('No observation with that id on this piece.');
    if (seen.kind !== 'BUYER_ACCEPTED' && seen.kind !== 'BUYER_COUNTERED') {
      return refuse('Only an acceptance or a counter-offer can stand behind an agreement; a reply is not one.');
    }
    if (seen.kind === 'BUYER_COUNTERED' && seen.amountCents !== input.amountCents) {
      return refuse('The agreed amount differs from the counter-offer it is drawn from.');
    }
  }
  const requestKey = `agreement:${opportunity.id}:${digest(
    input.amountCents,
    input.deliverable.trim(),
    input.acceptanceCondition.trim(),
    input.evidenceRef.trim(),
  )}`;
  /*
   * The agreement and its PIPELINE_AGREED entry are one decision, in one
   * transaction under the cash lock: there is no moment at which an agreement
   * exists the ledger does not count, or an amount is counted that no
   * agreement stands behind. The tick's `ensureAgreementLedger` stays as the
   * backstop for rows written before this was so.
   */
  let written: Awaited<ReturnType<typeof insertAgreement>>;
  try {
    written = await serializeCash(opportunity.projectId, mode.currency, async () => {
      const row = await insertAgreement({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        amountCents: input.amountCents,
        currency: input.currency,
        deliverable: input.deliverable.trim(),
        acceptanceCondition: input.acceptanceCondition.trim(),
        evidenceKind: input.evidenceKind as AgreementEvidenceKind,
        evidenceRef: input.evidenceRef.trim(),
        observationId: input.observationId ?? null,
        recordedBy: input.actorRef,
        requestKey,
      });
      const counted = await ensureAgreementLedger(row.row);
      if (!counted.ok) throw new RefusedInLock(counted.reason);
      return row;
    });
  } catch (error) {
    if (error instanceof RefusedInLock) return refuse(error.message);
    throw error;
  }
  if (written.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_AGREEMENT_RECORDED',
      actorRef: input.actorRef,
      summary: `Agreed ${input.amountCents} cents for: ${written.row.deliverable}.`,
      detail: { agreementId: written.row.id, evidenceKind: input.evidenceKind, evidenceRef: written.row.evidenceRef },
    });
  }
  return {
    ok: true,
    value: written.row,
    message: written.created ? 'Agreement recorded. It is pipeline: nothing has been paid.' : 'This agreement was already recorded.',
  };
}

/**
 * An agreement that will not be billed any further — the buyer disappeared,
 * the scope was cut, a new agreement replaced it.
 *
 * Destroys nothing: the row stays, its `PIPELINE_AGREED` stays, and a
 * `PIPELINE_RELEASED` is written beside it. Unpaid invoices against it are
 * voided in the same pass, because billing against an agreement nobody holds
 * is billing for nothing. Money already paid stays paid; returning it is a
 * refund, which is its own entry with its own reference.
 */
export async function releaseAgreement(input: {
  agreementId: string;
  reason: string;
  actorRef: string;
}): Promise<Outcome<CashAgreement>> {
  const agreement = await getAgreement(input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  const missing = required(input.reason, 'Why the agreement is released');
  if (missing) return refuse(missing);
  // The release and its PIPELINE_RELEASED entry are one decision, as the
  // agreement and its PIPELINE_AGREED entry were.
  let moved: boolean;
  try {
    moved = await serializeCash(agreement.projectId, agreement.currency, async () => {
      const did = await releaseAgreementRow({ id: agreement.id, reason: input.reason.trim(), by: input.actorRef });
      const counted = await ensureAgreementLedger((await getAgreement(agreement.id))!);
      if (!counted.ok) throw new RefusedInLock(counted.reason);
      return did;
    });
  } catch (error) {
    if (error instanceof RefusedInLock) return refuse(error.message);
    throw error;
  }
  const after = (await getAgreement(agreement.id))!;
  if (!moved && after.state !== 'RELEASED') return refuse('This agreement could not be released.');
  /*
   * What was billed against it. A draft nothing has sent is voided here; an
   * invoice the provider holds cannot be unsent from Brain's side, so an open
   * need names it for a person to void at the provider — never a state
   * written over a provider record Brain has not changed.
   */
  const entry = await moneyEntryByKey(agreement.projectId, agreementLedgerKey(agreement.id));
  if (entry) {
    for (const invoice of await listInvoices({ projectId: agreement.projectId, opportunityId: agreement.opportunityId })) {
      if (invoice.pipelineEntryId !== entry.id) continue;
      let state = invoice.state;
      if (state === 'DRAFTED') {
        const voided = await moveInvoice({
          id: invoice.id,
          from: 'DRAFTED',
          to: 'VOID',
          patch: { stateReason: `The agreement was released before it was sent: ${input.reason.trim()}` },
        });
        // A send claimed the draft first (`invoicing.ts`): it may now be at the
        // provider, so it is asked about below rather than silently left live.
        if (!voided) state = (await getInvoice(invoice.id))?.state ?? state;
      }
      if (state === 'ISSUED' || state === 'UNCERTAIN') {
        await raiseNeed({
          projectId: agreement.projectId,
          opportunityId: agreement.opportunityId,
          actorRef: 'BRAIN',
          blockedAction: `Void invoice ${invoice.providerNumber ?? invoice.id} at the provider`,
          whyItMatters:
            'Its agreement was released, and the provider still holds an invoice the buyer can pay. ' +
            'Brain does not unsend it on its own.',
          recommendedPath: 'Void the invoice at the invoicing provider; Brain reads the voided state back.',
          setupEffort: 'A minute.',
          nextStep: `Void ${invoice.providerInvoiceId ?? invoice.id} at the provider.`,
          completionCondition: 'The provider reads the invoice as void.',
          requestKey: `void-released:${invoice.id}`,
        });
      }
    }
  }
  if (moved) {
    await recordCashEvent({
      projectId: agreement.projectId,
      opportunityId: agreement.opportunityId,
      kind: 'CASH_AGREEMENT_RELEASED',
      actorRef: input.actorRef,
      summary: `Agreement released: ${input.reason.trim()}`,
      detail: { agreementId: agreement.id, amountCents: agreement.amountCents },
    });
  }
  return { ok: true, value: after, message: moved ? 'Released.' : 'This agreement was already released.' };
}

export { agreementsFor };
