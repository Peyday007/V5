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
 * Two things stop it, and neither of them is a model being sensible:
 *
 *   - only a `USER` turn is ever a capture source, so a `RUSSELL` turn cannot
 *     seed a candidate at all. `askedMessageFor` resolves the question a turn
 *     answers by walking back to the nearest `USER` turn, and a turn with no
 *     reachable one refuses with `NO_SOURCE_MESSAGE` rather than capturing.
 *     This is the bound that actually breaks the cycle, at its head;
 *   - one launch and one follow-on per cycle, from the row, which paces it.
 *
 * There was a third — the goal's own cumulative mission ceiling — and it is
 * gone with the lifetime quotas. Saying so rather than leaving the list at
 * three: it was never the bound doing this work, because a ceiling large
 * enough to be useful is a ceiling a runaway chain reaches anyway, and one
 * small enough to stop a runaway chain stops ordinary work first. What bounds
 * *concurrent* execution is `maxConcurrent`, which is real provider capacity
 * and is untouched.
 *
 * Hitting a bound preserves the remaining candidates for the next cycle. It
 * never drops them, and it never consumes a whole tick in one pass.
 */
import {
  claimCycle,
  completeCycle,
  cycleNow,
  getCycle,
} from '../../repos/russellCycle.ts';
import {
  getMission,
  linkMission,
  listAnsweredRequests,
  markResumed,
  renewLiveMissionReservations,
  setNextMission,
} from '../../repos/russellMissions.ts';
import { getOrchestration } from '../../repos/research.ts';
import { listAuditsByProject } from '../../repos/audits.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { getDb } from '../../db/database.ts';
import { completeProbe, listExpiredProbes } from '../../repos/russellProbes.ts';
import { openProbe, runProbe } from './probe.ts';
import { GENERAL_LIGHT_PROBE_V1 } from './probeEnvelope.ts';
import { outcomeOf, writeBack } from './writeback.ts';
import { launch, repairLaunches, type LaunchInput } from './launch.ts';
import { applyTurn } from './turn.ts';
import { applyPlan, judgeCandidate } from './planning.ts';
import { MAX_MISSION_ATTEMPTS } from './launch.ts';
import { parkStoppedMissions, reopenAnswered, resumeAnsweredRequest } from './needsHuman.ts';
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
  /**
   * Budget holds pushed out because their mission is still alive. A silence
   * here beside a running mission means its hold is about to lapse and refund
   * the owner's allowance by the passage of time.
   */
  renewedReservations: string[];
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
  renewedReservations: [],
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
  renewedReservations: [],
  };

  try {
    // 1. Finish what ended — but only where the loop can say something true.
    for (const raw of await missionsAwaitingWriteback(cycle.maxEventsPerCycle)) {
      const outcome = await outcomeOf(raw);
      if (!outcome) continue;

      /*
       * Tell the mission what its own packet produced.
       *
       * This is the connection that was missing, and it made two conditions
       * unreachable rather than merely untested. `linkMission` was called with
       * an orchestration and a bin at launch and **never with a document or an
       * audit** — nothing anywhere set `russell_missions.document_id`. The
       * guard immediately below skips any non-failed mission without one, so a
       * packet that filed a real report would have been pushed onto
       * `awaitingFiling` on every tick, for ever. And `followOnsToCreate`
       * requires `writeback_at IS NOT NULL`, so the automatic follow-on sat
       * behind the same wall.
       *
       * Read from the orchestration and from the audit rows — Brain's own
       * records of what the pipeline did — never from anything a worker said
       * about itself. `linkMission` is a plain update on columns that are null
       * until the pipeline fills them, so a redelivery writes the same ids.
       */
      const mission = await linkFiledWork(raw);

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
     * 1d-ii. Re-plan an idea whose run produced nothing.
     *
     * The gap this closes: a mission's key was the candidate and the grant, so
     * an idea got exactly one mission for ever. When that one ended without a
     * report the idea stayed `QUEUED` and the loop re-found the same dead row
     * on every tick — for ever, with nothing to show a person and no way back.
     *
     * A redo is not a retry. §15: a retry repeats the same search; a repair is
     * planned from what failed. So the failed run's own recorded reason goes to
     * a worker with the question, and the judgment it produces supersedes the
     * specification that led nowhere — which matters most in the case this was
     * written for, where that specification is the placeholder §54.2 recorded
     * and `PLAN_MINIMUMS` would now refuse outright.
     *
     * `launch()` derives the attempt from the rows and stops at
     * `MAX_MISSION_ATTEMPTS`, so nothing here needs to count.
     */
    for (const spent of await redoable(cycle.maxLaunchesPerCycle)) {
      const outcome = await judgeCandidate(spent.candidateId, {
        afterFailedMission: {
          missionId: spent.missionId,
          attempt: spent.attempt,
          reason: spent.reason,
        },
      });
      if (outcome.answeredByArchive) report.answeredByArchive.push(spent.candidateId);
      else if (outcome.binId) report.planning.push(spent.candidateId);
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
     * 1e-ii. Keep a live mission's reservation from expiring underneath it.
     *
     * Before the park and the launch, because both read the budget: a mission
     * whose hold lapsed during this very tick would look to `reserve` like
     * spend that never happened, and the launch step would hand out a slot the
     * owner had already committed.
     */
    for (const id of await renewLiveMissionReservations(cycle.maxEventsPerCycle)) {
      report.renewedReservations.push(id);
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
     * stop — and says whether it succeeded. A request it could not carry out is
     * **put back in front of the person**, because a decision recorded as
     * acted-on and not acted-on is the exact failure this whole path exists to
     * prevent.
     *
     * It used to be left `ANSWERED`, and the comment here said that kept it
     * visible. It did not: `listOpenRequests` selects `state = 'OPEN'`, so the
     * card left Needs You the instant the person clicked and nothing ever
     * happened — the same disappearance, one state along. `reopenAnswered`
     * undoes the answer and narrows the choices to the ones that can still act,
     * so what comes back is a card whose remaining options are true.
     */
    for (const request of await listAnsweredRequests(cycle.maxEventsPerCycle)) {
      const outcome = await resumeAnsweredRequest(request);
      if (!outcome.settled) {
        report.unresolvedAnswers.push({ requestId: request.id, reason: outcome.reason });
        await reopenAnswered(request, outcome.reason);
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
      } else if (!outcome.ok && outcome.refusedBy === 'IN_TOTAL') {
        /*
         * A wall, not a queue, and the difference decides whether a person
         * hears about it.
         *
         * This branch did not exist. A cumulative refusal's reason matches
         * neither prefix below, so it fell through every case and was dropped
         * from the report — a queued idea sat behind a spent ceiling in total
         * silence, on every tick, with the briefing saying nobody was needed.
         *
         * `AT_ONCE` deliberately still falls through: something is running and
         * this starts when it finishes. Reporting that as a blocker would
         * teach a person to ignore the one that is.
         */
        report.parked.push({ candidateId: entry.candidateId, reason: outcome.reason });
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
/**
 * Attach the packet's filed document and its audit to the mission.
 *
 * Separate from the writeback because it is a *reading*, not a decision: it
 * copies two ids Brain already holds onto the row that needs them, and returns
 * the mission as it now stands. If the packet has filed nothing yet there is
 * nothing to copy and the mission comes back unchanged, which is the ordinary
 * case on most ticks.
 *
 * The audit is the packet's own — matched on the run the orchestration names,
 * which is the same join `packet-report` uses. A project's other audits belong
 * to other work and must not be attributed here.
 */
async function linkFiledWork(mission: RussellMission): Promise<RussellMission> {
  if (!mission.orchestrationId) return mission;
  if (mission.documentId && mission.auditId) return mission;

  const orchestration = await getOrchestration(mission.orchestrationId);
  if (!orchestration) return mission;

  const documentId = mission.documentId ?? orchestration.documentId ?? null;
  let auditId = mission.auditId ?? null;
  if (!auditId) {
    const audits = (await listAuditsByProject(mission.projectId)).filter(
      (audit) => audit.runId === orchestration.runId,
    );
    // The latest, because an audit that superseded an earlier one is the one
    // the packet's verdict rests on.
    auditId = audits.length > 0 ? audits[audits.length - 1]!.id : null;
  }
  if (!documentId && !auditId) return mission;

  await linkMission({
    missionId: mission.id,
    ...(documentId ? { documentId } : {}),
    ...(auditId ? { auditId } : {}),
  });
  return (await getMission(mission.id)) ?? mission;
}

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
   * Three shapes of plan key, and three different candidate states to match.
   *
   * A first pass is keyed `russell:plan:<candidateId>` and belongs to an idea
   * with no priority yet. A post-probe pass is keyed
   * `russell:plan:<candidateId>:probed:<probeId>` and belongs to an idea whose
   * only verdict so far is `EXPLORE` — the one priority a second pass may
   * supersede. A redo is keyed `russell:plan:<candidateId>:redo:<missionId>`
   * and belongs to an idea still `QUEUED` whose newest mission is that one.
   *
   * **The redo arm did not exist, and that is the whole of why production
   * stalled.** 09a591a added the redo key, the manifest that carries the
   * failed run's reason, and the `applyPlan` branch that supersedes the dead
   * specification — and then left the only query that hands a finished plan to
   * `applyPlan` matching two shapes out of three. So `bin_fdc116329a2843289dcd`
   * reached `COMPLETE` at 03:36Z on 2026-09-09 carrying a worker's real
   * re-plan, nothing ever opened it, `nextLaunchable` kept reading the
   * specification that had already failed three times, and `launch()` refused
   * it every thirty seconds exactly as 6afeaaa had just taught it to. Three
   * correct mechanisms in a row, and the chain was still dead, because the one
   * between them selected nothing. §24's sentence at a fourth altitude: a
   * mechanism nothing calls is not a mechanism.
   *
   * The redo arm's guard is `m.rowid = MAX(rowid) for that candidate` — the
   * same condition `redoable()` uses to decide there is a redo to plan at all.
   * It is what makes the arm stop matching: the moment the re-planned attempt
   * launches, the mission this bin was planned from is no longer the newest,
   * and the bin is never looked at again. A flag would have said the same
   * thing and could disagree with the rows; this cannot.
   *
   * Written as one query with three joins rather than a `LIKE`, so the
   * candidate id is still matched exactly. `LIKE 'russell:plan:' || c.id ||
   * '%'` would also match a candidate whose id is a prefix of another one's,
   * which is not possible today and is not a property worth depending on.
   *
   * `applyPlan` re-checks each arm's condition when it opens the bin, because
   * this query and that call are not one statement.
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
     UNION
     SELECT b.id FROM bins b
       JOIN russell_missions m
         ON b.created_by_id = 'russell:plan:' || m.candidate_id || ':redo:' || m.id
       JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE b.completion_contract = 'RUSSELL_PLAN_V1'
        AND b.state IN ('COMPLETE','FAILED','CANCELLED')
        AND c.state = 'QUEUED'
        AND m.rowid = (
              SELECT MAX(m2.rowid) FROM russell_missions m2
               WHERE m2.candidate_id = m.candidate_id)
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

/**
 * Ideas whose latest mission ended without producing a report.
 *
 * Four conditions, and each one is doing work:
 *
 *   - the mission is `FAILED` or `CANCELLED`. `DONE` is answered and
 *     `NEEDS_HUMAN` is a person's decision that has not been made yet;
 *   - it filed no document, so nothing was learned and re-asking is not §13's
 *     waste;
 *   - it is the newest attempt for that candidate, so a redo is planned from
 *     the run that actually just ended;
 *   - it is below the ceiling, checked here as well as in `launch()` so a
 *     spent idea does not spend a planning bin discovering it.
 *
 * And no live plan bin for this same mission, which is what makes the step
 * idempotent: the tick runs every thirty seconds and a re-plan takes minutes.
 */
async function redoable(limit: number): Promise<
  { candidateId: string; missionId: string; attempt: number; reason: string }[]
> {
  const rows = await getDb().all<{
    candidate_id: string;
    id: string;
    attempt: number;
    terminal_reason: string | null;
  }>(
    `SELECT m.candidate_id, m.id, m.attempt, m.terminal_reason
       FROM russell_missions m
       JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE m.state IN ('FAILED','CANCELLED')
        AND m.document_id IS NULL
        AND c.state = 'QUEUED'
        -- The ceiling counts specifications, not rows, for the reason
        -- launch() records: production spent all three attempts on one
        -- placeholder in four minutes because the launcher raced the re-plan.
        -- Counting rows here would leave the idea permanently unredoable
        -- after exactly that accident, which is the state this query has to
        -- be able to get out of.
        -- The derived table is aliased because Postgres requires it; SQLite
        -- does not care, and one statement has to be right on both.
        AND (SELECT COUNT(*) FROM (
               SELECT DISTINCT m3.objective, m3.why_now FROM russell_missions m3
                WHERE m3.candidate_id = m.candidate_id) AS approaches) < ?
        AND m.rowid = (
              SELECT MAX(m2.rowid) FROM russell_missions m2
               WHERE m2.candidate_id = m.candidate_id)
        AND NOT EXISTS (
              SELECT 1 FROM bins b
               WHERE b.created_by_id = 'russell:plan:' || m.candidate_id || ':redo:' || m.id
                 AND b.state NOT IN ('CANCELLED','FAILED'))
      ORDER BY m.updated_at, m.rowid
      LIMIT ?`,
    [MAX_MISSION_ATTEMPTS, Math.max(1, limit)],
  );
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    missionId: row.id,
    attempt: row.attempt,
    reason: row.terminal_reason ?? 'the run ended without recording a reason',
  }));
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
