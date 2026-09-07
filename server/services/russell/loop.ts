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
  setNextMission,
} from '../../repos/russellMissions.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { getDb } from '../../db/database.ts';
import { completeProbe, listExpiredProbes } from '../../repos/russellProbes.ts';
import { openProbe, runProbe } from './probe.ts';
import { GENERAL_LIGHT_PROBE_V1 } from './probeEnvelope.ts';
import { outcomeOf, writeBack } from './writeback.ts';
import { launch, repairLaunches, type LaunchInput } from './launch.ts';
import { applyTurn } from './turn.ts';
import { applyPlan, judgeCandidate } from './planning.ts';
import { parkStoppedMissions, resumeAnsweredRequest } from './needsHuman.ts';
import { parseJson } from '../../repos/util.ts';
import type { RussellMission, RussellVisibility } from '../../domain/types.ts';

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
  /** Plan bins whose worker observations became a judgment this tick. */
  judged: string[];
  /**
   * Ideas the project's own archive already answered, judged and parked without
   * anything being dispatched. §13's default outcome, and the cheapest one.
   */
  answeredByArchive: string[];
  /** Ideas the archive did not answer, now with a worker reading them. */
  planning: string[];
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
  /**
   * Follow-on ideas created from a mission that finished and filed.
   *
   * An idea, not a mission. It is judged against the archive on a later step
   * exactly like anything else, so a follow-on the parent's own report already
   * answered costs nothing and never launches.
   */
  followOns: { missionId: string; candidateId: string }[];
  /**
   * Parents that learned their follow-on's mission id this tick, which is what
   * `russell_missions.next_mission_id` has always meant and what, until now,
   * nothing wrote.
   */
  linkedNext: { missionId: string; nextMissionId: string }[];
  /**
   * Missions parked at a decision a person has to make, each with the packet's
   * own recorded reason. A park, not a failure: the work is intact and the
   * answer resumes the same mission.
   */
  needsHuman: { missionId: string; requestId: string; waitingOn: string }[];
  /**
   * Answers that could not be carried out, left `ANSWERED` rather than marked
   * resumed. A decision recorded as acted-on that was not is worse than a
   * visible backlog.
   */
  unresolvedAnswers: { requestId: string; reason: string }[];
  /** True when a bound stopped the tick short, with work preserved. */
  bounded: boolean;
}

const EMPTY: TickReport = {
  ran: false,
  skipped: null,
  generation: null,
  wroteBack: [],
  judged: [],
  answeredByArchive: [],
  planning: [],
  resumed: [],
  expiredProbes: [],
  probed: [],
  answered: [],
  launched: [],
  parked: [],
  awaitingFiling: [],
  followOns: [],
  linkedNext: [],
  needsHuman: [],
  unresolvedAnswers: [],
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
    judged: [],
    answeredByArchive: [],
    planning: [],
    resumed: [],
    expiredProbes: [],
    probed: [],
    answered: [],
    launched: [],
    parked: [],
    awaitingFiling: [],
    followOns: [],
    linkedNext: [],
    needsHuman: [],
    unresolvedAnswers: [],
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

    /*
     * 1a-ii. Turn a finished mission's declared follow-on into an idea.
     *
     * `russell_missions.next_mission_id` has existed since migration 027 and
     * nothing has ever written it, so condition 15 — exactly one automatic
     * follow-on — was unreachable rather than merely unproven.
     *
     * What is created here is an **idea**, not a mission, and the distinction
     * is invariant 13 rather than pedantry: the parent has just filed a report
     * into this project's archive, so the question it left open may well have
     * been answered by its own conclusion. It therefore goes through the same
     * archive check and the same planning pass as anything a person asked for,
     * and a follow-on the report already answered parks having spent nothing.
     *
     * Re-entrant, and deliberately not inside the writeback's claimed window: a
     * crash between claiming the writeback and creating the idea would
     * otherwise lose the follow-on permanently, with nothing left to notice it.
     * Here the same query asks again on every tick until it succeeds.
     */
    for (const entry of await followOnsToCreate(cycle.maxEventsPerCycle)) {
      const created = await createCandidate({
        title: entry.followOn.title,
        statement: entry.followOn.question,
        projectId: entry.projectId,
        // The parent's scope, not the project's. A follow-on to a private
        // mission is private, for the reason every other inheritance here is.
        visibility: entry.visibility,
        conversationId: entry.conversationId,
        followOnOfMissionId: entry.missionId,
      });
      report.followOns.push({ missionId: entry.missionId, candidateId: created.id });
    }

    // 1b. Apply the answers workers have sent back.
    //
    // Before resuming and before launching, because a turn that has landed may
    // be the very thing that produced the candidate the launch step then reads.
    for (const binId of await answeredTurnBins(cycle.maxEventsPerCycle)) {
      const applied = await applyTurn(binId);
      if (applied.ok && !applied.alreadyAnswered) report.answered.push(binId);
    }

    /*
     * 1c. Take the plans workers have finished.
     *
     * Before judging new candidates, so a plan that landed this tick becomes a
     * judgment this tick rather than next. `applyPlan` is guarded on the
     * candidate not already carrying a priority, so a redelivered bin judges
     * once — the queue is at-least-once and this is the effect that must not
     * repeat.
     */
    for (const binId of await finishedPlanBins(cycle.maxEventsPerCycle)) {
      const applied = await applyPlan(binId);
      if (applied.ok && !applied.alreadyJudged) report.judged.push(binId);
    }

    /*
     * 1d. Judge what has been captured and never judged.
     *
     * This is the link that did not exist: `applyJudgment` was written, tested
     * and called by nobody, so every captured idea sat at `priority = NULL`
     * with an empty judgment — exactly what `exploring()` and
     * `nextLaunchable()` select against. No probe could open and no mission
     * could launch, whatever anybody asked for.
     *
     * `judgeCandidate` asks the archive first and spends nothing when the
     * project already answers the question, which is §13's default and the
     * cheapest correct outcome. Only what the archive does not settle reaches a
     * worker. Bounded per tick for the same reason the probe step is: a backlog
     * must not turn one tick into a crawl.
     */
    for (const candidate of await unjudged(cycle.maxLaunchesPerCycle)) {
      const outcome = await judgeCandidate(candidate.id);
      if (outcome.answeredByArchive) report.answeredByArchive.push(candidate.id);
      else if (outcome.binId) report.planning.push(candidate.id);
    }

    /*
     * 1e. Decide what the cheap look was for.
     *
     * An idea judged `EXPLORE` gets a probe, the probe reaches a verdict — and
     * then, until now, nothing. `exploring()` skips a candidate that already
     * has a probe and `nextLaunchable()` reads only `QUEUED`, so an explored
     * idea was selected by neither query and stayed at `EXPLORE` permanently
     * with its answer sitting unread beside it. Every probe this Brain has ever
     * run ended in that state.
     *
     * A second planning pass is what a probe is *for*: the verdict goes to a
     * worker with the question, and the judgment it produces supersedes the
     * "look at this first". Brain forces `cheapToReduce` false on that pass, so
     * it terminates rather than sending the idea back round.
     */
    for (const settled of await probedAwaitingDecision(cycle.maxLaunchesPerCycle)) {
      const outcome = await judgeCandidate(settled.candidateId, { afterProbe: settled.probe });
      if (outcome.answeredByArchive) report.answeredByArchive.push(settled.candidateId);
      else if (outcome.binId) report.planning.push(settled.candidateId);
    }

    /*
     * 1f. Park what the packet stopped on.
     *
     * Before the resume step, so a park and its answer cannot be processed in
     * the wrong order within one tick, and before the launch step, so a project
     * whose mission is waiting on a person does not start another one in front
     * of it.
     */
    for (const parked of await parkStoppedMissions(cycle.maxEventsPerCycle)) {
      report.needsHuman.push(parked);
    }

    /*
     * 2. Carry out what a person answered.
     *
     * This used to flip the mission back to `RUNNING` and mark the request
     * resumed, which looked like an answering transition and was not one: the
     * *packet* was still stopped, so the next tick parked the mission again.
     * A person could answer the same question forever and never see it move.
     *
     * `resumeAnsweredRequest` performs the decision — the authorization, or the
     * stop — and says whether it succeeded. A request it could not carry out
     * stays `ANSWERED` rather than being marked resumed, because a decision
     * recorded as acted-on and not acted-on is the exact failure this whole
     * path exists to prevent.
     */
    for (const request of await listAnsweredRequests(cycle.maxEventsPerCycle)) {
      const outcome = await resumeAnsweredRequest(request);
      if (!outcome.settled) {
        report.unresolvedAnswers.push({ requestId: request.id, reason: outcome.reason });
        continue;
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
        /*
         * And now the parent can be told, because only now does the follow-on
         * have a mission id.
         *
         * `setNextMission` is guarded on `next_mission_id IS NULL`, so a
         * redelivery, a second candidate somebody created by hand, or a replay
         * links nothing: the first one wins and the rest are ordinary
         * no-answers. That guard is what makes "exactly one" a property of the
         * database rather than of this loop running exactly once.
         */
        if (entry.followOnOfMissionId) {
          const linked = await setNextMission({
            missionId: entry.followOnOfMissionId,
            nextMissionId: outcome.mission!.id,
          });
          if (linked) {
            report.linkedNext.push({
              missionId: entry.followOnOfMissionId,
              nextMissionId: outcome.mission!.id,
            });
          }
        }
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
async function nextLaunchable(limit: number): Promise<
  {
    candidateId: string;
    /** The mission this idea follows on from, when it is a follow-on. */
    followOnOfMissionId: string | null;
    spec: Omit<LaunchInput, 'candidateId'>;
  }[]
> {
  const rows = await getDb().all<{
    id: string;
    judgment: string;
    project_id: string | null;
    follow_on_of_mission_id: string | null;
  }>(
    `SELECT id, judgment, project_id, follow_on_of_mission_id FROM russell_candidates
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

  const out: {
    candidateId: string;
    followOnOfMissionId: string | null;
    spec: Omit<LaunchInput, 'candidateId'>;
  }[] = [];
  for (const row of rows) {
    const judgment = parseJson<Record<string, unknown>>(row.judgment, {});
    const spec = judgment['missionSpec'];
    if (!spec || typeof spec !== 'object') continue;
    out.push({
      candidateId: row.id,
      followOnOfMissionId: row.follow_on_of_mission_id,
      spec: spec as Omit<LaunchInput, 'candidateId'>,
    });
  }
  return out;
}

/**
 * Ideas whose bounded look has finished and whose judgment still says to take
 * one.
 *
 * `FAILED` counts as settled alongside `COMPLETE`: a probe that could not run
 * is an answer about the probe, not a reason to leave the idea in a state
 * nothing reads. What it found — including that it found nothing — goes to the
 * second planning pass, which is where the decision is made.
 *
 * One probe per candidate by construction (`exploring()` opens one only when
 * none exists), and the most recently settled one is taken if that ever stops
 * being true.
 */
async function probedAwaitingDecision(limit: number): Promise<
  {
    candidateId: string;
    probe: { probeId: string; outcome: string; explanation: string };
  }[]
> {
  const rows = await getDb().all<{
    candidate_id: string;
    id: string;
    outcome: string | null;
    explanation: string | null;
  }>(
    `SELECT p.candidate_id, p.id, p.outcome, p.explanation
       FROM russell_probes p
       JOIN russell_candidates c ON c.id = p.candidate_id
      WHERE p.state IN ('COMPLETE','FAILED')
        AND c.priority = 'EXPLORE'
        AND c.state = 'CAPTURED'
      ORDER BY p.completed_at, p.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    probe: {
      probeId: row.id,
      // A probe that reached no verdict is `UNKNOWN`, which is a finding. It is
      // never rendered as an absence of evidence about the question.
      outcome: row.outcome ?? 'UNKNOWN',
      explanation: row.explanation ?? 'the look recorded no explanation',
    },
  }));
}

/**
 * Missions that finished, filed, and declared a question they would leave open.
 *
 * Four conditions, and each is doing something:
 *
 *   - `writeback_at IS NOT NULL` — the mission's conclusion is in the archive.
 *     Creating the follow-on before that would send it to be judged against an
 *     archive that does not yet contain the answer it might already have.
 *   - `state = 'DONE'` — a failed mission's follow-on is not a follow-on, it is
 *     a retry, and retries are the repair engine's business.
 *   - `next_mission_id IS NULL` — the parent has not already been linked.
 *   - no candidate already carries this mission id — which is what makes the
 *     step re-entrant rather than a source of duplicates. The parent's link is
 *     not enough on its own: the follow-on idea can exist for many ticks, or
 *     forever, before it launches.
 *
 * The follow-on itself is read from the candidate's own recorded judgment,
 * which is the validated plan a worker wrote. Brain fills in nothing.
 */
async function followOnsToCreate(limit: number): Promise<
  {
    missionId: string;
    projectId: string;
    visibility: RussellVisibility;
    conversationId: string | null;
    followOn: { title: string; question: string; whyNow: string };
  }[]
> {
  const rows = await getDb().all<{
    id: string;
    project_id: string;
    visibility: string;
    conversation_id: string | null;
    judgment: string;
  }>(
    `SELECT m.id, m.project_id, m.visibility, m.conversation_id, c.judgment
       FROM russell_missions m
       JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE m.state = 'DONE'
        AND m.writeback_at IS NOT NULL
        AND m.next_mission_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM russell_candidates f WHERE f.follow_on_of_mission_id = m.id
        )
      ORDER BY m.writeback_at, m.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );

  const out: {
    missionId: string;
    projectId: string;
    visibility: RussellVisibility;
    conversationId: string | null;
    followOn: { title: string; question: string; whyNow: string };
  }[] = [];
  for (const row of rows) {
    const judgment = parseJson<Record<string, unknown>>(row.judgment, {});
    const spec = judgment['missionSpec'];
    if (!spec || typeof spec !== 'object') continue;
    const declared = (spec as Record<string, unknown>)['followOn'];
    if (!declared || typeof declared !== 'object') continue;
    const body = declared as Record<string, unknown>;
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    const question = typeof body['question'] === 'string' ? body['question'].trim() : '';
    const whyNow = typeof body['whyNow'] === 'string' ? body['whyNow'].trim() : '';
    // Re-checked on the way out as well as on the way in. The row was written
    // by a validator, and it is still a stored value that something else could
    // have edited; a follow-on with no question is not one.
    if (!title || !question || !whyNow) continue;
    out.push({
      missionId: row.id,
      projectId: row.project_id,
      visibility: row.visibility as RussellVisibility,
      conversationId: row.conversation_id,
      followOn: { title, question, whyNow },
    });
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

/**
 * Plan bins a worker has finished, whose idea is still unjudged.
 *
 * Joined on the candidate rather than on the bin alone, so a plan already
 * applied is not looked at again — the same shape as `answeredTurnBins`, and
 * read from rows rather than from an event because a bin event is best-effort
 * by design.
 */
async function finishedPlanBins(limit: number): Promise<string[]> {
  /*
   * Two shapes of plan key, and two different candidate states to match.
   *
   * A first pass is keyed `russell:plan:<candidateId>` and belongs to an idea
   * with no priority yet. A post-probe pass is keyed
   * `russell:plan:<candidateId>:probed:<probeId>` and belongs to an idea whose
   * only verdict so far is `EXPLORE` — the one priority a second pass may
   * supersede.
   *
   * Written as one query with two joins rather than a `LIKE`, so the candidate
   * id is still matched exactly. `LIKE 'russell:plan:' || c.id || '%'` would
   * also match a candidate whose id is a prefix of another one's, which is not
   * possible today and is not a property worth depending on.
   *
   * `applyPlan` re-checks both conditions when it opens the bin, because this
   * query and that call are not one statement.
   */
  const rows = await getDb().all<{ id: string }>(
    `SELECT b.id FROM bins b
       JOIN russell_candidates c
         ON b.created_by_id = 'russell:plan:' || c.id
      WHERE b.completion_contract = 'RUSSELL_PLAN_V1'
        AND b.state IN ('COMPLETE','FAILED','CANCELLED')
        AND c.priority IS NULL
        AND c.state <> 'MERGED'
     UNION
     SELECT b.id FROM bins b
       JOIN russell_probes p
         ON b.created_by_id = 'russell:plan:' || p.candidate_id || ':probed:' || p.id
       JOIN russell_candidates c ON c.id = p.candidate_id
      WHERE b.completion_contract = 'RUSSELL_PLAN_V1'
        AND b.state IN ('COMPLETE','FAILED','CANCELLED')
        AND c.priority = 'EXPLORE'
        AND c.state = 'CAPTURED'
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => row.id);
}

/**
 * Ideas captured, never judged, and not already with a worker.
 *
 * `priority IS NULL` is the core of it, because that is precisely the column
 * every downstream selector reads. A merged candidate is excluded — its
 * canonical carries the judgment — and so is one with no project, which there
 * is nothing to judge against.
 *
 * The `NOT EXISTS` is the same shape as `exploring()`'s and exists for the same
 * reason: a candidate whose plan bin is still out there must not be offered
 * again every thirty seconds. `judgeCandidate` is idempotent and would return
 * the existing bin, so this is throughput and honesty rather than safety — a
 * tick that reported the same idea as newly dispatched on every pass would be
 * describing work it did not do.
 */
async function unjudged(limit: number): Promise<{ id: string }[]> {
  return getDb().all<{ id: string }>(
    `SELECT c.id FROM russell_candidates c
      WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM bins b
           WHERE b.created_by_id = 'russell:plan:' || c.id
             AND b.state NOT IN ('CANCELLED','FAILED')
        )
      ORDER BY c.created_at, c.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
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
