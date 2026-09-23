/**
 * The rows that make a workstream a goal Brain owns.
 *
 * Three kinds of write, and every one of them is guarded in the statement that
 * makes it — the shape every compare-and-swap in this codebase has, because a
 * read-then-write leaves a window for a race to live in.
 *
 *   * **A person's decision** — pause, resume, cancel, the goal's terms. Each
 *     is guarded on the decision it is changing, so two people pausing one
 *     goal produce one pause and one ordinary refusal.
 *   * **A hold on a bin.** Guarded on the bin being unheld and live, and
 *     released only by the goal that holds it, so one goal can never release a
 *     hold another goal placed.
 *   * **A priority snapshot**, append-only, written only when a position moves.
 *
 * Nothing here derives, ranks or decides. `services/goals/` does, and keeping
 * the rule out of the repository is what stops a second reader appearing with
 * its own opinion.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import { mapBin } from './bins.ts';
import type { Bin, BinRow } from '../domain/types.ts';
import type { GoalCommitment, GoalPrioritySnapshot, HoldReason } from '../domain/goals.ts';
export type { GoalPrioritySnapshot };

// ---------------------------------------------------------------------------
// A person's decisions about a goal
// ---------------------------------------------------------------------------

export async function setGoalTerms(
  id: string,
  terms: {
    outcome?: string | null;
    ownerUserId?: string | null;
    dueAt?: string | null;
    commitment?: GoalCommitment;
  },
): Promise<boolean> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (terms.outcome !== undefined) { sets.push('outcome = ?'); params.push(terms.outcome); }
  if (terms.ownerUserId !== undefined) { sets.push('owner_user_id = ?'); params.push(terms.ownerUserId); }
  if (terms.dueAt !== undefined) { sets.push('due_at = ?'); params.push(terms.dueAt); }
  if (terms.commitment !== undefined) { sets.push('commitment = ?'); params.push(terms.commitment); }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  const result = await getDb().run(`UPDATE workstreams SET ${sets.join(', ')} WHERE id = ?`, params);
  return result.changes > 0;
}

/** Guarded on the goal being live and unpaused. The loser is `false`. */
export async function pauseGoal(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE workstreams SET paused_at = ?, paused_reason = ?, updated_at = ?
      WHERE id = ? AND paused_at IS NULL AND cancelled_at IS NULL AND archived_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes > 0;
}

/**
 * Guarded on the goal being paused and not cancelled. A cancelled goal is not
 * resumed by this — a cancellation is a different decision with a different
 * answer (`reinstateGoal`), and one button that undid both would let a resume
 * silently reverse somebody's cancellation.
 */
export async function resumeGoal(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workstreams SET paused_at = NULL, paused_reason = NULL, updated_at = ?
      WHERE id = ? AND paused_at IS NOT NULL AND cancelled_at IS NULL`,
    [nowIso(), id],
  );
  return result.changes > 0;
}

export async function cancelGoal(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE workstreams SET cancelled_at = ?, cancelled_reason = ?, updated_at = ?
      WHERE id = ? AND cancelled_at IS NULL AND archived_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes > 0;
}

/** The answer to a cancellation somebody regrets. Keeps the event history. */
export async function reinstateGoal(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workstreams SET cancelled_at = NULL, cancelled_reason = NULL, updated_at = ?
      WHERE id = ? AND cancelled_at IS NOT NULL AND archived_at IS NULL`,
    [nowIso(), id],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Bins, as a goal sees them
// ---------------------------------------------------------------------------

/** States in which a bin still has work in it, so holding it means something. */
const LIVE_BIN_STATES = `('DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN')`;

/**
 * Every bin a goal's linked work resolves to, live or finished.
 *
 * Three joins and no fourth, each on a column Brain wrote when it made the
 * bin: a campaign's bins carry `factory_campaign_id`, a packet's carry
 * `orchestration_id`, and a mission carries its own `bin_id`. Nothing is
 * matched on a title or a manifest's prose.
 */
export async function binsFor(input: {
  campaignIds: string[];
  orchestrationIds: string[];
  binIds: string[];
}): Promise<Bin[]> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const add = (column: string, ids: string[]) => {
    if (ids.length === 0) return;
    clauses.push(`${column} IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  };
  add('factory_campaign_id', input.campaignIds);
  add('orchestration_id', input.orchestrationIds);
  add('id', input.binIds);
  if (clauses.length === 0) return [];
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins WHERE ${clauses.join(' OR ')} ORDER BY created_at, id`,
    params,
  );
  return rows.map(mapBin);
}

/**
 * Hold a live bin for a goal.
 *
 * Guarded on the bin being unheld and still holding work, so a finished bin is
 * never marked and two goals never both hold one. The lease, the attempts, the
 * generation and every event are untouched: a worker already inside the bin
 * finishes what it is doing, and resuming continues rather than restarts.
 */
export async function holdBinForGoal(binId: string, workstreamId: string, reason: HoldReason): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE bins SET held_by_workstream_id = ?, held_reason = ?, updated_at = ?
      WHERE id = ? AND held_by_workstream_id IS NULL AND state IN ${LIVE_BIN_STATES}`,
    [workstreamId, reason, nowIso(), binId],
  );
  return result.changes > 0;
}

/**
 * Released only by the goal that holds it — and the fire it lost is given back.
 *
 * While a bin is held the dispatcher's supersede pass correctly retires its
 * pending intent, because a held bin is not dispatchable. But `bin_dispatch` is
 * `UNIQUE (bin_id, lease_generation)` and a hold advances no generation, so
 * `ensureDispatchIntent` after the release would collide with that superseded
 * row and write nothing: the bin would be claimable and never fired again —
 * §24's *a fire nobody answers strands its bin*, reached through a pause. So
 * the superseded intent at the bin's *current* generation is put back to
 * `PENDING`, due now. Only that generation, and only `SUPERSEDED`: an older
 * generation's intent is about work that already moved on, and an abandoned
 * one gave up for a reason a release does not answer.
 */
export async function releaseGoalHold(binId: string, workstreamId: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE bins SET held_by_workstream_id = NULL, held_reason = NULL, updated_at = ?
      WHERE id = ? AND held_by_workstream_id = ?`,
    [at, binId, workstreamId],
  );
  if (result.changes === 0) return false;
  await getDb().run(
    `UPDATE bin_dispatch SET state = 'PENDING', next_attempt_at = ?, updated_at = ?
      WHERE bin_id = ? AND state = 'SUPERSEDED'
        AND lease_generation = (SELECT lease_generation FROM bins WHERE id = ?)`,
    [at, at, binId, binId],
  );
  return true;
}

/** A goal whose reason for holding changed — paused, then cancelled — says so. */
export async function restateGoalHold(binId: string, workstreamId: string, reason: HoldReason): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE bins SET held_reason = ?, updated_at = ?
      WHERE id = ? AND held_by_workstream_id = ? AND held_reason <> ?`,
    [reason, nowIso(), binId, workstreamId, reason],
  );
  return result.changes > 0;
}

export async function binsHeldBy(workstreamId: string): Promise<Bin[]> {
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins WHERE held_by_workstream_id = ? ORDER BY created_at, id`,
    [workstreamId],
  );
  return rows.map(mapBin);
}

/**
 * Every bin held by a goal, so a hold whose goal no longer wants it — archived,
 * reinstated, dependency met — can be found without walking every goal.
 */
export async function allHeldBins(): Promise<Bin[]> {
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins WHERE held_by_workstream_id IS NOT NULL ORDER BY created_at, id`,
  );
  return rows.map(mapBin);
}

/**
 * Move a live bin's priority, only when it differs.
 *
 * Never above 8 and never touching a bin at 9, which is where a conversation
 * turn lives: somebody talking to Russell now outranks any goal's background
 * work, and a goal allocation that could overtake them would be a person
 * waiting on Brain's own backlog.
 */
export async function setLiveBinPriority(binId: string, priority: number): Promise<boolean> {
  const bounded = Math.min(8, Math.max(0, Math.trunc(priority)));
  const result = await getDb().run(
    `UPDATE bins SET priority = ?, updated_at = ?
      WHERE id = ? AND priority <> ? AND priority < 9 AND state IN ${LIVE_BIN_STATES}`,
    [bounded, nowIso(), binId, bounded],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Priority history
// ---------------------------------------------------------------------------


interface SnapshotRow {
  id: string;
  workstream_id: string;
  owner_key: string;
  rank: number;
  previous_rank: number | null;
  criterion: string;
  reason: string;
  created_at: string;
}

function mapSnapshot(row: SnapshotRow): GoalPrioritySnapshot {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    ownerKey: row.owner_key,
    rank: Number(row.rank),
    previousRank: row.previous_rank === null ? null : Number(row.previous_rank),
    criterion: row.criterion,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export async function latestSnapshots(workstreamIds: string[]): Promise<Map<string, GoalPrioritySnapshot>> {
  const out = new Map<string, GoalPrioritySnapshot>();
  if (workstreamIds.length === 0) return out;
  const rows = await getDb().all<SnapshotRow>(
    `SELECT * FROM goal_priority_snapshots
      WHERE workstream_id IN (${workstreamIds.map(() => '?').join(', ')})
      ORDER BY created_at DESC, id DESC`,
    workstreamIds,
  );
  for (const row of rows) {
    if (!out.has(row.workstream_id)) out.set(row.workstream_id, mapSnapshot(row));
  }
  return out;
}

export async function snapshotHistory(workstreamId: string, limit = 20): Promise<GoalPrioritySnapshot[]> {
  const rows = await getDb().all<SnapshotRow>(
    `SELECT * FROM goal_priority_snapshots WHERE workstream_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [workstreamId, limit],
  );
  return rows.map(mapSnapshot);
}

export async function recordSnapshot(input: {
  workstreamId: string;
  ownerKey: string;
  rank: number;
  previousRank: number | null;
  criterion: string;
  reason: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO goal_priority_snapshots
       (id, workstream_id, owner_key, rank, previous_rank, criterion, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('gps'),
      input.workstreamId,
      input.ownerKey,
      input.rank,
      input.previousRank,
      input.criterion,
      input.reason,
      nowIso(),
    ],
  );
}
