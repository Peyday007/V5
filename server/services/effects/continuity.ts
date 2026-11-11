/**
 * What Brain actually knows about each external effect it has attempted
 * (CONT-35, §20, §25, invariants 25-26).
 *
 * Continuity after a partial failure starts with an honest account: what was
 * attempted, what the outside world may have accepted, what is confirmed, and
 * what remains unknown. This module reads that account from the rows the
 * effects engine already writes — `idempotency_operations` and
 * `effect_attempts`, through `server/repos/idempotency.ts` — and adds no
 * table, store or scheduler. It writes nothing: reconciling, resuming and
 * resolving stay with `external.ts`, which owns those transitions.
 *
 * The classes, and the one rule beneath all of them — a timeout, a thrown
 * send or a missing answer is never evidence that an effect did not happen
 * (invariant 26), so none of them can make an entry FAILED:
 *
 * - ATTEMPTED_NOT_SENT: reserved, and no attempt ever reached SENT. Nothing
 *   left Brain, so a retry cannot duplicate anything.
 * - MAY_HAVE_BEEN_ACCEPTED: an attempt reached SENT and no definite outcome
 *   was recorded, while the operation is still RESERVED (its executor is
 *   working on it, or died and its recovery deadline has passed). The
 *   provider may have accepted it; only reconciliation can say. Also any
 *   still-reserved operation whose sent attempts all ended without a definite
 *   refusal on record (a confirmed attempt never settled, or a FAILED one with
 *   no failure category): something left Brain, so it is never "not sent".
 * - CONFIRMED: SUCCEEDED, with the provider's receipt.
 * - UNKNOWN: UNCERTAIN, with the reason recorded when it became so. Waits for
 *   reconciliation or a person; nothing automatic resends it.
 * - FAILED_RECOVERABLE: a definite, retryable refusal — the provider said it
 *   did nothing (for instance DEPENDENCY_UNAVAILABLE). The operation stays
 *   RESERVED and an equivalent request may run it again.
 * - FAILED_EXTERNAL_CONSTRAINT: terminal. The refusal is final for this
 *   effect, and no retry under this key may bypass it.
 */
import { listAttempts, listOperations, operationNow } from '../../repos/idempotency.ts';
import type { EffectAttempt, EffectFailureCategory, IdempotencyOperation, OperationState } from '../../domain/types.ts';

export const CONTINUITY_CLASSES = [
  'ATTEMPTED_NOT_SENT',
  'MAY_HAVE_BEEN_ACCEPTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED_RECOVERABLE',
  'FAILED_EXTERNAL_CONSTRAINT',
] as const;
export type ContinuityClass = (typeof CONTINUITY_CLASSES)[number];

export interface ContinuityEntry {
  operationId: string;
  namespace: string;
  correlationId: string | null;
  state: OperationState;
  class: ContinuityClass;
  /** Why the entry is in its class, in words a person can act on. */
  reason: string;
  /** The provider's receipt, for a confirmed effect. */
  receiptRef: string | null;
  failureCategory: EffectFailureCategory | null;
  attempts: number;
  /** Attempts that reached SENT or later: something left Brain on each. */
  sentAttempts: number;
  /**
   * Whether an executor's lease on a still-reserved operation has run out —
   * `EXPIRED` means nobody is working on it and recovery may take it over.
   * Null once the operation has left RESERVED.
   */
  executorLease: 'LIVE' | 'EXPIRED' | null;
  /**
   * Whether sending again could not duplicate an effect. False whenever the
   * outside world may have accepted it and the outcome is not settled, and
   * for anything already settled.
   */
  retrySafe: boolean;
  /** The outside world must be asked (or a person must establish the outcome) before anything else is done. */
  needsReconciliation: boolean;
  updatedAt: string;
}

export interface ContinuityAccount {
  projectId: string;
  at: string;
  entries: ContinuityEntry[];
  totals: Record<ContinuityClass, number>;
  /** Entries whose outcome is not settled and whose effect may exist outside Brain. */
  unsettled: number;
  /** True when the read hit its bound, so older operations are not in this account. */
  truncated: boolean;
}

const READ_LIMIT = 500;

/** An attempt that left Brain (SENT or later) without a definite outcome. */
function sentWithoutOutcome(attempt: EffectAttempt): boolean {
  if (attempt.phase === 'INTENT') return false;
  return attempt.outcome === null || attempt.outcome === 'UNCERTAIN';
}

/**
 * Classify one operation from its own row and its attempt rows. Pure, so
 * the account is exactly a function of what was recorded.
 */
export function classifyOperation(
  operation: IdempotencyOperation,
  attempts: readonly EffectAttempt[],
  now: string = operationNow(),
): Omit<ContinuityEntry, 'operationId' | 'namespace' | 'correlationId' | 'state' | 'failureCategory' | 'updatedAt'> {
  const sent = attempts.filter((a) => a.phase !== 'INTENT');
  const latest = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  const counts = { attempts: attempts.length, sentAttempts: sent.length };
  const settled = { executorLease: null, retrySafe: false, needsReconciliation: false } as const;

  switch (operation.state) {
    case 'SUCCEEDED': {
      const receipt = operation.resultRef ?? [...sent].reverse().find((a) => a.receiptRef)?.receiptRef ?? null;
      return {
        ...counts,
        ...settled,
        class: 'CONFIRMED',
        receiptRef: receipt,
        reason: receipt ? `confirmed by the provider (receipt ${receipt})` : 'recorded as succeeded, and no receipt was recorded with it',
      };
    }
    case 'UNCERTAIN':
      return {
        ...counts,
        class: 'UNKNOWN',
        receiptRef: null,
        executorLease: null,
        retrySafe: false,
        needsReconciliation: true,
        reason: `outcome unknown: ${operation.uncertaintyReason ?? 'no reason was recorded'}; it may have taken effect, so it is reconciled or decided by a person, never resent`,
      };
    case 'FAILED':
      return {
        ...counts,
        ...settled,
        class: 'FAILED_EXTERNAL_CONSTRAINT',
        receiptRef: null,
        reason: `refused for good${operation.failureCategory ? ` (${operation.failureCategory})` : ''}${operation.resultSummary ? `: ${operation.resultSummary}` : ''}; no retry under this key may bypass it`,
      };
    case 'RESERVED': {
      const lease: 'LIVE' | 'EXPIRED' = operation.recoverAfter !== null && operation.recoverAfter > now ? 'LIVE' : 'EXPIRED';
      const pending = sent.filter(sentWithoutOutcome);
      if (pending.length > 0) {
        const last = pending[pending.length - 1]!;
        return {
          ...counts,
          class: 'MAY_HAVE_BEEN_ACCEPTED',
          receiptRef: null,
          executorLease: lease,
          retrySafe: false,
          needsReconciliation: true,
          reason:
            lease === 'LIVE'
              ? `attempt ${last.attemptNumber} was sent and has no answer yet; its executor still holds it`
              : `attempt ${last.attemptNumber} was sent and no outcome was recorded before its executor stopped; the provider may have accepted it`,
        };
      }
      // Every sent attempt ended definitively. A retryable refusal leaves the
      // operation reserved with its category, and the provider said it did nothing.
      if (operation.failureCategory !== null && latest?.outcome === 'FAILED') {
        return {
          ...counts,
          class: 'FAILED_RECOVERABLE',
          receiptRef: null,
          executorLease: lease,
          retrySafe: true,
          needsReconciliation: false,
          reason: `refused, retryably (${operation.failureCategory})${latest.detail ? `: ${latest.detail}` : ''}; the provider did nothing, so an equivalent request may run it again`,
        };
      }
      if (sent.length === 0) {
        return {
          ...counts,
          class: 'ATTEMPTED_NOT_SENT',
          receiptRef: null,
          executorLease: lease,
          retrySafe: true,
          needsReconciliation: false,
          reason: attempts.length === 0 ? 'reserved, and no attempt was started' : 'an attempt was started and nothing was sent',
        };
      }
      // Something left Brain, every sent attempt ended, and no definite refusal is on record:
      // either an attempt was confirmed and the operation was never settled, or it ended
      // FAILED without the category that says the provider did nothing. Neither is "not
      // sent"; the outside world may hold the effect, so it is reconciled, never resent.
      const confirmedAttempt = [...sent].reverse().find((a) => a.outcome === 'SUCCEEDED') ?? null;
      return {
        ...counts,
        class: 'MAY_HAVE_BEEN_ACCEPTED',
        receiptRef: confirmedAttempt?.receiptRef ?? null,
        executorLease: lease,
        retrySafe: false,
        needsReconciliation: true,
        reason: confirmedAttempt
          ? `attempt ${confirmedAttempt.attemptNumber} was confirmed${confirmedAttempt.receiptRef ? ` (receipt ${confirmedAttempt.receiptRef})` : ''} but the operation was never settled; it is reconciled, never resent`
          : `${sent.length} attempt(s) were sent and ended without a definite refusal on record; the provider may have accepted one, so it is reconciled, never resent`,
      };
    }
  }
}

/**
 * The continuity account of one project's external effects: every operation
 * in its class, the totals, and how many are unsettled. Read-only.
 */
export async function effectContinuityAccount(projectId: string): Promise<ContinuityAccount> {
  const now = operationNow();
  const operations = await listOperations(projectId, { limit: READ_LIMIT });
  const entries: ContinuityEntry[] = [];
  for (const operation of operations) {
    const attempts = await listAttempts(operation.id);
    entries.push({
      operationId: operation.id,
      namespace: operation.namespace,
      correlationId: operation.correlationId,
      state: operation.state,
      failureCategory: operation.failureCategory,
      updatedAt: operation.updatedAt,
      ...classifyOperation(operation, attempts, now),
    });
  }
  const totals = Object.fromEntries(CONTINUITY_CLASSES.map((c) => [c, 0])) as Record<ContinuityClass, number>;
  for (const entry of entries) totals[entry.class] += 1;
  return {
    projectId,
    at: now,
    entries,
    totals,
    unsettled: totals.MAY_HAVE_BEEN_ACCEPTED + totals.UNKNOWN,
    truncated: operations.length >= READ_LIMIT,
  };
}
