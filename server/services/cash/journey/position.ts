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
import { totalsByKind } from '../../../repos/cashLedger.ts';
import { listCommitments } from '../../../repos/cashAuthority.ts';
import { actionsFor } from '../../../repos/cashActions.ts';
import {
  agreementsFor,
  fulfilmentsFor,
  invoicesFor,
  observationsFor,
} from '../../../repos/cashJourney.ts';
import { commercialOperationsFor } from '../effects.ts';
import type {
  CashAgreement,
  CashFulfilment,
  CashInvoice,
  CashObservation,
} from '../../../domain/cashJourney.ts';
import type { CashOpportunity, CashMoneyKind } from '../../../domain/types.ts';

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
}

export interface DealPosition {
  opportunityId: string;
  stage: JourneyStage;
  paymentState: PaymentState;
  pnl: DealPnl;
  agreements: CashAgreement[];
  invoices: CashInvoice[];
  fulfilments: CashFulfilment[];
  observations: CashObservation[];
  contacted: boolean;
  /** Whether the work has been accepted against its acceptance condition. */
  delivered: boolean;
  /** Whether a take-payment attempt is in flight or unknown. */
  paymentInFlight: boolean;
}

const num = (t: Partial<Record<CashMoneyKind, number>>, k: CashMoneyKind): number => Number(t[k] ?? 0);

/** Each live agreement's room for another invoice, oldest first. */
export function invoiceRoomByAgreement(
  agreements: CashAgreement[],
  invoices: CashInvoice[],
): { agreement: CashAgreement; roomCents: number }[] {
  return agreements
    .filter((one) => one.state === 'AGREED')
    .map((agreement) => {
      const billed = invoices
        .filter((one) => one.agreementId === agreement.id && one.state === 'ISSUED')
        .reduce((sum, one) => sum + one.amountCents, 0);
      return { agreement, roomCents: Math.max(0, agreement.amountCents - billed) };
    });
}

export async function dealPosition(input: {
  opportunity: CashOpportunity;
  currency: string;
}): Promise<DealPosition> {
  const { opportunity, currency } = input;
  const [agreements, invoices, fulfilments, observations, actions, totals, operations, commitments] =
    await Promise.all([
      agreementsFor(opportunity.id),
      invoicesFor(opportunity.id),
      fulfilmentsFor(opportunity.id),
      observationsFor(opportunity.id),
      actionsFor(opportunity.id),
      totalsByKind({ projectId: opportunity.projectId, opportunityId: opportunity.id, currency }),
      commercialOperationsFor(opportunity.projectId, opportunity.id),
      listCommitments(opportunity.projectId),
    ]);

  const live = agreements.filter((one) => one.state === 'AGREED' && one.currency === currency);
  const agreedRevenue = live.reduce((sum, one) => sum + one.amountCents, 0);
  const ledgerAgreed = Math.max(0, num(totals, 'PIPELINE_AGREED') - num(totals, 'PIPELINE_RELEASED'));
  const issued = invoices.filter((one) => one.state === 'ISSUED' && one.currency === currency);
  const invoiced = issued.reduce((sum, one) => sum + one.amountCents, 0);

  const payments = num(totals, 'CUSTOMER_PAYMENT');
  const refunds = num(totals, 'REFUND');
  const paidNet = Math.max(0, payments - refunds);
  const settled = num(totals, 'SETTLEMENT');
  const costs = num(totals, 'COST');
  const unpaid = Math.max(0, num(totals, 'UNPAID_COMMITMENT') - num(totals, 'COMMITMENT_PAID'));
  const held = commitments
    .filter((one) => one.opportunityId === opportunity.id && one.state === 'HELD' && one.currency === currency)
    .reduce((sum, one) => sum + one.amountCents, 0);

  // A payment the buyer made reduces what they owe; a refund Brain paid back
  // does not make them owe it again.
  const owed = Math.max(0, invoiced - payments);
  // What an invoice that expired unpaid left is billable again; what was paid
  // against it is not.
  const invoiceable = Math.max(0, agreedRevenue - Math.max(invoiced, paidNet));
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
  const delivered = fulfilments.some((one) => one.state === 'DELIVERED');
  const fulfilling = fulfilments.some((one) => one.state === 'CREATED' || one.state === 'PERFORMED');
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
      contributionCents: payments - refunds - costs - unpaid,
      owedByBuyerCents: owed,
      invoiceableCents: invoiceable,
    },
    agreements,
    invoices,
    fulfilments,
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
        'The work has not been accepted by the buyer, so the delivery is not done. Record the ' +
        'fulfilment, what was performed, and the buyer accepting it.',
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
