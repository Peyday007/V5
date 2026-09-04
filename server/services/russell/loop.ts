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
import { openProbe, runProbe } from './probe.ts';
import { GENERAL_LIGHT_PROBE_V1 } from './probeEnvelope.ts';
import { outcomeOf, writeBack } from './writeback.ts';
import { launch, repairLaunches, type LaunchInput } from './launch.ts';
import { applyTurn } from './turn.ts';
import { parseJson } from '../../repos/util.ts';
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
  /** Probes opened and run to a verdict this tick. */
  probed: string[];
  /** Turn bins whose proposal was applied and whose pending turn now reads. */
  answered: string[];
  launched: string[];
  /**
   * Candidates left queued because they asked for a stronger audit separation
   * than the fleet can currently supply, each with the exact missing
   * capability. A park, not a failure: nothing is spent, nothing else is
   * affected, and the next tick asks again — so registering the missing
   * account, worker or Routine resumes it with nobody involved.
   */
  parked: { candidateId: string; reason: string }[];
  /**
   * Missions whose packet is terminal but whose filed document is not linked
   * yet, so the writeback is deliberately left for a later tick rather than
   * spent on a sentence assembled from the row.
   */
  awaitingFiling: string[];
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
  probed: [],
  answered: [],
  launched: [],
  parked: [],
  awaitingFiling: [],
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
    probed: [],
    answered: [],
    launched: [],
    parked: [],
    awaitingFiling: [],
  };

  try {
    // 1. Finish what ended — but only where the loop can say something true.
    for (const mission of await missionsAwaitingWriteback(cycle.maxEventsPerCycle)) {
      const outcome = await outcomeOf(mission);
      if (!outcome) continue;

      /*
       * The loop must not spend the writeback on a placeholder.
       *
       * `claimWriteback` is once-only, which is what makes the effects
       * exactly-once — and it means whoever writes back *first* decides what
       * the project ends up believing. A tick that fired before the filed
       * document was linked would therefore promote a sentence assembled from
       * the mission row, permanently, and the real conclusion could never land.
       *
       * So an accepted packet with nothing filed yet is left alone and picked
       * up on a later tick. A failed one is safe to finish immediately, because
       * nothing is promoted from a run that did not finish and there is no
       * conclusion to lose.
       */
      if (outcome !== 'FAILED' && !mission.documentId) {
        report.awaitingFiling.push(mission.id);
        continue;
      }

      const result = await writeBack({
        missionId: mission.id,
        outcome,
        conclusion:
          outcome === 'FAILED'
            ? ''
            : `${mission.objective} — filed and audited through the existing pipeline.`,
        provenance: {
          orchestrationId: mission.orchestrationId,
          documentId: mission.documentId,
          auditId: mission.auditId,
        },
      });
      if (result.ok && !result.alreadyDone) report.wroteBack.push(mission.id);
    }

    // 1b. Apply the answers workers have sent back.
    //
    // Before resuming and before launching, because a turn that has landed may
    // be the very thing that produced the candidate the launch step then reads.
    for (const binId of await answeredTurnBins(cycle.maxEventsPerCycle)) {
      const applied = await applyTurn(binId);
      if (applied.ok && !applied.alreadyAnswered) report.answered.push(binId);
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

    /*
     * 3b. Take the cheap look before committing capacity.
     *
     * A candidate Russell judged `EXPLORE` is one where a bounded look is worth
     * more than a packet, so it gets one — at most one per tick, so a backlog of
     * them cannot turn a tick into a crawl. The probe spends nothing and calls
     * no model; what it buys is the right to *not* spend the allowance a full
     * mission would.
     */
    for (const candidate of await exploring(1)) {
      const opened = await openProbe({
        candidateId: candidate.id,
        question: candidate.statement,
        maxLookups: GENERAL_LIGHT_PROBE_V1.maxLookups,
      });
      if (!opened.ok || !opened.probe) continue;
      // A probe already settled is not run again; `runProbe` is re-entrant and
      // `completeProbe` is guarded, so this is belt and braces rather than the
      // guarantee.
      if (opened.probe.state === 'COMPLETE' || opened.probe.state === 'FAILED') continue;
      const ran = await runProbe({ probeId: opened.probe.id });
      if (ran.ok) report.probed.push(opened.probe.id);
    }

    // A launch that crashed between its steps is finished here rather than at
    // boot only, so a mission half-built at 3am does not wait for a restart.
    await repairLaunches();

    // 4. Start at most one thing.
    const launchable = await nextLaunchable(cycle.maxEventsPerCycle);
    let started = 0;
    for (const entry of launchable) {
      if (started >= cycle.maxLaunchesPerCycle) {
        // The bound stopped the tick, and the rest stay queued for the next
        // one. Preserved rather than dropped: a candidate that lost a race for
        // a slot has not been decided against.
        report.bounded = true;
        break;
      }
      const outcome = await launch({ ...entry.spec, candidateId: entry.candidateId });
      if (outcome.ok && !outcome.replayed) {
        report.launched.push(outcome.mission!.id);
        started += 1;
      } else if (!outcome.ok && outcome.reason.startsWith('INSUFFICIENT_')) {
        // Reported rather than counted against the launch bound: a parked
        // mission consumed no slot, and a fleet short of a capability must not
        // starve the missions that never asked for it.
        report.parked.push({ candidateId: entry.candidateId, reason: outcome.reason });
      } else if (!outcome.ok && outcome.reason.startsWith('NO_HEALTHY_EXECUTION_SURFACE')) {
        report.parked.push({ candidateId: entry.candidateId, reason: outcome.reason });
      }
    }

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

/**
 * The next candidates that could become missions, best first.
 *
 * A candidate is launchable only if it already carries a complete mission
 * specification, put there by whatever authorized path promoted it. The loop
 * does not compose one: inventing an assignment, a source list and an evidence
 * bar for work nobody specified is exactly the kind of autonomy that has no
 * accountable author, and a mission whose scope Russell wrote for itself is a
 * mission nobody approved the shape of.
 *
 * So an unspecified candidate simply is not eligible here, and stays queued
 * until a turn or an operator gives it one.
 */
async function nextLaunchable(
  limit: number,
): Promise<{ candidateId: string; spec: Omit<LaunchInput, 'candidateId'> }[]> {
  const rows = await getDb().all<{ id: string; judgment: string; project_id: string | null }>(
    `SELECT id, judgment, project_id FROM russell_candidates
      WHERE state = 'QUEUED' AND project_id IS NOT NULL
      ORDER BY
        CASE priority
          WHEN 'MUST_DO' THEN 0 WHEN 'BIG_MOVE' THEN 1 WHEN 'WORTH_DOING' THEN 2
          WHEN 'EXPLORE' THEN 3 ELSE 4 END,
        COALESCE(ordinal, 999),
        created_at, rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );

  const out: { candidateId: string; spec: Omit<LaunchInput, 'candidateId'> }[] = [];
  for (const row of rows) {
    const judgment = parseJson<Record<string, unknown>>(row.judgment, {});
    const spec = judgment['missionSpec'];
    if (!spec || typeof spec !== 'object') continue;
    out.push({ candidateId: row.id, spec: spec as Omit<LaunchInput, 'candidateId'> });
  }
  return out;
}

/**
 * Candidates worth a cheap look, that have not had one.
 *
 * The `NOT EXISTS` is what stops the loop probing the same idea every thirty
 * seconds: a candidate with any probe against it — settled, running or failed —
 * is not offered again. Re-probing is a decision somebody makes, not something
 * a timer does.
 */
async function exploring(limit: number): Promise<{ id: string; statement: string }[]> {
  return getDb().all<{ id: string; statement: string }>(
    `SELECT c.id, c.statement FROM russell_candidates c
      WHERE c.priority = 'EXPLORE'
        AND c.state = 'CAPTURED'
        AND NOT EXISTS (SELECT 1 FROM russell_probes p WHERE p.candidate_id = c.id)
      ORDER BY COALESCE(c.ordinal, 999), c.created_at, c.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
}

/**
 * Turn bins a worker has finished, whose person is still waiting.
 *
 * Joined on the pending message rather than on the bin alone, so a turn already
 * applied is not looked at again — and read from rows rather than from an event,
 * because a bin event is best-effort by design and a person waiting for an
 * answer is not something to lose to a swallowed write.
 */
async function answeredTurnBins(limit: number): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT b.id FROM bins b
       JOIN russell_messages m
         ON b.created_by_id = 'russell:turn:' || m.id
      WHERE b.completion_contract = 'RUSSELL_TURN_V1'
        AND b.state IN ('COMPLETE','FAILED','CANCELLED')
        AND m.status = 'PENDING'
      ORDER BY b.updated_at, b.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => row.id);
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
