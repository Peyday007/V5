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
 *              CUSTOMER_PAYMENT, keyed on the invoice, backed by the invoice
 *              Brain issued under QUOTE_AND_INVOICE — the buyer paying it is
 *              not Brain taking a payment, and a revoked grant does not
 *              unsay money that arrived.
 *   settlement PAID → SETTLED when the provider says the funds are available.
 *              One SETTLEMENT for the gross amount and one COST for the
 *              provider's fee, so available funds equal what actually landed
 *              and the fee is counted once, as a cost.
 *
 * The payment and the settlement are never one entry. `money.ts` exists to keep
 * them apart: a payment is not funds until the provider says it is.
 */
import { dealPosition, invoiceableAgreements } from './journey/position.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { draftInvoice, getInvoice, listInvoices, moveInvoice } from '../../repos/cashInvoices.ts';
import { recordAction } from '../../repos/cashActions.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readCapability } from './capabilities.ts';
import { ISSUE_INVOICE_NAMESPACE, sendIssueInvoice, adapterStatus } from './effects.ts';
import { raiseNeed } from './needs.ts';
import { recordMoneyEvent, voidUncoveredDrafts } from './opportunities.ts';
import { usablePaymentReader } from './providers/payments.ts';
import { ADDRESS } from './providers/config.ts';
import { TAX_TREATMENTS, dueDateSeconds } from './providers/stripe.ts';
import type { ExternalOutcome } from '../effects/external.ts';
import type { CashInvoice } from '../../domain/types.ts';
import { serializeCash } from '../../repos/cashLock.ts';
import { customerPaymentByReference, getMoneyEntry } from '../../repos/cashLedger.ts';

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

  /*
   * Only an amount a live agreement stands behind is invoiceable
   * (`journey/deal.ts`). An agreement writes exactly one PIPELINE_AGREED entry,
   * keyed `agreement:<id>`, carrying the deliverable, the acceptance condition
   * and the evidence the buyer agreed — so a bare agreed amount somebody typed
   * into the ledger is never billed, and an agreement already invoiced or
   * released is not billed again.
   */
  const backed = await invoiceableAgreements({ projectId: input.projectId, opportunityId: opportunity.id });
  if (backed.length === 0) {
    // A repeat of a request already drafted is that draft, not a refusal:
    // retrying after a lost response must find what the first call made.
    const existing = (await listInvoices({ projectId: input.projectId, opportunityId: opportunity.id })).filter(
      (one) =>
        one.state !== 'VOID' &&
        one.state !== 'FAILED' &&
        (!input.pipelineEntryId || one.pipelineEntryId === input.pipelineEntryId),
    );
    if (existing.length === 1) {
      return { ok: true, value: existing[0]!, message: 'An invoice for that agreed amount already exists.' };
    }
    return refuse(
      'No agreement on this opportunity is waiting to be invoiced. Record the agreement — the amount, ' +
        'what is delivered, what counts as acceptance and the evidence — first; Brain does not choose ' +
        'what to bill, and an agreement already invoiced is not billed twice.',
    );
  }
  let entry = backed[0]!.entry;
  if (input.pipelineEntryId) {
    const named = backed.find((one) => one.entry.id === input.pipelineEntryId);
    if (!named) return refuse('That agreed amount is not a live agreement on this opportunity waiting to be invoiced.');
    entry = named.entry;
  } else if (backed.length > 1) {
    return refuse(
      `${backed.length} agreements on this opportunity are waiting to be invoiced (${backed
        .map((one) => one.entry.id)
        .join(', ')}). Name the one to invoice; choosing for you would be a guess.`,
    );
  }
  if (entry.currency !== mode.currency) {
    return refuse(`The agreed amount is in ${entry.currency} and this sprint keeps its money in ${mode.currency}.`);
  }
  /*
   * Never more than is still owed. The amount is the agreement's own, unless
   * money already reached the ledger for this deal (a payment made another
   * way, a partial payment against an earlier invoice), in which case it is
   * what remains: agreed, less the larger of what is billed and what was paid
   * net of refunds (`position.ts`). Derived arithmetic, never a figure chosen
   * — and refused outright when nothing remains to bill.
   */

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

  /*
   * The amount is read and the draft written under the project's cash lock, so
   * two requests for two agreements cannot both read the same remainder and
   * each bill it.
   */
  const drafted = await serializeCash(input.projectId, mode.currency, async (): Promise<Outcome<{ invoice: CashInvoice; created: boolean }>> => {
  const position = await dealPosition({ opportunity, currency: mode.currency });
  if (position.paymentState === 'PAYMENT_PENDING') {
    return refuse(
      'Brain’s own charge for this piece is still unresolved, and if it went through the buyer has paid. ' +
        'An invoice is requested once the provider has answered.',
    );
  }
  const amountCents = Math.min(entry.amountCents, position.pnl.invoiceableCents);
  if (amountCents <= 0) {
    return refuse(
      'Everything agreed on this piece is already billed or paid, so there is nothing left to invoice. ' +
        'Brain never bills money it has already been paid.',
    );
  }
  const made = await draftInvoice({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    pipelineEntryId: entry.id,
    amountCents,
    currency: entry.currency,
    customerName,
    customerEmail,
    taxTreatment: input.taxTreatment,
    dueDate: input.dueDate,
    description: (opportunity.offerScope ?? opportunity.title).slice(0, 500),
    requestedBy: input.actorRef,
  });
  return { ok: true, value: made, message: '' };
  });
  if (!drafted.ok) return drafted;
  const { invoice, created } = drafted.value;
  const amountCents = invoice.amountCents;
  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_INVOICE_REQUESTED',
      actorRef: input.actorRef,
      summary: `An invoice for ${amountCents} cents ${entry.currency} was requested.`,
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

/** The same need a release raises for an invoice it found already sent. */
async function askToVoidReleased(invoice: CashInvoice, providerInvoiceId: string | null): Promise<void> {
  await raiseNeed({
    projectId: invoice.projectId,
    opportunityId: invoice.opportunityId,
    actorRef: BRAIN,
    blockedAction: `Void invoice ${invoice.id} at the provider`,
    whyItMatters:
      'Its agreement was released while the invoice was being sent, and the provider may hold an invoice ' +
      'the buyer can pay. Brain does not unsend it on its own.',
    recommendedPath: 'Void the invoice at the invoicing provider; Brain reads the voided state back.',
    setupEffort: 'A minute.',
    nextStep: `Void ${providerInvoiceId ?? `the invoice with metadata brain_invoice=${invoice.id}`} at the provider.`,
    completionCondition: 'The provider reads the invoice as void.',
    blocksState: null,
    requestKey: `void-released:${invoice.id}`,
  });
}

async function settleIssue(invoice: CashInvoice, outcome: ExternalOutcome, pass: InvoicingPass): Promise<void> {
  if (outcome.status === 'UNCERTAIN') {
    let moved =
      invoice.state === 'UNCERTAIN' ||
      (await moveInvoice({
        id: invoice.id,
        from: invoice.state,
        to: 'UNCERTAIN',
        patch: { stateReason: outcome.reason, provider: adapterStatus(ISSUE_INVOICE_NAMESPACE).adapter },
      }));
    if (!moved && (await getInvoice(invoice.id))?.state === 'VOID') {
      // Released mid-send: an unknown outcome is still unknown, not void.
      moved = await moveInvoice({
        id: invoice.id,
        from: 'VOID',
        to: 'UNCERTAIN',
        patch: { stateReason: outcome.reason, provider: adapterStatus(ISSUE_INVOICE_NAMESPACE).adapter },
      });
      if (moved) await askToVoidReleased(invoice, null);
    }
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
  const patch = {
    provider: reader?.provider ?? adapterStatus(ISSUE_INVOICE_NAMESPACE).adapter,
    providerInvoiceId,
    providerStatus: read?.status ?? null,
    providerNumber: read?.number ?? null,
    hostedUrl: read?.hostedUrl ?? null,
    issuedAt: new Date().toISOString(),
    stateReason: null as string | null,
  };
  let moved = await moveInvoice({ id: invoice.id, from: invoice.state, to: 'ISSUED', patch });
  if (!moved) {
    /*
     * Released while the send was in flight: the agreement's release voided a
     * draft this pass had already sent. The provider holds an invoice the buyer
     * can pay, so the row says so — ISSUED, with the provider's id — and a
     * person is asked to void it there. Leaving it VOID would hide a live bill
     * and the payment the provider may later read for it.
     */
    if ((await getInvoice(invoice.id))?.state === 'VOID') {
      moved = await moveInvoice({
        id: invoice.id,
        from: 'VOID',
        to: 'ISSUED',
        patch: { ...patch, stateReason: 'Issued at the provider after its agreement was released.' },
      });
      if (moved) await askToVoidReleased(invoice, providerInvoiceId);
    }
    if (!moved) return;
  }

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

/**
 * Issue (or ask about) one invoice: the one function both the tick's pass and a
 * person's "have Brain do it" call, so the two send under the identical key
 * (`issueInvoiceKey(invoice.id)`) and a press racing a tick is one operation,
 * never two invoices.
 */
export async function issueOne(invoice: CashInvoice, pass: InvoicingPass): Promise<void> {
  const projectId = invoice.projectId;
  if (invoice.state === 'DRAFTED') {
    const decision = await checkCommercialAuthority({ projectId, action: INVOICE_ACTION });
    if (!decision.ok) {
      await holdWithReason(invoice, `Not authorized to ${INVOICE_ACTION}: ${decision.reason}.`, pass);
      return;
    }
    const reading = await readCapability('ISSUE_AN_INVOICE');
    if (reading.state !== 'PRESENT') {
      await holdWithReason(
        invoice,
        `Issuing needs ISSUE_AN_INVOICE, which reads ${reading.state}: ${adapterStatus(ISSUE_INVOICE_NAMESPACE).reason}`,
        pass,
      );
      return;
    }
    /*
     * The amount was what was owed when it was drafted. Money that arrived
     * another way since then makes part of it money the buyer already paid,
     * so it is checked again immediately before the send, under the cash lock,
     * and a draft the ledger has overtaken is voided rather than billed.
     */
    const voided = await serializeCash(projectId, invoice.currency, () =>
      voidUncoveredDrafts({
        projectId,
        opportunityId: invoice.opportunityId,
        currency: invoice.currency,
        because: 'Paid another way before it was sent; voided rather than billed twice.',
      }),
    );
    if (voided.length > 0) pass.voided.push(...voided);
    if ((await getInvoice(invoice.id))?.state !== 'DRAFTED') return;
    const opportunity = await getOpportunity(invoice.opportunityId);
    if (opportunity && (await dealPosition({ opportunity, currency: invoice.currency })).paymentState === 'PAYMENT_PENDING') {
      await holdWithReason(
        invoice,
        'Brain’s own charge for this piece is still unresolved; the invoice is sent once the provider has answered, or voided if it went through.',
        pass,
      );
      return;
    }
  } else if (invoice.state === 'UNCERTAIN') {
    // An UNCERTAIN invoice is only ever *asked about*, and asking needs the
    // provider too. Without one it stays exactly as unknown as it was.
    if ((await readCapability('ISSUE_AN_INVOICE')).state !== 'PRESENT') return;
  } else {
    return;
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
    return;
  }
  await settleIssue(invoice, outcome, pass);
}

async function issuePass(projectId: string, pass: InvoicingPass): Promise<void> {
  for (const invoice of await listInvoices({ projectId, states: ['DRAFTED', 'UNCERTAIN'] })) {
    await issueOne(invoice, pass);
  }
}

export function emptyInvoicingPass(): InvoicingPass {
  return { issued: [], uncertain: [], failed: [], withheld: [], paid: [], settled: [], voided: [] };
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
        paidInvoiceId: current.id,
      });
      /*
       * The same provider reference already on this piece's ledger is this
       * payment, recorded once already (a person, or an earlier read whose
       * invoice move did not land). Adopt it rather than hold the invoice
       * ISSUED for ever: one reference is one payment (§30), and the
       * settlement and the fee still have to be read.
       */
      const adopted = payment.ok
        ? null
        : await customerPaymentByReference(projectId, reading.chargeId ?? current.providerInvoiceId ?? '');
      // A payment another invoice already names is that invoice's money, never
      // this one's too: one payment counted against two invoices is money
      // counted twice.
      const namedElsewhere =
        adopted !== null &&
        (await listInvoices({ projectId, opportunityId: current.opportunityId })).some(
          (one) => one.id !== current.id && one.paymentEntryId === adopted.id,
        );
      const entry = payment.ok ? payment.value : namedElsewhere ? null : adopted;
      if (!entry || entry.opportunityId !== current.opportunityId) {
        await holdWithReason(
          current,
          `The provider says this was paid and it could not be recorded: ${payment.ok ? 'it belongs to another piece' : payment.reason}`,
          pass,
        );
        // Held is only honest if somebody is asked: the answer is attributing
        // a hand-recorded payment to this invoice, or the agreement for more.
        await raiseNeed({
          projectId,
          opportunityId: current.opportunityId,
          actorRef: BRAIN,
          blockedAction: `Record invoice ${current.id}'s payment`,
          whyItMatters:
            'The provider says the buyer paid this invoice, and Brain will not record it beside a payment that may be the same money.',
          recommendedPath:
            'If a payment you recorded by hand is this invoice’s, attribute it to the invoice; otherwise record the agreement the extra money is for.',
          setupEffort: 'A minute.',
          nextStep: payment.ok ? 'Check which piece this invoice belongs to.' : payment.reason,
          completionCondition: 'The invoice names its payment.',
          blocksState: null,
          requestKey: `invoice-payment-held:${current.id}`,
        });
        await moveInvoice({ id: current.id, from: 'ISSUED', to: 'ISSUED', patch: { lastReadAt: readAt } });
        continue;
      }
      if (!(await moveInvoice({ id: current.id, from: 'ISSUED', to: 'PAID', patch: { providerStatus: reading.status, paymentEntryId: entry.id, paidAt: reading.paidAt ?? readAt, stateReason: null } }))) {
        // Recording the payment names the invoice in the same transaction, so
        // it is usually PAID already; anything else is another pass's move.
        const after = await getInvoice(current.id);
        if (!after || after.state !== 'PAID' || after.paymentEntryId !== entry.id) continue;
      }
      pass.paid.push(current.id);
      current = (await getInvoice(current.id)) ?? current;
    }

    /*
     * An invoice Brain marked PAID with its *own* charge, that the provider now
     * also reads paid under a different charge, is the buyer paying twice:
     * Brain charged them and they paid the invoice's page too. That second
     * payment is real money that arrived, so it is recorded — not absorbed
     * into the first payment's settlement room, which would hide the refund
     * that is owed — and a person is told to refund one. A payment a *person*
     * attributed to this invoice is their statement that it is this invoice's
     * money, so the provider's reading of it is the same money and settles.
     */
    if (invoice.state === 'PAID' && reading.status === 'paid' && reading.amountPaidCents > 0 && current.paymentEntryId) {
      const named = await getMoneyEntry(current.paymentEntryId);
      const providerRef = reading.chargeId ?? current.providerInvoiceId;
      const brainCharge =
        named !== null &&
        named.recordedBy === BRAIN &&
        named.idempotencyKey !== `invoice-payment:${current.id}` &&
        named.verifiedReference !== providerRef;
      if (brainCharge) {
        const second = await recordMoneyEvent({
          projectId,
          opportunityId: current.opportunityId,
          kind: 'CUSTOMER_PAYMENT',
          amountCents: reading.amountPaidCents,
          currency: reading.currency,
          verifiedReference: providerRef,
          occurredAt: reading.paidAt ?? readAt,
          note: `The buyer also paid invoice ${current.providerNumber ?? current.providerInvoiceId} after Brain charged them.`,
          idempotencyKey: `invoice-payment:${current.id}`,
          actorRef: BRAIN,
          paidInvoiceId: current.id,
          besideBrainCharge: true,
        });
        await raiseNeed({
          projectId,
          opportunityId: current.opportunityId,
          actorRef: BRAIN,
          blockedAction: `Refund the second payment of invoice ${current.id}`,
          whyItMatters:
            'Brain charged the buyer and the buyer also paid this invoice on the provider’s page: they paid ' +
            'the same amount twice. Both payments are on the record, so a refund of one is bounded correctly.',
          recommendedPath: 'Refund one of the two payments through the deal’s obligation.',
          setupEffort: 'A few minutes.',
          nextStep: `Refund ${providerRef ?? 'the invoice payment'} or ${named?.verifiedReference ?? 'Brain’s charge'}.`,
          completionCondition: 'One of the two payments is refunded.',
          blocksState: null,
          requestKey: `invoice-paid-twice:${current.id}`,
        });
        if (!second.ok) {
          await holdWithReason(current, `The buyer paid this invoice as well as Brain's charge, and it could not be recorded: ${second.reason}`, pass);
          await moveInvoice({ id: current.id, from: 'PAID', to: 'PAID', patch: { lastReadAt: readAt } });
          continue;
        }
      }
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

