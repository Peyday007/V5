/**
 * The factory's fleet, its judgements and its ledger.
 *
 * Split from `repos/factory.ts` for the reason the factory itself enforces on
 * its workers: a file two lanes need to change at once is a file they collide
 * in. The state machine is there; who ran it, what they found and what it cost
 * is here.
 *
 * Three properties to keep while editing this file:
 *
 *   * **A row never holds a credential.** `factory_workers` holds the *name* of
 *     a secret and a digest of its value taken once at registration. Nothing
 *     recovers the value, including an administrator, and no projection that
 *     reads these rows can leak one.
 *
 *   * **Adding a worker is an INSERT.** `kind` selects an executor that already
 *     exists; a kind nothing implements is refused at registration rather than
 *     discovered at dispatch. There is no factory code change in the path of
 *     scaling the fleet.
 *
 *   * **`factory_events` is the only ledger.** Every throughput, concurrency
 *     and timing number the factory reports is counted from it. A second table
 *     that had to agree with it would be the one nobody reads and the one that
 *     drifts — §23 paid for that lesson once already.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  FactoryArtifact,
  FactoryArtifactKind,
  FactoryArtifactRow,
  FactoryCapability,
  FactoryEvent,
  FactoryEventRow,
  FactoryEvidenceClass,
  FactoryFinding,
  FactoryFindingRow,
  FactoryFindingSeverity,
  FactoryFindingState,
  FactoryIndependenceTier,
  FactoryIntegration,
  FactoryIntegrationOutcome,
  FactoryIntegrationRow,
  FactoryModelClass,
  FactoryRelease,
  FactoryReleaseDecision,
  FactoryReleaseKind,
  FactoryReleaseRow,
  FactoryReview,
  FactoryReviewRow,
  FactoryReviewVerdict,
  FactoryRole,
  FactorySession,
  FactorySessionRow,
  FactorySessionState,
  FactoryUsage,
  FactoryVerificationResult,
  FactoryWorker,
  FactoryWorkerAvailability,
  FactoryWorkerKind,
  FactoryWorkerRow,
} from '../domain/factory.ts';
import { bound, factoryNow, plusMs } from './factory.ts';

/* ------------------------------------------------------------------------- */
/* Workers                                                                    */
/* ------------------------------------------------------------------------- */

export function mapWorker(row: FactoryWorkerRow): FactoryWorker {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as FactoryWorkerKind,
    accountRef: row.account_ref,
    model: row.model,
    modelClass: row.model_class as FactoryModelClass | 'EITHER',
    capabilities: parseJson<FactoryCapability[]>(row.capabilities, []),
    repositories: parseJson<string[]>(row.repositories, []),
    maxConcurrency: row.max_concurrency,
    availability: row.availability as FactoryWorkerAvailability,
    credentialRef: row.credential_ref,
    credentialDigest: row.credential_digest,
    brainWorkerId: row.brain_worker_id,
    rateLimitedUntil: row.rate_limited_until,
    consecutiveFailures: row.consecutive_failures,
    registeredByUserId: row.registered_by_user_id,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RegisterWorkerInput {
  name: string;
  kind: FactoryWorkerKind;
  accountRef: string;
  model: string;
  modelClass?: FactoryModelClass | 'EITHER';
  capabilities: FactoryCapability[];
  repositories: string[];
  maxConcurrency?: number;
  credentialRef?: string | null;
  /**
   * The credential's value, read once and never stored.
   *
   * Only its sha-256 reaches the row. A worker credential is shown at issue and
   * is not recoverable afterwards by anyone — §17, and the same reasoning makes
   * this parameter the only place a value appears.
   */
  credentialValue?: string | null;
  brainWorkerId?: string | null;
  registeredByUserId?: string | null;
}

export async function registerWorker(
  input: RegisterWorkerInput,
): Promise<{ worker: FactoryWorker; created: boolean }> {
  const db = getDb();
  const at = factoryNow();
  const id = newId('fwk');
  const digest = input.credentialValue
    ? createHash('sha256').update(input.credentialValue).digest('hex')
    : null;

  const result = await db.run(
    `INSERT INTO factory_workers (
       id, name, kind, account_ref, model, model_class, capabilities, repositories,
       max_concurrency, availability, credential_ref, credential_digest,
       brain_worker_id, rate_limited_until, consecutive_failures,
       registered_by_user_id, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, NULL, 0, ?, NULL, ?, ?)
     ON CONFLICT (name) DO NOTHING`,
    [
      id,
      input.name,
      input.kind,
      input.accountRef,
      input.model,
      input.modelClass ?? 'FAST',
      toJson(input.capabilities),
      toJson(input.repositories),
      input.maxConcurrency ?? 1,
      input.credentialRef ?? null,
      digest,
      input.brainWorkerId ?? null,
      input.registeredByUserId ?? null,
      at,
      at,
    ],
  );

  const row = await db.get<FactoryWorkerRow>(`SELECT * FROM factory_workers WHERE name = ?`, [
    input.name,
  ]);
  if (!row) throw new Error('factory: worker vanished immediately after insert');
  return { worker: mapWorker(row), created: result.changes === 1 };
}

export async function getWorker(id: string): Promise<FactoryWorker | null> {
  const row = await getDb().get<FactoryWorkerRow>(`SELECT * FROM factory_workers WHERE id = ?`, [
    id,
  ]);
  return row ? mapWorker(row) : null;
}

export async function getWorkerByName(name: string): Promise<FactoryWorker | null> {
  const row = await getDb().get<FactoryWorkerRow>(`SELECT * FROM factory_workers WHERE name = ?`, [
    name,
  ]);
  return row ? mapWorker(row) : null;
}

export async function listWorkers(): Promise<FactoryWorker[]> {
  const rows = await getDb().all<FactoryWorkerRow>(
    `SELECT * FROM factory_workers ORDER BY name`,
  );
  return rows.map(mapWorker);
}

export interface WorkerPatch {
  availability?: FactoryWorkerAvailability;
  maxConcurrency?: number;
  capabilities?: FactoryCapability[];
  repositories?: string[];
  model?: string;
  modelClass?: FactoryModelClass | 'EITHER';
  brainWorkerId?: string | null;
}

export async function patchWorker(id: string, patch: WorkerPatch): Promise<void> {
  const sets: string[] = [];
  const values: SqlParam[] = [];
  if (patch.availability !== undefined) {
    sets.push('availability = ?');
    values.push(patch.availability);
  }
  if (patch.maxConcurrency !== undefined) {
    sets.push('max_concurrency = ?');
    values.push(patch.maxConcurrency);
  }
  if (patch.capabilities !== undefined) {
    sets.push('capabilities = ?');
    values.push(toJson(patch.capabilities));
  }
  if (patch.repositories !== undefined) {
    sets.push('repositories = ?');
    values.push(toJson(patch.repositories));
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    values.push(patch.model);
  }
  if (patch.modelClass !== undefined) {
    sets.push('model_class = ?');
    values.push(patch.modelClass);
  }
  if (patch.brainWorkerId !== undefined) {
    sets.push('brain_worker_id = ?');
    values.push(patch.brainWorkerId);
  }
  if (sets.length === 0) return;
  await getDb().run(
    `UPDATE factory_workers SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    [...values, factoryNow(), id],
  );
}

/**
 * Provider backpressure: defer this worker and leave its failure streak alone.
 *
 * §23's sentence, which this file is the second place to need: a refusal is not
 * misconduct. An account at its ceiling is busy, and quarantining it for being
 * busy removes capacity exactly when the fleet is short of it.
 */
export async function recordWorkerRateLimit(
  id: string,
  retryAfterMs: number,
): Promise<string> {
  const at = factoryNow();
  const until = plusMs(at, Math.max(1000, retryAfterMs));
  await getDb().run(
    `UPDATE factory_workers SET rate_limited_until = ?, updated_at = ? WHERE id = ?`,
    [until, at, id],
  );
  return until;
}

/** A real failure. Three in a row quarantines, and a refusal never counts. */
export async function recordWorkerFailure(id: string): Promise<number> {
  const db = getDb();
  const at = factoryNow();
  await db.run(
    `UPDATE factory_workers
        SET consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?`,
    [at, id],
  );
  const row = await db.get<{ consecutive_failures: number }>(
    `SELECT consecutive_failures FROM factory_workers WHERE id = ?`,
    [id],
  );
  const streak = row?.consecutive_failures ?? 0;
  if (streak >= 3) {
    await db.run(
      `UPDATE factory_workers SET availability = 'QUARANTINED', updated_at = ? WHERE id = ?`,
      [at, id],
    );
  }
  return streak;
}

export async function recordWorkerSuccess(id: string): Promise<void> {
  const at = factoryNow();
  await getDb().run(
    `UPDATE factory_workers
        SET consecutive_failures = 0, last_seen_at = ?, rate_limited_until = NULL, updated_at = ?
      WHERE id = ?`,
    [at, at, id],
  );
}

/** How many sessions this worker has running right now, counted from rows. */
export async function workerLoad(): Promise<Map<string, number>> {
  const rows = await getDb().all<{ worker_id: string; running: number }>(
    `SELECT worker_id, COUNT(*) AS running FROM factory_sessions
      WHERE state = 'RUNNING' GROUP BY worker_id`,
  );
  return new Map(rows.map((r) => [r.worker_id, Number(r.running)]));
}

/* ------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* ------------------------------------------------------------------------- */

export function mapSession(row: FactorySessionRow): FactorySession {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    workerId: row.worker_id,
    accountRef: row.account_ref,
    attempt: row.attempt,
    role: row.role as FactoryRole,
    externalSessionId: row.external_session_id,
    model: row.model,
    state: row.state as FactorySessionState,
    exitReason: row.exit_reason,
    durationMs: row.duration_ms,
    numTurns: row.num_turns,
    usage: parseJson<FactoryUsage | null>(row.usage, null),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OpenSessionInput {
  campaignId: string;
  unitId: string | null;
  workerId: string;
  accountRef: string;
  attempt: number;
  role: FactoryRole;
  model: string;
}

export async function openSession(input: OpenSessionInput): Promise<FactorySession> {
  const db = getDb();
  const id = newId('fss');
  const at = factoryNow();
  await db.run(
    `INSERT INTO factory_sessions (
       id, campaign_id, unit_id, worker_id, account_ref, attempt, role,
       external_session_id, model, state, exit_reason, duration_ms, num_turns,
       usage, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'RUNNING', NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    [
      id,
      input.campaignId,
      input.unitId,
      input.workerId,
      input.accountRef,
      input.attempt,
      input.role,
      input.model,
      at,
      at,
      at,
    ],
  );
  const row = await db.get<FactorySessionRow>(`SELECT * FROM factory_sessions WHERE id = ?`, [id]);
  if (!row) throw new Error('factory: session vanished immediately after insert');
  return mapSession(row);
}

export interface CloseSessionInput {
  state: Exclude<FactorySessionState, 'RUNNING'>;
  exitReason?: string | null;
  externalSessionId?: string | null;
  durationMs?: number | null;
  numTurns?: number | null;
  usage?: FactoryUsage | null;
}

export async function closeSession(id: string, input: CloseSessionInput): Promise<void> {
  const at = factoryNow();
  await getDb().run(
    `UPDATE factory_sessions
        SET state = ?, exit_reason = ?, external_session_id = COALESCE(?, external_session_id),
            duration_ms = ?, num_turns = ?, usage = ?, ended_at = ?, updated_at = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [
      input.state,
      bound(input.exitReason ?? null),
      input.externalSessionId ?? null,
      input.durationMs ?? null,
      input.numTurns ?? null,
      input.usage ? toJson(input.usage) : null,
      at,
      at,
      id,
    ],
  );
}

export async function getSession(id: string): Promise<FactorySession | null> {
  const row = await getDb().get<FactorySessionRow>(`SELECT * FROM factory_sessions WHERE id = ?`, [
    id,
  ]);
  return row ? mapSession(row) : null;
}

export async function listSessions(campaignId: string): Promise<FactorySession[]> {
  const rows = await getDb().all<FactorySessionRow>(
    `SELECT * FROM factory_sessions WHERE campaign_id = ? ORDER BY started_at, rowid`,
    [campaignId],
  );
  return rows.map(mapSession);
}

export async function sessionsForUnit(unitId: string): Promise<FactorySession[]> {
  const rows = await getDb().all<FactorySessionRow>(
    `SELECT * FROM factory_sessions WHERE unit_id = ? ORDER BY started_at, rowid`,
    [unitId],
  );
  return rows.map(mapSession);
}

/**
 * Sessions that have already done implementation work inside this campaign.
 *
 * The lineage a reviewer is judged against. Read from rows the server wrote
 * when it started each session, never from anything a worker says about itself.
 */
export async function implementingSessions(campaignId: string): Promise<FactorySession[]> {
  const rows = await getDb().all<FactorySessionRow>(
    `SELECT * FROM factory_sessions
      WHERE campaign_id = ? AND role IN ('IMPLEMENTER','ARCHITECT')
      ORDER BY started_at, rowid`,
    [campaignId],
  );
  return rows.map(mapSession);
}

/** Release a dead process's sessions, so a restart does not leave them RUNNING forever. */
export async function abandonStaleSessions(olderThanIso: string): Promise<number> {
  const at = factoryNow();
  const result = await getDb().run(
    `UPDATE factory_sessions
        SET state = 'ABANDONED', exit_reason = 'No heartbeat; reclaimed on recovery.',
            ended_at = ?, updated_at = ?
      WHERE state = 'RUNNING' AND started_at <= ?`,
    [at, at, olderThanIso],
  );
  return result.changes;
}

/* ------------------------------------------------------------------------- */
/* Reviews and findings                                                       */
/* ------------------------------------------------------------------------- */

export function mapReview(row: FactoryReviewRow): FactoryReview {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    round: row.round,
    scope: row.scope as 'CAMPAIGN' | 'UNIT',
    unitId: row.unit_id,
    reviewerSessionId: row.reviewer_session_id,
    reviewedSha: row.reviewed_sha,
    verdict: row.verdict as FactoryReviewVerdict,
    summary: row.summary,
    independence: row.independence as FactoryIndependenceTier,
    createdAt: row.created_at,
  };
}

export function mapFinding(row: FactoryFindingRow): FactoryFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    campaignId: row.campaign_id,
    findingKey: row.finding_key,
    severity: row.severity as FactoryFindingSeverity,
    category: row.category,
    statement: row.statement,
    evidence: row.evidence,
    acceptanceConditionId: row.acceptance_condition_id,
    state: row.state as FactoryFindingState,
    repairUnitId: row.repair_unit_id,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RecordReviewInput {
  campaignId: string;
  round: number;
  scope: 'CAMPAIGN' | 'UNIT';
  unitId?: string | null;
  reviewerSessionId: string | null;
  reviewedSha: string;
  verdict: FactoryReviewVerdict;
  summary: string;
  independence: FactoryIndependenceTier;
  findings: {
    key: string;
    severity: FactoryFindingSeverity;
    category: string;
    statement: string;
    evidence: string;
    acceptanceConditionId?: string | null;
  }[];
}

/**
 * Store a review and its findings in one transaction.
 *
 * A review whose findings were written separately could be read, acted on and
 * closed while half of what it found was still in flight. Both or neither.
 */
export async function recordReview(
  input: RecordReviewInput,
): Promise<{ review: FactoryReview; findings: FactoryFinding[] }> {
  const db = getDb();
  return await db.transaction(async () => {
    const id = newId('frv');
    const at = factoryNow();
    await db.run(
      `INSERT INTO factory_reviews (
         id, campaign_id, round, scope, unit_id, reviewer_session_id, reviewed_sha,
         verdict, summary, independence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.campaignId,
        input.round,
        input.scope,
        input.unitId ?? null,
        input.reviewerSessionId,
        input.reviewedSha,
        input.verdict,
        bound(input.summary) ?? '',
        input.independence,
        at,
      ],
    );

    const findings: FactoryFinding[] = [];
    for (const finding of input.findings) {
      const findingId = newId('ffd');
      await db.run(
        `INSERT INTO factory_findings (
           id, review_id, campaign_id, finding_key, severity, category, statement,
           evidence, acceptance_condition_id, state, repair_unit_id, resolution,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?, ?)
         ON CONFLICT (review_id, finding_key) DO NOTHING`,
        [
          findingId,
          id,
          input.campaignId,
          finding.key,
          finding.severity,
          finding.category,
          bound(finding.statement) ?? '',
          bound(finding.evidence) ?? '',
          finding.acceptanceConditionId ?? null,
          at,
          at,
        ],
      );
      const row = await db.get<FactoryFindingRow>(
        `SELECT * FROM factory_findings WHERE review_id = ? AND finding_key = ?`,
        [id, finding.key],
      );
      if (row) findings.push(mapFinding(row));
    }

    const reviewRow = await db.get<FactoryReviewRow>(`SELECT * FROM factory_reviews WHERE id = ?`, [
      id,
    ]);
    if (!reviewRow) throw new Error('factory: review vanished immediately after insert');
    return { review: mapReview(reviewRow), findings };
  });
}

export async function listReviews(campaignId: string): Promise<FactoryReview[]> {
  const rows = await getDb().all<FactoryReviewRow>(
    `SELECT * FROM factory_reviews WHERE campaign_id = ? ORDER BY round, created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapReview);
}

export async function listFindings(campaignId: string): Promise<FactoryFinding[]> {
  const rows = await getDb().all<FactoryFindingRow>(
    `SELECT * FROM factory_findings WHERE campaign_id = ? ORDER BY created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapFinding);
}

export async function listOpenFindings(campaignId: string): Promise<FactoryFinding[]> {
  const rows = await getDb().all<FactoryFindingRow>(
    `SELECT * FROM factory_findings
      WHERE campaign_id = ? AND state = 'OPEN' ORDER BY created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapFinding);
}

/**
 * Attach a repair unit to a finding, exactly once.
 *
 * Guarded on `state = 'OPEN'` and a null repair unit, so a tick that runs twice
 * over the same finding does not queue two repairs for one defect.
 */
export async function attachRepair(findingId: string, repairUnitId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_findings
        SET state = 'REPAIR_QUEUED', repair_unit_id = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN' AND repair_unit_id IS NULL`,
    [repairUnitId, factoryNow(), findingId],
  );
  return result.changes === 1;
}

export async function resolveFinding(
  findingId: string,
  state: Extract<FactoryFindingState, 'REPAIRED' | 'REJECTED' | 'ACCEPTED_LIMITATION'>,
  resolution: string,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_findings
        SET state = ?, resolution = ?, updated_at = ?
      WHERE id = ? AND state IN ('OPEN','REPAIR_QUEUED')`,
    [state, bound(resolution), factoryNow(), findingId],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Integrations                                                               */
/* ------------------------------------------------------------------------- */

export function mapIntegration(row: FactoryIntegrationRow): FactoryIntegration {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    attempt: row.attempt,
    outcome: row.outcome as FactoryIntegrationOutcome,
    reason: row.reason,
    rejectedPaths: parseJson<string[]>(row.rejected_paths, []),
    beforeSha: row.before_sha,
    afterSha: row.after_sha,
    verification: parseJson<FactoryVerificationResult[]>(row.verification, []),
    integratorSessionId: row.integrator_session_id,
    createdAt: row.created_at,
  };
}

export interface RecordIntegrationInput {
  campaignId: string;
  unitId: string;
  attempt: number;
  outcome: FactoryIntegrationOutcome;
  reason: string;
  rejectedPaths?: string[];
  beforeSha: string;
  afterSha?: string | null;
  verification?: FactoryVerificationResult[];
  integratorSessionId?: string | null;
}

export async function recordIntegration(
  input: RecordIntegrationInput,
): Promise<FactoryIntegration> {
  const db = getDb();
  const id = newId('fig');
  await db.run(
    `INSERT INTO factory_integrations (
       id, campaign_id, unit_id, attempt, outcome, reason, rejected_paths,
       before_sha, after_sha, verification, integrator_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (unit_id, attempt, outcome) DO NOTHING`,
    [
      id,
      input.campaignId,
      input.unitId,
      input.attempt,
      input.outcome,
      bound(input.reason) ?? '',
      toJson(input.rejectedPaths ?? []),
      input.beforeSha,
      input.afterSha ?? null,
      toJson(input.verification ?? []),
      input.integratorSessionId ?? null,
      factoryNow(),
    ],
  );
  const row = await db.get<FactoryIntegrationRow>(
    `SELECT * FROM factory_integrations
      WHERE unit_id = ? AND attempt = ? AND outcome = ?`,
    [input.unitId, input.attempt, input.outcome],
  );
  if (!row) throw new Error('factory: integration vanished immediately after insert');
  return mapIntegration(row);
}

export async function listIntegrations(campaignId: string): Promise<FactoryIntegration[]> {
  const rows = await getDb().all<FactoryIntegrationRow>(
    `SELECT * FROM factory_integrations WHERE campaign_id = ? ORDER BY created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapIntegration);
}

/* ------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* ------------------------------------------------------------------------- */

export function mapEvent(row: FactoryEventRow): FactoryEvent {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    workerId: row.worker_id,
    sessionId: row.session_id,
    accountRef: row.account_ref,
    kind: row.kind,
    phase: row.phase,
    durationMs: row.duration_ms,
    evidenceClass: row.evidence_class as FactoryEvidenceClass,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    at: row.at,
  };
}

export interface FactoryEventInput {
  campaignId?: string | null;
  unitId?: string | null;
  workerId?: string | null;
  sessionId?: string | null;
  accountRef?: string | null;
  kind: string;
  phase?: string | null;
  durationMs?: number | null;
  evidenceClass?: FactoryEvidenceClass;
  detail?: Record<string, unknown>;
}

/**
 * Append one row to the ledger.
 *
 * Every attribution column is filled by the caller that has the facts, because
 * §23's defect was a row the ledger counted as an activation being written
 * where the account, the Routine and the class were not in scope. A column
 * nothing can read is not a ledger entry.
 */
export async function recordFactoryEvent(input: FactoryEventInput): Promise<FactoryEvent> {
  const db = getDb();
  const id = newId('fev');
  const at = nowIso();
  await db.run(
    `INSERT INTO factory_events (
       id, campaign_id, unit_id, worker_id, session_id, account_ref, kind, phase,
       duration_ms, evidence_class, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.campaignId ?? null,
      input.unitId ?? null,
      input.workerId ?? null,
      input.sessionId ?? null,
      input.accountRef ?? null,
      input.kind,
      input.phase ?? null,
      input.durationMs ?? null,
      input.evidenceClass ?? 'DERIVED',
      toJson(input.detail ?? {}),
      at,
    ],
  );
  const row = await db.get<FactoryEventRow>(`SELECT * FROM factory_events WHERE id = ?`, [id]);
  if (!row) throw new Error('factory: event vanished immediately after insert');
  return mapEvent(row);
}

export async function listFactoryEvents(
  campaignId: string,
  options: { kinds?: string[]; limit?: number } = {},
): Promise<FactoryEvent[]> {
  const params: SqlParam[] = [campaignId];
  let clause = '';
  if (options.kinds && options.kinds.length > 0) {
    clause = ` AND kind IN (${options.kinds.map(() => '?').join(', ')})`;
    params.push(...options.kinds);
  }
  const limit = Math.max(1, Math.min(5000, options.limit ?? 2000));
  const rows = await getDb().all<FactoryEventRow>(
    `SELECT * FROM factory_events WHERE campaign_id = ?${clause}
      ORDER BY at, rowid LIMIT ${limit}`,
    params,
  );
  return rows.map(mapEvent);
}

/* ------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* ------------------------------------------------------------------------- */

export function mapArtifact(row: FactoryArtifactRow): FactoryArtifact {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    sessionId: row.session_id,
    kind: row.kind as FactoryArtifactKind,
    sha256: row.sha256,
    byteSize: row.byte_size,
    storageKey: row.storage_key,
    inlineText: row.inline_text,
    createdAt: row.created_at,
  };
}

export interface PutArtifactInput {
  campaignId: string;
  unitId?: string | null;
  sessionId?: string | null;
  kind: FactoryArtifactKind;
  /** The bytes, hashed here. Large content belongs in the store, not in this row. */
  text: string;
  /** A key the storage layer produced. Never a path built by hand. */
  storageKey?: string | null;
  /**
   * How much text to keep on the row.
   *
   * Generous, because the alternative turned out to be worse than large rows: a
   * worker log over the old limit was recorded with its hash, its size and its
   * content *nowhere* — a row that says evidence existed and cannot produce it.
   * Over the limit the tail is kept, with a marker, because the end of a worker's
   * run is where its reply and its reason are.
   */
  inlineLimit?: number;
}

/**
 * Record an artifact once, by content.
 *
 * The UNIQUE index on `(campaign_id, kind, sha256)` is the deduplication: the
 * same worker log written twice is one row, which is what keeps a repair loop
 * from filling the table with copies of the same failure.
 */
export async function putArtifact(input: PutArtifactInput): Promise<FactoryArtifact> {
  const db = getDb();
  const sha256 = createHash('sha256').update(input.text).digest('hex');
  const byteSize = Buffer.byteLength(input.text, 'utf8');
  const inlineLimit = input.inlineLimit ?? 256 * 1024;
  const inline =
    byteSize <= inlineLimit
      ? input.text
      : `[the first ${byteSize - inlineLimit} bytes are omitted; the tail is kept]\n${input.text.slice(-inlineLimit)}`;
  const id = newId('fat');
  await db.run(
    `INSERT INTO factory_artifacts (
       id, campaign_id, unit_id, session_id, kind, sha256, byte_size, storage_key,
       inline_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (campaign_id, kind, sha256) DO NOTHING`,
    [
      id,
      input.campaignId,
      input.unitId ?? null,
      input.sessionId ?? null,
      input.kind,
      sha256,
      byteSize,
      input.storageKey ?? null,
      inline,
      factoryNow(),
    ],
  );
  const row = await db.get<FactoryArtifactRow>(
    `SELECT * FROM factory_artifacts WHERE campaign_id = ? AND kind = ? AND sha256 = ?`,
    [input.campaignId, input.kind, sha256],
  );
  if (!row) throw new Error('factory: artifact vanished immediately after insert');
  return mapArtifact(row);
}

export async function listArtifacts(campaignId: string): Promise<FactoryArtifact[]> {
  const rows = await getDb().all<FactoryArtifactRow>(
    `SELECT * FROM factory_artifacts WHERE campaign_id = ? ORDER BY created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapArtifact);
}

/* ------------------------------------------------------------------------- */
/* Releases                                                                   */
/* ------------------------------------------------------------------------- */

export function mapRelease(row: FactoryReleaseRow): FactoryRelease {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    kind: row.kind as FactoryReleaseKind,
    decision: row.decision as FactoryReleaseDecision,
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
    decidedByUserId: row.decided_by_user_id,
    decidedReason: row.decided_reason,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ask a person for the release, once per campaign and kind.
 *
 * An unanswered request is `REQUESTED` and nothing about that state lets the
 * factory proceed: this is the human boundary the assignment keeps, expressed
 * as a row with a guarded answer rather than as a sentence in a prompt.
 */
export async function requestRelease(
  campaignId: string,
  kind: FactoryReleaseKind,
  evidence: Record<string, unknown>,
): Promise<FactoryRelease> {
  const db = getDb();
  const existing = await db.get<FactoryReleaseRow>(
    `SELECT * FROM factory_releases WHERE campaign_id = ? AND kind = ?`,
    [campaignId, kind],
  );
  if (existing) return mapRelease(existing);
  const id = newId('frl');
  const at = factoryNow();
  await db.run(
    `INSERT INTO factory_releases (
       id, campaign_id, kind, decision, evidence, decided_by_user_id,
       decided_reason, decided_at, created_at, updated_at)
     VALUES (?, ?, ?, 'REQUESTED', ?, NULL, NULL, NULL, ?, ?)`,
    [id, campaignId, kind, toJson(evidence), at, at],
  );
  const row = await db.get<FactoryReleaseRow>(`SELECT * FROM factory_releases WHERE id = ?`, [id]);
  if (!row) throw new Error('factory: release vanished immediately after insert');
  return mapRelease(row);
}

/**
 * A person answers. Guarded on `REQUESTED`, so an answer lands exactly once and
 * a second press changes nothing rather than re-stamping somebody else's.
 */
export async function answerRelease(
  releaseId: string,
  decision: Extract<FactoryReleaseDecision, 'APPROVED' | 'REFUSED'>,
  userId: string,
  reason: string,
): Promise<boolean> {
  const at = factoryNow();
  const result = await getDb().run(
    `UPDATE factory_releases
        SET decision = ?, decided_by_user_id = ?, decided_reason = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND decision = 'REQUESTED'`,
    [decision, userId, bound(reason), at, at, releaseId],
  );
  return result.changes === 1;
}

export async function getRelease(
  campaignId: string,
  kind: FactoryReleaseKind,
): Promise<FactoryRelease | null> {
  const row = await getDb().get<FactoryReleaseRow>(
    `SELECT * FROM factory_releases WHERE campaign_id = ? AND kind = ?`,
    [campaignId, kind],
  );
  return row ? mapRelease(row) : null;
}

export async function listReleases(campaignId: string): Promise<FactoryRelease[]> {
  const rows = await getDb().all<FactoryReleaseRow>(
    `SELECT * FROM factory_releases WHERE campaign_id = ? ORDER BY created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapRelease);
}
