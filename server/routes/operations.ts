/**
 * Inspecting and resolving operations.
 *
 * The smallest surface that lets an authorized administrator finish what an
 * uncertain effect started, and nothing more. Deliberately not an operations
 * dashboard — that is Step 12 — and deliberately not a way to make a retry
 * possible by deleting the evidence that says it already happened.
 *
 * Every route here is project-scoped and administrator-only, because resolving
 * an uncertain external effect is a judgement about the outside world that only
 * a person can make. The engine will never make it automatically, which is the
 * entire reason this file exists.
 */
import { Router } from 'express';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { recordIdentityEvent } from '../repos/identity.ts';
import {
  getOperation,
  listAttempts,
  listOperations,
  resolveUncertain,
} from '../repos/idempotency.ts';
import { EFFECT_FAILURE_CATEGORIES, OPERATION_STATES } from '../domain/types.ts';
import type {
  EffectFailureCategory,
  IdempotencyOperation,
  OperationState,
} from '../domain/types.ts';
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
  requiredString,
  authorizeProject,
} from './helpers.ts';

export const operationsRouter: Router = Router();

async function audit(input: {
  action: string;
  operationId: string | null;
  projectId: string | null;
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
      targetType: 'OPERATION',
      targetId: input.operationId,
      projectId: input.projectId,
      result: input.result,
      requestId: context?.requestId ?? null,
      metadata: input.metadata ?? {},
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    /* losing the record must not turn the operation into a failure */
  }
}

/**
 * What an administrator is allowed to see.
 *
 * Not the idempotency key — only its digest is stored, and even that is not
 * published. Not a request payload; only its fingerprint, which answers "was
 * this the same request" without disclosing what the request was.
 */
function publicOperation(operation: IdempotencyOperation): Record<string, unknown> {
  return {
    id: operation.id,
    namespace: operation.namespace,
    namespaceVersion: operation.namespaceVersion,
    projectId: operation.projectId,
    state: operation.state,
    attemptCount: operation.attemptCount,
    failureCategory: operation.failureCategory,
    uncertaintyReason: operation.uncertaintyReason,
    resultRef: operation.resultRef,
    resultStatus: operation.resultStatus,
    resultSummary: operation.resultSummary,
    workItemId: operation.workItemId,
    leaseGeneration: operation.leaseGeneration,
    createdByType: operation.createdByType,
    createdById: operation.createdById,
    correlationId: operation.correlationId,
    retentionClass: operation.retentionClass,
    // A prefix, so two operations can be told apart in a log without the
    // fingerprint itself becoming a way to test guesses at the request.
    requestFingerprintPrefix: operation.requestFingerprint.slice(0, 12),
    reservedAt: operation.reservedAt,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

/** Resolve an operation and authorize the project it actually belongs to. */
async function requireOperation(operationId: string): Promise<IdempotencyOperation> {
  const operation = await getOperation(operationId);
  if (!operation) throw notFound('No operation with that id.');
  await authorizeProject(operation.projectId, 'operation');
  return operation;
}

operationsRouter.get(
  '/projects/:projectId/operations',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const states = (optionalStringArray(req.query['state'], 'state') ?? []).filter(
      (state): state is OperationState => (OPERATION_STATES as readonly string[]).includes(state),
    );
    const operations = await listOperations(project.id, {
      states,
      limit: optionalInteger(req.query['limit'], 'limit', { min: 1, max: 500 }),
    });
    return { operations: operations.map(publicOperation) };
  }),
);

operationsRouter.get(
  '/operations/:operationId',
  handler(async (req) => {
    const operation = await requireOperation(pathId(req, 'operationId'));
    const attempts = await listAttempts(operation.id);
    return {
      operation: publicOperation(operation),
      // Attempt history, with receipts. `receipt_meta` was redacted by the
      // adapter before it was ever stored, so there is nothing further to strip.
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        executorType: attempt.executorType,
        executorId: attempt.executorId,
        workItemId: attempt.workItemId,
        leaseGeneration: attempt.leaseGeneration,
        adapter: attempt.adapter,
        // Whether a stable key was used, not the key itself.
        usedProviderKey: attempt.providerKey !== null,
        phase: attempt.phase,
        receiptRef: attempt.receiptRef,
        receiptMeta: attempt.receiptMeta,
        outcome: attempt.outcome,
        detail: attempt.detail,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
      })),
    };
  }),
);

/**
 * Resolve an uncertain operation.
 *
 * The only way out of `UNCERTAIN`, and it requires a person to state what they
 * established and why. It never deletes the operation or its attempts: the
 * record of the ambiguity survives its resolution, because "we sent this, did
 * not know what happened, and decided X" is the thing somebody will want to
 * read in six months.
 */
operationsRouter.post(
  '/operations/:operationId/resolve',
  handler(async (req) => {
    const operation = await requireOperation(pathId(req, 'operationId'));
    const body = bodyOf(req);
    const reason = requiredString(body['reason'], 'reason');
    const as = optionalString(body['as'], 'as');

    if (operation.state !== 'UNCERTAIN') {
      await audit({
        action: 'OPERATION_RESOLVE',
        operationId: operation.id,
        projectId: operation.projectId,
        result: 'DENIED',
        metadata: { reason: 'NOT_UNCERTAIN', state: operation.state },
      });
      // A succeeded operation is never silently overwritten.
      throw conflict('Only an operation with an unknown outcome can be resolved.', {
        reason: 'NOT_UNCERTAIN',
        state: operation.state,
      });
    }

    if (as === 'SUCCEEDED') {
      // Attaching a receipt the administrator verified with the provider.
      const receiptRef = optionalString(body['receiptRef'], 'receiptRef') ?? null;
      const resolved = await resolveUncertain(operation.id, {
        as: 'SUCCEEDED',
        resultRef: receiptRef,
        summary: reason,
      });
      if (!resolved) throw conflict('That operation changed while it was being resolved.');
      await audit({
        action: 'OPERATION_RESOLVE',
        operationId: operation.id,
        projectId: operation.projectId,
        result: 'SUCCESS',
        metadata: { as: 'SUCCEEDED', hasReceipt: receiptRef !== null },
      });
      return { operation: publicOperation((await getOperation(operation.id))!) };
    }

    if (as === 'FAILED') {
      const category = optionalString(body['category'], 'category') ?? 'ABANDONED';
      if (!(EFFECT_FAILURE_CATEGORIES as readonly string[]).includes(category)) {
        throw badRequest('That is not a failure category.', {
          categories: EFFECT_FAILURE_CATEGORIES,
        });
      }
      const resolved = await resolveUncertain(operation.id, {
        as: 'FAILED',
        category: category as EffectFailureCategory,
        detail: reason,
      });
      if (!resolved) throw conflict('That operation changed while it was being resolved.');
      await audit({
        action: 'OPERATION_RESOLVE',
        operationId: operation.id,
        projectId: operation.projectId,
        result: 'SUCCESS',
        metadata: { as: 'FAILED', category },
      });
      return { operation: publicOperation((await getOperation(operation.id))!) };
    }

    throw badRequest('"as" must be either SUCCEEDED or FAILED.');
  }),
);
