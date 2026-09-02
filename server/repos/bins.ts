/**
 * Bins: the durable mission a worker is handed, and who owns it right now.
 *
 * This module is Step 5's queue repository one level up, and deliberately so.
 * The claim is the same compare-and-swap on a generation number, the fence is
 * the same generation carried in every guarded `UPDATE`, and an expired lease
 * is claimable work for the same reason — recovery must not depend on any
 * process staying alive.
 *
 * What is different is *what* is being owned. A work item is one unit of doing;
 * a bin is one complete idea, with a manifest that fully specifies it and a
 * contract that decides whether it was finished. A worker leases the bin, then
 * drains the bin's own work items through the machinery that already existed.
 *
 * Two rules are worth stating here because every function below depends on
 * them and neither is visible from any single one:
 *
 *   1. **The bin is read from the lease, never from the request.** A worker
 *      checking in names nothing. What it is given comes out of a swap the
 *      server performed. So there is no argument anywhere in this file by which
 *      a caller could reach a bin it does not own.
 *
 *   2. **`worker_id` comes from the authenticated principal.** Never from a
 *      body field. A worker saying it is a worker is not evidence that it is
 *      that worker.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { bindRoutineWorker, recordRoutineCheckIn } from './fleet.ts';
import type { BinConfinement } from './workQueue.ts';
import type {
  Bin,
  BinDispatch,
  CapacityEvidence,
  BinDispatchRow,
  BinDispatchState,
  BinEvent,
  BinEventRow,
  BinManifest,
  BinRow,
  BinState,
  BinUnitResult,
  BinUnitResultRow,
  CompletionContract,
} from '../domain/types.ts';

/**
 * Brain's clock, never a worker's.
 *
 * The same assumption `queueNow` documents: instances agree on the time to far
 * less than a lease duration, and if they ever do not, the failure is a lease
 * reclaimed early or late rather than a lease with two owners — because
 * ownership is decided by the generation swap and not by the clock.
 */
export function binNow(): string {
  return nowIso();
}

function plusMs(from: string, ms: number): string {
  return new Date(new Date(from).getTime() + ms).toISOString();
}

/* ------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* ------------------------------------------------------------------------- */

export const MIN_BIN_LEASE_MS = 30_000;
export const MAX_BIN_LEASE_MS = 4 * 60 * 60 * 1000;
/**
 * Fifteen minutes.
 *
 * Long enough that a worker doing real research is not fighting its own lease
 * between heartbeats, short enough that a session which died silently is
 * recoverable inside one activation rather than at the end of the day. The
 * acceptance run measures whether it is right; this is the starting point, not
 * a conclusion.
 */
export const DEFAULT_BIN_LEASE_MS = 15 * 60 * 1000;

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_CHECKPOINT_BYTES = 8 * 1024;
export const MAX_UNIT_VALUE_CHARS = 4_000;
export const MAX_REASON_CHARS = 2_000;

export function clampBinLeaseMs(ms: number | undefined): number {
  if (!Number.isFinite(ms ?? NaN)) return DEFAULT_BIN_LEASE_MS;
  return Math.min(MAX_BIN_LEASE_MS, Math.max(MIN_BIN_LEASE_MS, Math.floor(ms as number)));
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

const EMPTY_MANIFEST: BinManifest = {
  objective: '',
  why: '',
  lineage: { projectId: '', layerId: null, goal: null, orchestrationId: null },
  units: [],
  acceptableSources: [],
  excludedSources: [],
  evidence: [],
  outputs: [],
  authorizedActions: [],
  prohibitedActions: [],
  budgetUnits: null,
  retry: { maxAttempts: 3, backoffSeconds: 60 },
  stoppingConditions: [],
};

export function mapBin(row: BinRow): Bin {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    kind: row.kind,
    title: row.title,
    objective: row.objective,
    rationale: row.rationale,
    manifest: parseJson<BinManifest>(row.manifest, EMPTY_MANIFEST),
    completionContract: row.completion_contract as CompletionContract,
    contractVersion: row.contract_version,
    state: row.state as BinState,
    priority: row.priority,
    orchestrationId: row.orchestration_id,
    budgetUnits: row.budget_units,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseGeneration: row.lease_generation,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    leaseCredentialId: row.lease_credential_id,
    leaseSessionRef: row.lease_session_ref,
    leasedAt: row.leased_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseRenewals: row.lease_renewals,
    checkpoint: row.checkpoint ? parseJson<Record<string, unknown>>(row.checkpoint, {}) : null,
    checkpointAt: row.checkpoint_at,
    terminalReason: row.terminal_reason,
    lastRefusal: row.last_refusal,
    refusalCount: row.refusal_count,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
    completedAt: row.completed_at,
  };
}

export function mapBinDispatch(row: BinDispatchRow): BinDispatch {
  return {
    id: row.id,
    binId: row.bin_id,
    leaseGeneration: row.lease_generation,
    state: row.state as BinDispatchState,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    routineRef: row.routine_ref,
    routineVersion: row.routine_version,
    fireEventId: row.fire_event_id,
    sessionRef: row.session_ref,
    lastErrorKind: row.last_error_kind,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

export function mapBinUnitResult(row: BinUnitResultRow): BinUnitResult {
  return {
    id: row.id,
    binId: row.bin_id,
    unitKey: row.unit_key,
    workItemId: row.work_item_id,
    value: row.value,
    contentHash: row.content_hash,
    leaseId: row.lease_id,
    leaseGeneration: row.lease_generation,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
  };
}

export function mapBinEvent(row: BinEventRow): BinEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    at: row.at,
    binId: row.bin_id,
    projectId: row.project_id,
    layerId: row.layer_id,
    orchestrationId: row.orchestration_id,
    workItemId: row.work_item_id,
    workerId: row.worker_id,
    sessionRef: row.session_ref,
    routineRef: row.routine_ref,
    routineVersion: row.routine_version,
    fireEventId: row.fire_event_id,
    provider: row.provider,
    leaseId: row.lease_id,
    leaseGeneration: row.lease_generation,
    attempt: row.attempt,
    durationMs: row.duration_ms,
    measures: parseJson<Record<string, unknown>>(row.measures, {}),
    outcome: row.outcome,
    reason: row.reason,
    isProxy: row.is_proxy === 1,
  };
}

/* ------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* ------------------------------------------------------------------------- */

export interface RecordBinEventInput {
  eventType: string;
  binId?: string | null;
  projectId?: string | null;
  layerId?: string | null;
  orchestrationId?: string | null;
  workItemId?: string | null;
  workerId?: string | null;
  sessionRef?: string | null;
  routineRef?: string | null;
  routineVersion?: string | null;
  fireEventId?: string | null;
  provider?: string | null;
  leaseId?: string | null;
  leaseGeneration?: number | null;
  attempt?: number | null;
  durationMs?: number | null;
  measures?: Record<string, unknown>;
  outcome?: string | null;
  reason?: string | null;
  isProxy?: boolean;
  /* Step 11 attribution. Which surface the event belongs to, and what kind of
   * fact it is — see `CAPACITY_EVIDENCE`. All nullable: most Step 10 events
   * belong to a bin rather than to a surface, and an event with no capacity
   * meaning has no evidence class rather than a defaulted one. */
  accountId?: string | null;
  routineId?: string | null;
  evidenceClass?: CapacityEvidence | null;
  workloadClass?: string | null;
}

/**
 * One raw observation, appended.
 *
 * Step 11 is not being built here. These rows are the facts it will need and
 * which cannot be reconstructed afterwards from application logs, so they are
 * written at the moment the thing happens rather than derived later from
 * something that survived.
 *
 * Never throws. A telemetry write that could fail an operation would make the
 * measurement change the thing being measured, and losing one observation is a
 * far smaller loss than failing a bin because a counter would not insert.
 */
export async function recordBinEvent(input: RecordBinEventInput): Promise<void> {
  try {
    await getDb().run(
      `INSERT INTO bin_events (id, event_type, at, bin_id, project_id, layer_id,
         orchestration_id, work_item_id, worker_id, session_ref, routine_ref, routine_version,
         fire_event_id, provider, lease_id, lease_generation, attempt, duration_ms,
         measures, outcome, reason, is_proxy, account_id, routine_id, evidence_class,
         workload_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('bev'),
        input.eventType,
        binNow(),
        input.binId ?? null,
        input.projectId ?? null,
        input.layerId ?? null,
        input.orchestrationId ?? null,
        input.workItemId ?? null,
        input.workerId ?? null,
        input.sessionRef ?? null,
        input.routineRef ?? null,
        input.routineVersion ?? null,
        input.fireEventId ?? null,
        input.provider ?? null,
        input.leaseId ?? null,
        input.leaseGeneration ?? null,
        input.attempt ?? null,
        input.durationMs ?? null,
        toJson(input.measures ?? {}),
        bounded(input.outcome, 200),
        bounded(input.reason, MAX_REASON_CHARS),
        input.isProxy ? 1 : 0,
        input.accountId ?? null,
        input.routineId ?? null,
        input.evidenceClass ?? null,
        input.workloadClass ?? null,
      ],
    );
  } catch {
    // Deliberately swallowed. See the note above.
  }
}

export async function listBinEvents(binId: string, limit = 500): Promise<BinEvent[]> {
  const rows = await getDb().all<BinEventRow>(
    `SELECT * FROM bin_events WHERE bin_id = ? ORDER BY at, rowid LIMIT ?`,
    [binId, Math.min(5000, Math.max(1, limit))],
  );
  return rows.map(mapBinEvent);
}

export async function countBinEvents(binId: string, eventType: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events WHERE bin_id = ? AND event_type = ?`,
    [binId, eventType],
  );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

export async function getBin(id: string): Promise<Bin | null> {
  const row = await getDb().get<BinRow>(`SELECT * FROM bins WHERE id = ?`, [id]);
  return row ? mapBin(row) : null;
}

export async function listBins(filter: {
  projectId?: string;
  states?: BinState[];
  limit?: number;
}): Promise<Bin[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.projectId) {
    clauses.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.states && filter.states.length > 0) {
    clauses.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
    params.push(...filter.states);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(500, Math.max(1, filter.limit ?? 100)));
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins ${where} ORDER BY priority DESC, created_at, rowid LIMIT ?`,
    params,
  );
  return rows.map(mapBin);
}

/**
 * The bin this worker currently holds, if any.
 *
 * Used to confine `brain_claim_work`: a worker inside a bin must not be able to
 * reach into the wider queue, and the confinement has to be derived from the
 * server's own rows rather than from the worker remembering to stay put.
 *
 * A worker can hold at most one bin because assignment leases exactly one, so
 * the first row is the answer rather than an arbitrary pick.
 */
export async function activeBinForWorker(workerId: string): Promise<Bin | null> {
  const row = await getDb().get<BinRow>(
    `SELECT * FROM bins WHERE state = 'LEASED' AND worker_id = ? AND lease_expires_at > ?
      ORDER BY leased_at DESC LIMIT 1`,
    [workerId, binNow()],
  );
  return row ? mapBin(row) : null;
}

/**
 * What a worker holding this bin may claim from the queue.
 *
 * A bin naming an orchestration is a lease on that packet, so its worker may
 * take the packet's queued work — which is where research work actually lives,
 * because `advancePacket` creates it knowing nothing about bins. A bin naming
 * none confines to the items tagged with it, exactly as before.
 */
export function confinementFor(bin: Bin): BinConfinement {
  return { id: bin.id, orchestrationId: bin.orchestrationId };
}

export async function binForOrchestration(orchestrationId: string): Promise<Bin | null> {
  const row = await getDb().get<BinRow>(`SELECT * FROM bins WHERE orchestration_id = ?`, [
    orchestrationId,
  ]);
  return row ? mapBin(row) : null;
}

/* ------------------------------------------------------------------------- */
/* Authoring                                                                  */
/* ------------------------------------------------------------------------- */

export interface CreateBinInput {
  projectId: string;
  layerId?: string | null;
  kind: string;
  title: string;
  objective: string;
  rationale?: string | null;
  manifest: BinManifest;
  completionContract: CompletionContract;
  contractVersion?: number;
  priority?: number;
  orchestrationId?: string | null;
  budgetUnits?: number | null;
  maxAttempts?: number;
  createdByType: string;
  createdById?: string | null;
  /** Author it already dispatchable. Used by every caller that has finished planning. */
  ready?: boolean;
}

export class ManifestTooLarge extends Error {
  constructor(public readonly bytes: number) {
    super(`The manifest is ${bytes} bytes; the limit is ${MAX_MANIFEST_BYTES}.`);
  }
}

export async function createBin(input: CreateBinInput): Promise<Bin> {
  const manifest = toJson(input.manifest);
  const bytes = Buffer.byteLength(manifest, 'utf8');
  if (bytes > MAX_MANIFEST_BYTES) throw new ManifestTooLarge(bytes);

  const id = newId('bin');
  const at = binNow();
  const ready = input.ready === true;
  await getDb().run(
    `INSERT INTO bins (id, project_id, layer_id, kind, title, objective, rationale, manifest,
       completion_contract, contract_version, state, priority, orchestration_id, budget_units,
       attempt_count, max_attempts, lease_generation, lease_id, worker_id, lease_credential_id,
       lease_session_ref, leased_at, heartbeat_at, lease_expires_at, lease_renewals,
       checkpoint, checkpoint_at, terminal_reason, last_refusal, refusal_count,
       created_by_type, created_by_id, created_at, updated_at, ready_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0,
             ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.projectId,
      input.layerId ?? null,
      input.kind,
      input.title,
      input.objective,
      input.rationale ?? null,
      manifest,
      input.completionContract,
      Math.max(1, input.contractVersion ?? 1),
      ready ? 'READY' : 'DRAFT',
      Math.min(9, Math.max(0, input.priority ?? 5)),
      input.orchestrationId ?? null,
      input.budgetUnits ?? null,
      Math.max(1, input.maxAttempts ?? 3),
      input.createdByType,
      input.createdById ?? null,
      at,
      at,
      ready ? at : null,
    ],
  );
  const created = await getBin(id);
  if (!created) throw new Error('The bin disappeared immediately after being written.');
  await recordBinEvent({
    eventType: ready ? 'BIN_READY' : 'BIN_CREATED',
    binId: id,
    projectId: input.projectId,
    layerId: input.layerId ?? null,
    orchestrationId: input.orchestrationId ?? null,
    measures: { units: input.manifest.units.length, priority: created.priority },
    outcome: created.state,
  });
  return created;
}

/**
 * Give a bin more assignments, because a platform fault spent the ones it had.
 *
 * An attempt is an assignment (see `assignNextBin`), which is right: a worker
 * that died still cost the bin a go at it. But that accounting assumes the
 * attempts were spent *on the work*. When Brain itself handed a worker a bin it
 * had made undrainable, the budget records a fault in Brain, and letting it
 * exhaust would retire a live packet for a reason that is not about the packet.
 *
 * So this is deliberately narrow, and each restriction is load-bearing:
 *
 *   - It **raises the ceiling and never resets the count**. §5: the failed
 *     attempts stay in the history where a reader can see them.
 *   - It **only ever raises**. A call that would lower the ceiling changes
 *     nothing, so it cannot be used to strand a bin.
 *   - It **refuses a terminal bin**, matching on the states that are still
 *     live, so a finished bin cannot be quietly reopened by widening a number.
 *   - It **records why**, as an ordinary bin event. An operator action with no
 *     audit row is invariant 3 again.
 */
export async function regrantBinAttempts(input: {
  binId: string;
  maxAttempts: number;
  reason: string;
}): Promise<{ bin: Bin | null; raised: boolean }> {
  const at = binNow();
  const result = await getDb().run(
    `UPDATE bins SET max_attempts = ?, updated_at = ?
      WHERE id = ? AND max_attempts < ?
        AND state IN ('DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN')`,
    [input.maxAttempts, at, input.binId, input.maxAttempts],
  );
  const bin = await getBin(input.binId);
  if (result.changes === 1 && bin) {
    await recordBinEvent({
      eventType: 'BIN_ATTEMPTS_REGRANTED',
      binId: bin.id,
      projectId: bin.projectId,
      orchestrationId: bin.orchestrationId,
      leaseGeneration: bin.leaseGeneration,
      attempt: bin.attemptCount,
      measures: { maxAttempts: bin.maxAttempts },
      outcome: 'REGRANTED',
      reason: input.reason,
    });
  }
  return { bin, raised: result.changes === 1 };
}

/** Why a reopen was refused, or that it happened. */
export type ReopenOutcome =
  | { ok: true; bin: Bin; previousState: string; previousGeneration: number; generation: number }
  | { ok: false; refusal: 'NOT_FOUND' | 'WRONG_STATE' | 'STALE_GENERATION' | 'NO_ATTEMPTS_LEFT'; reason: string };

/**
 * A person answers the escalation a bin raised, and the bin goes back to work.
 *
 * The state machine had no edge here, and the gap was the same shape as the one
 * `advancePacket` had: a bin escalates to `NEEDS_HUMAN` naming a condition, the
 * person resolves that condition, and nothing can act on the resolution.
 * `markBinReady` matches `DRAFT` only, and `resolveNeedsHumanBin` offers
 * `CANCELLED` or `FAILED` — so the only answers available were to destroy the
 * work. **A state that says "waiting for a person" which that person cannot
 * resolve is not waiting; it is stuck.**
 *
 * Deliberately its own statement rather than a widening of `markBinReady`.
 * That function's `DRAFT` guard is what stops two callers both believing they
 * were the transition that created dispatch intent, and adding a second state
 * to it would weaken that for every existing caller to serve one new one.
 *
 * Four properties make it safe rather than an override:
 *
 *   - **It matches exactly one source state.** `DRAFT`, `READY`, `LEASED`,
 *     `COMPLETE`, `CANCELLED` and `FAILED` all match nothing, so this can
 *     neither race a live worker nor rewrite a finished bin.
 *   - **It is a compare-and-swap on the generation**, which is §19's rule and
 *     not a special case here: a caller reasoning about generation 7 writes
 *     only if the bin is still at 7.
 *   - **It advances the generation**, so every worker that held this bin before
 *     the escalation is fenced — a late completion from one of them matches
 *     nothing, exactly as cancellation fences one.
 *   - **It requires budget.** Reopening a bin with no attempt left produces a
 *     bin nothing can assign, which is the stuck state again wearing `READY`.
 *     The refusal names the exhausted budget so the operator knows the remedy
 *     is a regrant rather than another reopen.
 *
 * Nothing is reset. `attempt_count`, the completion refusals, the unit results
 * and every event stay exactly where they are: the escalation is answered, not
 * erased. The `BIN_REOPENED` row records who answered it, why, what state it
 * came from, both generations, and the evidence they resolved it on — because
 * a reopen nobody can later explain is indistinguishable from a bin that
 * quietly un-parked itself.
 */
export async function reopenNeedsHumanBin(input: {
  binId: string;
  /** The generation the caller believes it is acting on. */
  leaseGeneration: number;
  /** Who is answering the escalation. Recorded, never inferred. */
  operator: string;
  reason: string;
  /** What the operator resolved it on — an id, a status, a run. */
  resolutionEvidence: Record<string, unknown>;
}): Promise<ReopenOutcome> {
  const before = await getBin(input.binId);
  if (!before) return { ok: false, refusal: 'NOT_FOUND', reason: `No bin ${input.binId}.` };
  if (before.state !== 'NEEDS_HUMAN') {
    return {
      ok: false,
      refusal: 'WRONG_STATE',
      reason:
        `Bin ${input.binId} is ${before.state}, not NEEDS_HUMAN. This answers an escalation and ` +
        'nothing else: a drafted, ready, leased or finished bin is not one waiting for a person.',
    };
  }
  if (before.attemptCount >= before.maxAttempts) {
    return {
      ok: false,
      refusal: 'NO_ATTEMPTS_LEFT',
      reason:
        `Bin ${input.binId} has used ${before.attemptCount} of ${before.maxAttempts} assignment ` +
        'attempts, so reopening it would produce a bin nothing can assign. Regrant its budget ' +
        'first, with the reason the budget went.',
    };
  }

  const at = binNow();
  const nextGeneration = input.leaseGeneration + 1;
  // The whole proof in one statement: the item, the generation the caller
  // reasoned about, and the one state this may act on. Never read-then-write.
  const result = await getDb().run(
    `UPDATE bins
        SET state = 'READY', ready_at = ?, updated_at = ?,
            lease_generation = lease_generation + 1,
            lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
            leased_at = NULL, heartbeat_at = NULL,
            terminal_reason = NULL, completed_at = NULL
      WHERE id = ? AND state = 'NEEDS_HUMAN' AND lease_generation = ?`,
    [at, at, input.binId, input.leaseGeneration],
  );
  if (result.changes !== 1) {
    return {
      ok: false,
      refusal: 'STALE_GENERATION',
      reason:
        `Bin ${input.binId} is not at generation ${input.leaseGeneration} any more, so this ` +
        'reopen was reasoning about a bin that has since moved. Read it again and decide again.',
    };
  }

  await recordBinEvent({
    eventType: 'BIN_REOPENED',
    binId: before.id,
    projectId: before.projectId,
    orchestrationId: before.orchestrationId,
    leaseGeneration: nextGeneration,
    attempt: before.attemptCount,
    outcome: 'READY',
    reason: input.reason,
    measures: {
      operator: input.operator,
      previousState: before.state,
      previousGeneration: input.leaseGeneration,
      generation: nextGeneration,
      attemptCount: before.attemptCount,
      maxAttempts: before.maxAttempts,
      resolutionEvidence: input.resolutionEvidence,
    },
  });

  const bin = (await getBin(input.binId))!;
  return {
    ok: true,
    bin,
    previousState: before.state,
    previousGeneration: input.leaseGeneration,
    generation: nextGeneration,
  };
}

/**
 * Make a drafted bin dispatchable.
 *
 * Guarded on `DRAFT` so two callers cannot both "make it ready" and both
 * believe they were the transition that did it — which matters because the
 * transition is what creates dispatch intent.
 *
 * Deliberately still `DRAFT` only. Answering a `NEEDS_HUMAN` escalation is
 * `reopenNeedsHumanBin` above, which fences and audits; widening this one to
 * reach that state would give every existing caller a power none of them mean
 * to have.
 */
export async function markBinReady(id: string): Promise<Bin | null> {
  const at = binNow();
  const result = await getDb().run(
    `UPDATE bins SET state = 'READY', ready_at = ?, updated_at = ? WHERE id = ? AND state = 'DRAFT'`,
    [at, at, id],
  );
  const bin = await getBin(id);
  if (result.changes === 1 && bin) {
    await recordBinEvent({
      eventType: 'BIN_READY',
      binId: bin.id,
      projectId: bin.projectId,
      orchestrationId: bin.orchestrationId,
      leaseGeneration: bin.leaseGeneration,
      outcome: 'READY',
    });
  }
  return bin;
}

/* ------------------------------------------------------------------------- */
/* Assignment — the compare-and-swap                                          */
/* ------------------------------------------------------------------------- */

export interface AssignBinInput {
  /** From the authenticated principal. Never from anything the caller sent. */
  workerId: string;
  credentialId?: string | null;
  /** Projects this worker may take work from, read this request. */
  projectIds: string[];
  /** The provider's own session identity, for telemetry only. Never authority. */
  sessionRef?: string | null;
  leaseMs?: number;
}

export interface AssignedBin {
  bin: Bin;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  /** True when this bin was picked up from an expired lease rather than fresh. */
  takeover: boolean;
}

/**
 * Hand exactly one ready bin to a worker that named nothing.
 *
 * The whole of Step 10's isolation guarantee is the `WHERE` clause below. Two
 * workers can both read generation 4 and both attempt the swap; exactly one
 * matches, because the winner made it 5 before the loser's statement ran. The
 * loser is not an error — it takes the next candidate, and if there are none it
 * is told there is nothing to do and exits cheaply.
 *
 * An expired lease is a candidate. That is what makes a dead worker's bin
 * recoverable without any process staying alive to notice, and it is why
 * `attempt_count` advances here rather than at release: the attempt is the
 * assignment, whether or not whoever held it last ever came back.
 */
/**
 * What "there is work for a worker" means, in one place.
 *
 * This predicate was written out four times — the assigner, the dispatcher's
 * ensure pass, its pre-fire re-read, and the supersede pass — and three of them
 * said `state = 'READY'` while the assigner said READY *or* a LEASED bin whose
 * lease has run out. The disagreement is not cosmetic: a worker that dies
 * leaves a bin the assigner will happily hand to the next caller and the
 * dispatcher will never start anyone for. If nothing else is ready, nothing
 * ever comes, and the bin waits forever.
 *
 * Fixed here rather than by calling the sweeper on a timer, because §19 is
 * explicit that an expired lease is claimable work and recovery must never
 * depend on one process staying alive. A sweeper that has to run for stranded
 * work to be recovered is that dependency wearing a different hat.
 *
 * The attempt budget is part of it, and that was the second lesson rather than
 * the first. `listDispatchableBins` and `assignNextBin` each carried
 * `attempt_count < max_attempts` as a separate line while the dispatcher's
 * pre-fire re-read and the supersede pass did not — so an intent created just
 * before a bin exhausted itself would still be fired, starting a worker the
 * assigner would then refuse. That spends the routine's limited fire budget to
 * achieve nothing, which is the one resource this step found is actually
 * scarce. One predicate, four callers, no copies.
 *
 * One `?`, bound to now.
 */
export const DISPATCHABLE_SQL =
  "((state = 'READY' OR (state = 'LEASED' AND lease_expires_at <= ?))" +
  ' AND attempt_count < max_attempts)';

/** The same question asked of a row already in memory. */
export function isDispatchable(bin: Bin, now: string = binNow()): boolean {
  // Out of attempts is out of work. A bin the assigner will refuse must not
  // earn an activation: firing at it spends the routine's limited budget to
  // start a worker that will be handed nothing. `reconcileBins` is what turns
  // an exhausted bin into a decision, and `regrantBinAttempts` is the answer
  // it names.
  if (bin.attemptCount >= bin.maxAttempts) return false;
  if (bin.state === 'READY') return true;
  if (bin.state !== 'LEASED') return false;
  return bin.leaseExpiresAt !== null && bin.leaseExpiresAt <= now;
}

/**
 * Every bin that deserves an activation, in the order a worker would be given
 * them. Bounded: the dispatcher reads a page, not the world.
 */
export async function listDispatchableBins(limit = 200): Promise<Bin[]> {
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins
      WHERE ${DISPATCHABLE_SQL}
      ORDER BY priority DESC, created_at, rowid
      LIMIT ?`,
    [binNow(), Math.min(500, Math.max(1, limit))],
  );
  return rows.map(mapBin);
}

export async function assignNextBin(input: AssignBinInput): Promise<AssignedBin | null> {
  const db = getDb();
  const leaseMs = clampBinLeaseMs(input.leaseMs);
  if (input.projectIds.length === 0) return null;

  for (let round = 0; round < 3; round += 1) {
    const now = binNow();
    const params: SqlParam[] = [now, ...input.projectIds];

    // Deterministic baseline ordering: priority first, then oldest first, then
    // the insertion counter so the order is total rather than merely mostly
    // decided. Two workers see the same list and the swap settles the rest.
    const candidates = await db.all<BinRow>(
      `SELECT * FROM bins
        WHERE ${DISPATCHABLE_SQL}
          AND project_id IN (${input.projectIds.map(() => '?').join(', ')})
        ORDER BY priority DESC, created_at, rowid
        LIMIT 25`,
      params,
    );

    if (candidates.length === 0) return null;

    for (const row of candidates) {
      const leaseId = newId('bls');
      const at = binNow();
      const expires = plusMs(at, leaseMs);
      const nextGeneration = row.lease_generation + 1;
      const takeover = row.state === 'LEASED';

      // Everything that decides ownership is in this one statement. There is no
      // read-then-write window for a race to live in, and the generation the
      // caller last saw is carried in the clause rather than trusted.
      const result = await db.run(
        `UPDATE bins
            SET state = 'LEASED',
                lease_generation = ?,
                lease_id = ?,
                worker_id = ?,
                lease_credential_id = ?,
                lease_session_ref = ?,
                leased_at = ?,
                heartbeat_at = ?,
                lease_expires_at = ?,
                lease_renewals = 0,
                attempt_count = attempt_count + 1,
                updated_at = ?
          WHERE id = ?
            AND lease_generation = ?
            AND ${DISPATCHABLE_SQL}`,
        [
          nextGeneration,
          leaseId,
          input.workerId,
          input.credentialId ?? null,
          bounded(input.sessionRef, 200),
          at,
          at,
          expires,
          at,
          row.id,
          row.lease_generation,
          at,
        ],
      );

      if (result.changes !== 1) continue; // Somebody else won it. Ordinary.

      const bin = await getBin(row.id);
      if (!bin) continue;

      await recordBinEvent({
        eventType: takeover ? 'BIN_TAKEOVER' : 'BIN_ASSIGNED',
        binId: bin.id,
        projectId: bin.projectId,
        layerId: bin.layerId,
        orchestrationId: bin.orchestrationId,
        workerId: input.workerId,
        sessionRef: input.sessionRef ?? null,
        leaseId,
        leaseGeneration: nextGeneration,
        attempt: bin.attemptCount,
        durationMs: bin.readyAt ? new Date(at).getTime() - new Date(bin.readyAt).getTime() : null,
        measures: { leaseMs, queueWaitMs: bin.readyAt ? new Date(at).getTime() - new Date(bin.readyAt).getTime() : null },
        outcome: takeover ? 'TAKEOVER' : 'ASSIGNED',
      });

      await creditDispatchArrival(row.id, row.lease_generation, input.workerId);

      return { bin, leaseId, leaseGeneration: nextGeneration, leaseExpiresAt: expires, takeover };
    }
  }
  return null;
}

/**
 * The fired session arrived. Credit it to the surface that was fired.
 *
 * A no-show streak only means something if something clears it, and until this
 * existed nothing did. Every successful fire advanced `consecutive_no_shows`
 * and no production path ever recorded an arrival, so three fires at a
 * perfectly healthy Routine made it a quarantine candidate — a health signal
 * pointing the opposite way to reality. `bindRoutineWorker` said "the check-in
 * path fills it in" about a check-in path that was never wired.
 *
 * Attribution is from the dispatch that produced this worker — the SENT intent
 * at the generation this assignment has just superseded — and never from
 * anything the worker said about itself. A body field naming a Routine would be
 * the same mistake §19 already refuses for queue ownership.
 *
 * A takeover of an expired lease credits nothing, because the intent at *that*
 * generation was the previous owner's and its session genuinely did not finish.
 * The lookup finding no row is the ordinary case for a bin that was never
 * dispatched at all, and it is silent on purpose.
 */
async function creditDispatchArrival(
  binId: string,
  leaseGeneration: number,
  workerId: string,
): Promise<void> {
  const row = await getDb().get<{ routine_id: string | null }>(
    `SELECT routine_id FROM bin_dispatch
      WHERE bin_id = ? AND lease_generation = ? AND state = 'SENT' AND routine_id IS NOT NULL`,
    [binId, leaseGeneration],
  );
  const routineId = row?.routine_id;
  if (!routineId) return;
  await recordRoutineCheckIn(routineId);
  // Observed, not declared. Refused rather than re-pointed when the row already
  // names a different identity; the operator's `bind-worker` is for that case
  // and a silent overwrite here would hide it.
  await bindRoutineWorker(routineId, workerId);
}

/* ------------------------------------------------------------------------- */
/* Ownership-sensitive operations                                             */
/* ------------------------------------------------------------------------- */

export interface BinProof {
  binId: string;
  leaseId: string;
  leaseGeneration: number;
  /** From the authenticated principal. */
  workerId: string;
}

export type BinLeaseOutcome = 'OK' | 'NOT_OWNER';

/**
 * The clause every ownership-sensitive statement carries.
 *
 * Item, lease, generation, the worker from the principal, the LEASED state and
 * an unexpired lease. A worker whose lease expired while it was busy comes back
 * holding generation 4 against a row now on 5 and matches nothing: it cannot
 * resurrect the bin, overwrite the new owner's work, or report success for a
 * mission somebody else is already redoing.
 */
function ownershipClause(): string {
  return `id = ? AND state = 'LEASED' AND lease_id = ? AND lease_generation = ?
            AND worker_id = ? AND lease_expires_at > ?`;
}

function ownershipParams(proof: BinProof, now: string): SqlParam[] {
  return [proof.binId, proof.leaseId, proof.leaseGeneration, proof.workerId, now];
}

export async function proveBinOwnership(proof: BinProof): Promise<Bin | null> {
  const now = binNow();
  const row = await getDb().get<BinRow>(
    `SELECT * FROM bins WHERE ${ownershipClause()}`,
    ownershipParams(proof, now),
  );
  return row ? mapBin(row) : null;
}

export async function heartbeatBin(
  proof: BinProof,
  leaseMs?: number,
): Promise<{ outcome: BinLeaseOutcome; expiresAt: string | null }> {
  const now = binNow();
  const expires = plusMs(now, clampBinLeaseMs(leaseMs));
  const result = await getDb().run(
    `UPDATE bins SET heartbeat_at = ?, lease_expires_at = ?, lease_renewals = lease_renewals + 1,
       updated_at = ? WHERE ${ownershipClause()}`,
    [now, expires, now, ...ownershipParams(proof, now)],
  );
  if (result.changes !== 1) {
    await recordBinEvent({
      eventType: 'BIN_STALE_WRITE',
      binId: proof.binId,
      workerId: proof.workerId,
      leaseId: proof.leaseId,
      leaseGeneration: proof.leaseGeneration,
      outcome: 'REJECTED',
      reason: 'heartbeat after lease loss',
    });
    return { outcome: 'NOT_OWNER', expiresAt: null };
  }
  await recordBinEvent({
    eventType: 'BIN_HEARTBEAT',
    binId: proof.binId,
    workerId: proof.workerId,
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    outcome: 'RENEWED',
  });
  return { outcome: 'OK', expiresAt: expires };
}

export async function checkpointBin(
  proof: BinProof,
  checkpoint: Record<string, unknown>,
): Promise<BinLeaseOutcome> {
  const body = toJson(checkpoint);
  if (Buffer.byteLength(body, 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw new Error(`A checkpoint may be at most ${MAX_CHECKPOINT_BYTES} bytes.`);
  }
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins SET checkpoint = ?, checkpoint_at = ?, updated_at = ? WHERE ${ownershipClause()}`,
    [body, now, now, ...ownershipParams(proof, now)],
  );
  if (result.changes !== 1) {
    await recordBinEvent({
      eventType: 'BIN_STALE_WRITE',
      binId: proof.binId,
      workerId: proof.workerId,
      leaseId: proof.leaseId,
      leaseGeneration: proof.leaseGeneration,
      outcome: 'REJECTED',
      reason: 'checkpoint after lease loss',
    });
    return 'NOT_OWNER';
  }
  await recordBinEvent({
    eventType: 'BIN_CHECKPOINT',
    binId: proof.binId,
    workerId: proof.workerId,
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    outcome: 'RECORDED',
  });
  return 'OK';
}

/**
 * Give the bin back without finishing it.
 *
 * The generation advances, which is what makes the release immediate: the
 * releasing worker's own proof stops matching the moment it succeeds, and the
 * bin earns a fresh dispatch intent because the intent key contains the
 * generation. Recovery and voluntary release are therefore the same path.
 */
export async function releaseBin(proof: BinProof, reason?: string | null): Promise<BinLeaseOutcome> {
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins
        SET state = 'READY', lease_generation = lease_generation + 1,
            lease_id = NULL, worker_id = NULL, lease_credential_id = NULL,
            leased_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
            ready_at = ?, updated_at = ?
      WHERE ${ownershipClause()}`,
    [now, now, ...ownershipParams(proof, now)],
  );
  if (result.changes !== 1) return 'NOT_OWNER';
  await recordBinEvent({
    eventType: 'BIN_RELEASED',
    binId: proof.binId,
    workerId: proof.workerId,
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    outcome: 'RELEASED',
    reason: reason ?? null,
  });
  return 'OK';
}

/**
 * Finish a bin, in whichever terminal state the *contract* decided.
 *
 * Never called because a worker said it was done. The only caller is the
 * completion service, after its contract evaluated true against durable rows.
 */
export async function finishBin(
  proof: BinProof,
  input: { state: Extract<BinState, 'COMPLETE' | 'FAILED' | 'NEEDS_HUMAN'>; reason: string },
): Promise<BinLeaseOutcome> {
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins
        SET state = ?, lease_generation = lease_generation + 1,
            lease_id = NULL, worker_id = NULL, lease_credential_id = NULL,
            leased_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
            terminal_reason = ?, completed_at = ?, updated_at = ?
      WHERE ${ownershipClause()}`,
    [input.state, bounded(input.reason, MAX_REASON_CHARS), now, now, ...ownershipParams(proof, now)],
  );
  if (result.changes !== 1) return 'NOT_OWNER';
  await recordBinEvent({
    eventType: 'BIN_TERMINAL',
    binId: proof.binId,
    workerId: proof.workerId,
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    outcome: input.state,
    reason: input.reason,
  });
  return 'OK';
}

/**
 * A completion the contract refused.
 *
 * The bin stays leased and the worker keeps working; what changes is that the
 * reason is written down and counted. A verdict nobody can trace is not
 * auditable, and a worker that asks to finish four times without the records
 * changing is a fact worth having.
 */
export async function recordBinRefusal(proof: BinProof, reason: string): Promise<BinLeaseOutcome> {
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins SET last_refusal = ?, refusal_count = refusal_count + 1, updated_at = ?
      WHERE ${ownershipClause()}`,
    [bounded(reason, MAX_REASON_CHARS), now, ...ownershipParams(proof, now)],
  );
  if (result.changes !== 1) return 'NOT_OWNER';
  await recordBinEvent({
    eventType: 'BIN_COMPLETION_REFUSED',
    binId: proof.binId,
    workerId: proof.workerId,
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    outcome: 'REFUSED',
    reason,
  });
  return 'OK';
}

/**
 * Terminalize a bin nobody currently holds.
 *
 * For the reconciliation pass, which decides what to do with a bin that is
 * nonterminal, unleased and out of attempts. Guarded on the generation so it
 * cannot race an assignment that happened a moment ago.
 */
export async function terminateUnleasedBin(
  binId: string,
  leaseGeneration: number,
  state: Extract<BinState, 'FAILED' | 'NEEDS_HUMAN' | 'CANCELLED'>,
  reason: string,
): Promise<boolean> {
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins SET state = ?, terminal_reason = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_generation = ? AND state IN ('READY', 'DRAFT')`,
    [state, bounded(reason, MAX_REASON_CHARS), now, now, binId, leaseGeneration],
  );
  if (result.changes !== 1) return false;
  await recordBinEvent({
    eventType: 'BIN_TERMINAL',
    binId,
    leaseGeneration,
    outcome: state,
    reason,
  });
  return true;
}

/**
 * Expired leases, for metrics.
 *
 * Deliberately not load-bearing: an expired lease is already claimable work, so
 * deleting this function changes nothing about recovery. It exists so that a
 * report can say how often it happened.
 */
/**
 * A person has decided what happens to a bin that asked for one.
 *
 * Deliberately not folded into `terminateUnleasedBin`. That function matches
 * only READY or DRAFT, and that narrowness is what makes it safe to point at a
 * list — it cannot take a bin a worker is holding, and it cannot rewrite one
 * that finished. Adding NEEDS_HUMAN to its match would widen every existing
 * caller to reach a state none of them mean to touch.
 *
 * So this is its own statement, guarded the same way and matching exactly the
 * one state that means "waiting for a human": the bin keeps its events, its
 * unit results and its whole failure history, and gains a terminal reason
 * saying who ended it and why. Escalation is not erased by being answered.
 */
export async function resolveNeedsHumanBin(
  binId: string,
  leaseGeneration: number,
  state: Extract<BinState, 'CANCELLED' | 'FAILED'>,
  reason: string,
): Promise<boolean> {
  const now = binNow();
  const result = await getDb().run(
    `UPDATE bins SET state = ?, terminal_reason = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_generation = ? AND state = 'NEEDS_HUMAN'`,
    [state, bounded(reason, MAX_REASON_CHARS), now, now, binId, leaseGeneration],
  );
  if (result.changes !== 1) return false;
  await recordBinEvent({
    eventType: 'BIN_TERMINAL',
    binId,
    leaseGeneration,
    outcome: state,
    reason,
  });
  return true;
}

export async function sweepExpiredBinLeases(): Promise<number> {
  const now = binNow();
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins WHERE state = 'LEASED' AND lease_expires_at <= ?`,
    [now],
  );
  for (const row of rows) {
    await recordBinEvent({
      eventType: 'BIN_LEASE_EXPIRED',
      binId: row.id,
      projectId: row.project_id,
      workerId: row.worker_id,
      leaseId: row.lease_id,
      leaseGeneration: row.lease_generation,
      attempt: row.attempt_count,
      outcome: 'EXPIRED',
    });
  }
  return rows.length;
}

/* ------------------------------------------------------------------------- */
/* Unit results                                                               */
/* ------------------------------------------------------------------------- */

export interface PutUnitResultInput {
  binId: string;
  unitKey: string;
  workItemId?: string | null;
  value: string;
  contentHash: string;
  leaseId: string | null;
  leaseGeneration: number | null;
  submittedBy?: string | null;
}

/**
 * Store one unit's answer, once.
 *
 * `UNIQUE (bin_id, unit_key)` and `ON CONFLICT DO NOTHING`: a redelivered
 * submission collides with the row it already wrote rather than producing a
 * second, which is the Step 6 shape applied to the smallest possible effect.
 * Returns whether this call was the one that inserted.
 */
export interface PutUnitResultOutcome {
  stored: boolean;
  corrected: boolean;
  previousHash: string | null;
}

/**
 * Store a unit's answer, or correct one already stored.
 *
 * Originally this was `ON CONFLICT DO NOTHING`, on the reasoning that a stored
 * result is a record and records are not overwritten. Production disagreed in
 * the most direct way available: a worker submitted a truncated sha-256 for one
 * unit, Brain correctly refused the bin's completion three times, and the
 * worker could not fix it — every correction came back DUPLICATE. It released
 * the bin saying so, exhausted its attempts, and the bin was permanently dead
 * from one transcription slip.
 *
 * First-write-wins is the wrong rule here, and the reason it is safe to change
 * is the same reason the refusal worked: **Brain recomputes the value itself.**
 * A correction cannot launder a wrong answer past the contract — it only lets a
 * worker try again at the thing Brain will check anyway. Refusing corrections
 * does not buy integrity; it only converts a recoverable mistake into a dead
 * bin.
 *
 * §17 — no new evidence silently overwriting old evidence — is honoured by the
 * word *silently*: the replaced content hash is returned and written into the
 * append-only `bin_events` row, so every value a unit ever held stays in the
 * history even though only the current one is in this table.
 *
 * A correction is refused once the bin is no longer leased by the caller, so a
 * completed bin's results are immutable and a worker that lost its lease cannot
 * rewrite the winner's work. That proof lives inside both statements rather
 * than in a check before them — the ownership the caller last saw is carried in
 * the clause, so there is no read-then-write window for a race to live in.
 */
export async function putBinUnitResult(
  input: PutUnitResultInput,
): Promise<PutUnitResultOutcome> {
  const db = getDb();
  const at = binNow();
  const value = input.value.slice(0, MAX_UNIT_VALUE_CHARS);

  const inserted = await db.run(
    `INSERT INTO bin_unit_results (id, bin_id, unit_key, work_item_id, value, content_hash,
       lease_id, lease_generation, submitted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (bin_id, unit_key) DO NOTHING`,
    [
      newId('bur'),
      input.binId,
      input.unitKey,
      input.workItemId ?? null,
      value,
      input.contentHash,
      input.leaseId,
      input.leaseGeneration,
      input.submittedBy ?? null,
      at,
    ],
  );
  if (inserted.changes === 1) return { stored: true, corrected: false, previousHash: null };

  // Something is already there. Read what it was, so the event can say what the
  // correction replaced, then swap it under the caller's own lease.
  const existing = await db.get<BinUnitResultRow>(
    `SELECT * FROM bin_unit_results WHERE bin_id = ? AND unit_key = ?`,
    [input.binId, input.unitKey],
  );
  if (!existing) return { stored: false, corrected: false, previousHash: null };
  if (existing.content_hash === input.contentHash) {
    return { stored: false, corrected: false, previousHash: existing.content_hash };
  }

  const updated = await db.run(
    `UPDATE bin_unit_results
        SET value = ?, content_hash = ?, work_item_id = ?,
            lease_id = ?, lease_generation = ?, submitted_by = ?, created_at = ?
      WHERE bin_id = ? AND unit_key = ? AND content_hash = ?
        AND EXISTS (
          SELECT 1 FROM bins b
           WHERE b.id = bin_unit_results.bin_id
             AND b.state = 'LEASED'
             AND b.lease_id = ?
             AND b.lease_generation = ?
             AND b.worker_id = ?
             AND b.lease_expires_at > ?
        )`,
    [
      value,
      input.contentHash,
      input.workItemId ?? null,
      input.leaseId,
      input.leaseGeneration,
      input.submittedBy ?? null,
      at,
      input.binId,
      input.unitKey,
      existing.content_hash,
      input.leaseId,
      input.leaseGeneration,
      input.submittedBy ?? null,
      at,
    ],
  );
  if (updated.changes !== 1) {
    return { stored: false, corrected: false, previousHash: existing.content_hash };
  }
  return { stored: true, corrected: true, previousHash: existing.content_hash };
}

export async function listBinUnitResults(binId: string): Promise<BinUnitResult[]> {
  const rows = await getDb().all<BinUnitResultRow>(
    `SELECT * FROM bin_unit_results WHERE bin_id = ? ORDER BY unit_key`,
    [binId],
  );
  return rows.map(mapBinUnitResult);
}

/* ------------------------------------------------------------------------- */
/* Dispatch intent                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Record that this bin, at this generation, deserves a worker.
 *
 * `ON CONFLICT DO NOTHING` on `(bin_id, lease_generation)` is the whole
 * idempotency story. While a bin sits READY at generation 4, every dispatcher
 * tick attempts this insert and every one after the first does nothing. When a
 * lease expires the generation advances and the bin legitimately earns a fresh
 * intent — recovery expressed by the same key rather than by a special path.
 *
 * Returns true when this call created the intent.
 */
export async function ensureDispatchIntent(bin: Bin): Promise<boolean> {
  const at = binNow();
  const result = await getDb().run(
    `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
       next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)
     ON CONFLICT (bin_id, lease_generation) DO NOTHING`,
    [newId('bdp'), bin.id, bin.leaseGeneration, 5, at, at, at],
  );
  if (result.changes === 1) {
    await recordBinEvent({
      eventType: 'DISPATCH_INTENT',
      binId: bin.id,
      projectId: bin.projectId,
      leaseGeneration: bin.leaseGeneration,
      outcome: 'PENDING',
    });
  }
  return result.changes === 1;
}

export async function getDispatch(id: string): Promise<BinDispatch | null> {
  const row = await getDb().get<BinDispatchRow>(`SELECT * FROM bin_dispatch WHERE id = ?`, [id]);
  return row ? mapBinDispatch(row) : null;
}

export async function listDispatchesForBin(binId: string): Promise<BinDispatch[]> {
  const rows = await getDb().all<BinDispatchRow>(
    `SELECT * FROM bin_dispatch WHERE bin_id = ? ORDER BY lease_generation, rowid`,
    [binId],
  );
  return rows.map(mapBinDispatch);
}

/**
 * How long a tick may hold an intent while it makes the HTTP call.
 *
 * Doubles as the recovery bound: a SENDING intent older than this is claimable
 * again, so a dispatcher that died mid-call strands nothing. Comfortably longer
 * than the fire request's own 20-second timeout.
 */
export const DISPATCH_CLAIM_MS = 120_000;

/**
 * Take one sendable intent, atomically.
 *
 * The swap is `state = 'PENDING'` → `'SENDING'`, and the *old* value is what
 * makes it safe: both racing ticks name `PENDING` in their `WHERE` regardless
 * of what either of them read, so exactly one matches.
 *
 * This was originally a swap on `attempt_count`, which looked equivalent and is
 * not. Two ticks that read at different moments read *different* counts, and
 * each one's `WHERE attempt_count = <what I read>` then matches its own read —
 * so both claimed the same intent and both fired. SQLite never showed it,
 * because its writers serialise and both reads happened before either write.
 * Postgres, with genuinely concurrent connections, failed it on the first run.
 * The lesson is the one the queue already documents: a compare-and-swap has to
 * be on a value the claimant does not supply.
 *
 * A stuck SENDING intent is reclaimed the same way an expired lease is — by
 * being a candidate again once its deadline passes — so recovery needs no
 * sweeper and no process staying alive.
 */
export async function claimDispatchIntent(): Promise<BinDispatch | null> {
  const db = getDb();
  const now = binNow();
  const deadline = plusMs(now, DISPATCH_CLAIM_MS);
  const candidates = await db.all<BinDispatchRow>(
    `SELECT * FROM bin_dispatch
      WHERE (state = 'PENDING' OR state = 'SENDING') AND next_attempt_at <= ?
      ORDER BY next_attempt_at, rowid LIMIT 10`,
    [now],
  );
  for (const row of candidates) {
    const result = await db.run(
      `UPDATE bin_dispatch
          SET state = 'SENDING', attempt_count = attempt_count + 1,
              next_attempt_at = ?, updated_at = ?
        WHERE id = ?
          AND ((state = 'PENDING' AND next_attempt_at <= ?)
            OR (state = 'SENDING' AND next_attempt_at <= ?))`,
      [deadline, now, row.id, now, now],
    );
    if (result.changes === 1) {
      const claimed = await getDispatch(row.id);
      if (claimed) return claimed;
    }
  }
  return null;
}

/**
 * Record which registered Routine a dispatch is going to.
 *
 * Written after routing and before firing, so a dispatch that fails still says
 * where it was aimed. `routine_ref` already held the provider's trigger id;
 * this holds the row, so a capacity report joins to the account without parsing
 * strings out of a text column.
 */
export async function markDispatchRoutine(id: string, routineId: string): Promise<void> {
  await getDb().run(
    'UPDATE bin_dispatch SET routine_id = ?, updated_at = ? WHERE id = ?',
    [routineId, binNow(), id],
  );
}

export async function markDispatchSent(
  id: string,
  input: { routineRef: string; routineVersion?: string | null; sessionRef?: string | null; fireEventId?: string | null },
): Promise<void> {
  const at = binNow();
  await getDb().run(
    `UPDATE bin_dispatch SET state = 'SENT', routine_ref = ?, routine_version = ?,
       session_ref = ?, fire_event_id = ?, sent_at = ?, updated_at = ? WHERE id = ?`,
    [
      input.routineRef,
      input.routineVersion ?? null,
      bounded(input.sessionRef, 200),
      bounded(input.fireEventId, 200),
      at,
      at,
      id,
    ],
  );
  const dispatch = await getDispatch(id);
  await recordBinEvent({
    eventType: 'DISPATCH_SENT',
    binId: dispatch?.binId ?? null,
    leaseGeneration: dispatch?.leaseGeneration ?? null,
    routineRef: input.routineRef,
    routineVersion: input.routineVersion ?? null,
    sessionRef: input.sessionRef ?? null,
    fireEventId: input.fireEventId ?? null,
    provider: 'claude-routine',
    attempt: dispatch?.attemptCount ?? null,
    outcome: 'SENT',
  });
}

/** Bounded exponential backoff, so a provider outage cannot spin the loop. */
export function dispatchBackoffMs(attemptCount: number): number {
  const base = 5_000;
  const capped = Math.min(attemptCount, 8);
  return Math.min(10 * 60_000, base * 2 ** Math.max(0, capped - 1));
}

export async function markDispatchFailed(
  id: string,
  input: { kind: string; message: string; retryAfterMs?: number | null },
): Promise<BinDispatchState> {
  const at = binNow();
  const current = await getDispatch(id);
  if (!current) return 'ABANDONED';
  const exhausted = current.attemptCount >= current.maxAttempts;
  const delay = input.retryAfterMs ?? dispatchBackoffMs(current.attemptCount);
  const next = plusMs(at, delay);
  const state: BinDispatchState = exhausted ? 'ABANDONED' : 'PENDING';
  await getDb().run(
    `UPDATE bin_dispatch SET state = ?, next_attempt_at = ?, last_error_kind = ?,
       last_error = ?, updated_at = ? WHERE id = ?`,
    [state, next, bounded(input.kind, 80), bounded(input.message, 500), at, id],
  );
  await recordBinEvent({
    eventType: exhausted ? 'DISPATCH_ABANDONED' : 'DISPATCH_RETRY',
    binId: current.binId,
    leaseGeneration: current.leaseGeneration,
    attempt: current.attemptCount,
    provider: 'claude-routine',
    outcome: state,
    reason: `${input.kind}: ${input.message}`,
    measures: { backoffMs: delay },
  });
  return state;
}

/**
 * Retire intents for bins that have moved on.
 *
 * A bin that was leased, completed or cancelled while an intent sat pending no
 * longer needs a worker. Sending anyway would only burn an activation, so the
 * intent is marked rather than fired — and marked rather than deleted, because
 * "we decided not to send this" is a fact Step 11 will want.
 */
export async function supersedeStaleIntents(): Promise<number> {
  const at = binNow();
  const result = await getDb().run(
    `UPDATE bin_dispatch SET state = 'SUPERSEDED', updated_at = ?
      WHERE state = 'PENDING'
        AND bin_id IN (
          SELECT id FROM bins
           WHERE NOT ${DISPATCHABLE_SQL}
              OR lease_generation <> bin_dispatch.lease_generation
        )`,
    [at, at],
  );
  return result.changes;
}

export async function countDispatches(binId: string, state: BinDispatchState): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_dispatch WHERE bin_id = ? AND state = ?`,
    [binId, state],
  );
  return Number(row?.n ?? 0);
}
