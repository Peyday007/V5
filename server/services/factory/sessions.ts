/**
 * What the hosted plane actually ran, read back from the rows Brain wrote.
 *
 * `metrics.ts` answers *how many sessions were genuinely running at one
 * instant* by sweeping `factory_sessions`, and every writer of that table is on
 * the **local** plane: `architect.ts`, `dispatch.ts`, `review.ts` and
 * `recovery.ts` each open a session because each one *starts* a process it can
 * time. The hosted plane starts nothing — Brain fires a Routine and a worker
 * somewhere else does the work — so it opened no sessions, and a hosted
 * campaign therefore reported `maxObservedConcurrency: 0` with
 * `concurrencyEvidence: UNKNOWN` over sessions that demonstrably ran.
 *
 * **That is not the same defect as a ceiling nobody has observed, and the
 * difference is the whole reason this module exists.** §27's rule is that a
 * ceiling nobody has seen reads UNKNOWN and stays UNKNOWN, and it is right.
 * Here Brain *did* see them: it wrote the dispatch, recorded the arrival, timed
 * the lease and stamped the terminal event. Every fact needed was already in
 * `bin_events` and `bin_dispatch`, and nothing read them into the one table the
 * question is asked of — a column nothing reads, which is the shape this
 * repository has corrected more often than any other.
 *
 * Three properties keep this a reading rather than a claim.
 *
 * **Nothing here comes from a worker.** The interval is Brain's own assignment
 * and terminal events; the worker identity is the one Brain leased the bin to;
 * the account comes from the `bin_dispatch` row Brain wrote when it chose the
 * surface. A worker's own account of itself contributes nothing, which is
 * §24's rule at the table that decides what concurrency is reported as.
 *
 * **It is derived on the tick, not hooked to the moment a bin finished.** So it
 * reaches the episodes already stranded — every hosted campaign this Brain has
 * ever run — survives a tick that died halfway, and cannot be missed by a code
 * path that forgot to call something. Fifth time that distinction has been the
 * difference between a fix that reaches production and one that does not.
 *
 * **It under-counts rather than over-counts.** An episode Brain has no close
 * event for — a lease that simply expired — is skipped rather than being given
 * an invented end, so the overlap reported is a floor. A concurrency figure
 * that guessed at an ending would be the projection §27 refuses to report as
 * throughput.
 */
import type { Bin, BinEvent } from '../../domain/types.ts';
import type { FactoryRole, FactorySessionState } from '../../domain/factory.ts';
import { dispatchAttributionForLease, listBinEvents } from '../../repos/bins.ts';
import { getAccount, getRoutine } from '../../repos/fleet.ts';
import { recordObservedSession } from '../../repos/factoryFleet.ts';
import { listUnits } from '../../repos/factory.ts';
import { campaignBins } from './remote.ts';

/** An assignment that ended, which is the only thing that is a session here. */
export interface SessionEpisode {
  leaseId: string | null;
  leaseGeneration: number;
  workerId: string | null;
  /** What the worker reported. Kept for the record; it decides nothing. */
  reportedSession: string | null;
  attempt: number;
  startedAt: string;
  endedAt: string;
  state: Exclude<FactorySessionState, 'RUNNING'>;
  exitReason: string | null;
  durationMs: number | null;
}

const OPENS = new Set(['BIN_ASSIGNED', 'BIN_TAKEOVER']);
const CLOSES = new Set(['BIN_TERMINAL', 'BIN_RELEASED']);

/**
 * Which of the five roles a factory bin's execution was.
 *
 * A `Record` over the bin kinds rather than a chain of `if`s, so a stage added
 * later is a compile error here instead of a session silently recorded as the
 * wrong role. `FACTORY_DELIVER` maps to `INTEGRATOR` because what that bin does
 * is act on the forge artifact — push the branch, open or update the pull
 * request — and `VERIFIER` would claim it ran the verification, which the
 * integrate stage did.
 */
export const ROLE_OF_BIN_KIND: Record<string, FactoryRole> = {
  FACTORY_PLAN: 'ARCHITECT',
  FACTORY_UNITS: 'IMPLEMENTER',
  FACTORY_INTEGRATE: 'INTEGRATOR',
  FACTORY_REVIEW: 'REVIEWER',
  FACTORY_DELIVER: 'INTEGRATOR',
};

function stateOf(event: BinEvent): Exclude<FactorySessionState, 'RUNNING'> {
  if (event.eventType === 'BIN_RELEASED') return 'ABANDONED';
  switch (event.outcome) {
    case 'COMPLETE':
      return 'FINISHED';
    case 'FAILED':
      return 'FAILED';
    default:
      // NEEDS_HUMAN, and anything a later state adds. The work stopped without
      // finishing and without failing, which is what ABANDONED already means.
      return 'ABANDONED';
  }
}

/**
 * Pair every assignment with the event that ended it.
 *
 * Pure over a recorded input, for `router.ts`'s reason: *why was this session
 * recorded the way it was* has to be answerable from rows somebody can read
 * back, rather than from a re-run against a database that has moved.
 *
 * Paired on the **lease id**, which both ends carry and which is unambiguous
 * across a retaken bin. The generation is carried too, because it is what makes
 * the row idempotent, and because a lease id is not a thing an operator reading
 * `bin_events` can join on by eye.
 */
export function episodesOf(events: BinEvent[]): SessionEpisode[] {
  const open = new Map<string, BinEvent>();
  const episodes: SessionEpisode[] = [];
  for (const event of events) {
    const key = event.leaseId ?? `gen:${event.leaseGeneration ?? -1}`;
    if (OPENS.has(event.eventType)) {
      open.set(key, event);
      continue;
    }
    if (!CLOSES.has(event.eventType)) continue;
    const started = open.get(key);
    if (!started) continue;
    open.delete(key);
    const generation = started.leaseGeneration;
    if (generation === null) continue;
    const startedMs = new Date(started.at).getTime();
    const endedMs = new Date(event.at).getTime();
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) continue;
    episodes.push({
      leaseId: started.leaseId,
      leaseGeneration: generation,
      workerId: started.workerId,
      reportedSession: started.sessionRef,
      attempt: started.attempt ?? 0,
      startedAt: started.at,
      endedAt: event.at,
      state: stateOf(event),
      exitReason: event.reason ?? event.outcome ?? null,
      durationMs: endedMs > startedMs ? endedMs - startedMs : 0,
    });
  }
  return episodes;
}

export interface SessionSweepReport {
  /** Episodes newly written into `factory_sessions` by this pass. */
  recorded: number;
  /** Episodes already recorded, which is the ordinary outcome after the first pass. */
  alreadyRecorded: number;
  /** Assignments Brain has no close event for, so no interval could be read. */
  unclosed: number;
  /** Episodes whose bin kind is not a factory stage, so no role could be named. */
  unmapped: number;
}

/**
 * Record every finished assignment episode of one campaign's bins.
 *
 * Safe to run on every tick and safe to run twice at once: the unique index on
 * `(bin_id, lease_generation)` is the arbiter, so two ticks reading one
 * finished bin write one row and the loser is an ordinary outcome.
 */
export async function recordObservedSessions(campaignId: string): Promise<SessionSweepReport> {
  const report: SessionSweepReport = {
    recorded: 0,
    alreadyRecorded: 0,
    unclosed: 0,
    unmapped: 0,
  };
  const bins = await campaignBins(campaignId);
  if (bins.length === 0) return report;
  const units = await listUnits(campaignId);
  for (const bin of bins) {
    const role = ROLE_OF_BIN_KIND[bin.kind];
    if (!role) {
      report.unmapped += 1;
      continue;
    }
    const events = await listBinEvents(bin.id);
    const opens = events.filter((event) => OPENS.has(event.eventType)).length;
    const episodes = episodesOf(events);
    report.unclosed += Math.max(0, opens - episodes.length);
    for (const episode of episodes) {
      const workerId = episode.workerId ?? bin.workerId;
      if (!workerId) {
        // No worker on either end. Nothing here may be invented, and a session
        // attributed to nobody is not a session anybody can reason about.
        continue;
      }
      const attribution = await dispatchAttributionForLease(bin.id, episode.leaseGeneration);
      const accountRef = await accountRefFor(attribution?.routineId ?? null);
      const written = await recordObservedSession({
        campaignId,
        unitId: soleUnitOf(bin, units),
        workerId,
        accountRef,
        attempt: episode.attempt,
        role,
        /*
         * Brain's own record of which session it fired is preferred over the
         * one the worker reported, for §24's reason: a session identity comes
         * from Brain's record of the fire, never from what a worker says about
         * itself. The reported value is the fallback rather than the answer,
         * because an arrival Brain did not fire has no dispatch row at all.
         */
        externalSessionId: attribution?.sessionRef ?? episode.reportedSession,
        // Brain does not choose the model on this plane and does not observe
        // it. `UNKNOWN` is the reading; a plausible default would be a claim.
        model: 'UNKNOWN',
        state: episode.state,
        exitReason: episode.exitReason,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        durationMs: episode.durationMs,
        binId: bin.id,
        leaseGeneration: episode.leaseGeneration,
      });
      if (written) report.recorded += 1;
      else report.alreadyRecorded += 1;
    }
  }
  return report;
}

/**
 * The account behind a Routine, as a name an operator recognises.
 *
 * `UNKNOWN` rather than a guess when Brain did not fire this generation or the
 * Routine has since been removed: an account attributed by assumption is the
 * arithmetic-on-a-fiction §23 already had to correct once.
 */
async function accountRefFor(routineId: string | null): Promise<string> {
  if (!routineId) return 'UNKNOWN';
  const routine = await getRoutine(routineId);
  if (!routine) return 'UNKNOWN';
  const account = await getAccount(routine.accountId);
  return account?.name ?? routine.accountId;
}

/**
 * The one unit this bin was about, or null when it carried several.
 *
 * A units bin routinely carries more than one unit, and a session that did two
 * of them is not a session belonging to either. Null is what `factory_sessions`
 * already means by "not about one unit", and attributing the pair to whichever
 * came first would make the per-unit reading wrong in a way nobody could see.
 */
function soleUnitOf(bin: Bin, units: { id: string; unitKey: string }[]): string | null {
  const declared = bin.manifest.units ?? [];
  if (declared.length !== 1) return null;
  const key = declared[0]?.key;
  if (!key) return null;
  return units.find((unit) => unit.unitKey === key)?.id ?? null;
}
