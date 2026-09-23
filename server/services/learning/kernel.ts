/**
 * One project's learning pass, on the durable tick.
 *
 * Observe what earlier work produced, then recheck the facts live goals depend
 * on. Both are derived from rows on every tick rather than hooked to the moment
 * something finished — the distinction this repository has needed more times
 * than any other: a hook fixes one entrance, and rows reach every entrance plus
 * everything already stranded, which is what let the first pass over
 * production's history observe twenty-six dives that finished before this
 * module existed.
 *
 * Neither half acts. The decision a lesson changes is made where that decision
 * already lives (`startValidations`, which asks `advise.ts`); this pass only
 * keeps what that decision reads current.
 *
 * A failure here must never stop the sprint's own work, so it is caught and
 * reported rather than thrown: learning that breaks operating would be a
 * mechanism whose failure mode is worse than its absence.
 */
import { observeCashDeepDives } from './observe.ts';
import { checkWatches } from './watch.ts';
import type { OutcomeWatchChange } from '../../repos/learning.ts';

export interface LearningPass {
  observed: number;
  changes: OutcomeWatchChange[];
  error?: string;
}

export async function runLearning(projectId: string): Promise<LearningPass> {
  try {
    const observed = await observeCashDeepDives(projectId);
    const changes = await checkWatches(projectId);
    return { observed: observed.length, changes };
  } catch (error) {
    return {
      observed: 0,
      changes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
