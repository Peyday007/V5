/**
 * What is actually happening to an open round, right now.
 *
 * ---------------------------------------------------------------------------
 * "OPEN" is a fact about a round, not about whether anybody is working
 * ---------------------------------------------------------------------------
 *
 * `manufacturing_rounds.state` says a question has been asked and not settled.
 * It says nothing about whether a mission was ever launched for it, whether a
 * bin exists, whether a worker holds a lease on its work right now, or whether
 * the whole thing stopped days ago on a decision nobody is being asked for. A
 * round that has been OPEN for three days and one a worker is holding this
 * minute are the same row.
 *
 * That gap is §24's `pending.ts` defect one kernel along, and it records what
 * the cost is: a sentence stored before anything happened *stays reassuring
 * however long the turn waits and whatever goes wrong with it*. The case that
 * matters is the one that must never read as patience — a round with no
 * mission, or a mission with no bin, which nothing is ever going to answer.
 *
 * ---------------------------------------------------------------------------
 * A projection, and it names what it cannot see
 * ---------------------------------------------------------------------------
 *
 * This writes nothing and derives everything on the read path, so it cannot
 * be stale and cannot be wrong about a row that has since moved. Where it
 * cannot tell, it says `UNKNOWN` rather than choosing the reassuring answer —
 * §30's and §37's rule that *we could not tell* must never read the same as
 * *we checked*, arriving at a progress line.
 *
 * It names **no worker, no Routine and no session**. `pending.ts` makes the
 * same refusal and for the same reason: which machine is holding something is
 * operator detail, and a progress line a project member reads is not where it
 * belongs.
 */
import { listMissions } from '../../repos/russellMissions.ts';
import { listWorkItemsForOrchestration } from '../../repos/workQueue.ts';
import type { ManufacturingRound, RussellMission, WorkItem } from '../../domain/types.ts';

/**
 * How far an open round has actually got.
 *
 * Ordered by how far along it is, and every value names a different remedy —
 * which is the whole point of splitting them. `NOT_LAUNCHED` waits for a tick,
 * `NEEDS_A_PERSON` waits for somebody, `STALLED` waits for nothing at all and
 * is the one a reader has to be able to find.
 */
export const ROUND_PROGRESS = [
  /** A round exists and no mission was ever launched for it. */
  'NOT_LAUNCHED',
  /** A mission exists and has produced no work a worker could claim. */
  'NO_WORK_YET',
  /** Work is on the queue and nobody is holding it. */
  'QUEUED',
  /** A worker holds a live lease on it right now. */
  'WORKING',
  /** The mission stopped on a decision, and somebody has to answer it. */
  'NEEDS_A_PERSON',
  /**
   * The mission ended and the round is still open.
   *
   * Not an error: the next tick absorbs what it found and settles the round.
   * It is named rather than folded into `WORKING` because a reader seeing it
   * for more than a tick has found something worth looking at.
   */
  'AWAITING_ABSORPTION',
  /**
   * Nothing is going to move this without somebody looking.
   *
   * The state this module exists for. A mission that failed or was cancelled
   * while its round stayed open is a question nobody is answering and nothing
   * is going to re-ask, and it would otherwise read exactly like a round that
   * was opened a minute ago.
   */
  'STALLED',
  /** The rows do not say. Never the reassuring answer. */
  'UNKNOWN',
] as const;
export type RoundProgress = (typeof ROUND_PROGRESS)[number];

export interface RoundReadingProgress {
  roundId: string;
  progress: RoundProgress;
  /** One sentence composed from the rows it was read from. */
  because: string;
  /** How many work items exist, and how many a worker is holding. */
  items: { total: number; leased: number; queued: number; finished: number };
}

/**
 * Read every open round's progress in one pass.
 *
 * Taken in bulk for `coverageOf`'s reason: a per-round fetch would make one
 * reading cost a query per open question, and the missions are a fact about
 * the project rather than about any one round.
 */
export async function readProgress(
  projectId: string,
  rounds: readonly ManufacturingRound[],
): Promise<RoundReadingProgress[]> {
  const open = rounds.filter((one) => one.state === 'OPEN');
  if (open.length === 0) return [];

  const missions = await listMissions({ projectId });
  const byCandidate = new Map<string, RussellMission>();
  for (const mission of missions) {
    if (!mission.candidateId) continue;
    /*
     * Newest wins, because a candidate can be launched more than once.
     *
     * `russell_missions` is append-only and a re-launch writes a second row;
     * reading the first would report a superseded attempt's state for ever.
     * `linkFiledWork` took the *last* element of a newest-first list and got
     * the older audit every time (§24) — the same mistake, one table along.
     */
    const existing = byCandidate.get(mission.candidateId);
    if (!existing || mission.createdAt > existing.createdAt) {
      byCandidate.set(mission.candidateId, mission);
    }
  }

  const out: RoundReadingProgress[] = [];
  for (const round of open) {
    const mission = byCandidate.get(round.candidateId) ?? null;
    const items = mission?.orchestrationId
      ? await listWorkItemsForOrchestration(mission.orchestrationId)
      : [];
    out.push({ roundId: round.id, ...describe(mission, items) });
  }
  return out;
}

function describe(
  mission: RussellMission | null,
  items: readonly WorkItem[],
): Omit<RoundReadingProgress, 'roundId'> {
  const counts = {
    total: items.length,
    leased: items.filter((one) => one.state === 'LEASED').length,
    queued: items.filter((one) => one.state === 'QUEUED').length,
    finished: items.filter(
      (one) => one.state === 'SUCCEEDED' || one.state === 'FAILED' || one.state === 'CANCELLED',
    ).length,
  };

  if (!mission) {
    return {
      progress: 'NOT_LAUNCHED',
      because:
        'The question has been asked and no mission has launched for it yet. The next tick ' +
        'judges it, compiles it and launches it — or parks it with a reason.',
      items: counts,
    };
  }

  if (mission.state === 'NEEDS_HUMAN') {
    return {
      progress: 'NEEDS_A_PERSON',
      because:
        'The mission stopped on a decision. Until somebody answers it, nothing about this ' +
        'question moves.',
      items: counts,
    };
  }

  if (mission.state === 'FAILED' || mission.state === 'CANCELLED') {
    return {
      progress: 'STALLED',
      because:
        `The mission for this question is ${mission.state.toLowerCase()}` +
        `${mission.terminalReason ? `: ${mission.terminalReason}` : ''}. The round is still ` +
        'open and nothing is going to re-ask it on its own.',
      items: counts,
    };
  }

  if (mission.state === 'DONE') {
    return {
      progress: 'AWAITING_ABSORPTION',
      because:
        'The mission finished and the round is still open. The next tick files what the gate ' +
        'accepted and settles it.',
      items: counts,
    };
  }

  if (!mission.orchestrationId) {
    return {
      progress: 'NO_WORK_YET',
      because:
        'A mission exists and has not yet produced work a worker could claim. The next tick ' +
        'advances it.',
      items: counts,
    };
  }

  if (counts.leased > 0) {
    return {
      progress: 'WORKING',
      because:
        `A worker is holding ${counts.leased} of ${counts.total} work item` +
        `${counts.total === 1 ? '' : 's'} for this question right now.`,
      items: counts,
    };
  }

  if (counts.queued > 0) {
    return {
      progress: 'QUEUED',
      because:
        `${counts.queued} work item${counts.queued === 1 ? ' is' : 's are'} on the queue and ` +
        'nobody is holding one. It waits for a worker to arrive.',
      items: counts,
    };
  }

  if (counts.total === 0) {
    return {
      progress: 'NO_WORK_YET',
      because:
        'The mission is running and has produced no work a worker could claim yet. The next ' +
        'tick advances it.',
      items: counts,
    };
  }

  /*
   * Every item finished and the mission is still running.
   *
   * Ordinary for a tick or two while the packet advances, and worth naming
   * rather than calling `WORKING`: a reader seeing it persist has found
   * something, and calling it working would have been the reassuring guess.
   */
  return {
    progress: 'UNKNOWN',
    because:
      `All ${counts.total} work item${counts.total === 1 ? '' : 's'} for this question have ` +
      'finished and the mission is still running. That is ordinary for a pass or two while ' +
      'the packet advances; if it persists, the packet is worth looking at.',
    items: counts,
  };
}
