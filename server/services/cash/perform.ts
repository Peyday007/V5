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
 * about the exact action before anything is sent, and the grant it was sent
 * under is written down first (`EffectIntent`); the capability is `PRESENT`
 * only when a real adapter is registered; and no amount is ever composed — an
 * invoice is for what a person recorded as agreed, a payment for what is still
 * outstanding against it.
 *
 * A receipt whose record did not land is not lost. A write that failed, a
 * process that died after the provider answered, a grant revoked or a piece
 * moved while the send was in flight all leave a SUCCEEDED operation carrying
 * the receipt, and `reconcileConfirmedEffects` — on the durable tick — records
 * it exactly once through `recordConfirmedEffect`, which calls no adapter. A
 * revocation stops the *next* effect; it never unsays one that happened.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { actionsFor, countActions, recordAction } from '../../repos/cashActions.ts';
import { moneyEntryByKey } from '../../repos/cashLedger.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { getOperation, resolveUncertain } from '../../repos/idempotency.ts';
import { listNeeds, openNeedForKey } from '../../repos/cashPortfolio.ts';
import { readNeedCondition } from './conditions.ts';
import { OperationConflict, OperationInProgress } from '../effects/engine.ts';
import type { ExternalOutcome } from '../effects/external.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readCapability } from './capabilities.ts';
import { closeNeed, raiseNeed } from './needs.ts';
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
  commercialOperationsInProject,
  intentFor,
  isPerformable,
  receiptOf,
  sendCommercialEffect,
  type CommercialOperation,
  type PerformableAction,
} from './effects.ts';
import type { CashOpportunity, IdempotencyOperation } from '../../domain/types.ts';
import { createHash } from 'node:crypto';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { composeOffer } from './offer.ts';
import { dealPosition } from './journey/position.ts';
import { nextInvoiceTarget, recordInvoiceFromEffect } from './journey/deal.ts';

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
  try {
    const recorded = await recordConfirmedEffect({
      opportunityId: opportunity.id,
      action,
      occurrence,
      operation: outcome.operation,
      receiptRef,
      actorRef: input.actorRef,
      amountCents: input.amountCents ?? null,
    });
    return recorded.result;
  } catch (error) {
    /*
     * The provider did it and the record could not be written — a database
     * that went away, a lock that timed out. The operation is SUCCEEDED with
     * the receipt on it and its intent is in the history, so
     * `reconcileConfirmedEffects` finishes this on the next tick without
     * anybody pressing anything, and without sending again.
     */
    return {
      kind: 'PERFORMED_NOT_RECORDED',
      receiptRef,
      reason:
        `writing the record failed (${error instanceof Error ? error.message : String(error)}). ` +
        'The receipt is kept and Brain finishes the record on its next pass; nothing is sent again.',
    };
  }
}

/* ------------------------------------------------------------------------- */
/* A receipt becomes the record — once, whenever it is read                   */
/* ------------------------------------------------------------------------- */

/** The key a confirmed effect is kept under when the piece has moved on. */
export function unappliedEffectKey(
  opportunityId: string,
  action: PerformableAction,
  operationId: string,
): string {
  return `effect-unapplied:${opportunityId}:${action}:${operationId}`;
}

/** The key a confirmed effect is kept under when Brain cannot say which grant covered it. */
export function unattributedEffectKey(opportunityId: string, operationId: string): string {
  return `effect-unattributed:${opportunityId}:${operationId}`;
}

/** The payment entry a confirmed take-payment writes, keyed as the page keys one. */
export function paymentKey(opportunityId: string, receiptRef: string): string {
  return `payment:${opportunityId}:${receiptRef}`;
}

const IN_FLIGHT = new Set<CashOpportunity['state']>(['EXECUTING', 'DELIVERING']);

/**
 * Record what a provider confirmed, exactly once, from whatever is true now.
 *
 * This is the one place a receipt becomes `cash_actions` and, for a payment,
 * `cash_money_entries` — called straight after a send, after a person settles
 * an unknown, and by the tick for a receipt whose recording never finished. It
 * calls no adapter, so nothing it does can send anything.
 *
 * Three facts decide it, and only the first is current:
 *
 *   - **Where the piece stands now.** A contact on a READY piece begins
 *     execution if beginning is still allowed; anything else is recorded as
 *     history with no transition, and where the effect no longer fits the
 *     piece an open need says so. A transition is never fabricated to make
 *     the record look tidy.
 *   - **The grant it was sent under**, read from the send-time intent rather
 *     than asked again. A revocation stops the next effect; it does not unsay
 *     one that already happened.
 *   - **The amount it was sent for**, from the same intent, never recomputed:
 *     what is outstanding now is not what was taken then.
 *
 * Idempotent by construction: the action is keyed `actionKey(...)` and the
 * payment `paymentKey(...)`, both `ON CONFLICT DO NOTHING`, so a second call —
 * the tick and a person racing, or the same tick twice — writes nothing.
 */
export async function recordConfirmedEffect(input: {
  opportunityId: string;
  action: PerformableAction;
  occurrence: string;
  operation: IdempotencyOperation;
  receiptRef: string;
  actorRef: string;
  /** A person's verified amount for a settled unknown; otherwise the intent's. */
  amountCents?: number | null;
}): Promise<{ result: EffectResult; created: boolean }> {
  const { action, occurrence, operation, receiptRef } = input;
  const effect = COMMERCIAL_EFFECTS[action];
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) {
    return {
      result: { kind: 'PERFORMED_NOT_RECORDED', receiptRef, reason: 'the opportunity is gone.' },
      created: false,
    };
  }
  const intent = operation.correlationId
    ? await intentFor(opportunity.id, operation.correlationId)
    : null;

  /*
   * The grant this was sent under. An operation from before intents were
   * written has none, and then the only honest attribution is a grant that
   * covers the action now; with neither, the fact stays visible on a need
   * rather than being written against an authority nobody can name.
   */
  let authorityId = intent?.authorityId ?? null;
  if (!authorityId) {
    const decision = await checkCommercialAuthority({ projectId: opportunity.projectId, action });
    authorityId = decision.ok && decision.authority ? decision.authority.id : null;
  }
  if (!authorityId) {
    await raiseNeed({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      actorRef: BRAIN,
      blockedAction: `Record ${effect.doing} for "${opportunity.title}"`,
      whyItMatters:
        `The provider confirmed it (reference ${receiptRef}), and Brain holds no record of which ` +
        'standing grant it was sent under, so it cannot be attributed to one.',
      recommendedPath: "Record it on this piece yourself with the provider's reference.",
      setupEffort: 'A minute.',
      nextStep: `Record ${action} with reference ${receiptRef}.`,
      completionCondition: `A ${action} carrying reference ${receiptRef} is on the record for this piece.`,
      requestKey: unattributedEffectKey(opportunity.id, operation.id),
    });
    return {
      result: {
        kind: 'PERFORMED_NOT_RECORDED',
        receiptRef,
        reason: 'no grant can be named for it, so it waits on an open need instead.',
      },
      created: false,
    };
  }

  const requestKey = actionKey(opportunity.id, action, occurrence);
  const detail = detailFor(action, opportunity);
  let created = false;
  let unapplied: string | null = null;

  const already = (await actionsFor(opportunity.id)).some((one) => one.requestKey === requestKey);
  if (!already) {
    let began: Outcome<CashOpportunity> | null = null;
    if (action === 'CONTACT_BUYER' && opportunity.state === 'READY') {
      began = await beginExecution({
        opportunityId: opportunity.id,
        actorRef: input.actorRef,
        firstAction: { action, performedBy: 'BRAIN', detail, reference: receiptRef, requestKey },
      });
      if (began.ok) created = true;
      else {
        unapplied =
          `It was ready when Brain reached the buyer, and beginning execution is refused now: ` +
          `${began.reason} The contact is recorded; the piece stays ready until that changes.`;
      }
    } else if (!IN_FLIGHT.has(opportunity.state)) {
      unapplied =
        `It is ${opportunity.state.toLowerCase()} now${
          intent && intent.stateAtSend !== opportunity.state
            ? `, and was ${intent.stateAtSend.toLowerCase()} when it was sent`
            : ''
        }, so nothing about its state follows from this.`;
    }
    if (!began?.ok) {
      const written = await recordAction({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        authorityId,
        action,
        performedBy: 'BRAIN',
        reference: receiptRef,
        detail,
        confirmedBy: input.actorRef,
        requestKey,
      });
      if (written.created) {
        created = true;
        await recordCashEvent({
          projectId: opportunity.projectId,
          opportunityId: opportunity.id,
          kind: 'CASH_ACTION_RECORDED',
          actorRef: input.actorRef,
          summary: `${action} was performed by brain.`,
          detail: {
            actionId: written.action.id,
            reference: receiptRef,
            authorityId,
            operationId: operation.id,
            authorizedAt: intent ? 'SEND' : 'RECORD',
          },
        });
      }
    }
  }

  if (unapplied) {
    await raiseNeed({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      actorRef: BRAIN,
      blockedAction: `Reconcile ${effect.doing} with where "${opportunity.title}" stands now`,
      whyItMatters:
        `The provider confirmed ${effect.doing} (reference ${receiptRef}) and it is recorded as done. ` +
        unapplied,
      recommendedPath:
        action === 'CONTACT_BUYER' && opportunity.state === 'READY'
          ? 'Nothing to send: once beginning execution is allowed again Brain moves it on by itself ' +
            'from the contact already recorded. If it should not proceed, archive it.'
          : 'Check with the payer what this means for them, and decide whether this piece should be ' +
            'reopened, refunded or left as it is.',
      setupEffort: 'A few minutes.',
      nextStep:
        action === 'CONTACT_BUYER' && opportunity.state === 'READY'
          ? 'Resolve the refusal above, or archive the piece.'
          : 'Decide what this effect means for this piece.',
      completionCondition:
        action === 'CONTACT_BUYER'
          ? 'Execution has begun on this piece.'
          : 'A person has decided what this effect means for this piece.',
      requestKey: unappliedEffectKey(opportunity.id, action, operation.id),
    });
  }

  if (action === 'QUOTE_AND_INVOICE') {
    // The invoice row, keyed by the operation, against the agreement the send
    // named. Without both, the record says so on a need rather than guessing
    // which agreement was billed.
    const mode = await getCashMode(opportunity.projectId);
    const amount = input.amountCents ?? intent?.amountCents ?? null;
    if (mode && amount && intent?.subjectRef) {
      await recordInvoiceFromEffect({
        opportunityId: opportunity.id,
        agreementId: intent.subjectRef,
        amountCents: amount,
        currency: mode.currency,
        operationId: operation.id,
        receiptRef,
        actorRef: input.actorRef,
      });
    }
  }

  if (action === 'ACCEPT_PAYMENT') {
    const mode = await getCashMode(opportunity.projectId);
    const amount = input.amountCents ?? intent?.amountCents ?? null;
    if (mode && amount !== null && amount > 0) {
      const key = paymentKey(opportunity.id, receiptRef);
      const before = await moneyEntryByKey(opportunity.projectId, key);
      // Keyed exactly as the page's own "Record a payment received" control
      // keys a payment, so a person recording the same receipt by hand is the
      // same entry rather than a second one. A payment, never a settlement:
      // the money becoming usable is a separate fact from a different source.
      const money = await recordMoneyEvent({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        kind: 'CUSTOMER_PAYMENT',
        amountCents: amount,
        currency: mode.currency,
        verifiedReference: receiptRef,
        note: 'Taken by Brain through the payment integration; settlement is recorded separately.',
        idempotencyKey: key,
        actorRef: input.actorRef,
        confirmedEffectOperationId: operation.id,
      });
      if (!money.ok) {
        return {
          result: { kind: 'PERFORMED_NOT_RECORDED', receiptRef, reason: money.reason },
          created,
        };
      }
      if (!before) created = true;
    } else if (mode) {
      await raiseNeed({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: `Record the payment taken for "${opportunity.title}"`,
        whyItMatters:
          `The provider confirmed taking a payment (reference ${receiptRef}) and Brain holds no ` +
          'record of the amount it asked for, so it will not write a figure it did not see.',
        recommendedPath: "Record the payment on this piece with the provider's reference and amount.",
        setupEffort: 'A minute.',
        nextStep: `Record the payment with reference ${receiptRef}.`,
        completionCondition: `A payment carrying reference ${receiptRef} is on the ledger.`,
        requestKey: unattributedEffectKey(opportunity.id, operation.id),
      });
    }
  }

  // An outcome that is now known settles the unknown it may have left behind.
  const left = await openNeedForKey(
    opportunity.projectId,
    uncertainEffectKey(opportunity.id, operation.id),
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

  const after = (await getOpportunity(opportunity.id))!;
  return {
    result: {
      kind: 'RECORDED',
      receiptRef,
      opportunity: after,
      message: unapplied
        ? `Recorded as done. ${unapplied}`
        : created
          ? 'Recorded.'
          : 'Already recorded.',
    },
    created,
  };
}

export interface ReconciledEffect {
  operationId: string;
  opportunityId: string;
  action: PerformableAction;
  receiptRef: string;
  result: EffectResult['kind'];
}

/**
 * Finish the record of every effect a provider confirmed and Brain did not
 * finish writing down.
 *
 * Derived from rows on every tick rather than hooked to the moment a write
 * failed, which is what reaches a process that died between the receipt and
 * the record: a `SUCCEEDED` operation carrying a receipt, in one of the three
 * commercial namespaces, whose action — or, for a payment, whose ledger entry
 * — is not there. It never calls an adapter, an `UNCERTAIN` operation is not
 * its business (invariant 26: an unknown is a person's to settle), and a
 * receipt already recorded is skipped before anything is written, so a second
 * pass is a no-op.
 */
export async function reconcileConfirmedEffects(projectId: string): Promise<ReconciledEffect[]> {
  const out: ReconciledEffect[] = [];
  for (const one of await commercialOperationsInProject(projectId)) {
    const { operation } = one;
    if (operation.state !== 'SUCCEEDED' || !operation.resultRef) continue;
    const receiptRef = operation.resultRef;
    const recorded = (await actionsFor(one.opportunityId)).some(
      (action) => action.requestKey === actionKey(one.opportunityId, one.action, one.occurrence),
    );
    const paid =
      one.action !== 'ACCEPT_PAYMENT' ||
      (await moneyEntryByKey(projectId, paymentKey(one.opportunityId, receiptRef))) !== null;
    if (recorded && paid) continue;

    let done: { result: EffectResult; created: boolean };
    try {
      done = await recordConfirmedEffect({
        opportunityId: one.opportunityId,
        action: one.action,
        occurrence: one.occurrence,
        operation,
        receiptRef,
        actorRef: BRAIN,
      });
    } catch {
      continue; // still SUCCEEDED and still incomplete, so the next pass tries again
    }
    if (done.created) {
      await recordCashEvent({
        projectId,
        opportunityId: one.opportunityId,
        kind: 'CASH_EFFECT_RECONCILED',
        actorRef: BRAIN,
        summary:
          `Brain finished recording ${COMMERCIAL_EFFECTS[one.action].doing} from the provider's ` +
          `receipt ${receiptRef}; nothing was sent again.`,
        detail: {
          operationId: operation.id,
          action: one.action,
          occurrence: one.occurrence,
          receiptRef,
          result: done.result.kind,
        },
      });
    }
    out.push({
      operationId: operation.id,
      opportunityId: one.opportunityId,
      action: one.action,
      receiptRef,
      result: done.result.kind,
    });
  }

  /*
   * And the needs this raised, once what they wait on is true. A contact that
   * stayed READY is answered the moment execution begins — by the tick from
   * the recorded contact, or by a person — and an effect no grant could be
   * named for is answered once its receipt is on the record. Read from rows,
   * never assumed; a need whose condition has no reading is left to a person.
   */
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    const key = need.requestKey ?? '';
    if (!key.startsWith('effect-unapplied:') && !key.startsWith('effect-unattributed:')) continue;
    const reading = await readNeedCondition(need);
    if (!reading?.holds) continue;
    await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: reading.reading,
      actorUserId: BRAIN,
      verifiedBy: 'BRAIN_READ_THE_ROW',
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* What a send is for                                                         */
/* ------------------------------------------------------------------------- */

interface Prepared {
  payload: Record<string, unknown>;
  amountCents: number | null;
  /** The journey row this send is for: the agreement an invoice bills. */
  subjectRef: string | null;
}

/**
 * The payload boundary: what an adapter is handed for this action, from the
 * rows and nothing the caller sent. No amount is ever composed here.
 *
 * A contact carries the exact offer text and its version — the digest of that
 * text — so the record of what was sent names the words that were sent, and a
 * piece whose offer cannot be drafted is not contacted at all. An invoice is
 * for what is still invoiceable against a live agreement
 * (`journey/deal.ts`), never the whole agreed figure again. A payment is for
 * what is billed and unpaid, or, where nothing is billed yet, what is agreed
 * and unpaid.
 */
export async function prepare(
  action: PerformableAction,
  opportunity: CashOpportunity,
): Promise<Outcome<Prepared>> {
  const payer = opportunity.payer;
  const channel = opportunity.reachableChannel;
  if (action === 'CONTACT_BUYER') {
    const draft = composeOffer({ opportunity, facts: await cardFactsFor(opportunity.id) });
    if (!draft.sendable || !draft.text) {
      return refuse(
        `The offer cannot be drafted from this card, so there is nothing to send. Missing: ` +
          `${draft.missing.map((one) => one.label).join(', ')}.`,
      );
    }
    return {
      ok: true,
      value: {
        payload: {
          payer: payer ?? 'the payer',
          channel: channel ?? 'the recorded channel',
          offerText: draft.text,
          offerVersion: offerVersion(draft.text),
        },
        amountCents: null,
        subjectRef: offerVersion(draft.text),
      },
      message: 'Prepared.',
    };
  }
  if (!payer) return refuse('Nobody is recorded as the payer, so there is nobody to bill.');

  const mode = await getCashMode(opportunity.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');

  if (action === 'QUOTE_AND_INVOICE') {
    const target = await nextInvoiceTarget({ opportunityId: opportunity.id, currency: mode.currency });
    if (!target.ok) return target;
    return {
      ok: true,
      value: {
        payload: {
          payer,
          channel: channel ?? null,
          amountCents: target.value.amountCents,
          currency: mode.currency,
          description: opportunity.title,
          agreementId: target.value.agreementId,
        },
        amountCents: target.value.amountCents,
        subjectRef: target.value.agreementId,
      },
      message: 'Prepared.',
    };
  }

  const position = await dealPosition({ opportunity, currency: mode.currency });
  const p = position.pnl;
  if (p.agreedRevenueCents <= 0) {
    return refuse(
      p.unbackedAgreedCents > 0
        ? 'An amount is recorded as agreed with no agreement behind it. Record the agreement before ' +
            'anything is collected.'
        : 'No agreement is recorded for this piece, so nothing is owed to collect.',
    );
  }
  const outstanding =
    p.invoicedCents > 0
      ? p.owedByBuyerCents
      : Math.max(0, p.agreedRevenueCents - (p.customerPaymentsCents - p.refundsCents));
  if (outstanding <= 0) {
    return refuse('Everything agreed and billed for this piece has already been paid.');
  }
  const open = position.invoices.filter((one) => one.state === 'ISSUED');
  return {
    ok: true,
    value: {
      payload: {
        payer,
        amountCents: outstanding,
        currency: mode.currency,
        invoiceReference: open.at(-1)?.providerRef ?? null,
      },
      amountCents: outstanding,
      subjectRef: open.at(-1)?.id ?? null,
    },
    message: 'Prepared.',
  };
}

/** The version of an offer: the digest of the exact words. */
export function offerVersion(text: string): string {
  return `offer-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

/* ------------------------------------------------------------------------- */
/* A person asking Brain to do it                                             */
/* ------------------------------------------------------------------------- */

/** Whether a contact is already on the record for this piece. */
export async function alreadyContacted(opportunityId: string): Promise<boolean> {
  return (await actionsFor(opportunityId)).some((one) => one.action === 'CONTACT_BUYER');
}

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

  // A READY piece already reached is waiting on the transition, not on a
  // second message: the contact is on the record (`recordConfirmedEffect`).
  if (action === 'CONTACT_BUYER' && opportunity.state === 'READY' && (await alreadyContacted(opportunity.id))) {
    return refuse(
      'The buyer has already been reached; this is waiting to begin execution from that contact, ' +
        'which Brain does by itself once it is allowed. Nothing more is sent.',
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
      authorityId: decision.authority!.id,
      amountCents: prepared.value.amountCents,
      stateAtSend: opportunity.state,
      subjectRef: prepared.value.subjectRef,
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
