/**
 * Russell's loop, as a row.
 *
 * The requirement this satisfies is short and unforgiving: **Russell keeps
 * working while nobody is on the site and the laptop is closed.** That rules out
 * anything whose correctness depends on a process staying alive, so the cycle's
 * position, its ownership, its pause state and its amplification bounds are all
 * persisted, and a restart resumes from rows rather than from memory.
 *
 * One row, `singleton`, created by the migration. Three things about it matter.
 *
 * **Ownership is a compare-and-swap on `generation`.** Two instances may both
 * read generation 7 and both try to take the tick; the `UPDATE` says
 * `WHERE generation = 7`, so exactly one matches. This is the fourth time this
 * codebase has needed the same sentence — a compare-and-swap has to be on a
 * value the claimant does not supply — after `work_items.lease_generation`,
 * `bin_dispatch`'s state swap and `fleet_routines.fire_generation`.
 *
 * **An expired lease is claimable.** So recovery never depends on the previous
 * owner shutting down cleanly, and there is no sweeper whose absence breaks
 * anything.
 *
 * **The bounds are rows, not constants.** `max_launches_per_cycle` and
 * `max_followons_per_cycle` are what stop Russell's own output from becoming
 * its own input in an unbounded chain, and an operator can lower them — or stop
 * the loop outright — without a deployment.
 */
import { getDb } from '../db/database.ts';
import { nowIso } from './util.ts';
import type { CycleState, RussellCycle, RussellCycleRow } from '../domain/types.ts';

export const CYCLE_ID = 'singleton';

/** The Brain's clock. Named once, for the same reason `queueNow()` is. */
export function cycleNow(): string {
  return nowIso();
}

function mapCycle(row: RussellCycleRow): RussellCycle {
  return {
    id: row.id,
    generation: row.generation,
    cursorAt: row.cursor_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    state: row.state as CycleState,
    pauseReason: row.pause_reason,
    pausedByUserId: row.paused_by_user_id,
    maxLaunchesPerCycle: row.max_launches_per_cycle,
    maxFollowonsPerCycle: row.max_followons_per_cycle,
    maxEventsPerCycle: row.max_events_per_cycle,
    maxRetryAgeMinutes: row.max_retry_age_minutes,
    lastRanAt: row.last_ran_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCycle(): Promise<RussellCycle | null> {
  const rows = await getDb().all<RussellCycleRow>('SELECT * FROM russell_cycle WHERE id = ?', [
    CYCLE_ID,
  ]);
  return rows[0] ? mapCycle(rows[0]) : null;
}

export interface CycleClaim {
  ok: boolean;
  cycle: RussellCycle | null;
  /** The generation this owner must present to keep or release the lease. */
  generation: number | null;
  reason: string;
}

/**
 * Take the tick, or lose the race.
 *
 * Losing is an ordinary outcome, not an error: another instance is running the
 * cycle and this one has nothing to do. The mechanism errs toward not running —
 * a tick missed now runs ten seconds later, and a tick run twice could launch a
 * mission nobody asked for.
 *
 * A `PAUSED` or `STOPPED` cycle refuses every claim, which is what makes the
 * emergency stop immediate rather than eventual: no new work is started, and
 * whatever was already accepted is untouched.
 */
export async function claimCycle(input: {
  owner: string;
  leaseMs?: number;
  at?: string;
}): Promise<CycleClaim> {
  const current = await getCycle();
  if (!current) return { ok: false, cycle: null, generation: null, reason: 'the cycle row is missing' };
  if (current.state !== 'RUNNING') {
    return {
      ok: false,
      cycle: current,
      generation: null,
      reason: `the cycle is ${current.state.toLowerCase()}`,
    };
  }

  const now = input.at ?? cycleNow();
  const held = current.leaseExpiresAt !== null && current.leaseExpiresAt > now;
  if (held && current.leaseOwner !== input.owner) {
    return { ok: false, cycle: current, generation: null, reason: 'another instance holds the cycle' };
  }

  const next = current.generation + 1;
  const expires = new Date(Date.parse(now) + Math.max(1_000, input.leaseMs ?? 60_000)).toISOString();
  const result = await getDb().run(
    `UPDATE russell_cycle
        SET generation = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND generation = ? AND state = 'RUNNING'`,
    [next, input.owner, expires, now, CYCLE_ID, current.generation],
  );
  if (result.changes !== 1) {
    return { ok: false, cycle: await getCycle(), generation: null, reason: 'lost the race for the cycle' };
  }
  return { ok: true, cycle: await getCycle(), generation: next, reason: 'claimed' };
}

/**
 * Finish a tick and record where it got to.
 *
 * Fenced on the generation the owner was given, so a slow tick whose lease
 * expired and was retaken cannot write over the new owner's cursor. A late
 * writer matches nothing and is told so.
 */
export async function completeCycle(input: {
  owner: string;
  generation: number;
  cursorAt?: string | null;
  error?: string | null;
}): Promise<boolean> {
  const at = cycleNow();
  const result = await getDb().run(
    `UPDATE russell_cycle
        SET lease_owner = NULL, lease_expires_at = NULL, last_ran_at = ?, last_error = ?,
            cursor_at = COALESCE(?, cursor_at), updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ?`,
    [at, input.error ?? null, input.cursorAt ?? null, at, CYCLE_ID, input.generation, input.owner],
  );
  return result.changes === 1;
}

/**
 * Stop Russell starting anything new.
 *
 * The kill switch, and it is deliberately a row rather than an environment
 * variable: it takes effect on the next claim with no deployment, it records who
 * did it and why, and it is reversible by the same route. Queued candidates and
 * held reservations survive it — pausing preserves work rather than discarding
 * it.
 */
export async function pauseCycle(input: {
  reason: string;
  actorUserId?: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_cycle
        SET state = 'PAUSED', pause_reason = ?, paused_by_user_id = ?,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [input.reason, input.actorUserId ?? null, cycleNow(), CYCLE_ID],
  );
  return result.changes === 1;
}

export async function resumeCycle(): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_cycle
        SET state = 'RUNNING', pause_reason = NULL, paused_by_user_id = NULL, updated_at = ?
      WHERE id = ? AND state = 'PAUSED'`,
    [cycleNow(), CYCLE_ID],
  );
  return result.changes === 1;
}

/**
 * Change the amplification bounds.
 *
 * Operator-owned, auditable, and needing no deployment — the same principle
 * Step 11 applied to fleet targets. Raising a bound is a policy decision;
 * lowering one takes effect on the next tick.
 */
export async function setCycleBounds(input: {
  maxLaunchesPerCycle?: number;
  maxFollowonsPerCycle?: number;
  maxEventsPerCycle?: number;
  maxRetryAgeMinutes?: number;
}): Promise<boolean> {
  const current = await getCycle();
  if (!current) return false;
  const result = await getDb().run(
    `UPDATE russell_cycle
        SET max_launches_per_cycle = ?, max_followons_per_cycle = ?,
            max_events_per_cycle = ?, max_retry_age_minutes = ?, updated_at = ?
      WHERE id = ?`,
    [
      Math.max(0, input.maxLaunchesPerCycle ?? current.maxLaunchesPerCycle),
      Math.max(0, input.maxFollowonsPerCycle ?? current.maxFollowonsPerCycle),
      Math.max(1, input.maxEventsPerCycle ?? current.maxEventsPerCycle),
      Math.max(1, input.maxRetryAgeMinutes ?? current.maxRetryAgeMinutes),
      cycleNow(),
      CYCLE_ID,
    ],
  );
  return result.changes === 1;
}
