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
import { fulfillmentsForOpportunity } from '../../../repos/cashFulfillment.ts';
import { entriesOfKinds, moneyEntryByKey, totalsByKind, unattributedPersonPayments } from '../../../repos/cashLedger.ts';
import { listInvoices } from '../../../repos/cashInvoices.ts';
import { listCommitments } from '../../../repos/cashAuthority.ts';
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, agreementsInProject, observationsFor } from '../../../repos/cashJourney.ts';
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
  /** Customer payments net of refunds: what every surface calls "paid". */
  paidNetCents: number;
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
  /**
   * Payments that count toward what was agreed and billed: gross payments less
   * a second payment of an already-paid invoice, less refunds — the larger of
   * the two, since a refund of that second payment is the same money. A
   * payment owed back to the buyer is never credit toward an agreement.
   */
  creditedPaymentsCents: number;
  /**
   * The same, before refunds: what counts toward the agreements as having been
   * paid at all. "What is still to collect" reads this, because a refund paid
   * back never makes the buyer owe that money again.
   */
  creditedGrossCents: number;
  /**
   * Owed back to the buyer and not yet refunded: a second payment of an
   * already-paid invoice, or money paid on an agreement since released.
   */
  owedBackCents: number;
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

/** Invoices for a live agreement, and what was paid on a released one's invoices. */
async function splitByLiveAgreement(
  live: CashAgreement[],
  invoices: CashInvoice[],
  currency: string,
): Promise<{ ours: CashInvoice[]; paidOnReleased: number }> {
  const liveEntryIds = new Set([...(await entriesFor(live)).values()].map((one) => one.id));
  const allOurs = invoices.filter((one) => one.currency === currency);
  const ours = allOurs.filter((one) => one.pipelineEntryId !== null && liveEntryIds.has(one.pipelineEntryId));
  const paidOnReleased = allOurs
    .filter((one) => !ours.includes(one) && one.paymentEntryId && BILLED_INVOICE_STATES.includes(one.state))
    .reduce((sum, one) => sum + one.amountCents, 0);
  return { ours, paidOnReleased };
}

export interface OwedBackReading {
  /** Owed back before any refund: duplicates, and released money no live agreement takes. */
  grossCents: number;
  /** Owed back and not yet refunded. */
  owedBackCents: number;
  /** Refunds that repaid something other than owed-back money. */
  otherRefundsCents: number;
  /** Payments toward live agreements, before those other refunds. */
  creditedGrossCents: number;
  /** Payments toward live agreements, net of those other refunds. */
  creditedNetCents: number;
}

/**
 * The one reading of money on a piece that is not payment toward its live
 * agreements, every consumer's — `dealPosition`, the project's cash position,
 * and the hand-payment cap — so no two of them can count it differently.
 *
 * Attributed rather than pooled, from rows that already say whose money is
 * whose:
 * - A second payment of an already-paid invoice belongs to that invoice's
 *   agreement and is owed back.
 * - Money paid on an agreement since released **carries** to the piece's live
 *   agreements, oldest released first, up to what they still need — a release
 *   for a replacement keeps money already paid as paid, which is what
 *   `releaseAgreement` promises; billing the replacement again would charge
 *   the buyer twice. Only what no live agreement takes is owed back, which is
 *   what a cancellation leaves.
 * - A refund recorded on an agreement's obligation (`refund:<fulfillment>:…`)
 *   repays that agreement's owed-back money first and nothing else's; a refund
 *   with no obligation behind it repays whatever is still owed back. So a
 *   refund for one agreement's failed work never makes another agreement's
 *   owed-back money disappear.
 */
export async function owedBackReading(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
}): Promise<OwedBackReading> {
  const agreements = (await agreementsFor(input.opportunityId)).filter((one) => one.currency === input.currency);
  const live = agreements.filter((one) => one.state === 'AGREED');
  const entries = await entriesFor(agreements);
  const agreementOfEntry = new Map<string, CashAgreement>();
  for (const agreement of agreements) {
    const entry = entries.get(agreement.id);
    if (entry) agreementOfEntry.set(entry.id, agreement);
  }
  const invoices = (await listInvoices({ projectId: input.projectId, opportunityId: input.opportunityId })).filter(
    (one) => one.currency === input.currency,
  );
  const money = await entriesOfKinds({ ...input, kinds: ['CUSTOMER_PAYMENT', 'REFUND'] });
  const payments = money.filter((one) => one.kind === 'CUSTOMER_PAYMENT');
  const refunds = money.filter((one) => one.kind === 'REFUND');
  const paid = payments.reduce((sum, one) => sum + one.amountCents, 0);

  // Which agreement each refund repaid, from the obligation it was recorded on.
  const fulfillments = await fulfillmentsForOpportunity(input.projectId, input.opportunityId);
  const agreementOfFulfillment = new Map<string, string>(
    fulfillments.map((one): [string, string] => [one.id, one.agreementId]),
  );
  const refundedOn = new Map<string, number>();
  let unattributed = 0;
  for (const refund of refunds) {
    const match = /^refund:([^:]+):/.exec(refund.idempotencyKey ?? '');
    const agreementId = match ? agreementOfFulfillment.get(match[1]!) : undefined;
    if (agreementId) refundedOn.set(agreementId, (refundedOn.get(agreementId) ?? 0) + refund.amountCents);
    else unattributed += refund.amountCents;
  }
  let toOwed = 0;
  const repay = (agreementIds: readonly string[], owed: number): number => {
    // Refunds on these agreements' own obligations first, then unattributed ones.
    let repaid = 0;
    for (const agreementId of agreementIds) {
      const own = Math.min(owed - repaid, refundedOn.get(agreementId) ?? 0);
      refundedOn.set(agreementId, (refundedOn.get(agreementId) ?? 0) - own);
      repaid += own;
    }
    const loose = Math.min(owed - repaid, unattributed);
    unattributed -= loose;
    repaid += loose;
    toOwed += repaid;
    return owed - repaid;
  };

  let gross = 0;
  let owedBack = 0;

  // Second payments of an already-paid invoice: owed back.
  let duplicates = 0;
  const duplicateOwed: { agreementId: string | null; cents: number }[] = [];
  for (const entry of payments) {
    if (!entry.idempotencyKey?.startsWith('invoice-payment:')) continue;
    const invoice = invoices.find((one) => `invoice-payment:${one.id}` === entry.idempotencyKey);
    if (!invoice || !invoice.paymentEntryId || invoice.paymentEntryId === entry.id) continue;
    duplicates += entry.amountCents;
    duplicateOwed.push({ agreementId: agreementOfEntry.get(invoice.pipelineEntryId ?? '')?.id ?? null, cents: entry.amountCents });
  }

  // Money paid on released agreements' invoices. A refund that already repaid
  // it is applied *before* anything carries — money returned to the buyer is
  // not there to carry — and what is left carries to live agreements, oldest
  // released first, up to what they still need. The room is read from gross
  // live payments, so a refund of a live agreement's own failed work never
  // pulls released money into it.
  const releasedPaid = agreements
    .filter((one) => one.state !== 'AGREED')
    .map((agreement) => ({
      agreement,
      cents: invoices
        .filter(
          (one) =>
            one.pipelineEntryId === entries.get(agreement.id)?.id &&
            one.paymentEntryId &&
            BILLED_INVOICE_STATES.includes(one.state),
        )
        .reduce((sum, one) => sum + one.amountCents, 0),
    }))
    .filter((one) => one.cents > 0)
    .sort((a, b) => (a.agreement.createdAt < b.agreement.createdAt ? -1 : 1));
  const releasedTotal = releasedPaid.reduce((sum, one) => sum + one.cents, 0);
  const agreedLive = live.reduce((sum, one) => sum + one.amountCents, 0);
  // Payments bound to no agreement's invoice — a hand payment outside every
  // invoice, Brain's own charge — pay whatever the live agreements still need.
  // On a piece that has agreements, what is beyond that is owed back: money for
  // an agreement since cancelled is not earned because it never had an
  // invoice. (A piece with no agreement at all is a one-sided record from
  // before agreements existed, and its payments stay what they were.)
  const liveInvoicePaid = invoices
    .filter(
      (one) =>
        one.paymentEntryId &&
        BILLED_INVOICE_STATES.includes(one.state) &&
        live.some((agreement) => entries.get(agreement.id)?.id === one.pipelineEntryId),
    )
    .reduce((sum, one) => sum + one.amountCents, 0);
  const unbound = Math.max(0, paid - duplicates - releasedTotal - liveInvoicePaid);
  const unboundCredited =
    agreements.length === 0 ? unbound : Math.min(unbound, Math.max(0, agreedLive - liveInvoicePaid));
  const unboundExcess = unbound - unboundCredited;
  let room = Math.max(0, agreedLive - liveInvoicePaid - unboundCredited);
  for (const { agreement, cents } of releasedPaid) {
    const net = repay([agreement.id], cents);
    const carried = Math.min(net, room);
    room -= carried;
    // Not payment toward a live agreement: all of it but what carried.
    gross += cents - carried;
    owedBack += net - carried;
  }
  if (unboundExcess > 0) {
    // Money for an agreement since cancelled: a refund on any released
    // agreement's own obligation repays it, as an unattributed one does.
    gross += unboundExcess;
    owedBack += repay(
      agreements.filter((one) => one.state !== 'AGREED').map((one) => one.id),
      unboundExcess,
    );
  }
  for (const { agreementId, cents } of duplicateOwed) {
    gross += cents;
    owedBack += repay(agreementId ? [agreementId] : [], cents);
  }

  const refunded = refunds.reduce((sum, one) => sum + one.amountCents, 0);
  const other = refunded - toOwed;
  return {
    grossCents: gross,
    owedBackCents: owedBack,
    otherRefundsCents: other,
    creditedGrossCents: Math.max(0, paid - gross),
    creditedNetCents: Math.max(0, paid - gross - other),
  };
}

const num = (t: Partial<Record<CashMoneyKind, number>>, k: CashMoneyKind): number => Number(t[k] ?? 0);

/**
 * Money owed back across a project (or one piece): each piece's owed-back sum
 * less that piece's refunds, never below zero — the per-deal `owedBackCents`,
 * summed — and the part of it that has settled into the account, which is all
 * deployable cash can hold back. Only pieces with a paid invoice can owe
 * anything back, so only those are read.
 */
export async function owedBackForProject(input: {
  projectId: string;
  opportunityId: string | null;
  currency: string;
}): Promise<{ owedBack: number; inAccount: number }> {
  // Only pieces with an agreement can owe anything back.
  const ids = new Set(
    (await agreementsInProject(input.projectId))
      .filter((one) => one.currency === input.currency && (!input.opportunityId || one.opportunityId === input.opportunityId))
      .map((one) => one.opportunityId),
  );
  let owedBack = 0;
  let inAccount = 0;
  for (const opportunityId of ids) {
    const reading = await owedBackReading({ projectId: input.projectId, opportunityId, currency: input.currency });
    if (reading.owedBackCents <= 0) continue;
    const totals = await totalsByKind({ projectId: input.projectId, opportunityId, currency: input.currency });
    owedBack += reading.owedBackCents;
    // Only settled money is in the account to be held back. Which payment a
    // settlement was cannot be told from the ledger — the provider's key names
    // the invoice, and a duplicate shares it — so this takes the bound that
    // cannot over-commit: as much of the piece's settled money as is owed
    // back. Its cost is a deployable figure that reads low while a duplicate
    // is unsettled beside a settled original, until the duplicate settles.
    inAccount += Math.min(reading.owedBackCents, num(totals, 'SETTLEMENT'));
  }
  return { owedBack, inAccount };
}



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
  // Only invoices for a *live* agreement bill anything still agreed. A
  // released agreement's invoice is history: what it billed is not owed, and
  // what was paid on it is owed back below, never credit toward another
  // agreement.
  const { ours, paidOnReleased } = await splitByLiveAgreement(live, invoices, currency);
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

  // A buyer paying an invoice a second time is that invoice's money too —
  // owed back, never credit that makes another agreement paid or unbillable.
  // Every comparison of payments with what was agreed or billed reads these
  // three, so no reader can count the owed-back money as payment.
  // Owed back: a second payment of an already-paid invoice, and money paid on
  // an agreement that was since released.
  const reading = await owedBackReading({ projectId: opportunity.projectId, opportunityId: opportunity.id, currency });
  const overpaidInvoices = reading.grossCents;
  const credited = reading.creditedGrossCents;
  const creditedNet = reading.creditedNetCents;
  const owedBack = reading.owedBackCents;
  // A payment the buyer made reduces what they owe; a refund Brain paid back
  // does not make them owe it again.
  const owed = Math.max(0, invoiced - credited);
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
  const paidOutsideInvoices = Math.max(0, payments - paidAgainstInvoices - overpaidInvoices);
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
  else if (creditedNet > 0 && creditedNet >= agreedRevenue && owed === 0) {
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
      paidNetCents: paidNet,
      refundsCents: refunds,
      settledCashCents: Math.min(settled, paidNet),
      unsettledCents: Math.max(0, paidNet - settled),
      incrementalCostsCents: costs,
      unpaidCommitmentsCents: unpaid,
      heldCommitmentsCents: held,
      contributionCents: contributionFrom({ payments, refunds, costs, unpaidCommitments: unpaid, owedBack }),
      creditedPaymentsCents: creditedNet,
      creditedGrossCents: credited,
      owedBackCents: owedBack,
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
  if (p.owedByBuyerCents > 0 || p.creditedPaymentsCents < p.agreedRevenueCents) {
    return { ok: false, reason: 'Not everything agreed has been paid yet.' };
  }
  if (p.owedBackCents > 0) {
    return {
      ok: false,
      reason:
        'The buyer is owed money back — a second payment of a paid invoice, or payment on an agreement ' +
        'since released — and it has not been refunded; money owed back ' +
        'is not collected revenue.',
    };
  }
  if (p.unsettledCents > 0) {
    return {
      ok: false,
      reason: 'Some of what was paid has not settled, and money that has not settled is not cash yet.',
    };
  }
  return { ok: true };
}
