/**
 * Issuing an invoice for an agreed amount, and learning — from the provider,
 * twice — that the customer paid and that the money became usable.
 *
 * ---------------------------------------------------------------------------
 * Brain chooses none of the terms
 * ---------------------------------------------------------------------------
 *
 * The amount and the currency are the `PIPELINE_AGREED` ledger entry the
 * invoice names — what somebody already recorded as agreed. The customer's
 * name and billing address, the tax treatment and the due date are what a
 * person recorded with the request. Every one of those is a fact Brain would
 * otherwise have to invent, and a wrong invoice sent to a real customer is not
 * something a later correction undoes. A missing term is a refusal naming it.
 *
 * ---------------------------------------------------------------------------
 * Three passes on the tick, each idempotent by its own rows
 * ---------------------------------------------------------------------------
 *
 *   issue      DRAFTED → ISSUED through `runExternalEffect`, under
 *              QUOTE_AND_INVOICE authority, only while ISSUE_AN_INVOICE reads
 *              PRESENT. An unknown outcome is UNCERTAIN with a need, and the
 *              next pass *asks the provider* under the same key rather than
 *              sending again — that is the recovery by prior request identity.
 *   payment    ISSUED → PAID when the provider says the customer paid. One
 *              CUSTOMER_PAYMENT, keyed on the invoice, under ACCEPT_PAYMENT.
 *   settlement PAID → SETTLED when the provider says the funds are available.
 *              One SETTLEMENT for the gross amount and one COST for the
 *              provider's fee, so available funds equal what actually landed
 *              and the fee is counted once, as a cost.
 *
 * The payment and the settlement are never one entry. `money.ts` exists to keep
 * them apart: a payment is not funds until the provider says it is.
 */
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { draftInvoice, getInvoice, listInvoices, moveInvoice } from '../../repos/cashInvoices.ts';
import { recordAction } from '../../repos/cashActions.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readCapability } from './capabilities.ts';
import { ISSUE_INVOICE_NAMESPACE, sendIssueInvoice, adapterStatus } from './effects.ts';
import { raiseNeed } from './needs.ts';
import { recordMoneyEvent } from './opportunities.ts';
import { usablePaymentReader } from './providers/payments.ts';
import { ADDRESS } from './providers/config.ts';
import { TAX_TREATMENTS, dueDateSeconds } from './providers/stripe.ts';
import type { ExternalOutcome } from '../effects/external.ts';
import type { CashInvoice } from '../../domain/types.ts';

const BRAIN = 'BRAIN';
const INVOICE_ACTION = 'QUOTE_AND_INVOICE';

/** How often one issued invoice is asked about. Not a deadline — a courtesy to the provider. */
export const PAYMENT_READ_INTERVAL_MS = 5 * 60 * 1000;

type Outcome<T> = { ok: true; value: T; message: string } | { ok: false; reason: string };

function refuse<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

/**
 * A person's request to invoice an agreed amount, recorded as a draft.
 *
 * Nothing is sent here. The tick issues it, under the standing authority and
 * only while a provider is usable, so a request made before a key exists is
 * kept and goes out by itself once one does.
 */
export async function requestInvoice(input: {
  projectId: string;
  opportunityId: string;
  pipelineEntryId?: string | null;
  customerName: string;
  customerEmail: string;
  taxTreatment: string;
  dueDate: string;
  actorRef: string;
  now?: Date;
}): Promise<Outcome<CashInvoice>> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');

  const agreed = (await listMoneyEntries({ projectId: input.projectId, opportunityId: opportunity.id, limit: 2000 }))
    .filter((one) => one.kind === 'PIPELINE_AGREED');
  if (agreed.length === 0) {
    return refuse(
      'Nothing has been recorded as agreed for this opportunity. Record the agreed amount as a ' +
        'PIPELINE_AGREED entry first — Brain does not choose what to bill.',
    );
  }
  let entry = agreed[0]!;
  if (input.pipelineEntryId) {
    const named = agreed.find((one) => one.id === input.pipelineEntryId);
    if (!named) return refuse('That agreed amount is not one recorded for this opportunity.');
    entry = named;
  } else if (agreed.length > 1) {
    return refuse(
      `${agreed.length} agreed amounts are recorded for this opportunity (${agreed
        .map((one) => one.id)
        .join(', ')}). Name the one to invoice; choosing for you would be a guess.`,
    );
  }
  if (entry.currency !== mode.currency) {
    return refuse(`The agreed amount is in ${entry.currency} and this sprint keeps its money in ${mode.currency}.`);
  }

  const customerName = input.customerName.trim();
  const customerEmail = input.customerEmail.trim();
  if (!customerName) return refuse('An invoice names the customer it bills.');
  if (!ADDRESS.test(customerEmail)) return refuse('An invoice is sent to one customer email address.');
  if (!(TAX_TREATMENTS as readonly string[]).includes(input.taxTreatment)) {
    return refuse(
      `The tax treatment is one of ${TAX_TREATMENTS.join(', ')}. An invoice that must charge tax ` +
        'is issued outside Brain, because Brain does not compute tax.',
    );
  }
  const due = dueDateSeconds(input.dueDate);
  if (due === null) return refuse('The due date is a calendar date, YYYY-MM-DD.');
  if (due * 1000 <= (input.now ?? new Date()).getTime()) return refuse('The due date has already passed.');

  const { invoice, created } = await draftInvoice({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    pipelineEntryId: entry.id,
    amountCents: entry.amountCents,
    currency: entry.currency,
    customerName,
    customerEmail,
    taxTreatment: input.taxTreatment,
    dueDate: input.dueDate,
    description: (opportunity.offerScope ?? opportunity.title).slice(0, 500),
    requestedBy: input.actorRef,
  });
  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_INVOICE_REQUESTED',
      actorRef: input.actorRef,
      summary: `An invoice for ${entry.amountCents} cents ${entry.currency} was requested.`,
      detail: { invoiceId: invoice.id, pipelineEntryId: entry.id },
    });
  }
  return {
    ok: true,
    value: invoice,
    message: created
      ? 'Recorded. Brain issues it under your commercial authority once an invoicing provider is connected.'
      : 'An invoice for that agreed amount already exists.',
  };
}

export interface InvoicingPass {
  issued: string[];
  uncertain: string[];
  failed: string[];
  withheld: { invoiceId: string; because: string }[];
  paid: string[];
  settled: string[];
  voided: string[];
}

/** Record why a draft is waiting, without a write when nothing changed. */
async function holdWithReason(invoice: CashInvoice, because: string, pass: InvoicingPass): Promise<void> {
  pass.withheld.push({ invoiceId: invoice.id, because });
  if (invoice.stateReason !== because) {
    await moveInvoice({ id: invoice.id, from: invoice.state, to: invoice.state, patch: { stateReason: because } });
  }
}

async function settleIssue(invoice: CashInvoice, outcome: ExternalOutcome, pass: InvoicingPass): Promise<void> {
  if (outcome.status === 'UNCERTAIN') {
    const moved =
      invoice.state === 'UNCERTAIN' ||
      (await moveInvoice({
        id: invoice.id,
        from: invoice.state,
        to: 'UNCERTAIN',
        patch: { stateReason: outcome.reason, provider: adapterStatus(ISSUE_INVOICE_NAMESPACE).adapter },
      }));
    if (moved && invoice.state !== 'UNCERTAIN') {
      await raiseNeed({
        projectId: invoice.projectId,
        opportunityId: invoice.opportunityId,
        actorRef: BRAIN,
        blockedAction: `Confirm whether invoice ${invoice.id} reached the provider`,
        whyItMatters:
          'The request to issue this invoice left and its outcome is unknown. Brain asks the ' +
          'provider on every pass under the same identity and never sends it again; until the ' +
          `provider answers, nothing says the customer was billed. ${outcome.reason}`,
        recommendedPath: 'Wait for the provider to confirm it, or look the invoice up in the provider directly.',
        setupEffort: 'A few minutes of checking.',
        nextStep: `Search the provider for metadata brain_invoice=${invoice.id}.`,
        completionCondition: 'The invoice reads ISSUED, or a person records that it was never created.',
        blocksState: null,
        requestKey: `invoice-uncertain:${invoice.id}`,
      });
    }
    pass.uncertain.push(invoice.id);
    return;
  }
  if (outcome.status === 'FAILED' && outcome.operation.state !== 'FAILED') {
    // A refusal the provider documents as "nothing was processed" — a rate
    // limit, or a key not configured — leaves the operation open for another
    // attempt, so the invoice stays where it was and the next pass tries again.
    await holdWithReason(
      invoice,
      `The provider did not process this yet (${outcome.operation.failureCategory ?? 'refused'}); Brain tries again on a later pass.`,
      pass,
    );
    return;
  }
  if (outcome.status === 'FAILED') {
    const category = outcome.operation.failureCategory ?? 'PROVIDER_REJECTED';
    await moveInvoice({
      id: invoice.id,
      from: invoice.state,
      to: 'FAILED',
      patch: { stateReason: `The provider refused this invoice (${category}). Nothing was billed.` },
    });
    pass.failed.push(invoice.id);
    return;
  }

  const providerInvoiceId =
    outcome.status === 'REPLAYED' ? (outcome.operation.resultRef ?? null) : outcome.receiptRef;
  if (!providerInvoiceId) {
    await holdWithReason(invoice, 'The provider confirmed the invoice and Brain holds no id for it.', pass);
    return;
  }
  const reader = usablePaymentReader();
  const reading = reader ? await reader.read(providerInvoiceId).catch(() => null) : null;
  const read = reading && reading.kind === 'READ' ? reading : null;
  const moved = await moveInvoice({
    id: invoice.id,
    from: invoice.state,
    to: 'ISSUED',
    patch: {
      provider: reader?.provider ?? adapterStatus(ISSUE_INVOICE_NAMESPACE).adapter,
      providerInvoiceId,
      providerStatus: read?.status ?? null,
      providerNumber: read?.number ?? null,
      hostedUrl: read?.hostedUrl ?? null,
      issuedAt: new Date().toISOString(),
      stateReason: null,
    },
  });
  if (!moved) return;

  const authority = await checkCommercialAuthority({ projectId: invoice.projectId, action: INVOICE_ACTION });
  if (authority.authority) {
    await recordAction({
      projectId: invoice.projectId,
      opportunityId: invoice.opportunityId,
      authorityId: authority.authority.id,
      action: INVOICE_ACTION,
      performedBy: 'BRAIN',
      reference: providerInvoiceId,
      detail: `Issued invoice ${invoice.id} for ${invoice.amountCents} cents ${invoice.currency}, due ${invoice.dueDate}.`,
      confirmedBy: BRAIN,
      requestKey: `invoice:${invoice.id}`,
    });
  }
  pass.issued.push(invoice.id);
}

async function issuePass(projectId: string, pass: InvoicingPass): Promise<void> {
  for (const invoice of await listInvoices({ projectId, states: ['DRAFTED', 'UNCERTAIN'] })) {
    if (invoice.state === 'DRAFTED') {
      const decision = await checkCommercialAuthority({ projectId, action: INVOICE_ACTION });
      if (!decision.ok) {
        await holdWithReason(invoice, `Not authorized to ${INVOICE_ACTION}: ${decision.reason}.`, pass);
        continue;
      }
      const reading = await readCapability('ISSUE_AN_INVOICE');
      if (reading.state !== 'PRESENT') {
        await holdWithReason(
          invoice,
          `Issuing needs ISSUE_AN_INVOICE, which reads ${reading.state}: ${adapterStatus(ISSUE_INVOICE_NAMESPACE).reason}`,
          pass,
        );
        continue;
      }
    } else if ((await readCapability('ISSUE_AN_INVOICE')).state !== 'PRESENT') {
      // An UNCERTAIN invoice is only ever *asked about*, and asking needs the
      // provider too. Without one it stays exactly as unknown as it was.
      continue;
    }
    let outcome: ExternalOutcome;
    try {
      // An UNCERTAIN invoice re-enters under the identical key, which the
      // engine answers by reconciling — asking is not sending.
      outcome = await sendIssueInvoice({
        projectId,
        invoiceId: invoice.id,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        customerEmail: invoice.customerEmail,
        customerName: invoice.customerName,
        taxTreatment: invoice.taxTreatment,
        dueDate: invoice.dueDate,
        description: invoice.description,
      });
    } catch (error) {
      await holdWithReason(
        invoice,
        `Issuing could not be attempted: ${error instanceof Error ? error.name : 'error'}.`,
        pass,
      );
      continue;
    }
    await settleIssue(invoice, outcome, pass);
  }
}

async function paymentPass(projectId: string, pass: InvoicingPass, now: Date): Promise<void> {
  const reader = usablePaymentReader();
  if (!reader) return;
  for (const invoice of await listInvoices({ projectId, states: ['ISSUED', 'PAID'] })) {
    if (!invoice.providerInvoiceId || invoice.provider !== reader.provider) continue;
    if (invoice.lastReadAt && now.getTime() - Date.parse(invoice.lastReadAt) < PAYMENT_READ_INTERVAL_MS) continue;

    const reading = await reader.read(invoice.providerInvoiceId).catch(() => null);
    if (!reading || reading.kind !== 'READ') continue; // unreadable is not evidence either way
    const readAt = now.toISOString();

    if (invoice.state === 'ISSUED' && (reading.status === 'void' || reading.status === 'uncollectible')) {
      if (await moveInvoice({ id: invoice.id, from: 'ISSUED', to: 'VOID', patch: { providerStatus: reading.status, lastReadAt: readAt, stateReason: `The provider marked it ${reading.status}.` } })) {
        pass.voided.push(invoice.id);
      }
      continue;
    }

    let current = invoice;
    if (current.state === 'ISSUED') {
      if (reading.status !== 'paid' || reading.amountPaidCents <= 0) {
        await moveInvoice({ id: current.id, from: 'ISSUED', to: 'ISSUED', patch: { providerStatus: reading.status, hostedUrl: reading.hostedUrl ?? current.hostedUrl, lastReadAt: readAt } });
        continue;
      }
      const payment = await recordMoneyEvent({
        projectId,
        opportunityId: current.opportunityId,
        kind: 'CUSTOMER_PAYMENT',
        amountCents: reading.amountPaidCents,
        currency: reading.currency,
        verifiedReference: reading.chargeId ?? current.providerInvoiceId,
        occurredAt: reading.paidAt ?? readAt,
        note: `Paid invoice ${current.providerNumber ?? current.providerInvoiceId}.`,
        idempotencyKey: `invoice-payment:${current.id}`,
        actorRef: BRAIN,
      });
      if (!payment.ok) {
        await holdWithReason(current, `The provider says this was paid and it could not be recorded: ${payment.reason}`, pass);
        await moveInvoice({ id: current.id, from: 'ISSUED', to: 'ISSUED', patch: { lastReadAt: readAt } });
        continue;
      }
      if (!(await moveInvoice({ id: current.id, from: 'ISSUED', to: 'PAID', patch: { providerStatus: reading.status, paymentEntryId: payment.value.id, paidAt: reading.paidAt ?? readAt, stateReason: null } }))) {
        continue;
      }
      pass.paid.push(current.id);
      current = (await getInvoice(current.id)) ?? current;
    }

    // PAID: settled only when the provider says the funds are usable.
    const balance = reading.balance;
    if (!balance || balance.status !== 'available') {
      const reason = !balance
        ? 'Paid, and the provider holds no balance transaction for it — a payment outside the provider is settled by recording it.'
        : `Paid; the provider says the funds are ${balance.status}${balance.availableOn ? ` until ${balance.availableOn}` : ''}.`;
      await moveInvoice({ id: current.id, from: 'PAID', to: 'PAID', patch: { lastReadAt: readAt, stateReason: reason } });
      continue;
    }
    const settlement = await recordMoneyEvent({
      projectId,
      opportunityId: current.opportunityId,
      kind: 'SETTLEMENT',
      amountCents: balance.amountCents,
      currency: balance.currency,
      verifiedReference: balance.id,
      fundsAvailableAt: balance.availableOn,
      occurredAt: balance.availableOn ?? readAt,
      note: `Funds from invoice ${current.providerNumber ?? current.providerInvoiceId} became available.`,
      idempotencyKey: `invoice-settlement:${current.id}`,
      actorRef: BRAIN,
    });
    if (!settlement.ok) {
      await holdWithReason(current, `The provider says these funds are available and they could not be recorded: ${settlement.reason}`, pass);
      await moveInvoice({ id: current.id, from: 'PAID', to: 'PAID', patch: { lastReadAt: readAt } });
      continue;
    }
    if (balance.feeCents > 0) {
      const fee = await recordMoneyEvent({
        projectId,
        opportunityId: current.opportunityId,
        kind: 'COST',
        amountCents: balance.feeCents,
        currency: balance.currency,
        verifiedReference: balance.id,
        occurredAt: balance.availableOn ?? readAt,
        note: `The provider's fee on invoice ${current.providerNumber ?? current.providerInvoiceId}.`,
        idempotencyKey: `invoice-fee:${current.id}`,
        actorRef: BRAIN,
      });
      if (!fee.ok) {
        // The settlement stands — it is the provider's answer — and the
        // invoice stays PAID so the next pass records the fee rather than
        // leaving available funds overstated by it.
        await holdWithReason(current, `The provider's fee could not be recorded: ${fee.reason}`, pass);
        continue;
      }
    }
    if (await moveInvoice({ id: current.id, from: 'PAID', to: 'SETTLED', patch: { settlementEntryId: settlement.value.id, settledAt: balance.availableOn ?? readAt, lastReadAt: readAt, stateReason: null } })) {
      pass.settled.push(current.id);
    }
  }
}

/** One project's invoicing step, for the tick. */
export async function runInvoicing(projectId: string, now: Date = new Date()): Promise<InvoicingPass> {
  const pass: InvoicingPass = { issued: [], uncertain: [], failed: [], withheld: [], paid: [], settled: [], voided: [] };
  if (!(await getCashMode(projectId))) return pass;
  await issuePass(projectId, pass);
  await paymentPass(projectId, pass, now);
  return pass;
}

