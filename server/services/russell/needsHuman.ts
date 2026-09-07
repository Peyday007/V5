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
import { askHuman, getMission, transitionMission } from '../../repos/russellMissions.ts';
import { getUser } from '../../repos/identity.ts';
import { getDb } from '../../db/database.ts';
import { authorizeUnresolvedGaps } from '../research/gapPolicy.ts';
import { advancePacket } from '../research/packetRunner.ts';
import type {
  HumanRequestChoice,
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
    `SELECT id FROM russell_missions
      WHERE state IN ('PLANNED','LAUNCHING','RUNNING','WAITING')
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
    const hasEvidence = (await currentFragments(orchestration.id)).length > 0;

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
      authorityNeeded: hasEvidence
        ? 'Deciding whether this project accepts a report with unresolved questions in it, ' +
          'rather than an answer. Brain may not make that call for you.'
        : 'Deciding what happens to a mission that never produced any research. Brain will ' +
          'not quietly abandon work you authorized, and it will not re-run something that ' +
          'failed before it started.',
      whyNotRussell: hasEvidence
        ? 'The evidence bar was not met and the repair ladder is spent. Lowering the bar or ' +
          'declaring the remaining questions out of scope is a decision about what the ' +
          'project is willing to rely on.'
        : 'This packet holds no fragments and no claims, so there is nothing to file and ' +
          'nothing to lower a bar for. Whether the question is still worth asking is yours.',
      recommendation: null,
      /*
       * Only the answers that can act on this packet.
       *
       * `RECORD_GAPS` files the report with its unresolved questions named. A
       * packet with no fragments has no report and no questions, so offering
       * it would be offering a button that does nothing — the failure this
       * module exists to fix, wearing the module's own clothes.
       */
      choices: hasEvidence
        ? Object.values(NEEDS_HUMAN_CHOICES)
        : [NEEDS_HUMAN_CHOICES.STOP],
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

async function stop(mission: RussellMission): Promise<boolean> {
  return transitionMission({
    missionId: mission.id,
    from: mission.state,
    to: 'CANCELLED',
    terminalReason: 'stopped by a person at a decision Brain could not make',
  });
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
  if ((await currentFragments(mission.orchestrationId)).length === 0) {
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
