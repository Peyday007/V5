/**
 * What happens after a buyer agrees: the obligation, carried to the end.
 *
 * Cash Mode could carry an opportunity to `PIPELINE_AGREED` and then to a
 * settlement, and nothing in between knew what had been promised, who was
 * doing it, whether it had been delivered, whether the buyer accepted it, what
 * it cost, or what to do when it went wrong. `advance` moved a piece to
 * `DELIVERING` on a button press, and "delivered" and "accepted" were not
 * different facts anywhere.
 *
 * This module is that middle, and it is an **entrance** to owners that already
 * exist rather than a second set of them:
 *
 *   * the work is a Factory change request (`submitObjective`) or a Russell
 *     idea (`capture`) — never a second queue — and for a person or a supplier
 *     there is no work object at all, because the obligation is the work;
 *   * the money is `cash_money_entries` through `recordMoneyEvent` — never a
 *     second ledger, and no figure is stored here;
 *   * a missing capability is a `cash_needs` row with a recommended path;
 *   * a refund is `runExternalEffect` through `effects.ts`, or a need when no
 *     adapter exists — never a second effects engine.
 *
 * ---------------------------------------------------------------------------
 * Four rules, each one a way this could most easily have lied
 * ---------------------------------------------------------------------------
 *
 * **Nothing derivable is stored.** Where an obligation stands is `readFulfillment`
 * over the obligation's rows, its events, the ledger and the work it points at.
 * A stored stage would be stale the moment the Factory or the pipeline moved.
 *
 * **Delivered is not complete, and complete is not accepted.** Software and
 * research completion are read from the Factory's and the pipeline's own rows,
 * because a worker saying "done" is not evidence (§27). Delivery is recorded
 * with what was delivered. Acceptance is recorded against the condition the
 * agreement named, with the buyer's evidence — and with no condition there is
 * nothing to accept against, so a need is raised instead of an acceptance.
 *
 * **An unknown refund stays unknown.** A refund whose provider did not answer
 * is `REFUND_UNKNOWN`, the tick never sends it again, and only a person with
 * the provider's own answer moves it. The `REFUND` money entry is written only
 * on a confirmed refund, carrying the provider's reference.
 *
 * **A failed obligation is never revenue.** Commercial completion needs the
 * work complete, the whole promise delivered, the buyer's acceptance, every
 * authorized refund resolved and no recorded failure. A failure after the buyer
 * paid raises a need: the money is a decision a person owes the buyer.
 */
import { createHash } from 'node:crypto';
import {
  claimFulfillmentWork,
  releaseFulfillmentWork,
  declareFulfillment,
  fulfillmentEvents,
  fulfillmentForOpportunity,
  getFulfillment,
  listFulfillments,
  listObservations,
  recordFulfillmentEvent,
  recordObservation,
  supplyAcceptanceCondition,
} from '../../repos/cashFulfillment.ts';
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { totalsByKind } from '../../repos/cashLedger.ts';
import { serializeCash } from '../../repos/cashLock.ts';
import {
  getOpportunity,
  listNeeds,
  needForKey,
  transitionOpportunity,
} from '../../repos/cashPortfolio.ts';
import { getCampaignByChangeRequest, getChangeRequest } from '../../repos/factory.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { ContractError, submitObjective } from '../factory/contract.ts';
import { capture } from '../russell/judgment.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import { readNeedCondition } from './conditions.ts';
import { refundAdapter, sendRefund } from './effects.ts';
import { recordMoneyEvent, refuse, type Outcome } from './opportunities.ts';
import { OperationConflict, OperationInProgress } from '../effects/engine.ts';
import { listAttempts } from '../../repos/idempotency.ts';
import type { CashOpportunity } from '../../domain/types.ts';
import {
  FULFILLMENT_KINDS,
  RECORDABLE_FULFILLMENT_EVENTS,
  type CashFulfillment,
  type CashFulfillmentEvent,
  type CashOutcomeObservation,
  type FulfillmentKind,
  type OutcomeObservationKind,
  type RecordableFulfillmentEvent,
} from '../../domain/cashFulfillment.ts';

/** Who Brain records itself as, on rows it writes from the tick. */
const BRAIN = 'BRAIN';

/** A refusal inside the cash lock, thrown so the transaction rolls back whole. */
class RefusedInLock extends Error {}

function digest(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((one) => String(one ?? '').trim()).join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/* --------------------------------------------------------------------------
 * Declaring the obligation
 * ------------------------------------------------------------------------ */

export function isFulfillmentKind(value: unknown): value is FulfillmentKind {
  return typeof value === 'string' && (FULFILLMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Say how an agreed opportunity is fulfilled.
 *
 * Who performs it, what was promised and what proves it landed. The kind is a
 * person's statement rather than an inference: deciding from an opportunity's
 * prose whether it is a software job would be §25's Westbrook defect at the
 * one field that decides what work Brain creates.
 *
 * The acceptance condition defaults to the one the card already recorded, so a
 * condition the buyer agreed to is not typed twice and cannot drift from the
 * card. With neither, the obligation is still recorded — the tick raises a need
 * for the condition rather than refusing the whole declaration.
 */
export async function declare(input: {
  projectId: string;
  opportunityId: string;
  kind: string;
  promise: string;
  performer: string;
  acceptanceCondition?: string | null;
  repositoryRemote?: string | null;
  repositoryRoot?: string | null;
  baseBranch?: string | null;
  mutationScope?: string[];
  supplierName?: string | null;
  actorRef: string;
}): Promise<Outcome<CashFulfillment>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) {
    return refuse('No opportunity with that id.');
  }
  if (!isFulfillmentKind(input.kind)) {
    return refuse(
      `"${input.kind}" is not a way Brain knows an obligation is performed. It is one of: ` +
        `${FULFILLMENT_KINDS.join(', ')}. A capability Brain does not have is a need, not a kind.`,
    );
  }
  const promise = input.promise.trim();
  const performer = input.performer.trim();
  if (!promise) return refuse('Say what was promised, in the words the agreement used.');
  if (!performer) {
    return refuse('Name who or what performs it. An obligation nobody is named for is not done.');
  }
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
    return refuse('Name the supplier or contractor, so their commitment and delivery can be tracked.');
  }

  const condition = input.acceptanceCondition?.trim() || opportunity.acceptanceCondition?.trim() || null;
  const declared = await declareFulfillment({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: input.kind,
    promise,
    performer,
    acceptanceCondition: condition,
    repositoryRemote: remote,
    repositoryRoot: root,
    baseBranch: input.baseBranch?.trim() || null,
    mutationScope: input.mutationScope ?? [],
    supplierName: supplier,
    declaredBy: input.actorRef,
  });

  if (!declared.created && !declared.revised) {
    // Work already exists for this obligation, or something is already
    // recorded against it, so the promise those were built on is the one that
    // was made. The acceptance condition is the one field
    // that may still be supplied, and only from empty.
    if (condition && !declared.fulfillment.acceptanceCondition) {
      await supplyAcceptanceCondition(declared.fulfillment.id, condition);
    }
    const now = await getFulfillment(declared.fulfillment.id);
    return {
      ok: true,
      value: now!,
      message:
        'Work already exists for this obligation, or something is recorded against it, so what was ' +
        'promised stays as declared. ' +
        (condition && !declared.fulfillment.acceptanceCondition
          ? 'The acceptance condition it was missing is recorded.'
          : 'Nothing was changed.'),
    };
  }

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: declared.created ? 'CASH_FULFILLMENT_DECLARED' : 'CASH_FULFILLMENT_REVISED',
    actorRef: input.actorRef,
    summary: `${input.kind.toLowerCase()} fulfillment by ${performer}: ${promise}`,
    detail: {
      fulfillmentId: declared.fulfillment.id,
      kind: input.kind,
      acceptanceCondition: condition,
    },
  });
  return {
    ok: true,
    value: declared.fulfillment,
    message: condition
      ? 'Recorded. Brain creates the work for it on the next pass once the agreement is on the ledger.'
      : 'Recorded without an acceptance condition, so Brain will ask for one: delivery cannot be ' +
        'judged accepted against a condition nobody stated.',
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
export type AcceptanceState =
  | 'NO_CONDITION'
  | 'AWAITING_DELIVERY'
  | 'AWAITING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'REJECTED';
export type RefundState = 'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';
export type FulfillmentStage =
  | 'REQUIRED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'REJECTED'
  | 'ACCEPTED'
  | 'FAILED'
  | 'COMPLETE';

export interface RefundReading {
  refundKey: string;
  amountCents: number;
  reason: string;
  state: RefundState;
  /** The provider's or bank's reference, on a confirmed refund. */
  reference: string | null;
  authorizedAt: string;
  /** What is known about an outcome that is not confirmed. */
  outcomeDetail: string | null;
}

export interface FulfillmentReading {
  opportunityId: string;
  title: string;
  mechanism: string;
  fulfillment: CashFulfillment | null;
  money: {
    currency: string;
    /** `PIPELINE_AGREED` on this opportunity. Never added to anything. */
    agreedCents: number;
    /** Gross customer payments recorded, before refunds. */
    paidCents: number;
    settledCents: number;
    refundedCents: number;
    /** Agreed minus paid, never below zero. Null when the obligation failed. */
    outstandingCents: number | null;
    /** Costs that have left the account. */
    costCents: number;
    /** Supplier commitments not yet paid. Explicitly outstanding, not hidden. */
    unpaidCommitmentCents: number;
    /** Payments net of refunds, minus costs. What this transaction produced so far. */
    contributionCents: number;
  };
  work: {
    state: WorkState;
    /** The change request or candidate, when Brain created one. */
    ref: string | null;
    /** What the work produced: a pull request, a commit, a document. */
    artifact: string | null;
    detail: string;
  };
  delivery: {
    state: DeliveryState;
    /** Each partial delivery, oldest first, with what was delivered. */
    portions: { detail: string; evidence: string | null; at: string }[];
    evidence: string | null;
    deliveredAt: string | null;
    /** What is still owed, in words, when delivery is partial. */
    remaining: string | null;
  };
  acceptance: {
    state: AcceptanceState;
    condition: string | null;
    evidence: string | null;
    reason: string | null;
  };
  supplier: {
    name: string | null;
    committedCents: number;
    failed: string | null;
  } | null;
  refunds: RefundReading[];
  failure: { kind: string; reason: string; at: string } | null;
  stage: FulfillmentStage;
  /** True only when every condition of commercial completion holds. */
  complete: boolean;
  /** What stands between this and complete, in the words a person decides in. */
  outstanding: string[];
  /** What Brain does next on its own. */
  brainNext: string[];
  /** What only a person can do. */
  personNext: string[];
}

function sum(totals: Record<string, number>, kind: string): number {
  return Number(totals[kind] ?? 0);
}

async function readWork(
  fulfillment: CashFulfillment,
  events: CashFulfillmentEvent[],
): Promise<FulfillmentReading['work']> {
  if (!fulfillment.workCreatedAt) {
    return { state: 'NOT_CREATED', ref: null, artifact: null, detail: 'No work exists for this yet.' };
  }

  if (fulfillment.kind === 'SOFTWARE' && fulfillment.workRef) {
    const request = await getChangeRequest(fulfillment.workRef);
    if (!request) {
      return {
        state: 'FAILED',
        ref: fulfillment.workRef,
        artifact: null,
        detail: 'The Factory change request this obligation points at no longer exists.',
      };
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
    return {
      state: 'IN_PROGRESS',
      ref: request.id,
      artifact,
      detail: `The Factory campaign is ${campaign.state.toLowerCase()}.`,
    };
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
        return {
          state: 'BLOCKED',
          ref: fulfillment.workRef,
          artifact: null,
          detail: `The research idea is parked: ${candidate.reason ?? 'no reason recorded'}.`,
        };
      }
      return {
        state: 'QUEUED',
        ref: fulfillment.workRef,
        artifact: null,
        detail:
          'Captured as a research idea. Whether it launches is the standing research authority’s ' +
          'decision, through the path every other idea takes.',
      };
    }
    if (mission.state === 'DONE') {
      return mission.documentId
        ? {
            state: 'COMPLETE',
            ref: fulfillment.workRef,
            artifact: mission.documentId,
            detail: 'The research is filed and audited.',
          }
        : {
            state: 'FAILED',
            ref: fulfillment.workRef,
            artifact: null,
            detail: 'The research mission finished without filing a document.',
          };
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
    return {
      state: 'IN_PROGRESS',
      ref: fulfillment.workRef,
      artifact: null,
      detail: `The research mission is ${mission.state.toLowerCase()}.`,
    };
  }

  // A person or a supplier: the obligation is the work, and only a recorded
  // completion with its evidence says it is done.
  const done = [...events].reverse().find((one) => one.kind === 'WORK_COMPLETE');
  if (done) {
    return { state: 'COMPLETE', ref: null, artifact: done.evidenceRef, detail: done.detail };
  }
  return {
    state: 'WAITING_ON_PERSON',
    ref: null,
    artifact: null,
    detail:
      fulfillment.kind === 'SUPPLIER'
        ? `Waiting on ${fulfillment.supplierName ?? fulfillment.performer} to do the work.`
        : `Waiting on ${fulfillment.performer} to do the work.`,
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
    if (!refund) continue;
    // A confirmed or failed refund is settled for good; an unknown one is
    // superseded only by a confirmation or a failure.
    if (refund.state === 'CONFIRMED' || refund.state === 'FAILED') continue;
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

/**
 * Where one agreed opportunity's obligation stands, derived from rows.
 *
 * Null for an opportunity with no agreement and no declared obligation — there
 * is nothing owed to describe. It writes nothing.
 */
export async function readFulfillment(
  opportunity: CashOpportunity,
): Promise<FulfillmentReading | null> {
  const mode = await getCashMode(opportunity.projectId);
  const currency = mode?.currency ?? 'USD';
  const totals = (await totalsByKind({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    currency,
  })) as Record<string, number>;
  const fulfillment = await fulfillmentForOpportunity(opportunity.projectId, opportunity.id);
  const agreed = sum(totals, 'PIPELINE_AGREED');
  if (!fulfillment && agreed <= 0) return null;

  const events = fulfillment ? await fulfillmentEvents(fulfillment.id) : [];
  const paid = sum(totals, 'CUSTOMER_PAYMENT');
  const refunded = sum(totals, 'REFUND');
  const costs = sum(totals, 'COST');
  const unpaid = Math.max(0, sum(totals, 'UNPAID_COMMITMENT') - sum(totals, 'COMMITMENT_PAID'));

  const work = fulfillment
    ? await readWork(fulfillment, events)
    : { state: 'NOT_CREATED' as const, ref: null, artifact: null, detail: 'Nobody has said how this is fulfilled.' };

  let lastDelivered = -1;
  let lastDecision = -1;
  const portions: FulfillmentReading['delivery']['portions'] = [];
  let failure: FulfillmentReading['failure'] = null;
  events.forEach((event, index) => {
    if (event.kind === 'DELIVERED') lastDelivered = index;
    if (event.kind === 'PARTIALLY_DELIVERED') {
      portions.push({ detail: event.detail, evidence: event.evidenceRef, at: event.createdAt });
    }
    if (event.kind === 'ACCEPTED' || event.kind === 'REJECTED') lastDecision = index;
    if (event.kind === 'FAILED' || event.kind === 'SUPPLIER_FAILED' || event.kind === 'ABANDONED') {
      failure = { kind: event.kind, reason: event.detail, at: event.createdAt };
    }
  });
  if (!failure && work.state === 'FAILED') {
    failure = { kind: 'WORK_FAILED', reason: work.detail, at: fulfillment?.updatedAt ?? opportunity.updatedAt };
  }
  const delivered = lastDelivered >= 0 ? events[lastDelivered]! : null;
  const deliveryState: DeliveryState = delivered ? 'DELIVERED' : portions.length > 0 ? 'PARTIAL' : 'NOT_DELIVERED';

  const condition = fulfillment?.acceptanceCondition ?? null;
  let acceptance: FulfillmentReading['acceptance'];
  const decision = lastDecision >= 0 ? events[lastDecision]! : null;
  if (!condition) {
    acceptance = { state: 'NO_CONDITION', condition: null, evidence: null, reason: null };
  } else if (decision && lastDecision > lastDelivered && (decision.kind === 'REJECTED' || delivered)) {
    acceptance =
      decision.kind === 'ACCEPTED'
        ? { state: 'ACCEPTED', condition, evidence: decision.evidenceRef, reason: decision.detail }
        : { state: 'REJECTED', condition, evidence: decision.evidenceRef, reason: decision.detail };
  } else if (delivered) {
    acceptance = { state: 'AWAITING_ACCEPTANCE', condition, evidence: null, reason: null };
  } else {
    acceptance = { state: 'AWAITING_DELIVERY', condition, evidence: null, reason: null };
  }

  const refunds = readRefunds(events);
  const unresolvedRefunds = refunds.filter((one) => one.state === 'PENDING' || one.state === 'UNKNOWN');
  const supplierCommitted = events
    .filter((one) => one.kind === 'SUPPLIER_COMMITTED')
    .reduce((total, one) => total + (one.amountCents ?? 0), 0);
  const supplierFailed = [...events].reverse().find((one) => one.kind === 'SUPPLIER_FAILED') ?? null;

  const outstanding: string[] = [];
  if (!fulfillment) outstanding.push('nobody has said how this is fulfilled');
  if (failure) outstanding.push(`the obligation failed: ${(failure as { reason: string }).reason}`);
  if (work.state !== 'COMPLETE') outstanding.push(`the work is not complete: ${work.detail}`);
  if (deliveryState !== 'DELIVERED') {
    outstanding.push(
      deliveryState === 'PARTIAL'
        ? 'only part of the promise has been delivered'
        : 'nothing has been delivered yet',
    );
  }
  if (acceptance.state === 'NO_CONDITION') {
    outstanding.push('no acceptance condition was stated, so acceptance cannot be judged');
  } else if (acceptance.state !== 'ACCEPTED') {
    outstanding.push(
      acceptance.state === 'REJECTED'
        ? `the buyer rejected the delivery: ${acceptance.reason}`
        : 'the buyer has not accepted it against the agreed condition',
    );
  }
  if (unresolvedRefunds.length > 0) {
    outstanding.push(`${unresolvedRefunds.length} authorized refund(s) are not resolved`);
  }
  if (fulfillment?.kind === 'SUPPLIER' && supplierCommitted === 0) {
    outstanding.push('the supplier’s commitment and its cost are not recorded');
  }
  const complete = outstanding.length === 0;

  const stage: FulfillmentStage = complete
    ? 'COMPLETE'
    : failure
      ? 'FAILED'
      : acceptance.state === 'ACCEPTED'
        ? 'ACCEPTED'
        : acceptance.state === 'REJECTED'
          ? 'REJECTED'
          : deliveryState === 'DELIVERED'
            ? 'DELIVERED'
            : fulfillment && fulfillment.workCreatedAt
              ? 'IN_PROGRESS'
              : 'REQUIRED';

  const brainNext: string[] = [];
  const personNext: string[] = [];
  if (!fulfillment) {
    personNext.push('Say how this is fulfilled: software, research, a person, or a supplier.');
  } else {
    if (!condition) personNext.push('State the acceptance condition the buyer agreed to.');
    if (!fulfillment.workCreatedAt && agreed > 0 && !failure) {
      brainNext.push('Create the work for this obligation on the next pass.');
    }
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
    if (acceptance.state === 'AWAITING_ACCEPTANCE') {
      personNext.push('Record the buyer’s acceptance, or rejection, with their evidence.');
    }
    if (acceptance.state === 'REJECTED' && !failure) {
      personNext.push('Redeliver against the condition, or record the obligation as failed.');
    }
    if (fulfillment.kind === 'SUPPLIER' && supplierCommitted === 0) {
      personNext.push('Record the supplier’s commitment and what it costs.');
    }
    if (failure && (failure as { kind: string }).kind === 'WORK_FAILED') {
      personNext.push('Retry the work with what changed, or record the obligation as failed or abandoned.');
    }
    if (failure && paid - refunded > 0 && refunds.length === 0) {
      personNext.push('Decide what is owed back to the buyer for a failed obligation they paid for.');
    }
  }
  for (const refund of unresolvedRefunds) {
    if (refund.state === 'UNKNOWN') {
      personNext.push(
        `Establish with the provider whether refund ${refund.refundKey} happened. Brain will not send it again.`,
      );
    } else if (refundAdapter()) {
      brainNext.push(`Send refund ${refund.refundKey} through the provider.`);
    } else {
      personNext.push(`Pay out refund ${refund.refundKey} and confirm it with the provider’s reference.`);
    }
  }
  if (unpaid > 0) personNext.push(`Pay the ${unpaid} cents still owed to the supplier, and record it.`);

  const remaining =
    deliveryState === 'PARTIAL' && fulfillment
      ? `The rest of: ${fulfillment.promise}`
      : null;

  return {
    opportunityId: opportunity.id,
    title: opportunity.title,
    mechanism: opportunity.mechanism,
    fulfillment,
    money: {
      currency,
      agreedCents: agreed,
      paidCents: paid,
      settledCents: sum(totals, 'SETTLEMENT'),
      refundedCents: refunded,
      outstandingCents: failure ? null : Math.max(0, agreed - paid),
      costCents: costs,
      unpaidCommitmentCents: unpaid,
      contributionCents: paid - refunded - costs,
    },
    work,
    delivery: {
      state: deliveryState,
      portions,
      evidence: delivered?.evidenceRef ?? null,
      deliveredAt: delivered?.createdAt ?? null,
      remaining,
    },
    acceptance,
    supplier:
      fulfillment?.kind === 'SUPPLIER'
        ? {
            name: fulfillment.supplierName,
            committedCents: supplierCommitted,
            failed: supplierFailed?.detail ?? null,
          }
        : null,
    refunds,
    failure,
    stage,
    complete,
    outstanding,
    brainNext,
    personNext,
  };
}

/** Every obligation in a project, agreed or declared. */
export async function readFulfillments(projectId: string): Promise<FulfillmentReading[]> {
  const ids = new Set<string>();
  for (const one of await listFulfillments(projectId)) ids.add(one.opportunityId);
  for (const id of await agreedOpportunityIds(projectId)) ids.add(id);
  const out: FulfillmentReading[] = [];
  for (const id of ids) {
    const opportunity = await getOpportunity(id);
    if (!opportunity || opportunity.projectId !== projectId) continue;
    const reading = await readFulfillment(opportunity);
    if (reading) out.push(reading);
  }
  return out;
}

async function agreedOpportunityIds(projectId: string): Promise<string[]> {
  const rows = await getDb().all<{ opportunity_id: string }>(
    `SELECT DISTINCT opportunity_id FROM cash_money_entries
      WHERE project_id = ? AND kind = 'PIPELINE_AGREED' AND opportunity_id IS NOT NULL
      ORDER BY opportunity_id`,
    [projectId],
  );
  return rows.map((row) => row.opportunity_id);
}

/* --------------------------------------------------------------------------
 * What happened
 * ------------------------------------------------------------------------ */

export function isRecordableEvent(value: unknown): value is RecordableFulfillmentEvent {
  return (
    typeof value === 'string' && (RECORDABLE_FULFILLMENT_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Record something that happened to an obligation.
 *
 * Each kind has the evidence it needs and the order it has to happen in, and
 * a refusal names the remedy:
 *
 *   * `WORK_COMPLETE` only for a person or a supplier, with what proves it —
 *     software and research completion is the Factory's and the pipeline's to
 *     say, never a person's or a worker's word;
 *   * `DELIVERED` only once the work is complete, with what was delivered;
 *     `PARTIALLY_DELIVERED` at any point, naming the part;
 *   * `ACCEPTED` only against a stated condition and after a full delivery,
 *     carrying the buyer's own evidence — a file uploaded is not acceptance;
 *   * `REJECTED` after something was delivered, with the buyer's reason;
 *   * `FAILED`, `SUPPLIER_FAILED`, `ABANDONED` with the reason, and nothing
 *     after them except refunds — a failed obligation is not quietly resumed.
 *
 * The key is the content, so an exact resubmission is the same row.
 */
export async function recordEvent(input: {
  projectId: string;
  opportunityId: string;
  kind: string;
  detail: string;
  evidenceRef?: string | null;
  actorRef: string;
}): Promise<Outcome<FulfillmentReading>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');
  const fulfillment = await fulfillmentForOpportunity(input.projectId, opportunity.id);
  if (!fulfillment) {
    return refuse('Say how this is fulfilled first, so there is an obligation to record this against.');
  }
  if (!isRecordableEvent(input.kind)) {
    return refuse(`"${input.kind}" is not something recorded here. It is one of: ${RECORDABLE_FULFILLMENT_EVENTS.join(', ')}.`);
  }
  const detail = input.detail.trim();
  const evidence = input.evidenceRef?.trim() || null;
  if (!detail) return refuse('Say what happened, in words somebody can check later.');

  const before = (await readFulfillment(opportunity))!;
  // A failure read from the work is a fact about that work, which can be
  // retried; a person may still close the obligation out over it. A failure a
  // person recorded is final.
  const closingOverWork =
    before.failure?.kind === 'WORK_FAILED' && (input.kind === 'FAILED' || input.kind === 'ABANDONED');
  if (before.failure && !closingOverWork) {
    return refuse(
      `This obligation already failed (${before.failure.reason}). Nothing more is recorded against ` +
        'it except refunds; a new agreement is a new obligation.',
    );
  }
  const needsEvidence = ['WORK_COMPLETE', 'DELIVERED', 'PARTIALLY_DELIVERED', 'ACCEPTED'];
  if (needsEvidence.includes(input.kind) && !evidence) {
    return refuse(
      `${input.kind} needs what proves it — a reference somebody else can look at. A statement that ` +
        'it happened is a claim, not evidence.',
    );
  }
  switch (input.kind) {
    case 'WORK_COMPLETE':
      if (fulfillment.kind === 'SOFTWARE' || fulfillment.kind === 'RESEARCH') {
        return refuse(
          `${fulfillment.kind.toLowerCase()} work is complete when the ${
            fulfillment.kind === 'SOFTWARE' ? 'Factory' : 'research pipeline'
          } says so, from its own rows. Somebody saying it is done is not evidence.`,
        );
      }
      if (!fulfillment.workCreatedAt) return refuse('The work for this has not been opened yet.');
      break;
    case 'DELIVERED':
      if (before.work.state !== 'COMPLETE') {
        return refuse(
          `The work is not complete (${before.work.detail}), so the whole promise cannot have been ` +
            'delivered. Record what part was delivered instead.',
        );
      }
      break;
    case 'ACCEPTED':
      if (!fulfillment.acceptanceCondition) {
        return refuse(
          'No acceptance condition was stated, so there is nothing to accept against. State the ' +
            'condition the buyer agreed to first.',
        );
      }
      if (before.delivery.state !== 'DELIVERED') {
        return refuse('Nothing has been fully delivered, so the buyer cannot have accepted it.');
      }
      if (before.acceptance.state === 'ACCEPTED') {
        return {
          ok: true,
          value: before,
          message: 'Already accepted. The acceptance on the record stands.',
        };
      }
      break;
    case 'REJECTED':
      if (before.delivery.state === 'NOT_DELIVERED') {
        return refuse('Nothing has been delivered, so there is nothing for the buyer to reject.');
      }
      break;
    case 'SUPPLIER_FAILED':
      if (fulfillment.kind !== 'SUPPLIER') return refuse('Only a supplier obligation has a supplier to fail.');
      break;
  }

  const recorded = await recordFulfillmentEvent({
    projectId: input.projectId,
    fulfillmentId: fulfillment.id,
    opportunityId: opportunity.id,
    kind: input.kind,
    detail,
    evidenceRef: evidence,
    recordedBy: input.actorRef,
    requestKey: `event:${input.kind}:${digest(detail, evidence)}`,
  });
  if (recorded.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: `CASH_FULFILLMENT_${input.kind}`,
      actorRef: input.actorRef,
      summary: `${input.kind.toLowerCase().replace(/_/g, ' ')}: ${detail}`,
      detail: { fulfillmentId: fulfillment.id, evidenceRef: evidence, eventId: recorded.event.id },
    });
    // The existing opportunity state, kept agreeing with the obligation: a
    // full delivery is what `DELIVERING` means. Guarded, so a piece in any
    // other state is left exactly where it is.
    if (input.kind === 'DELIVERED') {
      await transitionOpportunity({ id: opportunity.id, from: ['EXECUTING'], to: 'DELIVERING' });
    }
  }
  const after = (await readFulfillment((await getOpportunity(opportunity.id))!))!;
  return { ok: true, value: after, message: recorded.created ? 'Recorded.' : 'Already recorded.' };
}

/* --------------------------------------------------------------------------
 * Costs
 * ------------------------------------------------------------------------ */

export const FULFILLMENT_COST_KINDS = ['SUPPLIER_COMMITMENT', 'SUPPLIER_PAYMENT', 'INTERNAL_COST'] as const;
export type FulfillmentCostKind = (typeof FULFILLMENT_COST_KINDS)[number];

async function moneyKeyExists(projectId: string, key: string): Promise<{ amount: number } | null> {
  const row = await getDb().get<{ amount_cents: number }>(
    'SELECT amount_cents FROM cash_money_entries WHERE project_id = ? AND idempotency_key = ?',
    [projectId, key],
  );
  return row ? { amount: Number(row.amount_cents) } : null;
}

/**
 * A cost of fulfilling, recorded into the ledger that already exists.
 *
 * Three kinds, and the arithmetic `money.ts` refuses to get wrong is preserved
 * by using its own entries rather than a figure here:
 *
 *   * a supplier's **commitment** is `UNPAID_COMMITMENT` — owed, reducing
 *     deployable cash, not yet a cost;
 *   * a supplier's **payment** is `COST`, plus `COMMITMENT_PAID` for the part
 *     of it that closes what was owed, so the same dollar is never in both;
 *   * an **internal** incremental cost is `COST`.
 *
 * Only what actually happened: there is no estimate kind, and a payment needs
 * the reference that proves it left. Every key is derived from the obligation
 * and the content, so a retry writes nothing twice — and the part a payment
 * closes is read back from its own key on a retry rather than recomputed from
 * a balance the first attempt already moved.
 */
export async function recordCost(input: {
  projectId: string;
  opportunityId: string;
  kind: string;
  amountCents: number;
  detail: string;
  reference?: string | null;
  actorRef: string;
}): Promise<Outcome<FulfillmentReading>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');
  const fulfillment = await fulfillmentForOpportunity(input.projectId, opportunity.id);
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
  if ((kind === 'SUPPLIER_COMMITMENT' || kind === 'SUPPLIER_PAYMENT') && fulfillment.kind !== 'SUPPLIER') {
    return refuse('A supplier cost belongs to an obligation a supplier performs.');
  }
  if (kind === 'SUPPLIER_PAYMENT' && !reference) {
    return refuse('A payment to a supplier needs the reference that proves the money left.');
  }
  const mode = await getCashMode(input.projectId);
  if (!mode) return refuse('Cash Mode has not been activated for this project.');

  const key = `fulfillment-cost:${fulfillment.id}:${kind}:${digest(amount, detail, reference)}`;
  if (kind === 'SUPPLIER_COMMITMENT') {
    const written = await recordMoneyEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'UNPAID_COMMITMENT',
      amountCents: amount,
      currency: mode.currency,
      verifiedReference: reference,
      note: `${fulfillment.supplierName ?? fulfillment.performer}: ${detail}`,
      idempotencyKey: key,
      actorRef: input.actorRef,
    });
    if (!written.ok) return written;
    await recordFulfillmentEvent({
      projectId: input.projectId,
      fulfillmentId: fulfillment.id,
      opportunityId: opportunity.id,
      kind: 'SUPPLIER_COMMITTED',
      detail,
      evidenceRef: reference,
      amountCents: amount,
      recordedBy: input.actorRef,
      requestKey: key,
    });
  } else {
    /*
     * A payment and the part of it that closes what was owed are one decision,
     * under the project's cash lock and in one transaction. Outside the lock
     * two payments would each read the same unpaid balance and each close all
     * of it — and the excess would cancel another opportunity's commitments in
     * the project-wide arithmetic. In one transaction the `COST` entry exists
     * exactly when the decision was made, so a retry that finds it does not
     * recompute against commitments recorded since: zero closed stays zero.
     */
    const written = await serializeCash(input.projectId, mode.currency, async (): Promise<Outcome<null>> => {
      if (await moneyKeyExists(input.projectId, key)) return { ok: true, value: null, message: 'Already recorded.' };
      if (kind === 'SUPPLIER_PAYMENT') {
        const before = await readFulfillment(opportunity);
        const closes = Math.min(amount, before?.money.unpaidCommitmentCents ?? 0);
        if (closes > 0) {
          const paid = await recordMoneyEvent({
            projectId: input.projectId,
            opportunityId: opportunity.id,
            kind: 'COMMITMENT_PAID',
            amountCents: closes,
            currency: mode.currency,
            verifiedReference: reference,
            note: `closes what was owed to ${fulfillment.supplierName ?? fulfillment.performer}`,
            idempotencyKey: `${key}:closes`,
            actorRef: input.actorRef,
          });
          if (!paid.ok) throw new RefusedInLock(paid.reason);
        }
      }
      const cost = await recordMoneyEvent({
        projectId: input.projectId,
        opportunityId: opportunity.id,
        kind: 'COST',
        amountCents: amount,
        currency: mode.currency,
        verifiedReference: reference,
        note: detail,
        idempotencyKey: key,
        actorRef: input.actorRef,
      });
      if (!cost.ok) throw new RefusedInLock(cost.reason);
      return { ok: true, value: null, message: 'Recorded.' };
    }).catch((error: unknown) => {
      // A refusal rolls the whole decision back, so a closed commitment is
      // never left behind without the payment that closed it.
      if (error instanceof RefusedInLock) return refuse(error.message);
      throw error;
    });
    if (!written.ok) return written;
  }
  const after = (await readFulfillment(opportunity))!;
  return { ok: true, value: after, message: 'Recorded in the ledger.' };
}

/* --------------------------------------------------------------------------
 * Refunds
 * ------------------------------------------------------------------------ */

/**
 * A person decides the buyer is owed money back.
 *
 * Bounded by what was actually paid: payments, less refunds already confirmed,
 * less refunds still pending or unknown — because an unknown refund may have
 * happened, and authorizing against it as though it had not is how a buyer is
 * paid twice. Then Brain sends it if a refund adapter exists, and raises a need
 * naming the person's step if not.
 */
export async function authorizeRefund(input: {
  projectId: string;
  opportunityId: string;
  amountCents: number;
  reason: string;
  actorRef: string;
}): Promise<Outcome<FulfillmentReading>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');
  const fulfillment = await fulfillmentForOpportunity(input.projectId, opportunity.id);
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
   * The check and the authorization are one decision, so they happen under the
   * project's cash lock (`repos/cashLock.ts`). Read outside it, two people
   * authorizing 600 against 1000 paid would each see 1000 refundable and both
   * be recorded — 1200 owed back for 1000 received.
   *
   * The key is the request's own content, so a lost reply asked again joins the
   * refund it already made rather than authorizing a second. The one exception
   * is a refund that *failed*: nothing left the account, so the same words are
   * a retry and take the next occurrence. A confirmed refund is never joined
   * into a second one — the same amount for the same reason twice needs its own
   * reason, because a retry after a lost reply and a deliberate second refund
   * are otherwise the same request.
   */
  const decided = await serializeCash(
    input.projectId,
    mode.currency,
    async (): Promise<{ refundKey: string; created: boolean } | { refused: string }> => {
    const before = (await readFulfillment(opportunity))!;
    const failedBefore = before.refunds.filter(
      (one) => one.state === 'FAILED' && one.amountCents === amount && one.reason === reason,
    ).length;
    const refundKey = failedBefore === 0 ? digest('refund', amount, reason) : digest('refund', amount, reason, failedBefore);
    const existing = before.refunds.find((one) => one.refundKey === refundKey);
    if (existing) return { refundKey, created: false };
    const committed = before.refunds
      .filter((one) => one.state === 'PENDING' || one.state === 'UNKNOWN')
      .reduce((total, one) => total + one.amountCents, 0);
    const refundable = before.money.paidCents - before.money.refundedCents - committed;
    if (amount > refundable) {
      return {
        refused:
          `${refundable} cents are refundable: ${before.money.paidCents} paid, ${before.money.refundedCents} ` +
          `already refunded and ${committed} in refunds not yet resolved. A refund larger than what ` +
          'was paid is a payment, not a refund.',
      };
    }
    const recorded = await recordFulfillmentEvent({
      projectId: input.projectId,
      fulfillmentId: fulfillment.id,
      opportunityId: opportunity.id,
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
      opportunityId: opportunity.id,
      kind: 'CASH_REFUND_AUTHORIZED',
      actorRef: input.actorRef,
      summary: `A refund of ${amount} cents was authorized: ${reason}`,
      detail: { fulfillmentId: fulfillment.id, refundKey, amountCents: amount },
    });
  } else {
    const prior = (await readFulfillment(opportunity))!.refunds.find((one) => one.refundKey === refundKey);
    if (prior?.state === 'CONFIRMED') {
      return {
        ok: true,
        value: (await readFulfillment(opportunity))!,
        message:
          'A refund of this amount for this reason is already confirmed. A second refund needs its own ' +
          'reason, so it cannot be mistaken for a retry of the first.',
      };
    }
  }
  await settleRefund({ fulfillment, opportunity, refundKey });
  const after = (await readFulfillment(opportunity))!;
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

/**
 * Take one authorized refund as far as Brain can, once.
 *
 * With an adapter: through `runExternalEffect` on a key derived from the
 * refund, so asking again after a restart joins the same reservation and an
 * unresolved attempt is never resent. Without one: a need for the person who
 * pays it. An `UNKNOWN` refund is left exactly where it is.
 */
async function settleRefund(input: {
  fulfillment: CashFulfillment;
  opportunity: CashOpportunity;
  refundKey: string;
}): Promise<void> {
  const reading = await readFulfillment(input.opportunity);
  const refund = reading?.refunds.find((one) => one.refundKey === input.refundKey);
  if (!reading || !refund || refund.state !== 'PENDING') return;

  if (!refundAdapter()) {
    if (await withdrawnByPerson(input.fulfillment.projectId, `fulfillment:refund:${input.fulfillment.id}:${refund.refundKey}`)) return;
    await raiseNeed({
      projectId: input.fulfillment.projectId,
      opportunityId: input.opportunity.id,
      actorRef: BRAIN,
      blockedAction: `Pay back ${refund.amountCents} cents to the buyer of "${input.opportunity.title}"`,
      whyItMatters:
        'A refund was authorized and Brain has no way to send one, so until somebody pays it out ' +
        'the buyer is owed money and the contribution is overstated.',
      recommendedPath:
        'Refund through the provider that took the payment, then confirm it on the obligation with ' +
        'the provider’s reference. That is what writes the REFUND entry.',
      setupEffort: 'A few minutes in the payment provider.',
      nextStep: `Refund ${refund.amountCents} cents, then confirm refund ${refund.refundKey} with its reference.`,
      completionCondition: `Refund ${refund.refundKey} is confirmed with a provider reference, or recorded as not sent.`,
      requestKey: `fulfillment:refund:${input.fulfillment.id}:${refund.refundKey}`,
    });
    return;
  }

  let outcome;
  try {
    outcome = await sendRefund({
      projectId: input.fulfillment.projectId,
      fulfillmentId: input.fulfillment.id,
      refundKey: refund.refundKey,
      amountCents: refund.amountCents,
      currency: reading.money.currency,
      reason: refund.reason,
    });
  } catch (error) {
    // Another attempt holds the reservation right now. It will record what
    // happened; this one must not guess.
    if (error instanceof OperationInProgress || error instanceof OperationConflict) return;
    throw error;
  }

  if (outcome.status === 'CONFIRMED' || outcome.status === 'RECONCILED' || outcome.status === 'REPLAYED') {
    const receipt =
      outcome.status === 'REPLAYED'
        ? await replayedReceipt(outcome.operation.id, outcome.operation.resultRef)
        : outcome.receiptRef;
    if (!receipt) {
      await recordRefundUnknown(input, refund.refundKey, 'The provider replayed the refund without a receipt.');
      return;
    }
    await confirmRefundInternal({
      fulfillment: input.fulfillment,
      opportunity: input.opportunity,
      refund,
      reference: receipt,
      detail: 'The provider confirmed the refund.',
      actorRef: BRAIN,
    });
    return;
  }
  if (outcome.status === 'UNCERTAIN') {
    await recordRefundUnknown(input, refund.refundKey, outcome.reason);
    return;
  }
  await recordFulfillmentEvent({
    projectId: input.fulfillment.projectId,
    fulfillmentId: input.fulfillment.id,
    opportunityId: input.opportunity.id,
    kind: 'REFUND_FAILED',
    detail: 'The provider refused the refund; it is authoritative that nothing left the account.',
    refundKey: refund.refundKey,
    recordedBy: BRAIN,
    requestKey: `refund:${refund.refundKey}:outcome`,
  });
}

/**
 * The receipt of a refund the provider already confirmed, read back.
 *
 * A replay means an earlier attempt succeeded and this call joined it; the
 * receipt is on that attempt's own row. Null when it cannot be found, which
 * the caller records as unknown rather than inventing a reference.
 */
async function replayedReceipt(operationId: string, resultRef: string | null): Promise<string | null> {
  const attempts = await listAttempts(operationId);
  for (const attempt of [...attempts].reverse()) {
    if (attempt.receiptRef) return attempt.receiptRef;
  }
  return resultRef;
}

async function recordRefundUnknown(
  input: { fulfillment: CashFulfillment; opportunity: CashOpportunity },
  refundKey: string,
  reason: string,
): Promise<void> {
  await recordFulfillmentEvent({
    projectId: input.fulfillment.projectId,
    fulfillmentId: input.fulfillment.id,
    opportunityId: input.opportunity.id,
    kind: 'REFUND_UNKNOWN',
    detail: `The refund left and its outcome is unknown: ${reason}`,
    refundKey,
    recordedBy: BRAIN,
    requestKey: `refund:${refundKey}:unknown`,
  });
  if (await withdrawnByPerson(input.fulfillment.projectId, `fulfillment:refund-unknown:${input.fulfillment.id}:${refundKey}`)) return;
  await raiseNeed({
    projectId: input.fulfillment.projectId,
    opportunityId: input.opportunity.id,
    actorRef: BRAIN,
    blockedAction: `Establish whether refund ${refundKey} reached the buyer`,
    whyItMatters:
      'The provider did not say whether the refund happened. Sending it again could pay the buyer ' +
      'twice, so Brain will not; and recording it as paid without the provider’s word would be a guess.',
    recommendedPath: 'Look the refund up in the provider’s dashboard and record what it says.',
    setupEffort: 'A few minutes in the payment provider.',
    nextStep: `Confirm refund ${refundKey} with its reference, or record that it did not happen.`,
    completionCondition: `Refund ${refundKey} is confirmed with a provider reference, or recorded as not sent.`,
    requestKey: `fulfillment:refund-unknown:${input.fulfillment.id}:${refundKey}`,
  });
}

async function confirmRefundInternal(input: {
  fulfillment: CashFulfillment;
  opportunity: CashOpportunity;
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
    opportunityId: input.opportunity.id,
    kind: 'REFUND',
    amountCents: input.refund.amountCents,
    currency: mode.currency,
    verifiedReference: input.reference,
    note: input.refund.reason,
    idempotencyKey: `refund:${input.fulfillment.id}:${input.refund.refundKey}`,
    actorRef: input.actorRef,
  });
  if (!written.ok) return written;
  await recordFulfillmentEvent({
    projectId: input.fulfillment.projectId,
    fulfillmentId: input.fulfillment.id,
    opportunityId: input.opportunity.id,
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

/**
 * A person answers an authorized refund with the provider's own word.
 *
 * `confirm` needs the reference that proves the money went back; `not-sent`
 * needs what establishes it did not. Either resolves a `PENDING` or an
 * `UNKNOWN` refund; neither touches one already resolved.
 */
export async function answerRefund(input: {
  projectId: string;
  opportunityId: string;
  refundKey: string;
  answer: 'confirm' | 'not-sent';
  reference: string;
  actorRef: string;
}): Promise<Outcome<FulfillmentReading>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');
  const fulfillment = await fulfillmentForOpportunity(input.projectId, opportunity.id);
  const reading = await readFulfillment(opportunity);
  const refund = reading?.refunds.find((one) => one.refundKey === input.refundKey);
  if (!fulfillment || !reading || !refund) return refuse('No refund with that key on this obligation.');
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
      return { ok: true, value: reading, message: 'Already recorded.' };
    }
    return refuse(`This refund is already ${refund.state.toLowerCase()}. A resolved refund is not reopened.`);
  }
  if (input.answer === 'confirm') {
    const confirmed = await confirmRefundInternal({
      fulfillment,
      opportunity,
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
      opportunityId: opportunity.id,
      kind: 'REFUND_FAILED',
      detail: 'A person established the refund did not happen.',
      evidenceRef: reference,
      refundKey: refund.refundKey,
      recordedBy: input.actorRef,
      requestKey: `refund:${refund.refundKey}:not-sent`,
    });
  }
  const after = (await readFulfillment(opportunity))!;
  return { ok: true, value: after, message: 'Recorded.' };
}

/* --------------------------------------------------------------------------
 * The tick
 * ------------------------------------------------------------------------ */

export interface FulfillmentPass {
  /** Obligations Brain created work for this pass. */
  workCreated: { opportunityId: string; kind: FulfillmentKind; ref: string | null }[];
  needsRaised: string[];
  needsSettled: string[];
  refundsSettled: string[];
  observations: number;
}

/**
 * One project's fulfillment step, for the Cash tick.
 *
 * Idempotent from end to end, so a crash between any two steps resumes rather
 * than repeating: work is created on keys derived from the obligation and
 * claimed by a guarded update, needs are raised under keys, observations under
 * keys, and an unknown refund is never touched.
 */
export async function advanceFulfillment(projectId: string): Promise<FulfillmentPass> {
  const pass: FulfillmentPass = {
    workCreated: [],
    needsRaised: [],
    needsSettled: [],
    refundsSettled: [],
    observations: 0,
  };
  if (!(await getCashMode(projectId))) return pass;

  for (const reading of await readFulfillments(projectId)) {
    const opportunity = await getOpportunity(reading.opportunityId);
    if (!opportunity) continue;
    const fulfillment = reading.fulfillment;

    if (!fulfillment) {
      await raise(pass, {
        projectId,
        opportunity,
        key: `fulfillment:requirement:${opportunity.id}`,
        blockedAction: `Fulfil the agreement on "${opportunity.title}"`,
        whyItMatters:
          'A buyer agreed and nothing says how the work gets done, so nothing can be created, ' +
          'delivered or accepted for it.',
        recommendedPath:
          'Declare how it is fulfilled — software through the Factory, research through the ' +
          'pipeline, a person, or a supplier — with what was promised and what proves it landed.',
        nextStep: 'Declare the fulfillment for this opportunity.',
        completionCondition: 'A fulfillment is declared for this opportunity.',
      });
      continue;
    }

    if (!fulfillment.acceptanceCondition) {
      await raise(pass, {
        projectId,
        opportunity,
        key: `fulfillment:acceptance:${opportunity.id}`,
        blockedAction: `Judge whether the buyer of "${opportunity.title}" accepted the work`,
        whyItMatters:
          'A delivery is not an acceptance, and acceptance is judged against the condition the ' +
          'agreement named. With none, delivery can never be called accepted.',
        recommendedPath: 'State the condition the buyer agreed to, as the agreement put it.',
        nextStep: 'Record the acceptance condition on this obligation.',
        completionCondition: 'The obligation carries an acceptance condition.',
      });
    }

    if (!fulfillment.workCreatedAt && reading.money.agreedCents > 0 && !reading.failure) {
      await createWork(pass, fulfillment, opportunity);
    }

    for (const refund of reading.refunds) {
      if (refund.state !== 'PENDING') continue;
      await settleRefund({ fulfillment, opportunity, refundKey: refund.refundKey });
      pass.refundsSettled.push(refund.refundKey);
    }

    const now = await readFulfillment(opportunity);
    if (!now) continue;
    if (now.failure && now.money.paidCents - now.money.refundedCents > 0 && now.refunds.length === 0) {
      await raise(pass, {
        projectId,
        opportunity,
        key: `fulfillment:refund-decision:${opportunity.id}`,
        blockedAction: `Close out the failed obligation on "${opportunity.title}"`,
        whyItMatters:
          `The buyer paid ${now.money.paidCents - now.money.refundedCents} cents for an obligation that ` +
          `failed (${now.failure.reason}). Until somebody decides what is owed back, the contribution ` +
          'reads as revenue it may not be.',
        recommendedPath:
          'Authorize a refund for what is owed, or withdraw this need saying why the payment is kept.',
        nextStep: 'Authorize the refund, or withdraw this with the reason.',
        completionCondition: 'A refund is authorized on this obligation.',
      });
    }
    pass.observations += await observe(now, opportunity);
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

/** Whether the latest occurrence of this need is one a person withdrew. */
async function withdrawnByPerson(projectId: string, key: string): Promise<boolean> {
  return (await needForKey(projectId, key))?.state === 'WITHDRAWN';
}

async function raise(
  pass: FulfillmentPass,
  input: {
    projectId: string;
    opportunity: CashOpportunity;
    key: string;
    blockedAction: string;
    whyItMatters: string;
    recommendedPath: string;
    nextStep: string;
    completionCondition: string;
  },
): Promise<void> {
  /*
   * A person withdrawing one of these is their answer — "the payment is kept",
   * "there is no condition to state" — and the rows it reads do not change when
   * they say it. Raising it again would put the same question back every tick,
   * a new occurrence and a new event each time, until they stopped reading the
   * review. So a key whose latest occurrence a person withdrew stays withdrawn;
   * a resolved one can still come back, because that means the condition held
   * and then stopped holding.
   */
  if (await withdrawnByPerson(input.projectId, input.key)) return;
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
  if (raised.ok && !raised.message.includes('already raised')) pass.needsRaised.push(raised.value.id);
}

/**
 * Create the work for one obligation, exactly once.
 *
 * The creation itself is idempotent by the obligation — a submission key the
 * Factory collides on, an idea `capture` folds into the one already captured —
 * and the claim is a guarded update on the obligation's own row. So a retry, a
 * restart between the two and two ticks at once all leave one piece of work.
 */
async function createWork(
  pass: FulfillmentPass,
  fulfillment: CashFulfillment,
  opportunity: CashOpportunity,
): Promise<void> {
  if (fulfillment.kind === 'PERSON' || fulfillment.kind === 'SUPPLIER') {
    if (await claimFulfillmentWork(fulfillment.id, null)) {
      pass.workCreated.push({ opportunityId: opportunity.id, kind: fulfillment.kind, ref: null });
      await recordCashEvent({
        projectId: fulfillment.projectId,
        opportunityId: opportunity.id,
        kind: 'CASH_FULFILLMENT_OPENED',
        actorRef: BRAIN,
        summary: `Waiting on ${fulfillment.performer}: ${fulfillment.promise}`,
        detail: { fulfillmentId: fulfillment.id, kind: fulfillment.kind },
      });
    }
    return;
  }

  // Software and research are both built *from* the acceptance condition, so
  // neither is created without one; the need for it is already raised.
  if (!fulfillment.acceptanceCondition) return;

  // Each retry a person asked for is a new attempt, named by how many came
  // before it — read from the append-only history, so every pass computes the
  // same key and the Factory and `capture` collide on it rather than duplicate.
  const attempt = await workAttempt(fulfillment);
  let ref: string | null = null;
  if (fulfillment.kind === 'SOFTWARE') {
    try {
      const result = await submitObjective({
        projectId: fulfillment.projectId,
        objective: `Fulfil an agreed customer obligation: ${fulfillment.promise}`,
        expectedOutcome: `The buyer can accept it against: ${fulfillment.acceptanceCondition}`,
        nonGoals: [
          'Deploying anything to a customer: the release stays a person’s decision.',
          'Widening the scope beyond what the buyer agreed to.',
        ],
        acceptanceConditions: [
          {
            statement: fulfillment.acceptanceCondition,
            verification: 'Checked against the agreed acceptance condition before delivery.',
          },
        ],
        ...(fulfillment.repositoryRemote ? { repositoryRemote: fulfillment.repositoryRemote } : {}),
        ...(fulfillment.repositoryRoot ? { repositoryRoot: fulfillment.repositoryRoot } : {}),
        ...(fulfillment.baseBranch ? { baseBranch: fulfillment.baseBranch } : {}),
        ...(fulfillment.mutationScope.length > 0 ? { mutationScope: fulfillment.mutationScope } : {}),
        submissionKey:
          attempt === 0 ? `cash-fulfillment-${fulfillment.id}` : `cash-fulfillment-${fulfillment.id}-${attempt}`,
      });
      ref = result.changeRequest.id;
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      await raise(pass, {
        projectId: fulfillment.projectId,
        opportunity,
        key: `fulfillment:work:${opportunity.id}`,
        blockedAction: `Build the software the buyer of "${opportunity.title}" agreed to`,
        whyItMatters: `The Factory refused the objective: ${error.message}`,
        recommendedPath:
          'Fix what the Factory named — most often authorizing and onboarding the repository for ' +
          'this project on Build — and Brain submits the objective again on the next pass.',
        nextStep: 'Resolve the Factory’s refusal on Build.',
        completionCondition: 'Brain has created Factory work for this obligation.',
      });
      return;
    }
  } else {
    const captured = await capture({
      title: `Deliver to a buyer: ${fulfillment.promise}`.slice(0, 200),
      statement:
        `${fulfillment.promise}\n\nThis is owed to a buyer who agreed to pay for it. It is ` +
        `accepted when: ${fulfillment.acceptanceCondition}` +
        (attempt === 0 ? '' : `\n\nAttempt ${attempt + 1}: the previous attempt failed.`),
      projectId: fulfillment.projectId,
      visibility: 'SHARED',
    });
    if (!captured.candidate) {
      await raise(pass, {
        projectId: fulfillment.projectId,
        opportunity,
        key: `fulfillment:work:${opportunity.id}`,
        blockedAction: `Research what the buyer of "${opportunity.title}" agreed to`,
        whyItMatters: `The research idea could not be captured: ${captured.reason}`,
        recommendedPath: 'Restate the promise so it is a question research can answer.',
        nextStep: 'Revise the obligation’s promise.',
        completionCondition: 'Brain has created research work for this obligation.',
      });
      return;
    }
    ref = captured.candidate.id;
  }

  if (await claimFulfillmentWork(fulfillment.id, ref)) {
    pass.workCreated.push({ opportunityId: opportunity.id, kind: fulfillment.kind, ref });
    await recordCashEvent({
      projectId: fulfillment.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_FULFILLMENT_WORK_CREATED',
      actorRef: BRAIN,
      summary:
        fulfillment.kind === 'SOFTWARE'
          ? `Factory objective ${ref} submitted; a person approves it on Build.`
          : `Research idea ${ref} captured; the standing research authority decides whether it launches.`,
      detail: { fulfillmentId: fulfillment.id, ref },
    });
  }
}

async function workAttempt(fulfillment: CashFulfillment): Promise<number> {
  // Counted from the whole history by kind, never from a page of recent
  // events: an attempt number that went back down would collide with the
  // failed attempt's own Factory key.
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_events
      WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_FULFILLMENT_WORK_RETRIED'`,
    [fulfillment.projectId, fulfillment.opportunityId],
  );
  return Number(row?.n ?? 0);
}

/**
 * A person asks Brain to create the work again after it failed.
 *
 * The answering transition for a failure read from the work: without it a
 * withdrawn change request, a cancelled campaign or a research mission that
 * ended without a document would fail the obligation for good. Only that kind
 * of failure can be retried — one a person recorded is their decision. The
 * retry is written to the history first and the work released second, guarded
 * on the work that failed, so a crash between them costs one extra attempt
 * number and never two pieces of work.
 */
export async function retryWork(input: {
  projectId: string;
  opportunityId: string;
  reason: string;
  actorRef: string;
}): Promise<Outcome<FulfillmentReading>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opportunity with that id.');
  const fulfillment = await fulfillmentForOpportunity(input.projectId, opportunity.id);
  const reading = await readFulfillment(opportunity);
  if (!fulfillment || !reading) return refuse('Say how this is fulfilled first.');
  const reason = input.reason.trim();
  if (!reason) return refuse('Say what changed, so the next attempt is not the same one again.');
  if (reading.failure?.kind !== 'WORK_FAILED' || !fulfillment.workRef) {
    return refuse(
      reading.failure
        ? 'This obligation was recorded as failed by a person. That is their decision, and it is not retried.'
        : 'The work has not failed, so there is nothing to retry.',
    );
  }
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: 'CASH_FULFILLMENT_WORK_RETRIED',
    actorRef: input.actorRef,
    summary: `The work for "${opportunity.title}" failed and is being created again: ${reason}`,
    detail: { fulfillmentId: fulfillment.id, previousRef: fulfillment.workRef, failure: reading.failure.reason, reason },
  });
  if (!(await releaseFulfillmentWork(fulfillment.id, fulfillment.workRef))) {
    return refuse('Somebody else retried this work a moment ago. It is already being created again.');
  }
  return {
    ok: true,
    value: (await readFulfillment(opportunity))!,
    message: 'Brain creates the work again on the next pass. The failed attempt keeps its rows.',
  };
}

/* --------------------------------------------------------------------------
 * What it taught
 * ------------------------------------------------------------------------ */

/**
 * Record what a finished, failed or refunded obligation established.
 *
 * Written once per terminal point under a key naming it, never revised: a later
 * refund is a new observation beside the success it qualifies, which is the
 * difference between learning and rewriting. Every value is read from rows that
 * already exist — nothing here is an estimate.
 */
async function observe(reading: FulfillmentReading, opportunity: CashOpportunity): Promise<number> {
  const fulfillment = reading.fulfillment;
  if (!fulfillment) return 0;
  const events = await fulfillmentEvents(fulfillment.id);
  let written = 0;
  const base = {
    projectId: fulfillment.projectId,
    opportunityId: opportunity.id,
    fulfillmentId: fulfillment.id,
    mechanism: opportunity.mechanism,
    fulfillmentKind: fulfillment.kind,
    currency: reading.money.currency,
  };
  const put = async (
    outcome: 'SUCCESS' | 'FAILURE' | 'REFUND',
    marker: string,
    kind: OutcomeObservationKind,
    valueText: string,
    valueNumber: number | null = null,
  ): Promise<void> => {
    if (
      await recordObservation({
        ...base,
        outcome,
        kind,
        valueText,
        valueNumber,
        requestKey: `outcome:${fulfillment.id}:${marker}:${kind}`,
      })
    ) {
      written += 1;
    }
  };

  // Only a failure a person recorded is terminal for learning. A failure read
  // from the work can be retried into a success, and an obligation counted as
  // both would teach the next deal something that did not happen.
  const terminal = reading.complete
    ? 'SUCCESS'
    : reading.failure && reading.failure.kind !== 'WORK_FAILED'
      ? 'FAILURE'
      : null;
  if (terminal) {
    // Stable per terminal point: a recorded failure is named by its own event,
    // and a failure read from the work by the work it read — never by a
    // timestamp a later write to the obligation could move.
    const marker =
      terminal === 'SUCCESS'
        ? 'complete'
        : `failed:${digest(reading.failure!.kind, reading.failure!.at)}`;
    const decision = [...events].reverse().find((one) => one.kind === 'ACCEPTED' || one.kind === 'REJECTED');
    if (decision) {
      await put(terminal, marker, 'BUYER_RESPONSE', `${decision.kind}: ${decision.detail}`);
    }
    await put(terminal, marker, 'AGREED_PRICE', `${reading.money.agreedCents} cents agreed`, reading.money.agreedCents);
    if (reading.delivery.deliveredAt && fulfillment.workCreatedAt) {
      const seconds = Math.max(
        0,
        Math.round((Date.parse(reading.delivery.deliveredAt) - Date.parse(fulfillment.workCreatedAt)) / 1000),
      );
      await put(terminal, marker, 'DELIVERY_TIME', `${seconds} seconds from work opened to delivery`, seconds);
    }
    await put(
      terminal,
      marker,
      'ACCEPTANCE',
      terminal === 'SUCCESS'
        ? `Accepted against: ${reading.acceptance.condition}`
        : `Not accepted: ${reading.failure!.reason}`,
    );
    await put(
      terminal,
      marker,
      'ACTUAL_COST',
      `${reading.money.costCents} cents spent, ${reading.money.unpaidCommitmentCents} still owed`,
      reading.money.costCents,
    );
    if (fulfillment.kind === 'SUPPLIER') {
      await put(
        terminal,
        marker,
        'SUPPLIER_RELIABILITY',
        reading.supplier?.failed
          ? `${fulfillment.supplierName} failed: ${reading.supplier.failed}`
          : `${fulfillment.supplierName} delivered`,
      );
    }
    await put(
      terminal,
      marker,
      'REALIZED_CONTRIBUTION',
      `${reading.money.contributionCents - reading.money.unpaidCommitmentCents} cents realized, after ` +
        `${reading.money.unpaidCommitmentCents} still owed to the supplier`,
      reading.money.contributionCents - reading.money.unpaidCommitmentCents,
    );
  }
  for (const refund of reading.refunds) {
    if (refund.state !== 'CONFIRMED') continue;
    const marker = `refund:${refund.refundKey}`;
    await put('REFUND', marker, 'REFUND_REASON', refund.reason, refund.amountCents);
    await put(
      'REFUND',
      marker,
      'REALIZED_CONTRIBUTION',
      `${reading.money.contributionCents - reading.money.unpaidCommitmentCents} cents realized after the ` +
        `refund, net of ${reading.money.unpaidCommitmentCents} still owed to the supplier`,
      reading.money.contributionCents - reading.money.unpaidCommitmentCents,
    );
  }
  return written;
}

export interface OutcomeLesson {
  mechanism: string;
  fulfillmentKind: FulfillmentKind;
  /** How many obligations these observations come from. The sample, shown. */
  obligations: number;
  successes: number;
  failures: number;
  refunds: number;
  /** Each realized contribution, in cents, so a reader sees the spread. */
  contributions: number[];
  deliverySeconds: number[];
  refundReasons: string[];
  /** One observation is an anecdote, and it is said so rather than hidden. */
  anecdote: boolean;
}

/**
 * What finished work says about each kind of opportunity, with the sample.
 *
 * Grouped exactly by mechanism and fulfillment kind, never merged across them,
 * and never reduced to a rate: a group of two reports two. It informs and never
 * gates — nothing in ranking or research reads this to refuse anything — and it
 * is what a future question about a mechanism's economics can be asked against.
 */
export async function outcomeLessons(projectId: string, mechanism?: string): Promise<OutcomeLesson[]> {
  const observations = await listObservations({ projectId, mechanism });
  const groups = new Map<string, { obs: CashOutcomeObservation[] }>();
  for (const one of observations) {
    const key = `${one.mechanism}\u0000${one.fulfillmentKind}`;
    const group = groups.get(key) ?? { obs: [] };
    group.obs.push(one);
    groups.set(key, group);
  }
  const out: OutcomeLesson[] = [];
  for (const { obs } of groups.values()) {
    const first = obs[0]!;
    const fulfillments = new Set(obs.map((one) => one.fulfillmentId));
    const terminal = (outcome: string) =>
      new Set(obs.filter((one) => one.outcome === outcome).map((one) => one.fulfillmentId)).size;
    const finalContribution = new Map<string, number>();
    for (const one of obs) {
      if (one.kind === 'REALIZED_CONTRIBUTION' && one.valueNumber !== null) {
        finalContribution.set(one.fulfillmentId, one.valueNumber);
      }
    }
    out.push({
      mechanism: first.mechanism,
      fulfillmentKind: first.fulfillmentKind,
      obligations: fulfillments.size,
      successes: terminal('SUCCESS'),
      failures: terminal('FAILURE'),
      refunds: obs.filter((one) => one.kind === 'REFUND_REASON').length,
      contributions: [...finalContribution.values()],
      deliverySeconds: obs
        .filter((one) => one.kind === 'DELIVERY_TIME' && one.valueNumber !== null)
        .map((one) => one.valueNumber!),
      refundReasons: obs.filter((one) => one.kind === 'REFUND_REASON').map((one) => one.valueText),
      anecdote: fulfillments.size < 2,
    });
  }
  return out.sort((a, b) => a.mechanism.localeCompare(b.mechanism) || a.fulfillmentKind.localeCompare(b.fulfillmentKind));
}
