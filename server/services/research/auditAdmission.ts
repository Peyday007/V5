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
import { getDb } from '../../db/database.ts';
import { listRoutines } from '../../repos/fleet.ts';
import { listPasses } from '../../repos/research.ts';
import { parseJson } from '../../repos/util.ts';
import { AUDIT_ROLES, type AuditRole } from '../queue/workTypes.ts';
import { auditEligibility, type ExecutorLineage } from './auditEligibility.ts';
import {
  lineageFromPasses,
  SEPARATION_LADDER,
  type AuditLineage,
  type SeparationTier,
} from './independence.ts';
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

    /*
     * A mission that asked for a stronger tier is judged against it *here*,
     * where the refusal actually binds, and not only at launch. Checked at
     * launch alone the requirement would be decorative: the packet would start
     * and then be audited at the floor it was trying to exceed.
     *
     * It is read from the mission behind the orchestration — a server row —
     * rather than from the item's payload, because a payload field is
     * caller-supplied and `stricter()` only ever raises. A missing or
     * unreadable declaration means the floor, never a lowering.
     */
    const requiredTier = await missionRequiredTier(item.orchestration_id);

    const verdict = auditEligibility({
      role: role as AuditRole,
      executor,
      passes: await listPasses(item.orchestration_id),
      ...(requiredTier ? { requiredTier } : {}),
    });
    if (verdict.eligible) return { ok: true };
    return { ok: false, reason: verdict.reasons.join(' ') };
  };
}

/**
 * The stronger separation a mission declared, if it declared one.
 *
 * Carried in the candidate's own recorded `missionSpec` — the identical source
 * `repairLaunches` rebuilds a launch from — so a mission's requirement survives
 * a crash and needs no column of its own. Anything unreadable is the floor:
 * this may raise the bar and must never be a way to lower it.
 */
export async function missionRequiredTier(
  orchestrationId: string,
): Promise<SeparationTier | null> {
  try {
    const found = await getDb().all<{ judgment: string | null }>(
      `SELECT c.judgment AS judgment
         FROM russell_missions m
         JOIN russell_candidates c ON c.id = m.candidate_id
        WHERE m.orchestration_id = ?
        ORDER BY m.created_at, m.rowid
        LIMIT 1`,
      [orchestrationId],
    );
    const judgment = parseJson<Record<string, unknown>>(found[0]?.judgment ?? '{}', {});
    const spec = judgment['missionSpec'];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
    const want = (spec as Record<string, unknown>)['requiredSeparation'];
    return typeof want === 'string' && (SEPARATION_LADDER as readonly string[]).includes(want)
      ? (want as SeparationTier)
      : null;
  } catch {
    // A Brain with no Russell tables is a Brain with no mission declaring one.
    return null;
  }
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
  const ranked = await rankSurfacesFor(input);
  return [...new Set(ranked.map((surface) => surface.accountId))];
}

export interface RankedSurface {
  routineId: string;
  accountId: string;
  workerId: string;
  /** The strongest separation this surface would achieve if it took the role. */
  wouldAchieve: SeparationTier;
}

/**
 * The surfaces that could take a waiting role, strongest separation first.
 *
 * This is the **allocator**, and it is a preference rather than the
 * authorization — `auditAdmission` above is what refuses, and it refuses
 * whatever was actually fired. Keeping them apart is what lets the preference
 * be optimistic: it may reach for an account-separated surface and be wrong
 * about which session eventually arrives, and nothing unsafe follows, because
 * the arriving session is judged on its own recorded lineage.
 *
 * **No count appears here.** One Routine, one account and one worker produce a
 * ranked list of one that satisfies the session floor through a fresh
 * activation; twenty accounts produce a longer list whose head is
 * account-separated. Adding or removing surfaces changes capacity and
 * assurance — never whether a packet can finish.
 */
export async function rankSurfacesFor(input: {
  orchestrationId: string;
  role: AuditRole;
  requiredTier?: SeparationTier;
}): Promise<RankedSurface[]> {
  const [routines, passes] = await Promise.all([
    listRoutines(),
    listPasses(input.orchestrationId),
  ]);
  const { audits } = lineageFromPasses(passes);

  const ranked: RankedSurface[] = [];
  for (const routine of routines) {
    if (!routine.workerId) continue;
    const executor = {
      workerId: routine.workerId,
      routineId: routine.id,
      accountId: routine.accountId,
      /*
       * `future:` is a *prediction*, and only ever that.
       *
       * A session that has not happened is by construction distinct from every
       * recorded one, which is exactly what makes the session floor reachable
       * on a single Routine. It is used to decide where to send work and is
       * never written to a pass — final evidence has to contain three real
       * authenticated session references, and `strongestSeparation` reads those
       * rows rather than this placeholder.
       */
      sessionRef: `future:${routine.id}`,
    };
    const verdict = auditEligibility({
      role: input.role,
      executor,
      passes,
      ...(input.requiredTier ? { requiredTier: input.requiredTier } : {}),
    });
    if (!verdict.eligible) continue;
    ranked.push({
      routineId: routine.id,
      accountId: routine.accountId,
      workerId: routine.workerId,
      wouldAchieve: predictTier(executor, audits),
    });
  }

  // Strongest first. The ladder is strongest-first already, so ordering is its
  // index — no numeric weights to drift out of step with the ladder itself.
  ranked.sort(
    (a, b) => SEPARATION_LADDER.indexOf(a.wouldAchieve) - SEPARATION_LADDER.indexOf(b.wouldAchieve),
  );
  return ranked;
}

/**
 * The tier a candidate would reach against what has already run.
 *
 * Optimistic by design and safe because it decides nothing: the arriving
 * session is judged on its own rows. With no roles recorded yet every surface
 * predicts `SESSION`, because a first role separates from nothing.
 */
function predictTier(
  executor: { accountId: string | null; workerId: string; routineId: string | null },
  audits: AuditLineage[],
): SeparationTier {
  if (audits.length === 0) return 'SESSION';
  const differsOnAll = (read: (l: AuditLineage) => string | null, mine: string | null): boolean =>
    mine !== null && audits.every((other) => read(other) !== null && read(other) !== mine);

  if (differsOnAll((l) => l.accountId, executor.accountId)) return 'ACCOUNT';
  if (differsOnAll((l) => l.workerId, executor.workerId)) return 'WORKER';
  if (differsOnAll((l) => l.routineId, executor.routineId)) return 'ROUTINE';
  return 'SESSION';
}

/**
 * Is there any surface that could take a role at all?
 *
 * The distinction this exists to make: **no healthy execution surface** is a
 * different fact from *this packet cannot be separated*, and conflating them
 * produced a blocker that named a missing person. A fleet with no Routine that
 * has ever checked in cannot run an audit for reasons that have nothing to do
 * with independence, and it says so in those words.
 */
export async function healthySurfaceCount(): Promise<number> {
  const routines = await listRoutines();
  return routines.filter(
    (routine) =>
      routine.workerId !== null &&
      routine.tokenDigest !== null &&
      routine.tokenDigest !== '' &&
      (routine.state === 'ENABLED' || routine.state === 'DRAINING'),
  ).length;
}

/**
 * What separation the current fleet could actually supply, and what it lacks.
 *
 * The minimum is `SESSION` and needs no arithmetic at all — a session comes
 * into existence when a Routine is activated, so one healthy surface can
 * supply three distinct ones by being fired three times. That is why the floor
 * has no count in it and why a one-account fleet is complete rather than
 * degraded.
 *
 * A *stronger* tier does have arithmetic, and it is not a policy constant: an
 * audit's three roles are compared pairwise, so raising the floor to a
 * dimension means all three roles must differ at that dimension, which means
 * three distinct values of it must exist. Counting accounts here is therefore
 * measuring a capability, never encoding a requirement — nothing is refused for
 * being a small fleet, and only a mission that asked for more than the fleet
 * has is affected.
 */
export const SEPARATION_ROLE_SLOTS = 3;

export interface SeparationCapacity {
  /** The strongest tier this fleet could supply across all three roles. */
  strongest: SeparationTier | null;
  accounts: number;
  workers: number;
  routines: number;
  surfaces: number;
}

export async function separationCapacity(): Promise<SeparationCapacity> {
  const routines = await listRoutines();
  const healthy = routines.filter(
    (routine) =>
      routine.workerId !== null &&
      routine.tokenDigest !== null &&
      routine.tokenDigest !== '' &&
      (routine.state === 'ENABLED' || routine.state === 'DRAINING'),
  );
  const accounts = new Set(healthy.map((r) => r.accountId)).size;
  const workers = new Set(healthy.map((r) => r.workerId!)).size;
  const capacity: SeparationCapacity = {
    strongest: null,
    accounts,
    workers,
    routines: healthy.length,
    surfaces: healthy.length,
  };
  if (accounts >= SEPARATION_ROLE_SLOTS) capacity.strongest = 'ACCOUNT';
  else if (workers >= SEPARATION_ROLE_SLOTS) capacity.strongest = 'WORKER';
  else if (healthy.length >= SEPARATION_ROLE_SLOTS) capacity.strongest = 'ROUTINE';
  else if (healthy.length >= 1) capacity.strongest = 'SESSION';
  return capacity;
}

/**
 * Can the fleet supply this tier today, and if not, what exactly is missing?
 *
 * The sentence is the whole point. "Blocked" is not an actionable state, and
 * `MISSING_FRIEND` was worse than unactionable — it named a person as the
 * remedy for a capacity fact. What a parked mission records instead is the
 * capability it lacks and the number of it that exist, so the thing that
 * unparks it is visible and happens by itself when a row appears.
 */
export function separationShortfall(
  want: SeparationTier,
  have: SeparationCapacity,
): string | null {
  if (have.surfaces === 0) {
    return 'NO_HEALTHY_EXECUTION_SURFACE: no Routine is enabled with a registered secret';
  }
  const rank = (tier: SeparationTier): number => SEPARATION_LADDER.indexOf(tier);
  if (have.strongest !== null && rank(have.strongest) <= rank(want)) return null;
  const counts: Record<SeparationTier, number> = {
    ACCOUNT: have.accounts,
    WORKER: have.workers,
    ROUTINE: have.routines,
    SESSION: have.surfaces,
  };
  return (
    `INSUFFICIENT_${want}_SEPARATION: this mission asked for ${want} separation, ` +
    `which needs ${SEPARATION_ROLE_SLOTS} distinct ${want.toLowerCase()}s and the fleet has ` +
    `${counts[want]}. It resumes by itself when another is registered.`
  );
}
