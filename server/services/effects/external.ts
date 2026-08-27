/**
 * Performing an external effect, and being honest about what happened.
 *
 * The shape is deliberately different from `runIdempotent`: **no database
 * transaction is open while the provider is called.** Holding one across a
 * network round trip is how one slow provider exhausts a connection pool, and
 * it would make the timeout window — the exact moment this file exists to
 * handle — the worst possible time to be holding locks.
 *
 * So the sequence is:
 *
 *   1. Reserve the operation, and persist *intent* — an attempt row, before
 *      anything is sent. If the process dies here, the next attempt knows
 *      something might have been sent.
 *   2. Mark the attempt SENT, then send. Outside any transaction.
 *   3. Record what came back, in its own short transaction.
 *
 * Step 1 and 2 are separate rows-worth of truth on purpose. "We were about to
 * send" and "we sent" are different facts, and after a crash the difference
 * decides whether reconciliation is needed.
 */
import {
  closeAttempt,
  failOperation,
  getOperation,
  latestSentAttempt,
  markAttemptSent,
  markUncertain,
  openAttempt,
  reserveOperation,
  succeedOperation,
  takeOverOperation,
  beginAttemptOn,
} from '../../repos/idempotency.ts';
import {
  FINGERPRINT_VERSION,
  assertValidKey,
  fingerprintKey,
  fingerprintRequest,
  scopeHash,
} from './fingerprint.ts';
import {
  deriveProviderKey,
  type EffectAdapter,
  type ReconcileOutcome,
  type SendOutcome,
} from './adapter.ts';
import {
  BRAIN_BOUNDARY,
  OperationConflict,
  OperationInProgress,
  type OperationNamespace,
} from './engine.ts';
import type { ActorType, IdempotencyOperation } from '../../domain/types.ts';

export interface ExternalRunInput {
  adapter: EffectAdapter;
  namespace: OperationNamespace;
  projectId: string;
  key: string;
  /** The stable business identity of the intended effect. */
  businessId: string;
  payload: unknown;
  principalType: ActorType;
  principalId: string;
  correlationId?: string | null;
}

export type ExternalOutcome =
  | { status: 'CONFIRMED'; operation: IdempotencyOperation; receiptRef: string }
  | { status: 'REPLAYED'; operation: IdempotencyOperation }
  | { status: 'RECONCILED'; operation: IdempotencyOperation; receiptRef: string }
  | { status: 'FAILED'; operation: IdempotencyOperation }
  /**
   * The outcome is unknown and will stay unknown until somebody establishes it.
   * Nothing automatic will resend. This is a successful *run* — it is the
   * correct handling of an uncertain effect, not an error in handling it.
   */
  | { status: 'UNCERTAIN'; operation: IdempotencyOperation; reason: string };

async function recordConfirmed(
  operation: IdempotencyOperation,
  attemptId: string,
  adapter: EffectAdapter,
  receiptRef: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const safe = adapter.redactReceipt ? adapter.redactReceipt(meta) : meta;
  await closeAttempt(attemptId, {
    phase: 'CONFIRMED',
    outcome: 'SUCCEEDED',
    receiptRef,
    receiptMeta: safe,
  });
  await succeedOperation(operation.id, { resultRef: receiptRef, resultSummary: null });
}

export async function runExternalEffect(input: ExternalRunInput): Promise<ExternalOutcome> {
  assertValidKey(input.key);
  const payload = input.adapter.validate(input.payload);

  const scope = scopeHash({
    boundary: BRAIN_BOUNDARY,
    projectId: input.projectId,
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    principalScope: input.namespace.principalScope,
    principalType: input.principalType,
    principalId: input.principalId,
  });
  const reserved = await reserveOperation({
    scopeHash: scope,
    keyFingerprint: fingerprintKey(input.key),
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    projectId: input.projectId,
    requestFingerprint: fingerprintRequest({
      namespace: input.namespace.name,
      namespaceVersion: input.namespace.version,
      projectId: input.projectId,
      payload: input.adapter.fingerprintInputs(payload),
    }),
    fingerprintVersion: FINGERPRINT_VERSION,
    createdByType: input.principalType,
    createdById: input.principalId,
    correlationId: input.correlationId ?? null,
    // External effect identities must outlive any window in which the same
    // effect could be attempted again. Deleting one would make a completed
    // external effect silently repeatable.
    retentionClass: 'PERMANENT',
  });

  switch (reserved.outcome) {
    case 'CONFLICT':
      throw new OperationConflict(
        reserved.operation,
        'That idempotency key has already been used for a different request.',
      );
    case 'REPLAY':
      return { status: 'REPLAYED', operation: reserved.operation };
    case 'TERMINAL_FAILURE':
      return { status: 'FAILED', operation: reserved.operation };
    case 'IN_PROGRESS':
      throw new OperationInProgress(reserved.operation);
    case 'UNCERTAIN':
      // The one path that must never quietly become another send.
      return await resumeUncertain(input.adapter, reserved.operation);
    case 'RECOVERABLE': {
      const taken = await takeOverOperation(
        reserved.operation.id,
        reserved.operation.recoverAfter ?? '',
      );
      if (!taken) throw new OperationInProgress(reserved.operation);
      // An executor died. Whether it had already sent is exactly what the
      // attempt rows are for.
      const resumed = await resumeAfterCrash(input.adapter, reserved.operation);
      if (resumed) return resumed;
      break;
    }
    case 'RESERVED':
      break;
  }

  const operation = reserved.operation;
  const attemptNumber = await beginAttemptOn(operation.id);
  const providerKey = deriveProviderKey({
    adapter: input.adapter,
    operationId: operation.id,
    businessId: input.businessId,
  });

  // Intent, persisted before anything leaves. This row is the difference
  // between "we may have sent something" and "we have no idea".
  const attempt = await openAttempt({
    operationId: operation.id,
    attemptNumber,
    executorType: input.principalType,
    executorId: input.principalId,
    adapter: input.adapter.name,
    providerKey,
    requestId: input.correlationId ?? null,
  });

  await markAttemptSent(attempt.id);

  let outcome: SendOutcome;
  try {
    outcome = await input.adapter.send({
      providerKey,
      businessId: input.businessId,
      payload,
    });
  } catch (error) {
    // A thrown transport error is the ambiguous case, not a failure. The
    // request may well have arrived.
    outcome = {
      kind: 'UNCERTAIN',
      reason: error instanceof Error ? error.message : 'the send threw',
    };
  }

  if (outcome.kind === 'CONFIRMED') {
    await recordConfirmed(
      operation,
      attempt.id,
      input.adapter,
      outcome.receiptRef,
      outcome.receiptMeta ?? {},
    );
    return {
      status: 'CONFIRMED',
      operation: (await getOperation(operation.id)) ?? operation,
      receiptRef: outcome.receiptRef,
    };
  }

  if (outcome.kind === 'REJECTED') {
    await closeAttempt(attempt.id, {
      phase: 'FAILED',
      outcome: 'FAILED',
      detail: outcome.detail ?? null,
    });
    // Only a provider that definitely did nothing may be retried. Anything
    // else is uncertainty wearing a failure's clothes.
    await failOperation(operation.id, {
      category: outcome.category,
      terminal: !outcome.retryable,
      detail: outcome.detail ?? null,
    });
    return { status: 'FAILED', operation: (await getOperation(operation.id)) ?? operation };
  }

  // Uncertain. Ask, if asking is possible.
  await closeAttempt(attempt.id, {
    phase: 'UNCERTAIN',
    outcome: 'UNCERTAIN',
    detail: outcome.reason,
  });
  const reconciled = await tryReconcile(input.adapter, operation, input.businessId);
  if (reconciled) return reconciled;

  await markUncertain(operation.id, outcome.reason);
  return {
    status: 'UNCERTAIN',
    operation: (await getOperation(operation.id)) ?? operation,
    reason: outcome.reason,
  };
}

/**
 * Ask the provider what it already did.
 *
 * Only possible for a reconcilable adapter. For an opaque one this returns
 * null and the operation stops — which is the whole point of the class.
 */
async function tryReconcile(
  adapter: EffectAdapter,
  operation: IdempotencyOperation,
  businessId: string,
): Promise<ExternalOutcome | null> {
  if (!adapter.reconcile) return null;

  let answer: ReconcileOutcome;
  try {
    answer = await adapter.reconcile(businessId);
  } catch (error) {
    // Failing to reconcile is not evidence either way. Stop.
    return null;
  }

  if (answer.kind === 'FOUND') {
    const safe = adapter.redactReceipt
      ? adapter.redactReceipt(answer.receiptMeta ?? {})
      : (answer.receiptMeta ?? {});
    const attempt = await latestSentAttempt(operation.id);
    if (attempt) {
      await closeAttempt(attempt.id, {
        phase: 'CONFIRMED',
        outcome: 'SUCCEEDED',
        receiptRef: answer.receiptRef,
        receiptMeta: safe,
        detail: 'reconciled with the provider after an ambiguous send',
      });
    }
    await succeedOperation(operation.id, { resultRef: answer.receiptRef });
    return {
      status: 'RECONCILED',
      operation: (await getOperation(operation.id)) ?? operation,
      receiptRef: answer.receiptRef,
    };
  }

  if (answer.kind === 'ABSENT') {
    // The provider is authoritative and says it never saw it, so nothing
    // happened and this may be executed again.
    await failOperation(operation.id, {
      category: 'DEPENDENCY_UNAVAILABLE',
      terminal: false,
      detail: 'the provider confirmed it never received this',
    });
    return { status: 'FAILED', operation: (await getOperation(operation.id)) ?? operation };
  }

  return null; // INCONCLUSIVE — leave it uncertain
}

/** A retry arriving at an operation that is already UNCERTAIN. */
async function resumeUncertain(
  adapter: EffectAdapter,
  operation: IdempotencyOperation,
): Promise<ExternalOutcome> {
  // One more attempt to reconcile is safe — asking is not sending.
  const attempt = await latestSentAttempt(operation.id);
  if (adapter.reconcile && attempt) {
    const answer = await adapter.reconcile(operation.resultRef ?? operation.id).catch(() => null);
    if (answer && answer.kind === 'FOUND') {
      await closeAttempt(attempt.id, {
        phase: 'CONFIRMED',
        outcome: 'SUCCEEDED',
        receiptRef: answer.receiptRef,
        detail: 'reconciled on a later attempt',
      });
      return {
        status: 'RECONCILED',
        operation: (await getOperation(operation.id)) ?? operation,
        receiptRef: answer.receiptRef,
      };
    }
  }
  // Still unknown. It stays unknown, and nothing here resends it.
  return {
    status: 'UNCERTAIN',
    operation,
    reason: operation.uncertaintyReason ?? 'the outcome of an earlier send is unknown',
  };
}

/**
 * Resume an operation whose executor died.
 *
 * The question is whether it had already sent. If an attempt row reached
 * `SENT` and never closed, something may be out there — for a reconcilable
 * adapter, ask; for anything else, refuse to guess.
 */
async function resumeAfterCrash(
  adapter: EffectAdapter,
  operation: IdempotencyOperation,
): Promise<ExternalOutcome | null> {
  const attempt = await latestSentAttempt(operation.id);
  if (!attempt) return null; // nothing was ever sent; a fresh attempt is safe
  if (attempt.endedAt !== null) return null; // that attempt was resolved

  if (adapter.effectClass === 'EXTERNAL_IDEMPOTENT') {
    // Safe to send again: the provider de-duplicates on the same stable key,
    // which is exactly what native idempotency buys.
    return null;
  }

  const reconciled = await tryReconcile(adapter, operation, attempt.providerKey ?? operation.id);
  if (reconciled) return reconciled;

  const reason =
    'an earlier attempt sent this and did not record an outcome, and the provider cannot be asked';
  await markUncertain(operation.id, reason);
  return {
    status: 'UNCERTAIN',
    operation: (await getOperation(operation.id)) ?? operation,
    reason,
  };
}
