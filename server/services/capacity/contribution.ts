/**
 * Which member-contributed Claude connections are usable capacity, and which
 * are not.
 *
 * ---------------------------------------------------------------------------
 * The question this answers, and the one it refuses to
 * ---------------------------------------------------------------------------
 *
 * A member connecting their Claude account registers a fleet Routine, and the
 * dispatcher fires Routines. So "is this member's capacity usable" is already
 * decided, correctly, by `fleetSnapshot` — and what was missing is a reading
 * that says so **per member, with the refusal named**, so that nothing
 * downstream has to infer it from a state column.
 *
 * It is a projection. It writes nothing, fires nothing and grants nothing, and
 * it is not a gate: no work path calls it to decide whether anything may run.
 * The enforcement is where it always was and stays there —
 * `services/bins/routing.ts` decides which worker may be handed which bin,
 * `services/dispatch/router.ts` decides which surface is fired, and
 * `services/identity/policy.ts` decides what a credential may do. A second
 * place that could authorize execution is the second security model §27
 * refuses, and the weaker one always wins.
 *
 * ---------------------------------------------------------------------------
 * Why an unverified connection can never appear as usable here
 * ---------------------------------------------------------------------------
 *
 * Five conditions, every one of them read from a row Brain wrote:
 *
 *   * the connection is `HEALTHY` — which §32 and §23 both define as the
 *     four-row chain having closed, never as "registered with a credential";
 *   * its authorization is live, so something Brain fires could actually
 *     authenticate;
 *   * the registered Routine is `ENABLED`, which a revoke takes away — a
 *     revoked connection moves its own surface to `UNAVAILABLE`, so it drops
 *     out of the dispatcher's own candidates as well as out of this reading;
 *   * the Routine is bound to *this member's* worker, so a `MISBOUND`
 *     connection — one whose surface answers as somebody else — is refused by
 *     name rather than counted;
 *   * the deployment credential is present, so a fire would not be spent being
 *     refused.
 *
 * Fail any one and the connection is reported `usable: false` with the reason.
 * There is no branch that reports a connection usable without all five, and
 * none that takes anybody's word for any of them.
 *
 * ---------------------------------------------------------------------------
 * What it says about the Software Factory, and what it will not pretend
 * ---------------------------------------------------------------------------
 *
 * A contributed surface is research capacity. Whether it may also take
 * **repository** work is a different fact with a different answer: §27 is
 * explicit that no worker without an explicit `worker_routing` row may ever be
 * handed repository work, and that row is written by onboarding a repository —
 * a person's decision, at `ADMIN`, that this reading does not make and must not
 * imply. So `families` and `repositories` are reported exactly as the routing
 * row states them, and a worker with no row is reported as serving what its
 * scopes imply rather than as serving everything.
 *
 * That is the whole of the honesty requirement here: a verified connection
 * becomes *visible* to the factory's pool through the fleet it already reads,
 * and it becomes *usable* for a repository only when somebody authorizes it.
 */
import { listConnections } from '../../repos/capacityConnections.ts';
import { getAccount, getRoutine } from '../../repos/fleet.ts';
import { getUser, getWorkerByName, getWorkerRouting } from '../../repos/identity.ts';
import { listTokensForWorker } from '../../repos/oauth.ts';
import { resolveToken } from '../dispatch/fire.ts';
import { fleetSnapshot, routingRefusalByRoutine } from '../dispatch/candidates.ts';
import { namesFor, settleConnection } from './connection.ts';

export interface ContributedSurface {
  userId: string;
  /** The member's own name, as the People reading shows it. */
  displayName: string;
  /** The worker Brain fires as. A name, never a credential. */
  workerName: string;
  routineId: string | null;
  routineName: string | null;
  accountName: string | null;
  /** Every one of the five conditions held. */
  usable: boolean;
  /** Why not, in a sentence with the remedy in it. Null when it is usable. */
  because: string | null;
  /**
   * What the routing row says this worker serves.
   *
   * `null` means no row, which is *unknown* rather than *nothing*: §27's rule
   * is that a worker with no row serves what its scopes imply, and that no such
   * worker may ever be handed repository work.
   */
  routing: { families: string[]; repositories: string[] } | null;
}

export interface ContributedCapacity {
  surfaces: ContributedSurface[];
  /** How many cleared all five conditions. */
  usable: number;
  /** How many exist at all, usable or not. */
  total: number;
}

export async function contributedCapacity(): Promise<ContributedCapacity> {
  const connections = await listConnections();
  /*
   * The router's own answer, asked once. Usable capacity is what the dispatcher
   * would fire, and the dispatcher also refuses an unavailable account, a
   * disabled or archived worker, and a worker with no project membership —
   * none of which the checks below read (§23, `surfaceIneligibility`).
   */
  const snapshot = await fleetSnapshot();
  const surfaces: ContributedSurface[] = [];

  for (let connection of connections) {
    const user = await getUser(connection.userId);
    // A connection whose person has been disabled or removed is not this
    // Brain's capacity, and a row that reported one would be counting an
    // identity nobody can sign in as.
    if (!user || user.kind !== 'PERSON' || user.disabledAt !== null) continue;

    const names = namesFor(user);
    /*
     * Settled first, so this reads the same lifecycle the member's own page
     * reads rather than whatever was last written to the column.
     *
     * Without it a connection whose Routine had been repointed went on being
     * counted as capacity until its member next opened their page — the
     * dispatcher's own reading of who can be fired, taken from a stale row.
     */
    const settled = await settleConnection(user, connection);
    connection = settled.connection;
    const worker = settled.worker;
    const routine = connection.routineId ? await getRoutine(connection.routineId) : null;
    const account = routine ? await getAccount(routine.accountId) : null;
    const routing = worker ? await getWorkerRouting(worker.id) : null;

    const tokens = worker ? await listTokensForWorker(worker.id) : [];
    const at = new Date().toISOString();
    const authorizationLive = tokens.some(
      (token) => token.revokedAt === null && token.expiresAt > at,
    );

    const because = ((): string | null => {
      if (connection.state === 'REVOKED') {
        return 'This connection was taken back, so Brain does not fire it.';
      }
      if (connection.state === 'MISBOUND') {
        return (
          'The registered surface is not the one this connection names, so its sessions would ' +
          'be attributed to another worker. A Brain administrator repoints it.'
        );
      }
      if (!routine) return 'No surface is registered for this member yet.';
      if (routine.state !== 'ENABLED') {
        return `The surface is ${routine.state}, so the dispatcher does not fire it.`;
      }
      if (!worker || routine.workerId !== worker.id) {
        return 'The surface is not bound to this member’s worker identity.';
      }
      if (resolveToken(routine.tokenSecretName) === null) {
        return `${routine.tokenSecretName} is not set in this deployment, so a fire would be refused.`;
      }
      const refusal = routingRefusalByRoutine(snapshot, [routine.id]).get(routine.id) ?? null;
      if (refusal !== null) {
        return `The dispatcher would not fire this surface: ${refusal}.`;
      }
      if (!authorizationLive) {
        return 'The Claude connector holds no live authorization, so a session could not authenticate.';
      }
      if (connection.state !== 'HEALTHY') {
        return (
          'Nothing Brain fired at this surface has arrived and finished a piece of work yet. ' +
          'Registered with a credential is CONFIGURED; the bounded self-test is what proves it.'
        );
      }
      return null;
    })();

    surfaces.push({
      userId: connection.userId,
      displayName: user.displayName,
      workerName: names.workerName,
      routineId: routine?.id ?? null,
      routineName: routine?.name ?? null,
      accountName: account?.name ?? null,
      usable: because === null,
      because,
      routing: routing ? { families: [...routing.families], repositories: [...routing.repositories] } : null,
    });
  }

  return {
    surfaces,
    usable: surfaces.filter((one) => one.usable).length,
    total: surfaces.length,
  };
}

/**
 * The member-contributed surfaces the Software Factory could actually use for
 * one repository.
 *
 * Two questions, both of them rows: is the connection verified capacity at all
 * (the five conditions above), and does its worker's routing row name this
 * repository *and* the factory's workload family. Both must hold. A worker with
 * no routing row is excluded rather than assumed, which is §27's own rule — no
 * worker without an explicit row may be handed repository work — applied to the
 * reading rather than only to the claim.
 */
export function contributedForRepository(
  capacity: ContributedCapacity,
  repositoryId: string | null,
): ContributedSurface[] {
  if (!repositoryId) return [];
  return capacity.surfaces.filter(
    (one) =>
      one.usable &&
      one.routing !== null &&
      one.routing.families.includes('FACTORY') &&
      one.routing.repositories.includes(repositoryId),
  );
}
