/**
 * Registered devices, member slots and the challenges in between.
 *
 * Every secret here is a digest or a public key. The enrollment link is shown
 * once at issue and is not recoverable from any row, and a passkey's public
 * half is stored as it is because there is nothing in it to recover.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  MemberEnrollment,
  MemberEnrollmentRow,
  UserPasskey,
  UserPasskeyRow,
} from '../domain/types.ts';

function mapPasskey(row: UserPasskeyRow): UserPasskey {
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    algorithm: row.algorithm,
    signCount: row.sign_count,
    label: row.label,
    originKind: row.origin_kind as UserPasskey['originKind'],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function mapEnrollment(row: MemberEnrollmentRow): MemberEnrollment {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    kind: row.kind as MemberEnrollment['kind'],
    tokenPrefix: row.token_prefix,
    tokenDigest: row.token_digest,
    issuedByUserId: row.issued_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

/* ------------------------------------------------------------- passkeys */

export async function addPasskey(input: {
  userId: string;
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  label: string;
  originKind: UserPasskey['originKind'];
}): Promise<UserPasskey | null> {
  const id = newId('pky');
  try {
    await getDb().run(
      `INSERT INTO user_passkeys (id, user_id, credential_id, public_key, algorithm,
         sign_count, label, origin_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.credentialId,
        input.publicKey,
        input.algorithm,
        input.signCount,
        input.label,
        input.originKind,
        nowIso(),
      ],
    );
  } catch {
    /*
     * The UNIQUE on `credential_id` refused it: this physical credential is
     * already registered, possibly to somebody else. Null rather than a throw,
     * because the caller must answer that with the same refusal it gives for
     * everything else rather than a message naming who holds it.
     */
    return null;
  }
  return getPasskey(id);
}

export async function getPasskey(id: string): Promise<UserPasskey | null> {
  const row = await getDb().get<UserPasskeyRow>('SELECT * FROM user_passkeys WHERE id = ?', [id]);
  return row ? mapPasskey(row) : null;
}

/** By the id the browser presents. Live only: a revoked device is not a way in. */
export async function livePasskeyByCredential(credentialId: string): Promise<UserPasskey | null> {
  const row = await getDb().get<UserPasskeyRow>(
    'SELECT * FROM user_passkeys WHERE credential_id = ? AND revoked_at IS NULL',
    [credentialId],
  );
  return row ? mapPasskey(row) : null;
}

export async function listPasskeys(userId: string): Promise<UserPasskey[]> {
  const rows = await getDb().all<UserPasskeyRow>(
    /*
     * An ORDER BY must be sayable in both dialects, so the tiebreak is `id` and
     * never `rowid`/`seq` — three separate instances of that mistake are
     * recorded in CLAUDE.md.
     */
    'SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId],
  );
  return rows.map(mapPasskey);
}

export async function countLivePasskeys(userId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  return Number(row?.n ?? 0);
}

export async function notePasskeyUsed(input: { id: string; signCount: number }): Promise<void> {
  await getDb().run('UPDATE user_passkeys SET last_used_at = ?, sign_count = ? WHERE id = ?', [
    nowIso(),
    input.signCount,
    input.id,
  ]);
}

/**
 * Retire a device. Guarded on it still being live, so two requests revoking one
 * credential produce one revocation and the loser is told.
 */
export async function revokePasskey(input: {
  id: string;
  reason: string;
  byUserId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE user_passkeys SET revoked_at = ?, revoked_reason = ?, revoked_by_user_id = ?
      WHERE id = ? AND revoked_at IS NULL`,
    [nowIso(), input.reason, input.byUserId, input.id],
  );
  return result.changes === 1;
}

export async function revokeAllPasskeys(input: {
  userId: string;
  reason: string;
  byUserId: string;
}): Promise<number> {
  const result = await getDb().run(
    `UPDATE user_passkeys SET revoked_at = ?, revoked_reason = ?, revoked_by_user_id = ?
      WHERE user_id = ? AND revoked_at IS NULL`,
    [nowIso(), input.reason, input.byUserId, input.userId],
  );
  return result.changes;
}

/* ---------------------------------------------------------- enrollments */

export async function createEnrollment(input: {
  userId: string;
  displayName: string;
  kind: MemberEnrollment['kind'];
  tokenPrefix: string;
  tokenDigest: string;
  issuedByUserId: string;
  expiresAt: string;
}): Promise<MemberEnrollment> {
  const id = newId('enr');
  await getDb().run(
    `INSERT INTO member_enrollments (id, user_id, display_name, kind, token_prefix, token_digest,
       issued_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.displayName,
      input.kind,
      input.tokenPrefix,
      input.tokenDigest,
      input.issuedByUserId,
      nowIso(),
      input.expiresAt,
    ],
  );
  return (await getEnrollment(id))!;
}

export async function getEnrollment(id: string): Promise<MemberEnrollment | null> {
  const row = await getDb().get<MemberEnrollmentRow>(
    'SELECT * FROM member_enrollments WHERE id = ?',
    [id],
  );
  return row ? mapEnrollment(row) : null;
}

export async function enrollmentByPrefix(prefix: string): Promise<MemberEnrollment | null> {
  const row = await getDb().get<MemberEnrollmentRow>(
    'SELECT * FROM member_enrollments WHERE token_prefix = ?',
    [prefix],
  );
  return row ? mapEnrollment(row) : null;
}

export async function listEnrollments(): Promise<MemberEnrollment[]> {
  const rows = await getDb().all<MemberEnrollmentRow>(
    'SELECT * FROM member_enrollments ORDER BY created_at DESC, id DESC',
  );
  return rows.map(mapEnrollment);
}

/**
 * Spend it, in the statement that checks it is unspent.
 *
 * Every condition that makes the link valid is in the WHERE: unused, unrevoked
 * and unexpired. So two requests holding one intercepted link cannot both come
 * away with a device registered — the second matches nothing.
 */
export async function spendEnrollment(input: { id: string; now: string }): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE member_enrollments SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    [input.now, input.id, input.now],
  );
  return result.changes === 1;
}

export async function revokeEnrollment(input: { id: string; reason: string }): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE member_enrollments SET revoked_at = ?, revoked_reason = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    [nowIso(), input.reason, input.id],
  );
  return result.changes === 1;
}

/* ----------------------------------------------------------- challenges */

export async function rememberChallenge(input: {
  challenge: string;
  purpose: 'REGISTER' | 'AUTHENTICATE';
  userId?: string | null;
  expiresAt: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO webauthn_challenges (challenge, purpose, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.challenge, input.purpose, input.userId ?? null, nowIso(), input.expiresAt],
  );
}

/**
 * Take a challenge, once.
 *
 * A DELETE guarded on every condition, so a challenge cannot be answered twice
 * and an expired one is simply not there. Returning whether a row was removed
 * is what makes this a claim rather than a read.
 */
export async function takeChallenge(input: {
  challenge: string;
  purpose: 'REGISTER' | 'AUTHENTICATE';
  now: string;
}): Promise<boolean> {
  const result = await getDb().run(
    'DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ?',
    [input.challenge, input.purpose, input.now],
  );
  return result.changes === 1;
}

/** Housekeeping. Nothing depends on it running: expiry is checked on use. */
export async function forgetExpiredChallenges(now: string): Promise<number> {
  const result = await getDb().run('DELETE FROM webauthn_challenges WHERE expires_at <= ?', [now]);
  return result.changes;
}
