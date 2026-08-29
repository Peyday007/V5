/**
 * The distributed work queue.
 *
 * Everything in this file exists to answer one question safely: **who owns this
 * work item right now?** The answer is never what a caller says it is. It comes
 * from a row, inside the same statement that changes it.
 *
 * ---------------------------------------------------------------------------
 * The one idea
 * ---------------------------------------------------------------------------
 *
 * A claim is a compare-and-swap on `lease_generation`.
 *
 *   1. Read some candidates and their current generation.
 *   2. `UPDATE ... WHERE id = ? AND lease_generation = ?`
 *   3. `changes === 1` means you won. `0` means somebody else did.
 *
 * Two workers can both read generation 7 and both attempt the swap. Exactly one
 * matches, because the winner's update made it 8 before the loser's statement
 * ran. The loser is not an error and is not retried against the same row; it
 * moves to the next candidate.
 *
 * This works identically on SQLite and Postgres because both drivers report
 * `changes` the same way, which is the entire reason the queue does not need
 * `SELECT ... FOR UPDATE` to be correct. Postgres additionally gets
 * `FOR UPDATE SKIP LOCKED` on the *candidate select* — that reduces the number
 * of losers under contention, and if it were deleted tomorrow the queue would
 * be slower and still correct.
 *
 * ---------------------------------------------------------------------------
 * Fencing
 * ---------------------------------------------------------------------------
 *
 * The generation is also the fencing token. Every later operation by the owner
 * — heartbeat, complete, fail, release — presents the lease id and the
 * generation it was given, and every one of them is a single guarded `UPDATE`
 * whose `WHERE` carries the whole proof: the item, the lease id, the
 * generation, the worker id taken from the *authenticated principal*, the
 * `LEASED` state, and an expiry still in the future.
 *
 * There is no read-then-write window for a race to live in. A worker whose
 * lease expired while it was busy comes back holding generation 7 against a row
 * now on 8, and matches nothing. It cannot resurrect the item, cannot overwrite
 * the new owner's result, and cannot report success for work somebody else is
 * already redoing.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 *
 * Not exactly-once execution. A lease can expire after a worker performed an
 * effect and before it recorded completion, so the item is redelivered and the
 * effect happens twice. Fencing protects the *queue state*; protecting the
 * *effect* is Step 6. Until Step 6 exists, the only work this queue may carry
 * is work that is safe to perform more than once.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  ActorType,
  ClaimedWork,
  LeaseOutcome,
  LeaseRejection,
  WorkFailureCategory,
  WorkItem,
  WorkItemCheckpoint,
  WorkItemCheckpointRow,
  WorkItemRow,
  WorkItemState,
  WorkLease,
  WorkLeaseRow,
  WorkerScope,
} from '../domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Time                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The one clock, so there is one place to read when arguing about it.
 *
 * Lease decisions use the Brain's own clock and never a worker-supplied time —
 * that is the property that matters, and it is absolute. What it is *not* is
 * the database's clock: timestamps in this project are ISO-8601 text in both
 * backends by deliberate design (see docs/CLOUD.md), and reaching for `now()`
 * or `CURRENT_TIMESTAMP` would add a fifth difference between the two schemas
 * for a benefit measured in milliseconds.
 *
 * The assumption is therefore that Brain instances agree on the time to within
 * far less than a lease duration. Fly machines run NTP; the exposure is bounded
 * by `leaseMs`; and if it is ever wrong the failure is a lease reclaimed early
 * or late, not a lease with two owners — because ownership is decided by the
 * generation swap, not by the clock.
 */
export function queueNow(): string {
  return nowIso();
}

function plusMs(from: string, ms: number): string {
  return new Date(new Date(from).getTime() + ms).toISOString();
}

/* ------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* ------------------------------------------------------------------------- */

/** A queue is a dispatcher. Nothing here should ever be large. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_DETAIL_CHARS = 2000;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_RESULT_REF_CHARS = 512;
export const MAX_CLAIM_BATCH = 25;

/** Bounded so a caller cannot ask for a lease that never expires. */
export const MIN_LEASE_MS = 5_000;
export const MAX_LEASE_MS = 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export function clampLeaseMs(ms: number | undefined): number {
  if (!Number.isFinite(ms ?? NaN)) return DEFAULT_LEASE_MS;
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(ms as number)));
}

/** Bounded exponential backoff, so a poisonous item cannot spin the fleet. */
export function retryDelayMs(attemptCount: number): number {
  const base = 2_000;
  const capped = Math.min(attemptCount, 10);
  return Math.min(5 * 60_000, base * 2 ** Math.max(0, capped - 1));
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/* ------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* ------------------------------------------------------------------------- */

export function mapWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    projectId: row.project_id,
    workType: row.work_type,
    state: row.state as WorkItemState,
    priority: row.priority,
    availableAt: row.available_at,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    requiredScopes: parseJson<WorkerScope[]>(row.required_scopes, []),
    targetWorkerId: row.target_worker_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseGeneration: row.lease_generation,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    leaseCredentialId: row.lease_credential_id,
    leasedAt: row.leased_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    resultRef: row.result_ref,
    resultSummary: row.result_summary,
    failureCategory: row.failure_category as WorkFailureCategory | null,
    cancelledReason: row.cancelled_reason,
    correlationId: row.correlation_id,
    orchestrationId: row.orchestration_id,
    fragmentId: row.fragment_id,
    createdByType: row.created_by_type as ActorType,
    createdById: row.created_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function mapWorkLease(row: WorkLeaseRow): WorkLease {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    projectId: row.project_id,
    attemptNumber: row.attempt_number,
    leaseGeneration: row.lease_generation,
    workerId: row.worker_id,
    credentialId: row.credential_id,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    heartbeatCount: row.heartbeat_count,
    endedAt: row.ended_at,
    outcome: row.outcome as LeaseOutcome | null,
    detail: row.detail,
    requestId: row.request_id,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  const row = await getDb().get<WorkItemRow>('SELECT * FROM work_items WHERE id = ?', [id]);
  return row ? mapWorkItem(row) : null;
}

export async function listWorkItems(
  projectId: string,
  options: { states?: WorkItemState[]; limit?: number } = {},
): Promise<WorkItem[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const states = options.states ?? [];
  const where = states.length
    ? `project_id = ? AND state IN (${states.map(() => '?').join(', ')})`
    : 'project_id = ?';
  const rows = await getDb().all<WorkItemRow>(
    `SELECT * FROM work_items WHERE ${where}
      ORDER BY priority DESC, available_at, created_at, id LIMIT ${limit}`,
    [projectId, ...states],
  );
  return rows.map(mapWorkItem);
}

/** The attempt history for one item, oldest first. */
export async function listLeases(workItemId: string): Promise<WorkLease[]> {
  const rows = await getDb().all<WorkLeaseRow>(
    'SELECT * FROM work_leases WHERE work_item_id = ? ORDER BY lease_generation',
    [workItemId],
  );
  return rows.map(mapWorkLease);
}

/* ------------------------------------------------------------------------- */
/* Enqueue                                                                    */
/* ------------------------------------------------------------------------- */

export interface EnqueueInput {
  projectId: string;
  workType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  requiredScopes?: WorkerScope[];
  targetWorkerId?: string | null;
  maxAttempts?: number;
  availableAt?: string;
  correlationId?: string | null;
  /**
   * The research assignment this item belongs to. A pointer, never a copy of
   * the assignment: what the worker must research is read from the fragment
   * row through a scoped tool, not from the payload.
   */
  orchestrationId?: string | null;
  fragmentId?: string | null;
  createdByType: ActorType;
  createdById?: string | null;
}

export class PayloadTooLarge extends Error {
  constructor(bytes: number) {
    super(`A work payload may be at most ${MAX_PAYLOAD_BYTES} bytes; this one is ${bytes}.`);
    this.name = 'PayloadTooLarge';
  }
}

export async function enqueueWork(input: EnqueueInput): Promise<WorkItem> {
  const payload = toJson(input.payload ?? {});
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) throw new PayloadTooLarge(bytes);

  const id = newId('wki');
  const at = queueNow();
  await getDb().run(
    `INSERT INTO work_items (id, project_id, work_type, state, priority, available_at, payload,
       required_scopes, target_worker_id, attempt_count, max_attempts, lease_generation,
       lease_id, worker_id, lease_credential_id, leased_at, heartbeat_at, lease_expires_at,
       result_ref, result_summary, failure_category, cancelled_reason, correlation_id,
       orchestration_id, fragment_id,
       created_by_type, created_by_id, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, 0, ?, 0,
             NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, ?,
             ?, ?,
             ?, ?, ?, ?, NULL)`,
    [
      id,
      input.projectId,
      input.workType,
      Math.min(9, Math.max(0, input.priority ?? 5)),
      input.availableAt ?? at,
      payload,
      toJson(input.requiredScopes ?? []),
      input.targetWorkerId ?? null,
      Math.max(1, input.maxAttempts ?? 3),
      input.correlationId ?? null,
      input.orchestrationId ?? null,
      input.fragmentId ?? null,
      input.createdByType,
      input.createdById ?? null,
      at,
      at,
    ],
  );
  const created = await getWorkItem(id);
  if (!created) throw new Error('The work item disappeared immediately after being written.');
  return created;
}

/* ------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* ------------------------------------------------------------------------- */

/** One project this worker may take work from, and what it holds there. */
export interface ClaimScope {
  projectId: string;
  scopes: WorkerScope[];
}

export interface ClaimInput {
  workerId: string;
  credentialId?: string | null;
  /** Live membership, read this request. Never anything the caller sent. */
  scopes: ClaimScope[];
  workTypes?: string[];
  limit?: number;
  leaseMs?: number;
  requestId?: string | null;
}

function eligibleFor(item: WorkItemRow, held: Set<string>): boolean {
  const required = parseJson<string[]>(item.required_scopes, []);
  return required.every((scope) => held.has(scope));
}

/**
 * Take up to `limit` items, atomically.
 *
 * Returns an empty array when there is nothing to do. That is a normal answer
 * and not an error: an idle fleet asks this constantly.
 */
export async function claimWork(input: ClaimInput): Promise<ClaimedWork[]> {
  const db = getDb();
  const limit = Math.min(MAX_CLAIM_BATCH, Math.max(1, input.limit ?? 1));
  const leaseMs = clampLeaseMs(input.leaseMs);
  const projectIds = input.scopes.map((scope) => scope.projectId);
  if (projectIds.length === 0) return [];

  const heldByProject = new Map<string, Set<string>>();
  for (const scope of input.scopes) heldByProject.set(scope.projectId, new Set(scope.scopes));

  const claimed: ClaimedWork[] = [];
  // Look at more rows than are needed, because some will be lost to other
  // workers and some will be filtered out by scope. Bounded, so a worker
  // cannot ask the database to sort the world.
  const candidateLimit = Math.min(200, limit * 8);

  for (let round = 0; round < 3 && claimed.length < limit; round += 1) {
    const now = queueNow();
    const params: SqlParam[] = [now, now, ...projectIds];
    let typeClause = '';
    if (input.workTypes && input.workTypes.length > 0) {
      typeClause = ` AND work_type IN (${input.workTypes.map(() => '?').join(', ')})`;
      params.push(...input.workTypes);
    }
    params.push(input.workerId);

    // An expired lease is claimable work. That is what makes recovery
    // independent of any process staying alive: the next worker to ask picks it
    // up, whether or not a sweeper ever ran.
    //
    // Deliberately *not* `FOR UPDATE SKIP LOCKED`. Outside a transaction those
    // row locks are released the moment the statement ends, so they would skip
    // nothing and mean nothing; inside one, they would buy contention avoidance
    // at the price of holding locks across the whole batch. The compare-and-swap
    // below is what makes the claim correct either way, and one code path that
    // is provable on both backends is worth more here than a second one that is
    // faster under a contention level this fleet does not yet have.
    const candidates = await db.all<WorkItemRow>(
      `SELECT * FROM work_items
        WHERE ( (state = 'QUEUED' AND available_at <= ?)
             OR (state = 'LEASED' AND lease_expires_at <= ?) )
          AND project_id IN (${projectIds.map(() => '?').join(', ')})${typeClause}
          AND (target_worker_id IS NULL OR target_worker_id = ?)
        ORDER BY priority DESC, available_at, created_at, id
        LIMIT ${candidateLimit}`,
      params,
    );
    if (candidates.length === 0) break;

    let wonThisRound = 0;
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const held = heldByProject.get(candidate.project_id);
      if (!held || !eligibleFor(candidate, held)) continue;

      const swapAt = queueNow();
      const leaseId = newId('wls');
      const expiresAt = plusMs(swapAt, leaseMs);

      // The compare-and-swap. Everything that must happen exactly once happens
      // in this one statement: ownership, the attempt count, and the fencing
      // generation.
      const result = await db.run(
        `UPDATE work_items
            SET state = 'LEASED',
                worker_id = ?,
                lease_id = ?,
                lease_credential_id = ?,
                lease_generation = lease_generation + 1,
                attempt_count = attempt_count + 1,
                leased_at = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND lease_generation = ?
            AND available_at <= ?
            AND ( state = 'QUEUED'
               OR (state = 'LEASED' AND lease_expires_at <= ?) )`,
        [
          input.workerId,
          leaseId,
          input.credentialId ?? null,
          swapAt,
          swapAt,
          expiresAt,
          swapAt,
          candidate.id,
          candidate.lease_generation,
          swapAt,
          swapAt,
        ],
      );
      if (result.changes !== 1) continue; // somebody else won it; not an error

      const generation = candidate.lease_generation + 1;
      const attemptNumber = candidate.attempt_count + 1;

      // The previous lease, if there was one, ended because it ran out. Record
      // that before opening the new one, so the history reads in order.
      if (candidate.state === 'LEASED' && candidate.lease_id) {
        await db.run(
          `UPDATE work_leases
              SET ended_at = ?, outcome = 'EXPIRED',
                  detail = COALESCE(detail, 'The lease expired and the item was reclaimed.')
            WHERE work_item_id = ? AND lease_generation = ? AND ended_at IS NULL`,
          [swapAt, candidate.id, candidate.lease_generation],
        );
      }

      await db.run(
        `INSERT INTO work_leases (id, work_item_id, project_id, attempt_number, lease_generation,
           worker_id, credential_id, claimed_at, expires_at, last_heartbeat_at, heartbeat_count,
           ended_at, outcome, detail, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, ?)`,
        [
          leaseId,
          candidate.id,
          candidate.project_id,
          attemptNumber,
          generation,
          input.workerId,
          input.credentialId ?? null,
          swapAt,
          expiresAt,
          input.requestId ?? null,
        ],
      );

      claimed.push({
        workItemId: candidate.id,
        projectId: candidate.project_id,
        workType: candidate.work_type,
        payload: parseJson<Record<string, unknown>>(candidate.payload, {}),
        priority: candidate.priority,
        attemptNumber,
        maxAttempts: candidate.max_attempts,
        leaseId,
        leaseGeneration: generation,
        leaseExpiresAt: expiresAt,
        correlationId: candidate.correlation_id,
      });
      wonThisRound += 1;
    }
    // Every candidate was taken by somebody else or filtered out. Another round
    // over the same rows would produce the same answer.
    if (wonThisRound === 0) break;
  }

  return claimed;
}

/* ------------------------------------------------------------------------- */
/* Proving ownership                                                          */
/* ------------------------------------------------------------------------- */

export interface OwnershipProof {
  workItemId: string;
  workerId: string;
  leaseId: string;
  leaseGeneration: number;
}

export type LeaseResult =
  | { ok: true; item: WorkItem }
  | { ok: false; rejection: LeaseRejection };

/**
 * Why the guarded update matched nothing.
 *
 * Only ever called *after* an operation already failed, and only for a caller
 * the route layer has already authorized for this project — so reading the row
 * here reveals nothing that caller could not already see.
 */
async function classifyRejection(proof: OwnershipProof): Promise<LeaseRejection> {
  const row = await getDb().get<WorkItemRow>('SELECT * FROM work_items WHERE id = ?', [
    proof.workItemId,
  ]);
  if (!row) return 'NOT_FOUND';
  if (row.state === 'CANCELLED') return 'CANCELLED';
  if (row.state === 'SUCCEEDED' || row.state === 'FAILED') return 'ALREADY_TERMINAL';
  if (row.state !== 'LEASED') return 'NOT_LEASED';
  if (row.lease_generation !== proof.leaseGeneration) return 'STALE_GENERATION';
  if (row.worker_id !== proof.workerId || row.lease_id !== proof.leaseId) return 'NOT_THE_OWNER';
  if (row.lease_expires_at && row.lease_expires_at <= queueNow()) return 'LEASE_EXPIRED';
  return 'NOT_THE_OWNER';
}

/** The `WHERE` every ownership-sensitive operation shares. */
const OWNED = `id = ? AND state = 'LEASED' AND worker_id = ? AND lease_id = ?
   AND lease_generation = ? AND lease_expires_at > ?`;

function ownedParams(proof: OwnershipProof, now: string): SqlParam[] {
  return [proof.workItemId, proof.workerId, proof.leaseId, proof.leaseGeneration, now];
}

async function settle(proof: OwnershipProof, changes: number): Promise<LeaseResult> {
  if (changes !== 1) return { ok: false, rejection: await classifyRejection(proof) };
  const item = await getWorkItem(proof.workItemId);
  if (!item) return { ok: false, rejection: 'NOT_FOUND' };
  return { ok: true, item };
}

/* ------------------------------------------------------------------------- */
/* Heartbeat                                                                  */
/* ------------------------------------------------------------------------- */

export async function heartbeatWork(
  proof: OwnershipProof,
  options: { leaseMs?: number } = {},
): Promise<LeaseResult> {
  const db = getDb();
  const now = queueNow();
  // The extension is server-decided. A worker asking to hold something for a
  // week is asking, not deciding.
  const expiresAt = plusMs(now, clampLeaseMs(options.leaseMs));

  const result = await db.run(
    `UPDATE work_items SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE ${OWNED}`,
    [now, expiresAt, now, ...ownedParams(proof, now)],
  );
  if (result.changes === 1) {
    // A counter and a timestamp, not a new row. A heartbeat every few seconds
    // across a fleet would otherwise be the largest table in the database.
    await db.run(
      `UPDATE work_leases
          SET last_heartbeat_at = ?, heartbeat_count = heartbeat_count + 1, expires_at = ?
        WHERE work_item_id = ? AND lease_generation = ?`,
      [now, expiresAt, proof.workItemId, proof.leaseGeneration],
    );
  }
  return await settle(proof, result.changes);
}

/* ------------------------------------------------------------------------- */
/* Terminal transitions                                                       */
/* ------------------------------------------------------------------------- */

async function endLease(
  proof: OwnershipProof,
  at: string,
  outcome: LeaseOutcome,
  detail: string | null,
): Promise<void> {
  await getDb().run(
    `UPDATE work_leases SET ended_at = ?, outcome = ?, detail = ?
      WHERE work_item_id = ? AND lease_generation = ?`,
    [at, outcome, bounded(detail, MAX_DETAIL_CHARS), proof.workItemId, proof.leaseGeneration],
  );
}

export async function completeWork(
  proof: OwnershipProof,
  result: { resultRef?: string | null; summary?: string | null } = {},
): Promise<LeaseResult> {
  const now = queueNow();
  // The lease fields are cleared because the schema's own CHECK says a lease
  // exists if and only if the item is LEASED. Who did the work is not lost —
  // it is in work_leases, which is the append-only record of exactly that.
  const updated = await getDb().run(
    `UPDATE work_items
        SET state = 'SUCCEEDED', result_ref = ?, result_summary = ?,
            lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE ${OWNED}`,
    [
      bounded(result.resultRef, MAX_RESULT_REF_CHARS),
      bounded(result.summary, MAX_SUMMARY_CHARS),
      now,
      now,
      ...ownedParams(proof, now),
    ],
  );
  if (updated.changes === 1) await endLease(proof, now, 'SUCCEEDED', result.summary ?? null);
  return await settle(proof, updated.changes);
}

export interface FailInput {
  category: WorkFailureCategory;
  detail?: string | null;
  /** A worker may say "do not try this again"; policy still decides. */
  retryable?: boolean;
}

export async function failWork(proof: OwnershipProof, input: FailInput): Promise<LeaseResult> {
  const db = getDb();
  const now = queueNow();

  const current = await db.get<WorkItemRow>('SELECT * FROM work_items WHERE id = ?', [
    proof.workItemId,
  ]);
  if (!current) return { ok: false, rejection: 'NOT_FOUND' };

  // Whether another attempt is allowed is decided from the row, not from the
  // worker's opinion of it — but a worker saying "this input will never work"
  // is respected as a ceiling, never as a floor.
  const attemptsLeft = current.attempt_count < current.max_attempts;
  const retry = input.retryable !== false && attemptsLeft;

  const updated = retry
    ? await db.run(
        `UPDATE work_items
            SET state = 'QUEUED', failure_category = ?, available_at = ?,
                lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
                leased_at = NULL, heartbeat_at = NULL, updated_at = ?
          WHERE ${OWNED}`,
        [
          input.category,
          plusMs(now, retryDelayMs(current.attempt_count)),
          now,
          ...ownedParams(proof, now),
        ],
      )
    : await db.run(
        `UPDATE work_items
            SET state = 'FAILED', failure_category = ?,
                result_summary = ?,
                lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE ${OWNED}`,
        [
          attemptsLeft ? input.category : 'ATTEMPTS_EXHAUSTED',
          bounded(input.detail, MAX_SUMMARY_CHARS),
          now,
          now,
          ...ownedParams(proof, now),
        ],
      );

  if (updated.changes === 1) await endLease(proof, now, 'FAILED', input.detail ?? null);
  return await settle(proof, updated.changes);
}

/**
 * Give the work back without consuming another attempt's worth of goodwill.
 *
 * The attempt is already counted — it was counted at claim time, which is the
 * only moment it can be counted exactly once. Releasing therefore does not
 * refund it, and a worker that claims and releases in a loop exhausts the item
 * rather than spinning on it forever.
 */
export async function releaseWork(
  proof: OwnershipProof,
  detail?: string | null,
): Promise<LeaseResult> {
  const db = getDb();
  const now = queueNow();
  const current = await db.get<WorkItemRow>('SELECT * FROM work_items WHERE id = ?', [
    proof.workItemId,
  ]);
  if (!current) return { ok: false, rejection: 'NOT_FOUND' };

  const exhausted = current.attempt_count >= current.max_attempts;
  const updated = exhausted
    ? await db.run(
        `UPDATE work_items
            SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
                lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE ${OWNED}`,
        [now, now, ...ownedParams(proof, now)],
      )
    : await db.run(
        `UPDATE work_items
            SET state = 'QUEUED', available_at = ?,
                lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
                leased_at = NULL, heartbeat_at = NULL, updated_at = ?
          WHERE ${OWNED}`,
        [now, now, ...ownedParams(proof, now)],
      );

  if (updated.changes === 1) await endLease(proof, now, 'RELEASED', detail ?? null);
  return await settle(proof, updated.changes);
}

/* ------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* ------------------------------------------------------------------------- */

export type CancelResult =
  | { ok: true; item: WorkItem }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_TERMINAL' };

/**
 * Cancellation wins, deterministically.
 *
 * It advances the fencing generation, which is what makes it win: whatever the
 * current owner does next presents the old generation and matches nothing. A
 * completion already in flight cannot resurrect the item, and a heartbeat
 * cannot keep it alive.
 *
 * It does not claim that an effect already in flight was undone. Nothing here
 * can promise that, and Step 6 is where that conversation belongs.
 */
export async function cancelWork(
  workItemId: string,
  reason: string,
): Promise<CancelResult> {
  const db = getDb();
  const now = queueNow();
  const updated = await db.run(
    `UPDATE work_items
        SET state = 'CANCELLED',
            cancelled_reason = ?,
            lease_generation = lease_generation + 1,
            lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
            leased_at = NULL, heartbeat_at = NULL,
            completed_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('QUEUED', 'LEASED')`,
    [bounded(reason, MAX_SUMMARY_CHARS) ?? 'cancelled', now, now, workItemId],
  );
  if (updated.changes !== 1) {
    const row = await db.get<WorkItemRow>('SELECT id FROM work_items WHERE id = ?', [workItemId]);
    return { ok: false, reason: row ? 'ALREADY_TERMINAL' : 'NOT_FOUND' };
  }
  await db.run(
    `UPDATE work_leases SET ended_at = ?, outcome = 'CANCELLED', detail = ?
      WHERE work_item_id = ? AND ended_at IS NULL`,
    [now, bounded(reason, MAX_DETAIL_CHARS), workItemId],
  );
  const item = await getWorkItem(workItemId);
  return item ? { ok: true, item } : { ok: false, reason: 'NOT_FOUND' };
}

/**
 * Re-prove ownership as a *write*, for use inside somebody else's transaction.
 *
 * This is the fence at the commit boundary, and it is the reason Step 6 can
 * promise that a stale worker cannot commit an effect. Checking ownership with
 * a SELECT and then writing would leave a window: the lease can expire, or the
 * item be reclaimed or cancelled, between the check and the commit.
 *
 * So it is a guarded UPDATE. Called inside the same transaction as the domain
 * mutation, it either matches — in which case this worker still owns the item
 * and the row is locked for the rest of the transaction — or it does not, and
 * the caller aborts. There is no interval in between.
 *
 * The `updated_at` touch is deliberate: an UPDATE that changes nothing is not a
 * lock, and the point of this statement is to take one.
 */
export async function proveLeaseOwnership(proof: OwnershipProof): Promise<boolean> {
  const now = queueNow();
  const result = await getDb().run(
    `UPDATE work_items SET updated_at = ? WHERE ${OWNED}`,
    [now, ...ownedParams(proof, now)],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Expiry sweeping — visibility only                                          */
/* ------------------------------------------------------------------------- */

/**
 * Close the lease rows of leases that have run out.
 *
 * Purely for visibility and metrics. Correctness does not depend on this ever
 * running: `claimWork` treats an expired lease as claimable work, so the next
 * worker to ask recovers the item whether or not a sweeper exists. That is what
 * "recovery must not depend on one process staying alive" means in practice.
 */
export async function sweepExpiredLeases(): Promise<number> {
  const now = queueNow();
  const result = await getDb().run(
    `UPDATE work_leases
        SET ended_at = ?, outcome = 'EXPIRED',
            detail = COALESCE(detail, 'The lease expired.')
      WHERE ended_at IS NULL AND expires_at <= ?`,
    [now, now],
  );
  return result.changes;
}

/* ------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* ------------------------------------------------------------------------- */

export interface QueueMetrics {
  queued: number;
  claimable: number;
  leased: number;
  expiredLeases: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  oldestQueuedAt: string | null;
  oldestLeaseAt: string | null;
}

export async function queueMetrics(projectId: string): Promise<QueueMetrics> {
  const db = getDb();
  const now = queueNow();
  const counts = await db.all<{ state: string; n: number }>(
    'SELECT state, COUNT(*) AS n FROM work_items WHERE project_id = ? GROUP BY state',
    [projectId],
  );
  const by = (state: string): number =>
    Number(counts.find((row) => row.state === state)?.n ?? 0);

  const claimable = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM work_items
      WHERE project_id = ?
        AND ( (state = 'QUEUED' AND available_at <= ?)
           OR (state = 'LEASED' AND lease_expires_at <= ?) )`,
    [projectId, now, now],
  );
  const expired = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM work_items
      WHERE project_id = ? AND state = 'LEASED' AND lease_expires_at <= ?`,
    [projectId, now],
  );
  const oldestQueued = await db.get<{ at: string }>(
    `SELECT MIN(available_at) AS at FROM work_items WHERE project_id = ? AND state = 'QUEUED'`,
    [projectId],
  );
  const oldestLease = await db.get<{ at: string }>(
    `SELECT MIN(leased_at) AS at FROM work_items WHERE project_id = ? AND state = 'LEASED'`,
    [projectId],
  );

  return {
    queued: by('QUEUED'),
    claimable: Number(claimable?.n ?? 0),
    leased: by('LEASED'),
    expiredLeases: Number(expired?.n ?? 0),
    succeeded: by('SUCCEEDED'),
    failed: by('FAILED'),
    cancelled: by('CANCELLED'),
    oldestQueuedAt: oldestQueued?.at ?? null,
    oldestLeaseAt: oldestLease?.at ?? null,
  };
}

/* ------------------------------------------------------------------------- */
/* Checkpoints                                                                */
/* ------------------------------------------------------------------------- */

/** Long enough to say where the work got to; far too short to hold a source. */
export const MAX_CHECKPOINT_CHARS = 2000;

/** How many notes one attempt may leave, so a loop cannot fill the table. */
export const MAX_CHECKPOINTS_PER_ATTEMPT = 50;

export class TooManyCheckpoints extends Error {
  constructor(limit: number) {
    super(`One attempt may write at most ${limit} checkpoints.`);
    this.name = 'TooManyCheckpoints';
  }
}

/**
 * Write a durable note against work this worker currently owns.
 *
 * The ownership proof is inside the `INSERT`, not in a `SELECT` before it. An
 * `INSERT ... SELECT` whose source row is the work item under the full `OWNED`
 * guard inserts exactly one row when the lease is current and zero rows when it
 * is not — so a worker whose lease expired mid-research cannot append to the
 * record of the attempt that replaced it. Reading first and inserting second
 * would leave the window between them, which is the window this whole queue is
 * built to not have.
 *
 * `project_id`, `attempt_number`, `lease_generation` and `worker_id` all come
 * from the item's own row rather than from the caller. A worker that could name
 * its own generation could forge the authorship of a note.
 */
export async function checkpointWork(
  proof: OwnershipProof,
  note: string,
): Promise<LeaseResult> {
  const trimmed = bounded(note, MAX_CHECKPOINT_CHARS);
  if (!trimmed) return { ok: false, rejection: 'NOT_FOUND' };

  const db = getDb();
  const now = queueNow();

  const existing = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM work_item_checkpoints
      WHERE work_item_id = ? AND lease_generation = ?`,
    [proof.workItemId, proof.leaseGeneration],
  );
  if (Number(existing?.n ?? 0) >= MAX_CHECKPOINTS_PER_ATTEMPT) {
    throw new TooManyCheckpoints(MAX_CHECKPOINTS_PER_ATTEMPT);
  }

  const written = await db.run(
    `INSERT INTO work_item_checkpoints
       (id, work_item_id, project_id, attempt_number, lease_generation, worker_id, note, created_at)
     SELECT ?, id, project_id, attempt_count, lease_generation, worker_id, ?, ?
       FROM work_items
      WHERE ${OWNED}`,
    [newId('wkc'), trimmed, now, ...ownedParams(proof, now)],
  );

  return await settle(proof, written.changes);
}

/**
 * Every note left on this item, oldest first.
 *
 * Deliberately not filtered by generation. The next claimant is supposed to
 * read what earlier attempts found — that is the entire reason the table
 * exists — and each row says which attempt wrote it, so nothing is confused
 * about whose finding is whose.
 */
/**
 * Every checkpoint on an item, in the order they were written.
 *
 * `rowid` rather than `id` as the tiebreaker, and the difference is not
 * cosmetic. Timestamps are ISO-8601 at millisecond resolution, two checkpoints
 * from one attempt are routinely written inside the same millisecond, and `id`
 * is a random identifier — so ordering by it returns an arbitrary permutation
 * of the notes whenever the clock does not separate them.
 *
 * That is exactly wrong for the one thing this table is for: the next attempt
 * reads these to find out what the last one established, and a log out of order
 * is worse than no log. `rowid` is the insertion counter, `dialect.ts` maps it
 * to `seq` on Postgres, and thirty-odd other queries in this codebase already
 * use it for this reason.
 *
 * Found by CI after passing locally many times, which is the signature of an
 * ordering that depends on how fast the machine is.
 */
export async function listCheckpoints(workItemId: string): Promise<WorkItemCheckpoint[]> {
  const rows = await getDb().all<WorkItemCheckpointRow>(
    `SELECT * FROM work_item_checkpoints WHERE work_item_id = ? ORDER BY created_at, rowid`,
    [workItemId],
  );
  return rows.map((row) => ({
    id: row.id,
    workItemId: row.work_item_id,
    projectId: row.project_id,
    attemptNumber: row.attempt_number,
    leaseGeneration: row.lease_generation,
    workerId: row.worker_id,
    note: row.note,
    createdAt: row.created_at,
  }));
}
