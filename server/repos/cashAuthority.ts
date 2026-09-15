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
    spentCents: row.spent_cents,
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
  refusedBy?: 'PER_ACTION' | 'IN_TOTAL' | 'OVER_CAPITAL';
}

/**
 * A refusal raised from inside the transaction, so the provisional row rolls
 * back with it.
 *
 * It is thrown rather than returned because the row has already been inserted
 * by the time the ceilings can be checked against it, and the only way to make
 * that row never have existed — to any other reader, on either backend — is to
 * abandon the transaction that created it.
 */
class CommitRefused extends Error {
  constructor(
    readonly refusalReason: string,
    readonly refusedBy: NonNullable<CommitOutcome['refusedBy']>,
  ) {
    super(refusalReason);
    this.name = 'CommitRefused';
  }
}

/**
 * Hold part of the ceiling, atomically, and never provisionally.
 *
 * The original was insert-then-rank-then-release and had two defects a review
 * reproduced, both recorded here rather than quietly fixed.
 *
 * **A provisional row was visible.** It was inserted `HELD`, the ceilings were
 * checked afterwards, and a concurrent retry that read it back in between was
 * told "an equivalent commitment already exists" — about money that was
 * released microseconds later. The caller was told yes about a refusal.
 *
 * **The rank was scoped to one grant.** Withdrawing a grant with $400
 * outstanding and making a replacement with the same $500 ceiling permitted
 * another $400: $800 held against a limit of $500, with every row correct on
 * its own. A hold outlives the grant that authorized it, so the thing a ceiling
 * must be compared against is **what this project is holding**, not what this
 * grant issued.
 *
 * So the whole of it runs in one transaction, and the insert stays first:
 *
 *   1. insert on `(project_id, idempotency_key)`, ignoring a conflict;
 *   2. read back; if this call did not insert it, replay a **finished** row —
 *      finished because no other transaction can see an unfinished one;
 *   3. sum every `HELD` commitment **in this project** through this row's own
 *      rank, and check the per-action ceiling, the committed ceiling and the
 *      cash actually available;
 *   4. on any refusal, throw — which rolls the row away entirely.
 *
 * The rank is what makes the race deterministic: two callers get two ranks, so
 * their running sums differ and exactly one is over. The transaction is what
 * makes the intermediate state private. It can under-commit and cannot
 * over-commit, and a refusal leaves nothing behind for a later retry to
 * misread.
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
  /**
   * What may be committed before this one, in cents.
   *
   * Supplied by the caller because it is derived from the money ledger, which
   * this module does not read — and re-derived *inside* the transaction by the
   * caller's own hook when one is given, so the figure the check uses is the
   * figure that is true at the moment of the insert.
   */
  deployableAfter?: () => Promise<number>;
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

  try {
    return await getDb().transaction(async (): Promise<CommitOutcome> => {
      await getDb().run(
        `INSERT INTO cash_commitments
           (id, authority_id, project_id, opportunity_id, amount_cents, currency,
            purpose, expected_result, stop_condition, idempotency_key, state, spent_cents,
            settled_at, released_at, release_reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HELD', NULL, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
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
          'SELECT * FROM cash_commitments WHERE project_id = ? AND idempotency_key = ?',
          [input.projectId, input.idempotencyKey],
        )
      )[0];
      if (!existing) {
        return { ok: false, commitment: null, reason: 'the commitment could not be taken', replayed: false };
      }
      if (existing.id !== id) {
        /*
         * Somebody equivalent got there first, and that is success for an
         * idempotent caller: the money was committed once and this is the same
         * attempt reaching the same row. The row is finished rather than
         * provisional, because a refusal never commits one.
         *
         * A `RELEASED` row is *not* revived, and that is the deliberate
         * difference from a research reservation. A released research hold is a
         * stand-down on a slot that frees up later; a released commitment is a
         * person saying this money is not being spent, and reviving it on the
         * next retry would re-commit funds somebody had deliberately freed —
         * with the retry looking exactly like the original.
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
        throw new CommitRefused(
          `the commercial authority allows at most ${authority.maxPerActionCents} cents in one commitment`,
          'PER_ACTION',
        );
      }

      const held = await heldThroughMine(input.projectId, id);
      if (held > authority.maxCommittedCents) {
        throw new CommitRefused(
          `the commercial authority allows ${authority.maxCommittedCents} cents committed at once, ` +
            `and this would make ${held}`,
          'IN_TOTAL',
        );
      }

      /*
       * And the money itself.
       *
       * The gate used to ask whether deployable cash was *already* negative,
       * which fires one commitment after the one that did the damage: an
       * account with $100 could commit $400 under a $1,000 grant and be told
       * about it next time. The hook is evaluated here, inside the transaction
       * and after the insert, so what it reports already counts this
       * commitment — a negative answer is precisely "this does not fit".
       */
      if (input.deployableAfter) {
        const deployable = await input.deployableAfter();
        if (deployable < 0) {
          throw new CommitRefused(
            `this would leave ${deployable} cents deployable. A commitment has to fit the money ` +
              'that is actually there, not only avoid a balance that is already negative.',
            'OVER_CAPITAL',
          );
        }
      }

      const mine = (
        await getDb().all<CashCommitmentRow>('SELECT * FROM cash_commitments WHERE id = ?', [id])
      )[0];
      return {
        ok: true,
        commitment: mine ? mapCommitment(mine) : null,
        reason: 'committed',
        replayed: false,
      };
    });
  } catch (error) {
    if (error instanceof CommitRefused) {
      return {
        ok: false,
        commitment: null,
        reason: error.refusalReason,
        replayed: false,
        refusedBy: error.refusedBy,
      };
    }
    throw error;
  }
}

/**
 * Everything this **project** holds up to and including one row's own rank.
 *
 * By project rather than by grant, because a hold outlives the grant that
 * authorized it: withdrawing a grant with money outstanding and making a
 * replacement must not hand the replacement a fresh empty ceiling.
 *
 * `rowid` is rewritten to `seq` by `dialect.ts`, and `cash_commitments` carries
 * `seq BIGSERIAL` on Postgres for exactly this — a rank that exists in one
 * dialect only is the defect this repository has now written down four times.
 */
async function heldThroughMine(projectId: string, mineId: string): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN state = 'HELD' THEN amount_cents ELSE 0 END), 0) AS total
       FROM cash_commitments
      WHERE project_id = ?
        AND rowid <= (SELECT rowid FROM cash_commitments WHERE id = ?)`,
    [projectId, mineId],
  );
  return Number(rows[0]?.total ?? 0);
}

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

/**
 * How much one grant issued and still holds.
 *
 * Reported rather than enforced: the ceiling is compared against what the
 * **project** holds, because a hold outlives the grant that authorized it.
 */
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
/**
 * The spend happened. The hold becomes history, and what it cost is recorded.
 *
 * Guarded on `HELD`, so settling a released commitment cannot account for money
 * twice and settling a settled one is a retry that changes nothing. `spentCents`
 * is what actually left; the remainder simply stops being held, which is what
 * makes a partial spend expressible without a second row.
 *
 * Writing the matching cost is the **caller's** job and is not optional: this
 * function moving a row out of `HELD` without one is the defect that made
 * deployable cash rise when money was spent. `services/cash/opportunities.ts`
 * does both in one transaction, and nothing else calls this.
 */
export async function settleCommitment(
  commitmentId: string,
  spentCents: number,
): Promise<boolean> {
  const at = cashAuthorityNow();
  const result = await getDb().run(
    `UPDATE cash_commitments
        SET state = 'SETTLED', spent_cents = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [Math.max(0, Math.trunc(spentCents)), at, at, commitmentId],
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
