/**
 * Operation records: reservation, replay, conflict, and attempt history.
 *
 * One idea, again in one constraint:
 *
 *     UNIQUE (scope_hash, key_fingerprint)
 *
 * Reserving is `INSERT ... ON CONFLICT DO NOTHING`. Exactly one caller inserts
 * a row. Everyone else — a double click, a retried request, a second Brain
 * instance, a redelivered queue item — changes zero rows, reads the row they
 * collided with, and finds out what to do instead of doing it again.
 *
 * That is why this works across instances: the arbiter is the database, not a
 * mutex in one process. A process-local lock would be correct on one machine
 * and quietly wrong the moment there were two, which is precisely the class of
 * bug Step 5 spent its whole length avoiding.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { SqlParam } from '../db/types.ts';
import type {
  ActorType,
  EffectAttempt,
  EffectAttemptRow,
  EffectFailureCategory,
  EffectOutcome,
  EffectPhase,
  IdempotencyOperation,
  IdempotencyOperationRow,
  OperationState,
  RetentionClass,
} from '../domain/types.ts';

export function operationNow(): string {
  return nowIso();
}

const MAX_SUMMARY_CHARS = 2000;
const MAX_DETAIL_CHARS = 2000;
const MAX_RESULT_REF_CHARS = 512;

function bounded(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/* ------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* ------------------------------------------------------------------------- */

export function mapOperation(row: IdempotencyOperationRow): IdempotencyOperation {
  return {
    id: row.id,
    scopeHash: row.scope_hash,
    keyFingerprint: row.key_fingerprint,
    namespace: row.namespace,
    namespaceVersion: row.namespace_version,
    projectId: row.project_id,
    createdByType: row.created_by_type as ActorType,
    createdById: row.created_by_id,
    correlationId: row.correlation_id,
    workItemId: row.work_item_id,
    leaseGeneration: row.lease_generation,
    requestFingerprint: row.request_fingerprint,
    fingerprintVersion: row.fingerprint_version,
    state: row.state as OperationState,
    attemptCount: row.attempt_count,
    failureCategory: row.failure_category as EffectFailureCategory | null,
    uncertaintyReason: row.uncertainty_reason,
    recoverAfter: row.recover_after,
    resultRef: row.result_ref,
    resultStatus: row.result_status,
    resultSummary: row.result_summary,
    retentionClass: row.retention_class as RetentionClass,
    reservedAt: row.reserved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAttempt(row: EffectAttemptRow): EffectAttempt {
  return {
    id: row.id,
    operationId: row.operation_id,
    attemptNumber: row.attempt_number,
    executorType: row.executor_type as ActorType,
    executorId: row.executor_id,
    workItemId: row.work_item_id,
    leaseId: row.lease_id,
    leaseGeneration: row.lease_generation,
    adapter: row.adapter,
    providerKey: row.provider_key,
    phase: row.phase as EffectPhase,
    receiptRef: row.receipt_ref,
    receiptMeta: parseJson<Record<string, unknown>>(row.receipt_meta, {}),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome as EffectOutcome | null,
    detail: row.detail,
    requestId: row.request_id,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

export async function getOperation(id: string): Promise<IdempotencyOperation | null> {
  const row = await getDb().get<IdempotencyOperationRow>(
    'SELECT * FROM idempotency_operations WHERE id = ?',
    [id],
  );
  return row ? mapOperation(row) : null;
}

export async function findOperation(
  scopeHash: string,
  keyFingerprint: string,
): Promise<IdempotencyOperation | null> {
  const row = await getDb().get<IdempotencyOperationRow>(
    'SELECT * FROM idempotency_operations WHERE scope_hash = ? AND key_fingerprint = ?',
    [scopeHash, keyFingerprint],
  );
  return row ? mapOperation(row) : null;
}

export async function listAttempts(operationId: string): Promise<EffectAttempt[]> {
  const rows = await getDb().all<EffectAttemptRow>(
    'SELECT * FROM effect_attempts WHERE operation_id = ? ORDER BY attempt_number',
    [operationId],
  );
  return rows.map(mapAttempt);
}

export async function listOperations(
  projectId: string,
  options: { states?: OperationState[]; limit?: number } = {},
): Promise<IdempotencyOperation[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const states = options.states ?? [];
  const where = states.length
    ? `project_id = ? AND state IN (${states.map(() => '?').join(', ')})`
    : 'project_id = ?';
  const rows = await getDb().all<IdempotencyOperationRow>(
    `SELECT * FROM idempotency_operations WHERE ${where}
      ORDER BY created_at DESC, id LIMIT ${limit}`,
    [projectId, ...states],
  );
  return rows.map(mapOperation);
}

/* ------------------------------------------------------------------------- */
/* Reserving                                                                  */
/* ------------------------------------------------------------------------- */

export interface ReserveInput {
  scopeHash: string;
  keyFingerprint: string;
  namespace: string;
  namespaceVersion: number;
  projectId: string;
  requestFingerprint: string;
  fingerprintVersion: number;
  createdByType: ActorType;
  createdById?: string | null;
  correlationId?: string | null;
  workItemId?: string | null;
  leaseGeneration?: number | null;
  retentionClass?: RetentionClass;
}

/**
 * What a caller found when it tried to reserve.
 *
 * `RECOVERABLE` is the one that needs explaining: an operation left `RESERVED`
 * by an executor that died. It is not in progress — nobody is working on it —
 * and it is not finished. The caller may take it over, and the engine decides
 * whether that is safe for this effect class.
 */
export type ReserveOutcome =
  | { outcome: 'RESERVED'; operation: IdempotencyOperation }
  | { outcome: 'REPLAY'; operation: IdempotencyOperation }
  | { outcome: 'CONFLICT'; operation: IdempotencyOperation }
  | { outcome: 'IN_PROGRESS'; operation: IdempotencyOperation }
  | { outcome: 'RECOVERABLE'; operation: IdempotencyOperation }
  | { outcome: 'TERMINAL_FAILURE'; operation: IdempotencyOperation }
  | { outcome: 'UNCERTAIN'; operation: IdempotencyOperation };

/**
 * Reserve, or find out who already did.
 *
 * The retry loop covers one narrow race: retention cleanup deleting the row
 * between our failed insert and our read of it. Bounded at three, because a
 * fourth would mean something is wrong that a fourth attempt will not fix.
 */
export async function reserveOperation(input: ReserveInput): Promise<ReserveOutcome> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await tryReserve(input);
    if (outcome) return outcome;
  }
  throw new Error(
    'Could not reserve an operation: the record kept disappearing between writing and reading it.',
  );
}

/** One pass. `null` means the row vanished under us and it is worth retrying. */
async function tryReserve(input: ReserveInput): Promise<ReserveOutcome | null> {
  const db = getDb();
  const at = operationNow();
  const id = newId('idop');

  // ON CONFLICT DO NOTHING rather than a SELECT first. A read-then-insert has a
  // window; this does not. Both backends support it — `grantMembership` has
  // relied on ON CONFLICT since Step 4.
  const inserted = await db.run(
    `INSERT INTO idempotency_operations (id, scope_hash, key_fingerprint, namespace,
       namespace_version, project_id, created_by_type, created_by_id, correlation_id,
       work_item_id, lease_generation, request_fingerprint, fingerprint_version,
       state, attempt_count, failure_category, uncertainty_reason, recover_after,
       result_ref, result_status, result_summary, retention_class,
       reserved_at, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'RESERVED', 0, NULL, NULL, NULL,
             NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (scope_hash, key_fingerprint) DO NOTHING`,
    [
      id,
      input.scopeHash,
      input.keyFingerprint,
      input.namespace,
      input.namespaceVersion,
      input.projectId,
      input.createdByType,
      input.createdById ?? null,
      input.correlationId ?? null,
      input.workItemId ?? null,
      input.leaseGeneration ?? null,
      input.requestFingerprint,
      input.fingerprintVersion,
      input.retentionClass ?? 'STANDARD',
      at,
      at,
      at,
    ] as SqlParam[],
  );

  if (inserted.changes === 1) {
    const created = await getOperation(id);
    if (!created) throw new Error('The operation row disappeared immediately after being written.');
    return { outcome: 'RESERVED', operation: created };
  }

  // Somebody else has this key. What happens next depends entirely on whether
  // they were doing the same thing.
  const existing = await findOperation(input.scopeHash, input.keyFingerprint);
  // Deleted between the failed insert and this read — retention cleanup racing
  // a request. Say so honestly by asking the caller to try again, rather than
  // inventing an operation record to return.
  if (!existing) return null;

  // The check that makes a key mean something. Same key, different input, is
  // not a retry — it is a mistake, and executing it would be worse.
  if (existing.requestFingerprint !== input.requestFingerprint) {
    return { outcome: 'CONFLICT', operation: existing };
  }

  switch (existing.state) {
    case 'SUCCEEDED':
      return { outcome: 'REPLAY', operation: existing };
    case 'FAILED':
      return { outcome: 'TERMINAL_FAILURE', operation: existing };
    case 'UNCERTAIN':
      return { outcome: 'UNCERTAIN', operation: existing };
    default: {
      const recoverable =
        existing.recoverAfter !== null && existing.recoverAfter <= operationNow();
      return { outcome: recoverable ? 'RECOVERABLE' : 'IN_PROGRESS', operation: existing };
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Transitions                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Take over an operation whose executor died.
 *
 * A compare-and-swap on `recover_after`, so two recoverers cannot both believe
 * they have it — the same shape as the queue's claim, for the same reason.
 */
export async function takeOverOperation(
  operationId: string,
  recoverAfter: string,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE idempotency_operations SET recover_after = NULL, updated_at = ?
      WHERE id = ? AND state = 'RESERVED' AND recover_after = ?`,
    [operationNow(), operationId, recoverAfter],
  );
  return result.changes === 1;
}

/** Mark an execution as started, and count the attempt. */
export async function beginAttemptOn(operationId: string): Promise<number> {
  const at = operationNow();
  await getDb().run(
    `UPDATE idempotency_operations
        SET attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
      WHERE id = ? AND state = 'RESERVED'`,
    [at, at, operationId],
  );
  const row = await getDb().get<{ attempt_count: number }>(
    'SELECT attempt_count FROM idempotency_operations WHERE id = ?',
    [operationId],
  );
  return Number(row?.attempt_count ?? 1);
}

export interface SucceedInput {
  resultRef?: string | null;
  resultStatus?: number | null;
  resultSummary?: string | null;
}

/**
 * Commit terminal success.
 *
 * Guarded on `state = 'RESERVED'`, so a success can be recorded exactly once
 * and a stale executor returning later matches nothing. Called inside the same
 * transaction as the domain mutation for a same-database effect, which is what
 * makes "either both or neither" true rather than aspirational.
 */
export async function succeedOperation(
  operationId: string,
  result: SucceedInput = {},
): Promise<boolean> {
  const at = operationNow();
  const updated = await getDb().run(
    `UPDATE idempotency_operations
        SET state = 'SUCCEEDED', result_ref = ?, result_status = ?, result_summary = ?,
            recover_after = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'RESERVED'`,
    [
      bounded(result.resultRef, MAX_RESULT_REF_CHARS),
      result.resultStatus ?? null,
      bounded(result.resultSummary, MAX_SUMMARY_CHARS),
      at,
      at,
      operationId,
    ],
  );
  return updated.changes === 1;
}

/**
 * Record a failure.
 *
 * `terminal: false` leaves the operation `RESERVED` and immediately
 * recoverable, so an equivalent request may execute it again — that is a
 * retryable internal failure, and the reservation is what stops two retries
 * racing. `terminal: true` closes it for good.
 */
export async function failOperation(
  operationId: string,
  input: { category: EffectFailureCategory; terminal: boolean; detail?: string | null },
): Promise<boolean> {
  const at = operationNow();
  const updated = input.terminal
    ? await getDb().run(
        `UPDATE idempotency_operations
            SET state = 'FAILED', failure_category = ?, result_summary = ?,
                recover_after = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'RESERVED'`,
        [input.category, bounded(input.detail, MAX_SUMMARY_CHARS), at, at, operationId],
      )
    : await getDb().run(
        `UPDATE idempotency_operations
            SET failure_category = ?, recover_after = ?, updated_at = ?
          WHERE id = ? AND state = 'RESERVED'`,
        [input.category, at, at, operationId],
      );
  return updated.changes === 1;
}

/**
 * The state that exists because honesty requires it.
 *
 * An external effect was sent and the outcome is unknown. Not "it failed" — a
 * timeout is not evidence that nothing happened, and treating it as one is how
 * a payment gets made twice. The operation stops here and waits for a person or
 * a reconciliation, and nothing automatic resends it.
 */
export async function markUncertain(
  operationId: string,
  reason: string,
): Promise<boolean> {
  const at = operationNow();
  const updated = await getDb().run(
    `UPDATE idempotency_operations
        SET state = 'UNCERTAIN', uncertainty_reason = ?, recover_after = NULL,
            completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'RESERVED'`,
    [bounded(reason, MAX_SUMMARY_CHARS) ?? 'unknown', at, at, operationId],
  );
  return updated.changes === 1;
}

/**
 * Resolve an uncertain operation, once somebody has established what happened.
 *
 * Deliberately the only way out of `UNCERTAIN`, and deliberately not automatic.
 */
export async function resolveUncertain(
  operationId: string,
  resolution:
    | { as: 'SUCCEEDED'; resultRef?: string | null; summary?: string | null }
    | { as: 'FAILED'; category: EffectFailureCategory; detail?: string | null },
): Promise<boolean> {
  const at = operationNow();
  const updated =
    resolution.as === 'SUCCEEDED'
      ? await getDb().run(
          `UPDATE idempotency_operations
              SET state = 'SUCCEEDED', result_ref = ?, result_summary = ?,
                  uncertainty_reason = NULL, completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'UNCERTAIN'`,
          [
            bounded(resolution.resultRef, MAX_RESULT_REF_CHARS),
            bounded(resolution.summary, MAX_SUMMARY_CHARS),
            at,
            at,
            operationId,
          ],
        )
      : await getDb().run(
          `UPDATE idempotency_operations
              SET state = 'FAILED', failure_category = ?, result_summary = ?,
                  uncertainty_reason = NULL, completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'UNCERTAIN'`,
          [
            resolution.category,
            bounded(resolution.detail, MAX_SUMMARY_CHARS),
            at,
            at,
            operationId,
          ],
        );
  return updated.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Attempts                                                                   */
/* ------------------------------------------------------------------------- */

export interface OpenAttemptInput {
  operationId: string;
  attemptNumber: number;
  executorType: ActorType;
  executorId?: string | null;
  workItemId?: string | null;
  leaseId?: string | null;
  leaseGeneration?: number | null;
  adapter?: string | null;
  providerKey?: string | null;
  requestId?: string | null;
}

/**
 * Persist intent before anything is sent.
 *
 * This row existing is the difference between "we may have sent something" and
 * "we have no idea". Written first, always, even for effects that are about to
 * fail immediately.
 */
export async function openAttempt(input: OpenAttemptInput): Promise<EffectAttempt> {
  const id = newId('efa');
  const at = operationNow();
  await getDb().run(
    `INSERT INTO effect_attempts (id, operation_id, attempt_number, executor_type, executor_id,
       work_item_id, lease_id, lease_generation, adapter, provider_key, phase,
       receipt_ref, receipt_meta, started_at, ended_at, outcome, detail, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT', NULL, '{}', ?, NULL, NULL, NULL, ?)`,
    [
      id,
      input.operationId,
      input.attemptNumber,
      input.executorType,
      input.executorId ?? null,
      input.workItemId ?? null,
      input.leaseId ?? null,
      input.leaseGeneration ?? null,
      input.adapter ?? null,
      input.providerKey ?? null,
      at,
      input.requestId ?? null,
    ],
  );
  const row = await getDb().get<EffectAttemptRow>('SELECT * FROM effect_attempts WHERE id = ?', [id]);
  if (!row) throw new Error('The attempt row disappeared immediately after being written.');
  return mapAttempt(row);
}

/** Move an attempt to SENT: something has left the building. */
export async function markAttemptSent(attemptId: string): Promise<void> {
  await getDb().run(`UPDATE effect_attempts SET phase = 'SENT' WHERE id = ?`, [attemptId]);
}

export async function closeAttempt(
  attemptId: string,
  input: {
    phase: EffectPhase;
    outcome: EffectOutcome;
    receiptRef?: string | null;
    receiptMeta?: Record<string, unknown>;
    detail?: string | null;
  },
): Promise<void> {
  await getDb().run(
    `UPDATE effect_attempts
        SET phase = ?, outcome = ?, receipt_ref = ?, receipt_meta = ?, detail = ?, ended_at = ?
      WHERE id = ?`,
    [
      input.phase,
      input.outcome,
      bounded(input.receiptRef, MAX_RESULT_REF_CHARS),
      toJson(input.receiptMeta ?? {}),
      bounded(input.detail, MAX_DETAIL_CHARS),
      operationNow(),
      attemptId,
    ],
  );
}

/** The last attempt that reached a provider, for reconciliation. */
export async function latestSentAttempt(operationId: string): Promise<EffectAttempt | null> {
  const row = await getDb().get<EffectAttemptRow>(
    `SELECT * FROM effect_attempts
      WHERE operation_id = ? AND provider_key IS NOT NULL
      ORDER BY attempt_number DESC LIMIT 1`,
    [operationId],
  );
  return row ? mapAttempt(row) : null;
}
