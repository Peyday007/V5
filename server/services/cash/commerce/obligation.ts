/**
 * What we owe one buyer, from the offer to the day the money is ours.
 *
 * An obligation carries the buyer's own terms — scope, price and the acceptance
 * conditions delivered work is checked against — and every move it makes is a
 * guarded transition recorded with the evidence it moved on. Four moves are
 * load-bearing, and each is refused without the one thing that makes it true:
 *
 *   * OFFER_SENT needs a `CONTACT_BUYER` action under the standing grant, with
 *     a reference to the sent offer. An offer is not a sale.
 *   * AGREED needs the buyer's own `AGREED_TO_BUY` response, with provenance.
 *     Interest is not agreement, and agreement is pipeline — never revenue.
 *   * DELIVERED needs a deliverable reference and a recorded check against
 *     every acceptance condition, each with its evidence.
 *   * ACCEPTED needs the buyer's `ACCEPTED_DELIVERY` response. Delivered work
 *     the buyer has not accepted is not accepted.
 *
 * Nothing here is gated on the sprint's lifecycle: a customer's obligation does
 * not end because a temporary section winds down.
 */
import { getOpportunity, updateOpportunity } from '../../../repos/cashPortfolio.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { recordAction } from '../../../repos/cashActions.ts';
import {
  commerceNow,
  createObligation,
  getObligation,
  getResponse,
  noteObligation,
  obligationForAgreement,
  transitionObligation,
} from '../../../repos/cashCommerce.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { advance, beginExecution, recordMoneyEvent } from '../opportunities.ts';
import { competitionFor, addDays, recordBuyerResponse, refuse, type Outcome } from './demand.ts';
import {
  DELIVERY_ROUTES,
  isOneOf,
  type CashObligation,
  type DeliveryRoute,
  type ObligationState,
} from '../../../domain/commerce.ts';

export interface Terms {
  buyer: string;
  scope: string;
  priceCents: number;
  acceptanceConditions: string[];
  deliveryPlan: string;
  deliveryRoute: string;
  requiredResources?: string[];
}

function checkTerms(terms: Terms): string | null {
  if (!terms.buyer?.trim()) return 'Name the buyer.';
  if (!terms.scope?.trim()) return 'State the scope: one outcome and what it excludes.';
  if (!Number.isInteger(terms.priceCents) || terms.priceCents <= 0) {
    return 'The price is a whole number of cents greater than zero.';
  }
  const conditions = (terms.acceptanceConditions ?? []).map((one) => one.trim()).filter(Boolean);
  if (conditions.length === 0) {
    return (
      'State at least one acceptance condition — what the buyer has to see for the work to be ' +
      'accepted. Without one, delivered work cannot be checked against anything.'
    );
  }
  if (new Set(conditions).size !== conditions.length) return 'Each acceptance condition once.';
  if (!terms.deliveryPlan?.trim()) return 'Say how the work will be produced and delivered.';
  if (!isOneOf(DELIVERY_ROUTES, terms.deliveryRoute)) {
    return `The delivery route is one of: ${DELIVERY_ROUTES.join(', ')}.`;
  }
  return null;
}

function clean(terms: Terms) {
  return {
    buyer: terms.buyer.trim(),
    scope: terms.scope.trim(),
    priceCents: terms.priceCents,
    acceptanceConditions: terms.acceptanceConditions.map((one) => one.trim()).filter(Boolean),
    deliveryPlan: terms.deliveryPlan.trim(),
    deliveryRoute: terms.deliveryRoute as DeliveryRoute,
    requiredResources: (terms.requiredResources ?? []).map((one) => one.trim()).filter(Boolean),
  };
}

/** Prepare an offer. Contacts nobody and spends nothing. */
export async function prepareOffer(input: {
  projectId: string;
  opportunityId: string;
  ownerUserId: string;
  testId?: string | null;
  terms: Terms;
  actorRef: string;
}): Promise<Outcome<CashObligation>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) {
    return refuse('No opportunity with that id.');
  }
  const bad = checkTerms(input.terms);
  if (bad) return refuse(bad);
  const competing = await competitionFor(opportunity, input.ownerUserId);
  if (competing) return refuse(competing);
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  const terms = clean(input.terms);
  const obligation = await createObligation({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    testId: input.testId ?? null,
    agreementResponseId: null,
    ownerUserId: input.ownerUserId,
    ...terms,
    currency: mode.currency,
    state: 'OFFER_PREPARED',
    nextStep: `Send the offer to ${terms.buyer}, and record where it was sent.`,
    nextStepOwner: 'PERSON',
    nextStepDue: null,
  });
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OFFER_PREPARED',
    actorRef: input.actorRef,
    summary: `An offer to ${terms.buyer} was prepared. Nothing has been sent.`,
    detail: { obligationId: obligation.id, priceCents: terms.priceCents },
  });
  return { ok: true, value: obligation, message: 'Prepared. Nothing has been sent.' };
}

/**
 * The offer went out. Authorized as `CONTACT_BUYER`, and the opportunity starts
 * executing on the strength of that recorded action where its card allows.
 */
export async function sendOffer(input: {
  obligationId: string;
  projectId: string;
  reference: string;
  actorRef: string;
  performedBy?: 'PERSON' | 'BRAIN';
  followUpDays?: number;
}): Promise<Outcome<CashObligation>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  if (obligation.state !== 'OFFER_PREPARED') {
    return refuse(`This is ${obligation.state.toLowerCase()}; only a prepared offer can be sent.`);
  }
  if (!input.reference?.trim()) {
    return refuse('Record where the offer was sent — a message id, a URL or a thread.');
  }
  const decision = await checkCommercialAuthority({ projectId: obligation.projectId, action: 'CONTACT_BUYER' });
  if (!decision.ok || !decision.authority) {
    return refuse(`Sending an offer needs CONTACT_BUYER under a standing commercial authority, and ${decision.reason}.`);
  }
  const action = await recordAction({
    projectId: obligation.projectId,
    opportunityId: obligation.opportunityId,
    authorityId: decision.authority.id,
    action: 'CONTACT_BUYER',
    performedBy: input.performedBy ?? 'PERSON',
    reference: input.reference.trim(),
    detail: `Offer ${obligation.id} sent to ${obligation.buyer}.`,
    confirmedBy: input.actorRef,
    requestKey: `offer-sent:${obligation.id}`,
  });
  const at = commerceNow();
  const moved = await transitionObligation({
    id: obligation.id,
    from: ['OFFER_PREPARED'],
    to: 'OFFER_SENT',
    actorRef: input.actorRef,
    kind: 'OFFER_SENT',
    evidence: { actionId: action.action.id, reference: input.reference.trim() },
    patch: {
      offer_action_id: action.action.id,
      sent_at: at,
      next_step: `Wait for ${obligation.buyer} to answer; follow up if nothing arrives.`,
      next_step_owner: 'BUYER',
      next_step_due: addDays(at, input.followUpDays ?? 3),
    },
  });
  if (!moved) return refuse('The offer moved while this was being recorded; read it again.');
  await startExecutionIfReady(obligation, input.actorRef);
  return { ok: true, value: (await getObligation(obligation.id))!, message: 'Recorded as sent. This is not a sale.' };
}

/**
 * The opportunity begins executing on the recorded action, if its card allows.
 * Never required: a refusal here is reported by the briefing, not hidden.
 */
async function startExecutionIfReady(obligation: CashObligation, actorRef: string): Promise<void> {
  const opportunity = await getOpportunity(obligation.opportunityId);
  if (opportunity?.state === 'READY') {
    await beginExecution({ opportunityId: opportunity.id, actorRef });
  }
}

/**
 * The buyer agreed. From a demand-test response or an answer to a sent offer.
 *
 * The agreement is the buyer's own recorded `AGREED_TO_BUY` response, and the
 * price becomes pipeline in the ledger — `PIPELINE_AGREED`, which no figure
 * ever adds to cash.
 */
export async function recordAgreement(input: {
  projectId: string;
  responseId: string;
  ownerUserId: string;
  /** Required when there is no sent offer to take the terms from. */
  terms?: Terms;
  obligationId?: string | null;
  actorRef: string;
}): Promise<Outcome<CashObligation>> {
  const response = await getResponse(input.responseId);
  if (!response || response.projectId !== input.projectId) return refuse('No response with that id.');
  if (response.kind !== 'AGREED_TO_BUY') {
    return refuse(
      `That response is ${response.kind}. Only the buyer agreeing to buy makes an obligation ` +
        'agreed; interest, questions and promises are recorded as what they are.',
    );
  }
  const already = await obligationForAgreement(response.id);
  if (already) return { ok: true, value: already, message: 'This agreement is already recorded.' };

  const at = commerceNow();
  let obligation: CashObligation | null;
  if (input.obligationId) {
    const current = await getObligation(input.obligationId);
    if (!current || current.projectId !== input.projectId || current.opportunityId !== response.opportunityId) {
      return refuse('No obligation with that id.');
    }
    const moved = await transitionObligation({
      id: current.id,
      from: ['OFFER_SENT'],
      to: 'AGREED',
      actorRef: input.actorRef,
      kind: 'AGREED',
      evidence: { responseId: response.id, reference: response.reference, excerpt: response.excerpt },
      patch: {
        agreement_response_id: response.id,
        agreed_at: at,
        next_step: 'Start production on the agreed scope.',
        next_step_owner: current.deliveryRoute === 'HUMAN' ? 'PERSON' : current.deliveryRoute === 'VENDOR' ? 'VENDOR' : 'BRAIN',
        next_step_due: null,
      },
    });
    if (!moved) return refuse(`This offer is ${current.state.toLowerCase()}; only a sent offer can be agreed.`);
    obligation = await getObligation(current.id);
  } else {
    if (!input.terms) return refuse('An agreement without a sent offer needs its terms.');
    const bad = checkTerms(input.terms);
    if (bad) return refuse(bad);
    const opportunity = await getOpportunity(response.opportunityId);
    if (!opportunity) return refuse('No opportunity with that id.');
    const competing = await competitionFor(opportunity, input.ownerUserId);
    if (competing) return refuse(competing);
    const mode = await getCashMode(input.projectId);
    if (!mode) return refuse('Cash Mode has not been activated for this project.');
    const terms = clean(input.terms);
    const made = await createObligation({
      projectId: input.projectId,
      opportunityId: response.opportunityId,
      testId: response.testId,
      agreementResponseId: response.id,
      ownerUserId: input.ownerUserId,
      ...terms,
      currency: mode.currency,
      state: 'AGREED',
      nextStep: 'Start production on the agreed scope.',
      nextStepOwner: terms.deliveryRoute === 'HUMAN' ? 'PERSON' : terms.deliveryRoute === 'VENDOR' ? 'VENDOR' : 'BRAIN',
      nextStepDue: null,
    });
    await noteObligation({
      obligation: made,
      kind: 'AGREED',
      actorRef: input.actorRef,
      evidence: { responseId: response.id, reference: response.reference, excerpt: response.excerpt },
    });
    obligation = made;
  }
  const agreed = obligation!;
  await recordAgreedTermsOnCard(agreed, response.receivedAt, response.excerpt);
  await recordMoneyEvent({
    projectId: agreed.projectId,
    opportunityId: agreed.opportunityId,
    kind: 'PIPELINE_AGREED',
    amountCents: agreed.priceCents,
    currency: agreed.currency,
    idempotencyKey: `pipeline:${agreed.id}`,
    note: `Agreed by ${agreed.buyer}; pipeline until paid.`,
    actorRef: input.actorRef,
  });
  await recordCashEvent({
    projectId: agreed.projectId,
    opportunityId: agreed.opportunityId,
    kind: 'CASH_OBLIGATION_AGREED',
    actorRef: input.actorRef,
    summary: `${agreed.buyer} agreed to buy. This is pipeline, not revenue.`,
    detail: { obligationId: agreed.id, responseId: response.id },
  });
  await startExecutionIfReady(agreed, input.actorRef);
  return { ok: true, value: agreed, message: 'Agreed. Counted as pipeline until the buyer pays.' };
}

/**
 * What the buyer agreed to fills the card's blanks, and only its blanks.
 *
 * These are no longer questions for research: who pays, what they bought,
 * what counts as done and the price are the buyer's own recorded words. A
 * value somebody already recorded is never overwritten — a correction is a
 * person's to make — and nothing here invents a field the agreement does not
 * state.
 */
async function recordAgreedTermsOnCard(
  obligation: CashObligation,
  agreedAt: string,
  excerpt: string,
): Promise<void> {
  const opportunity = await getOpportunity(obligation.opportunityId);
  if (!opportunity) return;
  await updateOpportunity(opportunity.id, {
    payer: opportunity.payer ?? obligation.buyer,
    offer_scope: opportunity.offerScope ?? obligation.scope,
    acceptance_condition: opportunity.acceptanceCondition ?? obligation.acceptanceConditions.join('; '),
    price_cents: opportunity.priceCents ?? obligation.priceCents,
    buying_signal: opportunity.buyingSignal ?? `${obligation.buyer} agreed to buy: "${excerpt}"`,
    signal_observed_at: opportunity.signalObservedAt ?? agreedAt,
    delivery_method: opportunity.deliveryMethod ?? obligation.deliveryPlan,
  });
}

/** Production begins on the named route. */
export async function startProduction(input: {
  obligationId: string;
  projectId: string;
  productionReference: string;
  actorRef: string;
}): Promise<Outcome<CashObligation>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  if (!input.productionReference?.trim()) {
    return refuse(
      'Name where the work is being produced: a change request, a document, the person doing ' +
        'it, or the vendor engagement.',
    );
  }
  if (obligation.deliveryRoute === 'VENDOR') {
    const decision = await checkCommercialAuthority({ projectId: obligation.projectId, action: 'ENGAGE_CONTRACTOR' });
    if (!decision.ok) {
      return refuse(`Engaging a vendor needs ENGAGE_CONTRACTOR under the standing authority, and ${decision.reason}.`);
    }
  }
  const moved = await transitionObligation({
    id: obligation.id,
    from: ['AGREED', 'REVISION_REQUESTED'],
    to: 'IN_PRODUCTION',
    actorRef: input.actorRef,
    kind: obligation.state === 'REVISION_REQUESTED' ? 'REVISION_STARTED' : 'PRODUCTION_STARTED',
    evidence: { productionReference: input.productionReference.trim(), route: obligation.deliveryRoute },
    patch: {
      production_reference: input.productionReference.trim(),
      next_step: 'Deliver the work and check it against every acceptance condition.',
      next_step_owner: obligation.deliveryRoute === 'HUMAN' ? 'PERSON' : obligation.deliveryRoute === 'VENDOR' ? 'VENDOR' : 'BRAIN',
    },
  });
  if (!moved) {
    return refuse(`This is ${obligation.state.toLowerCase()}; production starts only once the buyer has agreed.`);
  }
  const opportunity = await getOpportunity(obligation.opportunityId);
  if (opportunity && ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING'].includes(opportunity.state)) {
    await advance({ opportunityId: opportunity.id, to: 'DELIVERING', actorRef: input.actorRef });
  }
  return { ok: true, value: (await getObligation(obligation.id))!, message: 'In production.' };
}

export interface QualityCheck {
  condition: string;
  met: boolean;
  evidence: string;
}

/**
 * The work was delivered, and checked against the buyer's own terms first.
 *
 * Every acceptance condition must have a check, met, with evidence. A missing,
 * unmet or unevidenced one refuses the delivery and names it.
 */
export async function deliver(input: {
  obligationId: string;
  projectId: string;
  deliverableReference: string;
  checks: QualityCheck[];
  actorRef: string;
  acceptanceDays?: number;
}): Promise<Outcome<CashObligation>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  if (obligation.state !== 'IN_PRODUCTION') {
    return refuse(`This is ${obligation.state.toLowerCase()}; only work in production can be delivered.`);
  }
  if (!input.deliverableReference?.trim()) return refuse('Name the delivered artifact and where the buyer received it.');
  const byCondition = new Map((input.checks ?? []).map((one) => [one.condition?.trim(), one]));
  const failing: string[] = [];
  for (const condition of obligation.acceptanceConditions) {
    const check = byCondition.get(condition);
    if (!check) failing.push(`"${condition}" has no recorded check`);
    else if (!check.met) failing.push(`"${condition}" is not met`);
    else if (!check.evidence?.trim()) failing.push(`"${condition}" has no evidence`);
  }
  if (failing.length > 0) {
    return refuse(`Not delivered: ${failing.join('; ')}. Work is checked against the buyer's terms before it goes out.`);
  }
  const at = commerceNow();
  const moved = await transitionObligation({
    id: obligation.id,
    from: ['IN_PRODUCTION'],
    to: 'DELIVERED',
    actorRef: input.actorRef,
    kind: 'DELIVERED',
    evidence: { deliverableReference: input.deliverableReference.trim(), checks: input.checks },
    patch: {
      deliverable_reference: input.deliverableReference.trim(),
      delivered_at: at,
      next_step: `Wait for ${obligation.buyer} to accept or ask for changes. Delivered is not accepted.`,
      next_step_owner: 'BUYER',
      next_step_due: addDays(at, input.acceptanceDays ?? 5),
    },
  });
  if (!moved) return refuse('The obligation moved while this was being recorded; read it again.');
  return { ok: true, value: (await getObligation(obligation.id))!, message: 'Delivered, and waiting for the buyer.' };
}

const ANSWER_MOVES: Partial<Record<string, { from: ObligationState[]; to: ObligationState; kind: string }>> = {
  DECLINED: { from: ['OFFER_PREPARED', 'OFFER_SENT'], to: 'LOST', kind: 'BUYER_DECLINED' },
  REVISION_REQUESTED: { from: ['DELIVERED'], to: 'REVISION_REQUESTED', kind: 'REVISION_REQUESTED' },
  REJECTED_DELIVERY: { from: ['DELIVERED'], to: 'REVISION_REQUESTED', kind: 'DELIVERY_REJECTED' },
  ACCEPTED_DELIVERY: { from: ['DELIVERED'], to: 'ACCEPTED', kind: 'ACCEPTED' },
};

/**
 * Something the buyer said about this obligation.
 *
 * Recorded verbatim first. Agreement goes through `recordAgreement`; a decline,
 * a revision request, a rejection and an acceptance move the obligation; a
 * question, an objection and a payment promise are notes that set the next
 * step. A promise to pay changes no figure.
 */
export async function recordObligationAnswer(input: {
  obligationId: string;
  projectId: string;
  kind: string;
  channel: string;
  reference: string;
  excerpt: string;
  receivedAt?: string;
  actorRef: string;
}): Promise<Outcome<CashObligation>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  const written = await recordBuyerResponse({
    projectId: obligation.projectId,
    opportunityId: obligation.opportunityId,
    testId: obligation.testId,
    obligationId: obligation.id,
    respondent: obligation.buyer,
    kind: input.kind,
    channel: input.channel,
    reference: input.reference,
    excerpt: input.excerpt,
    receivedAt: input.receivedAt,
    actorRef: input.actorRef,
  });
  if (!written.ok) return written;
  const response = written.value;
  if (response.kind === 'AGREED_TO_BUY') {
    return recordAgreement({
      projectId: obligation.projectId,
      responseId: response.id,
      ownerUserId: obligation.ownerUserId,
      obligationId: obligation.id,
      actorRef: input.actorRef,
    });
  }
  const move = ANSWER_MOVES[response.kind];
  const evidence = { responseId: response.id, reference: response.reference, excerpt: response.excerpt };
  const at = commerceNow();
  if (move) {
    const patch =
      move.to === 'ACCEPTED'
        ? {
            accepted_at: at,
            next_step: 'Invoice the buyer for the agreed price, if not already invoiced.',
            next_step_owner: 'PERSON' as const,
            next_step_due: null,
          }
        : move.to === 'REVISION_REQUESTED'
          ? {
              revision_count: obligation.revisionCount + 1,
              next_step: 'Revise the work against what the buyer asked, then deliver again.',
              next_step_owner: (obligation.deliveryRoute === 'HUMAN' ? 'PERSON' : 'BRAIN') as 'PERSON' | 'BRAIN',
              next_step_due: null,
            }
          : {
              closed_at: at,
              close_reason: `The buyer declined: ${response.excerpt}`,
              next_step: 'Nothing: the buyer declined. Record what it taught.',
              next_step_owner: 'BRAIN' as const,
              next_step_due: null,
            };
    const moved = await transitionObligation({
      id: obligation.id,
      from: move.from,
      to: move.to,
      actorRef: input.actorRef,
      kind: move.kind,
      evidence,
      patch,
    });
    if (!moved) {
      return refuse(
        `The response is recorded, and it does not move an obligation that is ${obligation.state.toLowerCase()}.`,
      );
    }
    if (move.to === 'ACCEPTED') await closeIfSettled(obligation.id, input.actorRef);
    return { ok: true, value: (await getObligation(obligation.id))!, message: `Recorded: ${move.kind}.` };
  }
  const nextStep =
    response.kind === 'PAYMENT_PROMISED'
      ? { step: `${obligation.buyer} said they will pay. Nothing is collected until the provider reports it.`, owner: 'BUYER' as const, due: addDays(at, 5) }
      : { step: `Answer ${obligation.buyer}'s ${response.kind.toLowerCase()}.`, owner: 'PERSON' as const, due: addDays(at, 1) };
  await noteObligation({ obligation, kind: response.kind, actorRef: input.actorRef, evidence, nextStep });
  return { ok: true, value: (await getObligation(obligation.id))!, message: 'Recorded.' };
}

export async function cancelObligation(input: {
  obligationId: string;
  projectId: string;
  reason: string;
  actorRef: string;
}): Promise<Outcome<CashObligation>> {
  const obligation = await getObligation(input.obligationId);
  if (!obligation || obligation.projectId !== input.projectId) return refuse('No obligation with that id.');
  if (!input.reason?.trim()) return refuse('Say why it is cancelled.');
  const moved = await transitionObligation({
    id: obligation.id,
    from: ['OFFER_PREPARED', 'OFFER_SENT', 'AGREED', 'IN_PRODUCTION', 'DELIVERED', 'REVISION_REQUESTED'],
    to: 'CANCELLED',
    actorRef: input.actorRef,
    kind: 'CANCELLED',
    evidence: { reason: input.reason.trim() },
    patch: {
      closed_at: commerceNow(),
      close_reason: input.reason.trim(),
      next_step: 'Nothing: cancelled.',
      next_step_owner: 'BRAIN',
      next_step_due: null,
    },
  });
  if (!moved) return refuse(`This is ${obligation.state.toLowerCase()} and cannot be cancelled.`);
  return { ok: true, value: (await getObligation(obligation.id))!, message: 'Cancelled.' };
}

/**
 * Close an accepted obligation once settled funds cover its price.
 *
 * Imported lazily from `payment.ts`'s reading so the two modules do not form a
 * load-order cycle; the rule itself is one sentence: accepted and paid in full
 * to the account, not promised and not merely charged.
 */
export async function closeIfSettled(obligationId: string, actorRef: string): Promise<boolean> {
  const { settledCentsFor } = await import('./payment.ts');
  const obligation = await getObligation(obligationId);
  if (!obligation || obligation.state !== 'ACCEPTED') return false;
  const settled = await settledCentsFor(obligation);
  if (settled < obligation.priceCents) return false;
  const moved = await transitionObligation({
    id: obligation.id,
    from: ['ACCEPTED'],
    to: 'CLOSED',
    actorRef,
    kind: 'CLOSED',
    evidence: { settledCents: settled },
    patch: {
      closed_at: commerceNow(),
      close_reason: 'Accepted by the buyer and settled in full.',
      next_step: 'Follow up for repeat work or support, if the buyer wants it.',
      next_step_owner: 'PERSON',
      next_step_due: addDays(commerceNow(), 14),
    },
  });
  if (moved) {
    await recordCashEvent({
      projectId: obligation.projectId,
      opportunityId: obligation.opportunityId,
      kind: 'CASH_OBLIGATION_CLOSED',
      actorRef,
      summary: `Closed: ${obligation.buyer} accepted and the money settled.`,
      detail: { obligationId: obligation.id, settledCents: settled },
    });
  }
  return moved;
}
