/**
 * The transitions of a deal after its first real action: what the buyer said,
 * what was agreed, what was billed, and whether the work was done.
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
 *   - **No delivery from an intention.** A fulfilment is work created in
 *     existing machinery; it is performed when that machinery says so (or a
 *     person records evidence for work done outside Brain), and delivered only
 *     against acceptance evidence.
 *   - **No figure composed.** An invoice is for what is still invoiceable
 *     against a live agreement; nothing here chooses a price.
 */
import { createHash } from 'node:crypto';
import { getOpportunity, transitionOpportunity } from '../../../repos/cashPortfolio.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { getCommitment } from '../../../repos/cashAuthority.ts';
import { getJob } from '../../../repos/cashJobs.ts';
import { getCandidate } from '../../../repos/russellCandidates.ts';
import { getChangeRequest } from '../../../repos/factory.ts';
import {
  agreementsFor,
  closeInvoiceRow,
  endFulfilment,
  fulfilmentsFor,
  getAgreement,
  getFulfilment,
  getInvoice,
  getObservation,
  insertAgreement,
  insertFulfilment,
  insertInvoice,
  insertObservation,
  invoicesFor,
  markFulfilmentDelivered,
  markFulfilmentPerformed,
  releaseAgreementRow,
} from '../../../repos/cashJourney.ts';
import { recordMoneyEvent, refuse, type Outcome } from '../opportunities.ts';
import {
  AGREEMENT_EVIDENCE_KINDS,
  FULFILMENT_PATHS,
  FULFILMENT_WORK_KINDS,
  OBSERVATION_KINDS,
  WORK_KINDS_FOR_PATH,
  isOneOf,
  type CashAgreement,
  type CashFulfilment,
  type CashInvoice,
  type CashObservation,
  type ObservationSource,
} from '../../../domain/cashJourney.ts';
import { dealPosition, invoiceRoomByAgreement } from './position.ts';

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
  if ((input.kind === 'BUYER_COUNTERED' || input.kind === 'SUPPLIER_COST_CHANGED') && !input.amountCents) {
    return refuse('A counter-offer or a changed cost carries the amount the other side stated.');
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

export function agreementLedgerKey(agreementId: string): string {
  return `agreement:${agreementId}`;
}
export function releaseLedgerKey(agreementId: string): string {
  return `agreement-released:${agreementId}`;
}

/**
 * Write the ledger entry an agreement implies, once. Called straight after the
 * agreement and again by the tick, so a crash between the two is finished on
 * the next pass rather than leaving an agreement the ledger does not count.
 */
export async function ensureAgreementLedger(agreement: CashAgreement): Promise<void> {
  await recordMoneyEvent({
    projectId: agreement.projectId,
    opportunityId: agreement.opportunityId,
    kind: 'PIPELINE_AGREED',
    amountCents: agreement.amountCents,
    currency: agreement.currency,
    note: `Agreement ${agreement.id}: ${agreement.deliverable}`,
    idempotencyKey: agreementLedgerKey(agreement.id),
    actorRef: agreement.recordedBy,
  });
  if (agreement.state === 'RELEASED') {
    await recordMoneyEvent({
      projectId: agreement.projectId,
      opportunityId: agreement.opportunityId,
      kind: 'PIPELINE_RELEASED',
      amountCents: agreement.amountCents,
      currency: agreement.currency,
      note: `Agreement ${agreement.id} released: ${agreement.releasedReason ?? ''}`,
      idempotencyKey: releaseLedgerKey(agreement.id),
      actorRef: agreement.releasedBy ?? agreement.recordedBy,
    });
  }
}

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
  const written = await insertAgreement({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    amountCents: input.amountCents,
    currency: input.currency,
    deliverable: input.deliverable.trim(),
    acceptanceCondition: input.acceptanceCondition.trim(),
    evidenceKind: input.evidenceKind,
    evidenceRef: input.evidenceRef.trim(),
    observationId: input.observationId ?? null,
    recordedBy: input.actorRef,
    requestKey,
  });
  await ensureAgreementLedger(written.row);
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
  const moved = await releaseAgreementRow({ id: agreement.id, reason: input.reason.trim(), by: input.actorRef });
  const after = (await getAgreement(agreement.id))!;
  if (!moved && agreement.state !== 'RELEASED') return refuse('This agreement could not be released.');
  await ensureAgreementLedger(after);
  for (const invoice of await invoicesFor(agreement.opportunityId)) {
    if (invoice.agreementId === agreement.id && invoice.state === 'ISSUED') {
      await closeInvoiceRow({ id: invoice.id, to: 'VOID', reason: `The agreement was released: ${input.reason.trim()}` });
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

/* ------------------------------------------------------------------------- */
/* Invoices                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * What the next invoice may be for: the oldest live agreement with room on it,
 * and no more than the deal as a whole still has invoiceable.
 */
export async function nextInvoiceTarget(input: {
  opportunityId: string;
  currency: string;
}): Promise<Outcome<{ agreementId: string; amountCents: number }>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const position = await dealPosition({ opportunity, currency: input.currency });
  if (position.pnl.agreedRevenueCents <= 0) {
    return refuse(
      position.pnl.unbackedAgreedCents > 0
        ? 'An amount is recorded as agreed with no agreement behind it. Record the agreement — the ' +
            'deliverable, the acceptance condition and the evidence — before anything is invoiced.'
        : 'No agreement is recorded for this piece, so there is nothing to invoice. Brain does not ' +
            'choose what a customer is billed.',
    );
  }
  if (position.pnl.invoiceableCents <= 0) {
    return refuse('Everything agreed has already been invoiced or paid.');
  }
  const room = invoiceRoomByAgreement(position.agreements, position.invoices).find((one) => one.roomCents > 0);
  if (!room) return refuse('Everything agreed has already been invoiced.');
  return {
    ok: true,
    value: {
      agreementId: room.agreement.id,
      amountCents: Math.min(room.roomCents, position.pnl.invoiceableCents),
    },
    message: 'Ready to invoice.',
  };
}

/** The invoice row a confirmed provider effect implies, keyed by the operation. */
export async function recordInvoiceFromEffect(input: {
  opportunityId: string;
  agreementId: string;
  amountCents: number;
  currency: string;
  operationId: string;
  receiptRef: string;
  actorRef: string;
}): Promise<CashInvoice | null> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return null;
  const agreement = await getAgreement(input.agreementId);
  if (!agreement || agreement.opportunityId !== opportunity.id) return null;
  const written = await insertInvoice({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    agreementId: agreement.id,
    amountCents: input.amountCents,
    currency: input.currency,
    issuedBy: 'BRAIN',
    providerRef: input.receiptRef,
    operationId: input.operationId,
    recordedBy: input.actorRef,
    requestKey: `invoice-effect:${input.operationId}`,
  });
  if (written.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_INVOICE_ISSUED',
      actorRef: input.actorRef,
      summary: `Invoiced ${input.amountCents} cents (provider reference ${input.receiptRef}).`,
      detail: { invoiceId: written.row.id, agreementId: agreement.id, operationId: input.operationId },
    });
  }
  return written.row;
}

/**
 * A person issued an invoice themselves and records it. Bounded by the same
 * invoiceable figure Brain's own invoice is, so a hand-recorded invoice cannot
 * bill an agreement twice either.
 */
export async function recordInvoiceByPerson(input: {
  opportunityId: string;
  agreementId: string;
  amountCents: number;
  providerRef: string;
  dueAt?: string | null;
  actorRef: string;
}): Promise<Outcome<CashInvoice>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const mode = await getCashMode(opportunity.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  const missing = required(input.providerRef, "The invoice's own reference");
  if (missing) return refuse(missing);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse('An invoice amount is a whole number of cents greater than zero.');
  }
  const key = `invoice:${opportunity.id}:${digest(input.providerRef.trim())}`;
  const existing = (await invoicesFor(opportunity.id)).find((one) => one.requestKey === key);
  if (existing) return { ok: true, value: existing, message: 'This invoice was already recorded.' };
  const position = await dealPosition({ opportunity, currency: mode.currency });
  const room = invoiceRoomByAgreement(position.agreements, position.invoices).find(
    (one) => one.agreement.id === input.agreementId,
  );
  if (!room) return refuse('No live agreement with that id on this piece.');
  const limit = Math.min(room.roomCents, position.pnl.invoiceableCents);
  if (input.amountCents > limit) {
    return refuse(
      `Only ${limit} cents of that agreement is still invoiceable, and this invoice is for ` +
        `${input.amountCents}. Billing more than was agreed would be a second invoice for the same work.`,
    );
  }
  const written = await insertInvoice({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    agreementId: input.agreementId,
    amountCents: input.amountCents,
    currency: mode.currency,
    issuedBy: 'PERSON',
    providerRef: input.providerRef.trim(),
    dueAt: input.dueAt ?? null,
    recordedBy: input.actorRef,
    requestKey: key,
  });
  if (written.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_INVOICE_ISSUED',
      actorRef: input.actorRef,
      summary: `Invoice ${written.row.providerRef} recorded for ${input.amountCents} cents.`,
      detail: { invoiceId: written.row.id, agreementId: input.agreementId },
    });
  }
  return { ok: true, value: written.row, message: written.created ? 'Recorded.' : 'Already recorded.' };
}

/** An invoice that will not be paid as issued: voided, or expired. */
export async function closeInvoice(input: {
  invoiceId: string;
  to: 'VOID' | 'EXPIRED';
  reason: string;
  actorRef: string;
}): Promise<Outcome<CashInvoice>> {
  const invoice = await getInvoice(input.invoiceId);
  if (!invoice) return refuse('No invoice with that id.');
  const missing = required(input.reason, 'Why');
  if (missing) return refuse(missing);
  const moved = await closeInvoiceRow({ id: invoice.id, to: input.to, reason: input.reason.trim() });
  if (!moved && invoice.state === 'ISSUED') return refuse('This invoice could not be closed.');
  if (moved) {
    await recordCashEvent({
      projectId: invoice.projectId,
      opportunityId: invoice.opportunityId,
      kind: `CASH_INVOICE_${input.to}`,
      actorRef: input.actorRef,
      summary: `Invoice ${invoice.providerRef} ${input.to.toLowerCase()}: ${input.reason.trim()}`,
      detail: { invoiceId: invoice.id },
    });
  }
  return { ok: true, value: (await getInvoice(invoice.id))!, message: moved ? 'Closed.' : 'Already closed.' };
}

/* ------------------------------------------------------------------------- */
/* Fulfilment                                                                 */
/* ------------------------------------------------------------------------- */

/** Whether the row a fulfilment names exists, read from the machinery that owns it. */
async function workExists(
  workKind: CashFulfilment['workKind'],
  workRef: string,
  projectId: string,
  opportunityId: string,
): Promise<string | null> {
  switch (workKind) {
    case 'RUSSELL_CANDIDATE':
      return (await getCandidate(workRef)) ? null : 'No Russell idea with that id.';
    case 'FACTORY_CHANGE_REQUEST':
      return (await getChangeRequest(workRef)) ? null : 'No Factory change request with that id.';
    case 'CASH_JOB': {
      const job = await getJob(workRef);
      return job && job.opportunityId === opportunityId ? null : 'No job with that id on this piece.';
    }
    case 'COMMITMENT': {
      const held = await getCommitment(workRef);
      return held && held.projectId === projectId && held.opportunityId === opportunityId
        ? null
        : 'No spending commitment with that id on this piece.';
    }
    case 'EXTERNAL':
      return workRef.trim() ? null : 'Name where the work is held outside Brain.';
  }
}

/**
 * Work created to deliver an agreement, in the machinery that does it.
 *
 * The first fulfilment moves the piece from EXECUTING to DELIVERING, because
 * that is what DELIVERING means now: work exists, rather than somebody having
 * pressed a button.
 */
export async function createFulfilment(input: {
  opportunityId: string;
  agreementId: string;
  path: string;
  workKind: string;
  workRef: string;
  actorRef: string;
}): Promise<Outcome<CashFulfilment>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  if (!AFTER_FIRST_ACTION.has(opportunity.state)) {
    return refuse(`This is ${opportunity.state.toLowerCase()}, and fulfilment follows an agreement on a piece being executed.`);
  }
  if (!isOneOf(FULFILMENT_PATHS, input.path)) {
    return refuse(`A fulfilment path is one of: ${FULFILMENT_PATHS.join(', ')}.`);
  }
  if (!isOneOf(FULFILMENT_WORK_KINDS, input.workKind)) {
    return refuse(`Work is held as one of: ${FULFILMENT_WORK_KINDS.join(', ')}.`);
  }
  if (!WORK_KINDS_FOR_PATH[input.path].includes(input.workKind)) {
    return refuse(
      `${input.path} work is held as ${WORK_KINDS_FOR_PATH[input.path].join(' or ')}, not ${input.workKind}.`,
    );
  }
  const agreement = await getAgreement(input.agreementId);
  if (!agreement || agreement.opportunityId !== opportunity.id || agreement.state !== 'AGREED') {
    return refuse('No live agreement with that id on this piece. Fulfilment delivers an agreement.');
  }
  const absent = await workExists(input.workKind, input.workRef, opportunity.projectId, opportunity.id);
  if (absent) return refuse(absent);
  const written = await insertFulfilment({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    agreementId: agreement.id,
    path: input.path,
    workKind: input.workKind,
    workRef: input.workRef.trim(),
    commitmentId: input.workKind === 'COMMITMENT' ? input.workRef.trim() : null,
    createdBy: input.actorRef,
    requestKey: `fulfilment:${agreement.id}:${input.workKind}:${digest(input.workRef.trim())}`,
  });
  if (written.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_FULFILMENT_CREATED',
      actorRef: input.actorRef,
      summary: `Fulfilment created (${input.path.toLowerCase()}): ${input.workKind} ${written.row.workRef}.`,
      detail: { fulfilmentId: written.row.id, agreementId: agreement.id },
    });
  }
  await moveToDelivering(opportunity.id, input.actorRef);
  return { ok: true, value: written.row, message: written.created ? 'Fulfilment created.' : 'Already created.' };
}

/** EXECUTING → DELIVERING once work exists. Idempotent; a no-op past it. */
export async function moveToDelivering(opportunityId: string, actorRef: string): Promise<boolean> {
  const live = (await fulfilmentsFor(opportunityId)).some((one) => one.state !== 'CANCELLED' && one.state !== 'FAILED');
  if (!live) return false;
  const moved = await transitionOpportunity({ id: opportunityId, from: ['EXECUTING'], to: 'DELIVERING' });
  if (moved) {
    const opportunity = (await getOpportunity(opportunityId))!;
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId,
      kind: 'CASH_DELIVERING',
      actorRef,
      summary: 'Work to deliver the agreement exists, so this is being delivered.',
      detail: {},
    });
  }
  return moved;
}

/**
 * A person records that work done outside Brain was performed, with evidence.
 *
 * Refused for Brain's own paths: whether a Russell mission or a Factory
 * campaign finished is read from those rows by the tick, and a person's say-so
 * standing in for Brain's own record would be the attestation §33 removed.
 */
export async function recordPerformed(input: {
  fulfilmentId: string;
  evidence: string;
  actorRef: string;
}): Promise<Outcome<CashFulfilment>> {
  const fulfilment = await getFulfilment(input.fulfilmentId);
  if (!fulfilment) return refuse('No fulfilment with that id.');
  if (fulfilment.workKind === 'RUSSELL_CANDIDATE' || fulfilment.workKind === 'FACTORY_CHANGE_REQUEST') {
    return refuse('This work is Brain\'s, so whether it was performed is read from its own rows, not recorded.');
  }
  const missing = required(input.evidence, 'Evidence that the work was performed');
  if (missing) return refuse(missing);
  return await performed(fulfilment, input.evidence.trim(), input.actorRef);
}

export async function performed(
  fulfilment: CashFulfilment,
  evidence: string,
  actorRef: string,
): Promise<Outcome<CashFulfilment>> {
  const moved = await markFulfilmentPerformed(fulfilment.id, evidence);
  if (!moved && fulfilment.state !== 'PERFORMED' && fulfilment.state !== 'DELIVERED') {
    return refuse(`This fulfilment is ${fulfilment.state.toLowerCase()}, and performing it does not follow.`);
  }
  if (moved) {
    await recordCashEvent({
      projectId: fulfilment.projectId,
      opportunityId: fulfilment.opportunityId,
      kind: 'CASH_FULFILMENT_PERFORMED',
      actorRef,
      summary: `Work performed: ${evidence}`,
      detail: { fulfilmentId: fulfilment.id },
    });
  }
  return { ok: true, value: (await getFulfilment(fulfilment.id))!, message: moved ? 'Recorded.' : 'Already recorded.' };
}

/**
 * The buyer accepted the work. Needs a `DELIVERY_ACCEPTED` observation on this
 * piece — the evidence — and a fulfilment that was performed.
 */
export async function acceptDelivery(input: {
  fulfilmentId: string;
  observationId: string;
  actorRef: string;
}): Promise<Outcome<CashFulfilment>> {
  const fulfilment = await getFulfilment(input.fulfilmentId);
  if (!fulfilment) return refuse('No fulfilment with that id.');
  const seen = await getObservation(input.observationId);
  if (!seen || seen.opportunityId !== fulfilment.opportunityId || seen.kind !== 'DELIVERY_ACCEPTED') {
    return refuse('Acceptance needs the buyer\'s DELIVERY_ACCEPTED observation on this piece.');
  }
  if (fulfilment.state === 'DELIVERED') {
    return { ok: true, value: fulfilment, message: 'Already delivered.' };
  }
  if (fulfilment.state !== 'PERFORMED') {
    return refuse('The work has not been performed yet, so there is nothing for the buyer to have accepted.');
  }
  const moved = await markFulfilmentDelivered({ id: fulfilment.id, observationId: seen.id });
  if (moved) {
    await recordCashEvent({
      projectId: fulfilment.projectId,
      opportunityId: fulfilment.opportunityId,
      kind: 'CASH_FULFILMENT_DELIVERED',
      actorRef: input.actorRef,
      summary: `The buyer accepted the work (${seen.evidenceRef}).`,
      detail: { fulfilmentId: fulfilment.id, observationId: seen.id },
    });
  }
  return { ok: true, value: (await getFulfilment(fulfilment.id))!, message: 'Delivered.' };
}

/** The work failed, or will not be done. Keeps the row with its reason. */
export async function endFulfilmentWith(input: {
  fulfilmentId: string;
  to: 'FAILED' | 'CANCELLED';
  reason: string;
  actorRef: string;
}): Promise<Outcome<CashFulfilment>> {
  const fulfilment = await getFulfilment(input.fulfilmentId);
  if (!fulfilment) return refuse('No fulfilment with that id.');
  const missing = required(input.reason, 'Why');
  if (missing) return refuse(missing);
  const moved = await endFulfilment({ id: fulfilment.id, to: input.to, reason: input.reason.trim() });
  if (!moved && fulfilment.state !== input.to) {
    return refuse(`This fulfilment is ${fulfilment.state.toLowerCase()} and cannot be ${input.to.toLowerCase()}.`);
  }
  if (moved) {
    await recordCashEvent({
      projectId: fulfilment.projectId,
      opportunityId: fulfilment.opportunityId,
      kind: `CASH_FULFILMENT_${input.to}`,
      actorRef: input.actorRef,
      summary: `Fulfilment ${input.to.toLowerCase()}: ${input.reason.trim()}`,
      detail: { fulfilmentId: fulfilment.id },
    });
  }
  return { ok: true, value: (await getFulfilment(fulfilment.id))!, message: moved ? 'Recorded.' : 'Already recorded.' };
}

export { agreementsFor };
