/**
 * Standing authority, and the budget it bounds.
 *
 * This is the module that decides whether Russell may act without asking, so
 * every design choice in it is defensive.
 *
 * **There is no `auto` boolean.** A single flag meaning "Russell may do things"
 * is not authority; it is the absence of it. A grant names the project, the
 * classes of work, the window, the ceilings and the explicit prohibitions, and
 * the caller has to say which of those it is relying on. `checkAuthority` below
 * answers a specific question — *may this project run this class of work now* —
 * and refuses anything it was not asked about.
 *
 * **Reservation is an insert, not a count.** `reserve` does an
 * `INSERT ... ON CONFLICT DO NOTHING` on a unique idempotency key and then
 * counts what is actually held. Two launches racing for the last slot therefore
 * cannot both succeed, and a replay of the same launch collides with its own
 * earlier row rather than spending the budget twice. This is Step 6's primitive
 * applied to capacity: the arbiter is the database, never a process-local
 * check-then-write.
 *
 * **Expiry is the Brain's clock.** Never a worker's, never a caller's. The
 * assumption is written down here and nowhere else.
 *
 * **Nothing here creates a grant on Russell's behalf.** `createGoal` takes the
 * human who authorized it and stores them; there is no code path by which
 * Russell, a worker, or a migration can mint or widen one.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  GoalState,
  ReservationKind,
  ReservationState,
  RussellGoal,
  RussellGoalRow,
  RussellReservation,
  RussellReservationRow,
} from '../domain/types.ts';

/** The Brain's clock, named once so the assumption has one home. */
export function authorityNow(): string {
  return nowIso();
}

function mapGoal(row: RussellGoalRow): RussellGoal {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    policyVersion: row.policy_version,
    allowedWork: parseJson<string[]>(row.allowed_work, []),
    prohibitions: parseJson<string[]>(row.prohibitions, []),
    maxMissions: row.max_missions,
    maxFragments: row.max_fragments,
    maxConcurrent: row.max_concurrent,
    maxProbes: row.max_probes,
    maxExternalSpend: row.max_external_spend,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    state: row.state as GoalState,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    revokedReason: row.revoked_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReservation(row: RussellReservationRow): RussellReservation {
  return {
    id: row.id,
    goalId: row.goal_id,
    kind: row.kind as ReservationKind,
    amount: row.amount,
    idempotencyKey: row.idempotency_key,
    state: row.state as ReservationState,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
  };
}

/**
 * The prohibitions every 12A grant carries whether or not a caller lists them.
 *
 * They are unioned into `prohibitions` at creation rather than checked
 * separately, so a grant written by hand, by a script or by a future screen
 * cannot omit one by forgetting. Removing an entry from this list is a code
 * change somebody reviews.
 */
export const ALWAYS_PROHIBITED = [
  'PAID_OVERAGE',
  'NEW_SPENDING',
  'PURCHASE',
  'CONTACT_PERSON',
  'PUBLISH_EXTERNALLY',
  'LEGAL_FILING',
  'IDENTITY_BEARING_ACT',
  'IRREVERSIBLE_EXTERNAL',
  'ACCESS_EXPANSION',
  'NEW_CREDENTIAL',
  'PERMISSION_CHANGE',
  'OUT_OF_SCOPE_WORK',
] as const;

export async function createGoal(input: {
  projectId: string;
  ownerUserId: string;
  createdByUserId: string;
  name: string;
  allowedWork: string[];
  prohibitions?: string[];
  maxMissions: number;
  maxFragments: number;
  maxConcurrent: number;
  maxProbes: number;
  startsAt?: string;
  expiresAt?: string | null;
}): Promise<RussellGoal> {
  const id = newId('rgl');
  const at = authorityNow();
  const prohibitions = [...new Set([...ALWAYS_PROHIBITED, ...(input.prohibitions ?? [])])];
  await getDb().run(
    `INSERT INTO russell_goals
       (id, project_id, owner_user_id, name, policy_version, allowed_work, prohibitions,
        max_missions, max_fragments, max_concurrent, max_probes, max_external_spend,
        starts_at, expires_at, state, revoked_at, revoked_by_user_id, revoked_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.ownerUserId,
      input.name,
      toJson(input.allowedWork),
      toJson(prohibitions),
      Math.max(0, input.maxMissions),
      Math.max(0, input.maxFragments),
      Math.max(0, input.maxConcurrent),
      Math.max(0, input.maxProbes),
      input.startsAt ?? at,
      input.expiresAt ?? null,
      input.createdByUserId,
      at,
      at,
    ],
  );
  const created = await getGoal(id);
  if (!created) throw new Error('The goal disappeared immediately after being written.');
  return created;
}

export async function getGoal(id: string): Promise<RussellGoal | null> {
  const rows = await getDb().all<RussellGoalRow>('SELECT * FROM russell_goals WHERE id = ?', [id]);
  return rows[0] ? mapGoal(rows[0]) : null;
}

export async function listGoals(projectId: string): Promise<RussellGoal[]> {
  const rows = await getDb().all<RussellGoalRow>(
    'SELECT * FROM russell_goals WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
    [projectId],
  );
  return rows.map(mapGoal);
}

/**
 * Withdraw a grant.
 *
 * Guarded on it still being live, and it takes effect on the next check rather
 * than at some later sweep — every meaningful action revalidates, so a
 * revocation lands on the next launch, provider call, writeback or resume.
 * Accepted progress is untouched: revoking stops new work, it does not corrupt
 * finished work.
 */
export async function revokeGoal(input: {
  goalId: string;
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  const at = authorityNow();
  const result = await getDb().run(
    `UPDATE russell_goals
        SET state = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ?,
            updated_at = ?
      WHERE id = ? AND state IN ('ACTIVE','PAUSED')`,
    [at, input.actorUserId, input.reason, at, input.goalId],
  );
  return result.changes === 1;
}

export async function setGoalState(input: {
  goalId: string;
  from: GoalState;
  to: GoalState;
}): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE russell_goals SET state = ?, updated_at = ? WHERE id = ? AND state = ?',
    [input.to, authorityNow(), input.goalId, input.from],
  );
  return result.changes === 1;
}

export interface AuthorityDecision {
  ok: boolean;
  goal: RussellGoal | null;
  /** Safe to show a person. Names the rule, never a credential or an id. */
  reason: string;
  policyVersion: number | null;
}

/**
 * May this project do this class of work, right now, under a live grant?
 *
 * Deny by default and fail closed: no grant, an expired one, a not-yet-started
 * one, a revoked one, a paused one, an unlisted work class or a prohibited
 * action are all refusals, and none of them degrade to a weaker allowance.
 *
 * The returned `policyVersion` is what a caller records alongside whatever it
 * then does, so "Russell was allowed to do this" is answerable later by saying
 * *which rules applied* rather than by re-running today's.
 */
export async function checkAuthority(input: {
  projectId: string;
  workClass: string;
  action?: string;
  at?: string;
}): Promise<AuthorityDecision> {
  const now = input.at ?? authorityNow();
  const rows = await getDb().all<RussellGoalRow>(
    `SELECT * FROM russell_goals
      WHERE project_id = ? AND state = 'ACTIVE'
      ORDER BY created_at DESC, rowid DESC`,
    [input.projectId],
  );
  if (rows.length === 0) {
    return { ok: false, goal: null, reason: 'no standing authority exists for this project', policyVersion: null };
  }

  for (const row of rows) {
    const goal = mapGoal(row);
    if (goal.startsAt > now) continue;
    if (goal.expiresAt && goal.expiresAt <= now) continue;
    if (!goal.allowedWork.includes(input.workClass)) continue;
    if (input.action && goal.prohibitions.includes(input.action)) {
      return {
        ok: false,
        goal,
        reason: `the standing authority prohibits ${input.action}`,
        policyVersion: goal.policyVersion,
      };
    }
    return { ok: true, goal, reason: 'within standing authority', policyVersion: goal.policyVersion };
  }
  return {
    ok: false,
    goal: null,
    reason: `no live standing authority covers ${input.workClass} in this project`,
    policyVersion: null,
  };
}

export interface ReservationOutcome {
  ok: boolean;
  reservation: RussellReservation | null;
  /** Safe to show a person. */
  reason: string;
  /** True when this call collided with an equivalent one that already held it. */
  replayed: boolean;
}

/**
 * Take one slice of a grant's budget, atomically.
 *
 * The order matters and is the whole mechanism:
 *
 *   1. insert on the idempotency key, ignoring a conflict;
 *   2. read back the row that now exists;
 *   3. if this call did not insert it, report a replay and stop;
 *   4. count what is held, and if the ceiling is exceeded, release the row we
 *      just took and refuse.
 *
 * Step 4 rather than a `SELECT count(*)` before step 1: checking first leaves a
 * window in which two callers both see room. Taking first and standing down if
 * we overshot has no window, and the release is recorded rather than silent so
 * a refusal is explicable afterwards.
 */
export async function reserve(input: {
  goalId: string;
  kind: ReservationKind;
  idempotencyKey: string;
  amount?: number;
  ttlMinutes?: number;
  at?: string;
}): Promise<ReservationOutcome> {
  const goal = await getGoal(input.goalId);
  if (!goal) return { ok: false, reservation: null, reason: 'no such standing authority', replayed: false };
  if (goal.state !== 'ACTIVE') {
    return { ok: false, reservation: null, reason: `the standing authority is ${goal.state}`, replayed: false };
  }

  const now = input.at ?? authorityNow();
  if (goal.expiresAt && goal.expiresAt <= now) {
    return { ok: false, reservation: null, reason: 'the standing authority has expired', replayed: false };
  }

  const id = newId('rrv');
  const expires = new Date(
    Date.parse(now) + Math.max(1, input.ttlMinutes ?? 120) * 60_000,
  ).toISOString();

  await getDb().run(
    `INSERT INTO russell_budget_reservations
       (id, goal_id, kind, amount, idempotency_key, state, expires_at, settled_at,
        released_at, release_reason, created_at)
     VALUES (?, ?, ?, ?, ?, 'HELD', ?, NULL, NULL, NULL, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, input.goalId, input.kind, Math.max(1, input.amount ?? 1), input.idempotencyKey, expires, now],
  );

  const existing = (
    await getDb().all<RussellReservationRow>(
      'SELECT * FROM russell_budget_reservations WHERE idempotency_key = ?',
      [input.idempotencyKey],
    )
  )[0];
  if (!existing) {
    return { ok: false, reservation: null, reason: 'the reservation could not be taken', replayed: false };
  }
  if (existing.id !== id) {
    // Somebody equivalent got there first. That is success for an idempotent
    // caller — the budget was spent once and this attempt is the same attempt.
    return {
      ok: existing.state === 'HELD' || existing.state === 'SETTLED',
      reservation: mapReservation(existing),
      reason: 'an equivalent reservation already exists',
      replayed: true,
    };
  }

  const ceiling = ceilingFor(goal, input.kind);
  const held = await totalThroughMine(goal.id, input.kind, now, existing);
  if (held > ceiling) {
    await releaseReservation({ reservationId: id, reason: `over the ${input.kind.toLowerCase()} ceiling` });
    return {
      ok: false,
      reservation: null,
      reason: `the standing authority allows ${ceiling} ${input.kind.toLowerCase()} at a time`,
      replayed: false,
    };
  }

  return { ok: true, reservation: mapReservation(existing), reason: 'reserved', replayed: false };
}

function ceilingFor(goal: RussellGoal, kind: ReservationKind): number {
  switch (kind) {
    case 'MISSION':
      return Math.min(goal.maxMissions, goal.maxConcurrent);
    case 'FRAGMENT':
      return goal.maxFragments;
    case 'PROBE':
    default:
      return goal.maxProbes;
  }
}

/**
 * How much of this kind is outstanding *up to and including my own row*.
 *
 * Counting everything outstanding and standing down if the total is over the
 * ceiling looks equivalent and is not, which a test caught immediately: two
 * callers race, both insert, both then count **two**, both conclude they
 * overshot, and both release. The ceiling is respected and nobody gets the
 * slot — an outcome strictly worse than either one winning.
 *
 * So the total is taken through this row's own position in a stable order,
 * `(created_at, id)`. The first inserter ranks 1 and keeps the slot; the second
 * ranks 2, sees it is over, and is the only one that stands down. Deterministic,
 * no mutual abort, and it generalises to amounts rather than counts.
 *
 * `HELD` and unexpired, or already `SETTLED`. An expired hold counts for
 * nothing — that is what makes a crashed launch's reservation recoverable
 * without anybody sweeping it — and a released one counts for nothing, which is
 * what makes standing down safe.
 */
async function totalThroughMine(
  goalId: string,
  kind: ReservationKind,
  now: string,
  mine: RussellReservationRow,
): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM russell_budget_reservations
      WHERE goal_id = ? AND kind = ?
        AND (state = 'SETTLED' OR (state = 'HELD' AND expires_at > ?))
        AND (created_at < ? OR (created_at = ? AND id <= ?))`,
    [goalId, kind, now, mine.created_at, mine.created_at, mine.id],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function settleReservation(reservationId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_budget_reservations
        SET state = 'SETTLED', settled_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [authorityNow(), reservationId],
  );
  return result.changes === 1;
}

export async function releaseReservation(input: {
  reservationId: string;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_budget_reservations
        SET state = 'RELEASED', released_at = ?, release_reason = ?
      WHERE id = ? AND state = 'HELD'`,
    [authorityNow(), input.reason, input.reservationId],
  );
  return result.changes === 1;
}

export async function getReservation(id: string): Promise<RussellReservation | null> {
  const rows = await getDb().all<RussellReservationRow>(
    'SELECT * FROM russell_budget_reservations WHERE id = ?',
    [id],
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}

export async function listReservations(goalId: string): Promise<RussellReservation[]> {
  const rows = await getDb().all<RussellReservationRow>(
    'SELECT * FROM russell_budget_reservations WHERE goal_id = ? ORDER BY created_at, rowid',
    [goalId],
  );
  return rows.map(mapReservation);
}
