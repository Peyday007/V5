/**
 * Russell's loop — the thing that keeps working when nobody is watching.
 *
 * The requirement is blunt: **Russell continues while the laptop is closed.**
 * That rules out anything whose correctness depends on this process staying
 * alive, so the cycle's position, its ownership, its pause state and its bounds
 * are all rows, and a restart resumes from them.
 *
 * One tick does four things, in this order and for these reasons:
 *
 *   1. **Finish what ended.** A mission whose packet reached a terminal state
 *      is written back before anything new is considered, so a decision about
 *      what to do next is taken against what the project now knows rather than
 *      what it knew before the result landed.
 *   2. **Resume what a person answered.** An answered Needs You request is the
 *      authority arriving; acting on it is what makes the request a queue
 *      rather than a graveyard.
 *   3. **Recover what a deadline passed.** A probe still running past its
 *      deadline is ended honestly at `UNKNOWN`, so nothing waits forever on a
 *      process that died.
 *   4. **Start at most one thing.** Bounded by `max_launches_per_cycle`, which
 *      is a row an operator can lower without a deployment.
 *
 * ---------------------------------------------------------------------------
 * Why the bounds are the important part
 * ---------------------------------------------------------------------------
 *
 * Russell's own output must not become Russell's own input in an unbounded
 * chain. A completion writes a briefing, the briefing is a turn, a turn could
 * capture a candidate, a candidate could launch a mission, and that mission's
 * completion writes another briefing. Nothing in that loop is wrong on its own
 * and together it is a machine for spending an allowance on itself.
 *
 * Three things stop it, and none of them is a model being sensible:
 *
 *   - only a `USER` turn is ever a capture source, so a `RUSSELL` turn cannot
 *     seed a candidate at all;
 *   - one launch and one follow-on per cycle, from the row;
 *   - and the goal's own mission ceiling, counted in the database.
 *
 * Hitting a bound preserves the remaining candidates for the next cycle. It
 * never drops them, and it never consumes the whole budget in one pass.
 */
import {
  claimCycle,
  completeCycle,
  cycleNow,
  getCycle,
} from '../../repos/russellCycle.ts';
import {
  getMission,
  listAnsweredRequests,
  markResumed,
  transitionMission,
} from '../../repos/russellMissions.ts';
import { getDb } from '../../db/database.ts';
import { completeProbe, listExpiredProbes } from '../../repos/russellProbes.ts';
import { outcomeOf, writeBack } from './writeback.ts';
import { repairLaunches } from './launch.ts';
import type { RussellMission } from '../../domain/types.ts';

/** How often the loop wakes when nothing else has woken it. */
export const RUSSELL_TICK_MS = 30_000;

export interface TickReport {
  ran: boolean;
  /** Why it did not run, when it did not. An ordinary outcome, not an error. */
  skipped: string | null;
  generation: number | null;
  wroteBack: string[];
  resumed: string[];
  expiredProbes: string[];
  launched: string[];
  /** True when a bound stopped the tick short, with work preserved. */
  bounded: boolean;
}

const EMPTY: TickReport = {
  ran: false,
  skipped: null,
  generation: null,
  wroteBack: [],
  resumed: [],
  expiredProbes: [],
  launched: [],
  bounded: false,
};

/**
 * One pass.
 *
 * Safe to call from a timer, from a completion, from a message, or from boot,
 * and safe to have two instances call at once — the claim decides. It never
 * throws for an ordinary refusal: a paused cycle and a lost race are results.
 */
export async function tick(owner: string): Promise<TickReport> {
  const claim = await claimCycle({ owner });
  if (!claim.ok || claim.generation === null) {
    return { ...EMPTY, skipped: claim.reason };
  }

  const cycle = claim.cycle!;
  const report: TickReport = {
    ...EMPTY,
    ran: true,
    generation: claim.generation,
    wroteBack: [],
    resumed: [],
    expiredProbes: [],
    launched: [],
  };

  try {
    // 1. Finish what ended.
    for (const mission of await missionsAwaitingWriteback(cycle.maxEventsPerCycle)) {
      const outcome = await outcomeOf(mission);
      if (!outcome) continue;
      const result = await writeBack({
        missionId: mission.id,
        outcome,
        // The conclusion and its provenance come from the filed packet, which
        // the caller that has read it supplies. The loop's own writeback is the
        // safety net for a completion nobody observed, so it says only what it
        // can prove from rows: that the packet reached this outcome.
        conclusion: `${mission.objective} — the packet reached its terminal state.`,
        provenance: {
          orchestrationId: mission.orchestrationId,
          documentId: mission.documentId,
          auditId: mission.auditId,
        },
      });
      if (result.ok && !result.alreadyDone) report.wroteBack.push(mission.id);
    }

    // 2. Resume what a person answered.
    for (const request of await listAnsweredRequests(cycle.maxEventsPerCycle)) {
      if (!request.missionId) {
        await markResumed(request.id);
        continue;
      }
      const mission = await getMission(request.missionId);
      if (!mission) {
        await markResumed(request.id);
        continue;
      }
      // Guarded on the mission still being where it was parked, so an answer
      // arriving twice resumes it once and a mission somebody else already
      // moved is left alone.
      if (mission.state === 'NEEDS_HUMAN') {
        await transitionMission({
          missionId: mission.id,
          from: 'NEEDS_HUMAN',
          to: 'RUNNING',
        });
      }
      if (await markResumed(request.id)) report.resumed.push(request.id);
    }

    // 3. Recover what a deadline passed.
    for (const probe of await listExpiredProbes(cycleNow())) {
      const ended = await completeProbe({
        probeId: probe.id,
        outcome: 'UNKNOWN',
        explanation: 'the probe reached its deadline before it could settle the question',
      });
      if (ended) report.expiredProbes.push(probe.id);
    }

    // A launch that crashed between its steps is finished here rather than at
    // boot only, so a mission half-built at 3am does not wait for a restart.
    await repairLaunches();

    // 4. Starting new work is Phase 2's remaining piece: the ranked queue is
    //    read and one eligible mission is launched. The bound is enforced here
    //    so that it is enforced whatever eventually does the launching.
    if (cycle.maxLaunchesPerCycle === 0) report.bounded = true;

    await completeCycle({ owner, generation: claim.generation, cursorAt: cycleNow() });
    return report;
  } catch (error) {
    await completeCycle({
      owner,
      generation: claim.generation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Missions whose packet may have finished while nobody was looking.
 *
 * Read from rows rather than from an event stream, because §12A is explicit
 * that the observer cannot rely solely on best-effort delivery: a bin event may
 * be swallowed, and a completion nobody heard about must still be noticed. This
 * is that re-derivation, and it is bounded per tick so one pass cannot walk the
 * whole table.
 */
async function missionsAwaitingWriteback(limit: number): Promise<RussellMission[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_missions
      WHERE writeback_at IS NULL
        AND state IN ('RUNNING','LAUNCHING','WAITING')
        AND orchestration_id IS NOT NULL
      ORDER BY updated_at, rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  const missions: RussellMission[] = [];
  for (const row of rows) {
    const mission = await getMission(row.id);
    if (mission) missions.push(mission);
  }
  return missions;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start ticking.
 *
 * The timer is a convenience, not the mechanism: every tick claims, every claim
 * is fenced, and the cursor is durable — so losing the timer loses throughput
 * and nothing else. Boot calls this after recovery, beside the dispatcher.
 */
export function startRussell(owner: string, intervalMs = RUSSELL_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick(owner).catch(() => {
      // Swallowed here and recorded on the row by `tick` itself. A throwing
      // timer callback would take the process down, and an unattended Brain
      // that dies on one bad tick is worse than one that skips it.
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopRussell(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Read where the loop is, for a diagnostic or a projection. */
export async function russellState() {
  return getCycle();
}
