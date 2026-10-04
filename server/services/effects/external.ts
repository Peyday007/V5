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
  armRecovery,
  closeAttempt,
  failOperation,
  getOperation,
  latestSentAttempt,
  markAttemptSent,
  markUncertain,
  openAttempt,
  operationNow,
  resolveUncertain,
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

/**
 * How long one external attempt may run before a later caller treats its
 * executor as gone. Generous on purpose: being taken over early costs a
 * reconciliation (or an UNCERTAIN a person settles), never a second send,
 * because `resumeAfterCrash` asks before it acts.
 */
export const EXTERNAL_ATTEMPT_LEASE_MS = 15 * 60 * 1000;

/**
 * How long this executor waits for the provider before it stops waiting and
 * records the attempt as UNCERTAIN.
 *
 * Strictly shorter than the recovery lease, and that is the point: without a
 * bound, a send that was merely slow could outlive `EXTERNAL_ATTEMPT_LEASE_MS`,
 * be taken over by a later caller as though its executor had died, and then
 * confirm into an operation that caller had already settled — two executors
 * holding one effect. Bounded here, the executor gives the effect up before
 * anybody else may take it. Giving up is not evidence (invariant 26): the
 * attempt is UNCERTAIN, the provider is asked, and nothing is resent.
 */
export const EXTERNAL_SEND_TIMEOUT_MS = 5 * 60 * 1000;

let sendTimeoutMs = EXTERNAL_SEND_TIMEOUT_MS;

/** Tests only: shorten the wait so a slow provider can be exercised. */
export function setExternalSendTimeoutForTests(ms: number | null): void {
  sendTimeoutMs = ms ?? EXTERNAL_SEND_TIMEOUT_MS;
}

const SEND_TIMED_OUT = Symbol('send timed out');

/**
 * Asking is bounded too: a reconcile that never answers would otherwise hold
 * an executor past its lease exactly as an unbounded send did. A reconcile
 * that does not answer in time throws, which every caller reads as "could not
 * tell" — never as an answer.
 */
async function boundedReconcile(adapter: EffectAdapter, businessId: string): Promise<ReconcileOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked = adapter.reconcile!(businessId);
  asked.catch(() => undefined);
  try {
    return await Promise.race([
      asked,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the provider did not answer in time')), sendTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedSend(
  send: () => Promise<SendOutcome>,
  timeoutMs: number,
): Promise<SendOutcome | typeof SEND_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof SEND_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(SEND_TIMED_OUT), timeoutMs);
  });
  // A send that settles after the bound is deliberately ignored: by then the
  // attempt is UNCERTAIN and only the provider's own answer may resolve it.
  const sent = send();
  sent.catch(() => undefined);
  try {
    return await Promise.race([sent, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  if (await succeedOperation(operation.id, { resultRef: receiptRef, resultSummary: null })) return;
  // The operation left RESERVED while this attempt was out: a recovery took it
  // over and could not confirm it, so it is UNCERTAIN. A receipt is the
  // evidence an unknown waits for, so it resolves the unknown rather than
  // being dropped — dropped, a person could later close it as "did not
  // happen" and the retry that follows would be a second effect.
  await resolveUncertain(operation.id, {
    as: 'SUCCEEDED',
    resultRef: receiptRef,
    summary: 'the provider confirmed this attempt after it had been recorded as unknown',
  });
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
    recoverAfter: new Date(Date.parse(operationNow()) + EXTERNAL_ATTEMPT_LEASE_MS).toISOString(),
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
      return await resumeUncertain(input.adapter, reserved.operation, input.businessId);
    case 'RECOVERABLE': {
      const taken = await takeOverOperation(
        reserved.operation.id,
        reserved.operation.recoverAfter ?? '',
      );
      if (!taken) throw new OperationInProgress(reserved.operation);
      // An executor died. Whether it had already sent is exactly what the
      // attempt rows are for.
      const resumed = await resumeAfterCrash(input.adapter, reserved.operation, input.businessId);
      if (resumed) return resumed;
      break;
    }
    case 'RESERVED':
      break;
  }

  const operation = reserved.operation;
  const attemptNumber = await beginAttemptOn(operation.id);
  // If this process dies between here and recording what came back, the next
  // caller must be able to take over and ask the provider — never wait for
  // ever, and never send again blind. See `armRecovery`.
  await armRecovery(
    operation.id,
    new Date(Date.parse(operationNow()) + EXTERNAL_ATTEMPT_LEASE_MS).toISOString(),
  );
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
  let timedOut = false;
  try {
    const answered = await boundedSend(
      () =>
        input.adapter.send({
          providerKey,
          businessId: input.businessId,
          payload,
        }),
      sendTimeoutMs,
    );
    if (answered === SEND_TIMED_OUT) {
      timedOut = true;
      outcome = {
        kind: 'UNCERTAIN',
        reason: 'the provider did not answer within the time this attempt waits',
      };
    } else {
      outcome = answered;
    }
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
  // After a timeout the request may still be on its way, so the provider
  // saying it has not seen it is not yet evidence that nothing was sent —
  // the same rule `resumeAfterCrash` applies to a send nobody saw return.
  const reconciled = await tryReconcile(input.adapter, operation, input.businessId, !timedOut);
  if (reconciled) return reconciled;

  await markUncertain(operation.id, outcome.reason);
  return {
    status: 'UNCERTAIN',
    operation: (await getOperation(operation.id)) ?? operation,
    reason: outcome.reason,
  };
}

/**
 * Recover an attempt whose executor stopped, without sending anything.
 *
 * For a durable tick: the operation is RESERVED and its lease has run out.
 * It is taken over through the same compare-and-swap a retry would use, and
 * then only asked about — `resumeAfterCrash` reads the attempt rows and the
 * provider. If no attempt was ever sent, or the provider said definitively
 * that it did nothing, the operation is closed FAILED so that a later send
 * runs under a new key, which is the only way a new send can ever happen;
 * this function itself never calls `send`.
 *
 * Returns null when there is nothing to recover (not reserved, lease still
 * live, or another recoverer won the take-over).
 */
export async function recoverExternalEffect(input: {
  adapter: EffectAdapter;
  operation: IdempotencyOperation;
  businessId: string;
}): Promise<ExternalOutcome | null> {
  const { operation } = input;
  if (operation.state !== 'RESERVED' || !operation.recoverAfter) return null;
  if (operation.recoverAfter > operationNow()) return null;
  if (!(await takeOverOperation(operation.id, operation.recoverAfter))) return null;
  const resumed = await resumeAfterCrash(input.adapter, operation, input.businessId);
  if (resumed) return resumed;
  const attempt = await latestSentAttempt(operation.id);
  await failOperation(operation.id, {
    category: 'DEPENDENCY_UNAVAILABLE',
    terminal: true,
    detail: attempt
      ? 'the provider said it did nothing; a new attempt needs a new key'
      : 'the executor stopped before anything was sent; a new attempt needs a new key',
  });
  return { status: 'FAILED', operation: (await getOperation(operation.id)) ?? operation };
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
  absentMeansNothingSent = true,
): Promise<ExternalOutcome | null> {
  if (!adapter.reconcile) return null;

  let answer: ReconcileOutcome;
  try {
    answer = await boundedReconcile(adapter, businessId);
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

  if (answer.kind === 'ABSENT' && absentMeansNothingSent) {
    // The provider is authoritative and says it never saw it, so nothing
    // happened and this may be executed again. The attempt is closed as
    // FAILED first, so a later take-over reads the provider's answer from it
    // rather than an unknown (`resumeAfterCrash`).
    const absent = await latestSentAttempt(operation.id);
    if (absent) {
      await closeAttempt(absent.id, {
        phase: 'FAILED',
        outcome: 'FAILED',
        detail: 'the provider confirmed it never received this',
      });
    }
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
  businessId: string,
): Promise<ExternalOutcome> {
  // One more attempt to reconcile is safe — asking is not sending.
  const attempt = await latestSentAttempt(operation.id);
  if (adapter.reconcile && attempt) {
    const answer = await boundedReconcile(adapter, businessId).catch(() => null);
    if (answer && answer.kind === 'FOUND') {
      const safe = adapter.redactReceipt
        ? adapter.redactReceipt(answer.receiptMeta ?? {})
        : (answer.receiptMeta ?? {});
      await closeAttempt(attempt.id, {
        phase: 'CONFIRMED',
        outcome: 'SUCCEEDED',
        receiptRef: answer.receiptRef,
        receiptMeta: safe,
        detail: 'reconciled on a later attempt',
      });
      await resolveUncertain(operation.id, {
        as: 'SUCCEEDED',
        resultRef: answer.receiptRef,
        summary: 'reconciled with the provider on a later attempt',
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
  businessId: string,
): Promise<ExternalOutcome | null> {
  const attempt = await latestSentAttempt(operation.id);
  if (!attempt) return null; // nothing was ever sent; a fresh attempt is safe

  /*
   * A closed attempt on an operation still RESERVED is not "resolved": its
   * executor recorded what the provider said and then died, or failed to
   * write, before the operation itself moved. What the attempt says decides,
   * never the fact that it ended — reading `endedAt` alone sent a confirmed
   * effect a second time once the recovery lease made this path reachable.
   */
  if (attempt.endedAt !== null) {
    if (attempt.outcome === 'SUCCEEDED' && attempt.receiptRef) {
      // The provider's receipt is already on the attempt: finish the operation.
      await succeedOperation(operation.id, {
        resultRef: attempt.receiptRef,
        resultSummary: 'recorded from a confirmed attempt whose executor did not finish',
      });
      return {
        status: 'RECONCILED',
        operation: (await getOperation(operation.id)) ?? operation,
        receiptRef: attempt.receiptRef,
      };
    }
    // Only the provider saying it did nothing permits another send.
    if (attempt.outcome === 'FAILED') return null;
    // UNCERTAIN or ABANDONED: an unknown, handled exactly as an open attempt.
  }

  if (adapter.effectClass === 'EXTERNAL_IDEMPOTENT') {
    // Safe to send again: the provider de-duplicates on the same stable key,
    // which is exactly what native idempotency buys.
    return null;
  }

  // `absentMeansNothingSent` is false here on purpose, and it is the stated
  // rule rather than an oversight: on the first pass the send itself returned
  // and a provider's ABSENT is its answer about that send, but here an
  // executor died mid-send, so an ABSENT may be a provider that has not yet
  // made the request visible. Invariant 26: an unknown outcome is recorded as
  // unknown and never auto-retried. Only FOUND resolves this path; anything
  // else stays UNCERTAIN for a person.
  const reconciled = await tryReconcile(adapter, operation, businessId, false);
  if (reconciled) return reconciled;

  const reason = adapter.reconcile
    ? 'an earlier attempt sent this and did not record an outcome, and the provider could not confirm it'
    : 'an earlier attempt sent this and did not record an outcome, and the provider cannot be asked';
  await markUncertain(operation.id, reason);
  return {
    status: 'UNCERTAIN',
    operation: (await getOperation(operation.id)) ?? operation,
    reason,
  };
}
