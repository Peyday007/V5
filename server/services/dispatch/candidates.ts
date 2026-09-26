/**
 * What the router needs to know, read from rows.
 *
 * Kept apart from `router.ts` on purpose. The router is a pure function so a
 * decision can be replayed and argued with; this is the impure half that goes
 * and gets the numbers. Separating them is what makes "why did this bin go to
 * that account" answerable from a recorded input rather than from a re-run
 * against a database that has since moved.
 */
import { deliveryReadings } from '../../repos/deliveryProofs.ts';
import { getDb } from '../../db/database.ts';
import {
  currentPolicy,
  effectiveTarget,
  listAccounts,
  listRoutines,
} from '../../repos/fleet.ts';
import { resolveToken } from './fire.ts';
import { surfaceIneligibility, type RoutingCandidate } from './router.ts';
import type { FleetAccount, FleetPolicy } from '../../domain/types.ts';
import { getWorker, getWorkerRouting, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { derivedFamiliesFrom } from '../bins/routing.ts';
import { latestAllowanceReports } from '../../repos/allowance.ts';

/**
 * How long a sent activation counts as in flight.
 *
 * Not a timeout and not a lease — those belong to the bin. This is only the
 * window in which a fire we made is still plausibly a running session, for the
 * purpose of not starting more than the target allows. Too short and Brain
 * over-fires; too long and it under-fires after a quiet failure. Thirty minutes
 * is longer than every activation Step 10 measured (the longest drained seven
 * bins in 107 seconds) and short enough that a dead session frees its slot
 * within one operator's attention span.
 */
export const IN_FLIGHT_WINDOW_MS = 30 * 60_000;

export interface FleetSnapshot {
  candidates: RoutingCandidate[];
  fleetPolicy: FleetPolicy | null;
  fleetInFlight: number;
  /** Routines registered but skipped because their secret is not deployed. */
  missingSecrets: { routineId: string; secretName: string }[];
}

/**
 * Activations started and not yet visibly finished, per Routine.
 *
 * Counted from `bin_dispatch` rather than from bins, because the question is
 * "how many sessions did we start" and a session exists from the moment the
 * provider accepted the fire — before any bin is leased, and still while one is
 * being drained. Counting leased bins instead would read zero in the window
 * between firing and check-in, which is exactly when over-firing happens.
 *
 * ---------------------------------------------------------------------------
 * A reservation is not an occupied slot
 * ---------------------------------------------------------------------------
 *
 * This number decides `ACCOUNT_TARGETS_REACHED`, which is what refused the
 * frozen acceptance message five times on 2026-09-04 — so counting a session
 * that is not running is not a rounding error, it is a fleet that refuses work
 * it has room for. Four conditions separate a live activation from a stale
 * reservation, and each is exact rather than a heuristic:
 *
 *   1. **The bin has not gone terminal.** `COMPLETE`, `CANCELLED` and `FAILED`
 *      were already excluded. `NEEDS_HUMAN` is added: it is terminal for the
 *      worker, whose session ended when it escalated, and holding a slot for a
 *      bin that is waiting on a *person* is the clearest stale reservation
 *      there is.
 *
 *   2. **It is the newest fire for its bin.** A bin whose worker never arrived
 *      is re-dispatched at a later generation, and the earlier `SENT` row stays
 *      `SENT` forever — `supersedeStaleIntents` only touches `PENDING` ones,
 *      deliberately, because a fire that really happened must not be rewritten
 *      as though it had not. So the old row was counted beside the new one and
 *      one bin reserved two slots. Note that this is **not** a generation
 *      *match* against the bin: a bin's generation advances the moment a worker
 *      is assigned, so requiring equality would drop the count exactly when a
 *      session starts working, reintroducing the hole the paragraph above
 *      exists to close.
 *
 *   3. **If a worker took it, the lease has not lapsed.** An expired lease is
 *      claimable work everywhere else in this codebase (§19); a session whose
 *      lease Brain has already written off is not occupying a slot.
 *
 *   4. **The fire is recent**, which is `IN_FLIGHT_WINDOW_MS` and was already
 *      here. It is the backstop for everything the first three cannot see.
 *
 * Every one of these can only *lower* the count, so the failure mode this
 * changes is under-firing rather than over-firing — and the targets, the fire
 * slot's compare-and-swap and the provider's own refusals all still bound the
 * other direction.
 */
export async function inFlightByRoutine(nowMs: number): Promise<Map<string, number>> {
  const since = new Date(nowMs - IN_FLIGHT_WINDOW_MS).toISOString();
  const now = new Date(nowMs).toISOString();
  const rows = await getDb().all<{ routine_id: string | null; n: number }>(
    `SELECT d.routine_id AS routine_id, COUNT(*) AS n
       FROM bin_dispatch d
       JOIN bins b ON b.id = d.bin_id
      WHERE d.state = 'SENT' AND d.sent_at >= ?
        AND b.state NOT IN ('COMPLETE','CANCELLED','FAILED','NEEDS_HUMAN')
        AND d.lease_generation = (
              SELECT MAX(d2.lease_generation) FROM bin_dispatch d2
               WHERE d2.bin_id = d.bin_id AND d2.state = 'SENT')
        AND (b.state <> 'LEASED' OR b.lease_expires_at > ?)
      GROUP BY d.routine_id`,
    [since, now],
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.routine_id) out.set(row.routine_id, Number(row.n));
  }
  return out;
}

/**
 * Everything the router needs, assembled once per tick.
 *
 * A Routine whose secret is not present in this deployment is left out of the
 * candidate list and reported separately. That is a real state — a row can be
 * registered before its secret is set, or a secret can be rotated away — and
 * treating it as "eligible but will fail" would spend the fleet's scarce fire
 * budget discovering it.
 */
export async function fleetSnapshot(now = new Date()): Promise<FleetSnapshot> {
  const nowIso = now.toISOString();
  const [accounts, routines, fleetPolicy, perRoutine, allowanceReports] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicy('FLEET', null),
    inFlightByRoutine(now.getTime()),
    latestAllowanceReports(),
  ]);
  const readingsByRoutine = await deliveryReadings();

  const accountById = new Map<string, FleetAccount>(accounts.map((a) => [a.id, a]));
  const perAccount = new Map<string, number>();
  for (const routine of routines) {
    const n = perRoutine.get(routine.id) ?? 0;
    perAccount.set(routine.accountId, (perAccount.get(routine.accountId) ?? 0) + n);
  }

  const candidates: RoutingCandidate[] = [];
  const missingSecrets: { routineId: string; secretName: string }[] = [];

  /*
   * The families each Routine's bound worker may be handed, read once.
   *
   * A Routine bound to no worker resolves to `null` — the question cannot be
   * answered, and the router treats that as eligible because the fire is not the
   * boundary. A worker with no routing row resolves to its *derived* default,
   * which is the same rule the assigner applies, so the two cannot disagree about
   * a worker nobody has narrowed.
   */
  const scopeByWorker = new Map<string, WorkerRoutingScope>();
  for (const routine of routines) {
    if (!routine.workerId || scopeByWorker.has(routine.workerId)) continue;
    scopeByWorker.set(routine.workerId, await routingScopeForWorker(routine.workerId));
  }

  for (const routine of routines) {
    const account = accountById.get(routine.accountId);
    if (!account) continue;
    if (!resolveToken(routine.tokenSecretName)) {
      missingSecrets.push({ routineId: routine.id, secretName: routine.tokenSecretName });
      continue;
    }
    const [routinePolicy, accountPolicy] = await Promise.all([
      currentPolicy('ROUTINE', routine.id),
      currentPolicy('ACCOUNT', account.id),
    ]);
    candidates.push({
      routine,
      account,
      servesFamilies: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.families ?? null
        : null,
      servesRepositories: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.repositories ?? null
        : null,
      /*
       * A Routine bound to no worker serves **no project**, and that is the one
       * place this snapshot deliberately fails closed.
       *
       * The two lines above resolve an unbound Routine to `null`, which the
       * router reads as eligible, because the cost of firing an out-of-scope
       * surface is one wasted activation and the cost of refusing an unknown is
       * work nothing is ever started for. That reasoning does not survive being
       * applied to the project: with one worker per private project, firing a
       * surface that cannot be handed the bin is not an occasional waste, it is
       * the *common* case — three fires in four at four operations, each
       * costing a 30-minute in-flight window before the intent can be re-armed.
       *
       * And the bootstrap this would otherwise deadlock has an operator's
       * answer already: `fleet bind-worker --ref trig_… --worker <name>` states
       * the binding rather than waiting to observe one, so a freshly registered
       * Routine is one command away from eligible.
       */
      deliveryReadings: Object.fromEntries(readingsByRoutine.get(routine.id) ?? []),
      servesProjects: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.projects ?? []
        : [],
      workerActive: routine.workerId
        ? scopeByWorker.get(routine.workerId)?.active ?? false
        : false,
      routineInFlight: perRoutine.get(routine.id) ?? 0,
      accountInFlight: perAccount.get(account.id) ?? 0,
      routineTarget: routinePolicy ? effectiveTarget(routinePolicy, nowIso).target : null,
      accountTarget: accountPolicy ? effectiveTarget(accountPolicy, nowIso).target : null,
      allowanceReport: allowanceReports.get(account.id) ?? null,
    });
  }

  let fleetInFlight = 0;
  for (const n of perRoutine.values()) fleetInFlight += n;

  return { candidates, fleetPolicy, fleetInFlight, missingSecrets };
}

/** What one worker may be handed, in the dimensions the fire decides on. */
interface WorkerRoutingScope {
  families: string[];
  /** Explicit and exhaustive, or `null` when the worker has no routing row. */
  repositories: string[] | null;
  /**
   * The projects this worker holds a **live** membership on.
   *
   * Always an array, never null, and that is the difference between this
   * dimension and the two above. Families and repositories are *scopes an
   * operator narrows*, so not having narrowed one is an unknown and the router
   * fails open on it. A project membership is not a narrowing — it is the
   * authorization itself, written by Brain, and a worker that holds none may be
   * handed nothing. There is no unknown here to fail open on, so the empty
   * array is a complete answer rather than a missing one.
   */
  projects: string[];
  /** Can this worker authenticate at all: present, not disabled, not archived. */
  active: boolean;
}

/**
 * The routing scope of one worker, for the routing snapshot.
 *
 * Its own function because the *derived* default needs the worker's membership
 * scopes, and `fleetSnapshot` holds a Routine rather than a principal. Reading
 * the memberships here keeps one rule — a worker with no explicit row serves what
 * its scopes imply and no repository work — rather than letting the fire side
 * invent a second, more generous default.
 *
 * An unreadable row resolves to `RESEARCH`/`GENERAL` and never to the repository
 * family, so a failure here can waste a fire and can never start a surface on
 * software work it is not authorized for.
 */
async function routingScopeForWorker(workerId: string): Promise<WorkerRoutingScope> {
  try {
    /*
     * Live memberships, read once and used for both answers.
     *
     * `listMembershipsForPrincipal` returns live rows only — "a revoked one is
     * not a weaker membership; it is none" — so a revocation removes this
     * Routine from routing on the very next snapshot, with nothing to
     * invalidate and no cache to miss.
     */
    const worker = await getWorker(workerId);
    const active = worker !== null && !worker.disabled && !worker.archived;
    const memberships = await listMembershipsForPrincipal('WORKER', workerId);
    const projects = memberships
      .filter((membership) => membership.active)
      .map((membership) => membership.projectId);

    const explicit = await getWorkerRouting(workerId);
    // An explicit row is exhaustive in both of *its* dimensions, which is the
    // same rule the admission hook reads it by. It says nothing about projects:
    // `worker_routing` has no project column, because the project a worker may
    // serve is its membership and never a routing preference.
    if (explicit) {
      return { families: explicit.families, repositories: explicit.repositories, projects, active };
    }
    // The derived default, from the one function that defines it. Its
    // repositories are *unknown* rather than empty — and unreachable, because
    // the derived families never include a repository family.
    return {
      families: derivedFamiliesFrom(memberships),
      repositories: null,
      projects,
      active,
    };
  } catch {
    /*
     * An unreadable row wastes a fire in the two dimensions that fail open, and
     * serves **no project** in the one that does not. A read that failed is not
     * evidence of a membership, and manufacturing one here would be exactly the
     * unknown-as-favourable-assumption invariant 39 forbids.
     */
    return { families: ['RESEARCH', 'GENERAL'], repositories: null, projects: [], active: false };
  }
}

/**
 * Why the router would refuse each registered Routine, independent of any bin.
 *
 * `surfaceIneligibility` answers for a routing candidate; a Routine whose secret
 * is not deployed never becomes one, and a Routine whose account row is gone is
 * skipped outright. Readers that describe a surface to a person (Who, goals,
 * the Fleet page) need an answer for all three, and deriving it here keeps
 * them asking the router's question rather than reading a state column — the
 * disagreement §23 records at four readers already.
 *
 * `null` means the router would consider it; it says nothing about headroom.
 */
export function routingRefusalByRoutine(snapshot: FleetSnapshot, routineIds: readonly string[]): Map<string, string | null> {
  const candidates = new Map(snapshot.candidates.map((one) => [one.routine.id, one]));
  const missing = new Set(snapshot.missingSecrets.map((one) => one.routineId));
  const out = new Map<string, string | null>();
  for (const id of routineIds) {
    const candidate = candidates.get(id);
    if (candidate) out.set(id, surfaceIneligibility(candidate));
    else if (missing.has(id)) out.set(id, 'its deployment secret is not present');
    else out.set(id, 'its account is not registered');
  }
  return out;
}
