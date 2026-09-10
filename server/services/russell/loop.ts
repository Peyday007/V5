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
  listAnsweredRequests,
  latestMissionForCandidate,
  markResumed,
  openRequestFor,
  renewLiveMissionReservations,
  setNextMission,
  transitionMission,
  withdrawRequest,
} from '../../repos/russellMissions.ts';
import { currentFragments, getOrchestration, updateOrchestration } from '../../repos/research.ts';
import { listCoverage, listRequirements } from '../../repos/reconciliation.ts';
import { getProject } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  createCandidate,
  getCandidate,
  recordJudgment,
} from '../../repos/russellCandidates.ts';
import { getDb } from '../../db/database.ts';
import { cancelWork, listWorkItems } from '../../repos/workQueue.ts';
import { completeProbe, listExpiredProbes } from '../../repos/russellProbes.ts';
import { openProbe, runProbe } from './probe.ts';
import { GENERAL_LIGHT_PROBE_V1 } from './probeEnvelope.ts';
import { reconcileBins, reopenParkedBin } from '../bins/service.ts';
import { getBin } from '../../repos/bins.ts';
import {
  handoffCandidates,
  routeAuditedDocument,
  type HandoffOutcome,
} from '../audit/handoff.ts';
import { TERMINAL_ORCHESTRATION } from '../research/outcome.ts';
import { reconcileTerminalPackets } from '../research/packetRunner.ts';
import { recomputeProject } from '../stateEngine.ts';
import {
  alignMissionLinks,
  missionsWithStaleLinks,
  reconcileCompletedMission,
} from './completionLinks.ts';
import { outcomeOf, writeBack } from './writeback.ts';
import { launch, repairLaunches, type LaunchInput } from './launch.ts';
import { applyTurn } from './turn.ts';
import { askArchive, judgeCandidate } from './planning.ts';
import { compileMission } from './compiler.ts';
import { specificationKey } from './launch.ts';
import { parkStoppedMissions, reopenAnswered, resumeAnsweredRequest } from './needsHuman.ts';
import { parseJson } from '../../repos/util.ts';
import type { RussellCandidate, RussellMission, RussellVisibility } from '../../domain/types.ts';

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
  /**
   * Missions retired because they ran on a specification this build no longer
   * produces, each with the idea it was recompiled for.
   *
   * Recovery, not repair: the row keeps its state and its reason, and the idea
   * is not charged an attempt for a defect in the planning that created it.
   */
  recovered: { missionId: string; candidateId: string }[];
  /**
   * Ideas the project's own archive already answered, judged and parked without
   * anything being dispatched. §13's default outcome, and the cheapest one.
   */
  answeredByArchive: string[];
  /**
   * Ideas the archive did not answer, judged and specified this tick.
   *
   * It used to mean "now with a worker reading them", because judging an idea
   * dispatched a planning bin. There is no bin: the specification is compiled
   * in the same call, so this is the list of ideas that got one.
   */
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
   * Documents routed to the layer their own audit said owns them, and the
   * packets re-opened to be judged there.
   *
   * The consumer OTHER_LAYER never had. A classification whose whole meaning is
   * "a different layer owns this" was recorded faithfully and read by nothing,
   * so a mis-filed document stayed mis-filed and its packet asked a person a
   * question the rows had already answered.
   */
  handedOff: { auditId: string; documentId: string; toLayerId: string; canonicalName: string }[];
  /**
   * Audits that named an owner Brain would not act on, with the word for why.
   *
   * Reported rather than silent, because "no handoff happened" and "a handoff
   * was refused because two layers were named" are different facts with
   * different remedies — and the second is the one a person is actually for.
   */
  handoffRefused: { auditId: string; refusal: string }[];
  /** A routed packet whose bin could not be put back to work, and why. */
  binReopenRefused: { binId: string; refusal: string }[];
  /**
   * Bins that had run out of assignments with nobody holding them, turned into
   * one decision with the reason attached.
   *
   * `reconcileBins` has always been able to do this and nothing in the running
   * server ever called it — it was reachable only from the operator script. So
   * an exhausted bin sat `READY`, undispatchable and unescalated, and the
   * packet under it waited for a worker that could never be sent. §24 again: a
   * mechanism nothing calls is not a mechanism, and this is the producer it
   * was missing.
   */
  escalatedBins: { binId: string; reason: string }[];
  /**
   * Missions that had already written back against links naming a superseded
   * audit round, repointed at what their packet actually produced.
   *
   * A correction, not a re-run: no audit, claim, document or message changes,
   * and the knowledge the mission promoted is re-anchored rather than written
   * again. Selected from rows, so it reaches a mission written back long before
   * this existed, and performing it is what stops it being selected again.
   */
  linksReconciled: { missionId: string; corrections: string }[];
  /**
   * Missions whose links are stale and could not be corrected yet, with the
   * word for why. Reported rather than silent: the case this exists for is a
   * re-opened audit round that is not finishing, and a repeated line here is
   * how somebody would find out.
   */
  linksUnreconciled: { missionId: string; refusal: string }[];
  /**
   * Terminal packets that still held claimable work, and how much was retired.
   *
   * A finished packet with a `QUEUED` or `LEASED` item is work a worker can
   * still be sent for, on a question that is already settled. Nothing advanced
   * a packet that had already finished, so nothing ever cleared it.
   */
  retiredPacketWork: { orchestrationId: string; retired: number }[];
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
  recovered: [],
  answeredByArchive: [],
  planning: [],
  resumed: [],
  expiredProbes: [],
  probed: [],
  answered: [],
  launched: [],
  parked: [],
  awaitingFiling: [],
  handedOff: [],
  handoffRefused: [],
  binReopenRefused: [],
  escalatedBins: [],
  linksReconciled: [],
  linksUnreconciled: [],
  retiredPacketWork: [],
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
    recovered: [],
    answeredByArchive: [],
    planning: [],
    resumed: [],
    expiredProbes: [],
    probed: [],
    answered: [],
    launched: [],
    parked: [],
    awaitingFiling: [],
    handedOff: [],
    handoffRefused: [],
    binReopenRefused: [],
    escalatedBins: [],
    linksReconciled: [],
    linksUnreconciled: [],
    retiredPacketWork: [],
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

    /*
     * 1a-iii. Repoint a finished mission that cites a superseded audit round.
     *
     * `linkFiledWork` keeps a mission current from now on, and that is no help
     * to one that already wrote back — `missionsAwaitingWriteback` selects on
     * `writeback_at IS NULL`, so a mission that finished against stale links
     * would never be looked at again. In production exactly one had: a packet
     * re-audited after an `OTHER_LAYER` handoff, whose mission still named the
     * first round's `MORE_RESEARCH` verdict, and whose promoted knowledge cited
     * it. §24 once more — a defect nothing re-reads is a defect nobody finds.
     *
     * Derived from rows rather than from a queue, so it reaches that mission
     * without anybody naming it, and idempotent by the state it produces:
     * corrected links no longer match the selection. It creates no work, spends
     * nothing, promotes nothing and supersedes nothing.
     */
    for (const missionId of await missionsWithStaleLinks(cycle.maxEventsPerCycle)) {
      const outcome = await reconcileCompletedMission(missionId);
      if (outcome.ok && outcome.corrections.length > 0) {
        report.linksReconciled.push({ missionId, corrections: outcome.detail });
      } else if (!outcome.ok) {
        report.linksUnreconciled.push({ missionId, refusal: outcome.refusal ?? 'refused' });
      }
    }

    /*
     * 1a-iv. Take live work off a packet that has already finished.
     *
     * `advancePacket` retires it, and only something *advancing* the packet
     * calls that — which nothing does once a packet is terminal. So a packet
     * that ended while items were outstanding kept them claimable for ever,
     * and the production one has: `COMPLETE`, filed and audited, with two
     * `RESEARCH_AUDIT` items still `LEASED` against it. An expired lease is
     * claimable work, so that is a worker Brain can still send for a question
     * it has already answered.
     *
     * Fleet-wide rather than Russell-scoped, because a stranded lease is the
     * same defect wherever the packet came from, and the tick is Brain's own
     * durable loop rather than Russell's — it already reconciles bins here for
     * the same reason.
     */
    for (const entry of await reconcileTerminalPackets(cycle.maxEventsPerCycle)) {
      report.retiredPacketWork.push(entry);
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
     * 1c. Recover an idea whose mission came from the retired planning subsystem.
     *
     * There used to be a step here that took the plans workers had finished. It
     * is gone with the bin: a specification is compiled in `judgeCandidate` now,
     * inside this tick, so there is nothing outstanding to collect.
     *
     * What is left is the rows that subsystem produced. Four missions in
     * production were launched from placeholder specifications a worker wrote,
     * and they are defects rather than attempts at the idea. This finds them by
     * asking the compiler what the idea's specification *is* and comparing —
     * no flag, no column, no list of ids — retires the mission with its own
     * reason preserved, and recompiles. §5 holds throughout: every row and
     * every reason stays, and `launch()` counts specifications rather than
     * rows, so recovering costs the idea nothing.
     */
    for (const stale of await retiredPlanning(cycle.maxLaunchesPerCycle)) {
      const retired = await retirePlanningDefect(stale);
      if (!retired) continue;
      report.recovered.push({ missionId: stale.missionId, candidateId: stale.candidateId });
      const outcome = await judgeCandidate(stale.candidateId, {
        afterRetiredPlanning: { missionId: stale.missionId, reason: stale.reason },
      });
      if (outcome.answeredByArchive) report.answeredByArchive.push(stale.candidateId);
      else if (outcome.ok) report.planning.push(stale.candidateId);
    }

    /*
     * 1c-ii. Act on a handoff the audit already decided.
     *
     * `OTHER_LAYER` means one thing — a different layer owns this — and until
     * now nothing did anything with it. The judge named the owner, `schema.ts`
     * refused the classification without one, `toGapInputs` resolved it to a
     * real layer id, and then the fact sat in `audit_gaps` while the document
     * stayed where it was and its packet asked a person where to file it.
     *
     * Routing is deterministic and it is not a judgment about the research:
     * `decideHandoff` is a pure function over gap rows and the project's own
     * layer list, and it refuses — by name, leaving the park exactly as it is —
     * on anything that is not exactly one resolvable owner.
     *
     * Selected from rows rather than from a queue, so this reaches an audit
     * recorded before this code existed as readily as one recorded a second
     * ago, and performing the routing is what stops it being selected again.
     */
    for (const auditId of await handoffCandidates(cycle.maxLaunchesPerCycle)) {
      const routed = await routeAuditedDocument({ auditId });
      if (!routed.ok) {
        if (routed.refusal) report.handoffRefused.push({ auditId, refusal: routed.refusal });
        continue;
      }
      report.handedOff.push({
        auditId,
        documentId: routed.documentId!,
        toLayerId: routed.toLayerId!,
        canonicalName: routed.canonicalName!,
      });
      const stuck = await reopenAuditRound(routed);
      if (stuck) report.binReopenRefused.push(stuck);
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
      else if (outcome.ok) report.planning.push(candidate.id);
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
      else if (outcome.ok) report.planning.push(settled.candidateId);
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
      } else if (!outcome.ok && outcome.kind === 'ALREADY_RESEARCHED') {
        /*
         * The answering transition for an idea that has nowhere left to go.
         *
         * There used to be a redo step here: a mission that produced nothing
         * sent its idea back to a worker for a different specification. With a
         * compiled specification there is no different one to write, so a redo
         * would be the same search twice — which is exactly what §15 forbids
         * and exactly what production did, three times, in four minutes.
         *
         * So the idea is parked with the run's own recorded reason instead of
         * sitting `QUEUED` while `launch()` refuses it every thirty seconds in
         * silence. `PARKED` has a person's override as its way back, and a
         * compiler change legitimately produces a new specification, which is
         * the other way out. Neither of them is a button somebody has to press
         * to keep the loop honest.
         */
        const parked = await parkResearchedIdea(entry.candidateId, outcome.reason);
        if (parked) report.parked.push({ candidateId: entry.candidateId, reason: parked });
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

    /*
     * Last: every nonterminal bin must have claimable work, live work, a
     * bounded retry, or one decision a person can actually take.
     *
     * `reconcileBins` is that rule and it had no caller outside the operator
     * script, which is how production reached a bin sitting `READY` at 5/5
     * with its packet's remaining audit roles queued and claimable: not
     * dispatchable, so no worker; not terminal, so no report; and nothing
     * anywhere looking. Conservative by construction — it only ever escalates,
     * never completes — so putting it on the tick adds a producer for an
     * existing escalation rather than a new decision.
     */
    const reconciled = await reconcileBins();
    report.escalatedBins = reconciled.details.map((detail) => ({
      binId: detail.binId,
      reason: detail.reason,
    }));

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
 * Attach the packet's filed document, its audit and its layer to the mission.
 *
 * Separate from the writeback because it is a *reading*, not a decision: it
 * copies ids Brain already holds onto the row that needs them, and returns the
 * mission as it now stands. If the packet has filed nothing yet there is
 * nothing to copy and the mission comes back unchanged, which is the ordinary
 * case on most ticks.
 *
 * **It re-reads every time, and the early return it used to have was half the
 * defect.** Skipping the work once the document and the audit were both
 * non-null is correct exactly while a packet is audited once — and §22's
 * `OTHER_LAYER` handoff is the case where it is not. A re-audited packet has a
 * new verdict and, usually, a new layer; a mission that stopped looking cited
 * the round that said the work belonged somewhere else, and the writeback filed
 * the project's conclusion under it. Non-null is not the same fact as current.
 *
 * The other half was the lookup itself, and `completionLinks.ts` holds both the
 * rule and the account of what it got wrong. It lives there rather than here
 * because the reconciliation of a mission that already wrote back has to apply
 * the identical rule, and two readers of one derivation must not become two
 * derivations.
 */
async function linkFiledWork(mission: RussellMission): Promise<RussellMission> {
  return (await alignMissionLinks(mission)).mission;
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
 * specification, and the loop still does not compose one here. It is compiled
 * at the moment the idea is judged, by `compileMission`, from the candidate,
 * the person's own message, the archive's answer and the limits of the envelope
 * the project's standing authorization names — deterministically and in code,
 * so the specification has an accountable author and cannot widen its own
 * scope. Reading it back at launch time and composing it at launch time are
 * different things, and only the first happens below.
 *
 * So an unjudged candidate simply is not eligible here, and stays queued until
 * the judgment pass compiles one.
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
    orchestration_id: string | null;
    title: string;
    is_follow_on: number;
  }>(
    /*
     * `c.follow_on_of_mission_id IS NULL` bounds the chain to one generation.
     *
     * It did not need to before: the follow-on was a field a worker declared on
     * the plan, and the second plan simply declared none. A derived follow-on
     * has no such stopping point of its own — a question the report could not
     * settle would produce an idea, whose report could not settle it either,
     * for ever — so the bound is stated here instead of being an accident of
     * what a model happened to write.
     */
    `SELECT m.id, m.project_id, m.visibility, m.conversation_id, c.judgment,
            m.orchestration_id, m.objective AS title,
            CASE WHEN c.follow_on_of_mission_id IS NULL THEN 0 ELSE 1 END AS is_follow_on
       FROM russell_missions m
       JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE m.state = 'DONE'
        AND m.writeback_at IS NOT NULL
        AND m.next_mission_id IS NULL
        AND c.follow_on_of_mission_id IS NULL
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
    const declared =
      spec && typeof spec === 'object'
        ? (spec as Record<string, unknown>)['followOn']
        : null;

    /*
     * Declared if the plan declared one; derived from the packet otherwise.
     *
     * A worker's plan could name the question finishing it would leave open,
     * because a reader of the question can see that. A compiled specification
     * cannot and does not — inventing one would be Brain buying research
     * nobody asked for — so for a compiled mission the follow-on comes from
     * what the finished packet *recorded* as unresolved, which is a fact about
     * the run rather than a prediction about it.
     */
    const followOn =
      declared && typeof declared === 'object'
        ? readDeclared(declared as Record<string, unknown>)
        : await unresolvedFollowOn(row.orchestration_id, row.title);
    if (!followOn) continue;
    const { title, question, whyNow } = followOn;
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

/** A follow-on a plan declared, re-checked on the way out as well as in. */
function readDeclared(
  body: Record<string, unknown>,
): { title: string; question: string; whyNow: string } | null {
  const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
  const question = typeof body['question'] === 'string' ? body['question'].trim() : '';
  const whyNow = typeof body['whyNow'] === 'string' ? body['whyNow'].trim() : '';
  // The row was written by a validator and is still a stored value something
  // else could have edited; a follow-on with no question is not one.
  return title && question && whyNow ? { title, question, whyNow } : null;
}

/**
 * The question a finished packet recorded that it could not settle.
 *
 * Read from the fragments the run actually blocked on, with the reason the run
 * actually recorded — never from prose about the report and never invented. A
 * packet that settled everything it asked produces nothing here, which is the
 * common case and the correct one: §13 applies to a follow-on exactly as it
 * does to a first question, and the cheapest follow-on is the one that never
 * exists.
 *
 * It is still only an *idea*. It is judged against the archive the parent has
 * just changed, compiled, and refused if the archive now answers it.
 */
async function unresolvedFollowOn(
  orchestrationId: string | null,
  parentObjective: string,
): Promise<{ title: string; question: string; whyNow: string } | null> {
  if (!orchestrationId) return null;
  const orchestration = await getOrchestration(orchestrationId);
  /*
   * The packet's own terminal status is the gate, and only one of them means
   * this.
   *
   * `COMPLETE_WITH_GAPS` is the state a packet reaches when a person authorized
   * it to file with what it could not settle named in the report. A `COMPLETE`
   * packet settled what it asked and leaves nothing open, so it produces no
   * follow-on — which is the common case and the correct one.
   *
   * Read from the status rather than from live fragment rows, and that is a
   * correction. The first version looked for a `BLOCKED` fragment, and by the
   * time a packet is terminal a blocked fragment has usually been repaired into
   * a newer attempt — so `currentFragments` shows the repair, not the failure,
   * and the follow-on never fired. The status is what the packet concluded;
   * the fragments are how it got there.
   */
  if (!orchestration || orchestration.status !== 'COMPLETE_WITH_GAPS') return null;

  /*
   * Which requirement the report did not answer, by the same rule
   * `assessPacket` uses to decide whether the packet covers its goal.
   *
   * A requirement is answered when the archive settled it — `SATISFIED` — or
   * when a fragment carrying its id reached `ACCEPTED`, which means it cleared
   * all seven gate conditions. Anything else in a packet that filed with gaps
   * is a question the report says it did not settle.
   *
   * Two different rules for "answered" in one codebase is how they come to
   * disagree, so this is the same one, and `NOT_REQUIRED` and `OWNED_ELSEWHERE`
   * are excluded here for the reason they are excluded there: they are not
   * research's job.
   */
  const requirements = await listRequirements(orchestrationId);
  const coverage = await listCoverage(orchestrationId);
  const byRequirement = new Map(coverage.map((entry) => [entry.requirementId, entry.status]));
  const answered = new Set(
    (await currentFragments(orchestrationId))
      .filter((fragment) => fragment.status === 'ACCEPTED')
      .flatMap((fragment) => fragment.requirementIds),
  );
  const open = requirements.find((requirement) => {
    if (requirement.necessity !== 'MANDATORY') return false;
    if (requirement.kind === 'OTHER_LAYER' || requirement.kind === 'IRRELEVANT') return false;
    if (answered.has(requirement.id)) return false;
    const status = byRequirement.get(requirement.id);
    return status !== 'SATISFIED' && status !== 'NOT_REQUIRED' && status !== 'OWNED_ELSEWHERE';
  });
  if (!open) return null;

  return {
    title: `Unsettled: ${open.statement.slice(0, 120)}`,
    question: open.statement,
    whyNow:
      `The report filed for "${parentObjective.slice(0, 120)}" records this as unresolved rather ` +
      'than answered, so it is still open.',
  };
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
 * Missions launched from a specification this build no longer produces.
 *
 * There is no flag for this and there is deliberately no list of ids. The
 * compiler is deterministic, so the question "was this mission specified by the
 * subsystem that is gone" is decidable by asking it what the idea's
 * specification *is* and comparing. A mission whose objective and reason match
 * the compiler's output is a legitimate attempt whatever went wrong with it;
 * one that does not could not have come from here.
 *
 * Four conditions before the compiler is asked, so the expensive half runs on
 * almost nothing:
 *
 *   - the mission is `FAILED`, `CANCELLED` or `NEEDS_HUMAN`. A live mission is
 *     not interrupted, and `DONE` is answered;
 *   - it filed no document, so nothing was learned and nothing is lost;
 *   - it is the newest for that candidate, so recovery happens once;
 *   - the candidate is still `QUEUED` and carries no person's override, because
 *     a decision somebody made is not re-taken.
 */
async function retiredPlanning(limit: number): Promise<
  { candidateId: string; missionId: string; reason: string }[]
> {
  const rows = await getDb().all<{
    candidate_id: string;
    id: string;
    objective: string;
    why_now: string;
    state: string;
    terminal_reason: string | null;
    waiting_on: string | null;
  }>(
    `SELECT m.candidate_id, m.id, m.objective, m.why_now, m.state, m.terminal_reason, m.waiting_on
       FROM russell_missions m
       JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE m.state IN ('FAILED','CANCELLED','NEEDS_HUMAN')
        AND m.document_id IS NULL
        AND c.state = 'QUEUED'
        AND c.override_user_id IS NULL
        AND m.rowid = (
              SELECT MAX(m2.rowid) FROM russell_missions m2
               WHERE m2.candidate_id = m.candidate_id)
      ORDER BY m.updated_at, m.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );

  const out: { candidateId: string; missionId: string; reason: string }[] = [];
  for (const row of rows) {
    const compiled = await compiledSpecificationFor(row.candidate_id);
    // Unknown is not "retired". A candidate the compiler refuses has no
    // specification to compare against, and guessing would retire a mission on
    // the strength of not being able to tell.
    if (!compiled) continue;
    if (specificationKey(row.objective, row.why_now) === compiled) continue;
    out.push({
      candidateId: row.candidate_id,
      missionId: row.id,
      reason:
        row.terminal_reason?.trim() ||
        row.waiting_on?.trim() ||
        'the run ended without recording a reason',
    });
  }
  return out;
}

/** What the compiler says this idea's specification is, or null if it refuses. */
async function compiledSpecificationFor(candidateId: string): Promise<string | null> {
  const candidate = await getCandidate(candidateId);
  if (!candidate?.projectId) return null;
  const project = await getProject(candidate.projectId);
  if (!project) return null;
  const compiled = await compileMission({
    candidate,
    project,
    // The archive count appears in `whyNow`, so it has to be the same number
    // the judgment pass will use. `askArchive` is the one that produces it.
    archive: await archiveCounts(candidate),
  });
  if (!compiled.ok) return null;
  return specificationKey(compiled.mission.spec.objective, compiled.mission.spec.whyNow);
}

async function archiveCounts(
  candidate: RussellCandidate,
): Promise<{ claimsConsidered: number; contradicting: string[] }> {
  const archive = await askArchive(candidate);
  return { claimsConsidered: archive.claimsConsidered, contradicting: archive.contradicting };
}

/**
 * End a mission that ran on a specification this build no longer produces.
 *
 * `FAILED`, guarded on the state it was read in, carrying the packet's or the
 * mission's own words plus one sentence saying what happened to it — so the row
 * still reads as the run it was, and the recovery is legible beside it rather
 * than instead of it. Any open Needs You request about it is withdrawn, because
 * a question about a retired mission is not a decision anybody should be asked
 * to make.
 *
 * Returns false when the mission moved underneath, which is an ordinary lost
 * race rather than an error.
 */
/**
 * Put the packet back in front of the audit, in the layer that now owns it.
 *
 * The first audit judged this document against a layer it has since left, so
 * its verdict is history rather than the packet's current answer. Nothing about
 * that verdict is rewritten and no pass is touched: `auditRoundStartedAt` reads
 * the handoff event and scopes the role lookup by time, so the three roles
 * become outstanding again and the runner enqueues a fresh `PRIMARY` on its own.
 *
 * What this does is the small amount of state that cannot be derived: the
 * packet says it is auditing again, the mission stops saying it is waiting for
 * a person, and the request that asked where to file the document is withdrawn
 * — because the routing answered it. Leaving it open would be asking somebody
 * to decide something Brain has already decided from their own rows.
 *
 * `completedAt` and `failureReason` are cleared for the same reason the status
 * moves: a packet that is auditing has not completed and has not failed, and
 * leaving either set would make the next reader believe a stale thing.
 */
async function reopenAuditRound(
  routed: HandoffOutcome,
): Promise<{ binId: string; refusal: string } | null> {
  if (!routed.documentId || !routed.toLayerId) return null;
  const mission = await missionForDocument(routed.documentId);

  if (mission?.orchestrationId) {
    const packet = await getOrchestration(mission.orchestrationId);
    if (packet && !TERMINAL_ORCHESTRATION.has(packet.status)) {
      /*
       * The previous round's audit items are withdrawn, not left to drain.
       *
       * They ask for an audit of a document against a layer it has left. A
       * worker still holding one would be briefed from current rows and so
       * would produce a *correct* pass — but for a role this round is already
       * enqueueing, which is two passes for one role and one wasted activation.
       * Cancelling is not destroying: the row keeps its id, its attempts and
       * its history, and gains the reason it stopped.
       */
      for (const item of await listWorkItems(packet.projectId, { limit: 500 })) {
        if (item.orchestrationId !== packet.id) continue;
        if (item.workType !== 'RESEARCH_AUDIT') continue;
        if (item.state !== 'QUEUED' && item.state !== 'LEASED') continue;
        await cancelWork(
          item.id,
          'The audited document was handed to the layer that owns it, so this asked for an ' +
            'audit against a layer it has left. The audit is running again in the new layer.',
        );
      }
      await updateOrchestration(packet.id, {
        status: 'AUDITING',
        currentPass: 'AUDIT',
        completedAt: null,
        failureReason: null,
      });
    }
  }

  if (mission) {
    /*
     * The mission's layer is not repointed here any more.
     *
     * It was, and only here — so a mission stayed aligned with its document
     * exactly when the Russell loop happened to be the caller. `documents`,
     * `research_orchestrations` and `russell_missions` all carry the same
     * ownership fact, and a routing that moved two of the three left the third
     * to be corrected by whoever noticed. `routeAuditedDocument` now moves all
     * three, so ownership is aligned by the handoff itself rather than by its
     * consumers, and the mission read above already carries the new layer.
     */
    if (mission.state === 'NEEDS_HUMAN') {
      await transitionMission({
        missionId: mission.id,
        from: 'NEEDS_HUMAN',
        to: 'RUNNING',
        waitingOn: null,
      });
    }
    const open = await openRequestFor(mission.id);
    if (open) {
      await withdrawRequest({
        requestId: open.id,
        reason:
          'Withdrawn: the audit named the layer that owns this work, so Brain filed it there ' +
          `as ${routed.canonicalName}. It is being judged again under that layer, and there is ` +
          'nothing here for you to decide.',
      });
    }
  }

  /*
   * And the bin, which is the thing that actually gets a worker sent.
   *
   * This was the third park in one chain and the only one nothing answered.
   * The bin escalated to `NEEDS_HUMAN` because `RESEARCH_PACKET_V1` refused a
   * packet sitting at `NEEDS_HUMAN` — correct at the time. Routing the document
   * resolved exactly that condition, and the packet and the mission were both
   * put back to work above; the bin was left parked, and a parked bin is not
   * dispatchable, so the reopened round's first audit item sat queued and
   * claimable with nobody ever sent for it.
   *
   * §24's sentence a third time: a state that says "waiting for a person" which
   * that person cannot resolve is not waiting, it is stuck. Here it was worse
   * than stuck — the person had already been told, truthfully, that there was
   * nothing left for them to decide.
   *
   * Brain answers it, because Brain is what resolved the condition. Through the
   * same guarded transition an operator uses and with nothing weakened: one
   * source state, a compare-and-swap on the generation, the fence, the budget
   * check, and a `BIN_REOPENED` row naming who answered it and on what
   * evidence. A bin that is not parked, or whose contract still answers
   * `HUMAN`, is left exactly where it is.
   */
  if (mission?.binId) {
    const bin = await getBin(mission.binId);
    if (bin?.state === 'NEEDS_HUMAN') {
      const reopened = await reopenParkedBin({
        binId: bin.id,
        operator: 'russell:other-layer-handoff',
        reason:
          `The audit named the layer that owns this work, so Brain filed the document there as ` +
          `${routed.canonicalName ?? 'its own layer name'} and the audit is running again under ` +
          'that layer. The condition this bin escalated on — a packet waiting for a person — is ' +
          'resolved, and nothing about its attempts or its history is reset.',
      });
      if (!reopened.ok) {
        if (mission.projectId) await recomputeProject(mission.projectId);
        return { binId: bin.id, refusal: reopened.refusal ?? 'REFUSED' };
      }
    }
  }

  if (mission?.projectId) await recomputeProject(mission.projectId);
  return null;
}

/** The Russell mission that filed this document, if one did. */
async function missionForDocument(documentId: string): Promise<RussellMission | null> {
  const row = await getDb().get<{ id: string }>(
    `SELECT m.id AS id
       FROM russell_missions m
       JOIN research_orchestrations o ON o.id = m.orchestration_id
      WHERE o.document_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT 1`,
    [documentId],
  );
  return row ? await getMission(row.id) : null;
}

async function retirePlanningDefect(input: {
  candidateId: string;
  missionId: string;
  reason: string;
}): Promise<boolean> {
  const mission = await getMission(input.missionId);
  if (!mission) return false;
  const already = mission.state === 'FAILED' || mission.state === 'CANCELLED';

  if (!already) {
    const moved = await transitionMission({
      missionId: mission.id,
      from: mission.state,
      to: 'FAILED',
      terminalReason:
        `${input.reason} — and the specification it ran on was written by the worker-planning ` +
        'subsystem this Brain has retired, so it is superseded by a compiled one rather than ' +
        'counted as an attempt at the idea.',
    });
    if (!moved) return false;
  }

  const open = await openRequestFor(mission.id);
  if (open) {
    await withdrawRequest({
      requestId: open.id,
      reason:
        'Withdrawn: this asked about a mission whose specification was written by the retired ' +
        'worker-planning subsystem. The idea has been specified again by Brain, so there is ' +
        'nothing here for you to decide.',
    });
  }

  await recordEvent({
    projectId: mission.projectId,
    entityType: 'RUSSELL_MISSION',
    entityId: mission.id,
    eventType: 'RUSSELL_MISSION_FAILED',
    payload: {
      orchestrationId: mission.orchestrationId,
      reason: input.reason,
      retiredPlanning: true,
      surface: 'RUSSELL',
    },
  });
  // A mission that was already terminal is still a recovery: what mattered was
  // reaching the idea, and it has been reached.
  return true;
}

/**
 * Ideas captured, never judged, and not already with a worker.
 *
 * `priority IS NULL` is the core of it, because that is precisely the column
 * every downstream selector reads. A merged candidate is excluded — its
 * canonical carries the judgment — and so is one with no project, which there
 * is nothing to judge against.
 *
 * There used to be a `NOT EXISTS` here excluding a candidate whose planning bin
 * was still out with a worker, because judging meant dispatching one and an
 * at-least-once loop must not dispatch twice. Judging is synchronous now, so
 * there is nothing outstanding to wait for — and the clause had become a trap:
 * a candidate carrying a *completed* plan bin from the retired subsystem would
 * have been excluded from being judged for ever, which is the opposite of what
 * it was written to do.
 */
async function unjudged(limit: number): Promise<{ id: string }[]> {
  return getDb().all<{ id: string }>(
    `SELECT c.id FROM russell_candidates c
      WHERE c.priority IS NULL AND c.state <> 'MERGED' AND c.project_id IS NOT NULL
      ORDER BY c.created_at, c.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
}

/**
 * Park an idea whose only specification has been researched and produced nothing.
 *
 * The reason is the run's own words when it recorded any, and Brain's sentence
 * about the state otherwise — never an invented account of why the research
 * failed. Guarded on `QUEUED`, so a person who moved it in the meantime wins.
 */
async function parkResearchedIdea(candidateId: string, refusal: string): Promise<string | null> {
  const candidate = await getCandidate(candidateId);
  if (!candidate || candidate.state !== 'QUEUED') return null;
  const previous = await latestMissionForCandidate(candidateId);
  const why = previous?.terminalReason?.trim() || previous?.waitingOn?.trim() || refusal;
  const reason = `Researched once and it produced no report: ${why}`;
  const recorded = await recordJudgment({
    candidateId,
    state: 'PARKED',
    priority: 'PARKED',
    reason,
    judgment: {
      ...candidate.judgment,
      researchedWithoutReport: { missionId: previous?.id ?? null, reason: why },
    },
    supporting: candidate.supporting,
    contradicting: candidate.contradicting,
  });
  return recorded ? reason : null;
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
