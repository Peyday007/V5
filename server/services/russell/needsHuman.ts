/**
 * The escalation Russell could not make, and the answer that finishes it.
 *
 * Two halves of one defect, found by walking the connected path rather than by
 * reading it. `askHuman` has existed since Phase 1 with no production caller,
 * and nothing anywhere moved a `russell_missions` row into `NEEDS_HUMAN` — the
 * only code touching that state was the loop's resume, reading a state nothing
 * wrote. So condition 17 was unreachable in the direction that matters: the
 * resume worked and there was never anything to resume.
 *
 * Meanwhile the packet underneath *does* reach `NEEDS_HUMAN`, deliberately and
 * often — invariant 20's whole point is that a Brain must not be able to
 * declare its way to "complete" when evidence runs out. A packet stopped there
 * is a decision waiting for a person, and until now the person was never told,
 * the mission still read `RUNNING`, and the conversation said nothing. That is
 * §24's sentence exactly: a state that says "waiting for a person" which that
 * person cannot resolve is not waiting, it is stuck.
 *
 * **Brain derives the park; it does not receive it.** The trigger is the
 * packet's own recorded status and reason, written by the runner. No worker
 * reports "I need a human", no prose is parsed, and there is no tool for
 * asking. A model that could open a Needs You request could interrupt anything
 * by saying so.
 *
 * **Every choice offered here is a choice something implements.** The list is
 * closed, it is Brain's, and each entry is wired to a real transition below —
 * because an escalation whose answer does nothing is the same defect one level
 * up, and it is the one that produced this module.
 */
import { currentFragments, getOrchestration } from '../../repos/research.ts';
import {
  askHuman,
  getMission,
  listOpenRequests,
  openRequestFor,
  reofferRequest,
  reopenRequest,
  transitionMission,
  withdrawRequest,
} from '../../repos/russellMissions.ts';
import { getUser } from '../../repos/identity.ts';
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { authorizeUnresolvedGaps } from '../research/gapPolicy.ts';
import { advancePacket, approvePlan } from '../research/packetRunner.ts';
import type {
  HumanRequestChoice,
  ResearchFragment,
  RussellHumanRequest,
  RussellMission,
} from '../../domain/types.ts';

/**
 * What a person can decide about a stopped packet.
 *
 * Two answers, and they are the only two that are honest. The packet has run
 * out of evidence it is authorized to look for; either the project accepts what
 * could not be settled and files the rest, or the work stops. What is *not*
 * offered is "try again", because the repair ladder has already been walked and
 * offering it would be inviting the same search a third time (§15).
 *
 * `RECORD_GAPS` is a real authorization with a real record: it is
 * `authorizeUnresolvedGaps`, whose doc comment has said since Step 9 that Step
 * 12 would call it "from wherever the Brain's own controls end up". This is
 * where they ended up.
 */
export const NEEDS_HUMAN_CHOICES = {
  /*
   * Authorize a plan Brain was not preauthorized to start.
   *
   * The third answer, and it is here because the first two could not answer
   * the stop production actually reached. `orc_8adc4708f56f49a8964b` parked on
   * 2026-09-09 because `planFitsEnvelope` refused its plan — the assignment did
   * not match the digest the envelope pins, and the fragment's geography and
   * source class were outside it. Nothing about the evidence bar had happened;
   * research had not started. The card offered "record what could not be
   * settled" and "stop this work", so the one decision a person could actually
   * make about a plan — read it and authorize it — was the one not on offer,
   * and every future idea would have parked the same way.
   *
   * It is `approvePlan`, the identical function the envelope calls when a plan
   * *does* fit and the identical one the console's own review screen calls. So
   * this widens nothing: it moves the fragments from PLANNED to QUEUED under a
   * named person, and the evidence gate, the verification pass, the synthesis
   * check and all three audit roles run exactly as they would have. §16's
   * sentence is that the envelope decides whether research may *start* — this
   * is the other way a start gets authorized, and it is the way §16 already
   * describes as `HUMAN`.
   *
   * Offered only when something is actually awaiting approval, for the reason
   * every other choice here is conditional.
   */
  APPROVE_PLAN: {
    key: 'APPROVE_PLAN',
    label: 'Authorize this plan and let it run',
    consequence:
      'The proposed research starts, recorded as authorized by you rather than by a ' +
      'preauthorized envelope. Nothing else changes: the same evidence standards, the same ' +
      'verification and the same three audit roles decide what it may conclude.',
  },
  RECORD_GAPS: {
    key: 'RECORD_GAPS',
    label: 'Record what could not be settled, and finish',
    consequence:
      'The packet files its report with the unresolved questions named in it, rather than ' +
      'claiming they were answered. Nothing further is searched.',
  },
  STOP: {
    key: 'STOP',
    label: 'Stop this work',
    consequence:
      'The mission ends without filing. What was already accepted stays in the project; ' +
      'nothing is promoted from it.',
  },
} as const satisfies Record<string, HumanRequestChoice>;

export type NeedsHumanChoice = keyof typeof NEEDS_HUMAN_CHOICES;

/**
 * The answers a packet in this shape can actually take.
 *
 * One function, called by the park that writes the card and by the reopen that
 * corrects it, so the two can never disagree about what is offerable. A packet
 * with no fragments has no report to file and no unresolved questions to name,
 * so `RECORD_GAPS` would be a button that does nothing — the failure this
 * module exists to fix, wearing the module's own clothes.
 */
/** Fragment statuses that mean the research itself has actually happened. */
const RESEARCHED_STATUSES = new Set([
  'RUNNING',
  'VALIDATING',
  'ACCEPTED',
  'BLOCKED',
  'REJECTED',
  'NEEDS_HUMAN',
]);

export interface PacketShape {
  /** Fragments proposed and not yet approved — what `approvePlan` acts on. */
  awaitingApproval: number;
  /**
   * Fragments that cleared all seven evidence conditions — what a report is
   * *made of*, as distinct from what the run touched.
   *
   * `RECORD_GAPS` files the report with its unresolved questions named beside
   * what was established, and a packet where nothing cleared has no "beside".
   * `advancePacket` says so itself: with no accepted fragment it stops at
   * `NEEDS_HUMAN` with *no fragment cleared its evidence gate*, whatever the
   * gap authorization says — so offering the choice would produce a decision
   * recorded in a person's name that parks the packet again on the next tick,
   * for ever. That is the failure this module exists to fix, wearing the
   * module's own clothes for the second time, one status further along than
   * the first.
   */
  accepted: number;
  /**
   * Fragments the research has actually reached — what a filed report is of.
   *
   * `QUEUED` is deliberately neither. An approved fragment nobody has started
   * is not a plan waiting for a decision and it is not research either, so
   * offering to "record what could not be settled" for it would file a report
   * about work that has not begun. That is the same harm as offering it for a
   * `PLANNED` fragment, one status along, and the compiled path made it
   * reachable: a plan the envelope approves moves straight to `QUEUED`.
   */
  researched: number;
}

/**
 * What a packet is, in the only two numbers the answers depend on.
 *
 * Read from the fragments rather than from the packet's prose, because which
 * answers can act is a fact about rows. It replaced a boolean `hasEvidence`,
 * and the distinction it added is the one that mattered: a packet whose only
 * fragment is still `PLANNED` has *something*, so the boolean said yes — and
 * `RECORD_GAPS` then offered to file a report of research that had not
 * happened. In production that fragment was a worker's placeholder, so acting
 * on the offer would have written invented work into the project's archive
 * under a person's name.
 */
export async function packetShape(orchestrationId: string): Promise<PacketShape> {
  return shapeOf(await currentFragments(orchestrationId));
}

function shapeOf(fragments: readonly ResearchFragment[]): PacketShape {
  return {
    awaitingApproval: fragments.filter((fragment) => fragment.status === 'PLANNED').length,
    accepted: fragments.filter((fragment) => fragment.status === 'ACCEPTED').length,
    researched: fragments.filter((fragment) => RESEARCHED_STATUSES.has(fragment.status)).length,
  };
}

export function choicesFor(shape: PacketShape): HumanRequestChoice[] {
  return [
    ...(shape.awaitingApproval > 0 ? [NEEDS_HUMAN_CHOICES.APPROVE_PLAN] : []),
    // Research happened *and* something survived it. Both, because the two
    // numbers answer different questions and only the second one decides
    // whether filing is possible.
    ...(shape.researched > 0 && shape.accepted > 0 ? [NEEDS_HUMAN_CHOICES.RECORD_GAPS] : []),
    NEEDS_HUMAN_CHOICES.STOP,
  ];
}

/**
 * Why this packet stopped, and why Brain may not decide it, from its own rows.
 *
 * Two stops with two different remedies, and until this they shared one
 * sentence: *the evidence bar was not met and the repair ladder is spent*. That
 * is true of the stop this module was written for and false of the one
 * production reached first, where nothing had been researched at all. A park
 * whose explanation contradicts its own reason teaches a person to stop reading
 * the explanation — the same defect mutation 18 fixed for `waitingOn` and left
 * standing one field along.
 */
function stopWords(
  shape: PacketShape,
  awaiting: readonly ResearchFragment[],
  packetReason: string,
): { authorityNeeded: string; whyNotRussell: string } {
  if (shape.awaitingApproval > 0) {
    /*
     * The plan, in the person's card, bounded.
     *
     * A person authorizing research has to see what they are authorizing, and
     * the fragment questions are what the plan actually asks. Bounded because a
     * decomposition is as many fragments as the gaps require (§12) and a card
     * carrying twenty questions is one nobody reads — so the first few are
     * named and the rest are counted rather than silently dropped.
     */
    const NAMED = 4;
    const rest = awaiting.length - NAMED;
    const asks =
      awaiting
        .slice(0, NAMED)
        .map((fragment) => `“${fragment.question}”`)
        .join('; ') + (rest > 0 ? `, and ${rest} more` : '');
    return {
      authorityNeeded:
        'Authorizing research Brain was not preauthorized to start. Brain may not decide this ' +
        'for you, because deciding it would mean setting the limits its own plan is judged by.',
      whyNotRussell:
        `The plan asks to establish ${asks}. ${packetReason} ` +
        'Nothing has been researched yet, so this is a decision about whether to start rather ' +
        'than about what to do with what was found.',
    };
  }
  if (shape.accepted === 0) {
    /*
     * Researched, and none of it survived the gate.
     *
     * A different stop from the one below and it must read differently, for
     * the reason this function exists: the sentence under it says the choice
     * is whether to accept a report with unresolved questions in it, and here
     * there is no report to accept. Everything the run established was
     * refused, so the honest description is that and the honest answer is to
     * stop it or to ask a narrower question.
     */
    return {
      authorityNeeded:
        'Deciding what to do about research that established nothing it could stand behind. ' +
        'Brain may not decide this for you, because narrowing the question or abandoning it ' +
        'is a decision about what the project is trying to find out.',
      whyNotRussell:
        'Every fragment was refused at its evidence gate and the repair ladder is spent, so ' +
        'there is no report to file with the unresolved questions named in it — there is ' +
        'nothing beside them. Each refusal keeps its recorded reason.',
    };
  }
  return {
    authorityNeeded:
      'Deciding whether this project accepts a report with unresolved questions in it, ' +
      'rather than an answer. Brain may not make that call for you.',
    whyNotRussell:
      'The evidence bar was not met and the repair ladder is spent. Lowering the bar or ' +
      'declaring the remaining questions out of scope is a decision about what the ' +
      'project is willing to rely on.',
  };
}

/** States a mission can be parked *from*. A terminal one is not interrupted. */
const PARKABLE = new Set(['PLANNED', 'LAUNCHING', 'RUNNING', 'WAITING']);

export interface ParkResult {
  missionId: string;
  requestId: string;
  /** The packet's own recorded reason, not a sentence written here. */
  waitingOn: string;
}

/**
 * Park every mission whose packet has stopped for a person.
 *
 * Re-entrant by construction. `transitionMission` is guarded on the state it
 * read, and `askHuman` inserts `ON CONFLICT (resume_key) DO NOTHING` against a
 * key derived from the mission — so a second tick, a redelivery or two
 * dispatchers running at once produce one park and one request.
 */
export async function parkStoppedMissions(limit: number): Promise<ParkResult[]> {
  const rows = await getDb().all<{ id: string }>(
    /*
     * `NEEDS_HUMAN` is in the selection, and it is not a mistake.
     *
     * The rule below — a packet with no evidence has nothing to decide, so it
     * fails rather than parking — only fires at the moment of parking, and
     * production already had a mission sitting parked from before it existed:
     * `rms_8e96b5f246464c069451`, holding the only queued idea in the project
     * behind a request offering one answer. A fix that cannot reach the row
     * that motivated it is half a fix.
     *
     * Including the state is safe because the branch below is the only thing
     * that acts on it: a parked mission whose packet *does* hold evidence is a
     * real decision, `transitionMission` is guarded on the state it read, and
     * re-parking one would be a no-op anyway.
     */
    `SELECT id FROM russell_missions
      WHERE state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN')
        AND orchestration_id IS NOT NULL
      ORDER BY updated_at, rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );

  const parked: ParkResult[] = [];
  for (const row of rows) {
    const mission = await getMission(row.id);
    if (!mission || !mission.orchestrationId) continue;
    const orchestration = await getOrchestration(mission.orchestrationId);
    if (!orchestration || orchestration.status !== 'NEEDS_HUMAN') continue;

    /*
     * The packet's own words, and a fallback that is still about the packet.
     *
     * `failureReason` is written by the runner from its own state — which
     * fragments failed, what it was left holding — so it is a fact rather than
     * a summary. A missing one is possible and must not become an invented
     * explanation, so the fallback says only what is certainly true.
     */
    const waitingOn =
      orchestration.failureReason?.trim() ||
      'The packet stopped at a decision only a person can make.';

    /*
     * Which stop this is, read from the packet rather than assumed.
     *
     * The sentences below used to be constants: "The evidence bar was not met
     * and the repair ladder is spent." That is true of the stop this module
     * was written for and false of the one that actually happened first. On
     * 2026-09-07 `orc_e1afa97f566d4b468373` parked with **zero fragments and
     * zero claims** — its planning item finished without recording anything —
     * and a person opening Needs You would have read `waitingOn` saying the
     * plan never happened, directly above an explanation saying the evidence
     * bar was not met, above an offer to record gaps that do not exist.
     *
     * That is this module's own defect one level up. A park whose explanation
     * contradicts its reason teaches a person to stop reading the explanation,
     * and a choice that cannot act on this packet is a choice nothing
     * implements — for this packet, which is the only one the person is
     * looking at.
     *
     * Derived from rows, never from the packet's prose: `failureReason` is
     * still reported verbatim as `waitingOn`, and what is decided here is only
     * *which* answers can do anything.
     */
    const fragments = await currentFragments(orchestration.id);
    // Sorted by key, because the card's words are compared before they are
    // rewritten and `currentFragments` orders by `fragment_index` alone — two
    // fragments sharing an index would otherwise read back in either order and
    // the offer would look changed on every tick.
    const awaiting = fragments
      .filter((fragment) => fragment.status === 'PLANNED')
      .sort((a, b) => a.fragmentKey.localeCompare(b.fragmentKey));
    const shape = shapeOf(fragments);
    /*
     * More than one thing a person could decide — asked of the offer itself,
     * not of a proxy for it.
     *
     * This was `fragments.length > 0`, which is a *row* count standing in for
     * "there is something to decide". Production produced the case that
     * separates them: `orc_bf57174a711e42c0a18b` held one fragment, zero
     * claims and nothing accepted — the compiler had specified county-records
     * sources for a question about private marketplace economics, and the
     * worker reported the domain mismatch rather than inventing an answer.
     * One row existed, so the proxy said park; `choicesFor` then offered
     * exactly one answer, and the card's own explanation said *"the honest
     * answers here are to stop it or to ask a narrower question"* while
     * offering only the first of those.
     *
     * So the condition is the offer. The rule below is unchanged and now
     * applies wherever it is true rather than wherever the proxy happened to
     * agree with it.
     */
    const decidable = choicesFor(shape).length > 1;

    /*
     * A decision with one option is not a decision.
     *
     * A packet with nothing a person could choose between has nothing to file
     * and no questions to declare out of scope, so `choicesFor` correctly
     * offers a single answer: STOP. Parking on that asks a person to press the
     * only button there is, and then waits — indefinitely, blocking the idea —
     * until they do. That is not an escalation, it is a failed run wearing an
     * escalation's clothes, and the person it interrupts learns nothing by
     * being interrupted.
     *
     * **The earlier reasoning here is recorded rather than quietly replaced.**
     * It said Brain "will not quietly abandon work you authorized, and it will
     * not re-run something that failed before it started" — and while a
     * mission was a candidate's only ever mission, that was right: failing it
     * silently would have retired the idea for good. Migration 033 makes a
     * redo a real, bounded, recorded transition, so the choice is no longer
     * between a person's button and oblivion. Failing is now the honest
     * outcome: the run produced nothing, it says so in the packet's own words,
     * the row keeps its reason, and `redoable()` may offer the idea a second
     * try that a person never had to ask for.
     *
     * Nothing is abandoned quietly. The mission is FAILED with the packet's
     * recorded reason, and the attempt ceiling in `loop.ts` is what stops a
     * question nobody can answer from being asked for ever.
     */
    if (!decidable) {
      const failed = await transitionMission({
        missionId: mission.id,
        from: mission.state,
        to: 'FAILED',
        terminalReason: waitingOn,
      });
      if (failed) {
        /*
         * Take back the question, if one was already asked.
         *
         * A request opened before this rule existed is still sitting in
         * somebody's Needs You offering a single button. Withdrawing it is
         * honest — it was never a decision — and it is guarded on `OPEN`, so
         * an answer somebody actually gave is never reached back through.
         */
        for (const open of await listOpenRequests(mission.projectId)) {
          if (open.missionId !== mission.id) continue;
          await withdrawRequest({
            requestId: open.id,
            reason:
              'Withdrawn: this packet produced no research, so the only answer it could ' +
              'offer was to stop — which is what Brain does with a run that produced ' +
              'nothing. The idea goes back for another attempt instead.',
          });
        }
      }
      if (failed) {
        await recordEvent({
          projectId: mission.projectId,
          entityType: 'RUSSELL_MISSION',
          entityId: mission.id,
          eventType: 'RUSSELL_MISSION_FAILED',
          payload: {
            orchestrationId: orchestration.id,
            reason: waitingOn,
            producedNothing: true,
            surface: 'RUSSELL',
          },
        });
      }
      continue;
    }

    /*
     * Already parked, and it has something: a real decision, waiting for a real
     * answer. Not re-parked — `transitionMission` from NEEDS_HUMAN to
     * NEEDS_HUMAN succeeds, so that would report a fresh park on every tick.
     *
     * But the offer is re-derived, because a request is written once and the
     * packet keeps moving. `rhr_acbf51e190924d99b5a3` was opened offering
     * "record what could not be settled" and "stop this work" for a packet
     * whose plan had been refused before any research began; the answer that
     * fits it — authorize the plan — did not exist when the row was written,
     * and this branch is the only thing that ever looks at a parked mission
     * again. Without this the repair could not reach the row that motivated it,
     * which is mutation 26's lesson at the same altitude.
     *
     * `reofferRequest` is guarded on OPEN and changes only what is offered and
     * why: never the state, never an answer, never who gave one. And it is
     * compared before it is written, so an unchanged card is not touched and a
     * tick that reports nothing did nothing.
     */
    if (mission.state === 'NEEDS_HUMAN') {
      const open = await openRequestFor(mission.id);
      if (open) {
        const wanted = choicesFor(shape);
        const words = stopWords(shape, awaiting, waitingOn);
        const same =
          open.choices.length === wanted.length &&
          open.choices.every((choice, at) => choice.key === wanted[at]?.key) &&
          open.authorityNeeded === words.authorityNeeded &&
          open.whyNotRussell === words.whyNotRussell;
        if (!same) {
          await reofferRequest({ requestId: open.id, choices: wanted, ...words });
        }
      }
      continue;
    }

    const moved = await transitionMission({
      missionId: mission.id,
      from: mission.state,
      to: 'NEEDS_HUMAN',
      waitingOn,
    });
    if (!moved) continue;

    const { request, created } = await askHuman({
      projectId: mission.projectId,
      // The mission's scope. A private mission's decision is not posted to
      // everyone who can read the project.
      visibility: mission.visibility,
      missionId: mission.id,
      candidateId: mission.candidateId,
      conversationId: mission.conversationId,
      // Only the evidence case reaches here now, so these are statements
      // rather than a branch. A packet that produced nothing failed above.
      // Derived from the packet, both of them. See `stopWords`: an envelope
      // refusal and an exhausted repair ladder are different stops with
      // different remedies, and one sentence cannot be true of both.
      ...stopWords(shape, awaiting, waitingOn),
      recommendation: null,
      /*
       * Only the answers that can act on this packet.
       *
       * `RECORD_GAPS` files the report with its unresolved questions named. A
       * packet with no fragments has no report and no questions, so offering
       * it would be offering a button that does nothing — the failure this
       * module exists to fix, wearing the module's own clothes.
       */
      choices: choicesFor(shape),
        // The packet is stopped and everything behind it is waiting, which is
      // what BLOCKING means here. Not URGENT: nothing is degrading, and an
      // urgency that is always the highest one stops sorting anything.
      urgency: 'BLOCKING',
      // Derived from the mission and the packet, so the same stop asked twice
      // is one request. Never from a clock, an attempt or a lease.
      resumeKey: `russell:needs-human:${mission.id}:${orchestration.id}`,
    });

    if (created || request.state === 'OPEN') {
      parked.push({ missionId: mission.id, requestId: request.id, waitingOn });
    }
  }
  return parked;
}

export interface ResumeResult {
  ok: boolean;
  /** What the answer actually did, in words the loop reports and a person reads. */
  reason: string;
  missionId: string | null;
  /** True when the request is finished with and may be marked resumed. */
  settled: boolean;
}

/**
 * Carry out what a person decided.
 *
 * This is the answering transition condition 17 is about, and the whole reason
 * it is here rather than inline in the loop: an answer that flipped the mission
 * back to `RUNNING` and left the packet stopped would recreate the park on the
 * very next tick, forever. The person would click, watch it come back, and have
 * no way to tell that their decision had been recorded and ignored.
 *
 * **The same mission resumes.** Nothing here creates a mission, a candidate or
 * an orchestration; a replacement would fail condition 17 outright and would
 * also throw away the packet's accepted work.
 */
export async function resumeAnsweredRequest(
  request: RussellHumanRequest,
): Promise<ResumeResult> {
  if (!request.missionId) {
    return { ok: true, reason: 'the request was not about a mission', missionId: null, settled: true };
  }
  const mission = await getMission(request.missionId);
  if (!mission) {
    return { ok: true, reason: 'the mission is gone', missionId: request.missionId, settled: true };
  }

  const choice = request.answeredChoice;
  if (choice === NEEDS_HUMAN_CHOICES.STOP.key) {
    return {
      ok: await stop(mission),
      reason: 'stopped, as asked',
      missionId: mission.id,
      settled: true,
    };
  }

  if (choice === NEEDS_HUMAN_CHOICES.RECORD_GAPS.key) {
    return recordGaps(mission, request);
  }

  if (choice === NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key) {
    return authorizePlan(mission, request);
  }

  /*
   * An answer this version does not implement.
   *
   * It cannot arrive from `answerHumanRequest`, which matches the offered keys
   * exactly — it can only be a request written by an older version of this
   * file. Left OPEN rather than marked resumed: pretending to have acted on a
   * decision nothing carried out is the failure this module exists to fix, and
   * a request that stays visible is one somebody can ask about.
   */
  return {
    ok: false,
    reason: `this Brain does not implement the answer "${choice ?? 'none'}"`,
    missionId: mission.id,
    settled: false,
  };
}

/**
 * Put an answer that could not be carried out back in front of the person.
 *
 * Which choices come back is decided here, from the packet, by the same
 * function the park uses — so a card that reappears offers only answers this
 * packet can actually take. Deriving it rather than storing it once is the
 * property the offer itself lacked: the row was written when the packet had a
 * different shape, and the shape is what decides.
 *
 * Never invents a reason. `reason` is what `resumeAnsweredRequest` returned,
 * which is Brain's own sentence about its own refusal.
 */
export async function reopenAnswered(
  request: RussellHumanRequest,
  reason: string,
): Promise<boolean> {
  const mission = request.missionId ? await getMission(request.missionId) : null;
  const orchestrationId = mission?.orchestrationId ?? null;
  const shape = orchestrationId
    ? await packetShape(orchestrationId)
    : { awaitingApproval: 0, accepted: 0, researched: 0 };
  /*
   * The words move with the choices, from the same shape and the same
   * functions the park uses.
   *
   * This re-derived only the offer, and a card that offers one thing while
   * explaining another is the defect `stopWords` was written for — arriving
   * here by a different door. A reopen is precisely the moment the packet has
   * moved underneath words that were composed for an earlier shape: a request
   * opened when the bar was nearly met can come back with only STOP on it and
   * still say the bar was nearly met.
   */
  const fragments = orchestrationId ? await currentFragments(orchestrationId) : [];
  const awaiting = fragments
    .filter((fragment) => fragment.status === 'PLANNED')
    .sort((a, b) => a.fragmentKey.localeCompare(b.fragmentKey));
  const words = stopWords(shape, awaiting, reason);
  return reopenRequest({
    requestId: request.id,
    choices: choicesFor(shape),
    recommendation: reason,
    authorityNeeded: words.authorityNeeded,
    whyNotRussell: words.whyNotRussell,
  });
}

async function stop(mission: RussellMission): Promise<boolean> {
  return transitionMission({
    missionId: mission.id,
    from: mission.state,
    to: 'CANCELLED',
    terminalReason: 'stopped by a person at a decision Brain could not make',
  });
}

/**
 * Carry out "authorize this plan".
 *
 * The same order `recordGaps` uses, for the same reason: the mission comes back
 * to `RUNNING` under a guard *before* the packet is advanced, because
 * `approvePlan` can carry a packet all the way to terminal in this call and a
 * mission still reading `NEEDS_HUMAN` when the writeback step looks at it would
 * be written back from a parked state.
 *
 * Three refusals, and each leaves the request OPEN rather than marking it
 * resumed — an answer recorded as acted-on and not acted-on is the exact
 * failure this module exists to prevent.
 */
async function authorizePlan(
  mission: RussellMission,
  request: RussellHumanRequest,
): Promise<ResumeResult> {
  if (!mission.orchestrationId) {
    return {
      ok: false,
      reason: 'this mission has no packet to authorize',
      missionId: mission.id,
      settled: false,
    };
  }

  /*
   * There has to be a plan. The offer is derived from the same numbers, but a
   * request written when the packet had a different shape still carries its old
   * choices, and the offer is what a person sees — so the guard is at the
   * transition as well.
   */
  const shape = await packetShape(mission.orchestrationId);
  if (shape.awaitingApproval === 0) {
    return {
      ok: false,
      reason:
        'nothing in this packet is waiting to be approved any more, so there is no plan to ' +
        'authorize — the honest answers here are to stop it or to record what is unresolved',
      missionId: mission.id,
      settled: false,
    };
  }

  /*
   * Against the person who gave it, by id, read from `answered_by_user_id`,
   * which `answerHumanRequest` took from the authenticated principal — never
   * from a body field and never from here. `approvePlan` writes it onto
   * `RESEARCH_PLAN_REVIEWED`, so the row says who authorized research to start
   * rather than that "a script" did.
   */
  const answeredBy = request.answeredByUserId ? await getUser(request.answeredByUserId) : null;
  if (!answeredBy) {
    return {
      ok: false,
      reason: 'the person who answered cannot be resolved, so nothing is authorized in their name',
      missionId: mission.id,
      settled: false,
    };
  }

  const moved = await transitionMission({
    missionId: mission.id,
    from: 'NEEDS_HUMAN',
    to: 'RUNNING',
    waitingOn: null,
  });
  if (!moved) {
    return {
      ok: false,
      reason: 'the mission moved out of Needs You before the answer could be applied',
      missionId: mission.id,
      settled: false,
    };
  }

  const advanced = await approvePlan({
    orchestrationId: mission.orchestrationId,
    approvedByUserId: answeredBy.id,
  });
  return {
    ok: true,
    reason: `the plan is authorized by you; the packet is now ${advanced.status}`,
    missionId: mission.id,
    settled: true,
  };
}

async function recordGaps(
  mission: RussellMission,
  request: RussellHumanRequest,
): Promise<ResumeResult> {
  if (!mission.orchestrationId) {
    return {
      ok: false,
      reason: 'this mission has no packet to authorize',
      missionId: mission.id,
      settled: false,
    };
  }
  /*
   * There has to be something to record.
   *
   * The choice set above no longer offers `RECORD_GAPS` to a packet with no
   * fragments — but a request opened before that was true still carries both
   * choices on its row, and the offer is what a person sees. So the guard is
   * here too, at the transition rather than only at the offer: authorizing
   * unresolved gaps on a packet that holds no research would record a person's
   * name against a decision about nothing, and then advance a packet with
   * nothing to advance.
   *
   * Left OPEN rather than settled, and the reason is said plainly, so the
   * decision stays visible instead of being marked answered and dropped.
   */
  const fragments = await currentFragments(mission.orchestrationId);
  if (fragments.length === 0) {
    return {
      ok: false,
      reason:
        'this packet holds no fragments, so there are no unresolved questions to record — ' +
        'the honest answers here are to stop it or to ask again',
      missionId: mission.id,
      settled: false,
    };
  }
  /*
   * And something has to have survived its gate.
   *
   * The same guard one status along, and the same reasoning. `advancePacket`
   * refuses to synthesize a packet with no accepted fragment and parks it again
   * at `NEEDS_HUMAN` — so authorizing unresolved gaps here would record a
   * person's decision, move the mission back to `RUNNING`, and have the next
   * tick park it on the identical reason. A decision that is recorded and then
   * has no effect is worse than one that was never offered, which is why the
   * offer no longer includes it and why the transition refuses it too: a
   * request opened before this was true still carries both choices on its row,
   * and the row is what a person sees.
   */
  if (!fragments.some((fragment) => fragment.status === 'ACCEPTED')) {
    return {
      ok: false,
      reason:
        'nothing in this packet cleared its evidence gate, so there is no report to file with ' +
        'the unresolved questions named in it — the honest answers here are to stop it or to ' +
        'ask a narrower question',
      missionId: mission.id,
      settled: false,
    };
  }

  /*
   * The authorization is recorded against the person who gave it, by id and
   * address, because "a script authorized it" answers nothing a year later.
   * Read from `answered_by_user_id`, which `answerHumanRequest` took from the
   * authenticated principal — never from a body field and never from here.
   */
  const answeredBy = request.answeredByUserId ? await getUser(request.answeredByUserId) : null;
  if (!answeredBy) {
    return {
      ok: false,
      reason: 'the person who answered cannot be resolved, so nothing is authorized in their name',
      missionId: mission.id,
      settled: false,
    };
  }

  await authorizeUnresolvedGaps({
    orchestrationId: mission.orchestrationId,
    authorizedBy: { id: answeredBy.id, email: answeredBy.email },
  });

  /*
   * Back to running *before* the packet is advanced, and guarded on the state
   * the park left it in.
   *
   * The order matters: `advancePacket` can carry the packet all the way to
   * terminal in this call, and a mission still reading `NEEDS_HUMAN` when the
   * writeback step looks at it would be written back from a parked state. The
   * writeback's own guard would refuse it, and the mission would sit finished
   * underneath and parked on top.
   */
  const moved = await transitionMission({
    missionId: mission.id,
    from: 'NEEDS_HUMAN',
    to: 'RUNNING',
    waitingOn: null,
  });
  if (!moved) {
    return {
      ok: false,
      reason: 'the mission moved out of Needs You before the answer could be applied',
      missionId: mission.id,
      settled: false,
    };
  }

  const advanced = await advancePacket(mission.orchestrationId);
  return {
    ok: true,
    reason: `authorized to record what is unresolved; the packet is now ${advanced.status}`,
    missionId: mission.id,
    settled: true,
  };
}
