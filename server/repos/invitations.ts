/**
 * Worker invitations: an administrator's approval, carried to another browser.
 *
 * The shape is deliberately the authorization code's, because it is the same
 * problem — a decision made by a human at one moment, redeemed by a machine at
 * another, exactly once. So the same rules apply: the plaintext exists in the
 * link and nowhere else, lookup is by prefix and then constant-time on the
 * secret, and redemption is a single guarded UPDATE rather than a read followed
 * by a write.
 *
 * That last one matters more here than it looks. An invitation is sent over a
 * channel the Brain does not control — a message, an email, a chat. Assume it
 * can be read by somebody else and opened twice. `redeemInvitation` is written
 * so that two requests carrying the same invitation cannot both succeed: the
 * `WHERE redeemed_at IS NULL` is part of the statement that sets it, so the
 * database decides the winner and the loser gets nothing.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { constantTimeEquals, digestSecret } from '../services/identity/secrets.ts';
import type {
  WorkerInvitation,
  WorkerInvitationKind,
  WorkerInvitationRow,
} from '../domain/types.ts';

/** Long enough to send and act on, short enough that a stale link is dead. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mapInvitation(row: WorkerInvitationRow): WorkerInvitation {
  return {
    id: row.id,
    workerId: row.worker_id,
    tokenPrefix: row.token_prefix,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
    note: row.note,
    kind: row.kind,
    intendedUserId: row.intended_user_id,
  };
}

export interface CreateInvitationInput {
  workerId: string;
  tokenPrefix: string;
  tokenDigest: string;
  createdByUserId: string;
  note?: string | null;
  ttlMs?: number;
  /** Defaults to `ROTATING`, onboarding's link. */
  kind?: WorkerInvitationKind;
  /** The member it is for. Only ever chosen by the administrator issuing it. */
  intendedUserId?: string | null;
}

export async function createInvitation(input: CreateInvitationInput): Promise<WorkerInvitation> {
  const id = newId('inv');
  const now = Date.now();
  await getDb().run(
    `INSERT INTO worker_invitations
       (id, worker_id, token_prefix, token_digest, created_by_user_id,
        created_at, expires_at, redeemed_at, revoked_at, note, kind, intended_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.workerId,
      input.tokenPrefix,
      input.tokenDigest,
      input.createdByUserId,
      new Date(now).toISOString(),
      new Date(now + (input.ttlMs ?? INVITATION_TTL_MS)).toISOString(),
      input.note ?? null,
      input.kind ?? 'ROTATING',
      input.intendedUserId ?? null,
    ],
  );
  const row = await getDb().get<WorkerInvitationRow>(
    'SELECT * FROM worker_invitations WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('The invitation disappeared immediately after being written.');
  return mapInvitation(row);
}

/**
 * Resolve a presented invitation, or null.
 *
 * Unknown, revoked, redeemed and expired are one answer. The differences
 * between them are exactly what somebody holding a guessed link would like to
 * learn, and the caller turns this into a single refusal.
 */
export async function findLiveInvitation(
  prefix: string,
  secret: string,
): Promise<WorkerInvitation | null> {
  const row = await getDb().get<WorkerInvitationRow>(
    'SELECT * FROM worker_invitations WHERE token_prefix = ?',
    [prefix],
  );
  if (!row) return null;
  if (!constantTimeEquals(digestSecret(secret), row.token_digest)) return null;
  if (row.revoked_at !== null || row.redeemed_at !== null) return null;
  if (row.expires_at <= nowIso()) return null;
  return mapInvitation(row);
}

/**
 * Spend an invitation, exactly once.
 *
 * One guarded UPDATE: the conditions that make it valid are in the same
 * statement that marks it used, so two requests carrying the same link cannot
 * both come away with a connection. A caller that changed no rows lost, and
 * that is an ordinary outcome rather than an error.
 */
export async function redeemInvitation(id: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE worker_invitations SET redeemed_at = ?
      WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    [at, id, at],
  );
  return result.changes > 0;
}

export async function revokeInvitation(id: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE worker_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL',
    [nowIso(), id],
  );
  return result.changes > 0;
}

/** Every invitation for a worker, newest first, whatever state it is in. */
export async function listInvitationsForWorker(workerId: string): Promise<WorkerInvitation[]> {
  const rows = await getDb().all<WorkerInvitationRow>(
    'SELECT * FROM worker_invitations WHERE worker_id = ? ORDER BY created_at DESC',
    [workerId],
  );
  return rows.map(mapInvitation);
}

/** Withdraw every unused invitation for a worker — used when it is archived. */
export async function revokeInvitationsForWorker(workerId: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE worker_invitations SET revoked_at = ?
      WHERE worker_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`,
    [nowIso(), workerId],
  );
  return result.changes;
}

/**
 * Withdraw onboarding's own unused link, and nothing else.
 *
 * Onboarding is a rotation: running it again replaces the one link it issued.
 * It must not reach the `ADDITIONAL` links an administrator sent to several
 * people for a pool — each of those belongs to somebody who has not opened it
 * yet, and withdrawing it because a different link was issued is exactly the
 * defect `094_worker_invitation_members.sql` exists to close.
 */
export async function revokeRotatingInvitationsForWorker(workerId: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE worker_invitations SET revoked_at = ?
      WHERE worker_id = ? AND kind = 'ROTATING' AND revoked_at IS NULL AND redeemed_at IS NULL`,
    [nowIso(), workerId],
  );
  return result.changes;
}

/** Withdraw one invitation, only if it belongs to this worker. Guarded in the statement. */
export async function revokeInvitationForWorker(id: string, workerId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE worker_invitations SET revoked_at = ?
      WHERE id = ? AND worker_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`,
    [nowIso(), id, workerId],
  );
  return result.changes > 0;
}
