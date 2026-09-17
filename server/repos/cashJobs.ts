/**
 * Execution jobs: the first thing in Cash Mode that belongs to somebody.
 *
 * The opportunity and all its evidence are shared and stay shared. A job adds
 * the parts that are not — who is doing it, what they may spend, who may see
 * the working state — and owns nothing about the research, so a reassignment
 * moves no evidence and a release loses none.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CashJob, CashJobRow, CashJobState, CashJobVisibility } from '../domain/types.ts';

function map(row: CashJobRow): CashJob {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    projectId: row.project_id,
    state: row.state as CashJobState,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility as CashJobVisibility,
    budgetCents: row.budget_cents,
    currency: row.currency,
    note: row.note,
    assignedAt: row.assigned_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Live means somebody may still be working on it. */
const LIVE = "state NOT IN ('RELEASED', 'COLLECTED')";

export async function createJob(input: {
  opportunityId: string;
  projectId: string;
  currency: string;
  ownerUserId?: string | null;
  visibility?: CashJobVisibility;
  budgetCents?: number | null;
  note?: string | null;
  createdBy: string;
}): Promise<CashJob | null> {
  const id = newId('cjb');
  const ts = nowIso();
  const owner = input.ownerUserId ?? null;
  try {
    await getDb().run(
      `INSERT INTO cash_jobs (id, opportunity_id, project_id, state, owner_user_id, visibility,
         budget_cents, currency, note, assigned_at, released_at, release_reason,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        id,
        input.opportunityId,
        input.projectId,
        owner ? 'ASSIGNED' : 'UNASSIGNED',
        owner,
        input.visibility ?? 'PRIVATE',
        input.budgetCents ?? null,
        input.currency,
        input.note ?? null,
        owner ? ts : null,
        input.createdBy,
        ts,
        ts,
      ],
    );
  } catch {
    /*
     * The unique index refused it: a live job already exists for this
     * opportunity. That is an ordinary outcome rather than an error — two
     * people simultaneously believing the work is theirs is the thing it
     * prevents — so the caller is told by getting null back.
     */
    return null;
  }
  return getJob(id);
}

export async function getJob(id: string): Promise<CashJob | null> {
  const row = await getDb().get<CashJobRow>('SELECT * FROM cash_jobs WHERE id = ?', [id]);
  return row ? map(row) : null;
}

/** The live job for an opportunity, or null. */
export async function liveJobFor(opportunityId: string): Promise<CashJob | null> {
  const row = await getDb().get<CashJobRow>(
    `SELECT * FROM cash_jobs WHERE opportunity_id = ? AND ${LIVE}
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [opportunityId],
  );
  return row ? map(row) : null;
}

export async function listJobs(projectId: string): Promise<CashJob[]> {
  const rows = await getDb().all<CashJobRow>(
    /*
     * Newest first, tiebroken on `id` rather than on `rowid`/`seq`.
     *
     * An ORDER BY must be sayable in both dialects, and a tiebreak on a column
     * only one backend has is the easiest way to write one that is not — three
     * separate instances of that are recorded in CLAUDE.md.
     */
    `SELECT * FROM cash_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(map);
}

export async function participantsOf(jobId: string): Promise<string[]> {
  const rows = await getDb().all<{ user_id: string }>(
    'SELECT user_id FROM cash_job_participants WHERE job_id = ? ORDER BY user_id',
    [jobId],
  );
  return rows.map((row) => row.user_id);
}

export async function addParticipant(input: {
  jobId: string;
  userId: string;
  addedBy: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO cash_job_participants (job_id, user_id, added_by, added_at)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [input.jobId, input.userId, input.addedBy, nowIso()],
  );
}

/**
 * Assign or reassign, guarded on the state the caller believed.
 *
 * A compare-and-swap on `state` rather than a read-then-write, for the reason
 * every other claim in this codebase is: two people pressing assign at once
 * must produce one owner, and the loser must be told rather than silently
 * overwriting. The guard is on a value the caller does not supply.
 */
export async function assignJob(input: {
  jobId: string;
  expectState: CashJobState;
  ownerUserId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_jobs SET owner_user_id = ?, state = 'ASSIGNED', assigned_at = ?, updated_at = ?
      WHERE id = ? AND state = ?`,
    [input.ownerUserId, nowIso(), nowIso(), input.jobId, input.expectState],
  );
  return result.changes === 1;
}

/** Hand it back without destroying anything: the row and its history stay. */
export async function releaseJob(input: {
  jobId: string;
  reason: string;
}): Promise<boolean> {
  const ts = nowIso();
  const result = await getDb().run(
    `UPDATE cash_jobs SET state = 'RELEASED', released_at = ?, release_reason = ?, updated_at = ?
      WHERE id = ? AND ${LIVE}`,
    [ts, input.reason, ts, input.jobId],
  );
  return result.changes === 1;
}

export async function setJobState(input: {
  jobId: string;
  expectState: CashJobState;
  to: CashJobState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_jobs SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
    [input.to, nowIso(), input.jobId, input.expectState],
  );
  return result.changes === 1;
}
