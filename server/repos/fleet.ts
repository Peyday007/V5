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
import type {
  CapacityEvidence,
  FleetAccount,
  FleetAccountRow,
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
  planLabel?: string | null;
  declaredPlanPower?: string | null;
}): Promise<FleetAccount> {
  const id = newId('acct');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO fleet_accounts (id, provider, name, plan_label, declared_plan_power,
       state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ENABLED', ?, ?)`,
    [id, input.provider ?? 'claude', input.name, input.planLabel ?? null,
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
 * A fired session never arrived.
 *
 * Counted separately from a refusal because the remedies differ: a refusal is
 * the provider saying no, a no-show is a session that was created and never
 * checked in, which usually means the surface cannot authorize.
 */
export async function recordRoutineNoShow(routineId: string): Promise<void> {
  await getDb().run(
    `UPDATE fleet_routines
        SET consecutive_no_shows = consecutive_no_shows + 1, updated_at = ?
      WHERE id = ?`,
    [nowIso(), routineId],
  );
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
