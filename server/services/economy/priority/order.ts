/**
 * Which research gets premium capacity first.
 *
 * Pure over a recorded snapshot, for `services/goals/priority.ts`' reason: "why
 * did this research go ahead of that" must be answerable from an input. It is an
 * ordering and never a gate — the exclusion between workers stays the
 * compare-and-swap on the bin.
 *
 * Premium capacity goes to demands that serve an active goal, in the order the
 * owner configured. A demand serving no active goal is background work: it is
 * ordered after every goal demand, flagged `premium: false`, and is meant to be
 * organised by code. There is no reserved share for either side.
 *
 * Ordered within an owner and interleaved across owners, so one person's goals,
 * priorities and deadlines can never move another person's demands.
 */

export interface GoalSetting {
  goalId: string;
  ownerKey: string;
  /** Active, not paused, cancelled or complete. */
  active: boolean;
  /** The owner's own order; lower first. Null when they did not set one. */
  userPriority: number | null;
  dueAt: string | null;
  createdAt: string;
}

export interface ResearchDemand {
  id: string;
  ownerKey: string;
  /** The goal this research serves, or null for unattached/long-term work. */
  goalId: string | null;
  createdAt: string;
}

export type OrderCriterion = 'ACTIVE_GOAL' | 'USER_PRIORITY' | 'DEADLINE' | 'AGE' | 'TIE';

export interface OrderedDemand {
  id: string;
  ownerKey: string;
  /** 0-based within the owner. */
  rank: number;
  /** Position in the interleaved fleet order. */
  position: number;
  premium: boolean;
  reason: string;
}

interface Resolved extends ResearchDemand {
  active: boolean;
  userPriority: number | null;
  dueAt: string | null;
}

function compare(a: Resolved, b: Resolved): { criterion: OrderCriterion; order: number } {
  if (a.active !== b.active) return { criterion: 'ACTIVE_GOAL', order: a.active ? -1 : 1 };
  // An unset priority sorts after a set one: it is not shown to be more urgent.
  if (a.userPriority !== b.userPriority) {
    if (a.userPriority === null) return { criterion: 'USER_PRIORITY', order: 1 };
    if (b.userPriority === null) return { criterion: 'USER_PRIORITY', order: -1 };
    return { criterion: 'USER_PRIORITY', order: a.userPriority - b.userPriority };
  }
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return { criterion: 'DEADLINE', order: 1 };
    if (b.dueAt === null) return { criterion: 'DEADLINE', order: -1 };
    return { criterion: 'DEADLINE', order: a.dueAt < b.dueAt ? -1 : 1 };
  }
  if (a.createdAt !== b.createdAt) return { criterion: 'AGE', order: a.createdAt < b.createdAt ? -1 : 1 };
  return { criterion: 'TIE', order: a.id < b.id ? -1 : a.id > b.id ? 1 : 0 };
}

function reasonFor(d: Resolved, criterion: OrderCriterion | null): string {
  if (!d.active) return 'serves no active goal, so code organises it and it takes no premium job';
  switch (criterion) {
    case 'USER_PRIORITY': return 'the owner ranked its goal first';
    case 'DEADLINE': return 'its goal is due sooner';
    case 'AGE': return 'nothing else separates it, and it was asked first';
    case 'TIE': return 'nothing recorded separates it; the order is by id only';
    default: return 'it serves an active goal';
  }
}

/**
 * A goal's demands are only resolved against goals of the same owner; a goal id
 * belonging to somebody else resolves to nothing, so it cannot lift a demand.
 */
export function orderResearch(demands: ResearchDemand[], goals: GoalSetting[]): OrderedDemand[] {
  const settings = new Map<string, GoalSetting>();
  for (const g of goals) settings.set(`${g.ownerKey}\u0000${g.goalId}`, g);

  const byOwner = new Map<string, Resolved[]>();
  for (const d of demands) {
    const g = d.goalId ? settings.get(`${d.ownerKey}\u0000${d.goalId}`) : undefined;
    const resolved: Resolved = {
      ...d,
      active: g?.active ?? false,
      userPriority: g?.userPriority ?? null,
      dueAt: g?.dueAt ?? null,
    };
    const list = byOwner.get(d.ownerKey);
    if (list) list.push(resolved);
    else byOwner.set(d.ownerKey, [resolved]);
  }

  const lanes = [...byOwner.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ownerKey, list]) => {
      const sorted = [...list].sort((a, b) => compare(a, b).order);
      return sorted.map((d, i) => ({
        d,
        ownerKey,
        rank: i,
        criterion: i === 0 ? null : compare(sorted[i - 1]!, d).criterion,
      }));
    });

  // Interleave by in-owner rank, with active goal work ahead of background at
  // every rank so premium capacity never waits behind another owner's background.
  const flat = lanes.flat();
  flat.sort((x, y) => {
    if (x.d.active !== y.d.active) return x.d.active ? -1 : 1;
    if (x.rank !== y.rank) return x.rank - y.rank;
    return x.ownerKey < y.ownerKey ? -1 : x.ownerKey > y.ownerKey ? 1 : 0;
  });

  return flat.map((e, position) => ({
    id: e.d.id,
    ownerKey: e.ownerKey,
    rank: e.rank,
    position,
    premium: e.d.active,
    reason: reasonFor(e.d, e.criterion),
  }));
}
