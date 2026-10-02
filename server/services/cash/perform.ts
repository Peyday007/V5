/**
 * Brain performing a commercial action, and what the record says afterwards.
 *
 * There are three ways a commercial action reaches `cash_actions`, and this
 * file is the one that involves the outside world answering:
 *
 *   1. A person did it themselves and records it (`execute`, `record-action`).
 *      Brain performs nothing; the row says `PERSON`.
 *   2. Brain does it, because a person asked or the tick decided to, through
 *      an effect adapter (`performCommercialAction`, `advanceWithinAuthority`).
 *      The row says `BRAIN` and carries the provider's receipt — and is
 *      written **only** from a receipt.
 *   3. Brain did it and nobody knows what happened, and later a person who
 *      checked the provider says so (`resolveCommercialEffect`). The operation
 *      leaves `UNCERTAIN` through `resolveUncertain`, which is the only way out
 *      of that state, and then the record is written exactly as (2) would have.
 *
 * Every outcome goes through `applyEffectOutcome`, so the tick, a person's
 * button and a person's resolution cannot come to disagree about what a
 * receipt, an unknown or a refusal means:
 *
 *   CONFIRMED / RECONCILED / REPLAYED   the action is recorded with the receipt
 *                                       as its reference, under the same
 *                                       request key whoever arrives first — so
 *                                       the tick and a resolution racing write
 *                                       one row.
 *   UNCERTAIN                           nothing is recorded, the state does not
 *                                       move, and an open need names the
 *                                       operation. Nothing resends it.
 *   FAILED                              nothing is recorded, the state does not
 *                                       move, and the provider's own refusal is
 *                                       kept on an open need rather than in a
 *                                       tick report that lives as long as the
 *                                       process.
 *
 * Nothing here widens what may happen. The standing commercial grant is asked
 * about the exact action before anything is sent and again when it is
 * recorded; the capability is `PRESENT` only when a real adapter is
 * registered; and no amount is ever composed — an invoice is for what a person
 * recorded as agreed, a payment for what is still outstanding against it.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { actionsFor, countActions } from '../../repos/cashActions.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { getOperation, resolveUncertain } from '../../repos/idempotency.ts';
import { openNeedForKey } from '../../repos/cashPortfolio.ts';
import { OperationConflict, OperationInProgress } from '../effects/engine.ts';
import type { ExternalOutcome } from '../effects/external.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readCapability } from './capabilities.ts';
import { cashPosition } from './money.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import { recordFurtherAction } from './actions.ts';
import {
  actionKey,
  beginExecution,
  recordMoneyEvent,
  refuse,
  type Outcome,
} from './opportunities.ts';
import {
  COMMERCIAL_EFFECTS,
  commercialOperationsFor,
  isPerformable,
  receiptOf,
  sendCommercialEffect,
  type CommercialOperation,
  type PerformableAction,
} from './effects.ts';
import type { CashOpportunity, IdempotencyOperation } from '../../domain/types.ts';

const BRAIN = 'BRAIN';

/* ------------------------------------------------------------------------- */
/* Need keys                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The key an unknown outcome is raised under. Brain writes it, so
 * `conditions.ts` reads the operation back by rebuilding nothing from prose.
 */
export function uncertainEffectKey(opportunityId: string, operationId: string): string {
  return `effect-uncertain:${opportunityId}:${operationId}`;
}

/** The key a provider's refusal is kept under. */
export function failedEffectKey(
  opportunityId: string,
  action: PerformableAction,
  operationId: string,
): string {
  return `effect-failed:${opportunityId}:${action}:${operationId}`;
}

/* ------------------------------------------------------------------------- */
/* One outcome, one meaning                                                   */
/* ------------------------------------------------------------------------- */

export type EffectResult =
  | { kind: 'RECORDED'; receiptRef: string; opportunity: CashOpportunity; message: string }
  /** The effect happened and the record was refused — say so, never hide it. */
  | { kind: 'PERFORMED_NOT_RECORDED'; receiptRef: string; reason: string }
  | { kind: 'UNCERTAIN'; operationId: string; reason: string }
  | { kind: 'FAILED'; operationId: string; reason: string };

function detailFor(action: PerformableAction, opportunity: CashOpportunity): string {
  const payer = opportunity.payer ?? 'the payer';
  const channel = opportunity.reachableChannel ?? 'the recorded channel';
  switch (action) {
    case 'CONTACT_BUYER':
      return `Reached ${payer} through ${channel} with the offer on this card.`;
    case 'QUOTE_AND_INVOICE':
      return `Issued the invoice to ${payer} for the amount recorded as agreed.`;
    case 'ACCEPT_PAYMENT':
      return `Took the payment from ${payer} for the amount outstanding.`;
  }
}

/**
 * Turn what the provider said into what the record says.
 *
 * `amountCents` is what Brain asked for, when the action moves money; a
 * confirmed payment is then also a `CUSTOMER_PAYMENT` carrying the receipt as
 * its verified reference — never a `SETTLEMENT`, which is the money becoming
 * usable and is a separate fact from a different source.
 */
export async function applyEffectOutcome(input: {
  opportunity: CashOpportunity;
  action: PerformableAction;
  occurrence: string;
  outcome: ExternalOutcome;
  actorRef: string;
  amountCents?: number | null;
}): Promise<EffectResult> {
  const { opportunity, action, occurrence, outcome } = input;
  const effect = COMMERCIAL_EFFECTS[action];

  if (outcome.status === 'UNCERTAIN') {
    /*
     * The send left and what happened to it is unknown. Recording a
     * performed action here, or beginning execution, would be the exact
     * defect invariants 25 and 26 exist to refuse. An open need names the
     * unknown outcome instead — and a second pass asks the identical
     * question under the identical key, which `runExternalEffect` answers
     * by trying to reconcile rather than by sending again.
     */
    await raiseNeed({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      actorRef: BRAIN,
      blockedAction: `Confirm whether ${effect.doing} for "${opportunity.title}" actually happened`,
      whyItMatters:
        `Brain tried ${effect.doing} and what happened is unknown. Recording it as done or as ` +
        `failed would both be a guess Brain is not permitted to make, and nothing will send it ` +
        `again. ${outcome.reason}`.trim(),
      recommendedPath:
        'Check the provider directly, then record on this piece whether it happened, with the ' +
        "provider's reference if it did.",
      setupEffort: 'A few minutes of checking.',
      nextStep: 'Confirm the outcome of this attempt and record it.',
      completionCondition: 'The outcome of this attempt is known, one way or the other.',
      blocksState: action === 'CONTACT_BUYER' ? 'EXECUTING' : null,
      requestKey: uncertainEffectKey(opportunity.id, outcome.operation.id),
    });
    return {
      kind: 'UNCERTAIN',
      operationId: outcome.operation.id,
      reason:
        `Brain tried ${effect.doing} and that left the outcome unknown, so nothing here says it ` +
        'happened and this piece has not moved. An open need names it.',
    };
  }

  if (outcome.status === 'FAILED') {
    const category = outcome.operation.failureCategory ?? 'unspecified';
    const providerSaid = outcome.operation.resultSummary;
    await raiseNeed({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      actorRef: BRAIN,
      blockedAction: `${effect.doing[0]!.toUpperCase()}${effect.doing.slice(1)} for "${opportunity.title}"`,
      whyItMatters:
        `The provider refused (${category})${providerSaid ? `: ${providerSaid}` : ''}. It is ` +
        'authoritative that nothing happened, so nothing is recorded as done.',
      recommendedPath:
        'Fix what the provider refused, or do it yourself outside Brain and record it on this ' +
        'piece with its reference.',
      setupEffort: 'Depends on the refusal; nothing about it is guessed here.',
      nextStep: 'Do it another way and record it, or correct the integration.',
      completionCondition: `A ${action} is on the record for this piece after this refusal.`,
      blocksState: action === 'CONTACT_BUYER' ? 'EXECUTING' : null,
      requestKey: failedEffectKey(opportunity.id, action, outcome.operation.id),
    });
    return {
      kind: 'FAILED',
      operationId: outcome.operation.id,
      reason: `The provider refused ${effect.doing} (${category}), so nothing was done.`,
    };
  }

  // CONFIRMED, RECONCILED or REPLAYED: the provider's own receipt is what
  // makes this true, carried as the action's reference rather than composed
  // as a sentence about what Brain assumes happened.
  const receiptRef = receiptOf(outcome)!;
  const requestKey = actionKey(opportunity.id, action, occurrence);

  let recorded: Outcome<CashOpportunity>;
  if (action === 'CONTACT_BUYER' && opportunity.state === 'READY') {
    recorded = await beginExecution({
      opportunityId: opportunity.id,
      actorRef: input.actorRef,
      firstAction: {
        action,
        performedBy: 'BRAIN',
        detail: detailFor(action, opportunity),
        reference: receiptRef,
        requestKey,
      },
    });
  } else {
    recorded = await recordFurtherAction({
      opportunityId: opportunity.id,
      actorRef: input.actorRef,
      action,
      performedBy: 'BRAIN',
      detail: detailFor(action, opportunity),
      reference: receiptRef,
      requestKey,
    });
  }
  if (!recorded.ok) {
    return { kind: 'PERFORMED_NOT_RECORDED', receiptRef, reason: recorded.reason };
  }

  if (action === 'ACCEPT_PAYMENT' && input.amountCents && input.amountCents > 0) {
    const mode = await getCashMode(opportunity.projectId);
    if (mode) {
      // Keyed exactly as the page's own "Record a payment received" control
      // keys a payment, so a person recording the same receipt by hand is the
      // same entry rather than a second one.
      const money = await recordMoneyEvent({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        kind: 'CUSTOMER_PAYMENT',
        amountCents: input.amountCents,
        currency: mode.currency,
        verifiedReference: receiptRef,
        note: 'Taken by Brain through the payment integration; settlement is recorded separately.',
        idempotencyKey: `payment:${opportunity.id}:${receiptRef}`,
        actorRef: input.actorRef,
      });
      if (!money.ok) {
        return { kind: 'PERFORMED_NOT_RECORDED', receiptRef, reason: money.reason };
      }
    }
  }

  // An outcome that is now known settles the unknown it may have left behind.
  const left = await openNeedForKey(
    opportunity.projectId,
    uncertainEffectKey(opportunity.id, outcome.operation.id),
  );
  if (left) {
    await closeNeed({
      needId: left.id,
      to: 'RESOLVED',
      resolution: `It happened: the provider's reference is ${receiptRef}.`,
      actorUserId: input.actorRef,
      verifiedBy: 'BRAIN_READ_THE_ROW',
    });
  }

  return {
    kind: 'RECORDED',
    receiptRef,
    opportunity: recorded.value,
    message: recorded.message ?? 'Recorded.',
  };
}

/* ------------------------------------------------------------------------- */
/* What a send is for                                                         */
/* ------------------------------------------------------------------------- */

interface Prepared {
  payload: Record<string, unknown>;
  amountCents: number | null;
}

/**
 * The payload boundary: what an adapter is handed for this action, from the
 * rows and nothing the caller sent. No amount is ever composed here.
 */
async function prepare(
  action: PerformableAction,
  opportunity: CashOpportunity,
): Promise<Outcome<Prepared>> {
  const payer = opportunity.payer;
  const channel = opportunity.reachableChannel;
  if (action === 'CONTACT_BUYER') {
    return {
      ok: true,
      value: {
        payload: { payer: payer ?? 'the payer', channel: channel ?? 'the recorded channel' },
        amountCents: null,
      },
      message: 'Prepared.',
    };
  }
  if (!payer) return refuse('Nobody is recorded as the payer, so there is nobody to bill.');

  const mode = await getCashMode(opportunity.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  const position = await cashPosition({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    currency: mode.currency,
  });

  if (action === 'QUOTE_AND_INVOICE') {
    if (position.pipelineCents <= 0) {
      return refuse(
        'No amount is recorded as agreed for this piece, so there is nothing to invoice. Record ' +
          'the agreed amount first; Brain does not choose what a customer is billed.',
      );
    }
    return {
      ok: true,
      value: {
        payload: {
          payer,
          channel: channel ?? null,
          amountCents: position.pipelineCents,
          currency: mode.currency,
          description: opportunity.title,
        },
        amountCents: position.pipelineCents,
      },
      message: 'Prepared.',
    };
  }

  const outstanding = position.pipelineCents - position.customerPaymentsCents;
  if (outstanding <= 0) {
    return refuse(
      position.pipelineCents <= 0
        ? 'No amount is recorded as agreed for this piece, so nothing is owed to collect.'
        : 'Everything agreed for this piece has already been paid.',
    );
  }
  const invoices = (await actionsFor(opportunity.id)).filter(
    (one) => one.action === 'QUOTE_AND_INVOICE',
  );
  return {
    ok: true,
    value: {
      payload: {
        payer,
        amountCents: outstanding,
        currency: mode.currency,
        invoiceReference: invoices.at(-1)?.reference ?? null,
      },
      amountCents: outstanding,
    },
    message: 'Prepared.',
  };
}

/* ------------------------------------------------------------------------- */
/* A person asking Brain to do it                                             */
/* ------------------------------------------------------------------------- */

/** Where an action Brain performs may start from. */
function stateAllows(action: PerformableAction, state: CashOpportunity['state']): boolean {
  if (action === 'CONTACT_BUYER') return state === 'READY' || state === 'EXECUTING' || state === 'DELIVERING';
  return state === 'EXECUTING' || state === 'DELIVERING';
}

/**
 * Have Brain perform one commercial action on this piece now.
 *
 * `expectedOccurrence` is what the page said the next occurrence was. It is
 * compared, never used: the key is built from the server's own count, and a
 * second press that arrives after the first was recorded is refused here
 * rather than becoming a second invoice. An attempt still unresolved is the
 * same occurrence, so pressing again reconciles it rather than resending.
 */
export async function performCommercialAction(input: {
  opportunityId: string;
  action: string;
  actorRef: string;
  expectedOccurrence: string;
}): Promise<Outcome<EffectResult>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  if (!isPerformable(input.action)) {
    return refuse(
      `"${input.action}" is not something Brain can be connected to perform. It can perform ` +
        `one of: ${Object.keys(COMMERCIAL_EFFECTS).join(', ')}.`,
    );
  }
  const action = input.action;
  const effect = COMMERCIAL_EFFECTS[action];

  if (!stateAllows(action, opportunity.state)) {
    return refuse(
      `This is ${opportunity.state.toLowerCase()}, and ${effect.doing} is not something that ` +
        'happens from there.',
    );
  }

  // Deny by default, the person's decision first.
  const decision = await checkCommercialAuthority({ projectId: opportunity.projectId, action });
  if (!decision.ok) {
    return refuse(
      `Not authorized to ${action}: ${decision.reason}. That is a decision for the person whose ` +
        'account this is.',
    );
  }

  const reading = await readCapability(effect.capability);
  if (reading.state !== 'PRESENT') {
    return refuse(
      `${effect.doing[0]!.toUpperCase()}${effect.doing.slice(1)} needs ${effect.capability}, ` +
        `which reads ${reading.state}: no integration for it is registered on this Brain. Do it ` +
        'yourself and record it on this piece instead.',
    );
  }

  const occurrence = String((await countActions(opportunity.id)) + 1);
  const attempts = (await commercialOperationsFor(opportunity.projectId, opportunity.id)).filter(
    (one) => one.action === action,
  );
  const open = attempts.filter((one) => one.operation.state === 'UNCERTAIN');
  // Each attempt at this occurrence that ended FAILED moves the key on by
  // one. A terminal failure is either the provider saying nothing happened or
  // a person establishing it, so a new key is never a resend of an unknown —
  // and a retryable refusal stays RESERVED and keeps its key.
  const retry = attempts.filter(
    (one) => one.occurrence === occurrence && one.operation.state === 'FAILED',
  ).length;
  if (input.expectedOccurrence !== occurrence) {
    return refuse(
      'Something has been recorded on this piece since the page was loaded, so this press may ' +
        'already have been done. Reload and check before asking again.',
    );
  }
  const unresolvedElsewhere = open.find((one) => one.occurrence !== occurrence);
  if (unresolvedElsewhere) {
    return refuse(
      `An earlier attempt at ${effect.doing} has an unknown outcome. Settle it first, so this ` +
        'is never done twice.',
    );
  }

  const prepared = await prepare(action, opportunity);
  if (!prepared.ok) return prepared;

  let outcome: ExternalOutcome;
  try {
    outcome = await sendCommercialEffect({
      action,
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      occurrence,
      retry,
      payload: prepared.value.payload,
    });
  } catch (error) {
    if (error instanceof OperationInProgress) {
      return refuse(`${effect.doing[0]!.toUpperCase()}${effect.doing.slice(1)} is already under way.`);
    }
    if (error instanceof OperationConflict) {
      return refuse(
        'An attempt for this occurrence was made with different figures, and its outcome is not ' +
          'settled. Settle it before asking again.',
      );
    }
    return refuse(
      `Brain could not attempt ${effect.doing}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Nothing here says it happened.',
    );
  }

  const result = await applyEffectOutcome({
    opportunity,
    action,
    occurrence,
    outcome,
    actorRef: input.actorRef,
    amountCents: prepared.value.amountCents,
  });
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_EFFECT_ATTEMPTED',
    actorRef: input.actorRef,
    summary: `Brain attempted ${effect.doing}: ${result.kind.toLowerCase().replace(/_/g, ' ')}.`,
    detail: { action, occurrence, operationId: outcome.operation.id, result: result.kind },
  });
  return { ok: true, value: result, message: messageFor(result) };
}

function messageFor(result: EffectResult): string {
  switch (result.kind) {
    case 'RECORDED':
      return `Done. The provider's reference is ${result.receiptRef}.`;
    case 'PERFORMED_NOT_RECORDED':
      return `It happened (reference ${result.receiptRef}), and recording it was refused: ${result.reason}`;
    case 'UNCERTAIN':
    case 'FAILED':
      return result.reason;
  }
}

/* ------------------------------------------------------------------------- */
/* A person settling an unknown                                               */
/* ------------------------------------------------------------------------- */

/**
 * A person checked the provider and says what happened to an attempt whose
 * outcome Brain could not establish.
 *
 * `HAPPENED` needs the provider's reference: a person's word that it happened
 * with nothing to trace is the same unverifiable claim an `UNCERTAIN` exists to
 * refuse. `DID_NOT_HAPPEN` closes the operation as failed, which is terminal
 * for that attempt: nothing resends it, and the piece stays where it was.
 */
export async function resolveCommercialEffect(input: {
  opportunityId: string;
  operationId: string;
  actorRef: string;
  happened: boolean;
  receiptRef?: string | null;
  /** For a payment: the amount the person verified the provider took. */
  amountCents?: number | null;
  note: string;
}): Promise<Outcome<EffectResult>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const note = input.note.trim();
  if (!note) return refuse('Say what you checked. It is kept with the resolution.');

  const found = (await commercialOperationsFor(opportunity.projectId, opportunity.id)).find(
    (one) => one.operation.id === input.operationId,
  );
  // The same answer for an operation that is not this piece's as for one that
  // does not exist: a resolution cannot be used to reach another piece's row.
  if (!found) return refuse('No attempt with that id on this piece.');
  if (found.operation.state !== 'UNCERTAIN') {
    return refuse(
      `That attempt is ${found.operation.state.toLowerCase()}, not unknown. Only an unknown ` +
        'outcome can be settled, and a known one is never overwritten.',
    );
  }

  if (input.happened) {
    const receiptRef = input.receiptRef?.trim();
    if (!receiptRef) {
      return refuse(
        "Give the provider's reference for it. A record that it happened with nothing to trace " +
          'is the unverifiable claim this exists to refuse.',
      );
    }
    if (found.action === 'ACCEPT_PAYMENT' && !(input.amountCents && input.amountCents > 0)) {
      return refuse('Give the amount the provider shows was taken, so the payment can be recorded.');
    }
    const resolved = await resolveUncertain(found.operation.id, {
      as: 'SUCCEEDED',
      resultRef: receiptRef,
      summary: `Confirmed by a person: ${note}`,
    });
    if (!resolved) return refuse('That attempt changed while it was being settled. Reload.');
    const operation = (await getOperation(found.operation.id))!;
    const result = await applyEffectOutcome({
      opportunity,
      action: found.action,
      occurrence: found.occurrence,
      outcome: { status: 'RECONCILED', operation, receiptRef },
      actorRef: input.actorRef,
      amountCents: input.amountCents ?? null,
    });
    await resolutionEvent(opportunity, found, input.actorRef, 'HAPPENED', note);
    return { ok: true, value: result, message: messageFor(result) };
  }

  const resolved = await resolveUncertain(found.operation.id, {
    as: 'FAILED',
    category: 'ABANDONED',
    detail: `Confirmed by a person that it did not happen: ${note}`,
  });
  if (!resolved) return refuse('That attempt changed while it was being settled. Reload.');
  const left = await openNeedForKey(
    opportunity.projectId,
    uncertainEffectKey(opportunity.id, found.operation.id),
  );
  if (left) {
    await closeNeed({
      needId: left.id,
      to: 'RESOLVED',
      resolution: `It did not happen: ${note}`,
      actorUserId: input.actorRef,
      verifiedBy: 'BRAIN_READ_THE_ROW',
    });
  }
  await resolutionEvent(opportunity, found, input.actorRef, 'DID_NOT_HAPPEN', note);
  const result: EffectResult = {
    kind: 'FAILED',
    operationId: found.operation.id,
    reason:
      'Recorded as not having happened. Nothing will send it again; do it yourself and record ' +
      'it here, or ask Brain to try again.',
  };
  return { ok: true, value: result, message: result.reason };
}

async function resolutionEvent(
  opportunity: CashOpportunity,
  found: CommercialOperation,
  actorRef: string,
  as: 'HAPPENED' | 'DID_NOT_HAPPEN',
  note: string,
): Promise<void> {
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_EFFECT_RESOLVED',
    actorRef,
    summary: `A person settled an unknown outcome of ${COMMERCIAL_EFFECTS[found.action].doing}: ${
      as === 'HAPPENED' ? 'it happened' : 'it did not happen'
    }.`,
    detail: { operationId: found.operation.id, action: found.action, occurrence: found.occurrence, as, note },
  });
}

/* ------------------------------------------------------------------------- */
/* What the page shows                                                        */
/* ------------------------------------------------------------------------- */

export interface EffectAttemptView {
  operationId: string;
  action: PerformableAction;
  occurrence: string;
  /** `PERFORMED` = succeeded and on the record; `UNRECORDED` = succeeded, not yet. */
  status: 'PERFORMED' | 'UNRECORDED' | 'UNKNOWN' | 'REFUSED' | 'IN_PROGRESS';
  receiptRef: string | null;
  reason: string | null;
  at: string;
}

function statusOf(operation: IdempotencyOperation, recorded: boolean): EffectAttemptView['status'] {
  switch (operation.state) {
    case 'SUCCEEDED':
      return recorded ? 'PERFORMED' : 'UNRECORDED';
    case 'UNCERTAIN':
      return 'UNKNOWN';
    case 'FAILED':
      return 'REFUSED';
    default:
      // A retryable refusal leaves the operation reserved with a category on
      // it; reported as refused, since the provider said nothing happened.
      return operation.failureCategory ? 'REFUSED' : 'IN_PROGRESS';
  }
}

/** Every attempt Brain has made on this piece, as the page reads them. */
export async function effectAttemptsFor(
  projectId: string,
  opportunityId: string,
): Promise<EffectAttemptView[]> {
  const attempts = await commercialOperationsFor(projectId, opportunityId);
  if (attempts.length === 0) return [];
  const keys = new Set((await actionsFor(opportunityId)).map((one) => one.requestKey));
  return attempts.map((one) => ({
    operationId: one.operation.id,
    action: one.action,
    occurrence: one.occurrence,
    status: statusOf(one.operation, keys.has(actionKey(opportunityId, one.action, one.occurrence))),
    receiptRef: one.operation.resultRef,
    reason: one.operation.uncertaintyReason ?? one.operation.resultSummary ?? one.operation.failureCategory,
    at: one.operation.updatedAt,
  }));
}
