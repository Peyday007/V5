/**
 * The distributed work queue, over HTTP.
 *
 * A narrow, authenticated contract — enough to operate the queue and to prove
 * it against the real deployment, and no more. **This is not the remote MCP
 * interface.** Step 7 builds that, and it will call the same repository
 * functions these handlers call rather than reimplementing a line of the
 * concurrency logic.
 *
 * Two rules run through every handler here:
 *
 *   1. **The principal decides who the worker is.** Not a body field, not a
 *      header, not an id in a path. A request that says `"workerId": "..."` is
 *      ignored on that point; the worker is whoever the credential
 *      authenticated as. Otherwise a worker with one valid credential could act
 *      as any other worker by asking politely.
 *   2. **The project comes from the row.** `requireWorkItem` reads the item,
 *      then authorizes the project that item actually belongs to. Guessing an
 *      id from another project gets the same 404 as an id that never existed.
 */
import { Router } from 'express';
import type {
  WorkFailureCategory,
  WorkItem,
  WorkItemState,
  WorkerScope,
} from '../domain/types.ts';
import { WORK_FAILURE_CATEGORIES, WORK_ITEM_STATES } from '../domain/types.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { recordIdentityEvent } from '../repos/identity.ts';
import {
  PayloadTooLarge,
  cancelWork,
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  heartbeatWork,
  listLeases,
  listWorkItems,
  queueMetrics,
  releaseWork,
  type ClaimScope,
  type LeaseResult,
  type OwnershipProof,
} from '../repos/workQueue.ts';
import {
  InvalidWorkPayload,
  UnknownWorkType,
  listWorkTypes,
  workType,
} from '../services/queue/workTypes.ts';
import {
  badRequest,
  bodyOf,
  conflict,
  handler,
  notFound,
  optionalInteger,
  optionalString,
  optionalStringArray,
  pathId,
  requireProject,
  requireWorkItem,
  requiredString,
} from './helpers.ts';

export const workRouter: Router = Router();

/* ------------------------------------------------------------------------ */
/* Audit                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Queue operations are audited to `identity_events`, beside the sign-ins and
 * the authorization denials, because "which principal took this work and what
 * happened to it" is the same question as "who did what" and deserves one
 * answer in one place.
 *
 * Heartbeats are the exception and are not audited. A fleet heartbeating every
 * few seconds would bury every event worth reading; the current lease row
 * carries a count and a last-seen timestamp instead, which is the same evidence
 * without the volume.
 */
async function audit(input: {
  action: string;
  workItemId?: string | null;
  projectId?: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const principal = currentPrincipal();
  const context = currentContext();
  try {
    await recordIdentityEvent({
      actorType: principal ? principal.type : 'ANONYMOUS',
      actorId: principal?.id ?? null,
      credentialId: principal?.credentialId ?? null,
      action: input.action,
      targetType: 'WORK_ITEM',
      targetId: input.workItemId ?? null,
      projectId: input.projectId ?? null,
      result: input.result,
      requestId: context?.requestId ?? null,
      // Never a payload, never a credential, never a provider response: counts,
      // categories and ids only.
      metadata: input.metadata ?? {},
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    // Losing the record of an operation is bad; turning the operation itself
    // into a failure because the record could not be written is worse.
  }
}

/* ------------------------------------------------------------------------ */
/* Shapes                                                                    */
/* ------------------------------------------------------------------------ */

/** What a person or another service is allowed to see about an item. */
function publicItem(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    projectId: item.projectId,
    workType: item.workType,
    state: item.state,
    priority: item.priority,
    availableAt: item.availableAt,
    payload: item.payload,
    requiredScopes: item.requiredScopes,
    targetWorkerId: item.targetWorkerId,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    leaseGeneration: item.leaseGeneration,
    // The lease id is not published. It is proof of ownership, and a reader
    // with permission to look at the queue is not thereby its owner.
    hasLease: item.leaseId !== null,
    workerId: item.workerId,
    leasedAt: item.leasedAt,
    heartbeatAt: item.heartbeatAt,
    leaseExpiresAt: item.leaseExpiresAt,
    resultRef: item.resultRef,
    resultSummary: item.resultSummary,
    failureCategory: item.failureCategory,
    cancelledReason: item.cancelledReason,
    correlationId: item.correlationId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
  };
}

/** The authenticated worker, or a refusal. Never a caller-supplied id. */
function currentWorkerId(): string {
  const principal = currentPrincipal();
  if (!principal || principal.type !== 'WORKER') {
    throw badRequest('Only a worker may take or report on queued work.');
  }
  return principal.id;
}

/**
 * Turn a refused ownership proof into a response.
 *
 * Deliberately uniform: every refusal is a 409 with a category. A worker whose
 * lease was reclaimed and a worker that never held the lease get the same shape
 * of answer, because the difference is not something a stale owner needs to
 * know and the categories are for the operator reading the audit trail.
 */
function refuse(result: Extract<LeaseResult, { ok: false }>): never {
  if (result.rejection === 'NOT_FOUND') throw notFound('No work item with that id.');
  throw conflict('This lease is no longer current.', { reason: result.rejection });
}

function proofFrom(req: Parameters<typeof bodyOf>[0], workItemId: string): OwnershipProof {
  const body = bodyOf(req);
  const generation = optionalInteger(body['leaseGeneration'], 'leaseGeneration', { min: 0 });
  if (generation === undefined) throw badRequest('leaseGeneration is required.');
  return {
    workItemId,
    workerId: currentWorkerId(),
    leaseId: requiredString(body['leaseId'], 'leaseId'),
    leaseGeneration: generation,
  };
}

/* ------------------------------------------------------------------------ */
/* Enqueue and inspect — project scoped                                      */
/* ------------------------------------------------------------------------ */

workRouter.post(
  '/projects/:projectId/work',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const type = requiredString(body['workType'], 'workType');

    let definition;
    try {
      definition = workType(type);
    } catch (error) {
      if (error instanceof UnknownWorkType) {
        await audit({
          action: 'QUEUE_ENQUEUE',
          projectId: project.id,
          result: 'DENIED',
          metadata: { workType: type, reason: 'UNKNOWN_WORK_TYPE' },
        });
        throw badRequest(error.message, {
          registered: listWorkTypes().map((entry) => entry.type),
        });
      }
      throw error;
    }

    let payload: Record<string, unknown>;
    try {
      payload = definition.validate(body['payload']);
    } catch (error) {
      if (error instanceof InvalidWorkPayload) throw badRequest(error.message);
      throw error;
    }

    const principal = currentPrincipal();
    try {
      const item = await enqueueWork({
        projectId: project.id,
        workType: definition.type,
        payload,
        priority: optionalInteger(body['priority'], 'priority', { min: 0, max: 9 }),
        requiredScopes: definition.requiredScopes,
        maxAttempts:
          optionalInteger(body['maxAttempts'], 'maxAttempts', { min: 1, max: 20 }) ??
          definition.defaultMaxAttempts,
        targetWorkerId: optionalString(body['targetWorkerId'], 'targetWorkerId') ?? null,
        correlationId: optionalString(body['correlationId'], 'correlationId') ?? null,
        createdByType: principal ? principal.type : 'SYSTEM',
        createdById: principal?.id ?? null,
      });
      await audit({
        action: 'QUEUE_ENQUEUE',
        workItemId: item.id,
        projectId: project.id,
        result: 'SUCCESS',
        metadata: { workType: item.workType, priority: item.priority },
      });
      return { item: publicItem(item) };
    } catch (error) {
      if (error instanceof PayloadTooLarge) throw badRequest(error.message);
      throw error;
    }
  }),
);

workRouter.get(
  '/projects/:projectId/work',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const states = (optionalStringArray(req.query['state'], 'state') ?? []).filter(
      (state): state is WorkItemState => (WORK_ITEM_STATES as readonly string[]).includes(state),
    );
    const items = await listWorkItems(project.id, {
      states,
      limit: optionalInteger(req.query['limit'], 'limit', { min: 1, max: 500 }),
    });
    return { items: items.map(publicItem) };
  }),
);

workRouter.get(
  '/projects/:projectId/work/metrics',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    // Scoped to one authorized project on purpose. A global count across every
    // project would tell a member of one project how busy the others are.
    return { metrics: await queueMetrics(project.id) };
  }),
);

workRouter.get(
  '/work/:workItemId',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    return { item: publicItem(item), attempts: await listLeases(item.id) };
  }),
);

/* ------------------------------------------------------------------------ */
/* Claim                                                                     */
/* ------------------------------------------------------------------------ */

workRouter.post(
  '/work/claim',
  handler(async (req) => {
    const principal = currentPrincipal();
    if (!principal || principal.type !== 'WORKER') {
      throw badRequest('Only a worker may claim queued work.');
    }
    const body = bodyOf(req);

    // Eligibility is rebuilt from the principal's live memberships on every
    // request. That is what makes revocation take effect on the next call
    // rather than at the next sign-in: a membership removed a second ago is
    // simply not in this list.
    const scopes: ClaimScope[] = principal.memberships
      .filter((membership) => (membership.scopes as WorkerScope[]).includes('queue:claim'))
      .map((membership) => ({
        projectId: membership.projectId,
        scopes: membership.scopes as WorkerScope[],
      }));

    // Holding the claim scope nowhere is an authorization answer, not an empty
    // queue, and the two must not look the same. A worker that has been granted
    // nothing should be told it may not claim — otherwise a revoked worker polls
    // forever against a queue that looks permanently idle, and an operator
    // debugging it sees "no work" instead of "no longer permitted".
    if (scopes.length === 0) {
      await audit({ action: 'QUEUE_CLAIM', result: 'DENIED', metadata: { reason: 'NO_CLAIM_SCOPE' } });
      throw notFound('No claimable work.');
    }

    // A caller may narrow to one project it already has, and may not widen.
    const requested = optionalString(body['projectId'], 'projectId');
    const eligible = requested ? scopes.filter((scope) => scope.projectId === requested) : scopes;
    if (requested && eligible.length === 0) {
      // Asking about a project this worker has no claim on. Refused the same way
      // as holding no scope at all, so the answer cannot be used to discover
      // which projects exist.
      await audit({
        action: 'QUEUE_CLAIM',
        projectId: null,
        result: 'DENIED',
        metadata: { reason: 'NOT_A_MEMBER' },
      });
      throw notFound('No claimable work.');
    }

    const claimed = await claimWork({
      workerId: principal.id,
      credentialId: principal.credentialId,
      scopes: eligible,
      workTypes: optionalStringArray(body['workTypes'], 'workTypes'),
      limit: optionalInteger(body['limit'], 'limit', { min: 1, max: 25 }),
      leaseMs: optionalInteger(body['leaseMs'], 'leaseMs', { min: 0 }),
      requestId: currentContext()?.requestId ?? null,
    });

    for (const claim of claimed) {
      await audit({
        action: 'QUEUE_CLAIM',
        workItemId: claim.workItemId,
        projectId: claim.projectId,
        result: 'SUCCESS',
        metadata: {
          workType: claim.workType,
          attemptNumber: claim.attemptNumber,
          leaseGeneration: claim.leaseGeneration,
        },
      });
    }
    // An empty list is a normal answer. An idle fleet asks this constantly and
    // must not be told it did something wrong.
    return { claimed };
  }),
);

/* ------------------------------------------------------------------------ */
/* Owning it                                                                 */
/* ------------------------------------------------------------------------ */

workRouter.post(
  '/work/:workItemId/heartbeat',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    const proof = proofFrom(req, item.id);
    const body = bodyOf(req);
    const result = await heartbeatWork(proof, {
      // A request, not a decision: the server clamps it.
      leaseMs: optionalInteger(body['leaseMs'], 'leaseMs', { min: 0 }),
    });
    if (!result.ok) {
      await audit({
        action: 'QUEUE_HEARTBEAT',
        workItemId: item.id,
        projectId: item.projectId,
        result: 'DENIED',
        metadata: { reason: result.rejection },
      });
      refuse(result);
    }
    // A successful heartbeat is not audited — see the note on `audit` above.
    return {
      workItemId: result.item.id,
      leaseGeneration: result.item.leaseGeneration,
      leaseExpiresAt: result.item.leaseExpiresAt,
    };
  }),
);

workRouter.post(
  '/work/:workItemId/complete',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    const proof = proofFrom(req, item.id);
    const body = bodyOf(req);
    const result = await completeWork(proof, {
      resultRef: optionalString(body['resultRef'], 'resultRef') ?? null,
      summary: optionalString(body['summary'], 'summary') ?? null,
    });
    await audit({
      action: 'QUEUE_COMPLETE',
      workItemId: item.id,
      projectId: item.projectId,
      result: result.ok ? 'SUCCESS' : 'DENIED',
      metadata: result.ok
        ? { leaseGeneration: proof.leaseGeneration }
        : { reason: result.rejection },
    });
    if (!result.ok) refuse(result);
    return { item: publicItem(result.item) };
  }),
);

workRouter.post(
  '/work/:workItemId/fail',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    const proof = proofFrom(req, item.id);
    const body = bodyOf(req);
    const category = optionalString(body['category'], 'category') ?? 'UNKNOWN';
    if (!(WORK_FAILURE_CATEGORIES as readonly string[]).includes(category)) {
      throw badRequest('That is not a failure category.', {
        categories: WORK_FAILURE_CATEGORIES,
      });
    }
    const retryable = body['retryable'];
    if (retryable !== undefined && typeof retryable !== 'boolean') {
      throw badRequest('retryable must be a boolean when present.');
    }
    const result = await failWork(proof, {
      category: category as WorkFailureCategory,
      // Bounded and sanitized by the repository. Never a stack trace, never a
      // provider response.
      detail: optionalString(body['detail'], 'detail') ?? null,
      retryable: retryable as boolean | undefined,
    });
    await audit({
      action: 'QUEUE_FAIL',
      workItemId: item.id,
      projectId: item.projectId,
      result: result.ok ? 'SUCCESS' : 'DENIED',
      metadata: result.ok
        ? { category, state: result.item.state, attemptCount: result.item.attemptCount }
        : { reason: result.rejection },
    });
    if (!result.ok) refuse(result);
    return { item: publicItem(result.item) };
  }),
);

workRouter.post(
  '/work/:workItemId/release',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    const proof = proofFrom(req, item.id);
    const result = await releaseWork(
      proof,
      optionalString(bodyOf(req)['detail'], 'detail') ?? null,
    );
    await audit({
      action: 'QUEUE_RELEASE',
      workItemId: item.id,
      projectId: item.projectId,
      result: result.ok ? 'SUCCESS' : 'DENIED',
      metadata: result.ok ? { state: result.item.state } : { reason: result.rejection },
    });
    if (!result.ok) refuse(result);
    return { item: publicItem(result.item) };
  }),
);

/* ------------------------------------------------------------------------ */
/* Cancellation — a human authority                                          */
/* ------------------------------------------------------------------------ */

workRouter.post(
  '/work/:workItemId/cancel',
  handler(async (req) => {
    const item = await requireWorkItem(pathId(req, 'workItemId'));
    const reason = optionalString(bodyOf(req)['reason'], 'reason') ?? 'cancelled by an operator';
    const result = await cancelWork(item.id, reason);
    await audit({
      action: 'QUEUE_CANCEL',
      workItemId: item.id,
      projectId: item.projectId,
      result: result.ok ? 'SUCCESS' : 'DENIED',
      metadata: result.ok ? {} : { reason: result.reason },
    });
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') throw notFound('No work item with that id.');
      throw conflict('That work item has already finished.', { reason: result.reason });
    }
    return { item: publicItem(result.item) };
  }),
);
