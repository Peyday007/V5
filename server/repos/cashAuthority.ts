/**
 * The commercial grant, and the ceiling it bounds.
 *
 * This is the module that decides whether Brain may commit somebody's money,
 * so every design choice in it is defensive — and two of them are deliberately
 * *different* from the research authority beside it.
 *
 * **The ceilings here are real.** §24 removed `russell_goals`' lifetime quotas
 * because nothing they rationed was scarce: the subscription behind a research
 * mission is already paid for, so a count of missions measured a starting point
 * and then became a permanent wall. Cash is the opposite fact. A dollar
 * committed to one opportunity cannot fund another, so `max_committed_cents`
 * stops things, and stopping is what it is for.
 *
 * **A commitment is never released by time.** There is no TTL on a hold and no
 * sweeper that frees one. §20's rule is that a timeout is not evidence, and it
 * is at its sharpest here: a hold that lapsed on a clock would hand back
 * spending room for money that may already have left the account. A commitment
 * is settled when the spend happened, or released by a person who knows it did
 * not. Both are recorded.
 *
 * **Nothing here creates a grant on Brain's behalf.** `createAuthority` takes
 * the person who authorized it and stores them, and no code path lets Brain, a
 * worker or a migration mint or widen one.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CashAuthority,
  CashAuthorityRow,
  CashAuthorityState,
  CashCommitment,
  CashCommitmentRow,
  CashCommitmentState,
} from '../domain/types.ts';

export function cashAuthorityNow(): string {
  return nowIso();
}

function mapAuthority(row: CashAuthorityRow): CashAuthority {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    policyVersion: row.policy_version,
    allowedActions: parseJson<string[]>(row.allowed_actions, []),
    prohibitions: parseJson<string[]>(row.prohibitions, []),
    maxCommittedCents: row.max_committed_cents,
    maxPerActionCents: row.max_per_action_cents,
    maxConcurrent: row.max_concurrent,
    currency: row.currency,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    state: row.state as CashAuthorityState,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    revokedReason: row.revoked_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommitment(row: CashCommitmentRow): CashCommitment {
  return {
    id: row.id,
    authorityId: row.authority_id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    purpose: row.purpose,
    expectedResult: row.expected_result,
    stopCondition: row.stop_condition,
    idempotencyKey: row.idempotency_key,
    state: row.state as CashCommitmentState,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createAuthority(input: {
  projectId: string;
  ownerUserId: string;
  createdByUserId: string;
  name: string;
  allowedActions: string[];
  prohibitions: string[];
  maxCommittedCents: number;
  maxPerActionCents: number;
  maxConcurrent: number;
  currency: string;
  startsAt?: string;
  expiresAt?: string | null;
}): Promise<CashAuthority> {
  const id = newId('cau');
  const at = cashAuthorityNow();
  await getDb().run(
    `INSERT INTO cash_authorities
       (id, project_id, owner_user_id, name, policy_version, allowed_actions, prohibitions,
        max_committed_cents, max_per_action_cents, max_concurrent, currency,
        starts_at, expires_at, state, revoked_at, revoked_by_user_id, revoked_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.ownerUserId,
      input.name,
      toJson(input.allowedActions),
      toJson(input.prohibitions),
      Math.max(0, Math.trunc(input.maxCommittedCents)),
      Math.max(0, Math.trunc(input.maxPerActionCents)),
      Math.max(0, Math.trunc(input.maxConcurrent)),
      input.currency,
      input.startsAt ?? at,
      input.expiresAt ?? null,
      input.createdByUserId,
      at,
      at,
    ],
  );
  const created = await getAuthority(id);
  if (!created) throw new Error('The commercial authority disappeared immediately after being written.');
  return created;
}

export async function getAuthority(id: string): Promise<CashAuthority | null> {
  const rows = await getDb().all<CashAuthorityRow>('SELECT * FROM cash_authorities WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapAuthority(rows[0]) : null;
}

export async function listAuthorities(projectId: string): Promise<CashAuthority[]> {
  const rows = await getDb().all<CashAuthorityRow>(
    'SELECT * FROM cash_authorities WHERE project_id = ? ORDER BY created_at DESC, id DESC',
    [projectId],
  );
  return rows.map(mapAuthority);
}

/**
 * The one grant in force, or nothing.
 *
 * A live grant is never silently replaced and two would make "the limits you
 * set" ambiguous, so `grantAuthority` refuses while one stands. This reader
 * still takes the newest of anything that qualifies rather than asserting
 * there is only one — a reader that threw on a shape the writer forbids is a
 * reader that turns a data problem into an outage.
 */
export async function liveAuthority(
  projectId: string,
  at?: string,
): Promise<CashAuthority | null> {
  const now = at ?? cashAuthorityNow();
  const rows = await getDb().all<CashAuthorityRow>(
    `SELECT * FROM cash_authorities
      WHERE project_id = ? AND state = 'ACTIVE'
      ORDER BY created_at DESC, id DESC`,
    [projectId],
  );
  for (const row of rows) {
    const authority = mapAuthority(row);
    if (authority.startsAt > now) continue;
    if (authority.expiresAt && authority.expiresAt <= now) continue;
    return authority;
  }
  return null;
}

export async function revokeAuthority(input: {
  authorityId: string;
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  const at = cashAuthorityNow();
  const result = await getDb().run(
    `UPDATE cash_authorities
        SET state = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ?,
            updated_at = ?
      WHERE id = ? AND state = 'ACTIVE'`,
    [at, input.actorUserId, input.reason, at, input.authorityId],
  );
  return result.changes === 1;
}

export interface CommitOutcome {
  ok: boolean;
  commitment: CashCommitment | null;
  /** Safe to show a person. Names the rule, never a credential. */
  reason: string;
  /** True when this call collided with an equivalent one that already held it. */
  replayed: boolean;
  refusedBy?: 'PER_ACTION' | 'IN_TOTAL';
}

/**
 * Hold part of the ceiling, atomically.
 *
 * The order is the whole mechanism, and it is `reserve`'s:
 *
 *   1. insert on the idempotency key, ignoring a conflict;
 *   2. read back the row that now exists;
 *   3. if this call did not insert it, report a replay and stop;
 *   4. sum what is held **through this row's own rank**, and if that exceeds
 *      the ceiling, release the row we just took and refuse.
 *
 * Step 4 rather than a `SELECT SUM(...)` before step 1: checking first leaves a
 * window in which two callers both see room for the last hundred dollars. The
 * rank clause is what makes the race deterministic — two concurrent callers get
 * two different ranks, so their running sums differ and exactly one of them is
 * over. The mechanism can under-commit and cannot over-commit.
 */
export async function commit(input: {
  authorityId: string;
  projectId: string;
  opportunityId?: string | null;
  amountCents: number;
  currency: string;
  purpose: string;
  expectedResult: string;
  stopCondition: string;
  idempotencyKey: string;
  createdBy: string;
  at?: string;
}): Promise<CommitOutcome> {
  const authority = await getAuthority(input.authorityId);
  if (!authority) {
    return { ok: false, commitment: null, reason: 'no such commercial authority', replayed: false };
  }
  if (authority.projectId !== input.projectId) {
    // Not a mismatch to explain: a grant addressed from another project is a
    // grant this caller does not have, and the refusal says nothing about it.
    return { ok: false, commitment: null, reason: 'no such commercial authority', replayed: false };
  }
  if (authority.state !== 'ACTIVE') {
    return {
      ok: false,
      commitment: null,
      reason: `the commercial authority is ${authority.state.toLowerCase()}`,
      replayed: false,
    };
  }

  const now = input.at ?? cashAuthorityNow();
  if (authority.startsAt > now) {
    return { ok: false, commitment: null, reason: 'the commercial authority has not started', replayed: false };
  }
  if (authority.expiresAt && authority.expiresAt <= now) {
    return { ok: false, commitment: null, reason: 'the commercial authority has expired', replayed: false };
  }
  if (authority.currency !== input.currency) {
    return {
      ok: false,
      commitment: null,
      reason:
        `the commercial authority is denominated in ${authority.currency} and this commitment ` +
        `is in ${input.currency}. Converting one into the other is a rate somebody has to ` +
        'choose, and Brain does not choose it.',
      replayed: false,
    };
  }

  const amount = Math.max(0, Math.trunc(input.amountCents));
  const id = newId('ccm');
  await getDb().run(
    `INSERT INTO cash_commitments
       (id, authority_id, project_id, opportunity_id, amount_cents, currency,
        purpose, expected_result, stop_condition, idempotency_key, state,
        settled_at, released_at, release_reason, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HELD', NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.authorityId,
      input.projectId,
      input.opportunityId ?? null,
      amount,
      input.currency,
      input.purpose,
      input.expectedResult,
      input.stopCondition,
      input.idempotencyKey,
      input.createdBy,
      now,
      now,
    ],
  );

  const existing = (
    await getDb().all<CashCommitmentRow>(
      'SELECT * FROM cash_commitments WHERE idempotency_key = ?',
      [input.idempotencyKey],
    )
  )[0];
  if (!existing) {
    return { ok: false, commitment: null, reason: 'the commitment could not be taken', replayed: false };
  }
  if (existing.id !== id) {
    /*
     * Somebody equivalent got there first, and that is success for an
     * idempotent caller: the money was committed once and this is the same
     * attempt reaching the same row.
     *
     * A `RELEASED` row is *not* revived here, and that is the deliberate
     * difference from `reserve`. A released research reservation is a
     * stand-down on a slot that later frees up. A released commitment is a
     * person saying this money is not being spent — reviving it on the next
     * retry would re-commit funds somebody had deliberately freed, and the
     * retry would look like the original.
     */
    return {
      ok: existing.state === 'HELD' || existing.state === 'SETTLED',
      commitment: mapCommitment(existing),
      reason:
        existing.state === 'RELEASED'
          ? 'an equivalent commitment was released; committing again is a new decision'
          : 'an equivalent commitment already exists',
      replayed: true,
    };
  }

  if (amount > authority.maxPerActionCents) {
    await releaseCommitment({ commitmentId: id, reason: 'over the per-action ceiling' });
    return {
      ok: false,
      commitment: null,
      reason: `the commercial authority allows at most ${authority.maxPerActionCents} cents in one commitment`,
      replayed: false,
      refusedBy: 'PER_ACTION',
    };
  }

  const held = await heldThroughMine(input.authorityId, id);
  if (held > authority.maxCommittedCents) {
    await releaseCommitment({ commitmentId: id, reason: 'over the committed ceiling' });
    return {
      ok: false,
      commitment: null,
      reason:
        `the commercial authority allows ${authority.maxCommittedCents} cents committed at once, ` +
        `and this would make ${held}`,
      replayed: false,
      refusedBy: 'IN_TOTAL',
    };
  }

  const mine = await getCommitment(id);
  return { ok: true, commitment: mine, reason: 'committed', replayed: false };
}

/**
 * Everything held on this grant up to and including one row's own rank.
 *
 * `rowid` is rewritten to `seq` by `dialect.ts`, and `cash_commitments` carries
 * `seq BIGSERIAL` on Postgres for exactly this — a rank that exists in one
 * dialect only is the defect this repository has now written down four times.
 */
async function heldThroughMine(authorityId: string, mineId: string): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN state = 'HELD' THEN amount_cents ELSE 0 END), 0) AS total
       FROM cash_commitments
      WHERE authority_id = ?
        AND rowid <= (SELECT rowid FROM cash_commitments WHERE id = ?)`,
    [authorityId, mineId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * The commitment a key already names, if any.
 *
 * Exposed so a caller can tell a *new* decision from a *replay* before applying
 * a rule that only makes sense for a new one. `commit` itself does not need it —
 * its insert already collides — but the shortfall gate above it does: refusing
 * a retry because the original made the account short is refusing somebody the
 * ability to recover from a lost response.
 */
export async function getCommitmentByKey(key: string): Promise<CashCommitment | null> {
  const rows = await getDb().all<CashCommitmentRow>(
    'SELECT * FROM cash_commitments WHERE idempotency_key = ?',
    [key],
  );
  return rows[0] ? mapCommitment(rows[0]) : null;
}

export async function getCommitment(id: string): Promise<CashCommitment | null> {
  const rows = await getDb().all<CashCommitmentRow>('SELECT * FROM cash_commitments WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapCommitment(rows[0]) : null;
}

export async function listCommitments(projectId: string): Promise<CashCommitment[]> {
  const rows = await getDb().all<CashCommitmentRow>(
    'SELECT * FROM cash_commitments WHERE project_id = ? ORDER BY created_at DESC, id DESC',
    [projectId],
  );
  return rows.map(mapCommitment);
}

/** How much of the ceiling is currently spoken for. */
export async function heldCents(authorityId: string): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM cash_commitments WHERE authority_id = ? AND state = 'HELD'`,
    [authorityId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** How much a project currently holds, across every grant it has ever had. */
export async function heldCentsForProject(projectId: string): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM cash_commitments WHERE project_id = ? AND state = 'HELD'`,
    [projectId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * The spend happened. The hold becomes history and the ceiling is free again.
 *
 * Guarded on `HELD`: settling a released commitment would account for money
 * twice, and settling a settled one is a retry that must change nothing.
 */
export async function settleCommitment(commitmentId: string): Promise<boolean> {
  const at = cashAuthorityNow();
  const result = await getDb().run(
    `UPDATE cash_commitments
        SET state = 'SETTLED', settled_at = ?, updated_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [at, at, commitmentId],
  );
  return result.changes === 1;
}

export async function releaseCommitment(input: {
  commitmentId: string;
  reason: string;
}): Promise<boolean> {
  const at = cashAuthorityNow();
  const result = await getDb().run(
    `UPDATE cash_commitments
        SET state = 'RELEASED', released_at = ?, release_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [at, input.reason, at, input.commitmentId],
  );
  return result.changes === 1;
}
