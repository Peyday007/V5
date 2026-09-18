/**
 * One member's Claude connection, as rows rather than as a conversation.
 *
 * Setup is durable and resumable because it has to be: the one step Brain
 * cannot perform — putting the trigger's bearer into the deployment
 * environment — belongs to a Brain administrator, and however long they take,
 * refreshing the page, restarting the server or firing a tick must not lose
 * what the member already did.
 *
 * Every write here is guarded on something the caller does not supply. There is
 * no read-then-write anywhere in this file, which is the same reason it is the
 * same reason everywhere else in this codebase: two ticks, two tabs or two
 * instances must produce one effect and one ordinary refusal.
 *
 * **No credential of any shape is stored here.** The trigger's bearer never
 * reaches Brain's database — `resolveToken` reads `process.env[secretName]` and
 * `fleet_routines` keeps the *name* of that variable plus a digest taken at
 * registration. What this table holds is a trig_… id, which is an address
 * rather than a secret, and three names Brain assigned.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  CapacityConnection,
  CapacityConnectionRow,
  CapacityConnectionState,
} from '../domain/types.ts';

function map(row: CapacityConnectionRow): CapacityConnection {
  return {
    id: row.id,
    userId: row.user_id,
    connectorName: row.connector_name,
    routineName: row.routine_name,
    secretName: row.secret_name,
    triggerRef: row.trigger_ref,
    accountId: row.account_id,
    routineId: row.routine_id,
    state: row.state as CapacityConnectionState,
    failureReason: row.failure_reason,
    probeBinId: row.probe_bin_id,
    probeSentAt: row.probe_sent_at,
    healthyAt: row.healthy_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnection(id: string): Promise<CapacityConnection | null> {
  const row = await getDb().get<CapacityConnectionRow>(
    'SELECT * FROM capacity_connections WHERE id = ?',
    [id],
  );
  return row ? map(row) : null;
}

export async function connectionForUser(userId: string): Promise<CapacityConnection | null> {
  const row = await getDb().get<CapacityConnectionRow>(
    'SELECT * FROM capacity_connections WHERE user_id = ?',
    [userId],
  );
  return row ? map(row) : null;
}

export async function listConnections(): Promise<CapacityConnection[]> {
  // Ordered on a real column and tiebroken on the primary key. `rowid` is
  // rewritten to `seq` by `dialect.ts` and an `ORDER BY` that is sayable in one
  // dialect only is how three production statements have already broken.
  return (
    await getDb().all<CapacityConnectionRow>(
      'SELECT * FROM capacity_connections ORDER BY created_at, id',
    )
  ).map(map);
}

/**
 * Start one, or hand back the one that is already there.
 *
 * Idempotent by the unique index on `user_id`, never by reading first: a member
 * opening the page in two tabs, or a page that reloads while the first request
 * is in flight, must produce one connection and one set of assigned names. The
 * loser of the insert reads the winner's row, which is the same shape
 * `ensureDispatchIntent` has used since Step 10.
 *
 * The three names are assigned here and never rewritten. The secret's name in
 * particular is what an administrator is told to set, and one that moved after
 * they were told would send them to set a variable nothing reads.
 */
export async function ensureConnection(input: {
  userId: string;
  connectorName: string;
  routineName: string;
  secretName: string;
}): Promise<CapacityConnection> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO capacity_connections
       (id, user_id, connector_name, routine_name, secret_name, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'NOT_STARTED', ?, ?)
     ON CONFLICT (user_id) DO NOTHING`,
    [newId('cxn'), input.userId, input.connectorName, input.routineName, input.secretName, at, at],
  );
  const existing = await connectionForUser(input.userId);
  if (!existing) throw new Error('The connection row disappeared immediately after being written.');
  return existing;
}

/**
 * Record the trigger the member read out of Claude.
 *
 * **Guarded on the trigger still being unset, not on the state**, and that is a
 * correction rather than a preference. The first version compared the *state*,
 * which is not the value being claimed: a submission naming a different trigger
 * matched the guard, succeeded, and silently replaced a recorded one — while
 * the caller's refusal, written for exactly that case, could never fire because
 * the write had already reported success. Worse, once a Routine is registered
 * the row's trigger and `fleet_routines.routine_ref` would then disagree, which
 * is Brain firing one surface while its own record names another.
 *
 * `trigger_ref IS NULL` is a compare-and-swap on the thing actually being
 * claimed. Two tabs submitting the same id produce one write and one ordinary
 * loser, and the loser re-reads the row and finds what it wanted already true —
 * idempotency means the effect is present after either call, not that the
 * second call does nothing. A *different* id is refused by the caller before
 * this is reached, because a refusal after a successful write is not a refusal.
 */
export async function setTrigger(input: {
  connectionId: string;
  triggerRef: string;
  to: CapacityConnectionState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET trigger_ref = ?, state = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ? AND trigger_ref IS NULL`,
    [input.triggerRef, input.to, nowIso(), input.connectionId],
  );
  return result.changes === 1;
}

/** Attach what registration produced. Guarded on the row not already holding one. */
export async function setRegistration(input: {
  connectionId: string;
  accountId: string;
  routineId: string;
  state: CapacityConnectionState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET account_id = ?, routine_id = ?, state = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ? AND routine_id IS NULL`,
    [input.accountId, input.routineId, input.state, nowIso(), input.connectionId],
  );
  return result.changes === 1;
}

/**
 * Move a connection's state, saying which state it is moving *from*.
 *
 * A compare-and-swap rather than an assignment, so a tick deriving `HEALTHY`
 * cannot overwrite a `FAILED` an administrator's action has just written, and
 * two ticks reading the same row produce one transition.
 */
export async function moveConnection(input: {
  connectionId: string;
  from: CapacityConnectionState;
  to: CapacityConnectionState;
  failureReason?: string | null;
  healthy?: boolean;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET state = ?, failure_reason = ?, healthy_at = ${input.healthy ? '?' : 'healthy_at'},
            updated_at = ?
      WHERE id = ? AND state = ?`,
    input.healthy
      ? [input.to, input.failureReason ?? null, at, at, input.connectionId, input.from]
      : [input.to, input.failureReason ?? null, at, input.connectionId, input.from],
  );
  return result.changes === 1;
}

/**
 * Claim the right to send a probe, before one exists.
 *
 * **The claim comes first and the bin second**, which is §24's own rule: the
 * queue is at-least-once and an effect performed before the guard is an effect
 * that repeats. The first version created the bin and *then* compare-and-swapped
 * the state, so two concurrent presses both built a bin and one of them lost the
 * swap — two activations against one surface for one question, which is exactly
 * the double fire the whole dispatch design exists to prevent. The sequential
 * case was caught by an early return and the concurrent one was not.
 *
 * The window this opens loses a *claim* rather than an effect: a caller that
 * claims and then fails to create the bin leaves `PROBE_SENT` with no
 * `probe_bin_id`, and the read path derives that straight back to `CONFIGURED`
 * because it maps the bin's presence rather than remembering the state. Visibly
 * retryable beats silently doubled.
 */
export async function claimProbe(input: {
  connectionId: string;
  from: CapacityConnectionState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET state = 'PROBE_SENT', probe_bin_id = NULL, probe_sent_at = NULL,
            failure_reason = NULL, updated_at = ?
      WHERE id = ? AND state = ?`,
    [nowIso(), input.connectionId, input.from],
  );
  return result.changes === 1;
}

/** Attach the bin the claim above authorized. Guarded on there being none. */
export async function attachProbe(input: {
  connectionId: string;
  binId: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET probe_bin_id = ?, probe_sent_at = ?, updated_at = ?
      WHERE id = ? AND state = 'PROBE_SENT' AND probe_bin_id IS NULL`,
    [input.binId, at, at, input.connectionId],
  );
  return result.changes === 1;
}

/** Give the claim back when the bin could not be made. */
export async function releaseProbeClaim(input: {
  connectionId: string;
  to: CapacityConnectionState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET state = ?, updated_at = ?
      WHERE id = ? AND state = 'PROBE_SENT' AND probe_bin_id IS NULL`,
    [input.to, nowIso(), input.connectionId],
  );
  return result.changes === 1;
}
