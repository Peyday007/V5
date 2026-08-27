/**
 * Running an operation at most once, honestly.
 *
 * ---------------------------------------------------------------------------
 * The shape
 * ---------------------------------------------------------------------------
 *
 *   1. Reserve, in its own committed transaction.
 *   2. Execute and record success, in one transaction.
 *   3. On failure, decide whether this was retryable or terminal.
 *
 * The reservation commits separately on purpose. If it shared a transaction
 * with the execution, a second caller's `INSERT` would block on the uncommitted
 * row for as long as the first caller's work took — turning a duplicate request
 * into a held lock. Committing it first means the loser finds out immediately
 * what is happening and can replay, wait or be refused.
 *
 * The *execution* and the transition to `SUCCEEDED` do share a transaction, and
 * that is what makes "either both or neither" true rather than aspirational: a
 * crash between the domain mutation and the success record is impossible,
 * because there is no between.
 *
 * ---------------------------------------------------------------------------
 * The fence
 * ---------------------------------------------------------------------------
 *
 * When the work is being performed under a queue lease, the first statement
 * inside that transaction re-proves ownership as a *write*
 * (`proveLeaseOwnership`). A stale worker — expired lease, reclaimed item,
 * cancelled work — matches nothing, the transaction aborts, and no effect is
 * committed. Checking with a SELECT would leave a window between the check and
 * the commit; this does not.
 *
 * ---------------------------------------------------------------------------
 * What this does not claim
 * ---------------------------------------------------------------------------
 *
 * Exactly-once across every provider. Same-database effects commit exactly
 * once. External effects get whatever their provider can actually support, and
 * `services/effects/adapter.ts` is where that difference is made explicit
 * rather than papered over.
 */
import { getDb } from '../../db/database.ts';
import {
  beginAttemptOn,
  closeAttempt,
  failOperation,
  findOperation,
  getOperation,
  openAttempt,
  reserveOperation,
  succeedOperation,
  takeOverOperation,
  type ReserveOutcome,
} from '../../repos/idempotency.ts';
import { proveLeaseOwnership, type OwnershipProof } from '../../repos/workQueue.ts';
import {
  FINGERPRINT_VERSION,
  assertValidKey,
  fingerprintKey,
  fingerprintRequest,
  scopeHash,
  type PrincipalScope,
} from './fingerprint.ts';
import type {
  ActorType,
  EffectFailureCategory,
  IdempotencyOperation,
  RetentionClass,
} from '../../domain/types.ts';

/**
 * The Brain this is.
 *
 * One installation today, so a constant — but it is in the scope hash from the
 * beginning, because retrofitting a boundary into a key derivation later means
 * every existing key changes meaning on the day it lands.
 */
export const BRAIN_BOUNDARY = 'brain';

/** What an operation namespace declares about itself. */
export interface OperationNamespace {
  name: string;
  version: number;
  /** Two people doing this: one intent, or two? */
  principalScope: PrincipalScope;
  /** How long the record must outlive the effect. */
  retention: RetentionClass;
}

export class OperationConflict extends Error {
  readonly operation: IdempotencyOperation;
  constructor(operation: IdempotencyOperation, message: string) {
    super(message);
    this.name = 'OperationConflict';
    this.operation = operation;
  }
}

export class OperationInProgress extends Error {
  readonly operation: IdempotencyOperation;
  constructor(operation: IdempotencyOperation) {
    super('An equivalent operation is already running.');
    this.name = 'OperationInProgress';
    this.operation = operation;
  }
}

export class EffectFenceLost extends Error {
  constructor() {
    super('This worker no longer owns the work item, so the effect was not committed.');
    this.name = 'EffectFenceLost';
  }
}

/**
 * Thrown by an executor to say "this failed, and trying again will not help".
 *
 * Anything else thrown is treated as retryable, which is the safe default: a
 * transient database blip should not permanently close an operation.
 */
export class TerminalEffectFailure extends Error {
  readonly category: EffectFailureCategory;
  constructor(category: EffectFailureCategory, message: string) {
    super(message);
    this.name = 'TerminalEffectFailure';
    this.category = category;
  }
}

export interface ExecutionContext {
  operation: IdempotencyOperation;
  attemptNumber: number;
}

export interface ExecutionResult<T> {
  /** A reference to the canonical Brain record this produced. */
  resultRef?: string | null;
  resultStatus?: number | null;
  resultSummary?: string | null;
  /** What the caller gets back on this, the original execution. */
  value: T;
}

export interface RunInput {
  namespace: OperationNamespace;
  projectId: string;
  /** The caller-supplied key, or a stable logical key for queue work. */
  key: string;
  /** The semantic input. Never credentials, timestamps or request ids. */
  payload: unknown;
  principalType: ActorType;
  principalId: string;
  correlationId?: string | null;
  /** Present when this effect is performed under a queue lease. */
  fence?: OwnershipProof | null;
}

export type RunOutcome<T> =
  | { status: 'EXECUTED'; operation: IdempotencyOperation; value: T }
  | { status: 'REPLAYED'; operation: IdempotencyOperation }
  | { status: 'UNCERTAIN'; operation: IdempotencyOperation }
  | { status: 'TERMINAL_FAILURE'; operation: IdempotencyOperation };

/**
 * Run a same-database effect at most once.
 *
 * `execute` runs inside a transaction that also records the success, and — when
 * a fence is supplied — inside one that has already re-proved lease ownership.
 * It must not call an external provider: that is `runExternalEffect`, because
 * holding a database transaction open across a network call is how a pool gets
 * exhausted by one slow provider.
 */
export async function runIdempotent<T>(
  input: RunInput,
  execute: (context: ExecutionContext) => Promise<ExecutionResult<T>>,
): Promise<RunOutcome<T>> {
  assertValidKey(input.key);

  const scope = scopeHash({
    boundary: BRAIN_BOUNDARY,
    projectId: input.projectId,
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    principalScope: input.namespace.principalScope,
    principalType: input.principalType,
    principalId: input.principalId,
  });
  const requestFingerprint = fingerprintRequest({
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    projectId: input.projectId,
    payload: input.payload,
  });

  const reserved: ReserveOutcome = await reserveOperation({
    scopeHash: scope,
    keyFingerprint: fingerprintKey(input.key),
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    projectId: input.projectId,
    requestFingerprint,
    fingerprintVersion: FINGERPRINT_VERSION,
    createdByType: input.principalType,
    createdById: input.principalId,
    correlationId: input.correlationId ?? null,
    workItemId: input.fence?.workItemId ?? null,
    leaseGeneration: input.fence?.leaseGeneration ?? null,
    retentionClass: input.namespace.retention,
  });

  switch (reserved.outcome) {
    case 'CONFLICT':
      // Never executed, and the previous payload is never disclosed. The caller
      // learns only that the key is taken.
      throw new OperationConflict(
        reserved.operation,
        'That idempotency key has already been used for a different request.',
      );
    case 'REPLAY':
      return { status: 'REPLAYED', operation: reserved.operation };
    case 'UNCERTAIN':
      return { status: 'UNCERTAIN', operation: reserved.operation };
    case 'TERMINAL_FAILURE':
      return { status: 'TERMINAL_FAILURE', operation: reserved.operation };
    case 'IN_PROGRESS':
      throw new OperationInProgress(reserved.operation);
    case 'RECOVERABLE': {
      // Somebody's executor died holding this. Taking it over is a
      // compare-and-swap, so two recoverers cannot both win.
      const taken = await takeOverOperation(
        reserved.operation.id,
        reserved.operation.recoverAfter ?? '',
      );
      if (!taken) throw new OperationInProgress(reserved.operation);
      break;
    }
    case 'RESERVED':
      break;
  }

  const operation = reserved.operation;
  const attemptNumber = await beginAttemptOn(operation.id);
  const attempt = await openAttempt({
    operationId: operation.id,
    attemptNumber,
    executorType: input.principalType,
    executorId: input.principalId,
    workItemId: input.fence?.workItemId ?? null,
    leaseId: input.fence?.leaseId ?? null,
    leaseGeneration: input.fence?.leaseGeneration ?? null,
    requestId: input.correlationId ?? null,
  });

  try {
    const value = await getDb().transaction(async () => {
      // The fence, first, as a write. Everything after this either commits with
      // it or does not commit at all.
      if (input.fence) {
        const owns = await proveLeaseOwnership(input.fence);
        if (!owns) throw new EffectFenceLost();
      }

      const produced = await execute({ operation, attemptNumber });

      const recorded = await succeedOperation(operation.id, {
        resultRef: produced.resultRef ?? null,
        resultStatus: produced.resultStatus ?? null,
        resultSummary: produced.resultSummary ?? null,
      });
      if (!recorded) {
        // Somebody finished this while we were working. Roll back rather than
        // commit a second domain effect beside their result.
        throw new OperationInProgress(operation);
      }
      return produced.value;
    });

    await closeAttempt(attempt.id, { phase: 'CONFIRMED', outcome: 'SUCCEEDED' });
    const settled = (await getOperation(operation.id)) ?? operation;
    return { status: 'EXECUTED', operation: settled, value };
  } catch (error) {
    const terminal = error instanceof TerminalEffectFailure;
    const category: EffectFailureCategory = terminal
      ? error.category
      : error instanceof EffectFenceLost
        ? 'NOT_AUTHORIZED'
        : 'INTERNAL_ERROR';

    await closeAttempt(attempt.id, {
      phase: 'FAILED',
      outcome: 'FAILED',
      // Bounded and sanitized by the repository. Never a stack trace.
      detail: error instanceof Error ? error.message : String(error),
    });
    // A lost fence is not this operation's failure — the work belongs to
    // somebody else now, and the operation stays open for whoever holds it.
    await failOperation(operation.id, {
      category,
      terminal,
      detail: terminal ? error.message : null,
    });
    throw error;
  }
}

/**
 * Read a completed operation's outcome without executing anything.
 *
 * Used by a queue attempt that wants to know whether the effect it was about to
 * perform has already been performed — the difference between redelivery being
 * safe and redelivery being a second effect.
 */
export async function findCompletedEffect(input: {
  namespace: OperationNamespace;
  projectId: string;
  key: string;
  principalType: ActorType;
  principalId: string;
}): Promise<IdempotencyOperation | null> {
  const scope = scopeHash({
    boundary: BRAIN_BOUNDARY,
    projectId: input.projectId,
    namespace: input.namespace.name,
    namespaceVersion: input.namespace.version,
    principalScope: input.namespace.principalScope,
    principalType: input.principalType,
    principalId: input.principalId,
  });
  return await findOperation(scope, fingerprintKey(input.key));
}
