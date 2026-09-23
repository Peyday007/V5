/**
 * The fleet: which accounts exist, which Routines belong to them, and how hard
 * Brain is currently allowed to push each one.
 *
 * Step 10's fleet was `fireConfig()` — two environment variables read at call
 * time. That was the correct amount of machinery for proving a dispatcher works
 * and the wrong amount for running more than one account, because it can only
 * ever name one Routine and changing it needs a deployment.
 *
 * Three rules shape everything below, and none of them is visible from any one
 * function:
 *
 *   1. **An account is not a Routine.** An account has a subscription
 *      allowance; a Routine has a fire surface. Two Routines under one account
 *      double how fast Brain can *start* sessions and change nothing about how
 *      much that account may *do*. Step 10 measured the fire ceiling and was
 *      explicit that it had not measured the allowance. Collapsing the two here
 *      would bake that confusion into the schema.
 *
 *   2. **A row never holds a credential.** It holds the *name* of the
 *      deployment secret and a digest of the value taken once at registration.
 *      That is the Step 4 rule for worker credentials and the Step 8 rule for
 *      OAuth tokens, applied to the one credential Step 10 left in the
 *      environment.
 *
 *   3. **Policy is rows, not configuration.** Raising a target is an INSERT
 *      carrying an actor and a reason, so it needs no deployment, the previous
 *      value is still there to revert to, and every change is in the audit
 *      trail. The current policy for a scope is its highest version — the
 *      "latest row wins, history stays" shape `research_fragments` already uses
 *      for attempts.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { recordIdentityEvent } from './identity.ts';
import type {
  CapacityEvidence,
  FleetAccount,
  FleetAccountRow,
  FleetAccountKind,
  FleetPolicy,
  FleetPolicyRow,
  FleetRoutine,
  FleetRoutineRow,
  FleetState,
  PolicyScope,
} from '../domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* ------------------------------------------------------------------------- */

function mapAccount(row: FleetAccountRow): FleetAccount {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    /*
     * Unknown reads as VERIFICATION, for `mapUser`'s reason: leaving a real
     * account out of a capacity count is a complaint, and counting a fixture as
     * capacity is the defect this column was added to end.
     */
    kind: row.kind === 'CAPACITY' ? 'CAPACITY' : 'VERIFICATION',
    planLabel: row.plan_label,
    declaredPlanPower: row.declared_plan_power,
    state: row.state as FleetState,
    stateReason: row.state_reason,
    retryAt: row.retry_at,
    lastRefusalAt: row.last_refusal_at,
    lastRefusalReason: row.last_refusal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoutine(row: FleetRoutineRow): FleetRoutine {
  return {
    id: row.id,
    accountId: row.account_id,
    routineRef: row.routine_ref,
    name: row.name,
    routineVersion: row.routine_version,
    baseUrl: row.base_url,
    tokenSecretName: row.token_secret_name,
    tokenDigest: row.token_digest,
    workerId: row.worker_id,
    capabilities: parseJson<string[]>(row.capabilities, []),
    state: row.state as FleetState,
    stateReason: row.state_reason,
    fireGeneration: row.fire_generation,
    consecutiveFailures: row.consecutive_failures,
    consecutiveNoShows: row.consecutive_no_shows,
    totalFires: row.total_fires,
    totalRefusals: row.total_refusals,
    lastFiredAt: row.last_fired_at,
    lastCheckInAt: row.last_check_in_at,
    retryAt: row.retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPolicy(row: FleetPolicyRow): FleetPolicy {
  return {
    id: row.id,
    scope: row.scope as PolicyScope,
    scopeId: row.scope_id,
    version: row.version,
    target: row.target,
    autoScale: row.auto_scale === 1,
    autoScaleCeiling: row.auto_scale_ceiling,
    minReserve: row.min_reserve,
    boostTarget: row.boost_target,
    boostUntil: row.boost_until,
    boostReason: row.boost_reason,
    exploreCeiling: row.explore_ceiling,
    exploreUntil: row.explore_until,
    paused: row.paused === 1,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/**
 * The digest of a credential, for saying "the secret in the environment is the
 * one this row was registered with" without either being readable.
 *
 * Exported so the registration command and the verifier compute it the same
 * way; a second implementation would eventually disagree with this one.
 */
export function credentialDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/* ------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* ------------------------------------------------------------------------- */

export async function createAccount(input: {
  provider?: string;
  name: string;
  /** Capacity unless a caller says otherwise; see `FleetAccountKind`. */
  kind?: FleetAccountKind;
  planLabel?: string | null;
  declaredPlanPower?: string | null;
}): Promise<FleetAccount> {
  const id = newId('acct');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO fleet_accounts (id, provider, name, kind, plan_label, declared_plan_power,
       state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ENABLED', ?, ?)`,
    [id, input.provider ?? 'claude', input.name, input.kind ?? 'CAPACITY', input.planLabel ?? null,
      input.declaredPlanPower ?? null, at, at],
  );
  return (await getAccount(id))!;
}

export async function getAccount(id: string): Promise<FleetAccount | null> {
  const row = await getDb().get<FleetAccountRow>('SELECT * FROM fleet_accounts WHERE id = ?', [id]);
  return row ? mapAccount(row) : null;
}

export async function getAccountByName(
  name: string,
  provider = 'claude',
): Promise<FleetAccount | null> {
  const row = await getDb().get<FleetAccountRow>(
    'SELECT * FROM fleet_accounts WHERE provider = ? AND name = ?',
    [provider, name],
  );
  return row ? mapAccount(row) : null;
}

export async function listAccounts(): Promise<FleetAccount[]> {
  return (
    await getDb().all<FleetAccountRow>('SELECT * FROM fleet_accounts ORDER BY created_at, rowid')
  ).map(mapAccount);
}

/**
 * Move an account between fleet states.
 *
 * Guarded on the state it is expected to be in, so two operators cannot both
 * believe they were the one who quarantined it, and a health signal cannot
 * silently overwrite a decision a person made a moment earlier.
 */
export async function setAccountState(input: {
  accountId: string;
  from: FleetState;
  to: FleetState;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE fleet_accounts SET state = ?, state_reason = ?, updated_at = ?
      WHERE id = ? AND state = ?`,
    [input.to, input.reason, nowIso(), input.accountId, input.from],
  );
  return result.changes === 1;
}

/**
 * Record that the provider refused this account, and when it says to try again.
 *
 * Written from refusals only. Nothing here is inferred: if the provider did not
 * say a retry time, `retryAt` stays null and the router treats the account as
 * available rather than inventing a wait.
 */
export async function recordAccountRefusal(input: {
  accountId: string;
  reason: string;
  retryAt: string | null;
}): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `UPDATE fleet_accounts
        SET retry_at = ?, last_refusal_at = ?, last_refusal_reason = ?, updated_at = ?
      WHERE id = ?`,
    [input.retryAt, at, input.reason.slice(0, 500), at, input.accountId],
  );
}

/* ------------------------------------------------------------------------- */
/* Routines                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Why a second Routine may not be registered, or null when it may.
 *
 * Pure, over rows the caller already has, and applied at the operator surface
 * rather than in the INSERT — the reason is that the damage is a *registration*
 * mistake rather than a data one, and it is only refusable while somebody is
 * standing there to be told what to do instead.
 *
 * Both collisions are the same fact wearing two shapes: **two Routines on one
 * trigger token is one surface wearing two rows.** A pool built on it reports
 * capacity that does not exist, fires one surface twice believing it fired two,
 * and quarantines both rows when that one token goes stale. The name catches the
 * copy-paste; the digest catches the same value stored twice under two names,
 * which the name check cannot see.
 *
 * The digest is `token_digest`, already stored at registration, so this costs
 * one read and reveals nothing: a digest is not recoverable to a value, and the
 * refusal names the Routine rather than either secret's contents.
 */
export function routineRegistrationCollision(
  registered: FleetRoutine[],
  candidate: { tokenSecretName: string; tokenDigest: string },
): string | null {
  const sameName = registered.find((other) => other.tokenSecretName === candidate.tokenSecretName);
  if (sameName) {
    return (
      `${candidate.tokenSecretName} is already the deployment secret for ${sameName.name} ` +
      `(${sameName.routineRef}). Each Routine holds its own trigger token under its own secret ` +
      'name — sharing one would make two surfaces one trigger fired twice.'
    );
  }
  const sameToken = registered.find((other) => other.tokenDigest === candidate.tokenDigest);
  if (sameToken) {
    return (
      `the value in ${candidate.tokenSecretName} is the same trigger token already registered ` +
      `for ${sameToken.name} (${sameToken.routineRef}) under ${sameToken.tokenSecretName}. Two ` +
      'names for one token is still one token; create a trigger for this Routine and store its own.'
    );
  }
  return null;
}

export async function createRoutine(input: {
  accountId: string;
  routineRef: string;
  name: string;
  tokenSecretName: string;
  tokenDigest?: string | null;
  routineVersion?: string | null;
  baseUrl?: string | null;
  capabilities?: string[];
  workerId?: string | null;
}): Promise<FleetRoutine> {
  const id = newId('rtn');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO fleet_routines (id, account_id, routine_ref, name, routine_version, base_url,
       token_secret_name, token_digest, worker_id, capabilities, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ENABLED', ?, ?)`,
    [id, input.accountId, input.routineRef, input.name, input.routineVersion ?? null,
      input.baseUrl ?? null, input.tokenSecretName, input.tokenDigest ?? null,
      input.workerId ?? null, toJson(input.capabilities ?? []), at, at],
  );
  return (await getRoutine(id))!;
}

export async function getRoutine(id: string): Promise<FleetRoutine | null> {
  const row = await getDb().get<FleetRoutineRow>('SELECT * FROM fleet_routines WHERE id = ?', [id]);
  return row ? mapRoutine(row) : null;
}

export async function getRoutineByRef(routineRef: string): Promise<FleetRoutine | null> {
  const row = await getDb().get<FleetRoutineRow>(
    'SELECT * FROM fleet_routines WHERE routine_ref = ?',
    [routineRef],
  );
  return row ? mapRoutine(row) : null;
}

export async function listRoutines(options: { accountId?: string } = {}): Promise<FleetRoutine[]> {
  const params: SqlParam[] = [];
  let sql = 'SELECT * FROM fleet_routines';
  if (options.accountId) {
    sql += ' WHERE account_id = ?';
    params.push(options.accountId);
  }
  sql += ' ORDER BY created_at, rowid';
  return (await getDb().all<FleetRoutineRow>(sql, params)).map(mapRoutine);
}

export async function setRoutineState(input: {
  routineId: string;
  from: FleetState;
  to: FleetState;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE fleet_routines SET state = ?, state_reason = ?, updated_at = ?
      WHERE id = ? AND state = ?`,
    [input.to, input.reason, nowIso(), input.routineId, input.from],
  );
  return result.changes === 1;
}

/**
 * Change what a surface is *called*, and nothing else.
 *
 * A label, not an identity. The Routine is addressed by its `routine_ref` —
 * the trigger Brain actually fires — and the account by its own id, so a rename
 * cannot move either of them. Every column that decides anything is left
 * exactly as it was: the reference, the deployment secret's name, the digest
 * taken at registration, the bound worker, the state, the counters. A rename
 * that could touch one of those would be a re-registration wearing a friendlier
 * word, and the credential it disturbed would be the one already doing the work.
 *
 * Guarded on the current name so two people renaming the same row produce one
 * rename and one ordinary refusal rather than a last-writer-wins.
 */
export async function renameRoutine(input: {
  routineId: string;
  from: string;
  to: string;
}): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE fleet_routines SET name = ?, updated_at = ? WHERE id = ? AND name = ?',
    [input.to, nowIso(), input.routineId, input.from],
  );
  return result.changes === 1;
}

/** The same, for an account. See `renameRoutine`. */
export async function renameAccount(input: {
  accountId: string;
  from: string;
  to: string;
}): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE fleet_accounts SET name = ?, updated_at = ? WHERE id = ? AND name = ?',
    [input.to, nowIso(), input.accountId, input.from],
  );
  return result.changes === 1;
}

/**
 * Bind a Routine to the worker identity its sessions authenticate as.
 *
 * Observed rather than declared. A Routine is registered before it has ever
 * run, so the worker is unknown until a session arrives; the check-in path
 * fills it in. Guarded on the column being empty so an observation cannot
 * silently re-point a Routine at a different identity — that would be a
 * different surface wearing the same row.
 */
export async function bindRoutineWorker(routineId: string, workerId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE fleet_routines SET worker_id = ?, updated_at = ?
      WHERE id = ? AND (worker_id IS NULL OR worker_id = ?)`,
    [workerId, nowIso(), routineId, workerId],
  );
  return result.changes === 1;
}

/**
 * Correct a Routine's worker binding, deliberately.
 *
 * `bindRoutineWorker` above refuses a re-point, and that is right: the caller
 * there is the arrival path, which *observes* an identity, and an observation
 * that silently overwrote the row would hide exactly the mix-up this exists to
 * repair. But refusing an observation is not the same as having no remedy, and
 * for a while this codebase had none — no unbind, no re-point, no delete, in the
 * repository, the script or the console, while `bindRoutineWorker`'s own message
 * said to "retire it and register the new surface" and `UNIQUE (routine_ref)`
 * made re-registering that ref impossible.
 *
 * That is Step 10's lesson at a new altitude. **A state that says "an operator
 * must fix this" which the operator has no action to fix is not waiting, it is
 * stuck**, and every escalation needs an answering transition that is guarded
 * rather than absent.
 *
 * So this is guarded the way every other correction in this codebase is: a
 * compare-and-swap on the value the claimant does not supply — here the binding
 * the operator believes is there. Naming the wrong current worker changes
 * nothing and reports it, so a re-point can never be a blind overwrite of a
 * binding that moved while somebody was reading it.
 *
 * It is an identity attribution change, so it is audited to the append-only
 * `identity_events` with both ends of the move and the operator's reason. It
 * cannot bind a Routine that has none — that is `bindRoutineWorker`'s job, from
 * evidence — and it never touches the health counters, because re-pointing a
 * row is not a session arriving.
 */
export async function repointRoutineWorker(input: {
  routineId: string;
  expectedWorkerId: string;
  workerId: string;
  actor: string;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE fleet_routines SET worker_id = ?, updated_at = ?
      WHERE id = ? AND worker_id = ?`,
    [input.workerId, nowIso(), input.routineId, input.expectedWorkerId],
  );
  if (result.changes !== 1) return false;
  await recordIdentityEvent({
    actorType: 'SYSTEM',
    actorId: input.actor,
    action: 'REPOINT_ROUTINE_WORKER',
    targetType: 'FLEET_ROUTINE',
    targetId: input.routineId,
    result: 'SUCCESS',
    metadata: {
      from: input.expectedWorkerId,
      to: input.workerId,
      reason: input.reason,
    },
  });
  return true;
}

/**
 * Declare what a Routine can be given.
 *
 * A separate operation from registration because a capability is an operational
 * fact that changes — a Routine that gains a repository, a surface that loses
 * one — and the alternative to having this is either a row nobody can correct or
 * manual SQL, and invariant 2 admits no manual SQL in ordinary operation.
 *
 * It is a declaration and never a grant. Brain holds no credential for anything
 * a capability names; what the Routine may actually reach is decided where the
 * Routine runs. So this changes *what work Brain will route there*, which is a
 * narrowing or a widening of Brain's own dispatch and nothing else — and it is
 * audited, with both the old set and the new one, because a reader asking why a
 * bin went somewhere needs to know what the row said at the time.
 */
export async function setRoutineCapabilities(input: {
  routineId: string;
  capabilities: string[];
  actor: string;
  reason: string;
}): Promise<FleetRoutine | null> {
  const before = await getRoutine(input.routineId);
  if (!before) return null;
  const wanted = [...new Set(input.capabilities.map((tag) => tag.trim()).filter(Boolean))].sort();
  await getDb().run(
    `UPDATE fleet_routines SET capabilities = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(wanted), nowIso(), input.routineId],
  );
  await recordIdentityEvent({
    actorType: 'SYSTEM',
    actorId: input.actor,
    action: 'SET_ROUTINE_CAPABILITIES',
    targetType: 'FLEET_ROUTINE',
    targetId: input.routineId,
    result: 'SUCCESS',
    metadata: {
      from: before.capabilities,
      to: wanted,
      reason: input.reason,
    },
  });
  return await getRoutine(input.routineId);
}

/**
 * Point a Routine at a different deployment secret, deliberately.
 *
 * `register-routine` takes the secret's *name* once and there was no way to
 * change it afterwards, which is the same shape `setRoutineCapabilities` above
 * was written to answer: a row that has become wrong, and the only remedies
 * left being manual SQL — which invariant 2 forbids — or retiring a surface
 * that is perfectly healthy. Here the row becomes wrong in one specific and
 * entirely ordinary way: **a trigger and a bearer that were paired by hand,
 * paired wrongly.**
 *
 * That is worth stating precisely, because a provider `AUTH 401` does *not*
 * say a token is invalid. It says this token does not authorize this trigger.
 * With four triggers and four secrets registered diagonally, four refusals
 * eliminate four of sixteen pairings and prove nothing whatever about the other
 * twelve — so a fleet can be one relabelling away from working while every row
 * in it reads as permanently broken.
 *
 * What it does **not** touch is the deployment secret. Brain holds the name and
 * a digest and has never been able to read a value back (§22, §23); this moves
 * which *name* a row points at, and nothing about Fly, the variable, or the
 * bearer inside it. The digest is recomputed from the newly-named secret so
 * `routineRegistrationCollision`'s "two names, one token" reading stays true of
 * the row afterwards.
 *
 * It is audited to the append-only `identity_events` with both secret **names**
 * and both digest prefixes — an identifier of a value, never the value, and
 * twelve hex characters of a sha-256 is not recoverable to one. A reader asking
 * why a surface started working needs to know what the row said before.
 *
 * It changes no health state on purpose: a row pointing somewhere new is not a
 * fire that succeeded, and re-enabling a quarantined surface stays the separate
 * guarded transition `fleet set-state` already provides.
 */
export async function setRoutineSecret(input: {
  routineId: string;
  tokenSecretName: string;
  tokenDigest: string;
  actor: string;
  reason: string;
}): Promise<FleetRoutine | null> {
  const before = await getRoutine(input.routineId);
  if (!before) return null;
  await getDb().run(
    `UPDATE fleet_routines SET token_secret_name = ?, token_digest = ?, updated_at = ? WHERE id = ?`,
    [input.tokenSecretName, input.tokenDigest, nowIso(), input.routineId],
  );
  await recordIdentityEvent({
    actorType: 'SYSTEM',
    actorId: input.actor,
    action: 'SET_ROUTINE_SECRET',
    targetType: 'FLEET_ROUTINE',
    targetId: input.routineId,
    result: 'SUCCESS',
    metadata: {
      fromSecretName: before.tokenSecretName,
      toSecretName: input.tokenSecretName,
      fromDigest: before.tokenDigest?.slice(0, 12) ?? null,
      toDigest: input.tokenDigest.slice(0, 12),
      reason: input.reason,
    },
  });
  return await getRoutine(input.routineId);
}

/** A Routine's session arrived. Health counters reset on evidence, not on hope. */
export async function recordRoutineCheckIn(routineId: string): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `UPDATE fleet_routines
        SET last_check_in_at = ?, consecutive_no_shows = 0, updated_at = ?
      WHERE id = ?`,
    [at, at, routineId],
  );
}

/**
 * Take this Routine's fire slot, atomically.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * `routeBin` is a pure function over a snapshot, which is the right shape for a
 * routing *decision* and is no protection at all against a routing *race*. Two
 * dispatchers read the same snapshot, both compute that Routine R has headroom
 * for one more activation, and both fire it. The account is then over its
 * target and nothing in the system knows, because each of them individually did
 * the arithmetic correctly.
 *
 * The same hazard exists inside a single tick: a burst of five reads the fleet
 * once and would otherwise send five activations at a Routine whose target is
 * one, having measured its headroom before any of them left.
 *
 * ---------------------------------------------------------------------------
 * The swap
 * ---------------------------------------------------------------------------
 *
 * The caller passes the `fire_generation` it read. The `UPDATE` names that
 * value, so both racers name the *same* number and exactly one row is matched.
 * The loser gets `false`, which is an ordinary outcome — the queue documents
 * the same thing about a losing claim.
 *
 * The generation is the guard specifically because **the claimant does not
 * supply it**. `bin_dispatch` learned this the expensive way: a swap on
 * `attempt_count` looked equivalent, and two ticks reading at different moments
 * read different counts, so each one's guard matched its own read and both
 * claimed. SQLite never showed it. Postgres failed it immediately.
 *
 * `state` and `retry_at` are in the guard too, so a Routine quarantined or
 * rate-limited between the snapshot and the claim is refused by the database
 * rather than by a stale in-memory candidate list.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately is not
 * ---------------------------------------------------------------------------
 *
 * `total_fires` is incremented here rather than on the way back, so it counts
 * *attempts committed to* — the moment after which an HTTP request either went
 * out or the process died holding the slot. A refusal is still an attempt, and
 * is counted separately in `total_refusals`; counting fires on the return path
 * instead would silently lose every activation whose caller crashed mid-call,
 * which is exactly the population worth being able to see.
 *
 * It is not a semaphore and holds no count of what is running. Concurrency is
 * bounded by the caller comparing measured in-flight against the policy target
 * *before* claiming; this makes sure two callers cannot both act on one such
 * measurement. A losing claim is refused rather than retried against a fresh
 * read, so the mechanism can under-fire and cannot over-fire. That asymmetry is
 * chosen: a fire missed this tick happens ten seconds later, and a fire made
 * twice is an activation nobody authorized.
 */
export async function claimRoutineFireSlot(input: {
  routineId: string;
  expectedGeneration: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE fleet_routines
        SET fire_generation = fire_generation + 1,
            total_fires = total_fires + 1,
            last_fired_at = ?, updated_at = ?
      WHERE id = ? AND fire_generation = ?
        AND state = 'ENABLED'
        AND (retry_at IS NULL OR retry_at <= ?)`,
    [at, at, input.routineId, input.expectedGeneration, at],
  );
  return result.changes === 1;
}

export async function recordRoutineFire(input: {
  routineId: string;
  ok: boolean;
  retryAt?: string | null;
  rateLimited?: boolean;
}): Promise<void> {
  const at = nowIso();
  if (input.ok) {
    // `total_fires` and `last_fired_at` are written by `claimRoutineFireSlot`,
    // not here. The write that decides a fire happens is the compare-and-swap;
    // counting it again on the way back would double-count every activation and
    // would count nothing at all for a claim whose HTTP call then died.
    await getDb().run(
      `UPDATE fleet_routines
          SET consecutive_failures = 0, consecutive_no_shows = consecutive_no_shows + 1,
              retry_at = NULL, updated_at = ?
        WHERE id = ?`,
      [at, input.routineId],
    );
    return;
  }
  // A rate limit is capacity evidence, not misconduct: it advances the refusal
  // count and the retry point and leaves the failure streak alone, so an
  // account at its ceiling is never quarantined for being busy.
  await getDb().run(
    `UPDATE fleet_routines
        SET total_refusals = total_refusals + 1,
            consecutive_failures = CASE WHEN ? = 1 THEN consecutive_failures
                                        ELSE consecutive_failures + 1 END,
            retry_at = ?, updated_at = ?
      WHERE id = ?`,
    [input.rateLimited ? 1 : 0, input.retryAt ?? null, at, input.routineId],
  );
}

/**
 * Fires each surface made that nobody answered, since that surface last
 * answered.
 *
 * The per-surface no-show fact, derived from rows rather than counted in a
 * column, and the reason it has to be is `recordWorkerArrival`: an arrival
 * clears `consecutive_no_shows` for **every Routine bound to the same worker**,
 * which is precisely what a Factory pool is. In a fleet of four Claude accounts
 * on one identity, one dead surface has its counter reset by its healthy
 * siblings and is fired at for ever — an activation each time, out of a fixed
 * subscription allowance, with every row reading healthy. That column's own
 * documentation says what it is: "fires awaiting an arrival", advanced
 * optimistically on every successful fire, which is also why its ordinary value
 * on a working surface whose worker is still booting is 1.
 *
 * `DISPATCH_NO_SHOW` is the exact fact instead. `reopenNoShowDispatches` writes
 * one when a fire it made is `SENT`, has aged past the window in which it still
 * counts as a live activation, and the bin is still claimable at the very
 * generation that fire named — so nothing was handed out in between and the
 * session genuinely never came. It is read from `bin_events` rather than from
 * `bin_dispatch` because that table is append-only: a reopened intent's
 * `routine_id` is rewritten when it is re-routed to another surface, so a count
 * read back from the dispatch row would credit one account's no-show to the
 * next account that tried.
 *
 * **Since that surface's own last arrival**, so a repair ends it. A surface
 * that answers has every no-show before that instant turned into history, and
 * history does not take anything out of routing.
 *
 * "That surface's own arrival" is `worker_sessions`, and deliberately not
 * `fleet_routines.last_check_in_at`. The second is written by
 * `recordWorkerArrival` across every Routine bound to one worker, so falling
 * back to it would reintroduce the very defect this function exists to fix, one
 * column along: a healthy sibling's check-in would silently forgive a dead
 * surface's no-shows. `worker_sessions` is written from Brain's own dispatch
 * row — one fire, one Routine, one arrival — so it is the only per-surface
 * arrival evidence there is. With none, every no-show counts, which is correct:
 * a surface Brain has never been able to attribute an arrival to has never
 * answered.
 */
export async function unansweredFiresByRoutine(): Promise<Map<string, number>> {
  const rows = await getDb().all<{ routine_id: string; n: number }>(
    `SELECT e.routine_id AS routine_id, COUNT(*) AS n
       FROM bin_events e
      WHERE e.event_type = 'DISPATCH_NO_SHOW'
        AND e.routine_id IS NOT NULL
        AND e.at > COALESCE(
              (SELECT MAX(s.observed_at) FROM worker_sessions s
                WHERE s.routine_id = e.routine_id),
              '')
      GROUP BY e.routine_id`,
  );
  return new Map(rows.map((row) => [row.routine_id, Number(row.n)]));
}

/**
 * A fired session never arrived.
 *
 * Counted separately from a refusal because the remedies differ: a refusal is
 * the provider saying no, a no-show is a session that was created and never
 * checked in, which usually means the surface cannot authorize.
 *
 * **Nothing calls this, and that is the honest state rather than an oversight
 * waiting to be tidied away.** `consecutive_no_shows` is advanced
 * optimistically by `recordRoutineFire` and cleared by an arrival, so the
 * column is really "fires awaiting an arrival". Proving a *real* no-show needs
 * a reconciler that ages out a SENT dispatch nobody ever claimed, and there
 * isn't one. Until there is, this function is the shape of the thing that is
 * missing, and deleting it would delete the only statement of what the counter
 * is supposed to mean.
 */
export async function recordRoutineNoShow(routineId: string): Promise<void> {
  await getDb().run(
    `UPDATE fleet_routines
        SET consecutive_no_shows = consecutive_no_shows + 1, updated_at = ?
      WHERE id = ?`,
    [nowIso(), routineId],
  );
}

/**
 * An authenticated session arrived, whether or not there was work for it.
 *
 * This is the repair for a health signal that pointed the wrong way.
 *
 * `recordRoutineFire` advances `consecutive_no_shows` on every successful fire,
 * and until now the *only* thing that cleared it was a worker being handed a
 * bin. So a session that started, authenticated, asked for work and was told
 * `NO_READY_BINS` — which `checkIn`'s own comment calls "an ordinary answer",
 * and which is the expected outcome for the losing half of a duplicate
 * activation — left the counter exactly where a session that never started at
 * all would have left it.
 *
 * Two consequences, and the second is worse than the first. An operator reading
 * `no-shows=1` concluded nobody arrived when somebody had. And three such
 * ordinary answers in a row quarantine a completely healthy Routine at
 * `NO_SHOW_QUARANTINE_THRESHOLD`, which is the same "health signal pointing the
 * opposite way to reality" §23 already recorded once and fixed only for the
 * assignment path.
 *
 * Attribution is from `fleet_routines.worker_id` — a row the server owns,
 * written by observation — and never from anything the worker said about
 * itself. **Its imprecision is stated rather than hidden:** where several
 * Routines are bound to one worker identity, an arrival credits all of them,
 * because the evidence is "a session for this worker authorized and reached
 * us" and that is genuinely evidence about every surface running as that
 * worker. Where the binding is one-to-one it is exact.
 */
export async function recordWorkerArrival(workerId: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE fleet_routines
        SET consecutive_no_shows = 0, last_check_in_at = ?, updated_at = ?
      WHERE worker_id = ? AND consecutive_no_shows > 0`,
    [nowIso(), nowIso(), workerId],
  );
  return result.changes;
}

/* ------------------------------------------------------------------------- */
/* Policy                                                                     */
/* ------------------------------------------------------------------------- */

export interface PolicyInput {
  scope: PolicyScope;
  scopeId?: string | null;
  target: number;
  autoScale?: boolean;
  autoScaleCeiling?: number | null;
  minReserve?: number;
  boostTarget?: number | null;
  boostUntil?: string | null;
  boostReason?: string | null;
  exploreCeiling?: number | null;
  exploreUntil?: string | null;
  paused?: boolean;
  actor: string;
  reason: string;
}

/**
 * Write the next version of a scope's policy.
 *
 * An INSERT, never an UPDATE. The previous version is what makes a change
 * reversible and what makes "who raised this, and why" answerable months later;
 * an in-place edit would answer neither.
 *
 * The version is computed from the current maximum and inserted under a UNIQUE
 * constraint, so two concurrent writers cannot both take version 4 — one of
 * them fails and re-reads, which is the same discipline the queue uses.
 */
export async function setPolicy(input: PolicyInput): Promise<FleetPolicy> {
  const scopeId = input.scopeId ?? null;
  const current = await getPolicyRow(input.scope, scopeId);
  const version = (current?.version ?? 0) + 1;
  const id = newId('fpol');
  await getDb().run(
    `INSERT INTO fleet_policy (id, scope, scope_id, version, target, auto_scale,
       auto_scale_ceiling, min_reserve, boost_target, boost_until, boost_reason,
       explore_ceiling, explore_until, paused, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.scope, scopeId, version, input.target, input.autoScale ? 1 : 0,
      input.autoScaleCeiling ?? null, input.minReserve ?? 0,
      input.boostTarget ?? null, input.boostUntil ?? null, input.boostReason ?? null,
      input.exploreCeiling ?? null, input.exploreUntil ?? null,
      input.paused ? 1 : 0, input.actor, input.reason, nowIso()],
  );
  return (await getPolicyById(id))!;
}

async function getPolicyById(id: string): Promise<FleetPolicy | null> {
  const row = await getDb().get<FleetPolicyRow>('SELECT * FROM fleet_policy WHERE id = ?', [id]);
  return row ? mapPolicy(row) : null;
}

async function getPolicyRow(scope: PolicyScope, scopeId: string | null): Promise<FleetPolicy | null> {
  const row = scopeId
    ? await getDb().get<FleetPolicyRow>(
        `SELECT * FROM fleet_policy WHERE scope = ? AND scope_id = ?
          ORDER BY version DESC LIMIT 1`,
        [scope, scopeId],
      )
    : await getDb().get<FleetPolicyRow>(
        `SELECT * FROM fleet_policy WHERE scope = ? AND scope_id IS NULL
          ORDER BY version DESC LIMIT 1`,
        [scope],
      );
  return row ? mapPolicy(row) : null;
}

/** The policy in force for a scope, or null if nobody has ever set one. */
export async function currentPolicy(
  scope: PolicyScope,
  scopeId: string | null = null,
): Promise<FleetPolicy | null> {
  return await getPolicyRow(scope, scopeId);
}

export async function policyHistory(
  scope: PolicyScope,
  scopeId: string | null = null,
  limit = 50,
): Promise<FleetPolicy[]> {
  const rows = scopeId
    ? await getDb().all<FleetPolicyRow>(
        `SELECT * FROM fleet_policy WHERE scope = ? AND scope_id = ?
          ORDER BY version DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
        [scope, scopeId],
      )
    : await getDb().all<FleetPolicyRow>(
        `SELECT * FROM fleet_policy WHERE scope = ? AND scope_id IS NULL
          ORDER BY version DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
        [scope],
      );
  return rows.map(mapPolicy);
}

/**
 * The target actually in force right now, and where it came from.
 *
 * A boost that has expired is not applied — the reader compares `boost_until`
 * to the clock, so a temporary push stops being temporary only if somebody
 * writes a new policy, never because a timer failed to run.
 */
export function effectiveTarget(
  policy: FleetPolicy | null,
  now: string,
): { target: number; source: CapacityEvidence; boosted: boolean } {
  if (!policy) return { target: 0, source: 'UNKNOWN', boosted: false };
  if (policy.paused) return { target: 0, source: 'OPERATOR_POLICY', boosted: false };
  const boosting =
    policy.boostTarget !== null && policy.boostUntil !== null && policy.boostUntil > now;
  if (boosting) {
    return { target: policy.boostTarget!, source: 'OPERATOR_POLICY', boosted: true };
  }
  const exploring =
    policy.exploreCeiling !== null && policy.exploreUntil !== null && policy.exploreUntil > now;
  if (exploring && policy.exploreCeiling! > policy.target) {
    return { target: policy.exploreCeiling!, source: 'OPERATOR_POLICY', boosted: true };
  }
  return { target: policy.target, source: 'OPERATOR_POLICY', boosted: false };
}

/* ------------------------------------------------------------------------- */
/* Worker sessions — which surface an authenticated session actually came from */
/* ------------------------------------------------------------------------- */

export interface WorkerSession {
  sessionRef: string;
  workerId: string;
  routineId: string;
  accountId: string;
  binId: string;
  leaseGeneration: number;
  observedAt: string;
}

/**
 * Record which Routine and account produced this authenticated session.
 *
 * Written from the dispatch row Brain wrote itself, at the moment a fired
 * session arrives and takes the bin that fire was for. **Never from anything
 * the worker says about itself** — a body field naming a Routine would be the
 * same mistake §19 refuses for queue ownership and §23 refuses for arrivals.
 *
 * First observation wins, by `ON CONFLICT DO NOTHING`. A credential belongs to
 * one activation and an activation was started by one Routine, so a second bin
 * taken by the same session must not be able to re-point what started it — and
 * a silent re-point would hide a surface wearing another's identity, which is
 * the case `bindRoutineWorker` already refuses one level up.
 *
 * Returns whether this call was the observation, which is what makes it usable
 * as evidence rather than merely as a cache.
 */
export async function recordWorkerSession(input: {
  sessionRef: string;
  workerId: string;
  routineId: string;
  accountId: string;
  binId: string;
  leaseGeneration: number;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO worker_sessions
       (session_ref, worker_id, routine_id, account_id, bin_id, lease_generation, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_ref) DO NOTHING`,
    [
      input.sessionRef,
      input.workerId,
      input.routineId,
      input.accountId,
      input.binId,
      input.leaseGeneration,
      nowIso(),
    ],
  );
  return result.changes === 1;
}

/** The surface one authenticated session came from, or null if unobserved. */
/**
 * Which session Brain observed taking this bin, newest first.
 *
 * The companion to `getWorkerSession`, asked from the other end. A completed bin
 * no longer carries its lease — `finishBin` clears the worker, the lease id and
 * the credential in the same statement that finishes it — so by the time anything
 * reads the bin's *results*, the bin itself can no longer say who produced them.
 * This row can, and it is the authoritative answer rather than the convenient
 * one: `worker_sessions` is written from the dispatch row Brain wrote itself,
 * never from anything the worker said about itself.
 *
 * Newest first because a takeover is a second arrival on one bin, and the session
 * that finished it is the last one that took it.
 */
export async function workerSessionForBin(binId: string): Promise<WorkerSession | null> {
  const row = await getDb().get<{
    session_ref: string;
    worker_id: string;
    routine_id: string;
    account_id: string;
    bin_id: string;
    lease_generation: number;
    observed_at: string;
  }>(
    /*
     * `session_ref` rather than `rowid` as the tiebreak, and that is not a style
     * choice: `dialect.ts` rewrites `rowid` to `seq`, `worker_sessions` has no
     * such column on Postgres, and the statement therefore threw on the backend
     * production runs while passing every SQLite test. The primary key makes the
     * order total and is sayable in both dialects.
     */
    `SELECT * FROM worker_sessions WHERE bin_id = ?
      ORDER BY observed_at DESC, session_ref DESC LIMIT 1`,
    [binId],
  );
  return row
    ? {
        sessionRef: row.session_ref,
        workerId: row.worker_id,
        routineId: row.routine_id,
        accountId: row.account_id,
        binId: row.bin_id,
        leaseGeneration: Number(row.lease_generation),
        observedAt: row.observed_at,
      }
    : null;
}

/**
 * Every session Brain observed arriving on one Routine, newest first.
 *
 * The read that turns "a token was minted for this worker and used" into "this
 * Routine's fire produced a session that authenticated as this worker". Those
 * are different claims and only the second one is about the surface: a token is
 * held by a *connector*, and nothing about a token says which Routine has it.
 *
 * Every row here was written from the `bin_dispatch` row Brain itself wrote when
 * it fired, so this cannot be satisfied by anything a worker says about itself.
 */
export async function sessionsForRoutine(routineId: string, limit = 20): Promise<WorkerSession[]> {
  const rows = await getDb().all<{
    session_ref: string;
    worker_id: string;
    routine_id: string;
    account_id: string;
    bin_id: string;
    lease_generation: number;
    observed_at: string;
  }>(
    // Ordered on a real column and tiebroken on the primary key, because
    // `worker_sessions` has no identity column on Postgres.
    `SELECT * FROM worker_sessions WHERE routine_id = ?
      ORDER BY observed_at DESC, session_ref DESC LIMIT ?`,
    [routineId, Math.min(200, Math.max(1, limit))],
  );
  return rows.map((row) => ({
    sessionRef: row.session_ref,
    workerId: row.worker_id,
    routineId: row.routine_id,
    accountId: row.account_id,
    binId: row.bin_id,
    leaseGeneration: Number(row.lease_generation),
    observedAt: row.observed_at,
  }));
}

export async function getWorkerSession(sessionRef: string): Promise<WorkerSession | null> {
  const row = await getDb().get<{
    session_ref: string;
    worker_id: string;
    routine_id: string;
    account_id: string;
    bin_id: string;
    lease_generation: number;
    observed_at: string;
  }>(`SELECT * FROM worker_sessions WHERE session_ref = ?`, [sessionRef]);
  return row
    ? {
        sessionRef: row.session_ref,
        workerId: row.worker_id,
        routineId: row.routine_id,
        accountId: row.account_id,
        binId: row.bin_id,
        leaseGeneration: Number(row.lease_generation),
        observedAt: row.observed_at,
      }
    : null;
}
