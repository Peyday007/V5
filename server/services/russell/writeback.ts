/**
 * What happens when a mission actually finishes.
 *
 * A filed document is not a finished mission. §12A's rule is that an accepted
 * terminal outcome changes what Russell knows, what the project says, what the
 * conversation shows, what is ranked where, and what Russell does next — and
 * that all of it happens **exactly once**, under replay, a duplicated provider
 * callback, two observers and a restart in the middle.
 *
 * The whole of that guarantee is one line: `claimWriteback` is a compare-and-swap
 * on `writeback_at IS NULL`. Whoever wins does the six effects below; everyone
 * else is told it is already done and does nothing. It is a swap rather than a
 * read-then-write for the reason this codebase has now needed five times — a
 * read leaves a window, and the window is where the duplicate lives.
 *
 * Two things this deliberately does **not** do.
 *
 * It does not decide whether the mission succeeded. That is the packet's own
 * terminal state, produced by the existing plan/research/verify/synthesize/audit
 * pipeline, and a truthful terminal-with-gaps outcome is written back as exactly
 * that rather than relabelled complete.
 *
 * It does not launch the next mission itself. It *reports* whether one is
 * eligible, and the loop decides — because launching from inside the writeback
 * would make one completion able to start a chain, and the per-cycle bound that
 * stops Russell feeding itself lives in the loop.
 */
import { recordEvent } from '../../repos/events.ts';
import {
  claimWriteback,
  getMission,
  recordKnowledge,
  transitionMission,
} from '../../repos/russellMissions.ts';
import { getCandidate, recordJudgment } from '../../repos/russellCandidates.ts';
import { addMessage } from '../../repos/russellConversations.ts';
import { getOrchestration } from '../../repos/research.ts';
import type {
  KnowledgeConfidence,
  MissionState,
  RussellMission,
} from '../../domain/types.ts';

export interface WritebackResult {
  ok: boolean;
  /** True when somebody else already did it — a replay, not a failure. */
  alreadyDone: boolean;
  missionId: string;
  /** What a person is told, in plain language. */
  briefing: string;
  knowledgeIds: string[];
  /** True when an authorized next mission is available for the loop to start. */
  nextEligible: boolean;
  reason: string;
}

/**
 * How the packet ended, read from the orchestration rather than from prose.
 *
 * `ACCEPTED` means the pipeline produced a filed, audited result. `WITH_GAPS`
 * means it finished and said honestly what it could not settle — which is a
 * real outcome that must be written back as itself. `FAILED` means it did not
 * finish, and nothing is promoted to knowledge from a run that did not.
 */
export type MissionOutcome = 'ACCEPTED' | 'WITH_GAPS' | 'FAILED';

const TERMINAL_STATE: Record<MissionOutcome, MissionState> = {
  ACCEPTED: 'DONE',
  WITH_GAPS: 'DONE',
  FAILED: 'FAILED',
};

const CONFIDENCE: Record<MissionOutcome, KnowledgeConfidence> = {
  ACCEPTED: 'ESTABLISHED',
  WITH_GAPS: 'SUPPORTED',
  FAILED: 'UNCERTAIN',
};

export interface WritebackInput {
  missionId: string;
  outcome: MissionOutcome;
  /** What was concluded, in a sentence a person reads first. */
  conclusion: string;
  /** Anything the run could not settle. Recorded as `GAP` knowledge, not hidden. */
  gaps?: string[];
  /** Accepted claim ids, document id and audit id behind the conclusion. */
  provenance: Record<string, unknown>;
  /** Whether an authorized next mission exists. Decided by the caller from rows. */
  nextEligible?: boolean;
}

/**
 * Do the six things a finished mission has to do, once.
 *
 * The order matters only in that the claim comes first: everything after it is
 * inside the window this call owns, and a crash partway through leaves
 * `writeback_at` set with some effects missing. That is the honest trade — the
 * alternative is a distributed transaction across knowledge, candidates,
 * conversations and events that neither database gives us — and it is why each
 * effect below is written to be individually idempotent as well.
 */
export async function writeBack(input: WritebackInput): Promise<WritebackResult> {
  const mission = await getMission(input.missionId);
  if (!mission) {
    return {
      ok: false,
      alreadyDone: false,
      missionId: input.missionId,
      briefing: '',
      knowledgeIds: [],
      nextEligible: false,
      reason: 'no such mission',
    };
  }

  const claimed = await claimWriteback(mission.id);
  if (!claimed) {
    return {
      ok: true,
      alreadyDone: true,
      missionId: mission.id,
      briefing: '',
      knowledgeIds: [],
      nextEligible: false,
      reason: 'this mission was already written back',
    };
  }

  const knowledgeIds: string[] = [];

  // 1. Promote what was concluded, with its provenance rather than a copy of
  //    the evidence. A knowledge row points at accepted claims; it does not
  //    become a second warehouse of them.
  if (input.outcome !== 'FAILED') {
    const conclusion = await recordKnowledge({
      projectId: mission.projectId,
      layerId: mission.layerId,
      visibility: mission.visibility,
      kind: 'CONCLUSION',
      statement: input.conclusion,
      provenance: input.provenance,
      authorType: 'PIPELINE',
      confidence: CONFIDENCE[input.outcome],
      missionId: mission.id,
      conversationId: mission.conversationId,
    });
    knowledgeIds.push(conclusion.id);
  }

  // 2. Gaps are knowledge too, and durable. Burying an unresolved question in
  //    prose is how it stops being asked.
  for (const gap of input.gaps ?? []) {
    const row = await recordKnowledge({
      projectId: mission.projectId,
      layerId: mission.layerId,
      visibility: mission.visibility,
      kind: 'GAP',
      statement: gap,
      provenance: input.provenance,
      authorType: 'PIPELINE',
      confidence: 'UNCERTAIN',
      missionId: mission.id,
      conversationId: mission.conversationId,
    });
    knowledgeIds.push(row.id);
  }

  // 3. The mission reaches its terminal state, guarded on where it was.
  await transitionMission({
    missionId: mission.id,
    from: mission.state,
    to: TERMINAL_STATE[input.outcome],
    terminalReason: input.outcome === 'WITH_GAPS' ? 'finished with unresolved gaps' : null,
  });

  // 4. The candidate that started it is finished too, and keeps its reason.
  if (mission.candidateId) {
    const candidate = await getCandidate(mission.candidateId);
    if (candidate && candidate.state !== 'MERGED') {
      await recordJudgment({
        candidateId: candidate.id,
        state: input.outcome === 'FAILED' ? 'PARKED' : 'DONE',
        priority: candidate.priority ?? 'WORTH_DOING',
        reason:
          input.outcome === 'FAILED'
            ? 'the research did not finish, so this is parked rather than answered'
            : 'answered by a completed mission',
        judgment: candidate.judgment,
        supporting: [...candidate.supporting, ...knowledgeIds],
        contradicting: candidate.contradicting,
      });
    }
  }

  const briefing = brief(mission, input);

  // 5. The conversation shows what changed, as a turn rather than a banner —
  //    so it is where the person was already looking, and it persists.
  if (mission.conversationId) {
    await addMessage({
      conversationId: mission.conversationId,
      role: 'RUSSELL',
      content: briefing,
      produced: { missionId: mission.id, knowledgeIds },
    });
  }

  // 6. And the project's own append-only history records it.
  await recordEvent({
    projectId: mission.projectId,
    layerId: mission.layerId,
    entityType: 'RUSSELL_MISSION',
    entityId: mission.id,
    eventType: 'RUSSELL_MISSION_WRITEBACK',
    payload: {
      outcome: input.outcome,
      knowledgeIds,
      briefing,
      candidateId: mission.candidateId,
    },
  });

  return {
    ok: true,
    alreadyDone: false,
    missionId: mission.id,
    briefing,
    knowledgeIds,
    nextEligible: input.nextEligible ?? false,
    reason: 'written back',
  };
}

/**
 * What changed, why it matters, what happens next, and whether a person is
 * needed — in that order, and in plain words.
 *
 * Derived from the outcome and the row, never generated. It may simplify; it
 * may not invent progress, certainty or completion, and there is deliberately
 * no percentage anywhere in it.
 */
function brief(mission: RussellMission, input: WritebackInput): string {
  const gaps = input.gaps ?? [];
  if (input.outcome === 'FAILED') {
    return (
      `${mission.objective} did not finish. ` +
      'Nothing has been added to what the project believes, and the idea is parked rather than answered. ' +
      'You are not needed yet.'
    );
  }
  const head = `${input.conclusion}`;
  const why = mission.whyNow;
  if (gaps.length > 0) {
    return (
      `${head}\n\n${why} ` +
      `${gaps.length === 1 ? 'One question' : `${gaps.length} questions`} could not be settled, ` +
      'and each is recorded as an open unknown rather than smoothed over. You are not needed.'
    );
  }
  return `${head}\n\n${why} You are not needed.`;
}

/**
 * Whether the packet behind a mission reached an outcome worth writing back.
 *
 * Read from the orchestration's own status, which is the pipeline's answer, and
 * never from anything a worker said about itself. Returns null while the packet
 * is still running, which is the ordinary case on most ticks.
 */
export async function outcomeOf(mission: RussellMission): Promise<MissionOutcome | null> {
  if (!mission.orchestrationId) return null;
  const orchestration = await getOrchestration(mission.orchestrationId);
  if (!orchestration) return null;
  switch (orchestration.status) {
    case 'COMPLETE':
      return 'ACCEPTED';
    case 'COMPLETE_WITH_GAPS':
      return 'WITH_GAPS';
    case 'FAILED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return null;
  }
}
