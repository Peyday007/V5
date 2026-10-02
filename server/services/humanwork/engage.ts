/**
 * Steps 3 and 4's front half: preparing an engagement, putting the concrete
 * decision in front of the person who may make it, and turning an approval
 * into an ask the worker can answer.
 *
 * ---------------------------------------------------------------------------
 * Four states nobody may skip
 * ---------------------------------------------------------------------------
 *
 *   PROPOSED  terms prepared; nobody has decided anything
 *   APPROVED  a project administrator approved exactly these terms
 *   INVITED   the ask reached the person, by a channel that is named
 *   ENGAGED   the person accepted — themselves in Brain, or attested with
 *             the evidence named by a coordinator
 *
 * Each move is a compare-and-swap naming the state it comes from, so an
 * unanswered invitation cannot read as an engagement, and a late second answer
 * to one decision matches nothing.
 *
 * ---------------------------------------------------------------------------
 * What Brain can and cannot do here
 * ---------------------------------------------------------------------------
 *
 * Brain holds exactly one channel to a person: an assignment on a team
 * member's own page, which they see when they sign in. It holds no email, no
 * messaging integration and no marketplace account, and it may not act in
 * anybody's name (`IDENTITY_BEARING_ACT` is on the prohibited list every
 * commercial grant carries). So for anybody outside the team, Brain prepares
 * the exact message and a person sends it — and records that they did, with a
 * reference — which is the honest shape of "contact" on this Brain today.
 */
import { askHuman, getHumanRequest } from '../../repos/russellMissions.ts';
import { getMembership, getUser } from '../../repos/identity.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  createEngagement,
  engagementForRequest,
  getCandidate,
  getEngagement,
  getOrder,
  listEngagements,
  recordHumanWorkEvent,
  setDecisionRequest,
  transitionEngagement,
} from '../../repos/humanWork.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { commitSpend } from '../cash/opportunities.ts';
import { roleAtLeast } from '../identity/policy.ts';
import { engagementTerms, money, type Checked } from './vocabulary.ts';
import type {
  HumanWorkCandidate,
  HumanWorkEngagement,
  HumanWorkOrder,
  RussellHumanRequest,
} from '../../domain/types.ts';

export const HUMAN_WORK_DECISION_PREFIX = 'human-work:engage:';
export const ENGAGEMENT_CHOICES = {
  APPROVE: 'APPROVE_ENGAGEMENT',
  REFUSE: 'REFUSE_ENGAGEMENT',
} as const;

/** The channel a team member is reached by: their own Brain page. */
export const BRAIN_ASSIGNMENTS_CHANNEL = 'BRAIN_ASSIGNMENTS';

// ---------------------------------------------------------------------------
// Preparing terms
// ---------------------------------------------------------------------------

export async function prepareEngagement(input: {
  orderId: string;
  candidateId: string;
  terms: unknown;
  actorRef: string;
}): Promise<Checked<HumanWorkEngagement>> {
  const order = await getOrder(input.orderId);
  if (!order || order.state !== 'OPEN') return { ok: false, reason: 'No open work order with that id.' };
  const candidate = await getCandidate(input.candidateId);
  if (!candidate || candidate.orderId !== order.id) return { ok: false, reason: 'No candidate with that id on this work.' };
  if (candidate.setAsideAt) return { ok: false, reason: 'That candidate was set aside.' };
  const terms = engagementTerms(input.terms);
  if (!terms.ok) return terms;
  if (terms.value.currency !== order.currency && terms.value.compensationCents > 0) {
    return { ok: false, reason: `The work is budgeted in ${order.currency}; terms in another currency are not converted.` };
  }
  if (order.budgetCents !== null && terms.value.compensationCents > order.budgetCents) {
    return {
      ok: false,
      reason:
        `These terms cost ${money(terms.value.compensationCents, terms.value.currency)} against a budget of ` +
        `${money(order.budgetCents, order.currency)} for this work. Narrow the scope, or raise the budget — ` +
        'which is its own decision.',
    };
  }
  // Every access the order says the work needs must be in the terms: a worker
  // who agreed to terms that left out the access they will need has agreed to
  // something that cannot be delivered.
  const missing = order.accessRequired.filter((item) => !terms.value.access.includes(item));
  if (missing.length) {
    return { ok: false, reason: `The terms leave out access the work needs: ${missing.join('; ')}.` };
  }
  const live = (await listEngagements(order.id)).find((one) =>
    ['PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED'].includes(one.state),
  );
  if (live) {
    return {
      ok: false,
      reason:
        'This work already has a live engagement. Withdraw it first; two sets of terms in front of ' +
        'one decision is two decisions nobody asked for.',
    };
  }
  const engagement = await createEngagement({
    projectId: order.projectId,
    orderId: order.id,
    candidateId: candidate.id,
    terms: terms.value,
    assigneeUserId: candidate.userId,
    createdBy: input.actorRef,
  });
  if (!engagement) return { ok: false, reason: 'Somebody prepared terms for this work at the same moment.' };
  await recordHumanWorkEvent({
    projectId: order.projectId,
    orderId: order.id,
    engagementId: engagement.id,
    kind: 'TERMS_PREPARED',
    summary:
      `Terms prepared for ${candidate.displayName}: ${money(terms.value.compensationCents, terms.value.currency)}, ` +
      `${terms.value.deliverables.length} deliverable(s). Nothing is committed until a decision is made.`,
    detail: { termsHash: engagement.termsHash },
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  return { ok: true, value: engagement };
}

// ---------------------------------------------------------------------------
// The decision, as a Needs You card
// ---------------------------------------------------------------------------

/**
 * The exact sentences a decision-maker reads.
 *
 * Composed here from the rows, so the card and the thing it authorizes are one
 * object. It says what approving does **and what it does not**: approving does
 * not send anything to anybody outside Brain, grant any access or pay anybody.
 */
export function decisionWords(
  order: HumanWorkOrder,
  candidate: HumanWorkCandidate,
  engagement: HumanWorkEngagement,
): { authorityNeeded: string; whyNotRussell: string; recommendation: string } {
  const terms = engagement.terms;
  const who =
    candidate.relationship === 'TEAM_MEMBER'
      ? `${candidate.displayName}, a member of this Brain`
      : candidate.relationship === 'EXISTING_RELATIONSHIP'
        ? `${candidate.displayName}, somebody this operation already works with`
        : `${candidate.displayName}, found by research — they have agreed to nothing`;
  const due = terms.schedule.map((item) => `${item.milestone}${item.due ? ` by ${item.due}` : ''}`).join('; ');
  const reach =
    candidate.relationship === 'TEAM_MEMBER'
      ? 'Approving puts the assignment on their own Brain page; they accept or decline it there.'
      : 'Approving does not contact them: Brain prepares the message and a person sends it and records that they did.';
  return {
    authorityNeeded:
      `Engage ${who}, for "${order.title}": ${terms.scope} ` +
      `Delivers: ${terms.deliverables.join('; ')}. Schedule: ${due}. ` +
      `Cost: ${money(terms.compensationCents, terms.currency)} (${terms.compensationBasis}). ` +
      `Access they would need: ${terms.access.length ? terms.access.join('; ') : 'none'}. ` +
      `Confidentiality: ${terms.confidentiality} Ownership: ${terms.ownership}`,
    whyNotRussell:
      `A person is needed here (${order.necessityReason}): ${order.whyPerson} ` +
      'Committing somebody\'s time or the project\'s money is a decision an administrator of this project makes.',
    recommendation:
      `${reach} Approving grants no access and pays nobody; access and payment are recorded separately as they happen. ` +
      `The result is accepted only when every condition holds: ${order.acceptance.map((one) => one.statement).join('; ')}`,
  };
}

export async function requestEngagementDecision(input: {
  engagementId: string;
  actorRef: string;
}): Promise<Checked<RussellHumanRequest>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (engagement.state !== 'PROPOSED') return { ok: false, reason: `That engagement is already ${engagement.state}.` };
  const order = await getOrder(engagement.orderId);
  const candidate = await getCandidate(engagement.candidateId);
  if (!order || !candidate) return { ok: false, reason: 'The work or the candidate is gone.' };
  const words = decisionWords(order, candidate, engagement);
  const { request, created } = await askHuman({
    projectId: order.projectId,
    visibility: 'SHARED',
    authorityNeeded: words.authorityNeeded,
    whyNotRussell: words.whyNotRussell,
    recommendation: words.recommendation,
    urgency: 'BLOCKING',
    choices: [
      {
        key: ENGAGEMENT_CHOICES.APPROVE,
        label: `Approve engaging ${candidate.displayName}`,
        consequence:
          engagement.compensationCents > 0
            ? `Authorizes up to ${money(engagement.compensationCents, engagement.currency)} on exactly these terms, and the ask goes to them.`
            : 'Authorizes this assignment on exactly these terms, at no charge, and the ask goes to them.',
      },
      {
        key: ENGAGEMENT_CHOICES.REFUSE,
        label: 'Do not engage',
        consequence: 'Nothing is committed and nobody is asked; the work stays open for other candidates or other terms.',
      },
    ],
    resumeKey: `${HUMAN_WORK_DECISION_PREFIX}${engagement.id}`,
  });
  await setDecisionRequest(engagement.id, request.id);
  if (created) {
    await recordHumanWorkEvent({
      projectId: order.projectId,
      orderId: order.id,
      engagementId: engagement.id,
      kind: 'DECISION_REQUESTED',
      summary: `The engagement decision is in Needs You for an administrator of this project.`,
      detail: { requestId: request.id },
      actor: 'PERSON',
      actorUserId: input.actorRef,
    });
  }
  return { ok: true, value: request };
}

/** Whether this person may decide an engagement on this project. Read from rows now. */
async function mayDecide(projectId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const user = await getUser(userId);
  if (!user || user.disabled || user.kind !== 'PERSON') return false;
  if (user.isBrainAdmin) return true;
  const membership = await getMembership(projectId, 'HUMAN', userId);
  return Boolean(membership && membership.active && roleAtLeast(membership.role, 'ADMIN'));
}

export interface DecisionResult {
  settled: boolean;
  reason: string;
}

/**
 * Carry out what a person answered on the card.
 *
 * Called from `resumeAnsweredRequest`, so the card is marked resumed only when
 * this actually moved the engagement — §24's answering transition, not a flag.
 * The answerer's authority is re-read from rows at this moment: a card anybody
 * with write access could answer is not the same as an administrator's
 * decision, so an answer from somebody who may not decide is put back.
 */
export async function resolveEngagementDecision(request: RussellHumanRequest): Promise<DecisionResult> {
  const engagement = await engagementForRequest(request.id);
  if (!engagement) return { settled: true, reason: 'the engagement this card was about is gone' };
  if (engagement.state !== 'PROPOSED') {
    return { settled: true, reason: `the engagement is already ${engagement.state}` };
  }
  const order = await getOrder(engagement.orderId);
  const candidate = await getCandidate(engagement.candidateId);
  if (!order || !candidate || order.state !== 'OPEN') {
    return { settled: true, reason: 'the work this card was about is closed' };
  }
  if (!(await mayDecide(order.projectId, request.answeredByUserId))) {
    return {
      settled: false,
      reason:
        'Engaging somebody is decided by an administrator of this project, and the person who answered is not one. ' +
        'The card is back for somebody who may decide.',
    };
  }
  const deciderId = request.answeredByUserId!;

  if (request.answeredChoice === ENGAGEMENT_CHOICES.REFUSE) {
    const moved = await transitionEngagement({
      id: engagement.id,
      from: 'PROPOSED',
      to: 'REFUSED_BY_OWNER',
      patch: { ended_reason: request.answeredReason ?? 'not approved' },
    });
    if (moved) {
      await recordHumanWorkEvent({
        projectId: order.projectId,
        orderId: order.id,
        engagementId: engagement.id,
        kind: 'ENGAGEMENT_REFUSED',
        summary: `Not approved${request.answeredReason ? `: ${request.answeredReason}` : '.'}`,
        actor: 'PERSON',
        actorUserId: deciderId,
      });
      await recordEvent({
        projectId: order.projectId,
        entityType: 'human_work_engagement',
        entityId: engagement.id,
        eventType: 'HUMAN_WORK_ENGAGEMENT_DECIDED',
        payload: { decision: 'REFUSED', decidedBy: deciderId },
      });
    }
    return { settled: true, reason: 'not approved, as decided' };
  }

  if (request.answeredChoice !== ENGAGEMENT_CHOICES.APPROVE) {
    return { settled: false, reason: `this Brain does not implement the answer "${request.answeredChoice ?? 'none'}"` };
  }

  /*
   * Funding. Three answers and no fourth:
   *   no money       → NO_CHARGE
   *   a standing commercial authority covering ENGAGE_CONTRACTOR
   *                  → a hold under its ceilings, refused if it does not fit
   *   otherwise      → the approver's own decision on this exact amount is the
   *                    ceiling (DIRECT_APPROVAL); nothing can be paid above it.
   * A grant that exists and covers the action is never bypassed: if its
   * ceilings refuse the hold, the approval cannot be carried out.
   */
  let funding: HumanWorkEngagement['funding'] = 'NO_CHARGE';
  let commitmentId: string | null = null;
  if (engagement.compensationCents > 0) {
    const authority = await checkCommercialAuthority({ projectId: order.projectId, action: 'ENGAGE_CONTRACTOR' });
    if (authority.ok) {
      const held = await commitSpend({
        projectId: order.projectId,
        action: 'ENGAGE_CONTRACTOR',
        amountCents: engagement.compensationCents,
        purpose: `Engage ${candidate.displayName} for: ${order.title}`,
        expectedResult: order.acceptance.map((one) => one.statement).join('; '),
        stopCondition: `No more than ${money(engagement.compensationCents, engagement.currency)} on these terms.`,
        idempotencyKey: `human-work:${engagement.id}:${engagement.termsHash}`,
        actorRef: deciderId,
      });
      if (!held.ok) {
        return {
          settled: false,
          reason: `The standing commercial authority refused to hold this amount: ${held.reason}`,
        };
      }
      funding = 'COMMERCIAL_AUTHORITY';
      commitmentId = held.value.id;
    } else {
      funding = 'DIRECT_APPROVAL';
    }
  }

  const at = new Date().toISOString();
  const moved = await transitionEngagement({
    id: engagement.id,
    from: 'PROPOSED',
    to: 'APPROVED',
    patch: {
      approved_by_user_id: deciderId,
      approved_at: at,
      approved_max_cents: engagement.compensationCents,
      funding: funding!,
      commitment_id: commitmentId,
    },
  });
  if (!moved) return { settled: true, reason: 'the engagement moved while this was being decided' };
  await recordHumanWorkEvent({
    projectId: order.projectId,
    orderId: order.id,
    engagementId: engagement.id,
    kind: 'ENGAGEMENT_APPROVED',
    summary:
      `Approved: ${candidate.displayName}, up to ${money(engagement.compensationCents, engagement.currency)} ` +
      `(${funding}).`,
    detail: { funding, commitmentId, termsHash: engagement.termsHash },
    actor: 'PERSON',
    actorUserId: deciderId,
  });
  await recordEvent({
    projectId: order.projectId,
    entityType: 'human_work_engagement',
    entityId: engagement.id,
    eventType: 'HUMAN_WORK_ENGAGEMENT_DECIDED',
    payload: { decision: 'APPROVED', decidedBy: deciderId, funding, commitmentId },
  });
  // The one channel Brain holds: a team member's own page. The ask reaches them
  // now, in the same answering transition, so an approval never sits waiting
  // for somebody to remember to send it.
  if (candidate.relationship === 'TEAM_MEMBER' && candidate.userId) {
    await deliverInBrain(engagement.id, deciderId);
  }
  return { settled: true, reason: 'approved; the ask is on its way' };
}

async function deliverInBrain(engagementId: string, actorRef: string): Promise<boolean> {
  const engagement = await getEngagement(engagementId);
  if (!engagement || engagement.state !== 'APPROVED' || !engagement.assigneeUserId) return false;
  const moved = await transitionEngagement({
    id: engagement.id,
    from: 'APPROVED',
    to: 'INVITED',
    patch: {
      invited_at: new Date().toISOString(),
      invited_by: 'BRAIN',
      invitation_channel: BRAIN_ASSIGNMENTS_CHANNEL,
      invitation_reference: engagement.id,
    },
  });
  if (moved) {
    await recordHumanWorkEvent({
      projectId: engagement.projectId,
      orderId: engagement.orderId,
      engagementId: engagement.id,
      kind: 'INVITATION_SENT',
      summary:
        'The assignment is on their own Brain page. It is an invitation until they accept it there; ' +
        'nobody is engaged by an unanswered ask.',
      detail: { channel: BRAIN_ASSIGNMENTS_CHANNEL, approvedBy: actorRef },
      actor: 'BRAIN',
    });
  }
  return moved;
}

/** The tick's half: an approval for a team member that has not reached them yet. */
export async function deliverApprovedInBrain(engagement: HumanWorkEngagement): Promise<boolean> {
  return deliverInBrain(engagement.id, engagement.approvedByUserId ?? 'BRAIN');
}

/**
 * The message a person sends to somebody outside the team, composed by Brain.
 *
 * It carries the terms and nothing from the project beyond what the order
 * marks as shared, because an invitation is the first disclosure and the
 * narrowest one should be the default.
 */
export function invitationDraft(order: HumanWorkOrder, candidate: HumanWorkCandidate, engagement: HumanWorkEngagement): string {
  const terms = engagement.terms;
  return [
    `Hello ${candidate.displayName},`,
    '',
    `We would like to engage you for: ${order.title}.`,
    `Scope: ${terms.scope}`,
    `Deliverables: ${terms.deliverables.join('; ')}.`,
    `Schedule: ${terms.schedule.map((item) => `${item.milestone}${item.due ? ` by ${item.due}` : ''}`).join('; ')}.`,
    `Compensation: ${money(terms.compensationCents, terms.currency)}${terms.rateBasis ? ` (${terms.rateBasis})` : ''}.`,
    `Access provided: ${terms.access.length ? terms.access.join('; ') : 'none needed'}.`,
    `Confidentiality: ${terms.confidentiality}`,
    `Ownership of the result: ${terms.ownership}`,
    `The work is accepted when: ${order.acceptance.map((one) => one.statement).join('; ')}.`,
    '',
    'Please reply to confirm whether you accept these terms.',
  ].join('\n');
}

/**
 * A person sent the ask outside Brain, and says how.
 *
 * Only after approval, and only with the channel named: an invitation Brain
 * cannot point to is an invitation it cannot follow up.
 */
export async function recordInvitationSent(input: {
  engagementId: string;
  channel: string;
  reference?: string | null;
  actorRef: string;
}): Promise<Checked<HumanWorkEngagement>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (engagement.state !== 'APPROVED') {
    return {
      ok: false,
      reason:
        engagement.state === 'PROPOSED'
          ? 'Nobody has approved these terms yet, so nobody may be asked.'
          : `That engagement is already ${engagement.state}.`,
    };
  }
  const channel = input.channel.trim();
  if (!channel) return { ok: false, reason: 'Say which channel the ask went out on.' };
  const moved = await transitionEngagement({
    id: engagement.id,
    from: 'APPROVED',
    to: 'INVITED',
    patch: {
      invited_at: new Date().toISOString(),
      invited_by: input.actorRef,
      invitation_channel: channel,
      invitation_reference: (input.reference ?? '').trim() || null,
    },
  });
  if (!moved) return { ok: false, reason: 'The engagement moved at the same moment.' };
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: 'INVITATION_SENT',
    summary: `The ask was sent by a person via ${channel}. It is not an engagement until they accept.`,
    detail: { channel, reference: input.reference ?? null },
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  return { ok: true, value: (await getEngagement(engagement.id))! };
}

/**
 * The worker answers — themselves, inside Brain.
 *
 * `userId` is the authenticated principal, compared with the row. Nobody else
 * can accept on a team member's behalf through this function.
 */
export async function answerInvitation(input: {
  engagementId: string;
  userId: string;
  accept: boolean;
  note?: string | null;
}): Promise<Checked<HumanWorkEngagement>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement || engagement.assigneeUserId !== input.userId) return { ok: false, reason: 'No assignment with that id.' };
  if (engagement.state !== 'INVITED') return { ok: false, reason: `That assignment is ${engagement.state.toLowerCase()}.` };
  const at = new Date().toISOString();
  const moved = input.accept
    ? await transitionEngagement({
        id: engagement.id,
        from: 'INVITED',
        to: 'ENGAGED',
        patch: { engaged_at: at, engaged_evidence: 'ACCEPTED_IN_BRAIN', engaged_attested_by: null },
      })
    : await transitionEngagement({
        id: engagement.id,
        from: 'INVITED',
        to: 'DECLINED_BY_WORKER',
        patch: { ended_reason: (input.note ?? '').trim() || 'declined' },
      });
  if (!moved) return { ok: false, reason: 'The assignment moved at the same moment.' };
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: input.accept ? 'WORKER_ACCEPTED' : 'WORKER_DECLINED',
    summary: input.accept
      ? 'They accepted the assignment in Brain.'
      : `They declined${input.note ? `: ${input.note}` : '.'}`,
    actor: 'ASSIGNEE',
    actorUserId: input.userId,
  });
  if (input.accept) {
    await recordEvent({
      projectId: engagement.projectId,
      entityType: 'human_work_engagement',
      entityId: engagement.id,
      eventType: 'HUMAN_WORK_ENGAGED',
      payload: { evidence: 'ACCEPTED_IN_BRAIN' },
    });
  } else {
    await releaseCommitmentIfAny(engagement, true);
  }
  return { ok: true, value: (await getEngagement(engagement.id))! };
}

/**
 * A coordinator saying somebody outside Brain accepted, and on what evidence.
 *
 * `ATTESTED_BY_COORDINATOR` is its own value, never folded into the worker's
 * own acceptance: "they said yes in Brain" and "somebody says they said yes"
 * are different facts, and the view prints which one this is.
 */
export async function attestAcceptance(input: {
  engagementId: string;
  evidence: string;
  actorRef: string;
}): Promise<Checked<HumanWorkEngagement>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (engagement.state !== 'INVITED') {
    return { ok: false, reason: 'Only an ask that was sent can be accepted; this one is ' + engagement.state + '.' };
  }
  if (engagement.assigneeUserId) {
    return { ok: false, reason: 'A team member accepts on their own Brain page; nobody accepts for them.' };
  }
  const evidence = input.evidence.trim();
  if (!evidence) return { ok: false, reason: 'Say what shows they accepted — a reply, a signed agreement, a reference.' };
  const moved = await transitionEngagement({
    id: engagement.id,
    from: 'INVITED',
    to: 'ENGAGED',
    patch: {
      engaged_at: new Date().toISOString(),
      engaged_evidence: 'ATTESTED_BY_COORDINATOR',
      engaged_attested_by: input.actorRef,
    },
  });
  if (!moved) return { ok: false, reason: 'The engagement moved at the same moment.' };
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: 'WORKER_ACCEPTED',
    summary: `Acceptance attested by a coordinator: ${evidence}`,
    detail: { evidence },
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  await recordEvent({
    projectId: engagement.projectId,
    entityType: 'human_work_engagement',
    entityId: engagement.id,
    eventType: 'HUMAN_WORK_ENGAGED',
    payload: { evidence: 'ATTESTED_BY_COORDINATOR', attestedBy: input.actorRef },
  });
  return { ok: true, value: (await getEngagement(engagement.id))! };
}

async function releaseCommitmentIfAny(engagement: HumanWorkEngagement, release: boolean): Promise<void> {
  if (!release || !engagement.commitmentId) return;
  const { releaseCommitment } = await import('../../repos/cashAuthority.ts');
  await releaseCommitment({ commitmentId: engagement.commitmentId, reason: 'the engagement did not go ahead' });
}

/** Withdraw a live engagement: nothing done under it is erased. */
export async function withdrawEngagement(input: {
  engagementId: string;
  reason: string;
  actorRef: string;
}): Promise<Checked<HumanWorkEngagement>> {
  const engagement = await getEngagement(input.engagementId);
  if (!engagement) return { ok: false, reason: 'No engagement with that id.' };
  if (!['PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED'].includes(engagement.state)) {
    return { ok: false, reason: `That engagement is already ${engagement.state}.` };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'Say why it is being withdrawn.' };
  const moved = await transitionEngagement({
    id: engagement.id,
    from: engagement.state,
    to: 'CANCELLED',
    patch: { ended_reason: reason },
  });
  if (!moved) return { ok: false, reason: 'The engagement moved at the same moment.' };
  await releaseCommitmentIfAny(engagement, true);
  if (engagement.decisionRequestId) {
    const { withdrawRequest } = await import('../../repos/russellMissions.ts');
    const request = await getHumanRequest(engagement.decisionRequestId);
    if (request?.state === 'OPEN') await withdrawRequest({ requestId: request.id, reason: `Withdrawn: ${reason}` });
  }
  await recordHumanWorkEvent({
    projectId: engagement.projectId,
    orderId: engagement.orderId,
    engagementId: engagement.id,
    kind: 'ENGAGEMENT_WITHDRAWN',
    summary: `Withdrawn: ${reason}. Everything recorded under it is kept, including any obligation already owed.`,
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  return { ok: true, value: (await getEngagement(engagement.id))! };
}
