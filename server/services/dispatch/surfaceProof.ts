/**
 * Does this Routine actually run as the worker it is bound to?
 *
 * ---------------------------------------------------------------------------
 * Why the obvious answer is not an answer
 * ---------------------------------------------------------------------------
 *
 * The first version of this check read two things: the Routine's `worker_id`,
 * and whether an OAuth token had ever been minted for that worker and used. Both
 * are true facts and neither is the claim.
 *
 * `fleet_routines.worker_id` is an **operator's assertion** — a row somebody
 * wrote, or an observation from a previous arrival — and a token is held by a
 * **connector**, which is not a Routine. One Claude account can hold several
 * connectors and several Routines, and nothing about a minted, used token says
 * which Routine, if any, is configured with the connector that holds it. So
 * "registered for worker X" and "X has authenticated somewhere" can both be true
 * of a Routine whose Cowork configuration actually selects a different connector
 * — which is precisely the mistake a second connector *name* invites, and the
 * one this command exists to catch.
 *
 * ---------------------------------------------------------------------------
 * What is actually asked
 * ---------------------------------------------------------------------------
 *
 * A chain of four links, every one of them a row Brain wrote itself:
 *
 *   1. **Fired** — a `bin_dispatch` row Brain sent to *this* Routine.
 *   2. **Arrived** — a `worker_sessions` row for that fire. It is written at
 *      arrival *from that same dispatch row*, never from anything the worker says
 *      about itself, so the worker id on it is Brain's own attribution of who
 *      turned up.
 *   3. **Assigned** — that session was handed the bin the fire was for.
 *   4. **Completed** — the bin reached `COMPLETE`, so the session did not merely
 *      authenticate: it did a piece of work Brain accepted.
 *
 * Anything less is reported as less. A Routine with arrivals but no completion is
 * a surface that connects and cannot finish; a Routine whose arrivals
 * authenticated as a *different* worker is the failure this whole check is for,
 * and it is a fault rather than a missing proof.
 *
 * Pure over rows it is handed, for `router.ts`'s reason: the decision has to be
 * answerable afterwards from a recorded input rather than from a re-run against a
 * database that has moved.
 */
import type { Bin, BinDispatch } from '../../domain/types.ts';
import type { WorkerSession } from '../../repos/fleet.ts';

/** The four links, when all four are present. */
export interface SurfaceChain {
  sessionRef: string;
  binId: string;
  observedAt: string;
  /** When Brain fired, if the dispatch row that produced this arrival is still readable. */
  sentAt: string | null;
}

export interface SurfaceProof {
  chain: SurfaceChain | null;
  /** Arrivals on this Routine that authenticated as somebody else. */
  foreignWorkerIds: string[];
  sessionCount: number;
  problems: string[];
}

export interface SurfaceProofInput {
  /** The worker `fleet_routines.worker_id` names. */
  boundWorkerId: string;
  routineRef: string;
  /** Every arrival attributed to this Routine, newest first. */
  sessions: readonly WorkerSession[];
  /** The bin each session was observed taking, by bin id. */
  bins: ReadonlyMap<string, Bin | null>;
  /** Every dispatch intent for those bins, by bin id. */
  dispatches: ReadonlyMap<string, readonly BinDispatch[]>;
}

export function proveSurface(input: SurfaceProofInput): SurfaceProof {
  const foreign = input.sessions.filter((session) => session.workerId !== input.boundWorkerId);
  let chain: SurfaceChain | null = null;

  for (const session of input.sessions) {
    if (session.workerId !== input.boundWorkerId) continue;
    const bin = input.bins.get(session.binId) ?? null;
    // Assigned *and* accepted. A bin the session took and abandoned proves the
    // connector and not the surface's ability to finish anything.
    if (!bin || bin.state !== 'COMPLETE') continue;
    const sent = (input.dispatches.get(session.binId) ?? []).find(
      (intent) => intent.routineRef === input.routineRef && intent.sentAt !== null,
    );
    chain = {
      sessionRef: session.sessionRef,
      binId: session.binId,
      observedAt: session.observedAt,
      sentAt: sent?.sentAt ?? null,
    };
    break;
  }

  const problems: string[] = [];
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map((session) => session.workerId))].join(', ');
    problems.push(
      `${foreign.length} session(s) on this Routine authenticated as a different worker (${names}) — ` +
        'its connector is not the identity this surface is bound to',
    );
  }
  if (!chain) {
    problems.push(
      input.sessions.length === 0
        ? 'no fire to this Routine has ever produced an authenticated arrival, so nothing yet shows ' +
          'this Routine uses this worker — re-run with --probe to create one bounded self-test'
        : 'this Routine has produced arrivals but none of them was assigned a bin it then completed, ' +
          'so the chain from fire to accepted completion is not closed',
    );
  }

  return { chain, foreignWorkerIds: [...new Set(foreign.map((s) => s.workerId))], sessionCount: input.sessions.length, problems };
}
