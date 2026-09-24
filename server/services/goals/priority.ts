/**
 * Which goal gets capacity first, and exactly why.
 *
 * Pure over a recorded snapshot, for `services/dispatch/router.ts`' reason:
 * "why is this goal ahead of that one" must be answerable from an input rather
 * than from a re-run against a database that has since moved. Being pure also
 * makes it useless as a safety mechanism, which is correct — what it decides is
 * an ordering, and the exclusion that keeps two workers off one bin is still
 * the compare-and-swap on the bin.
 *
 * Lexicographic over facts, in a declared order, never a weighted score. The
 * first criterion two goals differ on is the whole reason one is above the
 * other, and nothing below it was consulted — which is what lets
 * `explainAgainst` say so in one sentence.
 *
 * **Ranked within an owner, never across owners.** Four people run four
 * private operations on one fleet (§30, §34), and a ranking that put one
 * person's customer commitment above another person's everything would let one
 * operation's priorities decide how much capacity another operation gets. So
 * each owner's first goal gets the same bin priority, their second the next,
 * and the fleet interleaves them — which is also the only arrangement in which
 * one person's goals cannot be seen to affect another's allocation.
 */
import type { WorkstreamPurpose } from '../../domain/register.ts';
import type { GoalCommitment, PriorityCriterion } from '../../domain/goals.ts';

export interface PriorityFacts {
  id: string;
  ownerKey: string;
  /**
   * Active, not paused, cancelled or complete, not waiting on another goal, and
   * not stopped at a person's decision with nothing else it can run.
   */
  workable: boolean;
  commitment: GoalCommitment;
  dueAt: string | null;
  purpose: WorkstreamPurpose;
  /** How many other live goals declare they depend on this one. */
  dependents: number;
  createdAt: string;
}

export interface RankedGoal {
  id: string;
  ownerKey: string;
  /** 0-based within the owner. */
  rank: number;
  /** Why it is above the next one down, or null when it is last. */
  aboveNext: { criterion: PriorityCriterion; reason: string } | null;
  /** Why it is below the one above, or null when it is first. */
  belowPrevious: { criterion: PriorityCriterion; reason: string } | null;
}

const COMMITMENT_ORDER: Record<GoalCommitment, number> = { CUSTOMER: 0, INTERNAL: 1, NONE: 2 };
const PURPOSE_ORDER: Record<WorkstreamPurpose, number> = {
  REVENUE_DIRECT: 0,
  REVENUE_ENABLING: 1,
  CAPABILITY: 2,
  LONG_TERM: 3,
};

/**
 * The first criterion `a` and `b` differ on, negative when `a` comes first.
 *
 * A missing deadline sorts *after* any deadline, because a goal nobody put a
 * date on has not been shown to be more urgent than one somebody did — an
 * unknown is never the favourable reading (invariant 39).
 */
export function compareGoals(
  a: PriorityFacts,
  b: PriorityFacts,
): { criterion: PriorityCriterion; order: number } {
  if (a.workable !== b.workable) return { criterion: 'WORKABLE', order: a.workable ? -1 : 1 };
  const commitment = COMMITMENT_ORDER[a.commitment] - COMMITMENT_ORDER[b.commitment];
  if (commitment !== 0) return { criterion: 'COMMITMENT', order: commitment };
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return { criterion: 'DEADLINE', order: 1 };
    if (b.dueAt === null) return { criterion: 'DEADLINE', order: -1 };
    return { criterion: 'DEADLINE', order: a.dueAt < b.dueAt ? -1 : 1 };
  }
  const purpose = PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose];
  if (purpose !== 0) return { criterion: 'PURPOSE', order: purpose };
  if (a.dependents !== b.dependents) {
    return { criterion: 'UNBLOCKS', order: b.dependents - a.dependents };
  }
  if (a.createdAt !== b.createdAt) return { criterion: 'AGE', order: a.createdAt < b.createdAt ? -1 : 1 };
  return { criterion: 'TIE', order: a.id < b.id ? -1 : a.id > b.id ? 1 : 0 };
}

const PURPOSE_WORDS: Record<WorkstreamPurpose, string> = {
  REVENUE_DIRECT: 'pursues money directly',
  REVENUE_ENABLING: 'clears the way for money',
  CAPABILITY: 'builds a general capability',
  LONG_TERM: 'serves a longer-term goal',
};

/** One sentence naming the deciding fact, from the winner's side. */
export function explainAgainst(
  winner: PriorityFacts,
  loser: PriorityFacts,
  criterion: PriorityCriterion,
): string {
  switch (criterion) {
    case 'WORKABLE':
      return 'it can be worked now, and the other is paused, cancelled, finished, or waiting on another goal or on a person';
    case 'COMMITMENT':
      return winner.commitment === 'CUSTOMER'
        ? 'it is owed to a customer and the other is not'
        : 'it is committed to somebody and the other is not';
    case 'DEADLINE':
      return winner.dueAt && loser.dueAt
        ? `it is due ${winner.dueAt.slice(0, 10)}, before the other's ${loser.dueAt.slice(0, 10)}`
        : `it is due ${winner.dueAt?.slice(0, 10) ?? '—'} and the other has no deadline`;
    case 'PURPOSE':
      return `it ${PURPOSE_WORDS[winner.purpose]}, and the other ${PURPOSE_WORDS[loser.purpose]}`;
    case 'UNBLOCKS':
      return `${winner.dependents} other goal(s) wait on it, against ${loser.dependents}`;
    case 'AGE':
      return 'nothing else separates them, and it was set first';
    case 'TIE':
      return 'nothing recorded separates them; the order between them is by id only';
  }
}

/** Rank every goal within its owner. Deterministic, total, and explained. */
export function rankGoals(goals: PriorityFacts[]): RankedGoal[] {
  const byOwner = new Map<string, PriorityFacts[]>();
  for (const goal of goals) {
    const list = byOwner.get(goal.ownerKey);
    if (list) list.push(goal);
    else byOwner.set(goal.ownerKey, [goal]);
  }

  const out: RankedGoal[] = [];
  for (const [ownerKey, list] of [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...list].sort((a, b) => compareGoals(a, b).order);
    sorted.forEach((goal, index) => {
      const next = sorted[index + 1];
      const previous = sorted[index - 1];
      const aboveNext = next
        ? (() => {
            const { criterion } = compareGoals(goal, next);
            return { criterion, reason: explainAgainst(goal, next, criterion) };
          })()
        : null;
      const belowPrevious = previous
        ? (() => {
            const { criterion } = compareGoals(previous, goal);
            return { criterion, reason: explainAgainst(previous, goal, criterion) };
          })()
        : null;
      out.push({ id: goal.id, ownerKey, rank: index, aboveNext, belowPrevious });
    });
  }
  return out;
}
