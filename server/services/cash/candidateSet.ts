/**
 * Surviving opportunities, exported for a planner that combines them.
 *
 * There is no per-opportunity minimum revenue: several small opportunities that
 * only together reach a goal all survive. The only thing that removes one here
 * is a known break of the goal's own limits. This module decides nothing about
 * a plan and imports nothing from the goal planners; it hands them a set and
 * says, in words, whether the set could reach the target on what is counted.
 */
import { rankForGoal, type RankGoal, type RankInput } from './rankGoal.ts';

export interface CandidateMember {
  id: string;
  title: string;
  countedCents: number;
  capitalCents: number | null;
  daysToCash: number | null;
  repeatable: boolean | null;
}

export interface CandidateSet {
  members: CandidateMember[];
  /** Rejected for breaking a limit, with why - never silently dropped. */
  excluded: { id: string; why: string }[];
  countedCents: number;
  targetCents: number;
  /** Whether the whole set's counted money reaches the target; capital is judged separately. */
  reachesTarget: boolean;
  /** Whether the members' known capital together stays inside the goal's ceiling; null when any is unknown. */
  capitalWithinCeiling: boolean | null;
  note: string;
}

export function candidateSet(items: RankInput[], goal: RankGoal): CandidateSet {
  const ranked = rankForGoal(items, goal);
  const byId = new Map(items.map((i) => [i.opportunity.id, i]));
  const members: CandidateMember[] = [];
  const excluded: CandidateSet['excluded'] = [];
  for (const r of ranked) {
    const i = byId.get(r.id)!;
    if (r.fit === 'MISFIT') {
      excluded.push({ id: r.id, why: 'breaks a limit of the goal on what is known' });
      continue;
    }
    members.push({
      id: r.id,
      title: i.opportunity.title,
      countedCents: r.countedCents,
      capitalCents: i.opportunity.peakFundingCents,
      daysToCash: i.daysToCash,
      repeatable: i.repeatable,
    });
  }
  const countedCents = members.reduce((n, m) => n + m.countedCents, 0);
  const capitals = members.map((m) => m.capitalCents);
  const capitalWithinCeiling = goal.capitalCeilingCents === null || capitals.some((c) => c === null)
    ? (goal.capitalCeilingCents === null ? true : null)
    : capitals.reduce<number>((n, c) => n + (c ?? 0), 0) <= goal.capitalCeilingCents;
  const reachesTarget = countedCents >= goal.targetCents;
  return {
    members, excluded, countedCents, targetCents: goal.targetCents, reachesTarget, capitalWithinCeiling,
    note: reachesTarget
      ? `${members.length} surviving opportunit${members.length === 1 ? 'y' : 'ies'} together count ${(countedCents / 100).toLocaleString('en-US')} toward ${(goal.targetCents / 100).toLocaleString('en-US')}; whether they can all run together is the planner's question.`
      : `Surviving opportunities count ${(countedCents / 100).toLocaleString('en-US')} of ${(goal.targetCents / 100).toLocaleString('en-US')} on what is supported; more must be found or supported.`,
  };
}
