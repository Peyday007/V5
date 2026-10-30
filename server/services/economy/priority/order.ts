/**
 * Which research is dispatched first. A pure ordering over rows the caller
 * read; it fetches nothing and decides nothing about authorization.
 *
 * Premium capacity goes to active near-term goals, ranked by the owner's own
 * configured priority, then by how near the deadline is. Work belonging to no
 * active goal sorts after all of it and is left to code, never premium jobs.
 * There is no reserved share: a distant possibility waits only while an
 * active goal's work is waiting. Lexicographic, never a score, so the first
 * criterion two items differ on is the whole reason.
 */

export interface PriorityGoal {
  id: string;
  ownerUserId: string;
  active: boolean;
  /** The owner's configured priority; lower runs first. Null = not configured. */
  configuredRank: number | null;
  /** Null when no deadline is known. */
  daysLeft: number | null;
}

export interface ResearchWork {
  id: string;
  ownerUserId: string;
  /** The goal the work serves; null for background / long-term work. */
  goalId: string | null;
  createdAt: string;
}

export type PriorityClass = 'ACTIVE_GOAL' | 'BACKGROUND';

export interface OrderedWork {
  work: ResearchWork;
  class: PriorityClass;
  premium: boolean;
  reason: string;
}

const UNSET = Number.POSITIVE_INFINITY;

/**
 * Orders `work` for `ownerUserId` only. Another user's goals are never read
 * for the ordering, and their work is not returned.
 */
export function orderResearchWork(
  ownerUserId: string,
  goals: readonly PriorityGoal[],
  work: readonly ResearchWork[],
): OrderedWork[] {
  const mine = new Map<string, PriorityGoal>();
  for (const g of goals) if (g.ownerUserId === ownerUserId) mine.set(g.id, g);

  const rows = work
    .filter((w) => w.ownerUserId === ownerUserId)
    .map((w) => {
      const goal = w.goalId ? mine.get(w.goalId) : undefined;
      const active = goal !== undefined && goal.active;
      return { w, goal: active ? goal : undefined };
    });

  rows.sort((a, b) => {
    const aa = a.goal !== undefined, bb = b.goal !== undefined;
    if (aa !== bb) return aa ? -1 : 1;
    if (a.goal && b.goal) {
      const ra = a.goal.configuredRank ?? UNSET, rb = b.goal.configuredRank ?? UNSET;
      if (ra !== rb) return ra - rb;
      const da = a.goal.daysLeft ?? UNSET, db = b.goal.daysLeft ?? UNSET;
      if (da !== db) return da - db;
    }
    if (a.w.createdAt !== b.w.createdAt) return a.w.createdAt < b.w.createdAt ? -1 : 1;
    return a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0;
  });

  return rows.map(({ w, goal }) => goal
    ? { work: w, class: 'ACTIVE_GOAL', premium: true,
        reason: goal.configuredRank !== null
          ? `serves an active goal the owner ranked ${goal.configuredRank}`
          : 'serves an active goal with no configured rank' }
    : { work: w, class: 'BACKGROUND', premium: false,
        reason: 'serves no active goal of this owner; organised by code, no premium job' });
}
