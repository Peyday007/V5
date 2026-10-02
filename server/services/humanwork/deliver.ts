/**
 * Steps 4 and 5: coordinating delivery, and deciding whether the result meets
 * the need.
 *
 * ---------------------------------------------------------------------------
 * An assigned task is not a delivered result
 * ---------------------------------------------------------------------------
 *
 * A result is accepted only when **every** acceptance condition reads MET, and
 * the three kinds of condition are judged three ways, none of them by the
 * worker's say-so:
 *
 *   DOCUMENT_READY      the latest deliverable is a registered document whose
 *                       current extraction Brain could read (§9) — a file on
 *                       disk is not something Brain has inspected
 *   ACCOUNT_FOUNDATION  a dimension of an account's foundation reads PASS,
 *                       re-read from rows on every evaluation
 *   PERSON_REVIEW       somebody other than the assignee judged it MET against
 *                       the latest deliverable round
 *
 * A NOT_MET judgement must name the repair. That is what makes "request a
 * specific repair" a row rather than a sentence somebody meant to send.
 */
import { getDocument } from '../../repos/documents.ts';
import { currentExtractionRunsFor } from '../../repos/extraction.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  addCost,
  addDeliverable,
  addReview,
  closeOrder,
  getEngagement,
  getOrder,
  listCosts,
  listDeliverables,
  listEngagements,
  listReviews,
  recordHumanWorkEvent,
  transitionEngagement,
} from '../../repos/humanWork.ts';
import { foundationReading } from '../identity/foundation.ts';
import { settleSpend } from '../cash/opportunities.ts';
import { getCommitment } from '../../repos/cashAuthority.ts';
import { money, type Checked } from './vocabulary.ts';
import type {
  AcceptanceCondition,
  HumanWorkDeliverable,
  HumanWorkEngagement,
  HumanWorkOrder,
  HumanWorkReview,
  ReviewVerdict,
} from '../../domain/types.ts';

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/** What a coordinator or the assignee may post while the work is under way. */
export const COORDINATION_KINDS = [
  'ACKNOWLEDGED',
  'MILESTONE',
  'QUESTION',
  'ANSWER',
  'CHANGE_REQUESTED',
  'HANDOFF',
  'ACCESS_GRANTED',
  'ACCESS_REVOKED',
  'NOTE',
] as const;
export type CoordinationKind = (typeof COORDINATION_KINDS)[number];

/** Which of those the assignee may post. Access is never theirs to record. */
const ASSIGNEE_KINDS: readonly CoordinationKind[] = ['ACKNOWLEDGED', 'MILESTONE', 'QUESTION', 'CHANGE_REQUESTED', 'HANDOFF', 'NOTE'];

export async function postUpdate(input: {
  engagementId: string;
  kind: string;
  text: string;
  as: 'ASSIGNEE' | 'PERSON';
  userId: string;
}): Promise<Checked<true>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (!(COORDINATION_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: `kind must be one of ${COORDINATION_KINDS.join(', ')}.` };
  }
  const kind = input.kind as CoordinationKind;
  if (input.as === 'ASSIGNEE' && !ASSIGNEE_KINDS.includes(kind)) {
    return { ok: false, reason: `${kind} is recorded by the coordinator, not by the person doing the work.` };
  }
  if (engagement.state !== 'ENGAGED') {
    return {
      ok: false,
      reason:
        engagement.state === 'INVITED'
          ? 'They have not accepted yet, so there is no work under way to report on.'
          : `That engagement is ${engagement.state.toLowerCase()}.`,
    };
  }
  const text = input.text.trim();
  if (!text) return { ok: false, reason: 'Say something.' };
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind,
    summary: text.slice(0, 2_000),
    actor: input.as,
    actorUserId: input.userId,
  });
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export async function submitDeliverable(input: {
  engagementId: string;
  description: string;
  documentId?: string | null;
  reference?: string | null;
  as: 'ASSIGNEE' | 'COORDINATOR';
  userId: string;
}): Promise<Checked<HumanWorkDeliverable>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (engagement.state !== 'ENGAGED') {
    return { ok: false, reason: 'A deliverable is handed in under an accepted engagement; this one is ' + engagement.state + '.' };
  }
  const description = input.description.trim();
  if (!description) return { ok: false, reason: 'Say what is being handed in.' };
  const documentId = (input.documentId ?? '').trim() || null;
  const reference = (input.reference ?? '').trim() || null;
  if (!documentId && !reference) {
    return { ok: false, reason: 'A deliverable is a registered document or a reference to where it is — not a sentence saying it is done.' };
  }
  if (documentId) {
    const document = await getDocument(documentId);
    if (!document || document.projectId !== engagement.projectId) {
      return { ok: false, reason: 'No document with that id in this project. Import it first; a file Brain has not registered is not a deliverable.' };
    }
  }
  const deliverable = await addDeliverable({
    projectId: engagement.projectId,
    engagementId: engagement.id,
    description,
    documentId,
    reference,
    submittedByUserId: input.userId,
    submittedAs: input.as,
  });
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: 'DELIVERABLE_SUBMITTED',
    summary: `Round ${deliverable.round} handed in: ${description}`,
    detail: { deliverableId: deliverable.id, documentId, reference },
    actor: input.as === 'ASSIGNEE' ? 'ASSIGNEE' : 'PERSON',
    actorUserId: input.userId,
  });
  return { ok: true, value: deliverable };
}

// ---------------------------------------------------------------------------
// Judging it
// ---------------------------------------------------------------------------

export interface ConditionReading {
  key: string;
  statement: string;
  check: AcceptanceCondition['check'];
  verdict: ReviewVerdict | 'NOT_JUDGED';
  /** The server's sentence on why. */
  because: string;
  repair: string | null;
  /** Who or what judged it: 'BRAIN' for a row reading, else a user id. */
  judgedBy: string | null;
}

async function documentReady(deliverable: HumanWorkDeliverable | null): Promise<{ met: boolean; because: string }> {
  if (!deliverable) return { met: false, because: 'Nothing has been handed in yet.' };
  if (!deliverable.documentId) {
    return { met: false, because: 'The latest round is a reference, not a registered document Brain can read.' };
  }
  const runs = await currentExtractionRunsFor([deliverable.documentId]);
  const run = runs.get(deliverable.documentId);
  if (!run) return { met: false, because: 'Brain has not read the document yet; there is no extraction run.' };
  if (run.status === 'READY' || run.status === 'READY_WITH_WARNINGS') {
    return { met: true, because: `Brain read the document (${run.status}).` };
  }
  return { met: false, because: `Brain could not read the document (${run.status}); an unread document is not evidence.` };
}

/**
 * Every condition, judged now.
 *
 * Row-read conditions are re-read on every call, so a condition that held
 * yesterday and does not today reads NOT_MET today. Person reviews count only
 * on the **latest** round, and never from the assignee.
 */
export async function evaluateAcceptance(
  order: HumanWorkOrder,
  engagement: HumanWorkEngagement | null,
): Promise<ConditionReading[]> {
  const deliverables = engagement ? await listDeliverables(engagement.id) : [];
  const latest = deliverables.at(-1) ?? null;
  const reviews = engagement ? await listReviews(engagement.id) : [];
  let foundation: Awaited<ReturnType<typeof foundationReading>> | null = null;

  const out: ConditionReading[] = [];
  for (const condition of order.acceptance) {
    const base = { key: condition.key, statement: condition.statement, check: condition.check };
    if (condition.check === 'DOCUMENT_READY') {
      const reading = await documentReady(latest);
      out.push({ ...base, verdict: reading.met ? 'MET' : latest ? 'NOT_MET' : 'NOT_JUDGED', because: reading.because, repair: null, judgedBy: 'BRAIN' });
      continue;
    }
    if (condition.check === 'ACCOUNT_FOUNDATION') {
      foundation ??= await foundationReading();
      const account = foundation.accounts.find((one) => one.userId === condition.userId);
      const finding = account?.findings.find((one) => one.dimension === condition.dimension);
      if (!finding) {
        out.push({ ...base, verdict: 'NOT_JUDGED', because: 'That account or dimension is not in the foundation reading.', repair: null, judgedBy: 'BRAIN' });
      } else {
        out.push({
          ...base,
          verdict: finding.verdict === 'PASS' ? 'MET' : 'NOT_MET',
          because: finding.because,
          repair: finding.verdict === 'PASS' ? null : finding.nextAction,
          judgedBy: 'BRAIN',
        });
      }
      continue;
    }
    // PERSON_REVIEW
    const judged = latest
      ? reviews
          .filter((review) => review.deliverableId === latest.id && review.criterionKey === condition.key)
          .filter((review) => review.reviewerUserId !== engagement?.assigneeUserId)
          .at(-1)
      : undefined;
    out.push({
      ...base,
      verdict: judged ? judged.verdict : 'NOT_JUDGED',
      because: judged
        ? judged.note
        : latest
          ? `Round ${latest.round} has not been reviewed against this condition.`
          : 'Nothing has been handed in yet.',
      repair: judged?.repair ?? null,
      judgedBy: judged?.reviewerUserId ?? null,
    });
  }
  return out;
}

export async function reviewCondition(input: {
  engagementId: string;
  criterionKey: string;
  verdict: ReviewVerdict;
  note: string;
  repair?: string | null;
  reviewerUserId: string;
}): Promise<Checked<HumanWorkReview>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  const order = await getOrder(engagement.orderId);
  if (!order) return { ok: false, reason: 'The work is gone.' };
  const condition = order.acceptance.find((one) => one.key === input.criterionKey);
  if (!condition) return { ok: false, reason: 'No acceptance condition with that key.' };
  if (condition.check !== 'PERSON_REVIEW') {
    return { ok: false, reason: 'Brain reads that condition from rows itself; a review cannot overrule it.' };
  }
  if (engagement.assigneeUserId && engagement.assigneeUserId === input.reviewerUserId) {
    return { ok: false, reason: 'The person who did the work cannot accept their own result.' };
  }
  if (!['MET', 'NOT_MET', 'CANNOT_VERIFY'].includes(input.verdict)) {
    return { ok: false, reason: 'verdict must be MET, NOT_MET or CANNOT_VERIFY.' };
  }
  const note = input.note.trim();
  if (!note) return { ok: false, reason: 'Say what the judgement rests on.' };
  const repair = (input.repair ?? '').trim() || null;
  if (input.verdict === 'NOT_MET' && !repair) {
    return { ok: false, reason: 'A condition that is not met needs the specific repair that would meet it.' };
  }
  const latest = (await listDeliverables(engagement.id)).at(-1);
  if (!latest) return { ok: false, reason: 'Nothing has been handed in to review.' };
  const review = await addReview({
    projectId: engagement.projectId,
    engagementId: engagement.id,
    deliverableId: latest.id,
    criterionKey: condition.key,
    verdict: input.verdict,
    note,
    repair,
    reviewerUserId: input.reviewerUserId,
  });
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: input.verdict === 'NOT_MET' ? 'REPAIR_REQUESTED' : 'CONDITION_REVIEWED',
    summary:
      input.verdict === 'NOT_MET'
        ? `Round ${latest.round} does not meet "${condition.statement}". Repair: ${repair}`
        : `Round ${latest.round}: "${condition.statement}" is ${input.verdict}. ${note}`,
    detail: { reviewId: review.id, deliverableId: latest.id, criterionKey: condition.key },
    actor: 'PERSON',
    actorUserId: input.reviewerUserId,
  });
  return { ok: true, value: review };
}

/**
 * Close the work as accepted.
 *
 * Refused unless every condition reads MET right now. `actor` is BRAIN only
 * when the kernel accepts a no-charge result whose conditions are all read
 * from rows — nothing a person could add to that judgement — and a person
 * otherwise. Outstanding payment is preserved rather than closed: accepting a
 * result is not paying for it.
 */
export async function acceptResult(input: {
  orderId: string;
  actor: 'BRAIN' | 'PERSON';
  userId: string | null;
  note?: string | null;
}): Promise<Checked<{ order: HumanWorkOrder; outstandingCents: number }>> {
  const order = await getOrder(input.orderId);
  if (!order || order.state !== 'OPEN') return { ok: false, reason: 'No open work order with that id.' };
  const engagement = (await listEngagements(order.id)).find((one) => one.state === 'ENGAGED');
  if (!engagement) return { ok: false, reason: 'Nobody is engaged on this work, so there is no result to accept.' };
  const readings = await evaluateAcceptance(order, engagement);
  const unmet = readings.filter((one) => one.verdict !== 'MET');
  if (unmet.length) {
    return {
      ok: false,
      reason: `Not every condition holds: ${unmet.map((one) => `"${one.statement}" — ${one.because}`).join('; ')}`,
    };
  }
  if (engagement.assigneeUserId && input.userId === engagement.assigneeUserId) {
    return { ok: false, reason: 'The person who did the work cannot accept their own result.' };
  }
  const at = new Date().toISOString();
  const moved = await transitionEngagement({ id: engagement.id, from: 'ENGAGED', to: 'COMPLETED', patch: { completed_at: at } });
  if (!moved) return { ok: false, reason: 'The engagement moved at the same moment.' };
  const note = (input.note ?? '').trim();
  await closeOrder({ id: order.id, to: 'ACCEPTED', reason: note || 'every acceptance condition held' });
  const obligations = await obligationsFor(engagement);
  await recordHumanWorkEvent({
    projectId: order.projectId,
    orderId: order.id,
    engagementId: engagement.id,
    kind: 'RESULT_ACCEPTED',
    summary:
      `Accepted: every condition held (${readings.map((one) => one.key).join(', ')}).` +
      (obligations.outstandingCents > 0
        ? ` ${money(obligations.outstandingCents, engagement.currency)} is still owed.`
        : ''),
    detail: { readings: readings.map((one) => ({ key: one.key, verdict: one.verdict, judgedBy: one.judgedBy })) },
    actor: input.actor,
    actorUserId: input.userId,
  });
  await recordEvent({
    projectId: order.projectId,
    entityType: 'human_work_order',
    entityId: order.id,
    eventType: 'HUMAN_WORK_RESULT_ACCEPTED',
    payload: { engagementId: engagement.id, acceptedBy: input.actor === 'BRAIN' ? 'BRAIN' : input.userId },
  });
  return { ok: true, value: { order: (await getOrder(order.id))!, outstandingCents: obligations.outstandingCents } };
}

export async function cancelWork(input: { orderId: string; reason: string; userId: string }): Promise<Checked<HumanWorkOrder>> {
  const order = await getOrder(input.orderId);
  if (!order || order.state !== 'OPEN') return { ok: false, reason: 'No open work order with that id.' };
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'Say why the work is being stopped.' };
  const live = (await listEngagements(order.id)).find((one) => ['PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED'].includes(one.state));
  if (live) {
    const { withdrawEngagement } = await import('./engage.ts');
    const withdrawn = await withdrawEngagement({ engagementId: live.id, reason, actorRef: input.userId });
    if (!withdrawn.ok) return withdrawn;
  }
  await closeOrder({ id: order.id, to: 'CANCELLED', reason });
  await recordHumanWorkEvent({
    projectId: order.projectId,
    orderId: order.id,
    kind: 'ORDER_CANCELLED',
    summary: `Stopped: ${reason}. Obligations already owed stay on the record.`,
    actor: 'PERSON',
    actorUserId: input.userId,
  });
  await recordEvent({
    projectId: order.projectId,
    entityType: 'human_work_order',
    entityId: order.id,
    eventType: 'HUMAN_WORK_CANCELLED',
    payload: { reason, by: input.userId },
  });
  return { ok: true, value: (await getOrder(order.id))! };
}

// ---------------------------------------------------------------------------
// Money and time
// ---------------------------------------------------------------------------

export interface Obligations {
  agreedCents: number;
  incurredCents: number;
  paidCents: number;
  outstandingCents: number;
  hours: number | null;
  currency: string;
  sentence: string;
}

/**
 * What is owed, derived from rows.
 *
 * Owed is the larger of what was agreed and what was actually incurred, less
 * what was paid; an engagement that did not go ahead owes only what was
 * incurred. Hours are the sum of what was recorded, and null when nothing was,
 * because zero hours is a measurement.
 */
export async function obligationsFor(engagement: HumanWorkEngagement): Promise<Obligations> {
  const costs = await listCosts(engagement.id);
  const incurred = costs.filter((one) => one.kind === 'INCURRED').reduce((sum, one) => sum + one.amountCents, 0);
  const paid = costs.filter((one) => one.kind === 'PAID').reduce((sum, one) => sum + one.amountCents, 0);
  const agreedApplies = ['ENGAGED', 'COMPLETED'].includes(engagement.state);
  const agreed = agreedApplies ? engagement.compensationCents : 0;
  const owedBasis = Math.max(agreed, incurred);
  const outstanding = Math.max(0, owedBasis - paid);
  const hourRows = costs.filter((one) => one.hours !== null);
  const hours = hourRows.length ? hourRows.reduce((sum, one) => sum + (one.hours ?? 0), 0) : null;
  const sentence =
    engagement.compensationCents === 0 && incurred === 0
      ? 'No charge was agreed, and nothing has been incurred.'
      : `${money(agreed, engagement.currency)} agreed, ${money(paid, engagement.currency)} paid, ` +
        `${money(outstanding, engagement.currency)} outstanding.`;
  return { agreedCents: agreed, incurredCents: incurred, paidCents: paid, outstandingCents: outstanding, hours, currency: engagement.currency, sentence };
}

export async function recordCost(input: {
  engagementId: string;
  kind: 'INCURRED' | 'PAID';
  amountCents: number;
  hours?: number | null;
  reference?: string | null;
  note?: string | null;
  idempotencyKey: string;
  userId: string;
}): Promise<Checked<{ replayed: boolean; obligations: Obligations }>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (!['ENGAGED', 'COMPLETED', 'CANCELLED', 'DECLINED_BY_WORKER'].includes(engagement.state)) {
    return { ok: false, reason: 'Money moves against work somebody accepted; this engagement is ' + engagement.state + '.' };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return { ok: false, reason: 'amountCents must be a whole, non-negative number.' };
  }
  if (input.hours !== undefined && input.hours !== null && (!Number.isFinite(input.hours) || input.hours < 0)) {
    return { ok: false, reason: 'hours must be a non-negative number.' };
  }
  const key = input.idempotencyKey.trim();
  if (!key) return { ok: false, reason: 'An idempotency key is required, so a retry never records money twice.' };
  const reference = (input.reference ?? '').trim() || null;
  if (input.kind === 'PAID' && !reference) {
    return { ok: false, reason: 'A payment needs a reference somebody can check — a receipt, a transfer id.' };
  }
  const before = await obligationsFor(engagement);
  if (input.kind === 'PAID') {
    const ceiling = engagement.approvedMaxCents ?? 0;
    if (before.paidCents + input.amountCents > Math.max(ceiling, before.incurredCents)) {
      return {
        ok: false,
        reason:
          `That would pay ${money(before.paidCents + input.amountCents, engagement.currency)} against an approved ` +
          `${money(ceiling, engagement.currency)}. Paying more than was approved is a new decision.`,
      };
    }
  }
  const { replayed } = await addCost({
    projectId: engagement.projectId,
    engagementId: engagement.id,
    kind: input.kind,
    amountCents: input.amountCents,
    currency: engagement.currency,
    hours: input.hours ?? null,
    reference,
    note: (input.note ?? '').trim() || null,
    recordedBy: input.userId,
    idempotencyKey: key,
  });
  if (!replayed) {
    await recordHumanWorkEvent({
      projectId: engagement.projectId,
      orderId: engagement.orderId,
      engagementId: engagement.id,
      kind: input.kind === 'PAID' ? 'PAYMENT_RECORDED' : 'COST_RECORDED',
      summary: `${input.kind === 'PAID' ? 'Paid' : 'Incurred'} ${money(input.amountCents, engagement.currency)}` +
        (input.hours ? ` for ${input.hours} hour(s)` : '') + (reference ? ` (${reference})` : '') + '.',
      detail: { amountCents: input.amountCents, hours: input.hours ?? null, reference },
      actor: 'PERSON',
      actorUserId: input.userId,
    });
    // A hold under the commercial authority settles against what actually left.
    if (input.kind === 'PAID' && engagement.commitmentId) {
      const commitment = await getCommitment(engagement.commitmentId);
      const after = await obligationsFor(engagement);
      if (commitment?.state === 'HELD' && after.outstandingCents === 0) {
        await settleSpend({ commitmentId: commitment.id, spentCents: Math.min(after.paidCents, commitment.amountCents), actorRef: input.userId, note: `Paid for: ${engagement.terms.scope}` });
      }
    }
  }
  return { ok: true, value: { replayed, obligations: await obligationsFor(engagement) } };
}
