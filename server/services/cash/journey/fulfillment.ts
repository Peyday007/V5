/**
 * The obligation an agreement creates, carried to the end.
 *
 * This is the post-sale model's middle (docs/POST-SALE.md): an agreement says
 * what was promised and what proves it landed; this module says who performs
 * it, creates the work in the machinery that does it, and reads where it
 * stands. It is an **entrance** to owners that already exist:
 *
 *   * the work is a Factory change request (`submitObjective`) or a Russell
 *     idea (`capture`) — never a second queue — and for a person or a supplier
 *     there is no work object at all, because the obligation is the work;
 *   * the money is `cash_money_entries` through `recordMoneyEvent` — no figure
 *     is stored here, and the deal's P&L is `position.ts`;
 *   * a missing capability is a `cash_needs` row with a recommended path;
 *   * a refund is `runExternalEffect` through `effects.ts`, or a need when no
 *     usable adapter exists — never a second effects engine.
 *
 * Built from two branches that modelled this independently. The obligation,
 * its event log, the derived reading and the refund state machine are PR
 * #124's; the agreement it hangs off, the one-per-agreement grain and the deal
 * position it feeds are the first-dollar journey's.
 *
 * ---------------------------------------------------------------------------
 * Four rules, each one a way this could most easily have lied
 * ---------------------------------------------------------------------------
 *
 * **Nothing derivable is stored.** Where an obligation stands is
 * `readObligation` over its rows, its events and the work it points at.
 *
 * **Work complete is not delivered, delivered is not accepted.** Software and
 * research completion are read from the Factory's and the pipeline's own rows
 * (§27). Delivery is recorded with what was delivered, and a partial delivery
 * never completes the whole promise. Acceptance is recorded against the
 * agreement's own acceptance condition, with the buyer's evidence.
 *
 * **An unknown refund stays unknown.** A refund whose provider did not answer
 * is `REFUND_UNKNOWN`; the tick never sends it again; a person's answer closes
 * the effect operation itself, so a late provider reply cannot reopen it. The
 * `REFUND` money entry is written only on a confirmed refund, carrying the
 * provider's reference, and every pending or unknown refund counts against what
 * may still be refunded.
 *
 * **A failed obligation is never revenue.** Completion needs the work done, the
 * whole promise delivered, the buyer's acceptance, every refund resolved and no
 * recorded failure; and a deal is collected only when every live agreement's
 * obligation is complete and the money has settled (`position.ts`).
 */
import { createHash } from 'node:crypto';
import {
  claimFulfillmentWork,
  declareFulfillment,
  fulfillmentEvents,
  fulfillmentForAgreement,
  getFulfillment,
  recordFulfillmentEvent,
  releaseFulfillmentWork,
  unresolvedRefundCents,
} from '../../../repos/cashFulfillment.ts';
import { agreementsFor, agreementsInProject, getAgreement } from '../../../repos/cashJourney.ts';
import { getDb } from '../../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { listMoneyEntries, totalsByKind } from '../../../repos/cashLedger.ts';
import { serializeCash } from '../../../repos/cashLock.ts';
import { getOpportunity, listNeeds, needForKey, openNeedForKey, transitionOpportunity } from '../../../repos/cashPortfolio.ts';
import { getCampaignByChangeRequest, getChangeRequest } from '../../../repos/factory.ts';
import { getCandidate } from '../../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../../repos/russellMissions.ts';
import { listAttempts, operationsByCorrelation, resolveUncertain } from '../../../repos/idempotency.ts';
import { ContractError, submitObjective } from '../../factory/contract.ts';
import { capture } from '../../russell/judgment.ts';
import { closeNeed, raiseNeed } from '../needs.ts';
import { readNeedCondition } from '../conditions.ts';
import { REFUND_NAMESPACE, refundAdapter, sendRefund } from '../effects.ts';
import { recordMoneyEvent, refuse, type Outcome } from '../opportunities.ts';
import { OperationConflict, OperationInProgress } from '../../effects/engine.ts';
import type { CashOpportunity } from '../../../domain/types.ts';
import type { CashAgreement } from '../../../domain/cashJourney.ts';
import {
  FULFILLMENT_KINDS,
  RECORDABLE_FULFILLMENT_EVENTS,
  type CashFulfillment,
  type CashFulfillmentEvent,
  type FulfillmentKind,
  type RecordableFulfillmentEvent,
} from '../../../domain/cashFulfillment.ts';

/** Who Brain records itself as, on rows it writes from the tick. */
const BRAIN = 'BRAIN';

/** Where an obligation's work and delivery may happen: after the first action. */
const PERFORMING = new Set(['EXECUTING', 'DELIVERING']);

/** A refusal inside the cash lock, thrown so the transaction rolls back whole. */
class RefusedInLock extends Error {}

function digest(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((one) => String(one ?? '').trim()).join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function isFulfillmentKind(value: unknown): value is FulfillmentKind {
  return typeof value === 'string' && (FULFILLMENT_KINDS as readonly string[]).includes(value);
}

export function isRecordableEvent(value: unknown): value is RecordableFulfillmentEvent {
  return (
    typeof value === 'string' && (RECORDABLE_FULFILLMENT_EVENTS as readonly string[]).includes(value)
  );
}

/** An agreement on this project, read back and checked rather than trusted. */
async function agreementInProject(projectId: string, agreementId: string): Promise<CashAgreement | null> {
  const agreement = await getAgreement(agreementId);
  return agreement && agreement.projectId === projectId ? agreement : null;
}

/* --------------------------------------------------------------------------
 * Declaring the obligation
 * ------------------------------------------------------------------------ */

/**
 * Say how an agreement is fulfilled: who performs it, and by what means.
 *
 * The kind is a person's statement rather than an inference: deciding from an
 * opportunity's prose whether it is a software job would be §25's Westbrook
 * defect at the one field that decides what work Brain creates. What was
 * promised and what proves it landed are the agreement's, and not restated.
 */
export async function declare(input: {
  projectId: string;
  agreementId: string;
  kind: string;
  performer: string;
  repositoryRemote?: string | null;
  repositoryRoot?: string | null;
  baseBranch?: string | null;
  mutationScope?: string[];
  supplierName?: string | null;
  actorRef: string;
}): Promise<Outcome<CashFulfillment>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  if (agreement.state !== 'AGREED') {
    return refuse('This agreement was released, so there is no obligation to fulfil any more.');
  }
  const opportunity = await getOpportunity(agreement.opportunityId);
  if (!opportunity || !PERFORMING.has(opportunity.state)) {
    return refuse(
      `This is ${opportunity?.state.toLowerCase() ?? 'gone'}. An obligation is performed while the piece ` +
        'is being executed or delivered.',
    );
  }
  if (!isFulfillmentKind(input.kind)) {
    return refuse(
      `"${input.kind}" is not a way Brain knows an obligation is performed. It is one of: ` +
        `${FULFILLMENT_KINDS.join(', ')}. A capability Brain does not have is a need, not a kind.`,
    );
  }
  const performer = input.performer.trim();
  if (!performer) return refuse('Name who or what performs it. An obligation nobody is named for is not done.');
  const remote = input.repositoryRemote?.trim() || null;
  const root = input.repositoryRoot?.trim() || null;
  if (input.kind === 'SOFTWARE' && !remote && !root) {
    return refuse(
      'Software is built by the Factory, which needs to know which repository the work is in. ' +
        'Name the repository; whether this project may change it is still the Factory’s decision.',
    );
  }
  const supplier = input.supplierName?.trim() || null;
  if (input.kind === 'SUPPLIER' && !supplier) {
    return refuse('Name the supplier or contractor, so their liability and delivery can be tracked.');
  }

  const declared = await declareFulfillment({
    projectId: input.projectId,
    opportunityId: agreement.opportunityId,
    agreementId: agreement.id,
    kind: input.kind,
    performer,
    repositoryRemote: remote,
    repositoryRoot: root,
    baseBranch: input.baseBranch?.trim() || null,
    mutationScope: input.mutationScope ?? [],
    supplierName: supplier,
    declaredBy: input.actorRef,
  });
  if (!declared.created && !declared.revised) {
    return {
      ok: true,
      value: declared.fulfillment,
      message:
        'Work already exists for this obligation, or something is recorded against it, so the ' +
        'declaration stays as it was. Nothing was changed.',
    };
  }
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: agreement.opportunityId,
    kind: declared.created ? 'CASH_FULFILLMENT_DECLARED' : 'CASH_FULFILLMENT_REVISED',
    actorRef: input.actorRef,
    summary: `${input.kind.toLowerCase()} fulfillment by ${performer}: ${agreement.deliverable}`,
    detail: { fulfillmentId: declared.fulfillment.id, agreementId: agreement.id, kind: input.kind },
  });
  // A person's or a supplier's work has nothing for Brain to create, so it is
  // opened now rather than on the next pass; the guarded claim makes the tick
  // doing it too a no-op.
  if (input.kind === 'PERSON' || input.kind === 'SUPPLIER') {
    const pass: FulfillmentPass = { workCreated: [], needsRaised: [], needsSettled: [], refundsSettled: [] };
    await createWork(pass, declared.fulfillment, agreement, opportunity);
  }
  const after = (await getFulfillment(declared.fulfillment.id))!;
  return {
    ok: true,
    value: after,
    message: after.workCreatedAt
      ? `Recorded. Waiting on ${after.performer} to do the work.`
      : 'Recorded. Brain creates the work for it on the next pass.',
  };
}

/* --------------------------------------------------------------------------
 * Reading where it stands
 * ------------------------------------------------------------------------ */

export type WorkState =
  | 'NOT_CREATED'
  | 'AWAITING_APPROVAL'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'WAITING_ON_PERSON'
  | 'COMPLETE'
  | 'FAILED';
export type DeliveryState = 'NOT_DELIVERED' | 'PARTIAL' | 'DELIVERED';
export type AcceptanceState = 'AWAITING_DELIVERY' | 'AWAITING_ACCEPTANCE' | 'ACCEPTED' | 'REJECTED';
export type RefundState = 'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';
export type ObligationStage =
  | 'REQUIRED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'REJECTED'
  | 'ACCEPTED'
  | 'FAILED'
  | 'COMPLETE'
  | 'RELEASED';

export interface RefundReading {
  refundKey: string;
  amountCents: number;
  reason: string;
  state: RefundState;
  /** The provider's or bank's reference, on a confirmed refund. */
  reference: string | null;
  authorizedAt: string;
  outcomeDetail: string | null;
}

export interface ObligationReading {
  opportunityId: string;
  agreement: CashAgreement;
  fulfillment: CashFulfillment | null;
  work: {
    state: WorkState;
    ref: string | null;
    /** What the work produced: a pull request, a commit, a document. */
    artifact: string | null;
    detail: string;
  };
  delivery: {
    state: DeliveryState;
    portions: { detail: string; evidence: string | null; at: string }[];
    evidence: string | null;
    deliveredAt: string | null;
  };
  acceptance: {
    state: AcceptanceState;
    condition: string;
    evidence: string | null;
    reason: string | null;
  };
  refunds: RefundReading[];
  failure: { kind: string; reason: string; at: string } | null;
  stage: ObligationStage;
  /**
   * True only when every condition of the obligation's completion holds: work
   * complete, the whole promise delivered, accepted, no failure, every refund
   * resolved. Says nothing about money; the deal's position adds that.
   */
  complete: boolean;
  outstanding: string[];
  brainNext: string[];
  personNext: string[];
}

async function readWork(fulfillment: CashFulfillment, events: CashFulfillmentEvent[]): Promise<ObligationReading['work']> {
  if (!fulfillment.workCreatedAt) {
    return { state: 'NOT_CREATED', ref: null, artifact: null, detail: 'No work exists for this yet.' };
  }
  if (fulfillment.kind === 'SOFTWARE' && fulfillment.workRef) {
    const request = await getChangeRequest(fulfillment.workRef);
    if (!request) {
      return { state: 'FAILED', ref: fulfillment.workRef, artifact: null, detail: 'The Factory change request this obligation points at no longer exists.' };
    }
    if (request.state === 'WITHDRAWN') {
      return { state: 'FAILED', ref: request.id, artifact: null, detail: 'The change request was withdrawn.' };
    }
    if (request.state === 'DRAFT') {
      return {
        state: 'AWAITING_APPROVAL',
        ref: request.id,
        artifact: null,
        detail: 'The Factory objective is written and waits for a person to approve it on Build.',
      };
    }
    const campaign = await getCampaignByChangeRequest(request.id);
    if (!campaign) {
      return { state: 'IN_PROGRESS', ref: request.id, artifact: null, detail: 'Approved; the campaign is starting.' };
    }
    const artifact = campaign.prUrl ?? campaign.prRef ?? campaign.integrationSha ?? null;
    if (campaign.state === 'COMPLETE' || campaign.state === 'AWAITING_RELEASE') {
      return {
        state: 'COMPLETE',
        ref: request.id,
        artifact,
        detail:
          campaign.state === 'COMPLETE'
            ? 'The Factory finished: the change is integrated, reviewed and verified.'
            : 'The Factory finished and the release waits for a person. Nothing is deployed by this.',
      };
    }
    if (campaign.state === 'CANCELLED') {
      return { state: 'FAILED', ref: request.id, artifact, detail: 'The Factory campaign was cancelled.' };
    }
    if (campaign.state === 'BLOCKED') {
      return {
        state: 'BLOCKED',
        ref: request.id,
        artifact,
        detail: `The Factory campaign is blocked: ${campaign.blockerDetail ?? campaign.blockerKind ?? 'no reason recorded'}.`,
      };
    }
    return { state: 'IN_PROGRESS', ref: request.id, artifact, detail: `The Factory campaign is ${campaign.state.toLowerCase()}.` };
  }
  if (fulfillment.kind === 'RESEARCH' && fulfillment.workRef) {
    let candidate = await getCandidate(fulfillment.workRef);
    // An idea that folded into another is answered by the one it folded into.
    for (let hops = 0; candidate?.canonicalCandidateId && hops < 4; hops += 1) {
      candidate = await getCandidate(candidate.canonicalCandidateId);
    }
    const mission = candidate ? await latestMissionForCandidate(candidate.id) : null;
    if (!mission) {
      if (candidate?.state === 'PARKED') {
        return { state: 'BLOCKED', ref: fulfillment.workRef, artifact: null, detail: `The research idea is parked: ${candidate.reason ?? 'no reason recorded'}.` };
      }
      return {
        state: 'QUEUED',
        ref: fulfillment.workRef,
        artifact: null,
        detail: 'Captured as a research idea. Whether it launches is the standing research authority’s decision.',
      };
    }
    if (mission.state === 'DONE') {
      return mission.documentId
        ? { state: 'COMPLETE', ref: fulfillment.workRef, artifact: mission.documentId, detail: 'The research is filed and audited.' }
        : { state: 'FAILED', ref: fulfillment.workRef, artifact: null, detail: 'The research mission finished without filing a document.' };
    }
    if (mission.state === 'FAILED' || mission.state === 'CANCELLED') {
      return {
        state: 'FAILED',
        ref: fulfillment.workRef,
        artifact: null,
        detail: `The research mission ${mission.state.toLowerCase()}: ${mission.terminalReason ?? 'no reason recorded'}.`,
      };
    }
    if (mission.state === 'NEEDS_HUMAN') {
      return {
        state: 'WAITING_ON_PERSON',
        ref: fulfillment.workRef,
        artifact: null,
        detail: `The research stopped at a decision only a person can make: ${mission.waitingOn ?? 'see Needs You'}.`,
      };
    }
    return { state: 'IN_PROGRESS', ref: fulfillment.workRef, artifact: null, detail: `The research mission is ${mission.state.toLowerCase()}.` };
  }
  // A person or a supplier: the obligation is the work, and only a recorded
  // completion with its evidence, in this attempt, says it is done.
  const done = [...events].reverse().find((one) => one.kind === 'WORK_COMPLETE');
  if (done) return { state: 'COMPLETE', ref: null, artifact: done.evidenceRef, detail: done.detail };
  return {
    state: 'WAITING_ON_PERSON',
    ref: null,
    artifact: null,
    detail: `Waiting on ${fulfillment.kind === 'SUPPLIER' ? (fulfillment.supplierName ?? fulfillment.performer) : fulfillment.performer} to do the work.`,
  };
}

function readRefunds(events: CashFulfillmentEvent[]): RefundReading[] {
  const out = new Map<string, RefundReading>();
  for (const event of events) {
    if (!event.refundKey) continue;
    if (event.kind === 'REFUND_AUTHORIZED') {
      out.set(event.refundKey, {
        refundKey: event.refundKey,
        amountCents: event.amountCents ?? 0,
        reason: event.detail,
        state: 'PENDING',
        reference: null,
        authorizedAt: event.createdAt,
        outcomeDetail: null,
      });
      continue;
    }
    const refund = out.get(event.refundKey);
    // A confirmed or failed refund is settled for good; an unknown one is
    // superseded only by a confirmation or a failure.
    if (!refund || refund.state === 'CONFIRMED' || refund.state === 'FAILED') continue;
    if (event.kind === 'REFUND_CONFIRMED') {
      refund.state = 'CONFIRMED';
      refund.reference = event.evidenceRef;
      refund.outcomeDetail = event.detail;
    } else if (event.kind === 'REFUND_FAILED') {
      refund.state = 'FAILED';
      refund.outcomeDetail = event.detail;
    } else if (event.kind === 'REFUND_UNKNOWN') {
      refund.state = 'UNKNOWN';
      refund.outcomeDetail = event.detail;
    }
  }
  return [...out.values()];
}

/** How many rejections came before: a redelivery after each is a new round. */
function roundOf(events: CashFulfillmentEvent[]): number {
  return events.filter((one) => one.kind === 'REJECTED').length;
}

/**
 * Where one agreement's obligation stands, derived from rows. Writes nothing.
 */
export async function readObligation(agreement: CashAgreement): Promise<ObligationReading> {
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  const events = fulfillment ? await fulfillmentEvents(fulfillment.id) : [];
  const work = fulfillment
    ? await readWork(fulfillment, events)
    : { state: 'NOT_CREATED' as const, ref: null, artifact: null, detail: 'Nobody has said how this is fulfilled.' };

  let lastDelivered = -1;
  let lastDecision = -1;
  const portions: ObligationReading['delivery']['portions'] = [];
  let failure: ObligationReading['failure'] = null;
  events.forEach((event, index) => {
    if (event.kind === 'DELIVERED') lastDelivered = index;
    if (event.kind === 'PARTIALLY_DELIVERED') portions.push({ detail: event.detail, evidence: event.evidenceRef, at: event.createdAt });
    if (event.kind === 'ACCEPTED' || event.kind === 'REJECTED') lastDecision = index;
    if (event.kind === 'FAILED' || event.kind === 'SUPPLIER_FAILED' || event.kind === 'ABANDONED') {
      failure = { kind: event.kind, reason: event.detail, at: event.createdAt };
    }
  });
  if (!failure && work.state === 'FAILED') {
    failure = { kind: 'WORK_FAILED', reason: work.detail, at: fulfillment?.updatedAt ?? agreement.updatedAt };
  }
  const delivered = lastDelivered >= 0 ? events[lastDelivered]! : null;
  // A delivery a later rejection answered no longer stands as the delivery.
  const standingDelivery = delivered && !(lastDecision > lastDelivered && events[lastDecision]!.kind === 'REJECTED') ? delivered : null;
  const deliveryState: DeliveryState = standingDelivery ? 'DELIVERED' : portions.length > 0 || delivered ? 'PARTIAL' : 'NOT_DELIVERED';

  const condition = agreement.acceptanceCondition;
  const decision = lastDecision >= 0 ? events[lastDecision]! : null;
  let acceptance: ObligationReading['acceptance'];
  if (decision && lastDecision > lastDelivered && (decision.kind === 'REJECTED' || delivered)) {
    acceptance =
      decision.kind === 'ACCEPTED'
        ? { state: 'ACCEPTED', condition, evidence: decision.evidenceRef, reason: decision.detail }
        : { state: 'REJECTED', condition, evidence: decision.evidenceRef, reason: decision.detail };
  } else if (standingDelivery) {
    acceptance = { state: 'AWAITING_ACCEPTANCE', condition, evidence: null, reason: null };
  } else {
    acceptance = { state: 'AWAITING_DELIVERY', condition, evidence: null, reason: null };
  }

  const refunds = readRefunds(events);
  const unresolved = refunds.filter((one) => one.state === 'PENDING' || one.state === 'UNKNOWN');
  const released = agreement.state === 'RELEASED';

  const outstanding: string[] = [];
  if (released) outstanding.push(`the agreement was released: ${agreement.releasedReason ?? 'no reason recorded'}`);
  if (!fulfillment) outstanding.push('nobody has said how this is fulfilled');
  if (failure) outstanding.push(`the obligation failed: ${(failure as { reason: string }).reason}`);
  if (work.state !== 'COMPLETE') outstanding.push(`the work is not complete: ${work.detail}`);
  if (deliveryState !== 'DELIVERED') {
    outstanding.push(deliveryState === 'PARTIAL' ? 'only part of the promise has been delivered' : 'nothing has been delivered yet');
  }
  if (acceptance.state !== 'ACCEPTED') {
    outstanding.push(
      acceptance.state === 'REJECTED'
        ? `the buyer rejected the delivery: ${acceptance.reason}`
        : 'the buyer has not accepted it against the agreed condition',
    );
  }
  if (unresolved.length > 0) outstanding.push(`${unresolved.length} authorized refund(s) are not resolved`);
  const complete = outstanding.length === 0;

  const stage: ObligationStage = complete
    ? 'COMPLETE'
    : released
      ? 'RELEASED'
      : failure
        ? 'FAILED'
        : acceptance.state === 'ACCEPTED'
          ? 'ACCEPTED'
          : acceptance.state === 'REJECTED'
            ? 'REJECTED'
            : deliveryState === 'DELIVERED'
              ? 'DELIVERED'
              : fulfillment?.workCreatedAt
                ? 'IN_PROGRESS'
                : 'REQUIRED';

  const brainNext: string[] = [];
  const personNext: string[] = [];
  if (!released) {
    if (!fulfillment) {
      personNext.push('Say how this is fulfilled: software, research, a person, or a supplier.');
    } else {
      if (!fulfillment.workCreatedAt && !failure) brainNext.push('Create the work for this obligation on the next pass.');
      if (work.state === 'AWAITING_APPROVAL') personNext.push('Approve the Factory objective on Build.');
      if (work.state === 'WAITING_ON_PERSON' && fulfillment.kind !== 'RESEARCH') {
        personNext.push(`Record the work as complete, with what proves it, once ${fulfillment.performer} has done it.`);
      }
      if (work.state === 'WAITING_ON_PERSON' && fulfillment.kind === 'RESEARCH') {
        personNext.push('Answer the research mission’s question in Needs You.');
      }
      if ((work.state === 'IN_PROGRESS' || work.state === 'QUEUED') && !failure) {
        brainNext.push('Watch the work through to completion; nothing is needed from a person.');
      }
      if (work.state === 'COMPLETE' && deliveryState !== 'DELIVERED' && !failure) {
        personNext.push('Deliver it to the buyer and record what was delivered.');
      }
      if (acceptance.state === 'AWAITING_ACCEPTANCE') personNext.push('Record the buyer’s acceptance, or rejection, with their evidence.');
      if (acceptance.state === 'REJECTED' && !failure) personNext.push('Redeliver against the condition, or record the obligation as failed.');
      if (failure && (failure as { kind: string }).kind === 'WORK_FAILED') {
        personNext.push('Retry the work with what changed, or record the obligation as failed or abandoned.');
      }
    }
  }
  for (const refund of unresolved) {
    if (refund.state === 'UNKNOWN') {
      personNext.push(`Establish with the provider whether refund ${refund.refundKey} happened. Brain will not send it again.`);
    } else if (refundAdapter()) {
      brainNext.push(`Send refund ${refund.refundKey} through the provider.`);
    } else {
      personNext.push(`Pay out refund ${refund.refundKey} and confirm it with the provider’s reference.`);
    }
  }

  return {
    opportunityId: agreement.opportunityId,
    agreement,
    fulfillment,
    work,
    delivery: {
      state: deliveryState,
      portions,
      evidence: standingDelivery?.evidenceRef ?? null,
      deliveredAt: standingDelivery?.createdAt ?? null,
    },
    acceptance,
    refunds,
    failure,
    stage,
    complete,
    outstanding,
    brainNext,
    personNext,
  };
}

/** Every agreement's obligation on one opportunity, oldest agreement first. */
export async function readObligations(opportunityId: string): Promise<ObligationReading[]> {
  const out: ObligationReading[] = [];
  for (const agreement of await agreementsFor(opportunityId)) out.push(await readObligation(agreement));
  return out;
}

/* --------------------------------------------------------------------------
 * What happened
 * ------------------------------------------------------------------------ */

/**
 * Record something that happened to an obligation.
 *
 *   * `WORK_COMPLETE` only for a person or a supplier, with what proves it;
 *   * `DELIVERED` only once the work is complete, with what was delivered;
 *     `PARTIALLY_DELIVERED` at any point, naming the part — and never enough;
 *   * `ACCEPTED` only after a full delivery, carrying the buyer's evidence;
 *   * `REJECTED` after something was delivered, with the buyer's reason;
 *   * `FAILED`, `SUPPLIER_FAILED`, `ABANDONED` with the reason.
 *
 * Nothing after a recorded failure, and nothing after completion — refunds
 * have their own route. The key is the content within a delivery round, so an
 * exact resubmission is the same row and a redelivery after a rejection is a
 * new one.
 */
export async function recordEvent(input: {
  projectId: string;
  agreementId: string;
  kind: string;
  detail: string;
  evidenceRef?: string | null;
  actorRef: string;
}): Promise<Outcome<ObligationReading>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  if (!fulfillment) return refuse('Say how this is fulfilled first, so there is an obligation to record this against.');
  if (!isRecordableEvent(input.kind)) {
    return refuse(`"${input.kind}" is not something recorded here. It is one of: ${RECORDABLE_FULFILLMENT_EVENTS.join(', ')}.`);
  }
  const detail = input.detail.trim();
  const evidence = input.evidenceRef?.trim() || null;
  if (!detail) return refuse('Say what happened, in words somebody can check later.');

  const before = await readObligation(agreement);
  const events = await fulfillmentEvents(fulfillment.id);
  const key = `event:${input.kind}:${roundOf(events)}:${digest(detail, evidence)}`;
  if (events.some((one) => one.requestKey === key)) {
    return { ok: true, value: before, message: 'Already recorded.' };
  }
  if (agreement.state === 'RELEASED') {
    return refuse('This agreement was released; nothing more is recorded against its obligation except refunds.');
  }
  if (before.complete) {
    return refuse('This obligation is complete: delivered, accepted and closed. A further problem is a refund or a new agreement.');
  }
  const closingOverWork = before.failure?.kind === 'WORK_FAILED' && (input.kind === 'FAILED' || input.kind === 'ABANDONED');
  if (before.failure && !closingOverWork) {
    return refuse(
      `This obligation already failed (${before.failure.reason}). Nothing more is recorded against ` +
        'it except refunds; a new agreement is a new obligation.',
    );
  }
  if (['WORK_COMPLETE', 'DELIVERED', 'PARTIALLY_DELIVERED', 'ACCEPTED'].includes(input.kind) && !evidence) {
    return refuse(`${input.kind} needs what proves it — a reference somebody else can look at. A statement that it happened is a claim, not evidence.`);
  }
  switch (input.kind) {
    case 'WORK_COMPLETE':
      if (fulfillment.kind === 'SOFTWARE' || fulfillment.kind === 'RESEARCH') {
        return refuse(
          `${fulfillment.kind.toLowerCase()} work is complete when the ${fulfillment.kind === 'SOFTWARE' ? 'Factory' : 'research pipeline'} ` +
            'says so, from its own rows. Somebody saying it is done is not evidence.',
        );
      }
      if (!fulfillment.workCreatedAt) return refuse('The work for this has not been opened yet.');
      break;
    case 'DELIVERED':
      if (before.work.state !== 'COMPLETE') {
        return refuse(`The work is not complete (${before.work.detail}), so the whole promise cannot have been delivered. Record what part was delivered instead.`);
      }
      break;
    case 'ACCEPTED':
      if (before.delivery.state !== 'DELIVERED') return refuse('Nothing has been fully delivered, so the buyer cannot have accepted it.');
      if (before.acceptance.state === 'ACCEPTED') return { ok: true, value: before, message: 'Already accepted.' };
      break;
    case 'REJECTED':
      if (before.delivery.state === 'NOT_DELIVERED') return refuse('Nothing has been delivered, so there is nothing for the buyer to reject.');
      break;
    case 'SUPPLIER_FAILED':
      if (fulfillment.kind !== 'SUPPLIER') return refuse('Only a supplier obligation has a supplier to fail.');
      break;
  }

  const recorded = await recordFulfillmentEvent({
    projectId: input.projectId,
    fulfillmentId: fulfillment.id,
    opportunityId: agreement.opportunityId,
    kind: input.kind,
    detail,
    evidenceRef: evidence,
    recordedBy: input.actorRef,
    requestKey: key,
  });
  if (recorded.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: agreement.opportunityId,
      kind: `CASH_FULFILLMENT_${input.kind}`,
      actorRef: input.actorRef,
      summary: `${input.kind.toLowerCase().replace(/_/g, ' ')}: ${detail}`,
      detail: { fulfillmentId: fulfillment.id, agreementId: agreement.id, evidenceRef: evidence, eventId: recorded.event.id },
    });
  }
  // Not gated on `created`: a crash between the event and this move is
  // finished by the retry (or the tick) rather than stranding the piece.
  if (input.kind === 'DELIVERED' || input.kind === 'PARTIALLY_DELIVERED') {
    await moveToDelivering(agreement.opportunityId, input.actorRef);
  }
  return { ok: true, value: await readObligation((await getAgreement(agreement.id))!), message: recorded.created ? 'Recorded.' : 'Already recorded.' };
}

/**
 * EXECUTING → DELIVERING once something has been delivered on a live
 * obligation. That is what DELIVERING means: delivery has begun, read from the
 * obligation's own rows rather than a button. Idempotent; a no-op past it.
 */
export async function moveToDelivering(opportunityId: string, actorRef: string): Promise<boolean> {
  const readings = await readObligations(opportunityId);
  const begun = readings.some((one) => one.agreement.state === 'AGREED' && one.delivery.state !== 'NOT_DELIVERED');
  if (!begun) return false;
  const moved = await transitionOpportunity({ id: opportunityId, from: ['EXECUTING'], to: 'DELIVERING' });
  if (moved) {
    const opportunity = (await getOpportunity(opportunityId))!;
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId,
      kind: 'CASH_DELIVERING',
      actorRef,
      summary: 'Something agreed has been delivered, so this is being delivered.',
      detail: {},
    });
  }
  return moved;
}

/* --------------------------------------------------------------------------
 * Costs
 * ------------------------------------------------------------------------ */

export const FULFILLMENT_COST_KINDS = [
  'SUPPLIER_COMMITMENT',
  'SUPPLIER_COST_REDUCED',
  'SUPPLIER_PAYMENT',
  'INTERNAL_COST',
] as const;
export type FulfillmentCostKind = (typeof FULFILLMENT_COST_KINDS)[number];

async function moneyKeyExists(projectId: string, key: string): Promise<boolean> {
  const row = await getDb().get<{ id: string }>(
    'SELECT id FROM cash_money_entries WHERE project_id = ? AND idempotency_key = ?',
    [projectId, key],
  );
  return Boolean(row);
}

/** What this obligation still owes its supplier, read from its own ledger keys. */
async function owedToSupplier(projectId: string, fulfillmentId: string): Promise<number> {
  const rows = await getDb().all<{ kind: string; total: number }>(
    `SELECT kind, SUM(amount_cents) AS total FROM cash_money_entries
      WHERE project_id = ? AND idempotency_key LIKE ?
        AND kind IN ('UNPAID_COMMITMENT', 'COMMITMENT_PAID', 'COMMITMENT_RELEASED')
      GROUP BY kind`,
    [projectId, `fulfillment-cost:${fulfillmentId}:%`],
  );
  const of = (kind: string) => Number(rows.find((one) => one.kind === kind)?.total ?? 0);
  return Math.max(0, of('UNPAID_COMMITMENT') - of('COMMITMENT_PAID') - of('COMMITMENT_RELEASED'));
}

/**
 * A cost of fulfilling, recorded into the ledger that already exists — the
 * ledger's own kinds, so the arithmetic `money.ts` refuses to get wrong holds:
 *
 *   * a supplier's **commitment** is `UNPAID_COMMITMENT` — owed, not yet a cost;
 *   * a commitment that **shrank** before it was paid is `COMMITMENT_RELEASED`,
 *     bounded by what is still owed — a cost change is an entry, never an edit;
 *   * a supplier's **payment** is `COST`, plus `COMMITMENT_PAID` for the part of
 *     it that closes what was owed, so one dollar is never counted twice;
 *   * an **internal** incremental cost is `COST`.
 *
 * Only what happened: no estimate kind, and a payment needs its reference.
 * Every key is derived from the obligation and the content.
 */
export async function recordCost(input: {
  projectId: string;
  agreementId: string;
  kind: string;
  amountCents: number;
  detail: string;
  reference?: string | null;
  actorRef: string;
}): Promise<Outcome<ObligationReading>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  if (!fulfillment) return refuse('Say how this is fulfilled first, so the cost has an obligation to belong to.');
  if (!(FULFILLMENT_COST_KINDS as readonly string[]).includes(input.kind)) {
    return refuse(`"${input.kind}" is not a fulfillment cost. It is one of: ${FULFILLMENT_COST_KINDS.join(', ')}.`);
  }
  const kind = input.kind as FulfillmentCostKind;
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(input.amountCents) || amount !== input.amountCents || amount <= 0) {
    return refuse('An amount is a whole number of cents greater than zero.');
  }
  const detail = input.detail.trim();
  const reference = input.reference?.trim() || null;
  if (!detail) return refuse('Say what the money was for, as it actually happened. An estimate is not a cost.');
  if (kind !== 'INTERNAL_COST' && fulfillment.kind !== 'SUPPLIER') {
    return refuse('A supplier cost belongs to an obligation a supplier performs.');
  }
  if (kind === 'SUPPLIER_PAYMENT' && !reference) return refuse('A payment to a supplier needs the reference that proves the money left.');
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');

  const key = `fulfillment-cost:${fulfillment.id}:${kind}:${digest(amount, detail, reference)}`;
  const supplier = fulfillment.supplierName ?? fulfillment.performer;
  /*
   * Every decision under the project's cash lock and in one transaction: the
   * check that a payment or a reduction fits what is owed, and the entries it
   * writes. Outside the lock two payments would each read the same balance and
   * each close all of it. A retry that finds its own key is the same decision,
   * so it is never recomputed against entries recorded since.
   */
  const written = await serializeCash(input.projectId, mode.currency, async (): Promise<Outcome<null>> => {
    if (await moneyKeyExists(input.projectId, key)) return { ok: true, value: null, message: 'Already recorded.' };
    const write = async (entry: { kind: 'UNPAID_COMMITMENT' | 'COMMITMENT_PAID' | 'COMMITMENT_RELEASED' | 'COST'; amount: number; key: string; note: string }) => {
      const done = await recordMoneyEvent({
        projectId: input.projectId,
        opportunityId: agreement.opportunityId,
        kind: entry.kind,
        amountCents: entry.amount,
        currency: mode.currency,
        verifiedReference: reference,
        note: entry.note,
        idempotencyKey: entry.key,
        actorRef: input.actorRef,
      });
      if (!done.ok) throw new RefusedInLock(done.reason);
    };
    if (kind === 'SUPPLIER_COMMITMENT') {
      await write({ kind: 'UNPAID_COMMITMENT', amount, key, note: `${supplier}: ${detail}` });
    } else if (kind === 'SUPPLIER_COST_REDUCED') {
      const owed = await owedToSupplier(input.projectId, fulfillment.id);
      if (amount > owed) {
        throw new RefusedInLock(
          `${owed} cents are still owed to ${supplier} on this obligation, so it cannot fall by ${amount}. ` +
            'A cost that went down after it was paid is money back from the supplier, which is its own entry.',
        );
      }
      await write({ kind: 'COMMITMENT_RELEASED', amount, key, note: `${supplier} now costs less: ${detail}` });
    } else {
      if (kind === 'SUPPLIER_PAYMENT') {
        const closes = Math.min(amount, await owedToSupplier(input.projectId, fulfillment.id));
        if (closes > 0) await write({ kind: 'COMMITMENT_PAID', amount: closes, key: `${key}:closes`, note: `closes what was owed to ${supplier}` });
      }
      await write({ kind: 'COST', amount, key, note: detail });
    }
    return { ok: true, value: null, message: 'Recorded.' };
  }).catch((error: unknown) => {
    if (error instanceof RefusedInLock) return refuse(error.message);
    throw error;
  });
  if (!written.ok) return written;
  return { ok: true, value: await readObligation(agreement), message: 'Recorded in the ledger.' };
}

/* --------------------------------------------------------------------------
 * Refunds
 * ------------------------------------------------------------------------ */

/**
 * What may still be refunded on an opportunity: payments, less refunds already
 * confirmed, less refunds still pending or unknown on any of its obligations —
 * because an unknown refund may have happened, and authorizing against it as
 * though it had not is how a buyer is paid twice. The ledger's own REFUND
 * check (`recordMoneyEvent`) asks the same question with the same helper.
 */
export async function refundableCents(projectId: string, opportunityId: string, currency: string): Promise<{
  paid: number;
  refunded: number;
  unresolved: number;
  refundable: number;
}> {
  const totals = await totalsByKind({ projectId, opportunityId, currency });
  const paid = Number(totals.CUSTOMER_PAYMENT ?? 0);
  const refunded = Number(totals.REFUND ?? 0);
  const unresolved = await unresolvedRefundCents({ projectId, opportunityId });
  return { paid, refunded, unresolved, refundable: paid - refunded - unresolved };
}

/**
 * A person decides the buyer is owed money back on this obligation.
 *
 * Bounded under the cash lock by `refundableCents`, so two people authorizing
 * at once cannot add up to more than was paid. Then Brain sends it if a usable
 * refund adapter exists, and raises a need naming the person's step if not.
 */
export async function authorizeRefund(input: {
  projectId: string;
  agreementId: string;
  amountCents: number;
  reason: string;
  actorRef: string;
}): Promise<Outcome<ObligationReading>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  if (!fulfillment) return refuse('Say how this is fulfilled first, so a refund has an obligation to belong to.');
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(input.amountCents) || amount !== input.amountCents || amount <= 0) {
    return refuse('A refund is a whole number of cents greater than zero.');
  }
  const reason = input.reason.trim();
  if (!reason) return refuse('Say why the buyer is owed this. The reason is what the next deal learns from.');
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');

  /*
   * The key is the request's own content, so a lost reply asked again joins the
   * refund it already made. The one exception is a refund that *failed*:
   * nothing left the account, so the same words are a retry and take the next
   * occurrence. A confirmed refund is never joined into a second one.
   */
  const decided = await serializeCash(
    input.projectId,
    mode.currency,
    async (): Promise<{ refundKey: string; created: boolean } | { refused: string }> => {
      const refunds = readRefunds(await fulfillmentEvents(fulfillment.id));
      const failedBefore = refunds.filter((one) => one.state === 'FAILED' && one.amountCents === amount && one.reason === reason).length;
      const refundKey = failedBefore === 0 ? digest('refund', amount, reason) : digest('refund', amount, reason, failedBefore);
      if (refunds.some((one) => one.refundKey === refundKey)) return { refundKey, created: false };
      const room = await refundableCents(input.projectId, agreement.opportunityId, mode.currency);
      if (amount > room.refundable) {
        return {
          refused:
            `${Math.max(0, room.refundable)} cents are refundable: ${room.paid} paid, ${room.refunded} already ` +
            `refunded and ${room.unresolved} in refunds not yet resolved. A refund larger than what was paid ` +
            'is a payment, not a refund.',
        };
      }
      const recorded = await recordFulfillmentEvent({
        projectId: input.projectId,
        fulfillmentId: fulfillment.id,
        opportunityId: agreement.opportunityId,
        kind: 'REFUND_AUTHORIZED',
        detail: reason,
        amountCents: amount,
        refundKey,
        recordedBy: input.actorRef,
        requestKey: `refund:${refundKey}:authorized`,
      });
      return { refundKey, created: recorded.created };
    },
  );
  if ('refused' in decided) return refuse(decided.refused);
  const { refundKey } = decided;
  if (decided.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: agreement.opportunityId,
      kind: 'CASH_REFUND_AUTHORIZED',
      actorRef: input.actorRef,
      summary: `A refund of ${amount} cents was authorized: ${reason}`,
      detail: { fulfillmentId: fulfillment.id, refundKey, amountCents: amount },
    });
  } else {
    const prior = readRefunds(await fulfillmentEvents(fulfillment.id)).find((one) => one.refundKey === refundKey);
    if (prior?.state === 'CONFIRMED') {
      return {
        ok: true,
        value: await readObligation(agreement),
        message:
          'A refund of this amount for this reason is already confirmed. A second refund needs its own ' +
          'reason, so it cannot be mistaken for a retry of the first.',
      };
    }
  }
  await settleRefund({ fulfillment, agreement, refundKey });
  const after = await readObligation(agreement);
  const refund = after.refunds.find((one) => one.refundKey === refundKey)!;
  return {
    ok: true,
    value: after,
    message:
      refund.state === 'CONFIRMED'
        ? 'Refunded. The provider confirmed it and the ledger records it.'
        : refund.state === 'UNKNOWN'
          ? 'Sent, and the provider did not say what happened. It is recorded as unknown and will not be sent again.'
          : refund.state === 'FAILED'
            ? 'The provider refused the refund. Nothing left the account.'
            : 'Authorized. Brain cannot send refunds here, so a person pays it out and confirms it with the reference.',
  };
}

/** The refund's effect operation, if Brain ever sent it. */
async function refundOperation(agreement: CashAgreement, fulfillment: CashFulfillment, refundKey: string) {
  const correlation = `refund:${agreement.opportunityId}:${fulfillment.id}:${refundKey}`;
  const ops = await operationsByCorrelation({
    projectId: fulfillment.projectId,
    namespaces: [REFUND_NAMESPACE.name],
    correlationPrefix: correlation,
  });
  return ops.find((one) => one.correlationId === correlation) ?? null;
}

/**
 * Take one authorized refund as far as Brain can, once. With a usable adapter:
 * through `runExternalEffect` on a key derived from the refund, so asking again
 * joins the same reservation and an unresolved attempt is never resent. Without
 * one: a need for the person who pays it. An `UNKNOWN` refund is left alone.
 */
async function settleRefund(input: { fulfillment: CashFulfillment; agreement: CashAgreement; refundKey: string }): Promise<void> {
  const refund = readRefunds(await fulfillmentEvents(input.fulfillment.id)).find((one) => one.refundKey === input.refundKey);
  if (!refund || refund.state !== 'PENDING') return;
  const { fulfillment, agreement } = input;
  const opportunity = await getOpportunity(agreement.opportunityId);
  if (!opportunity) return;

  if (!refundAdapter()) {
    await raise({
      projectId: fulfillment.projectId,
      opportunity,
      key: `fulfillment:refund:${fulfillment.id}:${refund.refundKey}`,
      blockedAction: `Pay back ${refund.amountCents} cents to the buyer of "${opportunity.title}"`,
      whyItMatters:
        'A refund was authorized and Brain has no way to send one, so until somebody pays it out the ' +
        'buyer is owed money and the contribution is overstated.',
      recommendedPath:
        'Refund through the provider that took the payment, then confirm it on the obligation with the ' +
        'provider’s reference. That is what writes the REFUND entry.',
      nextStep: `Refund ${refund.amountCents} cents, then confirm refund ${refund.refundKey} with its reference.`,
      completionCondition: `Refund ${refund.refundKey} is confirmed with a provider reference, or recorded as not sent.`,
    });
    return;
  }
  const mode = await getCashMode(fulfillment.projectId);
  if (!mode) return;
  const paymentReferences = (await listMoneyEntries({ projectId: fulfillment.projectId, opportunityId: opportunity.id }))
    .filter((one) => one.kind === 'CUSTOMER_PAYMENT' && one.verifiedReference)
    .map((one) => one.verifiedReference!);
  let outcome;
  try {
    outcome = await sendRefund({
      projectId: fulfillment.projectId,
      opportunityId: opportunity.id,
      fulfillmentId: fulfillment.id,
      refundKey: refund.refundKey,
      amountCents: refund.amountCents,
      currency: mode.currency,
      reason: refund.reason,
      paymentReferences,
    });
  } catch (error) {
    // Another attempt holds the reservation right now. It will record what
    // happened; this one must not guess.
    if (error instanceof OperationInProgress || error instanceof OperationConflict) return;
    throw error;
  }
  if (outcome.status === 'CONFIRMED' || outcome.status === 'RECONCILED' || outcome.status === 'REPLAYED') {
    const receipt =
      outcome.status === 'REPLAYED' ? await replayedReceipt(outcome.operation.id, outcome.operation.resultRef) : outcome.receiptRef;
    if (!receipt) {
      await recordRefundUnknown(input, refund.refundKey, 'The provider replayed the refund without a receipt.');
      return;
    }
    await confirmRefundInternal({ fulfillment, agreement, refund, reference: receipt, detail: 'The provider confirmed the refund.', actorRef: BRAIN });
    return;
  }
  if (outcome.status === 'UNCERTAIN') {
    await recordRefundUnknown(input, refund.refundKey, outcome.reason);
    return;
  }
  await recordFulfillmentEvent({
    projectId: fulfillment.projectId,
    fulfillmentId: fulfillment.id,
    opportunityId: agreement.opportunityId,
    kind: 'REFUND_FAILED',
    detail: 'The provider refused the refund; it is authoritative that nothing left the account.',
    refundKey: refund.refundKey,
    recordedBy: BRAIN,
    requestKey: `refund:${refund.refundKey}:outcome`,
  });
}

async function replayedReceipt(operationId: string, resultRef: string | null): Promise<string | null> {
  for (const attempt of [...(await listAttempts(operationId))].reverse()) {
    if (attempt.receiptRef) return attempt.receiptRef;
  }
  return resultRef;
}

async function recordRefundUnknown(
  input: { fulfillment: CashFulfillment; agreement: CashAgreement },
  refundKey: string,
  reason: string,
): Promise<void> {
  await recordFulfillmentEvent({
    projectId: input.fulfillment.projectId,
    fulfillmentId: input.fulfillment.id,
    opportunityId: input.agreement.opportunityId,
    kind: 'REFUND_UNKNOWN',
    detail: `The refund left and its outcome is unknown: ${reason}`,
    refundKey,
    recordedBy: BRAIN,
    requestKey: `refund:${refundKey}:unknown`,
  });
  const opportunity = await getOpportunity(input.agreement.opportunityId);
  if (!opportunity) return;
  await raise({
    projectId: input.fulfillment.projectId,
    opportunity,
    key: `fulfillment:refund-unknown:${input.fulfillment.id}:${refundKey}`,
    blockedAction: `Establish whether refund ${refundKey} reached the buyer`,
    whyItMatters:
      'The provider did not say whether the refund happened. Sending it again could pay the buyer twice, ' +
      'so Brain will not; and recording it as paid without the provider’s word would be a guess.',
    recommendedPath: 'Look the refund up in the provider’s dashboard and record what it says.',
    nextStep: `Confirm refund ${refundKey} with its reference, or record that it did not happen.`,
    completionCondition: `Refund ${refundKey} is confirmed with a provider reference, or recorded as not sent.`,
  });
}

async function confirmRefundInternal(input: {
  fulfillment: CashFulfillment;
  agreement: CashAgreement;
  refund: RefundReading;
  reference: string;
  detail: string;
  actorRef: string;
}): Promise<Outcome<null>> {
  const mode = await getCashMode(input.fulfillment.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');
  // The money first and the event second, both on keys derived from the
  // refund: a crash between them leaves the ledger right and the next call
  // writes the event, replaying the entry rather than adding a second.
  const written = await recordMoneyEvent({
    projectId: input.fulfillment.projectId,
    opportunityId: input.agreement.opportunityId,
    kind: 'REFUND',
    amountCents: input.refund.amountCents,
    currency: mode.currency,
    verifiedReference: input.reference,
    note: input.refund.reason,
    idempotencyKey: refundLedgerKey(input.fulfillment.id, input.refund.refundKey),
    actorRef: input.actorRef,
    confirmsRefund: { fulfillmentId: input.fulfillment.id, refundKey: input.refund.refundKey },
  });
  if (!written.ok) return written;
  await recordFulfillmentEvent({
    projectId: input.fulfillment.projectId,
    fulfillmentId: input.fulfillment.id,
    opportunityId: input.agreement.opportunityId,
    kind: 'REFUND_CONFIRMED',
    detail: input.detail,
    evidenceRef: input.reference,
    amountCents: input.refund.amountCents,
    refundKey: input.refund.refundKey,
    recordedBy: input.actorRef,
    requestKey: `refund:${input.refund.refundKey}:confirmed`,
  });
  return { ok: true, value: null, message: 'Confirmed.' };
}

/** The ledger key a confirmed refund is written under. */
export function refundLedgerKey(fulfillmentId: string, refundKey: string): string {
  return `refund:${fulfillmentId}:${refundKey}`;
}

/**
 * A person answers an authorized refund with the provider's own word.
 *
 * `confirm` needs the reference that proves the money went back; `not-sent`
 * needs what establishes it did not. Refused while Brain's own send is still
 * waiting on the provider, because the provider's answer would then race the
 * person's. An unknown effect is closed through `resolveUncertain` in the same
 * breath, so a late provider reply cannot reopen it — and the effect and the
 * obligation never disagree about whether the money left.
 */
export async function answerRefund(input: {
  projectId: string;
  agreementId: string;
  refundKey: string;
  answer: 'confirm' | 'not-sent';
  reference: string;
  actorRef: string;
}): Promise<Outcome<ObligationReading>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No refund with that key on this obligation.');
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  const refund = fulfillment
    ? readRefunds(await fulfillmentEvents(fulfillment.id)).find((one) => one.refundKey === input.refundKey)
    : undefined;
  if (!fulfillment || !refund) return refuse('No refund with that key on this obligation.');
  const reference = input.reference.trim();
  if (!reference) {
    return refuse(
      input.answer === 'confirm'
        ? 'A confirmed refund needs the provider’s or bank’s reference. Without it this is a belief.'
        : 'Say what establishes the refund did not happen — the provider’s own record of it.',
    );
  }
  if (refund.state === 'CONFIRMED' || refund.state === 'FAILED') {
    if ((refund.state === 'CONFIRMED') === (input.answer === 'confirm')) {
      return { ok: true, value: await readObligation(agreement), message: 'Already recorded.' };
    }
    return refuse(`This refund is already ${refund.state.toLowerCase()}. A resolved refund is not reopened.`);
  }
  const operation = await refundOperation(agreement, fulfillment, refund.refundKey);
  if (operation && operation.state === 'RESERVED') {
    return refuse('Brain’s send of this refund is still waiting on the provider. Its answer comes first; ask again once it has.');
  }
  if (operation && operation.state === 'UNCERTAIN') {
    await resolveUncertain(
      operation.id,
      input.answer === 'confirm'
        ? { as: 'SUCCEEDED', resultRef: reference, summary: 'A person confirmed the refund with the provider.' }
        : { as: 'FAILED', category: 'PROVIDER_REJECTED', detail: `A person established it did not happen: ${reference}` },
    );
  }
  if (input.answer === 'confirm') {
    const confirmed = await confirmRefundInternal({
      fulfillment,
      agreement,
      refund,
      reference,
      detail: 'A person confirmed the refund with the provider’s reference.',
      actorRef: input.actorRef,
    });
    if (!confirmed.ok) return confirmed;
  } else {
    await recordFulfillmentEvent({
      projectId: input.projectId,
      fulfillmentId: fulfillment.id,
      opportunityId: agreement.opportunityId,
      kind: 'REFUND_FAILED',
      detail: 'A person established the refund did not happen.',
      evidenceRef: reference,
      refundKey: refund.refundKey,
      recordedBy: input.actorRef,
      requestKey: `refund:${refund.refundKey}:not-sent`,
    });
  }
  return { ok: true, value: await readObligation(agreement), message: 'Recorded.' };
}

/* --------------------------------------------------------------------------
 * Retrying failed work
 * ------------------------------------------------------------------------ */

/**
 * A person asks Brain to create the work again after it failed.
 *
 * Only a failure read from the work can be retried — one a person recorded is
 * their decision. The release and the attempt counter move in one guarded
 * statement, so a crash cannot leave the attempt number behind a failed
 * attempt's Factory key, and two people retrying release it once. The failed
 * work keeps its rows; the next pass creates attempt N+1.
 */
export async function retryWork(input: {
  projectId: string;
  agreementId: string;
  reason: string;
  actorRef: string;
}): Promise<Outcome<ObligationReading>> {
  const agreement = await agreementInProject(input.projectId, input.agreementId);
  if (!agreement) return refuse('No agreement with that id.');
  const fulfillment = await fulfillmentForAgreement(agreement.id);
  if (!fulfillment) return refuse('Say how this is fulfilled first.');
  const reason = input.reason.trim();
  if (!reason) return refuse('Say what changed, so the next attempt is not the same one again.');
  const reading = await readObligation(agreement);
  if (reading.failure?.kind !== 'WORK_FAILED' || !fulfillment.workRef) {
    return refuse(
      reading.failure
        ? 'This obligation was recorded as failed by a person. That is their decision, and it is not retried.'
        : 'The work has not failed, so there is nothing to retry.',
    );
  }
  if (!(await releaseFulfillmentWork(fulfillment.id, fulfillment.workRef, fulfillment.workAttempt))) {
    return refuse('Somebody else retried this work a moment ago. It is already being created again.');
  }
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: agreement.opportunityId,
    kind: 'CASH_FULFILLMENT_WORK_RETRIED',
    actorRef: input.actorRef,
    summary: `The work for "${agreement.deliverable}" failed and is being created again: ${reason}`,
    detail: {
      fulfillmentId: fulfillment.id,
      previousRef: fulfillment.workRef,
      attempt: fulfillment.workAttempt + 1,
      failure: reading.failure.reason,
      reason,
    },
  });
  return { ok: true, value: await readObligation(agreement), message: 'Brain creates the work again on the next pass. The failed attempt keeps its rows.' };
}

/* --------------------------------------------------------------------------
 * The tick
 * ------------------------------------------------------------------------ */

export interface FulfillmentPass {
  workCreated: { agreementId: string; kind: FulfillmentKind; ref: string | null }[];
  needsRaised: string[];
  needsSettled: string[];
  refundsSettled: string[];
}

async function raise(input: {
  projectId: string;
  opportunity: CashOpportunity;
  key: string;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  nextStep: string;
  completionCondition: string;
}, pass?: FulfillmentPass): Promise<void> {
  /*
   * A person withdrawing one of these is their answer — "the payment is kept" —
   * and the rows it reads do not change when they say it, so a key whose latest
   * occurrence a person withdrew stays withdrawn. One already open is not
   * raised again.
   */
  const latest = await needForKey(input.projectId, input.key);
  if (latest?.state === 'WITHDRAWN') return;
  if (await openNeedForKey(input.projectId, input.key)) return;
  const raised = await raiseNeed({
    projectId: input.projectId,
    opportunityId: input.opportunity.id,
    actorRef: BRAIN,
    blockedAction: input.blockedAction,
    whyItMatters: input.whyItMatters,
    recommendedPath: input.recommendedPath,
    setupEffort: 'A few minutes.',
    nextStep: input.nextStep,
    completionCondition: input.completionCondition,
    requestKey: input.key,
  });
  if (raised.ok && pass) pass.needsRaised.push(raised.value.id);
}

/**
 * Create the work for one obligation, exactly once per attempt.
 *
 * Idempotent by the obligation and its attempt — a submission key the Factory
 * collides on, an idea `capture` folds into the one already captured — and the
 * claim is a guarded update naming the attempt. So a retry, a restart between
 * the two and two ticks at once all leave one piece of work.
 */
async function createWork(pass: FulfillmentPass, fulfillment: CashFulfillment, agreement: CashAgreement, opportunity: CashOpportunity): Promise<void> {
  const attempt = fulfillment.workAttempt;
  if (fulfillment.kind === 'PERSON' || fulfillment.kind === 'SUPPLIER') {
    if (await claimFulfillmentWork(fulfillment.id, null, attempt)) {
      pass.workCreated.push({ agreementId: agreement.id, kind: fulfillment.kind, ref: null });
      await recordCashEvent({
        projectId: fulfillment.projectId,
        opportunityId: opportunity.id,
        kind: 'CASH_FULFILLMENT_OPENED',
        actorRef: BRAIN,
        summary: `Waiting on ${fulfillment.performer}: ${agreement.deliverable}`,
        detail: { fulfillmentId: fulfillment.id, kind: fulfillment.kind },
      });
    }
    return;
  }
  let ref: string | null = null;
  if (fulfillment.kind === 'SOFTWARE') {
    try {
      const result = await submitObjective({
        projectId: fulfillment.projectId,
        objective: `Fulfil an agreed customer obligation: ${agreement.deliverable}`,
        expectedOutcome: `The buyer can accept it against: ${agreement.acceptanceCondition}`,
        nonGoals: [
          'Deploying anything to a customer: the release stays a person’s decision.',
          'Widening the scope beyond what the buyer agreed to.',
        ],
        acceptanceConditions: [
          { statement: agreement.acceptanceCondition, verification: 'Checked against the agreed acceptance condition before delivery.' },
        ],
        ...(fulfillment.repositoryRemote ? { repositoryRemote: fulfillment.repositoryRemote } : {}),
        ...(fulfillment.repositoryRoot ? { repositoryRoot: fulfillment.repositoryRoot } : {}),
        ...(fulfillment.baseBranch ? { baseBranch: fulfillment.baseBranch } : {}),
        ...(fulfillment.mutationScope.length > 0 ? { mutationScope: fulfillment.mutationScope } : {}),
        submissionKey: attempt === 0 ? `cash-fulfillment-${fulfillment.id}` : `cash-fulfillment-${fulfillment.id}-${attempt}`,
      });
      ref = result.changeRequest.id;
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      await raise({
        projectId: fulfillment.projectId,
        opportunity,
        key: `fulfillment:work:${fulfillment.id}`,
        blockedAction: `Build the software the buyer of "${opportunity.title}" agreed to`,
        whyItMatters: `The Factory refused the objective: ${error.message}`,
        recommendedPath:
          'Fix what the Factory named — most often authorizing and onboarding the repository for this ' +
          'project on Build — and Brain submits the objective again on the next pass.',
        nextStep: 'Resolve the Factory’s refusal on Build.',
        completionCondition: 'Brain has created Factory work for this obligation.',
      }, pass);
      return;
    }
  } else {
    const captured = await capture({
      title: `Deliver to a buyer: ${agreement.deliverable}`.slice(0, 200),
      statement:
        `${agreement.deliverable}\n\nThis is owed to a buyer who agreed to pay for it. It is accepted when: ` +
        `${agreement.acceptanceCondition}` +
        (attempt === 0 ? '' : `\n\nAttempt ${attempt + 1}: the previous attempt failed.`),
      projectId: fulfillment.projectId,
      visibility: 'SHARED',
    });
    if (!captured.candidate) {
      await raise({
        projectId: fulfillment.projectId,
        opportunity,
        key: `fulfillment:work:${fulfillment.id}`,
        blockedAction: `Research what the buyer of "${opportunity.title}" agreed to`,
        whyItMatters: `The research idea could not be captured: ${captured.reason}`,
        recommendedPath: 'Restate the agreement’s deliverable so it is a question research can answer.',
        nextStep: 'Record a revised agreement, or release this one.',
        completionCondition: 'Brain has created research work for this obligation.',
      }, pass);
      return;
    }
    ref = captured.candidate.id;
  }
  if (await claimFulfillmentWork(fulfillment.id, ref, attempt)) {
    pass.workCreated.push({ agreementId: agreement.id, kind: fulfillment.kind, ref });
    await recordCashEvent({
      projectId: fulfillment.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_FULFILLMENT_WORK_CREATED',
      actorRef: BRAIN,
      summary:
        fulfillment.kind === 'SOFTWARE'
          ? `Factory objective ${ref} submitted; a person approves it on Build.`
          : `Research idea ${ref} captured; the standing research authority decides whether it launches.`,
      detail: { fulfillmentId: fulfillment.id, ref, attempt },
    });
  }
}

/**
 * One project's obligations, advanced from rows on the Cash tick.
 *
 * Idempotent from end to end: work is created on keys derived from the
 * obligation and its attempt and claimed by a guarded update, needs are raised
 * under keys, and an unknown refund is never touched. Bounded to agreements on
 * a piece being executed or delivered — plus refunds, which outlive the deal.
 * It runs while the sprint is winding down, because a customer's obligation
 * does not end when discovery does (invariant 40).
 */
export async function advanceFulfillment(projectId: string): Promise<FulfillmentPass> {
  const pass: FulfillmentPass = { workCreated: [], needsRaised: [], needsSettled: [], refundsSettled: [] };
  if (!(await getCashMode(projectId))) return pass;

  for (const agreement of await agreementsInProject(projectId)) {
    const opportunity = await getOpportunity(agreement.opportunityId);
    if (!opportunity) continue;
    const fulfillment = await fulfillmentForAgreement(agreement.id);
    const performing = agreement.state === 'AGREED' && PERFORMING.has(opportunity.state);

    if (!fulfillment) {
      if (performing) {
        await raise({
          projectId,
          opportunity,
          key: `fulfillment:requirement:${agreement.id}`,
          blockedAction: `Fulfil the agreement on "${opportunity.title}": ${agreement.deliverable}`,
          whyItMatters:
            'A buyer agreed and nothing says how the work gets done, so nothing can be created, delivered ' +
            'or accepted for it.',
          recommendedPath:
            'Declare how it is fulfilled — software through the Factory, research through the pipeline, a ' +
            'person, or a supplier — and who performs it.',
          nextStep: 'Declare the fulfillment for this agreement.',
          completionCondition: 'A fulfillment is declared for this agreement.',
        }, pass);
      }
      continue;
    }

    const reading = await readObligation(agreement);
    if (performing && !fulfillment.workCreatedAt && !reading.failure) {
      await createWork(pass, fulfillment, agreement, opportunity);
    }
    for (const refund of reading.refunds) {
      if (refund.state !== 'PENDING') continue;
      await settleRefund({ fulfillment, agreement, refundKey: refund.refundKey });
      pass.refundsSettled.push(refund.refundKey);
    }
    if (reading.failure) {
      const mode = (await getCashMode(projectId))!;
      const room = await refundableCents(projectId, opportunity.id, mode.currency);
      const decided = reading.refunds.some((one) => one.state !== 'FAILED');
      if (room.paid - room.refunded > 0 && !decided) {
        await raise({
          projectId,
          opportunity,
          key: `fulfillment:refund-decision:${fulfillment.id}`,
          blockedAction: `Close out the failed obligation on "${opportunity.title}"`,
          whyItMatters:
            `The buyer paid ${room.paid - room.refunded} cents on this deal and this obligation failed ` +
            `(${reading.failure.reason}). Until somebody decides what is owed back, the contribution reads ` +
            'as revenue it may not be.',
          recommendedPath: 'Authorize a refund for what is owed, or withdraw this need saying why the payment is kept.',
          nextStep: 'Authorize the refund, or withdraw this with the reason.',
          completionCondition: 'A refund is authorized on this obligation and has not failed.',
        }, pass);
      }
    }
    if (opportunity.state === 'EXECUTING') await moveToDelivering(opportunity.id, BRAIN);
  }

  // Close Brain's own needs whose condition now holds, read from the rows.
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.requestKey?.startsWith('fulfillment:')) continue;
    const verdict = await readNeedCondition(need);
    if (!verdict?.holds) continue;
    const closed = await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: verdict.reading,
      actorUserId: BRAIN,
      verifiedBy: 'BRAIN_READ_THE_ROW',
    });
    if (closed.ok) pass.needsSettled.push(need.id);
  }
  return pass;
}

export { getFulfillment };
