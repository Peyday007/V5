/**
 * A coding worker on a permanent, subscription-backed Cowork Routine.
 *
 * ---------------------------------------------------------------------------
 * This file used to be a refusal, and the refusal has been answered — but not
 * in the place it was written
 * ---------------------------------------------------------------------------
 *
 * The earlier version said, correctly, that what did not exist was the
 * unit-level handshake: a remote session claiming a *factory* unit, checking out
 * a worktree and reporting a branch. It reported the surface as UNKNOWN capacity
 * and refused to pretend otherwise. That was the honest answer at the time.
 *
 * The handshake now exists and it is **not an executor**. It is
 * `services/factory/remote.ts`, `remoteLoop.ts` and the bin plane: a stage of a
 * campaign becomes a bin, the Step 10/11 dispatcher fires a Routine, a session
 * with its own checkout drains the bin through `/mcp`, and Brain confirms what
 * it did with the forge. The correction is recorded here rather than by deleting
 * the file, the same way §22 records Step 7's wrong reasoning about OAuth.
 *
 * Why it could not be an executor, which is the part worth keeping: an
 * `Executor` is a function Brain *calls* and waits on, holding a worktree path
 * it can see. The deployed Brain has no checkout and no filesystem a worker
 * shares, and a Routine activation is not a call — it is a fire that may be
 * refused, may arrive minutes later, may be taken over by a different session,
 * and must survive Brain restarting in the middle. Squeezing that into
 * `execute(request): Promise<ExecutionResult>` would have meant either a
 * long-lived promise nothing could recover (a restart loses the work) or a fake
 * synchronous answer, which is the invented evidence this codebase exists to
 * refuse. The bin has all four properties already — durable, leased, fenced,
 * resumable — because Steps 5, 6, 10 and 11 built them.
 *
 * ---------------------------------------------------------------------------
 * So what is this executor for
 * ---------------------------------------------------------------------------
 *
 * It is the honest boundary between the two planes, and it says which one a
 * campaign is on. A `COWORK_ROUTINE` worker is a real registration — the
 * registry accepts it, the readiness report counts it, and nothing refuses it —
 * but units are never *assigned* to it, because in this plane units are not
 * assigned to factory workers at all. They are carried by bins, and the
 * execution surface is the fleet in `fleet_routines`.
 *
 * `probe` therefore answers the question that actually matters here: is there a
 * fleet surface that could take repository work? It asks `fleet.ts` rather than
 * asserting anything, so a Brain with no registered Routine reports no capacity
 * instead of claiming some. And `execute` refuses by design: a campaign that
 * reached it is a campaign in the wrong plane, which is a defect worth a clear
 * error rather than a silent spawn.
 */
import type { ExecutionRequest, ExecutionResult, Executor } from './index.ts';
import { FACTORY_CAPABILITY } from '../remote.ts';

export const coworkExecutor: Executor = {
  kind: 'COWORK_ROUTINE',

  /**
   * Whether a fleet surface exists that could take repository work.
   *
   * Read from rows, never asserted. A Routine whose deployment secret is not
   * present is deliberately not counted — `listRoutines` records the name of the
   * secret and a digest, and a surface that cannot be fired is not capacity.
   */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { listRoutines } = await import('../../../repos/fleet.ts');
      const routines = await listRoutines();
      const usable = routines.filter(
        (routine) =>
          routine.state === 'ENABLED' &&
          // The deployment secret named by the row, resolved the same way the
          // dispatcher resolves it. A Routine whose secret is not present is a
          // Routine that cannot be fired, and that is not capacity.
          (process.env[routine.tokenSecretName] ?? '').trim().length > 0,
      );
      if (usable.length === 0) {
        return {
          ok: false,
          detail:
            'No enabled fleet Routine is registered, so there is nowhere for repository work to ' +
            'run. Register one with `npm run fleet -- routine:register`; Brain holds the name of ' +
            'its deployment secret and a digest of the value, never the value.',
        };
      }
      return {
        ok: true,
        detail:
          `${usable.length} enabled fleet Routine(s) can be fired. Factory work reaches them as ` +
          `bins requiring the \`${FACTORY_CAPABILITY}\` capability, not as unit assignments to ` +
          'this worker row — the campaign runs in REMOTE mode and the fleet is its execution ' +
          'surface.',
      };
    } catch (error: unknown) {
      // Unknown rather than available. "We could not tell" must never read the
      // same as "we checked".
      return {
        ok: false,
        detail:
          'The fleet could not be read, so whether repository work has anywhere to run is ' +
          `unknown: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      outcome: 'ERROR',
      externalSessionId: null,
      summary: '',
      rawLog: '',
      durationMs: 0,
      numTurns: null,
      usage: null,
      retryAfterMs: null,
      detail:
        `Unit ${request.unitId} was assigned to a Cowork Routine worker, which cannot happen in ` +
        'a correct campaign: a campaign whose execution is on the fleet carries its work as ' +
        'bins and assigns no unit to a factory worker row. This is a defect in whatever routed ' +
        'it here, reported rather than papered over with a spawn.',
      paidApi: false,
    };
  },
};
