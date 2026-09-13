/**
 * Project invitations: one person's offer of membership, spent exactly once.
 *
 * The shape is `invitations.ts`'s, because it is the same problem — a decision a
 * human makes at one moment, redeemed in another browser at another — and
 * therefore the same three rules:
 *
 *   * the plaintext exists in the link and nowhere else; the row holds a prefix
 *     to be found by and a sha-256 of the secret;
 *   * lookup is one indexed read on the prefix and then a constant-time compare
 *     on the secret, so authentication never digests every live invitation to
 *     find out which one this is;
 *   * redemption is a **single guarded UPDATE** rather than a read followed by a
 *     write. That matters more here than anywhere else in this file: an
 *     invitation travels over a channel Brain does not control — a message, an
 *     email, a chat — so assume it can be read by somebody else and opened
 *     twice. `acceptInvitation` puts every condition that makes the invitation
 *     valid into the same statement that marks it used, so the database picks
 *     the winner and the loser comes away with nothing.
 *
 * What is different from a worker invitation, and why:
 *
 *   * It names an **email and a role**, both fixed by the person deciding.
 *     Neither is chosen by whoever redeems it — an acceptor who could pick their
 *     own role would make the link a way to grant themselves access, which is
 *     exactly what the issuing administrator's decision is for.
 *   * `findLiveInvitation` gives **one answer** for unknown, expired, accepted
 *     and revoked. The differences between those four are precisely what
 *     somebody holding a guessed link would like to learn, so the caller turns
 *     all of them into a single refusal with a single body.
 *
 * No `ORDER BY` here tiebreaks on `rowid`. `created_at DESC, id DESC` is a total
 * order that is sayable in both dialects, over a random unique id.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { constantTimeEquals, digestSecret } from '../services/identity/secrets.ts';
import { normalizeEmail } from './identity.ts';
import { PROJECT_ROLES } from '../domain/types.ts';
import type {
  ProjectInvitation,
  ProjectInvitationRow,
  ProjectRole,
} from '../domain/types.ts';

/**
 * Long enough to reach somebody and be acted on, short enough that a link found
 * in an old inbox is dead. The same window a worker invitation gets, because it
 * is the same channel with the same risk.
 */
export const PROJECT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mapRole(raw: string): ProjectRole {
  const match = PROJECT_ROLES.find((role) => role === raw);
  // A row whose role is not in the enum is a row nothing may act on. Throwing
  // is right: silently substituting VIEWER would grant access under a role
  // nobody chose, and silently substituting OWNER is worse.
  if (!match) throw new Error(`An invitation row carries "${raw}", which is not a project role.`);
  return match;
}

function mapInvitation(row: ProjectInvitationRow): ProjectInvitation {
  return {
    id: row.id,
    projectId: row.project_id,
    invitedEmail: row.invited_email,
    role: mapRole(row.role),
    tokenPrefix: row.token_prefix,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedUserId: row.accepted_user_id,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    note: row.note,
  };
}

export interface CreateProjectInvitationInput {
  projectId: string;
  invitedEmail: string;
  role: ProjectRole;
  tokenPrefix: string;
  tokenDigest: string;
  invitedByUserId: string;
  note?: string | null;
  ttlMs?: number;
}

export async function createProjectInvitation(
  input: CreateProjectInvitationInput,
): Promise<ProjectInvitation> {
  const id = newId('pinv');
  const now = Date.now();
  await getDb().run(
    `INSERT INTO project_invitations
       (id, project_id, invited_email, role, token_prefix, token_digest,
        invited_by_user_id, created_at, expires_at,
        accepted_at, accepted_user_id, revoked_at, revoked_reason, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    [
      id,
      input.projectId,
      normalizeEmail(input.invitedEmail),
      input.role,
      input.tokenPrefix,
      input.tokenDigest,
      input.invitedByUserId,
      new Date(now).toISOString(),
      new Date(now + (input.ttlMs ?? PROJECT_INVITATION_TTL_MS)).toISOString(),
      input.note ?? null,
    ],
  );
  const row = await getDb().get<ProjectInvitationRow>(
    'SELECT * FROM project_invitations WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('The invitation disappeared immediately after being written.');
  return mapInvitation(row);
}

/**
 * Resolve a presented invitation, or null.
 *
 * Unknown, revoked, accepted and expired are one answer, on purpose. The caller
 * turns this into a single refusal that names the remedy rather than the reason.
 */
export async function findLiveProjectInvitation(
  prefix: string,
  secret: string,
): Promise<ProjectInvitation | null> {
  const row = await getDb().get<ProjectInvitationRow>(
    'SELECT * FROM project_invitations WHERE token_prefix = ?',
    [prefix],
  );
  if (!row) return null;
  if (!constantTimeEquals(digestSecret(secret), row.token_digest)) return null;
  if (row.revoked_at !== null || row.accepted_at !== null) return null;
  if (row.expires_at <= nowIso()) return null;
  return mapInvitation(row);
}

/**
 * Spend an invitation, exactly once.
 *
 * One guarded UPDATE. Every condition that makes the invitation valid — unused,
 * not withdrawn, not expired — is in the same statement that records who used
 * it, so two requests carrying the same intercepted link cannot both come away
 * with a membership. A caller that changed no rows lost the race, and that is an
 * ordinary outcome rather than an error.
 */
export async function acceptProjectInvitation(
  id: string,
  acceptedUserId: string,
): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE project_invitations
        SET accepted_at = ?, accepted_user_id = ?
      WHERE id = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?`,
    [at, acceptedUserId, id, at],
  );
  return result.changes > 0;
}

/**
 * Withdraw one before it is used.
 *
 * Guarded the same way, so withdrawing an invitation somebody is accepting at
 * that instant either wins or loses cleanly. Nothing is deleted: the offer
 * having been made is part of who was let into this project and who was not.
 */
export async function revokeProjectInvitation(
  id: string,
  reason: string | null,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE project_invitations SET revoked_at = ?, revoked_reason = ?
      WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL`,
    [nowIso(), reason, id],
  );
  return result.changes > 0;
}

/** One invitation by its id, whatever state it is in. */
export async function getProjectInvitation(id: string): Promise<ProjectInvitation | null> {
  const row = await getDb().get<ProjectInvitationRow>(
    'SELECT * FROM project_invitations WHERE id = ?',
    [id],
  );
  return row ? mapInvitation(row) : null;
}

/** Every invitation for a project, newest first, whatever state it is in. */
export async function listProjectInvitations(
  projectId: string,
  limit = 100,
): Promise<ProjectInvitation[]> {
  const rows = await getDb().all<ProjectInvitationRow>(
    `SELECT * FROM project_invitations
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [projectId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(mapInvitation);
}

/**
 * Withdraw every unused invitation for one email on one project.
 *
 * Re-inviting somebody is a **replacement** rather than an accumulation, for
 * `connectSite`'s reason: there is then never more than one live secret to
 * reason about, and "the invitation I sent them" is unambiguous.
 */
export async function revokeUnusedInvitationsFor(
  projectId: string,
  invitedEmail: string,
  reason: string,
): Promise<number> {
  const result = await getDb().run(
    `UPDATE project_invitations SET revoked_at = ?, revoked_reason = ?
      WHERE project_id = ? AND invited_email = ?
        AND revoked_at IS NULL AND accepted_at IS NULL`,
    [nowIso(), reason, projectId, normalizeEmail(invitedEmail)],
  );
  return result.changes;
}
