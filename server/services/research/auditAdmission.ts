/**
 * The admission rule the queue asks before leasing an audit item.
 *
 * This is the seam between Step 5's queue, which knows nothing about research,
 * and Step 11's independence matrix, which knows nothing about leases. The
 * queue calls it with a candidate row; this resolves the lineage the candidate
 * executor would bring and answers yes or no.
 *
 * Everything it uses is server-derived:
 *
 *   worker   from the authenticated principal
 *   Routine  from `fleet_routines.worker_id`, bound by the arrival-crediting
 *            path from the dispatch row that produced the worker
 *   account  from that Routine's row
 *   session  from the credential the request authenticated with
 *
 * None of it is a body field. A Routine cannot declare itself independent, and
 * its instructions are not asked to; that is the point of deciding here.
 */
import { listRoutines } from '../../repos/fleet.ts';
import { listPasses } from '../../repos/research.ts';
import { parseJson } from '../../repos/util.ts';
import { AUDIT_ROLES, type AuditRole } from '../queue/workTypes.ts';
import { auditEligibility, type ExecutorLineage } from './auditEligibility.ts';
import type { WorkItemRow } from '../../domain/types.ts';

/**
 * Resolve which Routine and account a worker runs on. Nulls stay null.
 *
 * One worker may be bound to more than one Routine — it is what happens when
 * two Claude accounts are connected through one connector, and it is exactly
 * the state the `ACCOUNT` dimension exists to refuse. This used to take the
 * first match, which over `ORDER BY created_at, rowid` is deterministic and
 * arbitrary: the answer was whichever surface was registered first, and nothing
 * said the question had two answers.
 *
 * So the ambiguity is named rather than picked from. Several Routines on one
 * account still resolve that account — the allowance is not in doubt, only the
 * surface — and Routines spanning accounts resolve neither, because
 * `auditEligibility` counts unknown lineage as a violation and an account id
 * chosen by registration order would turn a refusal into an approval.
 */
export async function lineageForWorker(input: {
  workerId: string;
  credentialId: string | null;
}): Promise<ExecutorLineage> {
  const routines = await listRoutines();
  const mine = routines.filter((routine) => routine.workerId === input.workerId);
  const accounts = new Set(mine.map((routine) => routine.accountId));
  const oneAccount = accounts.size === 1;
  return {
    workerId: input.workerId,
    routineId: mine.length === 1 ? mine[0]!.id : null,
    accountId: oneAccount ? mine[0]!.accountId : null,
    // Empty string rather than null would compare equal between two sessions
    // that both lacked one, so an absent credential stays absent and the
    // matrix fails it closed.
    sessionRef: input.credentialId ?? '',
  };
}

/**
 * The `admit` callback for `claimWork`.
 *
 * Returns `ok` for everything that is not a research audit item, which is
 * requirement 9 in one line: ordinary research, verification, synthesis and bin
 * draining are not touched by this at all.
 */
export function auditAdmission(executor: ExecutorLineage) {
  return async (item: WorkItemRow): Promise<{ ok: boolean; reason?: string }> => {
    if (item.work_type !== 'RESEARCH_AUDIT') return { ok: true };
    if (!item.orchestration_id) return { ok: true };

    const payload = parseJson<Record<string, unknown>>(item.payload, {});
    const role = payload['role'];
    if (typeof role !== 'string' || !AUDIT_ROLES.includes(role as AuditRole)) {
      // A malformed role cannot be judged against the matrix. Refused rather
      // than admitted: an item whose role cannot be read is not one whose
      // independence has been established.
      return { ok: false, reason: 'the item does not name a recognised audit role' };
    }

    const verdict = auditEligibility({
      role: role as AuditRole,
      executor,
      passes: await listPasses(item.orchestration_id),
    });
    if (verdict.eligible) return { ok: true };
    return { ok: false, reason: verdict.reasons.join(' ') };
  };
}

/**
 * Which accounts are still eligible to take a waiting role on this packet.
 *
 * Used by the dispatcher so a waiting audit role is fired at a surface that can
 * actually take it, rather than at whichever surface sorted first — requirement
 * 7. It is a *preference*, never the authorization: the admission rule above is
 * what refuses, and it refuses whatever was fired.
 */
export async function accountsEligibleFor(input: {
  orchestrationId: string;
  role: AuditRole;
}): Promise<string[]> {
  const [routines, passes] = await Promise.all([
    listRoutines(),
    listPasses(input.orchestrationId),
  ]);
  const eligible = new Set<string>();
  for (const routine of routines) {
    if (!routine.workerId) continue;
    const verdict = auditEligibility({
      role: input.role,
      executor: {
        workerId: routine.workerId,
        routineId: routine.id,
        accountId: routine.accountId,
        // A future session on this Routine is by construction a different
        // session from any already recorded, so the session dimension cannot
        // be decided here and is represented as one that has not happened yet.
        sessionRef: `future:${routine.id}`,
      },
      passes,
    });
    if (verdict.eligible) eligible.add(routine.accountId);
  }
  return [...eligible];
}
