/**
 * Where each piece of human work has got to, derived from rows on the read
 * path and stored nowhere.
 *
 * `tier.ts`'s argument, one kernel along: a stored stage is stale the moment
 * the row it waited on moves, and a stage that says "in progress" over an
 * engagement nobody accepted is the defect this whole path exists to prevent.
 * Every sentence here is the server's, so Russell, the Labor screen, the
 * assignee's own page and the operator report say one thing.
 */
import { getUser } from '../../repos/identity.ts';
import { getHumanRequest } from '../../repos/russellMissions.ts';
import {
  getOrder,
  listCandidates,
  listDeliverables,
  listEngagements,
  listHumanWorkEvents,
  listOrders,
} from '../../repos/humanWork.ts';
import { foundationReading } from '../identity/foundation.ts';
import { qualify, type Qualification } from './candidates.ts';
import { evaluateAcceptance, obligationsFor, type ConditionReading, type Obligations } from './deliver.ts';
import { invitationDraft } from './engage.ts';
import { money } from './vocabulary.ts';
import type {
  HumanWorkCandidate,
  HumanWorkDeliverable,
  HumanWorkEngagement,
  HumanWorkEvent,
  HumanWorkOrder,
} from '../../domain/types.ts';

export const HUMAN_WORK_STAGES = [
  'NEEDS_CANDIDATES',
  'QUALIFYING',
  'TERMS_PREPARED',
  'AWAITING_AUTHORIZATION',
  'AUTHORIZED_NOT_SENT',
  'AWAITING_ACCEPTANCE',
  'IN_PROGRESS',
  'UNDER_REVIEW',
  'REPAIR_REQUESTED',
  'READY_TO_ACCEPT',
  'ACCEPTED',
  'CANCELLED',
] as const;
export type HumanWorkStage = (typeof HUMAN_WORK_STAGES)[number];

/** Who performs the next action. `BRAIN` means nobody is being asked. */
export type HumanWorkActorRole =
  | 'PROJECT_ADMINISTRATOR'
  | 'COORDINATOR'
  | 'ASSIGNEE'
  | 'BRAIN_ADMINISTRATOR'
  | 'BRAIN'
  | 'NOBODY';

export interface HumanWorkBlocker {
  statement: string;
  remedy: string;
  who: HumanWorkActorRole;
}

export interface HumanWorkOrderView {
  order: HumanWorkOrder;
  stage: HumanWorkStage;
  /** One sentence Russell can say: who is doing what, what it costs, whether it meets the need. */
  headline: string;
  nextAction: { text: string; who: HumanWorkActorRole } | null;
  blockers: HumanWorkBlocker[];
  candidates: { candidate: HumanWorkCandidate; qualification: Qualification }[];
  engagement: HumanWorkEngagement | null;
  pastEngagements: HumanWorkEngagement[];
  /** Whether the person agreed, and how that is known — never inferred. */
  agreement: string;
  decisionRequest: { id: string; state: string } | null;
  /** For an ask outside Brain: the exact message a person sends. */
  invitationDraft: string | null;
  deliverables: HumanWorkDeliverable[];
  conditions: ConditionReading[];
  obligations: Obligations | null;
  /** Measured, from the rows' own timestamps; null where the stage was not reached. */
  timing: { engagedAt: string | null; acceptedAt: string | null; hoursEngagedToAccepted: number | null; overdue: string[] };
  events: HumanWorkEvent[];
}

const LIVE = ['PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED'];

function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10;
}

export async function orderView(order: HumanWorkOrder, options: { now?: string } = {}): Promise<HumanWorkOrderView> {
  const now = options.now ?? new Date().toISOString();
  const candidates = await listCandidates(order.id);
  const engagements = await listEngagements(order.id);
  const live = engagements.find((one) => LIVE.includes(one.state)) ?? null;
  const completed = engagements.find((one) => one.state === 'COMPLETED') ?? null;
  const engagement = live ?? completed;
  const past = engagements.filter((one) => one !== engagement);
  const candidate = engagement ? candidates.find((one) => one.id === engagement.candidateId) ?? null : null;
  const deliverables = engagement ? await listDeliverables(engagement.id) : [];
  const conditions = await evaluateAcceptance(order, engagement && ['ENGAGED', 'COMPLETED'].includes(engagement.state) ? engagement : null);
  const obligations = engagement ? await obligationsFor(engagement) : null;
  const events = await listHumanWorkEvents(order.id);
  const request = engagement?.decisionRequestId ? await getHumanRequest(engagement.decisionRequestId) : null;
  const qualified = await Promise.all(
    candidates.filter((one) => !one.setAsideAt).map(async (one) => ({ candidate: one, qualification: await qualify(one) })),
  );

  const blockers: HumanWorkBlocker[] = [];
  let stage: HumanWorkStage;
  let nextAction: HumanWorkOrderView['nextAction'] = null;
  const name = candidate?.displayName ?? 'they';

  if (order.state === 'ACCEPTED') {
    stage = 'ACCEPTED';
  } else if (order.state === 'CANCELLED') {
    stage = 'CANCELLED';
  } else if (!engagement) {
    stage = qualified.length ? 'QUALIFYING' : 'NEEDS_CANDIDATES';
    nextAction = qualified.length
      ? { text: 'Prepare terms for the strongest candidate: scope, deliverables, schedule, compensation, access, confidentiality and ownership.', who: 'COORDINATOR' }
      : { text: 'Record who could do this: a team member, somebody this operation already works with, or a possibility research established.', who: 'COORDINATOR' };
  } else if (engagement.state === 'PROPOSED') {
    stage = request?.state === 'OPEN' ? 'AWAITING_AUTHORIZATION' : 'TERMS_PREPARED';
    nextAction =
      stage === 'AWAITING_AUTHORIZATION'
        ? { text: `Decide in Needs You whether to engage ${name} on these terms.`, who: 'PROJECT_ADMINISTRATOR' }
        : { text: 'Put the engagement decision in front of an administrator of this project.', who: 'COORDINATOR' };
  } else if (engagement.state === 'APPROVED') {
    stage = 'AUTHORIZED_NOT_SENT';
    if (engagement.assigneeUserId) {
      nextAction = { text: 'Brain puts the assignment on their Brain page on its next pass.', who: 'BRAIN' };
    } else {
      nextAction = { text: `Send ${name} the prepared message, then record the channel and reference here.`, who: 'COORDINATOR' };
      blockers.push({
        statement: 'Brain holds no outbound channel to anybody outside this Brain — no email, messaging or marketplace integration.',
        remedy: 'A person sends the prepared message and records that they did. Connecting an outbound channel is its own decision.',
        who: 'COORDINATOR',
      });
    }
  } else if (engagement.state === 'INVITED') {
    stage = 'AWAITING_ACCEPTANCE';
    nextAction = engagement.assigneeUserId
      ? { text: `${name} accepts or declines the assignment on their own Brain page.`, who: 'ASSIGNEE' }
      : { text: `Wait for ${name}'s answer, then record their acceptance with its evidence.`, who: 'COORDINATOR' };
  } else {
    const unmet = conditions.filter((one) => one.verdict !== 'MET');
    const repairs = conditions.filter((one) => one.verdict === 'NOT_MET' && one.check === 'PERSON_REVIEW');
    const needsDeliverable = order.acceptance.some((one) => one.check !== 'ACCOUNT_FOUNDATION');
    if (engagement.state === 'COMPLETED') {
      stage = 'ACCEPTED';
    } else if (unmet.length === 0) {
      stage = 'READY_TO_ACCEPT';
      nextAction =
        engagement.compensationCents === 0 && order.acceptance.every((one) => one.check !== 'PERSON_REVIEW')
          ? { text: 'Every condition reads MET from rows; Brain records the acceptance on its next pass.', who: 'BRAIN' }
          : { text: 'Every condition holds. Record the acceptance.', who: 'PROJECT_ADMINISTRATOR' };
    } else if (repairs.length) {
      stage = 'REPAIR_REQUESTED';
      nextAction = { text: `${name} makes the requested repair: ${repairs.map((one) => one.repair).join('; ')}`, who: 'ASSIGNEE' };
    } else if (needsDeliverable && deliverables.length > 0) {
      stage = 'UNDER_REVIEW';
      nextAction = { text: `Review round ${deliverables.at(-1)!.round} against each condition.`, who: 'COORDINATOR' };
    } else {
      stage = 'IN_PROGRESS';
      const first = unmet[0]!;
      nextAction = { text: `${name} is doing the work. Outstanding: ${first.statement}`, who: 'ASSIGNEE' };
    }
  }

  // A team member who cannot sign in cannot see the assignment. Derived from
  // the same foundation reading People uses, so the two cannot disagree.
  if (engagement?.assigneeUserId && ['APPROVED', 'INVITED', 'ENGAGED'].includes(engagement.state)) {
    const foundation = await foundationReading();
    const signIn = foundation.accounts
      .find((one) => one.userId === engagement.assigneeUserId)
      ?.findings.find((one) => one.dimension === 'SIGN_IN');
    if (signIn && signIn.verdict === 'BLOCKED') {
      blockers.push({
        statement: `${name} cannot sign in to Brain, so the assignment cannot reach them: ${signIn.because}`,
        remedy: `${signIn.nextAction ?? 'Issue them a way in.'} Sending that link to them is contacting them, which is yours to do.`,
        who: 'BRAIN_ADMINISTRATOR',
      });
    }
  }

  const overdue: string[] = [];
  if (engagement && ['ENGAGED'].includes(engagement.state)) {
    for (const item of engagement.terms.schedule ?? []) {
      if (item.due && item.due < now.slice(0, item.due.length) && stage !== 'READY_TO_ACCEPT') {
        overdue.push(`${item.milestone} was due ${item.due}`);
      }
    }
  }
  if (order.dueBy && order.state === 'OPEN' && order.dueBy < now) overdue.push(`the work was due ${order.dueBy}`);

  const agreement = !engagement
    ? 'Nobody has been asked.'
    : engagement.engagedEvidence === 'ACCEPTED_IN_BRAIN'
      ? `${name} accepted in Brain at ${engagement.engagedAt}.`
      : engagement.engagedEvidence === 'ATTESTED_BY_COORDINATOR'
        ? `A coordinator attested that ${name} accepted, at ${engagement.engagedAt}; they did not accept in Brain themselves.`
        : engagement.state === 'INVITED'
          ? `${name} has been asked (${engagement.invitationChannel}) and has not answered. An unanswered ask is not an agreement.`
          : `${name} has not been asked yet.`;

  const cost = engagement
    ? engagement.state === 'PROPOSED'
      ? `would cost ${money(engagement.compensationCents, engagement.currency)}`
      : obligations!.sentence
    : 'no terms yet';
  const meets =
    stage === 'ACCEPTED'
      ? 'the result met every condition'
      : conditions.length
        ? `${conditions.filter((one) => one.verdict === 'MET').length} of ${conditions.length} acceptance condition(s) met`
        : 'no conditions';
  const doing: Record<HumanWorkStage, string> = {
    NEEDS_CANDIDATES: 'nobody has been found yet',
    QUALIFYING: `${qualified.length} possible ${qualified.length === 1 ? 'person' : 'people'} on record, nobody asked`,
    TERMS_PREPARED: `terms prepared for ${name}, not yet put to a decision`,
    AWAITING_AUTHORIZATION: `waiting on your decision to engage ${name}`,
    AUTHORIZED_NOT_SENT: `${name} approved, ask not yet sent`,
    AWAITING_ACCEPTANCE: `${name} has been asked and has not answered`,
    IN_PROGRESS: `${name} is doing the work`,
    UNDER_REVIEW: `${name} handed in a result that is being checked`,
    REPAIR_REQUESTED: `${name} is repairing what did not meet the standard`,
    READY_TO_ACCEPT: `${name}'s result meets every condition`,
    ACCEPTED: `${name} finished it`,
    CANCELLED: 'stopped',
  };
  const headline = `${order.title}: ${doing[stage]}; ${cost}; ${meets}.`;

  return {
    order,
    stage,
    headline,
    nextAction,
    blockers,
    candidates: qualified,
    engagement,
    pastEngagements: past,
    agreement,
    decisionRequest: request ? { id: request.id, state: request.state } : null,
    invitationDraft:
      engagement && candidate && !engagement.assigneeUserId && ['APPROVED', 'INVITED'].includes(engagement.state)
        ? invitationDraft(order, candidate, engagement)
        : null,
    deliverables,
    conditions,
    obligations,
    timing: {
      engagedAt: engagement?.engagedAt ?? null,
      acceptedAt: engagement?.completedAt ?? null,
      hoursEngagedToAccepted: hoursBetween(engagement?.engagedAt ?? null, engagement?.completedAt ?? null),
      overdue,
    },
    events,
  };
}

export interface HumanWorkProjectView {
  orders: HumanWorkOrderView[];
  /** What Russell says about people working on this project, in order. */
  briefing: string[];
}

export async function humanWorkView(projectId: string): Promise<HumanWorkProjectView> {
  const orders = await listOrders(projectId);
  const views = [];
  for (const order of orders) views.push(await orderView(order));
  const open = views.filter((one) => one.order.state === 'OPEN');
  const briefing = open.map((one) => one.headline);
  for (const one of open) {
    if (one.nextAction && ['PROJECT_ADMINISTRATOR', 'BRAIN_ADMINISTRATOR'].includes(one.nextAction.who)) {
      briefing.push(`You are needed: ${one.nextAction.text}`);
    }
    for (const blocker of one.blockers.filter((b) => b.who === 'BRAIN_ADMINISTRATOR')) {
      briefing.push(`You are needed: ${blocker.remedy}`);
    }
  }
  return { orders: views, briefing };
}

// ---------------------------------------------------------------------------
// What the person doing the work sees — and nothing else
// ---------------------------------------------------------------------------

export interface AssignmentView {
  engagementId: string;
  state: HumanWorkEngagement['state'];
  title: string;
  work: string;
  whyYou: string;
  scope: string;
  deliverables: string[];
  schedule: HumanWorkEngagement['terms']['schedule'];
  compensation: string;
  access: string[];
  confidentiality: string;
  ownership: string;
  /** Only what the work order marks as shared. Never the project. */
  context: string[];
  acceptance: { key: string; statement: string; verdict: string; because: string; repair: string | null }[];
  coordinator: string | null;
  updates: { kind: string; summary: string; at: string; byYou: boolean }[];
  rounds: { round: number; description: string; at: string }[];
}

/**
 * The assignee's brief.
 *
 * Built field by field from the order and the terms rather than by filtering a
 * project view, for `services/cash/shared.ts`' reason: a projection that
 * fetched broadly and stripped fields would be one forgotten line from
 * disclosing the project to somebody who was engaged for one task in it.
 */
export async function assignmentView(engagement: HumanWorkEngagement, userId: string): Promise<AssignmentView | null> {
  const order = await getOrder(engagement.orderId);
  if (!order) return null;
  const conditions = ['ENGAGED', 'COMPLETED'].includes(engagement.state)
    ? await evaluateAcceptance(order, engagement)
    : [];
  const coordinator = order.coordinatorUserId ? await getUser(order.coordinatorUserId) : null;
  const events = await listHumanWorkEvents(order.id);
  const deliverables = await listDeliverables(engagement.id);
  const visible = new Set(['INVITATION_SENT', 'WORKER_ACCEPTED', 'WORKER_DECLINED', 'ACKNOWLEDGED', 'MILESTONE', 'QUESTION', 'ANSWER', 'CHANGE_REQUESTED', 'HANDOFF', 'ACCESS_GRANTED', 'ACCESS_REVOKED', 'DELIVERABLE_SUBMITTED', 'REPAIR_REQUESTED', 'CONDITION_REVIEWED', 'RESULT_ACCEPTED', 'PAYMENT_RECORDED']);
  return {
    engagementId: engagement.id,
    state: engagement.state,
    title: order.title,
    work: order.work,
    whyYou: order.whyPerson,
    scope: engagement.terms.scope,
    deliverables: engagement.terms.deliverables,
    schedule: engagement.terms.schedule,
    compensation: money(engagement.compensationCents, engagement.currency),
    access: engagement.terms.access,
    confidentiality: engagement.terms.confidentiality,
    ownership: engagement.terms.ownership,
    context: order.sharedContext,
    acceptance: (conditions.length ? conditions : order.acceptance.map((one) => ({ key: one.key, statement: one.statement, verdict: 'NOT_JUDGED', because: 'Not started.', repair: null }))).map((one) => ({
      key: one.key,
      statement: one.statement,
      verdict: one.verdict,
      because: one.because,
      repair: one.repair,
    })),
    coordinator: coordinator ? coordinator.displayName : null,
    updates: events
      .filter((event) => event.engagementId === engagement.id && visible.has(event.kind))
      .map((event) => ({ kind: event.kind, summary: event.summary, at: event.createdAt, byYou: event.actorUserId === userId })),
    rounds: deliverables.map((one) => ({ round: one.round, description: one.description, at: one.createdAt })),
  };
}
