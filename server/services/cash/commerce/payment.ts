/**
 * An invoice, and the payment provider's account of what happened to it.
 *
 * Three facts are kept apart, because collapsing any two of them is how a sprint
 * comes to believe it has money it has not got:
 *
 *   * **agreed** — the buyer said yes. `PIPELINE_AGREED`, counted nowhere.
 *   * **paid** — the provider reports the customer's payment. A verified
 *     `CUSTOMER_PAYMENT` entry, which is not yet usable money.
 *   * **settled** — the funds reached the account. A `SETTLEMENT` entry, the
 *     only one that moves available funds. A provider fee is the difference,
 *     and it is recorded as a cost rather than hidden in a smaller number.
 *
 * Issuing is `QUOTE_AND_INVOICE` and recording a payment is `ACCEPT_PAYMENT`,
 * both under the standing grant. Every state an invoice reaches needs the
 * provider's own reference.
 */
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../../repos/cashMode.ts';
import { recordAction } from '../../../repos/cashActions.ts';
import { getMoneyEntry } from '../../../repos/cashLedger.ts';
import {
  commerceNow,
  createInvoice,
  getInvoice,
  getObligation,
  listInvoices,
  noteObligation,
  transitionInvoice,
} from '../../../repos/cashCommerce.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { advance, recordMoneyEvent } from '../opportunities.ts';
import { closeIfSettled } from './obligation.ts';
import { refuse, type Outcome } from './demand.ts';
import {
  INVOICE_STATES,
  INVOICE_TRANSITIONS,
  isOneOf,
  type CashInvoice,
  type CashObligation,
  type InvoiceState,
} from '../../../domain/commerce.ts';

const INVOICEABLE = ['AGREED', 'IN_PRODUCTION', 'DELIVERED', 'REVISION_REQUESTED', 'ACCEPTED'];
const COUNTING: InvoiceState[] = ['ISSUED', 'PAYMENT_PENDING', 'PAID', 'SETTLED'];

/**
 * What the buyer has paid against one obligation, counting only invoices whose
 * funds have settled. A payment still in flight to the account does not close
 * anything; a fee the provider kept is a cost, not an unpaid balance.
 */
export async function settledCentsFor(obligation: CashObligation): Promise<number> {
  let paid = 0;
  for (const invoice of await listInvoices({ projectId: obligation.projectId, obligationId: obligation.id })) {
    if (invoice.state !== 'SETTLED' || !invoice.paymentEntryId || !invoice.settlementEntryId) continue;
    const entry = await getMoneyEntry(invoice.paymentEntryId);
    if (entry) paid += entry.amountCents;
  }
  return paid;
}

export async function issueInvoice(input: {
  obligationId: string;
  projectId: string;
  amountCents: number;
  provider: string;
  providerReference: string;
  dueAt?: string | null;
  actorRef: string;
  performedBy?: 'PERSON' | 'BRAIN';
}): Promise<Outcome<CashInvoice>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  if (!INVOICEABLE.includes(obligation.state)) {
    return refuse(`This is ${obligation.state.toLowerCase()}; an invoice needs a buyer who agreed.`);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse('An invoice amount is a whole number of cents greater than zero.');
  }
  if (!input.provider?.trim() || !input.providerReference?.trim()) {
    return refuse("Name the payment provider and the invoice's own reference there.");
  }
  const invoiced = (await listInvoices({ projectId: obligation.projectId, obligationId: obligation.id }))
    .filter((one) => COUNTING.includes(one.state) && one.providerReference !== input.providerReference.trim())
    .reduce((sum, one) => sum + one.amountCents, 0);
  if (invoiced + input.amountCents > obligation.priceCents) {
    return refuse(
      `The agreed price is ${obligation.priceCents} cents and ${invoiced} are already invoiced; ` +
        'invoicing more than was agreed needs a new agreement, not a bigger invoice.',
    );
  }
  const decision = await checkCommercialAuthority({ projectId: obligation.projectId, action: 'QUOTE_AND_INVOICE' });
  if (!decision.ok || !decision.authority) {
    return refuse(`Issuing an invoice needs QUOTE_AND_INVOICE under a standing commercial authority, and ${decision.reason}.`);
  }
  const action = await recordAction({
    projectId: obligation.projectId,
    opportunityId: obligation.opportunityId,
    authorityId: decision.authority.id,
    action: 'QUOTE_AND_INVOICE',
    performedBy: input.performedBy ?? 'PERSON',
    reference: `${input.provider.trim()}:${input.providerReference.trim()}`,
    detail: `Invoice for ${input.amountCents} cents to ${obligation.buyer}.`,
    confirmedBy: input.actorRef,
    requestKey: `invoice:${obligation.id}:${input.provider.trim()}:${input.providerReference.trim()}`,
  });
  const { invoice, created } = await createInvoice({
    projectId: obligation.projectId,
    obligationId: obligation.id,
    opportunityId: obligation.opportunityId,
    amountCents: input.amountCents,
    currency: obligation.currency,
    provider: input.provider.trim(),
    providerReference: input.providerReference.trim(),
    issuedActionId: action.action.id,
    dueAt: input.dueAt ?? null,
  });
  if (created) {
    await noteObligation({
      obligation,
      kind: 'INVOICED',
      actorRef: input.actorRef,
      evidence: { invoiceId: invoice.id, amountCents: invoice.amountCents },
      nextStep: {
        step: `Wait for ${obligation.buyer} to pay invoice ${invoice.providerReference}; chase it if it is late.`,
        owner: 'BUYER',
        due: invoice.dueAt,
      },
    });
    await recordCashEvent({
      projectId: obligation.projectId,
      opportunityId: obligation.opportunityId,
      kind: 'CASH_INVOICE_ISSUED',
      actorRef: input.actorRef,
      summary: `Invoiced ${obligation.buyer} for ${invoice.amountCents} cents. Not collected until paid and settled.`,
      detail: { invoiceId: invoice.id },
    });
  }
  return { ok: true, value: invoice, message: created ? 'Issued.' : 'This invoice was already recorded.' };
}

/**
 * What the provider says happened, one state at a time.
 *
 * `PAID` writes a verified `CUSTOMER_PAYMENT`; `SETTLED` writes a `SETTLEMENT`
 * of what actually reached the account and a `COST` for any fee in between;
 * `REFUNDED` writes a `REFUND`. Every ledger key is derived from the invoice,
 * so a retried report writes each entry once.
 */
export async function recordInvoiceState(input: {
  invoiceId: string;
  projectId: string;
  to: string;
  reference?: string | null;
  settledAmountCents?: number | null;
  fundsAvailableAt?: string | null;
  reason?: string | null;
  actorRef: string;
}): Promise<Outcome<CashInvoice>> {
  const invoice = await getInvoice(input.invoiceId);
  if (!invoice || invoice.projectId !== input.projectId) return refuse('No invoice with that id.');
  if (!isOneOf(INVOICE_STATES, input.to)) return refuse(`An invoice state is one of: ${INVOICE_STATES.join(', ')}.`);
  const to = input.to as InvoiceState;
  if (invoice.state === to) return { ok: true, value: invoice, message: `Already ${to}.` };
  if (!INVOICE_TRANSITIONS[invoice.state].includes(to)) {
    return refuse(`An invoice that is ${invoice.state} cannot become ${to}.`);
  }
  const reference = (input.reference ?? '').trim();
  const at = commerceNow();
  let patch: Parameters<typeof transitionInvoice>[0]['patch'] = { state_reason: input.reason ?? null };

  if (to === 'PAID') {
    if (!reference) return refuse("A payment needs the provider's payment reference. A payment nobody can trace is pipeline.");
    const entry = await recordMoneyEvent({
      projectId: invoice.projectId,
      opportunityId: invoice.opportunityId,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      verifiedReference: reference,
      idempotencyKey: `invoice-paid:${invoice.id}`,
      note: `Invoice ${invoice.providerReference} paid.`,
      actorRef: input.actorRef,
    });
    if (!entry.ok) return entry;
    patch = { ...patch, payment_reference: reference, payment_entry_id: entry.value.id, paid_at: at };
  }
  if (to === 'SETTLED') {
    if (!reference) return refuse('A settlement needs the payout or bank reference that shows the funds arrived.');
    const settled = input.settledAmountCents ?? invoice.amountCents;
    if (!Number.isInteger(settled) || settled <= 0 || settled > invoice.amountCents) {
      return refuse('What settled is a whole number of cents, above zero and no more than was paid.');
    }
    /*
     * The settlement is recorded gross and the provider's fee as a cost beside
     * it. `availableFunds` subtracts every cost once, so recording the net
     * figure *and* the fee would take the fee out of the account twice — the
     * one arithmetic mistake `money.ts` exists to refuse. Gross plus a cost
     * leaves exactly what arrived, and puts the fee in the contribution too.
     */
    const entry = await recordMoneyEvent({
      projectId: invoice.projectId,
      opportunityId: invoice.opportunityId,
      kind: 'SETTLEMENT',
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      verifiedReference: reference,
      fundsAvailableAt: input.fundsAvailableAt ?? at,
      idempotencyKey: `invoice-settled:${invoice.id}`,
      note: `Invoice ${invoice.providerReference} settled.`,
      actorRef: input.actorRef,
    });
    if (!entry.ok) return entry;
    const fee = invoice.amountCents - settled;
    if (fee > 0) {
      const cost = await recordMoneyEvent({
        projectId: invoice.projectId,
        opportunityId: invoice.opportunityId,
        kind: 'COST',
        amountCents: fee,
        currency: invoice.currency,
        idempotencyKey: `invoice-fee:${invoice.id}`,
        note: `${invoice.provider} fee on invoice ${invoice.providerReference}.`,
        actorRef: input.actorRef,
      });
      if (!cost.ok) return cost;
    }
    patch = {
      ...patch,
      settlement_reference: reference,
      settlement_entry_id: entry.value.id,
      funds_available_at: input.fundsAvailableAt ?? at,
      settled_at: at,
    };
  }
  if (to === 'REFUNDED') {
    if (!reference) return refuse('A refund needs its provider reference.');
    const entry = await recordMoneyEvent({
      projectId: invoice.projectId,
      opportunityId: invoice.opportunityId,
      kind: 'REFUND',
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      idempotencyKey: `invoice-refund:${invoice.id}`,
      note: `Invoice ${invoice.providerReference} refunded (${reference}).`,
      actorRef: input.actorRef,
    });
    if (!entry.ok) return entry;
  }
  if ((to === 'FAILED' || to === 'VOID') && !(input.reason ?? '').trim()) {
    return refuse('Say what the provider reported.');
  }

  const moved = await transitionInvoice({ id: invoice.id, from: [invoice.state], to, patch });
  if (!moved) return refuse('The invoice moved while this was being recorded; read it again.');
  await recordCashEvent({
    projectId: invoice.projectId,
    opportunityId: invoice.opportunityId,
    kind: `CASH_INVOICE_${to}`,
    actorRef: input.actorRef,
    summary: `Invoice ${invoice.providerReference}: ${invoice.state} → ${to}.`,
    detail: { invoiceId: invoice.id, reference: reference || null },
  });

  if (to === 'SETTLED') {
    const obligation = await getObligation(invoice.obligationId);
    if (obligation) {
      await closeIfSettled(obligation.id, input.actorRef);
      const opportunity = await getOpportunity(invoice.opportunityId);
      if (opportunity && ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING'].includes(opportunity.state)) {
        const after = await getObligation(obligation.id);
        if (after?.state === 'CLOSED') {
          await advance({
            opportunityId: opportunity.id,
            to: 'COLLECTED',
            actorRef: input.actorRef,
            outcome: `Settled ${invoice.amountCents} cents from ${obligation.buyer}.`,
          });
        }
      }
    }
  }
  return { ok: true, value: (await getInvoice(invoice.id))!, message: `Recorded: ${to}.` };
}
