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
    invitationRequestedAt: row.invitation_requested_at,
    invitationIssuedAt: row.invitation_issued_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    revokedByUserId: row.revoked_by_user_id,
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
 * Attach a probe bin, and refuse if this connection already has one.
 *
 * ---------------------------------------------------------------------------
 * Two wrong answers, and the Postgres suite found the second
 * ---------------------------------------------------------------------------
 *
 * The first version created the bin and swapped the state afterwards, so two
 * concurrent presses both passed the no-live-probe check and both built one.
 *
 * The second version claimed first — `UPDATE … SET state = 'PROBE_SENT' WHERE
 * state = ?`, with `?` being the state the caller had just read. It passed on
 * SQLite, where writers are serialized and the second caller's read always saw
 * the first caller's `CONFIGURED`, so its claim matched nothing. On Postgres the
 * round trips are slow enough that the second caller reads `PROBE_SENT` — and
 * then **claims `WHERE state = 'PROBE_SENT'`, which is exactly the state it was
 * supposed to be claiming into.** A guard satisfied by the thing it is guarding
 * against is not a guard. `expected 2 to be 1`, on the backend production runs.
 *
 * ---------------------------------------------------------------------------
 * What is actually claimed
 * ---------------------------------------------------------------------------
 *
 * `probe_bin_id IS NULL`, which is the one value that means *nobody holds this
 * yet* and is not also the value a winner writes. A caller makes its bin as a
 * **DRAFT** — which `DISPATCHABLE_SQL` does not select, so it cannot be fired —
 * offers it here, and only the winner's bin is then marked READY. The loser
 * cancels a bin that was never dispatchable, so there is no window for a double
 * fire to live in and no orphan left behind.
 *
 * This is §20's reconcilable-effect shape rather than claim-then-act, and the
 * difference is that the effect here is *Brain's own row*: a DRAFT bin can be
 * cancelled, so making one speculatively costs nothing that cannot be given
 * back. An external effect could not be treated this way.
 */
export async function attachProbe(input: {
  connectionId: string;
  binId: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET probe_bin_id = ?, probe_sent_at = ?, state = 'PROBE_SENT',
            failure_reason = NULL, updated_at = ?
      WHERE id = ? AND probe_bin_id IS NULL`,
    [input.binId, at, at, input.connectionId],
  );
  return result.changes === 1;
}

/**
 * Let go of a probe that has been answered or abandoned, so another may be sent.
 *
 * Guarded on the bin the caller believes is there, so two readers of a spent
 * probe produce one release. Retrying is what this is for: `sendProbe` clears a
 * cancelled, failed or escalated probe before offering a new one, and that is
 * what makes "a failed probe can be retried without creating another account or
 * Routine" true of the rows.
 */
export async function releaseProbe(input: {
  connectionId: string;
  binId: string;
  to: CapacityConnectionState;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET probe_bin_id = NULL, probe_sent_at = NULL, state = ?, updated_at = ?
      WHERE id = ? AND probe_bin_id = ?`,
    [input.to, nowIso(), input.connectionId, input.binId],
  );
  return result.changes === 1;
}

/**
 * Record that the member has asked for their one-time connector link.
 *
 * Guarded on `invitation_requested_at IS NULL`, which is the value actually
 * being claimed rather than the state beside it — the same correction
 * `setTrigger` carries, for the same reason. Two tabs produce one request and
 * one ordinary loser, and a member who presses it again after a week is told
 * what they already asked for rather than moving an administrator's queue.
 *
 * It is deliberately not conditional on the state: a connection sitting at
 * `REVOKED` or `MISBOUND` may still be waiting for a link, and a guard that
 * named one state would have to name all of them.
 */
export async function requestInvitation(input: {
  connectionId: string;
  to: CapacityConnectionState;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET invitation_requested_at = ?, state = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ? AND invitation_requested_at IS NULL`,
    [at, input.to, at, input.connectionId],
  );
  return result.changes === 1;
}

/**
 * Record that an administrator issued one.
 *
 * Not guarded, and that is deliberate: issuing is a **rotation** as much as a
 * setup — `issueConnectorInvitation` revokes what was live before minting the
 * next — so the second issue is a real event and the stamp must move with it.
 * What it must never do is move a state backwards, so it leaves `state` alone
 * entirely and the reconciliation on the read path decides where the row is.
 */
export async function recordInvitationIssued(connectionId: string): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `UPDATE capacity_connections SET invitation_issued_at = ?, updated_at = ? WHERE id = ?`,
    [at, at, connectionId],
  );
}

/**
 * Give a connection back.
 *
 * Guarded on `revoked_at IS NULL` so two presses revoke once, and on nothing
 * else: every state is revocable, including a half-finished one, because the
 * question a person is answering is *do I want this Brain firing my Claude
 * account* and that has the same answer at every step of the setup.
 *
 * Nothing is deleted. The trigger, the account, the Routine, the probe and the
 * proof timestamp all stay, which is what makes `reconnect` a resumption rather
 * than a second registration.
 */
export async function revokeConnection(input: {
  connectionId: string;
  reason: string;
  byUserId: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET state = 'REVOKED', revoked_at = ?, revoked_reason = ?, revoked_by_user_id = ?,
            failure_reason = NULL, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL`,
    [at, input.reason, input.byUserId, at, input.connectionId],
  );
  return result.changes === 1;
}

/**
 * Put a revoked connection back into the journey.
 *
 * Guarded on the row still being `REVOKED`, so a reconnect cannot resurrect a
 * connection somebody is mid-way through repairing. It clears `revoked_at`
 * because that column is what `revokeConnection` claims on — leaving it set
 * would make the next revoke a silent no-op — and keeps `revoked_reason` and
 * `revoked_by_user_id`, which are history and do not stop having happened.
 *
 * It returns to `NOT_STARTED` rather than to wherever it was. The tokens were
 * revoked, so the connector genuinely has to be approved again, and a state
 * claiming otherwise would be the false-settled reading §29 keeps correcting.
 *
 * **Both invitation stamps are cleared with it, and that is the half a reading
 * of this function alone would miss.** Revoking revokes the member's live
 * invitation as well as their tokens, so after a reconnect the link that
 * `invitation_issued_at` records no longer works — and leaving that stamp set
 * would show the first step as *done* while the person holds nothing they can
 * open, which is the step-that-cannot-be-taken this whole journey was rewritten
 * to remove. Clearing `invitation_requested_at` beside it is what makes the ask
 * available again; the request was answered, the answer was withdrawn, and the
 * audit of both is on `identity_events` rather than on these two columns.
 */
export async function reconnectConnection(connectionId: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE capacity_connections
        SET state = 'NOT_STARTED', revoked_at = NULL, failure_reason = NULL,
            invitation_requested_at = NULL, invitation_issued_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'REVOKED'`,
    [at, connectionId],
  );
  return result.changes === 1;
}
