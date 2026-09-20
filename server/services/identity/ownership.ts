/**
 * Whose capacity a worker is, where Brain can actually prove it.
 *
 * The defect migration 072 corrects is a worker named after a person being read
 * as a statement about whose Claude account ran a session. Removing the name
 * from every surface is half of that; the other half is that the question it was
 * pretending to answer is a real one, and it has a real answer for some workers.
 *
 * **Only one source counts, and it is not the approver.** §22 is emphatic that
 * the human on an `oauth_authorization_codes` row is the person who *approved a
 * grant*, recorded for the audit and deliberately absent from the token — an
 * administrator can approve a connector for capacity that is not theirs, which
 * is exactly what the consent screen is for. So approval is not ownership and
 * is never read as it here.
 *
 * What is ownership is `capacity_connections`: a member signed in with their own
 * device, asked for their own invitation, redeemed it themselves, and submitted
 * their own Routine. Brain wrote every row in that journey. So a worker that
 * resolves to exactly one live connection is owned by that connection's member,
 * and everything else is null.
 *
 * Three properties, each of which is the point rather than a detail:
 *
 *   - **Exactly one.** A worker two members' connections resolve to is a shared
 *     identity, and naming one of them its owner would be the original defect
 *     with better provenance. Ambiguity is null.
 *   - **Never overwritten.** The write is guarded on the column still being
 *     null, so a recorded value can never be replaced by a derived one —
 *     `lineageRecovery`'s rule, at a new column.
 *   - **Derived on the tick, not hooked to a moment.** It reaches the workers
 *     already registered, survives a tick that died halfway, and cannot be
 *     missed by a code path that forgot to call something. The fourth time this
 *     repository has needed that distinction.
 *
 * It authorizes nothing. No policy, route, router, admission hook or audit reads
 * `owner_user_id`; it is metadata a person looks at.
 */
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';

export interface OwnershipReport {
  /** Workers whose owner was established by this pass. */
  established: Array<{ workerId: string; userId: string }>;
  /** Workers more than one live connection resolves to, left null on purpose. */
  ambiguous: string[];
}

export const OWNER_EVIDENCE_CONNECTION = 'CAPACITY_CONNECTION';

export async function reconcileWorkerOwnership(): Promise<OwnershipReport> {
  const rows = await getDb().all<{ worker_id: string; user_id: string }>(
    `SELECT r.worker_id AS worker_id, c.user_id AS user_id
       FROM capacity_connections c
       JOIN fleet_routines r ON r.id = c.routine_id
      WHERE c.routine_id IS NOT NULL
        AND r.worker_id IS NOT NULL
        AND c.revoked_at IS NULL`,
  );

  const byWorker = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byWorker.get(row.worker_id) ?? new Set<string>();
    set.add(row.user_id);
    byWorker.set(row.worker_id, set);
  }

  const report: OwnershipReport = { established: [], ambiguous: [] };
  const at = nowIso();
  for (const [workerId, users] of byWorker) {
    if (users.size !== 1) {
      report.ambiguous.push(workerId);
      continue;
    }
    const [userId] = [...users];
    const result = await getDb().run(
      `UPDATE workers SET owner_user_id = ?, owner_evidence = ?, updated_at = ?
        WHERE id = ? AND owner_user_id IS NULL`,
      [userId!, OWNER_EVIDENCE_CONNECTION, at, workerId],
    );
    if (result.changes === 1) report.established.push({ workerId, userId: userId! });
  }
  return report;
}
