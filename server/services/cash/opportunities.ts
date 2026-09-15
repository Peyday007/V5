/**
 * The producer, and every transition an opportunity has.
 *
 * This is the module Appendix C calls "the new cash producer", and the cash
 * mode's lifecycle is checked here — at the one place a new piece of work comes
 * into existence — rather than being inferred from a flag somewhere downstream.
 *
 * Three rules run through all of it.
 *
 * **Discovery is gated; everything else is not.** Creating an opportunity needs
 * an ACTIVE mode. Filling in a card, executing, delivering, collecting,
 * recording money, raising a need and settling one work in every state,
 * including archived, because a customer's obligation does not end when a
 * sprint does.
 *
 * **Money needs a person's grant, and reading never does.** Every state that
 * costs something — executing, committing, accepting a payment — is checked
 * against `checkCommercialAuthority`, which is a row a person wrote. Nothing
 * here can widen it and nothing here creates one.
 *
 * **An unknown is never a yes.** `EXECUTING` is refused while the card has a
 * load-bearing blank, because starting a transaction whose payer or delivery
 * path nobody has established is how a sprint spends its allowance learning
 * what an evidence card would have said for nothing.
 */
import {
  createOpportunity,
  getOpportunity,
  listOpportunities,
  markExhausted,
  transitionOpportunity,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import {
  commit as commitCents,
  getCommitment,
  liveAuthority,
  settleCommitment,
} from '../../repos/cashAuthority.ts';
import { getDb } from '../../db/database.ts';
import { recordMoney } from '../../repos/cashLedger.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { checkCommercialAuthority } from './authority.ts';
import { evidenceCard } from './card.ts';
import { discoveryAllowed } from './lifecycle.ts';
import { cashPosition, checkMoneyEntry } from './money.ts';
import { toJson } from '../../repos/util.ts';
import type {
  CashCommitment,
  CashMechanism,
  CashMoneyEntry,
  CashMoneyKind,
  CashOpportunity,
} from '../../domain/types.ts';
import { CASH_MECHANISMS } from '../../domain/types.ts';

export type Refusal = { ok: false; reason: string };
export type Accepted<T> = { ok: true; value: T; message: string };
export type Outcome<T> = Accepted<T> | Refusal;

function refuse(reason: string): Refusal {
  return { ok: false, reason };
}

export function isMechanism(value: unknown): value is CashMechanism {
  return typeof value === 'string' && (CASH_MECHANISMS as readonly string[]).includes(value);
}

/**
 * Bring a new piece into the portfolio.
 *
 * The one call the sprint's lifecycle gates. Everything about the opening —
 * which industry, which model, whether it could ever recur — is deliberately
 * unconstrained: the mandate is broad discovery and a producer that refused a
 * mechanism for being finite, or for not fitting an existing asset, would be
 * the invented preference the plan spends a section forbidding.
 */
export async function capture(input: {
  projectId: string;
  actorRef: string;
  ownerUserId: string;
  title: string;
  mechanism: string;
  currency: string;
  industry?: string | null;
  source?: string | null;
  candidateId?: string | null;
  externalRecordId?: string | null;
  expiresAt?: string | null;
  expiryReason?: string | null;
  dependsOnId?: string | null;
  duplicateOfId?: string | null;
  requiredCapabilities?: string[];
  executionAsset?: string | null;
  assetRevision?: string | null;
  nextAction?: string | null;
  stopRule?: string | null;
  reofferedFromId?: string | null;
}): Promise<Outcome<CashOpportunity>> {
  const title = input.title.trim();
  if (title.length < 4) return refuse('An opportunity needs a title somebody can recognise it by.');
  if (!isMechanism(input.mechanism)) {
    return refuse(
      `"${input.mechanism}" is not a mechanism this Brain records. Use OTHER rather than ` +
        'inventing one: the list is for grouping, and a bucket that refused an unlisted opening ' +
        'would narrow the search.',
    );
  }

  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return refuse(gate.reason);

  if (input.dependsOnId) {
    const parent = await getOpportunity(input.dependsOnId);
    if (!parent || parent.projectId !== input.projectId) {
      return refuse('The opportunity this depends on is not in this portfolio.');
    }
  }

  const opportunity = await createOpportunity({
    projectId: input.projectId,
    cashModeId: gate.mode.id,
    ownerUserId: input.ownerUserId,
    title,
    mechanism: input.mechanism,
    currency: input.currency,
    industry: input.industry ?? null,
    source: input.source ?? null,
    candidateId: input.candidateId ?? null,
    externalRecordId: input.externalRecordId ?? null,
    expiresAt: input.expiresAt ?? null,
    expiryReason: input.expiryReason ?? null,
    dependsOnId: input.dependsOnId ?? null,
    duplicateOfId: input.duplicateOfId ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    executionAsset: input.executionAsset ?? null,
    assetRevision: input.assetRevision ?? null,
    nextAction: input.nextAction ?? null,
    stopRule: input.stopRule ?? null,
    reofferedFromId: input.reofferedFromId ?? null,
  });

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OPPORTUNITY_CAPTURED',
    actorRef: input.actorRef,
    summary: `Captured "${title}".`,
    detail: { mechanism: input.mechanism, source: input.source ?? null },
  });

  return {
    ok: true,
    value: opportunity,
    message: 'Captured. Nothing has been spent and nobody has been contacted.',
  };
}

/**
 * Fill in the evidence card.
 *
 * Not gated by the lifecycle: a wound-down sprint still has to be able to
 * finish what it started, and answering a question about a live deal is not
 * new discovery.
 */
export async function fillCard(input: {
  opportunityId: string;
  actorRef: string;
  patch: Record<string, unknown>;
}): Promise<Outcome<CashOpportunity>> {
  const before = await getOpportunity(input.opportunityId);
  if (!before) return refuse('No opportunity with that id.');

  const patch: Record<string, unknown> = {};
  const text = (key: string, column: string): void => {
    if (!(key in input.patch)) return;
    const value = input.patch[key];
    if (value === null) {
      patch[column] = null;
      return;
    }
    if (typeof value !== 'string') return;
    patch[column] = value.trim() === '' ? null : value.trim();
  };
  const cents = (key: string, column: string): string | null => {
    if (!(key in input.patch)) return null;
    const value = input.patch[key];
    if (value === null) {
      patch[column] = null;
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) {
      return `${key} is a whole number of cents, or null for "not known".`;
    }
    if (value < 0) return `${key} cannot be negative.`;
    patch[column] = value;
    return null;
  };

  text('payer', 'payer');
  text('reachableChannel', 'reachable_channel');
  text('buyingSignal', 'buying_signal');
  text('signalObservedAt', 'signal_observed_at');
  text('offerScope', 'offer_scope');
  text('acceptanceCondition', 'acceptance_condition');
  text('paymentTerms', 'payment_terms');
  text('fulfillmentOwner', 'fulfillment_owner');
  text('deliveryMethod', 'delivery_method');
  text('requiredInputs', 'required_inputs');
  text('deadline', 'deadline');
  text('economicsNote', 'economics_note');
  text('expiresAt', 'expires_at');
  text('expiryReason', 'expiry_reason');
  text('nextAction', 'next_action');
  text('nextActionDue', 'next_action_due');
  text('stopRule', 'stop_rule');
  text('industry', 'industry');
  text('source', 'source');
  text('executionAsset', 'execution_asset');
  text('assetRevision', 'asset_revision');

  for (const problem of [cents('priceCents', 'price_cents'), cents('peakFundingCents', 'peak_funding_cents')]) {
    if (problem) return refuse(problem);
  }
  if ('humanHours' in input.patch) {
    const value = input.patch['humanHours'];
    if (value === null) patch['human_hours'] = null;
    else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return refuse('humanHours is a number of hours, or null for "not known".');
    } else patch['human_hours'] = value;
  }
  if ('requiredCapabilities' in input.patch) {
    const value = input.patch['requiredCapabilities'];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return refuse('requiredCapabilities is a list of capability names.');
    }
    patch['required_capabilities'] = toJson(value);
  }

  if (Object.keys(patch).length === 0) {
    return refuse('Nothing in that changes the card.');
  }

  const after = await updateOpportunity(input.opportunityId, patch);
  if (!after) return refuse('No opportunity with that id.');

  // The card becoming complete is itself a state change worth recording, and it
  // is the only automatic one: DISCOVERED to EVIDENCE_CARD costs nothing, says
  // nothing about the world, and is derived from the row rather than asserted.
  const card = evidenceCard(after);
  if (card.readiness.ready && after.state === 'DISCOVERED') {
    await transitionOpportunity({
      id: after.id,
      from: ['DISCOVERED'],
      to: 'EVIDENCE_CARD',
    });
  }

  await recordCashEvent({
    projectId: after.projectId,
    opportunityId: after.id,
    kind: 'CASH_CARD_UPDATED',
    actorRef: input.actorRef,
    summary: card.readiness.summary,
    detail: { fields: Object.keys(patch), missing: card.readiness.missing },
  });

  const reread = await getOpportunity(after.id);
  return {
    ok: true,
    value: reread ?? after,
    message: card.readiness.summary,
  };
}

/**
 * Declare a card credible enough to test.
 *
 * Deliberately a person's or a worker's *assertion* that the card is complete,
 * checked against the card rather than taken. `readyToTest` is the whole check,
 * and it is a pure function over the row, so the answer does not depend on who
 * asked.
 */
export async function markReady(input: {
  opportunityId: string;
  actorRef: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const card = evidenceCard(opportunity);
  if (!card.readiness.ready) return refuse(card.readiness.summary);

  const moved = await transitionOpportunity({
    id: opportunity.id,
    from: ['DISCOVERED', 'EVIDENCE_CARD'],
    to: 'READY',
  });
  if (!moved) {
    return refuse(`This is ${opportunity.state.toLowerCase()}, which is past being marked ready.`);
  }
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OPPORTUNITY_READY',
    actorRef: input.actorRef,
    summary: 'The card is complete and this is ready to test.',
  });
  const after = await getOpportunity(opportunity.id);
  return { ok: true, value: after!, message: card.readiness.summary };
}

/**
 * Start executing.
 *
 * Four questions, in this order, and the order matters: the card first because
 * it costs nothing to ask, the authority second because it is the decision, the
 * capacity third, and the money last because it is the only one that depends on
 * every entry in the ledger.
 */
export async function beginExecution(input: {
  opportunityId: string;
  actorRef: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');

  const card = evidenceCard(opportunity);
  if (!card.readiness.ready) return refuse(card.readiness.summary);

  const decision = await checkCommercialAuthority({
    projectId: opportunity.projectId,
    action: 'CONTACT_BUYER',
  });
  if (!decision.ok || !decision.authority) {
    return refuse(
      `Executing means reaching the buyer, and ${decision.reason}. That is a decision for the ` +
        'person whose account this is; nothing else is blocked by it.',
    );
  }

  const inFlight = (
    await listOpportunities({ projectId: opportunity.projectId, states: ['EXECUTING', 'DELIVERING'] })
  ).length;
  if (inFlight >= decision.authority.maxConcurrent) {
    return refuse(
      `${inFlight} of ${decision.authority.maxConcurrent} execution slots are taken. This waits ` +
        'on fulfilment capacity rather than on anything about the opportunity.',
    );
  }

  const position = await cashPosition({ projectId: opportunity.projectId });
  const needed = opportunity.peakFundingCents ?? 0;
  if (needed > position.deployableCents) {
    return refuse(
      `This needs ${needed} cents out before the money comes back, and ${position.deployableCents} ` +
        'cents are deployable. Settle something, release a commitment or add capital.',
    );
  }

  const moved = await transitionOpportunity({
    id: opportunity.id,
    from: ['READY'],
    to: 'EXECUTING',
  });
  if (!moved) {
    return refuse(`This is ${opportunity.state.toLowerCase()} rather than ready to execute.`);
  }
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_EXECUTION_STARTED',
    actorRef: input.actorRef,
    summary: 'Execution started under the standing commercial authority.',
    detail: { policyVersion: decision.policyVersion, peakFundingCents: needed },
  });
  const after = await getOpportunity(opportunity.id);
  return { ok: true, value: after!, message: 'Executing.' };
}

/** Delivery has begun, or the money is in. Neither costs anything to record. */
export async function advance(input: {
  opportunityId: string;
  to: 'DELIVERING' | 'COLLECTED';
  actorRef: string;
  outcome?: string | null;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const from = input.to === 'DELIVERING' ? (['EXECUTING'] as const) : (['EXECUTING', 'DELIVERING'] as const);
  const moved = await transitionOpportunity({
    id: opportunity.id,
    from: [...from],
    to: input.to,
    outcome: input.outcome ?? undefined,
  });
  if (!moved) {
    return refuse(
      `This is ${opportunity.state.toLowerCase()}, and ${input.to.toLowerCase()} does not follow it.`,
    );
  }
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: `CASH_${input.to}`,
    actorRef: input.actorRef,
    summary:
      input.to === 'DELIVERING'
        ? 'The obligation is being delivered.'
        : 'The money is in and the delivery is done.',
    detail: { outcome: input.outcome ?? null },
  });
  const after = await getOpportunity(opportunity.id);
  return { ok: true, value: after!, message: 'Recorded.' };
}

/**
 * This owner passes.
 *
 * Declining is not archiving: the opening may be perfectly good for somebody
 * else, and `reoffer` is the transition that says so. Both ends are recorded,
 * because nothing moves between private operations without a row naming who
 * moved it and why.
 */
export async function decline(input: {
  opportunityId: string;
  actorUserId: string;
  reason: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const reason = input.reason.trim();
  if (!reason) return refuse('Say why you are passing, so it can be offered to somebody else honestly.');

  const moved = await transitionOpportunity({
    id: opportunity.id,
    from: ['DISCOVERED', 'EVIDENCE_CARD', 'READY'],
    to: 'DECLINED',
    declinedByUserId: input.actorUserId,
    declinedReason: reason,
  });
  if (!moved) {
    return refuse(
      `This is ${opportunity.state.toLowerCase()}. Something already under way is stopped rather ` +
        'than declined, and the obligation stands either way.',
    );
  }
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OPPORTUNITY_DECLINED',
    actorRef: input.actorUserId,
    summary: 'This owner passed on the opportunity.',
    detail: { reason },
  });
  const after = await getOpportunity(opportunity.id);
  return { ok: true, value: after!, message: 'Passed. It can be offered privately to somebody else.' };
}

/**
 * Offer a declined opening to another person's operation.
 *
 * A **copy into the other project**, never a move: the original keeps its row,
 * its decline and its reason, because the first person's record of what they
 * were shown and what they decided is theirs. The copy carries only the opening
 * itself — the title, the mechanism, the source and the expiry — and none of
 * the first owner's card, because their payer notes and their quoted price are
 * their working, and private operations stay private.
 *
 * The destination must have an ACTIVE cash mode of its own: an opening cannot
 * be pushed into a sprint that is winding down, and a person who is not running
 * one is not handed work by somebody else's decision.
 */
export async function reoffer(input: {
  opportunityId: string;
  toProjectId: string;
  toOwnerUserId: string;
  actorUserId: string;
  reason: string;
}): Promise<Outcome<CashOpportunity>> {
  const original = await getOpportunity(input.opportunityId);
  if (!original) return refuse('No opportunity with that id.');
  if (original.state !== 'DECLINED') {
    return refuse('Only an opportunity somebody has passed on can be offered to somebody else.');
  }
  if (original.projectId === input.toProjectId) {
    return refuse('That is the operation it is already in.');
  }

  const captured = await capture({
    projectId: input.toProjectId,
    actorRef: input.actorUserId,
    ownerUserId: input.toOwnerUserId,
    title: original.title,
    mechanism: original.mechanism,
    currency: original.currency,
    industry: original.industry,
    source: original.source,
    expiresAt: original.expiresAt,
    expiryReason: original.expiryReason,
    reofferedFromId: original.id,
    nextAction: 'Establish the payer and the access for yourself; nothing about the first ' +
      "owner's card carries over.",
  });
  if (!captured.ok) return captured;

  await recordCashEvent({
    projectId: original.projectId,
    opportunityId: original.id,
    kind: 'CASH_OPPORTUNITY_REOFFERED',
    actorRef: input.actorUserId,
    summary: 'The opening was offered to another private operation.',
    detail: { reason: input.reason, toProjectId: input.toProjectId, copyId: captured.value.id },
  });

  return {
    ok: true,
    value: captured.value,
    message:
      'Offered. The original keeps its row and its reason, and none of the first owner’s card ' +
      'came with it.',
  };
}

/** The opening is finished, whatever the transaction did. */
export async function exhaust(input: {
  opportunityId: string;
  actorRef: string;
  reason: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const reason = input.reason.trim();
  if (!reason) return refuse('Record why the opening is finished, so the method is still reusable.');
  const marked = await markExhausted({ id: opportunity.id, reason });
  if (!marked) return refuse('This opening was already marked exhausted.');
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OPENING_EXHAUSTED',
    actorRef: input.actorRef,
    summary: 'The opening is finished. Whatever it paid is still a success.',
    detail: { reason },
  });
  const after = await getOpportunity(opportunity.id);
  return {
    ok: true,
    value: after!,
    message:
      'Marked exhausted. That is separate from what this earned: a completed profitable one-off ' +
      'stays a completed profitable one-off.',
  };
}

/** Stop pursuing this, with the reason on the row. */
export async function archiveOpportunity(input: {
  opportunityId: string;
  actorRef: string;
  reason: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');
  const reason = input.reason.trim();
  if (!reason) return refuse('Record the reason and the condition that would justify reopening it.');
  const moved = await transitionOpportunity({
    id: opportunity.id,
    from: ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING', 'COLLECTED', 'DECLINED'],
    to: 'ARCHIVED',
    archivedReason: reason,
  });
  if (!moved) return refuse('This is already archived.');
  await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_OPPORTUNITY_ARCHIVED',
    actorRef: input.actorRef,
    summary: 'Stopped, with the reason kept.',
    detail: { reason },
  });
  const after = await getOpportunity(opportunity.id);
  return { ok: true, value: after!, message: 'Archived. Agreed delivery obligations are unaffected.' };
}

/**
 * Hold part of the ceiling for a named obstacle.
 *
 * §6's sentence is the signature: spend $X to remove this named obstacle to
 * this transaction; expect this observable result; stop at this limit. All
 * three are required, because a commitment that names no obstacle is a budget
 * line and a budget line is what gets spent on a generic campaign.
 */
export async function commitSpend(input: {
  projectId: string;
  opportunityId?: string | null;
  action: string;
  amountCents: number;
  purpose: string;
  expectedResult: string;
  stopCondition: string;
  idempotencyKey: string;
  actorRef: string;
}): Promise<Outcome<CashCommitment>> {
  for (const [name, value] of [
    ['purpose', input.purpose],
    ['expectedResult', input.expectedResult],
    ['stopCondition', input.stopCondition],
  ] as const) {
    if (!value.trim()) {
      return refuse(
        `A commitment says what obstacle it removes, what result to expect and where to stop. ` +
          `"${name}" is empty.`,
      );
    }
  }

  const decision = await checkCommercialAuthority({
    projectId: input.projectId,
    action: input.action,
  });
  if (!decision.ok || !decision.authority) return refuse(decision.reason);

  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) {
      return refuse('No opportunity with that id.');
    }
  }

  /*
   * Does this fit the money?
   *
   * The gate used to ask whether deployable cash was *already* negative, which
   * fires one commitment after the one that did the damage: an account with
   * $100 could commit $400 under a $1,000 grant and be told about it next time.
   *
   * `deployableAfter` is evaluated **inside** `commit`'s transaction, after the
   * row is inserted, so what it reports already counts this commitment — a
   * negative answer is precisely "this does not fit", and no window exists in
   * which two callers both read the same room. It is a function rather than a
   * number for the same reason: a figure read out here would be read before the
   * insert and stale by the time it decided anything.
   *
   * A **replay** never reaches it. `commit` returns at the conflict, before any
   * ceiling is consulted, which is what keeps a retry reachable after the
   * original attempt is what made the account short — §20's rule that a retry
   * is not a second effect.
   */
  const outcome = await commitCents({
    authorityId: decision.authority.id,
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    amountCents: input.amountCents,
    currency: decision.authority.currency,
    purpose: input.purpose.trim(),
    expectedResult: input.expectedResult.trim(),
    stopCondition: input.stopCondition.trim(),
    idempotencyKey: input.idempotencyKey,
    createdBy: input.actorRef,
    deployableAfter: async () =>
      (
        await cashPosition({
          projectId: input.projectId,
          currency: decision.authority!.currency,
        })
      ).deployableCents,
  });
  if (!outcome.ok || !outcome.commitment) return refuse(outcome.reason);

  if (!outcome.replayed) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunityId ?? null,
      kind: 'CASH_COMMITTED',
      actorRef: input.actorRef,
      summary: `Committed ${input.amountCents} cents: ${input.purpose.trim()}`,
      detail: {
        action: input.action,
        amountCents: input.amountCents,
        policyVersion: decision.policyVersion,
        stopCondition: input.stopCondition.trim(),
      },
    });
  }
  return {
    ok: true,
    value: outcome.commitment,
    message: outcome.replayed ? 'This commitment already existed.' : 'Committed.',
  };
}

/**
 * Write one money event. Append-only, once per key, in the sprint's currency.
 *
 * Three things are checked before anything is written, and each exists because
 * its absence produced a wrong figure: the entry's own shape, the sprint's
 * currency, and — for a customer payment — the authority to accept one. The key
 * is what makes a retry a retry rather than a second $750.
 */
export async function recordMoneyEvent(input: {
  projectId: string;
  opportunityId?: string | null;
  commitmentId?: string | null;
  kind: CashMoneyKind;
  amountCents: number;
  currency: string;
  verifiedReference?: string | null;
  fundsAvailableAt?: string | null;
  occurredAt?: string;
  note?: string | null;
  idempotencyKey: string;
  actorRef: string;
}): Promise<Outcome<CashMoneyEntry>> {
  const check = checkMoneyEntry({
    kind: input.kind,
    amountCents: input.amountCents,
    verifiedReference: input.verifiedReference,
  });
  if (!check.ok) return refuse(check.reason);
  if (!input.idempotencyKey.trim()) {
    return refuse(
      'A money entry needs a key naming the operation, so that a retry is not a second one.',
    );
  }

  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  if (mode.currency !== input.currency) {
    return refuse(
      `This sprint keeps its money in ${mode.currency} and this entry is in ${input.currency}. ` +
        'Brain does not choose an exchange rate, and a figure that added the two would be a ' +
        'number nobody can use wearing a label that says it was checked.',
    );
  }

  if (input.kind === 'CUSTOMER_PAYMENT') {
    const decision = await checkCommercialAuthority({
      projectId: input.projectId,
      action: 'ACCEPT_PAYMENT',
    });
    if (!decision.ok) return refuse(decision.reason);
  }

  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) {
      return refuse('No opportunity with that id.');
    }
  }

  const written = await recordMoney({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    commitmentId: input.commitmentId ?? null,
    kind: input.kind,
    amountCents: input.amountCents,
    currency: input.currency,
    verifiedReference: input.verifiedReference ?? null,
    fundsAvailableAt: input.fundsAvailableAt ?? null,
    occurredAt: input.occurredAt,
    note: input.note ?? null,
    recordedBy: input.actorRef,
    idempotencyKey: input.idempotencyKey,
  });
  if (!written.ok || !written.entry) return refuse(written.reason);

  if (!written.replayed) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunityId ?? null,
      kind: 'CASH_MONEY_RECORDED',
      actorRef: input.actorRef,
      summary: `${input.kind} of ${input.amountCents} cents.`,
      detail: { kind: input.kind, amountCents: input.amountCents, entryId: written.entry.id },
    });
  }

  return {
    ok: true,
    value: written.entry,
    message: written.replayed ? 'This entry was already recorded.' : 'Recorded.',
  };
}

/**
 * The spend happened: the hold becomes history **and** the cost is recorded.
 *
 * These are one operation and were two, which is the defect this exists to
 * close. `settleCommitment` alone moved a row out of `HELD` and wrote nothing
 * else, so a $400 hold against $1,000 of capital took deployable cash from $600
 * back to $1,000 — the account was told it had the money it had just spent.
 *
 * Both writes are in one transaction, so there is no state in which the hold is
 * gone and the cost is missing. The cost's key is derived from the commitment
 * rather than supplied, so a retried settlement writes one cost.
 *
 * A partial spend is expressible rather than rounded: `spentCents` is what
 * actually left, the remainder stops being held, and settling for more than was
 * held is refused — more than was held is a new commitment, not this one.
 */
export async function settleSpend(input: {
  commitmentId: string;
  spentCents: number;
  actorRef: string;
  note?: string | null;
}): Promise<Outcome<CashCommitment>> {
  const commitment = await getCommitment(input.commitmentId);
  if (!commitment) return refuse('No commitment with that id.');
  if (commitment.state !== 'HELD') {
    return refuse(`That commitment is already ${commitment.state.toLowerCase()}.`);
  }
  const spent = Math.trunc(input.spentCents);
  if (!Number.isFinite(spent) || spent < 0) {
    return refuse('What was spent is a whole number of cents, and not negative.');
  }
  if (spent > commitment.amountCents) {
    return refuse(
      `This commitment held ${commitment.amountCents} cents and you are settling ${spent}. ` +
        'A settlement spends what was held or less; more than that is a new commitment.',
    );
  }

  const settled = await getDb().transaction(async () => {
    if (!(await settleCommitment(commitment.id, spent))) return false;
    if (spent > 0) {
      const written = await recordMoney({
        projectId: commitment.projectId,
        opportunityId: commitment.opportunityId,
        commitmentId: commitment.id,
        kind: 'COST',
        amountCents: spent,
        currency: commitment.currency,
        note: input.note ?? commitment.purpose,
        recordedBy: input.actorRef,
        // Derived from the commitment rather than supplied, so a retried
        // settlement can never write a second cost.
        idempotencyKey: `settle:${commitment.id}`,
      });
      if (!written.ok) {
        // The cost could not be written, so the hold must not be released
        // either. Abandoning the transaction is what keeps the two together.
        throw new Error(`the settlement cost could not be recorded: ${written.reason}`);
      }
    }
    return true;
  });
  if (!settled) return refuse(`That commitment is already ${commitment.state.toLowerCase()}.`);

  await recordCashEvent({
    projectId: commitment.projectId,
    opportunityId: commitment.opportunityId,
    kind: 'CASH_COMMITMENT_SETTLED',
    actorRef: input.actorRef,
    summary: `${spent} of ${commitment.amountCents} cents committed were spent.`,
    detail: { commitmentId: commitment.id, spentCents: spent, heldCents: commitment.amountCents },
  });

  const after = await getCommitment(commitment.id);
  return {
    ok: true,
    value: after!,
    message:
      spent === commitment.amountCents
        ? 'Settled. The money is out and the hold is history.'
        : `Settled at ${spent} cents. The unspent ${commitment.amountCents - spent} is deployable again.`,
  };
}

/** The grant in force, for a caller that needs its ceilings. */
export async function authorityFor(projectId: string) {
  const mode = await getCashMode(projectId);
  const authority = await liveAuthority(projectId);
  return { mode, authority };
}
