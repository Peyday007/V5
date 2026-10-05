/**
 * Where one deal stands, derived from its rows every time and stored nowhere.
 *
 * Three families of row meet here and each is the master of exactly one thing:
 *
 *   - `cash_agreements` says **what was agreed** — the amount, the deliverable,
 *     the acceptance condition and the evidence. Live agreed revenue is the sum
 *     of the agreements still `AGREED`.
 *   - `cash_invoices` says **what was billed against which agreement**. Whether
 *     an invoice is paid is never stored on it.
 *   - `cash_money_entries` says **what money moved** (invariant 37). Payments,
 *     refunds, settlements, costs and commitments are read from it and nowhere
 *     else, so this module cannot disagree with `money.ts` about a dollar.
 *
 * Nothing here subtracts a cost twice. A `COST` has already left the account
 * and is subtracted once from contribution; an unpaid commitment is owed and
 * subtracted once; a `COMMITMENT_PAID` closes the owed amount and is the moment
 * the matching `COST` exists, so the two never count at once — `money.ts`'
 * rule, applied per deal.
 *
 * And pending money is never available cash: a payment recorded but not
 * settled reads as `unsettledCents`, and a settlement is never a second sale —
 * contribution is read from payments, never from settlements.
 */
import { moneyEntryByKey, totalsByKind, unattributedPersonPayments } from '../../../repos/cashLedger.ts';
import { listInvoices } from '../../../repos/cashInvoices.ts';
import { listCommitments } from '../../../repos/cashAuthority.ts';
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { readObligation, type ObligationReading } from './fulfillment.ts';
import { contributionFrom } from '../money.ts';
import { commercialOperationsFor } from '../effects.ts';
import type { CashAgreement, CashObservation } from '../../../domain/cashJourney.ts';
import type {
  CashInvoice,
  CashInvoiceState,
  CashMoneyEntry,
  CashOpportunity,
  CashMoneyKind,
} from '../../../domain/types.ts';

/** The ledger key an agreement's PIPELINE_AGREED entry is written under. */
export function agreementLedgerKey(agreementId: string): string {
  return `agreement:${agreementId}`;
}

/** Billed: the provider confirmed it, whatever has happened to its money since. */
export const BILLED_INVOICE_STATES: readonly CashInvoiceState[] = ['ISSUED', 'PAID', 'SETTLED'];
/** Billed, or on its way to being billed, or of unknown outcome: never invoiced again. */
export const LIVE_INVOICE_STATES: readonly CashInvoiceState[] = ['DRAFTED', 'UNCERTAIN', 'ISSUED', 'PAID', 'SETTLED'];

/**
 * The PIPELINE_AGREED entry each agreement wrote. An invoice names the entry it
 * bills, so which agreement an invoice bills is this join and nothing else.
 */
async function entriesFor(agreements: CashAgreement[]): Promise<Map<string, CashMoneyEntry>> {
  const out = new Map<string, CashMoneyEntry>();
  for (const agreement of agreements) {
    const entry = await moneyEntryByKey(agreement.projectId, agreementLedgerKey(agreement.id));
    if (entry) out.set(agreement.id, entry);
  }
  return out;
}

/**
 * Live agreements no live invoice bills yet, oldest first, with the ledger
 * entry an invoice for each must name. The one reader `invoicing.ts` asks
 * before drafting, so an amount with no agreement behind it is never billed
 * and an agreement already billed is never billed twice.
 */
export async function invoiceableAgreements(input: {
  projectId: string;
  opportunityId: string;
}): Promise<{ agreement: CashAgreement; entry: CashMoneyEntry }[]> {
  const agreements = (await agreementsFor(input.opportunityId)).filter((one) => one.state === 'AGREED');
  const entries = await entriesFor(agreements);
  const invoices = await listInvoices({ projectId: input.projectId, opportunityId: input.opportunityId });
  const out: { agreement: CashAgreement; entry: CashMoneyEntry }[] = [];
  for (const agreement of agreements) {
    const entry = entries.get(agreement.id);
    if (!entry) continue;
    const billed = invoices.some((one) => one.pipelineEntryId === entry.id && LIVE_INVOICE_STATES.includes(one.state));
    if (!billed) out.push({ agreement, entry });
  }
  return out;
}

/** The stage of the journey, read from rows. Ordered: each needs the last. */
export const JOURNEY_STAGES = [
  'NOT_STARTED',
  'CONTACTED',
  'RESPONDED',
  'AGREED',
  'INVOICED',
  'PAID',
  'FULFILLING',
  'DELIVERED',
  'SETTLED',
  'COMPLETE',
  'ENDED_WITHOUT_SALE',
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const PAYMENT_STATES = [
  /** Nothing agreed, so nothing is owed. */
  'NOTHING_OWED',
  /** Agreed and not yet billed. */
  'NOT_INVOICED',
  /** Billed and unpaid. */
  'OUTSTANDING',
  /** A take-payment attempt is in flight or its outcome is unknown. */
  'PAYMENT_PENDING',
  /** Some of what is billed has been paid. */
  'PARTIALLY_PAID',
  /** Paid in full, and not all of it has settled. Not available cash. */
  'PAID_UNSETTLED',
  /** Paid in full and settled. */
  'SETTLED',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export interface DealPnl {
  currency: string;
  /** Live agreements only: an agreement released is no longer revenue. */
  agreedRevenueCents: number;
  /** `PIPELINE_AGREED` entries no agreement row stands behind. Never invoiced. */
  unbackedAgreedCents: number;
  invoicedCents: number;
  /** Gross customer payments, before refunds. */
  customerPaymentsCents: number;
  refundsCents: number;
  /** Settled and usable. Never more than was paid. */
  settledCashCents: number;
  /** Paid and not yet settled: earned, and not cash. */
  unsettledCents: number;
  /** Incremental costs that have actually left the account. */
  incrementalCostsCents: number;
  /** Costs incurred for this deal and not yet paid. */
  unpaidCommitmentsCents: number;
  /** Spending authorized against this deal and still held, not yet spent. */
  heldCommitmentsCents: number;
  /**
   * Payments less refunds less every incremental cost incurred, paid or owed.
   *
   * Earned rather than received: it is complete whether or not the provider has
   * paid out. Each cost once — a `COST` and the unpaid commitment it closes are
   * never both counted.
   */
  contributionCents: number;
  /** Billed and not yet paid. */
  owedByBuyerCents: number;
  /** Agreed and not yet billed — what a next invoice may be for. */
  invoiceableCents: number;
  /**
   * Drafted or unknown invoices no longer covered by what is still owed: money
   * arrived another way after they were drafted. A drafted one is voided rather
   * than sent; an unknown one is held until the provider says what it is.
   */
  uncoveredPendingCents: number;
}

export interface DealPosition {
  opportunityId: string;
  stage: JourneyStage;
  paymentState: PaymentState;
  pnl: DealPnl;
  agreements: CashAgreement[];
  invoices: CashInvoice[];
  /** Payments a person recorded that no invoice names: what `attribute-payment` can tie to one. */
  unattributedPayments: { id: string; amountCents: number; reference: string | null }[];
  /** Each agreement's obligation, as `fulfillment.ts` reads it. */
  obligations: ObligationReading[];
  observations: CashObservation[];
  contacted: boolean;
  /**
   * Every live agreement's obligation is complete: the work done, the whole
   * promise delivered, the buyer's acceptance recorded, no failure and every
   * refund resolved. False with no live agreement, and false while any one
   * obligation is short of that — one delivered agreement does not deliver
   * another.
   */
  delivered: boolean;
  /** Whether a take-payment attempt is in flight or unknown. */
  paymentInFlight: boolean;
}

const num = (t: Partial<Record<CashMoneyKind, number>>, k: CashMoneyKind): number => Number(t[k] ?? 0);

export async function dealPosition(input: {
  opportunity: CashOpportunity;
  currency: string;
}): Promise<DealPosition> {
  const { opportunity, currency } = input;
  const [agreements, invoices, observations, actions, totals, operations, commitments] =
    await Promise.all([
      agreementsFor(opportunity.id),
      listInvoices({ projectId: opportunity.projectId, opportunityId: opportunity.id }),
      observationsFor(opportunity.id),
      actionsFor(opportunity.id),
      totalsByKind({ projectId: opportunity.projectId, opportunityId: opportunity.id, currency }),
      commercialOperationsFor(opportunity.projectId, opportunity.id),
      listCommitments(opportunity.projectId),
    ]);

  const obligations: ObligationReading[] = [];
  for (const agreement of agreements) obligations.push(await readObligation(agreement));
  const live = agreements.filter((one) => one.state === 'AGREED' && one.currency === currency);
  const agreedRevenue = live.reduce((sum, one) => sum + one.amountCents, 0);
  const ledgerAgreed = Math.max(0, num(totals, 'PIPELINE_AGREED') - num(totals, 'PIPELINE_RELEASED'));
  const ours = invoices.filter((one) => one.currency === currency);
  const invoiced = ours
    .filter((one) => BILLED_INVOICE_STATES.includes(one.state))
    .reduce((sum, one) => sum + one.amountCents, 0);
  // Drafted or of unknown outcome: not billed, and not billable again either.
  const pendingInvoice = ours
    .filter((one) => one.state === 'DRAFTED' || one.state === 'UNCERTAIN')
    .reduce((sum, one) => sum + one.amountCents, 0);

  const payments = num(totals, 'CUSTOMER_PAYMENT');
  const refunds = num(totals, 'REFUND');
  const paidNet = Math.max(0, payments - refunds);
  const settled = num(totals, 'SETTLEMENT');
  const costs = num(totals, 'COST');
  const unpaid = Math.max(
    0,
    num(totals, 'UNPAID_COMMITMENT') - num(totals, 'COMMITMENT_PAID') - num(totals, 'COMMITMENT_RELEASED'),
  );
  const held = commitments
    .filter((one) => one.opportunityId === opportunity.id && one.state === 'HELD' && one.currency === currency)
    .reduce((sum, one) => sum + one.amountCents, 0);

  // A payment the buyer made reduces what they owe; a refund Brain paid back
  // does not make them owe it again.
  const owed = Math.max(0, invoiced - payments);
  // What an invoice that expired unpaid left is billable again; what was paid
  // against it is not.
  //
  // A payment is either against an invoice (the provider read it and the
  // invoice names the entry) or made another way. Only the second reduces what
  // is still billable on top of the invoices: counting a payment against an
  // invoice again would under-bill, and taking the larger of the two (the old
  // rule) over-billed whenever money arrived outside an invoice and a second
  // agreement was invoiced afterwards.
  const paidAgainstInvoices = ours
    .filter((one) => one.paymentEntryId && BILLED_INVOICE_STATES.includes(one.state))
    .reduce((sum, one) => sum + one.amountCents, 0);
  // A payment against an invoice names it: the provider's read, Brain's own
  // take-payment for that amount, a person who said which, or a person's later
  // attribution. A hand payment nobody tied stays here, and a provider read
  // beside one is held rather than counted twice.
  const paidOutsideInvoices = Math.max(0, payments - paidAgainstInvoices);
  const invoiceable = Math.max(0, agreedRevenue - invoiced - pendingInvoice - paidOutsideInvoices);
  const uncoveredPending = Math.max(
    0,
    pendingInvoice - Math.max(0, agreedRevenue - invoiced - paidOutsideInvoices),
  );
  const paymentInFlight = operations.some(
    (one) =>
      one.action === 'ACCEPT_PAYMENT' &&
      (one.operation.state === 'RESERVED' || one.operation.state === 'UNCERTAIN'),
  );

  let paymentState: PaymentState;
  if (agreedRevenue <= 0 && payments <= 0) paymentState = 'NOTHING_OWED';
  else if (paymentInFlight) paymentState = 'PAYMENT_PENDING';
  else if (paidNet > 0 && paidNet >= agreedRevenue && owed === 0) {
    paymentState = settled >= paidNet ? 'SETTLED' : 'PAID_UNSETTLED';
  } else if (payments > 0) paymentState = 'PARTIALLY_PAID';
  else if (invoiced > 0) paymentState = 'OUTSTANDING';
  else paymentState = 'NOT_INVOICED';

  const contacted = actions.some((one) => one.action === 'CONTACT_BUYER');
  const liveObligations = obligations.filter((one) => one.agreement.state === 'AGREED');
  const delivered = liveObligations.length > 0 && liveObligations.every((one) => one.complete);
  const fulfilling = liveObligations.some((one) => one.fulfillment !== null && !one.complete);
  const responded = observations.some((one) => one.kind.startsWith('BUYER_') && one.kind !== 'BUYER_SILENT');

  let stage: JourneyStage;
  if (opportunity.state === 'DECLINED' || opportunity.state === 'ARCHIVED') {
    stage = opportunity.state === 'ARCHIVED' && delivered && paymentState === 'SETTLED' ? 'COMPLETE' : 'ENDED_WITHOUT_SALE';
  } else if (opportunity.state === 'COLLECTED') stage = 'COMPLETE';
  else if (delivered && paymentState === 'SETTLED') stage = 'SETTLED';
  else if (delivered) stage = 'DELIVERED';
  else if (fulfilling) stage = 'FULFILLING';
  else if (paidNet > 0) stage = 'PAID';
  else if (invoiced > 0) stage = 'INVOICED';
  else if (agreedRevenue > 0) stage = 'AGREED';
  else if (responded) stage = 'RESPONDED';
  else if (contacted) stage = 'CONTACTED';
  else stage = 'NOT_STARTED';

  return {
    opportunityId: opportunity.id,
    stage,
    paymentState,
    pnl: {
      currency,
      agreedRevenueCents: agreedRevenue,
      unbackedAgreedCents: Math.max(0, ledgerAgreed - agreedRevenue),
      invoicedCents: invoiced,
      customerPaymentsCents: payments,
      refundsCents: refunds,
      settledCashCents: Math.min(settled, paidNet),
      unsettledCents: Math.max(0, paidNet - settled),
      incrementalCostsCents: costs,
      unpaidCommitmentsCents: unpaid,
      heldCommitmentsCents: held,
      contributionCents: contributionFrom({ payments, refunds, costs, unpaidCommitments: unpaid }),
      owedByBuyerCents: owed,
      invoiceableCents: invoiceable,
      uncoveredPendingCents: uncoveredPending,
    },
    agreements,
    invoices,
    unattributedPayments: await unattributedPersonPayments(opportunity.id, currency),
    obligations,
    observations,
    contacted,
    delivered,
    paymentInFlight,
  };
}

/**
 * Whether "the money is in and the delivery is done" may be said of this deal.
 *
 * The one predicate `advance(COLLECTED)` and the journey tick both ask, so a
 * button and the tick cannot disagree about it. Every live agreement is paid
 * and settled, nothing billed is owed, and the work was accepted — never an
 * intention, never a settlement alone.
 */
export function collectable(position: DealPosition): { ok: true } | { ok: false; reason: string } {
  const p = position.pnl;
  if (!position.delivered) {
    return {
      ok: false,
      reason:
        'Not every agreement on this piece is fulfilled: each needs its work done, the whole promise ' +
        'delivered, the buyer’s acceptance recorded, no failure and every refund resolved.',
    };
  }
  if (p.agreedRevenueCents <= 0) {
    return { ok: false, reason: 'Nothing is agreed on this piece, so there is nothing to collect.' };
  }
  if (p.owedByBuyerCents > 0 || p.customerPaymentsCents - p.refundsCents < p.agreedRevenueCents) {
    return { ok: false, reason: 'Not everything agreed has been paid yet.' };
  }
  if (p.unsettledCents > 0) {
    return {
      ok: false,
      reason: 'Some of what was paid has not settled, and money that has not settled is not cash yet.',
    };
  }
  return { ok: true };
}
