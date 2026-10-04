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
 * **Nothing here creates a grant on Russell's behalf.** `createGoal` and
 * `ensureGoal` both take the human who authorized it and store them; there is
 * no code path by which Russell, a worker, or a migration can mint or widen
 * one. `ensureGoal` exists because one authorization a person gives — pressing
 * Start Cash Mode — implies exactly one grant whose terms are fixed in code,
 * and asking them to fill that grant in afterwards would be a second
 * authorization for a decision they already made. The human is still named,
 * from the row their own press wrote, and the terms are still not theirs to
 * widen.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  GoalState,
  ReservationKind,
  ReservationState,
  RussellGoal,
  WorkPolicy,
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
    workPolicy: (row.work_policy ?? 'UNCAPPED') as WorkPolicy,
    purpose: row.purpose === 'RESEARCH_GOAL' ? 'RESEARCH_GOAL' : 'STANDING',
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
  /**
   * Whether the cumulative counts stop anything. Written explicitly rather
   * than left to the column default, because "this grant does not ration
   * research" is a decision worth reading off the row rather than inferring
   * from the absence of one. UNCAPPED is what the product issues.
   */
  workPolicy?: WorkPolicy;
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
        work_policy,
        starts_at, expires_at, state, revoked_at, revoked_by_user_id, revoked_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?)`,
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
      input.workPolicy ?? 'UNCAPPED',
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

/**
 * The one live grant of a fixed name for one project, created if it is absent.
 *
 * The arbiter is `idx_russell_goals_one_live_<name>`, a partial unique index on
 * `(project_id)` for that name and `state = 'ACTIVE'`, so two ticks that both
 * read "there is none here" produce one grant between them and the loser reads
 * back the winner's row. That is `reserve`'s primitive one table along, and it
 * is the reason this is an insert rather than a check followed by a write: a
 * check-then-write has a window, and a tick runs every few seconds on more than
 * one instance.
 *
 * `created` says which happened, because "authorized when you pressed Start"
 * and "already authorized since Tuesday" are different sentences to show a
 * person, and because a caller that records an event wants to record it once.
 *
 * The terms are the caller's constants and never a caller's *input*: this
 * writes whatever it is given, and the module that gives it is the one holding
 * the fixed grant. Widening is therefore a code change somebody reviews, which
 * is where "does this authorize an effect?" gets asked.
 */
export async function ensureGoal(input: {
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
  workPolicy?: WorkPolicy;
  startsAt?: string;
  expiresAt?: string | null;
}): Promise<{ goal: RussellGoal; created: boolean }> {
  const id = newId('rgl');
  const at = authorityNow();
  const prohibitions = [...new Set([...ALWAYS_PROHIBITED, ...(input.prohibitions ?? [])])];
  const result = await getDb().run(
    `INSERT INTO russell_goals
       (id, project_id, owner_user_id, name, policy_version, allowed_work, prohibitions,
        max_missions, max_fragments, max_concurrent, max_probes, max_external_spend,
        work_policy,
        starts_at, expires_at, state, revoked_at, revoked_by_user_id, revoked_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
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
      input.workPolicy ?? 'UNCAPPED',
      input.startsAt ?? at,
      input.expiresAt ?? null,
      input.createdByUserId,
      at,
      at,
    ],
  );
  if (result.changes === 1) {
    const created = await getGoal(id);
    if (created) return { goal: created, created: true };
  }
  const existing = await liveGoalNamed(input.projectId, input.name);
  if (!existing) {
    throw new Error('The grant was neither inserted nor found, which the unique index makes impossible.');
  }
  return { goal: existing, created: false };
}

/** The live grant of one fixed name, or null. The index makes "the" honest. */
export async function liveGoalNamed(projectId: string, name: string): Promise<RussellGoal | null> {
  const rows = await getDb().all<RussellGoalRow>(
    `SELECT * FROM russell_goals
      WHERE project_id = ? AND name = ? AND state = 'ACTIVE' AND purpose = 'STANDING'
      ORDER BY created_at DESC, rowid DESC`,
    [projectId, name],
  );
  return rows[0] ? mapGoal(rows[0]) : null;
}

export async function getGoal(id: string): Promise<RussellGoal | null> {
  const rows = await getDb().all<RussellGoalRow>('SELECT * FROM russell_goals WHERE id = ?', [id]);
  return rows[0] ? mapGoal(rows[0]) : null;
}

/**
 * The project's standing grants, newest first. A `RESEARCH_GOAL` is never one:
 * it is a bounded budget for one piece of research, and letting it appear here
 * would let it become Russell's standing authority by being listed.
 */
export async function listGoals(projectId: string): Promise<RussellGoal[]> {
  const rows = await getDb().all<RussellGoalRow>(
    `SELECT * FROM russell_goals WHERE project_id = ? AND purpose = 'STANDING'
      ORDER BY created_at DESC, rowid DESC`,
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

/*
 * There was a `raiseGoalCeiling` here, and it is gone. The correction is
 * recorded rather than quietly applied.
 *
 * It existed to answer one escalation: "the standing authority allows 2
 * missions in total" with three missions left to run. Raising the number the
 * owner set, on the grant they set it on, was the only answer that did not
 * either refund spend Brain had no business refunding or mint a new goal id
 * and take the spend history to zero with it.
 *
 * The escalation itself was the defect. Missions, fragments and probes were
 * never scarce: the subscription behind them is already paid for, and a
 * lifetime quota on them turned continuous authorized work into an allowance
 * somebody had to keep topping up. Under the UNCAPPED policy there is no
 * ceiling to reach, so there is nothing to raise — and a raise control kept
 * "for completeness" would be a way to move the one limit that is real,
 * concurrency, which is provider capacity rather than an allowance and is a
 * fleet decision with its own actor and reason.
 *
 * Changing concurrency is therefore what it always should have been: withdraw
 * the grant and make a new one, deliberately. That used to be objectionable
 * because it reset the counting; it no longer is, because the counting no
 * longer stops anything. Every reservation ever written is still there.
 */

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
      WHERE project_id = ? AND state = 'ACTIVE' AND purpose = 'STANDING'
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
  /**
   * Which ceiling refused, when one did.
   *
   * A discriminant rather than a prose match, because the two refusals mean
   * opposite things to the person waiting. `AT_ONCE` is an ordinary wait —
   * something is running and this will start when it finishes, with nobody
   * needed. `IN_TOTAL` is terminal: nothing will ever launch it while the
   * cumulative ceiling stands, and a caller that cannot tell them apart either
   * alarms a person about a queue or leaves them never told about a wall.
   *
   * The loop was doing the second. A cumulative refusal matched neither prefix
   * it checks for, so it was dropped from the tick report and from every
   * surface, and a queued idea sat behind a spent ceiling in silence.
   *
   * `AT_ONCE` is now the ordinary refusal and `IN_TOTAL` is reachable only for
   * a CAPPED grant — the policy the product no longer issues, and which only
   * grants that have already ended still carry. It is kept because those rows
   * are real and because the distinction is what the surfaces read.
   */
  refusedBy?: 'IN_TOTAL' | 'AT_ONCE';
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
  let mine = existing;
  if (existing.id !== id) {
    /*
     * Somebody equivalent got there first. That is success for an idempotent
     * caller — the budget was spent once and this attempt is the same attempt.
     *
     * Except when the row is `RELEASED`, which is not a previous success but a
     * previous *stand-down*. `launch()` keys a mission reservation by candidate
     * and goal, so a mission refused on concurrency left a released row under
     * that key and every later attempt read it back as a refusal: the candidate
     * could never launch, however free the fleet became. That is the "waiting
     * for something nobody can resolve" shape again, at the budget.
     *
     * So a released row is revived rather than reported. The revival is a
     * guarded compare-and-swap, so two callers racing to revive the same key
     * produce one winner; the loser re-reads and replays like any other
     * equivalent caller. It keeps its original `rowid`, which means it keeps
     * its place in the queue for the slot — it was there first.
     */
    if (existing.state !== 'RELEASED') {
      return {
        ok: existing.state === 'HELD' || existing.state === 'SETTLED',
        reservation: mapReservation(existing),
        reason: 'an equivalent reservation already exists',
        replayed: true,
      };
    }
    const revived = await getDb().run(
      `UPDATE russell_budget_reservations
          SET state = 'HELD', expires_at = ?, released_at = NULL, release_reason = NULL
        WHERE id = ? AND state = 'RELEASED'`,
      [expires, existing.id],
    );
    const reread = (
      await getDb().all<RussellReservationRow>(
        'SELECT * FROM russell_budget_reservations WHERE id = ?',
        [existing.id],
      )
    )[0];
    if (!reread) {
      return { ok: false, reservation: null, reason: 'the reservation could not be taken', replayed: false };
    }
    if (revived.changes !== 1) {
      // Lost the revival. Whatever it is now is the shared answer.
      return {
        ok: reread.state === 'HELD' || reread.state === 'SETTLED',
        reservation: mapReservation(reread),
        reason: 'an equivalent reservation already exists',
        replayed: true,
      };
    }
    mine = reread;
  }

  /*
   * Two ceilings, because they are two different questions.
   *
   * `ceilingFor` used to answer both with `Math.min(maxMissions,
   * maxConcurrent)` against a cumulative count, and that is wrong in the
   * direction that matters: a grant of two missions with one running at a time
   * permitted **one mission ever**, and refused the automatic follow-on. The
   * owner set those numbers from their plain meaning and would have been
   * under-authorized without being told.
   *
   * So:
   *
   *   - **total** counts `SETTLED` and live `HELD` — a finished mission has
   *     still been spent, and always counts against `maxMissions`;
   *   - **active** counts live `HELD` only — settling a mission gives back
   *     concurrency and refunds nothing cumulative.
   *
   * Both are ranked through this row's own `rowid`, which is what stops two
   * callers racing for the last slot from both winning it *and* from both
   * standing down. That property is the reason the rank exists and it has to
   * hold for each ceiling separately: a request may be inside the cumulative
   * limit and outside the concurrent one, and it must lose exactly one of them.
   */
  const totals = await totalsThroughMine(goal.id, input.kind, now, mine);
  const limits = ceilingsFor(goal, input.kind);

  if (limits.total !== null && totals.total > limits.total) {
    await releaseReservation({ reservationId: mine.id, reason: `over the ${input.kind.toLowerCase()} total` });
    return {
      ok: false,
      reservation: null,
      reason: `the standing authority allows ${limits.total} ${input.kind.toLowerCase()} in total`,
      replayed: false,
      refusedBy: 'IN_TOTAL',
    };
  }
  if (limits.active !== null && totals.active > limits.active) {
    await releaseReservation({ reservationId: mine.id, reason: `over the ${input.kind.toLowerCase()} concurrency` });
    return {
      ok: false,
      reservation: null,
      reason: `the standing authority allows ${limits.active} ${input.kind.toLowerCase()} at a time`,
      replayed: false,
      refusedBy: 'AT_ONCE',
    };
  }

  return { ok: true, reservation: mapReservation(mine), reason: 'reserved', replayed: false };
}

/**
 * What this grant allows, cumulatively and at once.
 *
 * Only a mission has a meaningful concurrency limit; a fragment and a probe are
 * bounded by their totals alone, so their `active` ceiling is the same number
 * and the second check can never be the one that refuses them. Written out
 * rather than special-cased at the call site, so adding a kind means answering
 * both questions for it.
 */
/**
 * What this grant allows, cumulatively and at once. `null` means uncapped.
 *
 * **The cumulative ceilings are gone by policy, not by being set very high.**
 * A subscription-backed Brain that stops after N pieces of research for ever,
 * and needs a person to top it up, is a machine for managing an allowance
 * rather than one that does the work. Three of the grant's four numbers were
 * lifetime quotas — missions, fragments, probes — and the original
 * specification had already said that measured starting values must not become
 * permanent capacity ceilings. They had.
 *
 * `null` rather than `Number.MAX_SAFE_INTEGER`: an enormous number pretending
 * to be unlimited still reads as a limit on the card, still needs replenishing
 * one day, and hides the decision behind a magnitude nobody chose.
 *
 * **Concurrency is untouched and stays a real number**, because it is not an
 * artificial quota. It is what the provider can actually run at once, and
 * exceeding it does not offend a policy — it overruns a subscription. Raising
 * it is a fleet capacity decision, which §23 keeps in `fleet_policy` with an
 * actor and a reason, not here.
 *
 * Reservations are still written for every kind. This removes the stopping
 * rule, not the evidence: what a grant has consumed is still counted, still
 * shown, and still what an audit reads.
 */
function ceilingsFor(
  goal: RussellGoal,
  kind: ReservationKind,
): { total: number | null; active: number | null } {
  const capped = goal.workPolicy === 'CAPPED';
  switch (kind) {
    case 'MISSION':
      return { total: capped ? goal.maxMissions : null, active: goal.maxConcurrent };
    case 'FRAGMENT':
      return { total: capped ? goal.maxFragments : null, active: capped ? goal.maxFragments : null };
    case 'PROBE':
    default:
      return { total: capped ? goal.maxProbes : null, active: capped ? goal.maxProbes : null };
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
 * So the total is taken through this row's own position in insertion order.
 * The first inserter ranks first and keeps the slot; the second ranks second,
 * sees it is over, and is the only one that stands down. Deterministic, no
 * mutual abort, and it generalises to amounts rather than counts.
 *
 * **The rank is `rowid`, and that is a correction.** It used to be
 * `(created_at, id)`, which is not an order at all when two reservations land
 * in the same millisecond: `id` is a random UUID, so the tie-break was a coin
 * toss, and roughly half the time the *second* caller ranked first and was
 * handed a slot the ceiling had already spent. The full suite found it under
 * load; three isolated runs of the same file did not, which is exactly how a
 * fifty-per-cent race hides.
 *
 * `rowid` — `seq` on Postgres, through the dialect — is insertion order,
 * strictly increasing, and supplied by the database rather than by the
 * claimant. That is the same property every other compare-and-swap in this
 * codebase depends on, and it is the third time the fix has been "rank by
 * something the caller cannot choose".
 *
 * `HELD` and unexpired, or already `SETTLED`. An expired hold counts for
 * nothing — that is what makes a crashed launch's reservation recoverable
 * without anybody sweeping it — and a released one counts for nothing, which is
 * what makes standing down safe.
 *
 * Both figures come from one pass over the same ranked rows, so they cannot
 * disagree about which reservations exist: `total` counts settled and live
 * work, `active` counts only what is still held. Two queries could see
 * different rows if one landed either side of a settlement.
 */
/**
 * What a grant has committed and what it still holds, per kind.
 *
 * The **same arithmetic** `totalsThroughMine` applies at the moment of
 * reservation, minus the rank clause that makes a race deterministic. It is
 * here, beside it, rather than in the projection that renders it — because the
 * projection had its own copy and the two had already drifted.
 *
 * `spendOf` counted **rows** (`.length`) while enforcement summed **`amount`**.
 * Every caller passes no amount today, so both come out the same by accident;
 * `reserve` takes one, and the first reservation of 2 would have enforced as 2
 * and displayed as 1. A person would have been told they had a mission left
 * while Russell refused to start one — §24's rule that the contract a person is
 * shown and the contract the validator enforces must be one object, broken in
 * the way that is hardest to notice, because it is right until it is not.
 *
 * Same predicates, said once: `committed` is `SETTLED` or unexpired `HELD` and
 * is what a total ceiling counts; `live` is unexpired `HELD` and is what a
 * concurrency ceiling counts. An expired hold is in neither, which is why
 * `renewLiveMissionReservations` exists.
 */
/**
 * The grant governing an orchestration, or null when nothing governs it.
 *
 * A packet reaches Russell's budget through the mission that launched it, and
 * only through that: a Step 9 or Step 10 packet has no Russell mission, so it
 * has no grant and is charged nothing. That is why the charges below can live
 * in the repository every creation path already goes through without changing
 * what those older steps do.
 */
async function goalForOrchestration(orchestrationId: string): Promise<RussellGoal | null> {
  // A packet reserved against a research goal says so on its own row, and that
  // is read first: it is what lets one goal's fragment ceiling span every
  // packet of the goal. Everything else falls back to the mission path.
  const linked = await getDb().all<{ goal_id: string | null }>(
    'SELECT goal_id FROM research_orchestrations WHERE id = ?',
    [orchestrationId],
  );
  const linkedGoalId = linked[0]?.goal_id ?? null;
  if (linkedGoalId) return getGoal(linkedGoalId);
  const rows = await getDb().all<{ goal_id: string | null }>(
    `SELECT goal_id FROM russell_missions
      WHERE orchestration_id = ? AND goal_id IS NOT NULL
      ORDER BY created_at, rowid LIMIT 1`,
    [orchestrationId],
  );
  const goalId = rows[0]?.goal_id ?? null;
  return goalId ? getGoal(goalId) : null;
}

export interface ChargeOutcome {
  ok: boolean;
  /** Safe to show a person, and the reason a packet parks when it is refused. */
  reason: string;
  /** Which ceiling refused, when one did. */
  refusedBy?: 'IN_TOTAL' | 'AT_ONCE';
  /** How many of these were already charged — a repair, a redelivery, a replay. */
  replayed: number;
  /**
   * Every reservation that now stands behind this charge, replays included.
   * The caller settles them once what they paid for exists, so a created
   * fragment counts for ever while a charge never followed by creation expires.
   */
  reservationIds: string[];
}

/**
 * Charge a grant for the bounded questions a packet is about to create.
 *
 * The owner's card says "Break them into at most 12 bounded questions" and
 * until now **nothing anywhere reserved a FRAGMENT**: that ceiling counted zero
 * for ever, whatever a packet did. The per-packet approval envelope bounds a
 * single plan's decomposition, which is a different control answering a
 * different question — it cannot enforce a cumulative allowance across
 * missions, and reading it as though it could is how a limit becomes
 * decoration.
 *
 * **Keyed on the fragment key, never on the attempt.** §15's repairs re-run the
 * same bounded question with a different search strategy, and a repaired
 * fragment is the same question — so a retry replays its reservation and is
 * charged once. A *split* produces new keys, and new keys are new questions,
 * which is exactly right: splitting a fragment in two does consume two of the
 * twelve.
 *
 * A refusal is reported rather than thrown, and it charges nothing: the caller
 * refuses the whole batch, so a packet never half-creates a plan it could not
 * pay for.
 */
export async function chargeFragments(input: {
  orchestrationId: string;
  fragmentKeys: string[];
}): Promise<ChargeOutcome> {
  const goal = await goalForOrchestration(input.orchestrationId);
  if (!goal) return { ok: true, reason: 'not governed by a standing authority', replayed: 0, reservationIds: [] };

  const taken: string[] = [];
  const standing: string[] = [];
  let replayed = 0;
  for (const key of input.fragmentKeys) {
    const outcome = await reserve({
      goalId: goal.id,
      kind: 'FRAGMENT',
      idempotencyKey: `russell:fragment:${input.orchestrationId}:${key}`,
    });
    if (!outcome.ok) {
      /*
       * Undo only what *this* call took. A reservation that replayed was
       * already spent by an earlier attempt and releasing it would refund
       * somebody's allowance on the strength of an unrelated refusal.
       */
      for (const id of taken) {
        await releaseReservation({ reservationId: id, reason: 'the plan was refused as a whole' });
      }
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.refusedBy ? { refusedBy: outcome.refusedBy } : {}),
        replayed,
        reservationIds: [],
      };
    }
    if (outcome.replayed) replayed += 1;
    else if (outcome.reservation) taken.push(outcome.reservation.id);
    if (outcome.reservation) standing.push(outcome.reservation.id);
  }
  return { ok: true, reason: 'charged', replayed, reservationIds: standing };
}

/**
 * Charge a grant for one cheap look.
 *
 * Keyed on the candidate, because `exploring()` opens at most one probe per
 * candidate and a second look at the same idea is the same look. Like
 * fragments, this ceiling reserved nothing before and therefore bounded
 * nothing; the per-probe lookup budget is a different control, about how far
 * one probe may reach rather than how many the owner allowed.
 */
export async function chargeProbe(input: {
  projectId: string;
  candidateId: string;
}): Promise<ChargeOutcome> {
  const goals = (await listGoals(input.projectId)).filter((goal) => goal.state === 'ACTIVE');
  const goal = goals[0];
  if (!goal) return { ok: true, reason: 'not governed by a standing authority', replayed: 0, reservationIds: [] };

  const outcome = await reserve({
    goalId: goal.id,
    kind: 'PROBE',
    idempotencyKey: `russell:probe:${input.candidateId}`,
  });
  return outcome.ok
    ? {
        ok: true,
        reason: 'charged',
        replayed: outcome.replayed ? 1 : 0,
        reservationIds: outcome.reservation ? [outcome.reservation.id] : [],
      }
    : {
        ok: false,
        reason: outcome.reason,
        ...(outcome.refusedBy ? { refusedBy: outcome.refusedBy } : {}),
        replayed: 0,
        reservationIds: [],
      };
}

export async function spendTotals(
  goalId: string,
  kind: ReservationKind,
  now: string,
): Promise<{ committed: number; live: number }> {
  const rows = await getDb().all<{ committed: number; live: number }>(
    `SELECT
        COALESCE(SUM(CASE
          WHEN state = 'SETTLED' OR (state = 'HELD' AND expires_at > ?) THEN amount
          ELSE 0 END), 0) AS committed,
        COALESCE(SUM(CASE
          WHEN state = 'HELD' AND expires_at > ? THEN amount
          ELSE 0 END), 0) AS live
       FROM russell_budget_reservations
      WHERE goal_id = ? AND kind = ?`,
    [now, now, goalId, kind],
  );
  return { committed: Number(rows[0]?.committed ?? 0), live: Number(rows[0]?.live ?? 0) };
}

async function totalsThroughMine(
  goalId: string,
  kind: ReservationKind,
  now: string,
  mine: RussellReservationRow,
): Promise<{ total: number; active: number }> {
  const rows = await getDb().all<{ total: number; active: number }>(
    `SELECT
        COALESCE(SUM(CASE
          WHEN state = 'SETTLED' OR (state = 'HELD' AND expires_at > ?) THEN amount
          ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE
          WHEN state = 'HELD' AND expires_at > ? THEN amount
          ELSE 0 END), 0) AS active
       FROM russell_budget_reservations
      WHERE goal_id = ? AND kind = ?
        AND rowid <= (SELECT rowid FROM russell_budget_reservations WHERE id = ?)`,
    [now, now, goalId, kind, mine.id],
  );
  return { total: Number(rows[0]?.total ?? 0), active: Number(rows[0]?.active ?? 0) };
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

/**
 * Move a live grant's concurrency, and nothing else about it.
 *
 * Concurrency is provider capacity rather than an allowance (§24), so it is the
 * one term of a standing authority that can be corrected without re-deciding
 * what was authorized: the work class, the prohibitions, the spend ceiling and
 * the owner are all untouched, and a grant that is not ACTIVE is refused.
 *
 * Narrow by construction — one column, guarded on the row still being live —
 * because a general "update a grant" would be a way to widen one.
 */
export async function setGoalConcurrency(goalId: string, maxConcurrent: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_goals SET max_concurrent = ?, updated_at = ?
      WHERE id = ? AND state = 'ACTIVE'`,
    [Math.max(0, Math.trunc(maxConcurrent)), nowIso(), goalId],
  );
  return result.changes === 1;
}

/**
 * Push a live reservation's expiry out, so time does not refund a budget.
 *
 * The TTL is what stops a crashed launch holding a slot for ever, and that is
 * worth keeping — but it must not decide that a mission which is still running
 * was never started. `renewLiveMissionReservations` calls this each tick for
 * reservations whose mission is still alive, which turns the TTL from "this
 * work took too long" into "nothing has tended this in two hours".
 *
 * Guarded on `HELD`: a settled or released reservation is finished with, and
 * renewing one would resurrect spend that had been accounted for.
 */
export async function renewReservation(
  reservationId: string,
  ttlMinutes = 120,
): Promise<boolean> {
  const now = authorityNow();
  const expires = new Date(Date.parse(now) + Math.max(1, ttlMinutes) * 60_000).toISOString();
  const result = await getDb().run(
    `UPDATE russell_budget_reservations SET expires_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [expires, reservationId],
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

/*
 * Research goals: a bounded budget for one piece of research.
 *
 * This extends the owner above rather than adding a second quota system. A
 * research goal is a `russell_goals` row with `purpose = 'RESEARCH_GOAL'`, a
 * CAPPED policy, and the same reservation ledger doing the same arithmetic:
 *
 *   - **a packet is the research goal's mission.** `max_missions` is the
 *     packet ceiling and a packet is reserved as kind `MISSION`; a new
 *     reservation kind would be a second vocabulary for one count. The key is
 *     `research:packet:<goalId>:<packetKey>`, so a replay is the same packet
 *     and is charged once. `max_concurrent` equals `max_missions`, so the
 *     concurrency check can never be the one that refuses a packet.
 *   - **a fragment is a fragment.** `chargeFragments` already reserves them and
 *     now resolves the governing goal from `research_orchestrations.goal_id`
 *     first, so `max_fragments` is enforced across every packet of the goal.
 *   - **money is pinned at zero.** `max_external_spend` is 0, `max_probes` is 0
 *     and `ALWAYS_PROHIBITED` (which names PAID_OVERAGE) is unioned in; there
 *     is no input that raises any of them (invariant 18).
 *   - **the deadline is `expires_at`, judged on Brain's clock** —
 *     `authorityNow()`, the same one `reserve` and `checkAuthority` use, and
 *     nothing else. After it no packet or fragment reservation succeeds; rows
 *     already written are never touched.
 *
 * A research goal is invisible to every standing-authority reader
 * (`checkAuthority`, `listGoals`, `liveGoalNamed`, and so `authorityFor`,
 * `chargeProbe` and `ensureGoal`'s read-back), so it never becomes Russell's
 * standing grant.
 */

export async function createResearchGoal(input: {
  projectId: string;
  ownerUserId: string;
  createdByUserId: string;
  name: string;
  maxPackets: number;
  maxFragments: number;
  deadline: string;
  /** Accepted only to be refused: nothing here may carry money. */
  paidOverages?: boolean;
}): Promise<RussellGoal> {
  // Read off an untyped view, because no spend field is part of this input's
  // contract; a caller that sends one (from JSON, say) is refused, not ignored.
  const spend = (input as Record<string, unknown>).maxExternalSpend;
  if ((spend !== undefined && spend !== null && Number(spend) !== 0) || input.paidOverages) {
    throw new Error('A research goal cannot carry external spend or paid overages.');
  }
  if (!Number.isInteger(input.maxPackets) || input.maxPackets < 1) {
    throw new Error('A research goal needs a packet ceiling that is a positive whole number.');
  }
  if (!Number.isInteger(input.maxFragments) || input.maxFragments < 1) {
    throw new Error('A research goal needs a fragment ceiling that is a positive whole number.');
  }
  if (!input.name.trim()) throw new Error('A research goal needs a name.');
  const deadlineMs = Date.parse(input.deadline);
  if (!Number.isFinite(deadlineMs)) throw new Error('A research goal needs a deadline that is a real date.');
  const at = authorityNow();
  const deadline = new Date(deadlineMs).toISOString();
  if (deadline <= at) throw new Error('A research goal needs a deadline that has not already passed.');

  const id = newId('rgl');
  await getDb().run(
    `INSERT INTO russell_goals
       (id, project_id, owner_user_id, name, policy_version, allowed_work, prohibitions,
        max_missions, max_fragments, max_concurrent, max_probes, max_external_spend,
        work_policy, purpose,
        starts_at, expires_at, state, revoked_at, revoked_by_user_id, revoked_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0, 'CAPPED', 'RESEARCH_GOAL',
             ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.ownerUserId,
      input.name,
      toJson(['RESEARCH']),
      toJson([...ALWAYS_PROHIBITED]),
      input.maxPackets,
      input.maxFragments,
      input.maxPackets,
      at,
      deadline,
      input.createdByUserId,
      at,
      at,
    ],
  );
  const created = await getGoal(id);
  if (!created) throw new Error('The research goal disappeared immediately after being written.');
  return created;
}

/** Which ceiling or condition stopped a packet, in a form a caller can switch on. */
export type GoalPacketRefusal =
  | 'PACKETS'
  | 'CONCURRENCY'
  | 'DEADLINE'
  | 'REVOKED'
  | 'PAUSED'
  | 'WRONG_PROJECT'
  | 'NOT_A_RESEARCH_GOAL'
  | 'UNAVAILABLE';

export interface GoalPacketOutcome {
  ok: boolean;
  reservation: RussellReservation | null;
  /** Null when ok. */
  refusedBy: GoalPacketRefusal | null;
  /** Safe to show a person; names the ceiling and never an id. */
  reason: string;
  /** True when this key already held a packet: the same packet, charged once. */
  replayed: boolean;
}

export function goalPacketKey(goalId: string, packetKey: string): string {
  return `research:packet:${goalId}:${packetKey}`;
}

/**
 * Reserve one packet against a research goal.
 *
 * The conditions are checked here only to *name* the refusal; `reserve` checks
 * them again inside the same call, so a goal revoked or expired between the
 * two is still refused and is reported by what it is now.
 */
export async function reserveGoalPacket(input: {
  goalId: string;
  packetKey: string;
  projectId: string;
  at?: string;
}): Promise<GoalPacketOutcome> {
  const refuse = (refusedBy: GoalPacketRefusal, reason: string): GoalPacketOutcome => ({
    ok: false,
    reservation: null,
    refusedBy,
    reason,
    replayed: false,
  });
  const now = input.at ?? authorityNow();
  const goal = await getGoal(input.goalId);
  if (!goal || goal.purpose !== 'RESEARCH_GOAL') {
    return refuse('NOT_A_RESEARCH_GOAL', 'there is no research goal with that id');
  }
  if (goal.projectId !== input.projectId) {
    return refuse('WRONG_PROJECT', 'this research goal belongs to a different project');
  }
  const why = goalStopReason(goal, now);
  if (why) return refuse(why.refusedBy, why.reason);
  if (!input.packetKey.trim()) return refuse('UNAVAILABLE', 'a packet needs a key');

  const outcome = await reserve({
    goalId: goal.id,
    kind: 'MISSION',
    idempotencyKey: goalPacketKey(goal.id, input.packetKey),
    at: now,
  });
  if (outcome.ok) {
    return {
      ok: true,
      reservation: outcome.reservation,
      refusedBy: null,
      reason: outcome.replayed ? 'this packet was already reserved' : 'reserved',
      replayed: outcome.replayed,
    };
  }
  if (outcome.refusedBy === 'IN_TOTAL') {
    return refuse('PACKETS', `this research goal allows ${goal.maxMissions} packet(s) and they are all used`);
  }
  if (outcome.refusedBy === 'AT_ONCE') {
    return refuse('CONCURRENCY', 'this research goal has no free packet slot right now');
  }
  const latest = await getGoal(goal.id);
  const stopped = latest ? goalStopReason(latest, authorityNow()) : null;
  return stopped ? refuse(stopped.refusedBy, stopped.reason) : refuse('UNAVAILABLE', outcome.reason);
}

function goalStopReason(
  goal: RussellGoal,
  now: string,
): { refusedBy: GoalPacketRefusal; reason: string } | null {
  if (goal.state === 'REVOKED') return { refusedBy: 'REVOKED', reason: 'this research goal was withdrawn' };
  if (goal.state !== 'ACTIVE') return { refusedBy: 'PAUSED', reason: `this research goal is ${goal.state.toLowerCase()}` };
  if (goal.expiresAt && goal.expiresAt <= now) {
    return { refusedBy: 'DEADLINE', reason: 'this research goal has passed its deadline' };
  }
  return null;
}

/**
 * Record that a reserved packet now exists, and settle what paid for it.
 *
 * The link is a guarded `UPDATE` on `goal_id IS NULL`, so two callers cannot
 * point one packet at two goals, and the unique `(goal_id, goal_packet_key)`
 * index means one packet key is at most one orchestration. A reservation that
 * is never followed by this call stays `HELD`, expires and refunds itself —
 * that is the restart semantics, and nothing sweeps it.
 */
export async function bindPacketToGoal(input: {
  orchestrationId: string;
  goalId: string;
  packetKey: string;
}): Promise<boolean> {
  const goal = await getGoal(input.goalId);
  if (!goal || goal.purpose !== 'RESEARCH_GOAL') return false;
  const now = authorityNow();
  /*
   * The link and the settlement are one transaction, so there is no window in
   * which a packet is linked and its reservation is left to expire and refund,
   * and none in which a charge is settled for a packet that was never linked.
   * It binds only against a reservation that actually stands for this key —
   * unexpired `HELD`, since a lapsed one counts for nothing and has to be
   * re-reserved (and so re-judged against the ceiling) before it can be spent.
   */
  return getDb().transaction(async () => {
    const held = await getDb().all<{ id: string; state: string; expires_at: string }>(
      'SELECT id, state, expires_at FROM russell_budget_reservations WHERE idempotency_key = ? AND goal_id = ?',
      [goalPacketKey(input.goalId, input.packetKey), input.goalId],
    );
    const reservation = held[0];
    if (!reservation) return false;
    const standing =
      reservation.state === 'SETTLED' || (reservation.state === 'HELD' && reservation.expires_at > now);
    if (!standing) return false;
    const linked = await getDb().run(
      `UPDATE research_orchestrations SET goal_id = ?, goal_packet_key = ?
        WHERE id = ? AND goal_id IS NULL`,
      [input.goalId, input.packetKey, input.orchestrationId],
    );
    if (linked.changes !== 1) return false;
    if (reservation.state === 'HELD') await settleReservation(reservation.id);
    return true;
  });
}

export interface GoalBudgetStatus {
  goalId: string;
  name: string;
  /** What the goal is now: its own state, or EXPIRED once the deadline has passed. */
  state: GoalState | 'EXPIRED';
  packets: { used: number; reserved: number; ceiling: number };
  fragments: { committed: number; ceiling: number };
  deadline: string | null;
  authorizedBy: string;
  createdAt: string;
}

/**
 * Where a research goal stands. Narrow indexed reads only: one COUNT on
 * `research_orchestrations (goal_id)` and two `spendTotals`.
 *
 * `used` is packets that exist; `reserved` is what the ledger holds for
 * packets, which also counts a reservation whose packet is not yet created.
 */
export async function goalBudgetStatus(goalId: string, at?: string): Promise<GoalBudgetStatus | null> {
  const goal = await getGoal(goalId);
  if (!goal || goal.purpose !== 'RESEARCH_GOAL') return null;
  const now = at ?? authorityNow();
  const counted = await getDb().all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM research_orchestrations WHERE goal_id = ?',
    [goal.id],
  );
  const packets = await spendTotals(goal.id, 'MISSION', now);
  const fragments = await spendTotals(goal.id, 'FRAGMENT', now);
  const expired = goal.expiresAt !== null && goal.expiresAt <= now;
  return {
    goalId: goal.id,
    name: goal.name,
    state: goal.state === 'ACTIVE' && expired ? 'EXPIRED' : goal.state,
    packets: { used: Number(counted[0]?.n ?? 0), reserved: packets.committed, ceiling: goal.maxMissions },
    fragments: { committed: fragments.committed, ceiling: goal.maxFragments },
    deadline: goal.expiresAt,
    authorizedBy: goal.createdByUserId,
    createdAt: goal.createdAt,
  };
}
