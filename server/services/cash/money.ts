/**
 * The six numbers, and the arithmetic that keeps them apart.
 *
 * §5's whole point is that these are *different figures* and that collapsing
 * any two of them is how a sprint comes to believe it has money it has not got.
 * So every one of them is derived here, from `cash_money_entries` and the held
 * commitments, and none of them is stored.
 *
 * ---------------------------------------------------------------------------
 * The one arithmetic mistake this file exists to refuse
 * ---------------------------------------------------------------------------
 *
 * "Already-paid expenses are already reflected in that balance; do not subtract
 * them twice." A `COST` entry is money that has *left* the account, so it is
 * subtracted once, in `availableFunds`. `deployableCash` then subtracts only
 * what has **not** left yet — unpaid commitments and protected reserves.
 * Subtracting costs again there would understate deployable cash by the whole
 * of what the sprint has ever spent, and would get worse the better it went.
 *
 * ---------------------------------------------------------------------------
 * Why a payment is not funds
 * ---------------------------------------------------------------------------
 *
 * `CUSTOMER_PAYMENT` and `SETTLEMENT` are two events about the same money: the
 * customer paid, and later the money became usable. Only the second moves
 * `availableFunds`. Stripe's own documentation says a first live payout is
 * typically scheduled to complete within 7-14 days and can take longer, and
 * later payouts follow the account's schedule — so treating a payment as cash
 * would put money in a plan a fortnight before it exists.
 */
import { heldCentsForProject } from '../../repos/cashAuthority.ts';
import { listMoneyEntries, totalsByKind } from '../../repos/cashLedger.ts';
import type { CashMoneyEntry, CashMoneyKind } from '../../domain/types.ts';

export interface CashPosition {
  currency: string;
  /** Proposed or agreed work with no cash received. Never added to anything. */
  pipelineCents: number;
  /** Verified payments, including those still pending with the provider. */
  customerPaymentsCents: number;
  /** Money settled and usable through the verified payment route. */
  availableFundsCents: number;
  /** Delivery costs and supplier bills incurred and not yet paid. */
  unpaidCommitmentsCents: number;
  /** Money held against a commitment Brain has authorized but not yet spent. */
  heldCommitmentsCents: number;
  /** Refunds, taxes, delivery obligations and protected operating cash. */
  reservesCents: number;
  /** What may actually be committed to something new. */
  deployableCents: number;
  /** Earned sales minus every incremental cost, before overhead and tax. */
  completedContributionCents: number;
  /**
   * Whether deployable cash is negative.
   *
   * Reported rather than smoothed over, and it is what stops new discretionary
   * commitments: §5 says an account in this state must expose the funding
   * shortfall rather than carry on.
   */
  shortfall: boolean;
}

function sum(totals: Partial<Record<CashMoneyKind, number>>, kind: CashMoneyKind): number {
  return Number(totals[kind] ?? 0);
}

/**
 * The position for one project, or for one opportunity inside it.
 *
 * Held commitments are a project-level fact — the ceiling is the owner's, not
 * one deal's — so they are counted only when the whole project is being asked
 * about. An opportunity's own position is about what that transaction did.
 */
export async function cashPosition(input: {
  projectId: string;
  opportunityId?: string;
  /**
   * The sprint's own currency, from `cash_modes`.
   *
   * It bounds the aggregation as well as labelling it. Labelling a sum that
   * mixed currencies would be the worst of both: a figure nobody can use,
   * wearing a label that says it was checked.
   */
  currency?: string;
}): Promise<CashPosition> {
  const totals = await totalsByKind({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
  });

  const capitalIn = sum(totals, 'CAPITAL_IN');
  const capitalOut = sum(totals, 'CAPITAL_OUT');
  const pipeline = sum(totals, 'PIPELINE_AGREED');
  const payments = sum(totals, 'CUSTOMER_PAYMENT');
  const settled = sum(totals, 'SETTLEMENT');
  const refunds = sum(totals, 'REFUND');
  const costs = sum(totals, 'COST');
  const unpaid = sum(totals, 'UNPAID_COMMITMENT');
  const paidOff = sum(totals, 'COMMITMENT_PAID');
  const reserved = sum(totals, 'RESERVE');
  const released = sum(totals, 'RESERVE_RELEASE');

  // Settled inflows and the account's own capital, minus what has actually
  // left: costs paid, refunds paid out, capital withdrawn. This is the
  // reconciliation §5 asks for — opening cash plus settled inflows minus actual
  // outflows — with no accrual anywhere in it.
  const availableFunds = capitalIn + settled - capitalOut - costs - refunds;

  // Incurred and not yet paid. `COMMITMENT_PAID` is the moment a bill becomes a
  // `COST`, so it is subtracted here and the cost is subtracted above; the same
  // dollar is never counted in both at once.
  const unpaidCommitments = Math.max(0, unpaid - paidOff);

  const held = input.opportunityId ? 0 : await heldCentsForProject(input.projectId);
  const reserves = Math.max(0, reserved - released);

  const deployable = availableFunds - unpaidCommitments - held - reserves;

  // Earned, not received: a contribution is what the transaction produced, and
  // it is complete whether or not the provider has paid out yet. Every
  // incremental cost is in it, including the tests that produced no sale.
  const completedContribution = payments - refunds - costs;

  return {
    currency: input.currency ?? 'USD',
    pipelineCents: pipeline,
    customerPaymentsCents: payments - refunds,
    availableFundsCents: availableFunds,
    unpaidCommitmentsCents: unpaidCommitments,
    heldCommitmentsCents: held,
    reservesCents: reserves,
    deployableCents: deployable,
    completedContributionCents: completedContribution,
    shortfall: deployable < 0,
  };
}

export interface MoneyRefusal {
  ok: false;
  reason: string;
}

export interface MoneyAccepted {
  ok: true;
}

/**
 * Whether an entry may be written at all.
 *
 * Two rules, and both are about the word "verified". A `CUSTOMER_PAYMENT` and a
 * `SETTLEMENT` carry the provider or bank reference that makes them
 * reconcilable — a payment nobody can trace is pipeline, and recording it as
 * cash is how a forecast gets into a bank balance. And a zero-amount entry is
 * refused rather than stored, because an entry that moves nothing is a
 * mis-click that will later read as evidence something happened.
 */
export function checkMoneyEntry(input: {
  kind: CashMoneyKind;
  amountCents: number;
  verifiedReference?: string | null;
}): MoneyAccepted | MoneyRefusal {
  if (!Number.isFinite(input.amountCents) || Math.trunc(input.amountCents) !== input.amountCents) {
    return { ok: false, reason: 'An amount is a whole number of cents.' };
  }
  if (input.amountCents <= 0) {
    return {
      ok: false,
      reason:
        'An amount must be greater than zero. The kind decides the direction, so a negative or ' +
        'zero entry cannot mean anything.',
    };
  }
  if (
    (input.kind === 'CUSTOMER_PAYMENT' || input.kind === 'SETTLEMENT') &&
    !(input.verifiedReference ?? '').trim()
  ) {
    return {
      ok: false,
      reason:
        'A customer payment and a settlement each need the provider or bank reference that ' +
        'makes them verifiable. A payment nobody can trace is pipeline, not cash.',
    };
  }
  return { ok: true };
}

/**
 * The worked illustration, as a readable line per entry.
 *
 * A projection for the money view: it says what each row did to the position
 * rather than restating the row. Nothing here writes.
 */
export function explainEntries(entries: CashMoneyEntry[]): {
  entry: CashMoneyEntry;
  effect: string;
}[] {
  return entries.map((entry) => ({ entry, effect: EFFECTS[entry.kind] }));
}

const EFFECTS: Record<CashMoneyKind, string> = {
  CAPITAL_IN: 'adds to available funds',
  CAPITAL_OUT: 'takes money out of available funds',
  PIPELINE_AGREED: 'is agreed work and changes no balance',
  CUSTOMER_PAYMENT: 'is earned, and is not usable until it settles',
  SETTLEMENT: 'makes money usable',
  REFUND: 'reverses earnings and is paid out of available funds',
  COST: 'has already left the account',
  UNPAID_COMMITMENT: 'is owed and reduces deployable cash',
  COMMITMENT_PAID: 'closes an amount owed, which the matching cost records',
  RESERVE: 'protects cash from being redeployed',
  RESERVE_RELEASE: 'makes protected cash deployable again',
};

/** The project's own entries, newest first. A thin pass-through for the view. */
export async function recentMoney(
  projectId: string,
  currency?: string,
  limit = 50,
): Promise<CashMoneyEntry[]> {
  return listMoneyEntries({ projectId, currency, limit });
}
