/**
 * Data access for job bundles, quota pauses and the provider connection.
 *
 * A job's membership is a separate table on purpose: a bundled fragment keeps
 * its own claims, its own verdict and its own repair history, and only its
 * execution is shared. Reading a job tells you which fragments rode along; it
 * never merges what they found.
 */
import { getDb } from '../db/database.ts';
import type {
  JobKind,
  JobStatus,
  ProviderConnection,
  ProviderConnectionRow,
  ResearchJob,
  ResearchJobRow,
} from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

async function mapJob(row: ResearchJobRow): Promise<ResearchJob> {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    rationale: row.rationale,
    provider: row.provider,
    model: row.model,
    jobKind: row.job_kind as JobKind,
    status: row.status as JobStatus,
    priority: Number(row.priority),
    externalJobId: row.external_job_id,
    promptSha256: row.prompt_sha256,
    promptBytes: row.prompt_bytes === null ? null : Number(row.prompt_bytes),
    outputBytes: row.output_bytes === null ? null : Number(row.output_bytes),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    failureReason: row.failure_reason,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fragmentIds: (await getDb().all<{ fragment_id: string }>(
        'SELECT fragment_id FROM research_job_fragments WHERE job_id = ? ORDER BY ordinal',
        [row.id],
      ))
      .map((entry) => entry.fragment_id),
  };
}

export interface CreateJobInput {
  orchestrationId: string;
  projectId: string;
  rationale: string;
  provider: string;
  model?: string | null;
  jobKind?: JobKind;
  priority?: number;
  fragmentIds: string[];
}

export async function createJob(input: CreateJobInput): Promise<ResearchJob> {
  const db = getDb();
  const ts = nowIso();
  const id = newId('job');
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO research_jobs (id, orchestration_id, project_id, rationale, provider, model,
         job_kind, status, priority, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
      [id, input.orchestrationId, input.projectId, input.rationale, input.provider,
        input.model ?? null, input.jobKind ?? 'INVESTIGATION', input.priority ?? 5, ts, ts, ts],
    );
    for (const [ordinal, fragmentId] of input.fragmentIds.entries()) {
      await db.run(
        `INSERT INTO research_job_fragments (job_id, fragment_id, ordinal) VALUES (?, ?, ?)`,
        [id, fragmentId, ordinal],
      );
    }
  });
  return (await getJob(id))!;
}

export async function getJob(id: string): Promise<ResearchJob | null> {
  const row = await getDb().get<ResearchJobRow>('SELECT * FROM research_jobs WHERE id = ?', [id]);
  return row ? await mapJob(row) : null;
}

export async function listJobs(orchestrationId: string): Promise<ResearchJob[]> {
  const rows = await getDb().all<ResearchJobRow>(
    'SELECT * FROM research_jobs WHERE orchestration_id = ? ORDER BY priority, queued_at, rowid',
    [orchestrationId],
  );
  return await Promise.all(rows.map(mapJob));
}

/** The next job to run: highest priority, then oldest. */
export async function nextQueuedJob(orchestrationId: string): Promise<ResearchJob | null> {
  const row = await getDb().get<ResearchJobRow>(
    `SELECT * FROM research_jobs WHERE orchestration_id = ? AND status = 'QUEUED'
      ORDER BY priority, queued_at, rowid LIMIT 1`,
    [orchestrationId],
  );
  return row ? await mapJob(row) : null;
}

export async function jobsForFragment(fragmentId: string): Promise<ResearchJob[]> {
  const rows = await getDb().all<ResearchJobRow>(
    `SELECT j.* FROM research_jobs j
       JOIN research_job_fragments f ON f.job_id = j.id
      WHERE f.fragment_id = ? ORDER BY j.queued_at`,
    [fragmentId],
  );
  return await Promise.all(rows.map(mapJob));
}

export interface JobFragmentOutcome {
  fragmentId: string;
  ordinal: number;
  outcome: string | null;
  detail: string | null;
}

/**
 * What each fragment in a job got out of it.
 *
 * Per fragment, always: a job is one execution and never one verdict, so a
 * bundle where three fragments cleared their gate and one did not reads as
 * exactly that rather than as a failed job.
 */
export async function jobFragmentOutcomes(jobId: string): Promise<JobFragmentOutcome[]> {
  return (await getDb().all<{ fragment_id: string; ordinal: number; outcome: string | null; detail: string | null }>(
      `SELECT fragment_id, ordinal, outcome, detail FROM research_job_fragments
        WHERE job_id = ? ORDER BY ordinal`,
      [jobId],
    ))
    .map((row) => ({
      fragmentId: row.fragment_id,
      ordinal: Number(row.ordinal),
      outcome: row.outcome,
      detail: row.detail,
    }));
}

export async function updateJob(
  id: string,
  patch: {
    status?: JobStatus;
    externalJobId?: string | null;
    promptSha256?: string | null;
    promptBytes?: number | null;
    outputBytes?: number | null;
    durationMs?: number | null;
    failureReason?: string | null;
    model?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<ResearchJob | null> {
  const { clause, values } = buildUpdate({
    status: patch.status,
    external_job_id: patch.externalJobId,
    prompt_sha256: patch.promptSha256,
    prompt_bytes: patch.promptBytes,
    output_bytes: patch.outputBytes,
    duration_ms: patch.durationMs,
    failure_reason: patch.failureReason,
    model: patch.model,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
  });
  if (!clause) return getJob(id);
  await getDb().run(`UPDATE research_jobs SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getJob(id);
}

/** What one fragment got out of a shared job. Separate per fragment, always. */
export async function recordFragmentOutcome(
  jobId: string,
  fragmentId: string,
  outcome: string,
  detail: string | null,
): Promise<void> {
  await getDb().run(
    'UPDATE research_job_fragments SET outcome = ?, detail = ? WHERE job_id = ? AND fragment_id = ?',
    [outcome, detail, jobId, fragmentId],
  );
}

/**
 * Close out jobs that were running when the server stopped.
 *
 * An external process Brain no longer has a handle on cannot be resumed and
 * must not be reported as running: whatever it did or did not do, this instance
 * did not receive it. The row stays, with the reason, so the history says what
 * actually happened rather than pretending the job is still in flight.
 */
export async function abandonRunningJobs(orchestrationId: string, reason: string): Promise<number> {
  const running = await getDb().all<{ id: string }>(
    "SELECT id FROM research_jobs WHERE orchestration_id = ? AND status = 'RUNNING'",
    [orchestrationId],
  );
  if (running.length === 0) return 0;
  const ts = nowIso();
  await getDb().run(
    `UPDATE research_jobs SET status = 'FAILED', failure_reason = ?, completed_at = ?, updated_at = ?
      WHERE orchestration_id = ? AND status = 'RUNNING'`,
    [reason, ts, ts, orchestrationId],
  );
  return running.length;
}

/** Cancel every job still waiting; used when the assignment is cancelled. */
export async function cancelQueuedJobs(orchestrationId: string, reason: string): Promise<number> {
  const pending = await getDb().all<{ id: string }>(
    "SELECT id FROM research_jobs WHERE orchestration_id = ? AND status IN ('QUEUED','RUNNING')",
    [orchestrationId],
  );
  if (pending.length === 0) return 0;
  await getDb().run(
    `UPDATE research_jobs SET status = 'CANCELLED', failure_reason = ?, updated_at = ?
      WHERE orchestration_id = ? AND status IN ('QUEUED','RUNNING')`,
    [reason, nowIso(), orchestrationId],
  );
  return pending.length;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export async function recordQuotaPause(input: {
  orchestrationId: string | null;
  provider: string;
  quotaState: string;
  detail: string;
  jobsCompleted: number;
  jobsPending: number;
}): Promise<string> {
  const id = newId('qta');
  const ts = nowIso();
  await getDb().run(
    `INSERT INTO quota_pauses (id, orchestration_id, provider, quota_state, detail,
       jobs_completed, jobs_pending, paused_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.orchestrationId, input.provider, input.quotaState, input.detail,
      input.jobsCompleted, input.jobsPending, ts, ts],
  );
  return id;
}

export async function resolveQuotaPause(id: string): Promise<void> {
  await getDb().run('UPDATE quota_pauses SET resumed_at = ? WHERE id = ?', [nowIso(), id]);
}

export async function openQuotaPause(orchestrationId: string): Promise<{ id: string; detail: string } | null> {
  const row = await getDb().get<{ id: string; detail: string }>(
    'SELECT id, detail FROM quota_pauses WHERE orchestration_id = ? AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1',
    [orchestrationId],
  );
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Provider connection
// ---------------------------------------------------------------------------

function mapConnection(row: ProviderConnectionRow): ProviderConnection {
  return {
    provider: row.provider,
    installed: toBool(row.installed),
    authenticated: toBool(row.authenticated),
    automationReady: toBool(row.automation_ready),
    executablePath: row.executable_path,
    version: row.version,
    model: row.model,
    quotaState: row.quota_state,
    message: row.message,
    diagnostics: parseJson<unknown>(row.diagnostics, null),
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureReason: row.last_failure_reason,
    paidOverageEnabled: toBool(row.paid_overage_enabled),
    paidOverageNote: row.paid_overage_note,
    paidOverageSetAt: row.paid_overage_set_at,
    lightModel: row.light_model,
    verifiedRunAt: row.verified_run_at,
    verifiedRunDetail: row.verified_run_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnection(provider: string): Promise<ProviderConnection | null> {
  const row = await getDb().get<ProviderConnectionRow>(
    'SELECT * FROM provider_connections WHERE provider = ?',
    [provider],
  );
  return row ? mapConnection(row) : null;
}

export interface SaveConnectionInput {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  executablePath?: string | null;
  version?: string | null;
  model?: string | null;
  quotaState?: string | null;
  message?: string | null;
  diagnostics?: unknown;
  succeeded?: boolean;
  failureReason?: string | null;
}

/** Record a connection test. Success and failure timestamps are both kept. */
export async function saveConnection(input: SaveConnectionInput): Promise<ProviderConnection> {
  const db = getDb();
  const ts = nowIso();
  const existing = await getConnection(input.provider);

  if (!existing) {
    await db.run(
      `INSERT INTO provider_connections (provider, installed, authenticated, automation_ready,
         executable_path, version, model, quota_state, message, diagnostics, last_checked_at,
         last_success_at, last_failure_at, last_failure_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.provider, fromBool(input.installed), fromBool(input.authenticated),
        fromBool(input.automationReady), input.executablePath ?? null, input.version ?? null,
        input.model ?? null, input.quotaState ?? null, input.message ?? null,
        input.diagnostics === undefined ? null : toJson(input.diagnostics), ts,
        input.succeeded ? ts : null, input.succeeded === false ? ts : null,
        input.failureReason ?? null, ts, ts],
    );
    return (await getConnection(input.provider))!;
  }

  await db.run(
    `UPDATE provider_connections SET installed = ?, authenticated = ?, automation_ready = ?,
       executable_path = ?, version = ?, model = ?, quota_state = ?, message = ?, diagnostics = ?,
       last_checked_at = ?, last_success_at = ?, last_failure_at = ?, last_failure_reason = ?,
       updated_at = ? WHERE provider = ?`,
    [fromBool(input.installed), fromBool(input.authenticated), fromBool(input.automationReady),
      input.executablePath ?? null, input.version ?? null, input.model ?? null,
      input.quotaState ?? null, input.message ?? null,
      input.diagnostics === undefined ? null : toJson(input.diagnostics), ts,
      input.succeeded ? ts : existing.lastSuccessAt,
      input.succeeded === false ? ts : existing.lastFailureAt,
      input.succeeded === false ? (input.failureReason ?? null) : existing.lastFailureReason,
      ts, input.provider],
  );
  return (await getConnection(input.provider))!;
}

/**
 * Turn paid overages on or off.
 *
 * Always an explicit act, always recorded with when and why. Nothing else in the
 * platform may set this.
 */
/**
 * The user's choice of which model does which kind of work.
 *
 * Stored rather than configured in the environment, because it is an ordinary
 * preference on an ordinary settings page — not something worth restarting a
 * server for.
 */
export async function setModelDefaults(
  provider: string,
  input: { light: string | null; strong: string | null },
): Promise<ProviderConnection | null> {
  await ensureConnection(provider);
  await getDb().run(
    'UPDATE provider_connections SET light_model = ?, model = ?, updated_at = ? WHERE provider = ?',
    [input.light, input.strong, nowIso(), provider],
  );
  return getConnection(provider);
}

/**
 * Record that a real job ran here.
 *
 * This is the question a connection page is really answering: not "is it
 * installed" but "has it ever actually done the work on this machine". A probe
 * never sets it.
 */
export async function recordVerifiedRun(provider: string, detail: string): Promise<ProviderConnection | null> {
  await ensureConnection(provider);
  const ts = nowIso();
  await getDb().run(
    `UPDATE provider_connections SET verified_run_at = ?, verified_run_detail = ?,
       last_success_at = ?, updated_at = ? WHERE provider = ?`,
    [ts, detail, ts, ts, provider],
  );
  return getConnection(provider);
}

/** Forget what Brain recorded about a connection, without touching the tool. */
export async function clearConnection(provider: string): Promise<ProviderConnection | null> {
  const existing = await getConnection(provider);
  if (!existing) return null;
  await getDb().run(
    `UPDATE provider_connections SET installed = 0, authenticated = 0, automation_ready = 0,
       executable_path = NULL, version = NULL, quota_state = NULL,
       message = 'Disconnected in Brain. Nothing was changed in the tool itself; use Detect to reconnect.',
       diagnostics = NULL, last_checked_at = ?, updated_at = ? WHERE provider = ?`,
    [nowIso(), nowIso(), provider],
  );
  return getConnection(provider);
}

/** A row to hang settings off, for a provider that has never been probed. */
async function ensureConnection(provider: string): Promise<void> {
  if (await getConnection(provider)) return;
  await saveConnection({ provider, installed: false, authenticated: false, automationReady: false });
}

export async function setPaidOverage(
  provider: string,
  enabled: boolean,
  note: string | null,
): Promise<ProviderConnection | null> {
  await ensureConnection(provider);
  await getDb().run(
    `UPDATE provider_connections SET paid_overage_enabled = ?, paid_overage_note = ?,
       paid_overage_set_at = ?, updated_at = ? WHERE provider = ?`,
    [fromBool(enabled), note, nowIso(), nowIso(), provider],
  );
  return getConnection(provider);
}
