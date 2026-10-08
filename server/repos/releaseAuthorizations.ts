/**
 * The owner's standing release authorization, as rows (CLAUDE.md §58).
 *
 * One live grant per (project, repository grant), arbitrated by the partial
 * unique index rather than by a read: a second grant while one is live is an
 * ordinary refusal. Revoking keeps the row. Nothing here decides whether a
 * change is low risk — `services/factory/releaseEligibility.ts` does, and a
 * grant cannot widen it.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  FactoryReleaseAuthorization,
  FactoryReleaseAuthorizationRow,
  ReleaseAuthorityChannel,
} from '../domain/factory.ts';

function mapRow(row: FactoryReleaseAuthorizationRow): FactoryReleaseAuthorization {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryGrant: row.repository_grant,
    grantedById: row.granted_by_id,
    authorityChannel: row.authority_channel as ReleaseAuthorityChannel,
    reason: row.reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedById: row.revoked_by_id,
    revokeReason: row.revoke_reason,
  };
}

/** The live grant, or null. An expired grant is not live, and is still a row. */
export async function liveReleaseAuthorization(
  projectId: string,
  repositoryGrant: string,
  at: string = nowIso(),
): Promise<FactoryReleaseAuthorization | null> {
  const row = await getDb().get<FactoryReleaseAuthorizationRow>(
    `SELECT * FROM factory_release_authorizations
      WHERE project_id = ? AND repository_grant = ? AND revoked_at IS NULL AND expires_at > ?`,
    [projectId, repositoryGrant, at],
  );
  return row ? mapRow(row) : null;
}

export async function listReleaseAuthorizations(projectId: string): Promise<FactoryReleaseAuthorization[]> {
  const rows = await getDb().all<FactoryReleaseAuthorizationRow>(
    `SELECT * FROM factory_release_authorizations WHERE project_id = ? ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(mapRow);
}

/**
 * Record a grant. Returns null when one is already live (the index refused it),
 * so the caller can say so rather than replace it silently.
 *
 * A grant that has merely expired still holds the unique slot, so it is closed
 * first, in the same transaction, with a reason saying it expired.
 */
export async function insertReleaseAuthorization(input: {
  projectId: string;
  repositoryGrant: string;
  grantedById: string;
  authorityChannel: ReleaseAuthorityChannel;
  reason: string;
  expiresAt: string;
}): Promise<FactoryReleaseAuthorization | null> {
  const db = getDb();
  return db.transaction(async () => {
    const at = nowIso();
    await db.run(
      `UPDATE factory_release_authorizations
          SET revoked_at = ?, revoked_by_id = 'system', revoke_reason = 'expired'
        WHERE project_id = ? AND repository_grant = ? AND revoked_at IS NULL AND expires_at <= ?`,
      [at, input.projectId, input.repositoryGrant, at],
    );
    const id = newId('fra');
    const inserted = await db.run(
      `INSERT INTO factory_release_authorizations
         (id, project_id, repository_grant, granted_by_id, authority_channel, reason, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.projectId,
        input.repositoryGrant,
        input.grantedById,
        input.authorityChannel,
        input.reason,
        input.expiresAt,
        at,
      ],
    );
    if (inserted.changes === 0) return null;
    const row = await db.get<FactoryReleaseAuthorizationRow>(
      `SELECT * FROM factory_release_authorizations WHERE id = ?`,
      [id],
    );
    return row ? mapRow(row) : null;
  });
}

/** Revoke the live grant, guarded on it still being live. False when there was none. */
export async function revokeReleaseAuthorization(input: {
  projectId: string;
  repositoryGrant: string;
  revokedById: string;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_release_authorizations
        SET revoked_at = ?, revoked_by_id = ?, revoke_reason = ?
      WHERE project_id = ? AND repository_grant = ? AND revoked_at IS NULL`,
    [nowIso(), input.revokedById, input.reason, input.projectId, input.repositoryGrant],
  );
  return result.changes > 0;
}
