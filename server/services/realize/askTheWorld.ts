/**
 * The questions the director composes, reaching work that can actually run.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `directorPass` reads a packet's open gaps, keeps the ones that are a question
 * about the world at all, asks the archive first through `coverBeforeWork`,
 * closes the ones the archive already settles, and returns the rest as
 * `CapabilityQuestion`s. Then it stops. Nothing anywhere turned one into work,
 * so `docs/CAPABILITY-KERNEL.md` §8 could say truthfully that **no research
 * mission has ever been run for a capability gap** — the faculty that decides
 * what Brain should learn about itself had no way to learn anything.
 *
 * This is the third end of the self-expansion loop that was built and reachable
 * by nothing, and it is the one whose absence is least visible: the director
 * produced a correct, non-empty answer every time it ran, and a reader would
 * have concluded the mechanism worked.
 *
 * ---------------------------------------------------------------------------
 * Why a candidate and not a packet
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is to call `startPacket` with the question. It is wrong for
 * the reason §25 already settled at the connected-site boundary, in almost
 * these words: **a site connector may ask, and only a person in Russell may
 * authorise the spending.** A capability packet is in exactly that position. It
 * is Brain reasoning about Brain, which is the least supervised thing in this
 * codebase and therefore the last place to invent a second way of starting
 * research.
 *
 * So a question becomes a `russell_candidates` row — an *idea*, which spends
 * nothing — and every rule that already governs an idea then applies unchanged:
 * §13's archive check runs again inside the compiler, the standing authority a
 * person granted decides whether a mission launches, the approval envelope
 * decides whether the plan may start without being asked, and the evidence
 * gate, the verification pass and three audit roles are exactly where they were.
 *
 * **There is no authorization in this module and no import that could grant
 * one.** A project with no standing research authority captures the idea and
 * launches nothing, which is the correct outcome and is visible rather than
 * silent — it parks where the person who could authorize it can see it.
 *
 * ---------------------------------------------------------------------------
 * Why the gap is marked ASSIGNED rather than left open
 * ---------------------------------------------------------------------------
 *
 * A gap with an idea behind it is being worked on, and the next director pass
 * reads only `OPEN` gaps — so without the move, every pass would capture the
 * same question again and `fingerprintOf` would merge them into one candidate
 * while the packet learned nothing from having asked. `carriedBy` names the
 * candidate, so walking from a gap to the work is a join rather than a search.
 */
import { capture } from '../russell/judgment.ts';
import { getFaculty } from '../../repos/faculties.ts';
import type { CapabilityQuestion } from './director.ts';
import { directorPass } from './director.ts';
import { getPacket, listGaps, setGapState } from './packet.ts';

export interface AskedQuestion {
  gapId: string;
  question: CapabilityQuestion;
  /** The idea this became, or null when it folded into one already captured. */
  candidateId: string | null;
  merged: boolean;
  reason: string;
}

export interface AskOutcome {
  packetId: string;
  /** Gaps the archive settled, closed by the director pass before anything was asked. */
  alreadyAnswered: number;
  asked: AskedQuestion[];
  /** Gaps that are real and are not research, with what each actually needs. */
  notResearch: Array<{ gapId: string; kind: string; remedy: string }>;
  explanation: string;
}

/**
 * Ask the world what this packet still needs to know.
 *
 * Every question becomes an idea in the architecture project's scope, and
 * nothing here launches, approves, enqueues or spends. Safe to repeat: the
 * director only sees `OPEN` gaps and this moves each one it asks about, so a
 * second call over an unchanged packet asks nothing — and if one is reopened,
 * `capture` folds the repeat into the candidate that already exists rather than
 * making a second.
 */
export async function askTheWorld(input: {
  packetId: string;
  /** The project the ideas are filed in, and whose authority decides the rest. */
  projectId: string;
  layerId: string;
}): Promise<AskOutcome> {
  const packet = await getPacket(input.packetId);
  if (!packet) throw new Error(`No such packet: ${input.packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) throw new Error(`Packet ${input.packetId} names a faculty that does not exist.`);

  const pass = await directorPass({
    packetId: input.packetId,
    projectId: input.projectId,
    layerId: input.layerId,
  });

  const asked: AskedQuestion[] = [];
  for (const question of pass.questions) {
    const outcome = await capture({
      title: `${faculty.definition.canonicalName}: ${question.aspect}`,
      statement: `${question.statement}\n\nWhat the answer decides: ${question.decides}`,
      projectId: input.projectId,
      // Shared rather than private: a capability question is
      // about Brain itself, and a private thread's idea would be invisible to
      // the people who would have to authorize the work it implies.
      visibility: 'SHARED',
    });

    if (outcome.candidate) {
      await setGapState({
        gapId: question.gapId,
        state: 'ASSIGNED',
        reason:
          `Captured as idea ${outcome.candidate.id}. ` +
          (outcome.merged
            ? 'It folded into an idea already captured for this question.'
            : 'Whether it becomes a mission is decided by the standing authority on this ' +
              'project, through the path every other idea takes.'),
        carriedBy: outcome.candidate.id,
      });
    }

    asked.push({
      gapId: question.gapId,
      question,
      candidateId: outcome.candidate?.id ?? null,
      merged: outcome.merged,
      reason: outcome.reason,
    });
  }

  return {
    packetId: input.packetId,
    alreadyAnswered: pass.alreadyAnswered,
    asked,
    notResearch: pass.notResearch,
    explanation: pass.explanation,
  };
}

/**
 * What this packet has out with the world, read back from rows.
 *
 * A projection: it writes nothing, and it exists because a gap that says
 * `ASSIGNED` and names a candidate is the only place the link is recorded. A
 * caller that had to search for the idea by its wording would be re-deriving a
 * join the row already holds — and would find the wrong one after a merge.
 */
export async function outstandingQuestions(
  packetId: string,
): Promise<Array<{ gapId: string; requirement: string; candidateId: string; reason: string }>> {
  const gaps = await listGaps(packetId, { states: ['ASSIGNED'] });
  return gaps
    .filter((gap) => gap.carriedBy !== null)
    .map((gap) => ({
      gapId: gap.id,
      requirement: gap.requirement,
      candidateId: gap.carriedBy as string,
      reason: gap.stateReason ?? '',
    }));
}
