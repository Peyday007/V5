/**
 * What has happened on one piece being executed, as a person needs to read it.
 *
 * The Cash page could record every step after READY and could show none of
 * them back on the piece itself: the actions were in `cash_actions`, the
 * money in the ledger, Brain's own attempts in `idempotency_operations`, and
 * the only place any of it surfaced was the project-wide activity list. So a
 * person looking at an executing piece could not tell what had been sent,
 * what was agreed, what was paid, what had settled, or whether an attempt of
 * Brain's was waiting on them to say what happened.
 *
 * Every figure here is derived from append-only rows at read time and none is
 * stored (invariant 37). The four money figures are kept apart on purpose:
 * agreed is pipeline, a payment is earned and not usable, a settlement is
 * usable, and a refund takes back from both — collapsing any two of them is
 * how a sprint comes to believe it has money it has not got.
 */
import { listInvoices } from '../../repos/cashInvoices.ts';
import { dealPosition } from './journey/position.ts';
import { usableAdapter } from './effects.ts';
import { actionsFor } from '../../repos/cashActions.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readCapability } from './capabilities.ts';
import { COMMERCIAL_EFFECTS, PERFORMABLE_ACTIONS, type PerformableAction } from './effects.ts';
import { effectAttemptsFor, sendGate, type EffectAttemptView } from './perform.ts';
import type { CashActionPerformer, CashOpportunity } from '../../domain/types.ts';

export interface ExecutionRecord {
  actions: {
    id: string;
    action: string;
    performedBy: CashActionPerformer;
    detail: string;
    reference: string | null;
    at: string;
  }[];
  money: {
    currency: string;
    /** Live agreements' amounts: what was agreed. Not cash. */
    agreedCents: number;
    /** `CUSTOMER_PAYMENT` net of refunds: earned, not usable until it settles. */
    paidCents: number;
    /** Settled and usable, never more than was paid net of refunds. */
    settledCents: number;
    refundedCents: number;
    /** Agreed and not yet paid. Zero when nothing was agreed. */
    outstandingCents: number;
  };
  /** Each customer payment and each settlement, with its provider reference. */
  payments: MoneyLine[];
  settlements: MoneyLine[];
  /** Brain's own attempts through an effect adapter, newest first. */
  attempts: EffectAttemptView[];
  /** The attempts counted by what is known about them. */
  effects: {
    attempted: number;
    /** The provider confirmed it and it is on the record. */
    confirmed: number;
    /** The provider confirmed it and the record has not caught up yet; the tick finishes it. */
    confirmedNotRecorded: number;
    /** Nobody knows whether it happened; a person settles it. Never resent. */
    uncertain: number;
    refused: number;
    inProgress: number;
  };
  /** The occurrence the next recorded action will be — what `perform` compares. */
  nextOccurrence: string;
  /** What Brain could do here itself, and why not where it cannot. */
  performable: {
    action: PerformableAction;
    doing: string;
    capability: string;
    /** What reading the capability gives right now — PRESENT only with an adapter. */
    capabilityState: string;
    available: boolean;
    reason: string | null;
  }[];
  /** The actions Brain could perform on this piece now, in the order offered. */
  brainCanDoNow: PerformableAction[];
  /**
   * Why Brain can do nothing here itself, in one sentence, or null when it can
   * do something. The first action's own reason: the one a person would act on.
   */
  blocker: string | null;
}

export interface MoneyLine {
  id: string;
  amountCents: number;
  reference: string | null;
  at: string;
}

const PERFORMABLE_FROM: Readonly<Record<PerformableAction, readonly string[]>> = {
  CONTACT_BUYER: ['READY', 'EXECUTING', 'DELIVERING'],
  QUOTE_AND_INVOICE: ['EXECUTING', 'DELIVERING'],
  ACCEPT_PAYMENT: ['EXECUTING', 'DELIVERING'],
};

export async function executionRecord(input: {
  opportunity: CashOpportunity;
  currency: string;
}): Promise<ExecutionRecord> {
  const { opportunity, currency } = input;
  const actions = await actionsFor(opportunity.id);
  // The deal's figures are `position.ts`'s, the one derivation of a deal's
  // money; this record shows them beside the actions and attempts rather than
  // computing a second set that could disagree.
  const { pnl } = await dealPosition({ opportunity, currency });
  const agreed = pnl.agreedRevenueCents;
  const refunds = pnl.refundsCents;
  // Credited, not gross: a second payment owed back is not money toward the agreement.
  const paid = pnl.creditedPaymentsCents;

  const attempts = await effectAttemptsFor(opportunity.projectId, opportunity.id);
  const nextOccurrence = String(actions.length + 1);
  const entries = await listMoneyEntries({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    currency,
  });
  const lines = (kind: string): MoneyLine[] =>
    entries
      .filter((one) => one.kind === kind)
      .map((one) => ({
        id: one.id,
        amountCents: one.amountCents,
        reference: one.verifiedReference,
        at: one.occurredAt,
      }));

  const performable: ExecutionRecord['performable'] = [];
  for (const action of PERFORMABLE_ACTIONS) {
    if (!PERFORMABLE_FROM[action].includes(opportunity.state)) continue;
    const effect = COMMERCIAL_EFFECTS[action];
    const reading = await readCapability(effect.capability);
    const decision = await checkCommercialAuthority({ projectId: opportunity.projectId, action });
    let reason: string | null = null;
    if (action === 'CONTACT_BUYER' && opportunity.state === 'READY' && actions.some((one) => one.action === action)) {
      reason = 'The buyer has already been reached; this waits to begin execution from that contact.';
    } else if (reading.state !== 'PRESENT') {
      reason =
        `${effect.capability} reads ${reading.state}: no integration for it is registered, so ` +
        'Brain cannot do this itself. Do it yourself and record it here.';
    } else if (!decision.ok) {
      reason = `Not authorized: ${decision.reason}.`;
    } else {
      // The same gate `performCommercialAction` asks, so the record never
      // offers a press the server would refuse.
      const gate = await sendGate(opportunity, action);
      if (!gate.ok) reason = gate.reason;
    }
    // An invoice leaves Brain only as a drafted `cash_invoices` row (its terms
    // are a person's), and a payment is charged only through a charge adapter —
    // a payment reader means the buyer pays the invoice's own page.
    if (reason === null && action === 'QUOTE_AND_INVOICE' && agreed > 0) {
      const pending = await listInvoices({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        states: ['DRAFTED', 'UNCERTAIN'],
      });
      if (pending.length === 0) {
        reason = 'No invoice is drafted. Request one with who is billed, the tax treatment and the due date.';
      }
    }
    if (reason === null && action === 'ACCEPT_PAYMENT') {
      // perform.ts refuses a charge beside an open invoice; never offer one.
      const open = (await listInvoices({ projectId: opportunity.projectId, opportunityId: opportunity.id })).filter(
        (one) =>
          one.state === 'DRAFTED' || one.state === 'UNCERTAIN' || (one.state === 'ISSUED' && !one.paymentEntryId),
      );
      if (open.length > 0) {
        reason = `Invoice ${open.map((one) => one.id).join(', ')} is open for this money; the buyer pays it there.`;
      }
    }
    if (reason === null && action === 'ACCEPT_PAYMENT' && !usableAdapter(effect.namespace)) {
      reason = 'The buyer pays the invoice through the provider’s own page; Brain reads the payment rather than charging it.';
    }
    if (reason === null && action !== 'CONTACT_BUYER' && agreed <= 0) {
      reason = 'No amount is recorded as agreed, so there is nothing to bill or collect.';
    } else if (reason === null && action === 'ACCEPT_PAYMENT' && agreed - paid <= 0) {
      reason = 'Everything agreed has already been paid.';
    }
    performable.push({
      action,
      doing: effect.doing,
      capability: effect.capability,
      capabilityState: reading.state,
      available: reason === null,
      reason,
    });
  }

  return {
    actions: actions.map((one) => ({
      id: one.id,
      action: one.action,
      performedBy: one.performedBy,
      detail: one.detail,
      reference: one.reference,
      at: one.createdAt,
    })),
    money: {
      currency,
      agreedCents: agreed,
      paidCents: paid,
      settledCents: pnl.settledCashCents,
      refundedCents: refunds,
      outstandingCents: Math.max(0, agreed - paid),
    },
    payments: lines('CUSTOMER_PAYMENT'),
    settlements: lines('SETTLEMENT'),
    attempts,
    effects: {
      attempted: attempts.length,
      confirmed: attempts.filter((one) => one.status === 'PERFORMED').length,
      confirmedNotRecorded: attempts.filter((one) => one.status === 'UNRECORDED').length,
      uncertain: attempts.filter((one) => one.status === 'UNKNOWN').length,
      refused: attempts.filter((one) => one.status === 'REFUSED').length,
      inProgress: attempts.filter((one) => one.status === 'IN_PROGRESS').length,
    },
    nextOccurrence,
    performable,
    brainCanDoNow: performable.filter((one) => one.available).map((one) => one.action),
    blocker: performable.some((one) => one.available)
      ? null
      : (performable[0]?.reason ??
        `Brain performs nothing on a piece that is ${opportunity.state.toLowerCase()}.`),
  };
}
