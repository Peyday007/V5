/**
 * Which research question is worth the next unit of a goal's budget.
 *
 * Lexicographic over named facts, never a weighted score: the first criterion
 * two questions differ on is the whole reason one is ahead, and nothing below
 * it was consulted. Volume cannot outrank importance, because no criterion
 * counts how many questions share a level — a few critical questions come
 * before any number of low-value ones.
 */
import type { TargetReading } from '../../goals/target.ts';

/** What an answer could do to the decision in front of the goal. */
export const DECISION_IMPACTS = ['CHANGES_DECISION', 'INFORMS', 'CONTEXT', 'UNKNOWN'] as const;
export type DecisionImpact = (typeof DECISION_IMPACTS)[number];

export interface OpenQuestion {
  key: string;
  impact: DecisionImpact;
  /** What deciding right is worth, in cents, where somebody stated it. Null = not stated. */
  valueCents: number | null;
  /** Work units one answer would consume (jobs, fragments); the budget's own unit. */
  costUnits: number;
  /** Other questions that cannot start until this one is answered. */
  blocks: number;
  /** Times an answer would be reused by other work. */
  reuse: number;
  /** Days since the opportunity's evidence was last current; null = never read. */
  staleDays: number | null;
}

export interface Ranked {
  question: OpenQuestion;
  /** The first criterion this question beat the next one on, in words. */
  because: string;
}

const impactRank = (i: DecisionImpact): number => DECISION_IMPACTS.indexOf(i);

/** Compare, returning the criterion that decided (or null when nothing separates them). */
export function decidedBy(a: OpenQuestion, b: OpenQuestion): { sign: number; criterion: string } | null {
  const steps: [string, number][] = [
    ['it can change the decision', impactRank(a.impact) - impactRank(b.impact)],
    ['more work waits on it', b.blocks - a.blocks],
    // A stated value beats an unstated one: an unknown never ranks higher.
    ['its stated value is higher', (b.valueCents ?? -1) - (a.valueCents ?? -1)],
    ['its answer is reused more', b.reuse - a.reuse],
    ['it costs less', a.costUnits - b.costUnits],
    ['its evidence is staler', (b.staleDays ?? -1) - (a.staleDays ?? -1)],
    ['its key sorts first', a.key < b.key ? -1 : a.key > b.key ? 1 : 0],
  ];
  for (const [criterion, diff] of steps) if (diff !== 0) return { sign: Math.sign(diff), criterion };
  return null;
}

export function orderQuestions(questions: readonly OpenQuestion[]): Ranked[] {
  const sorted = [...questions].sort((a, b) => decidedBy(a, b)?.sign ?? 0);
  return sorted.map((question, i) => ({
    question,
    because: i + 1 < sorted.length ? (decidedBy(question, sorted[i + 1]!)?.criterion ?? 'nothing separates it from the next') : 'last',
  }));
}

export interface GoalBudget {
  /** Work units the goal can spend; null means the goal states no ceiling. */
  units: number | null;
  /** Where the number came from, so it is never mistaken for a measurement. */
  basis: string;
}

/**
 * Reads the goal's stored resources through its exported reading. The ceiling is
 * the owner's hours; `unitsPerHour` is the caller's own conversion, so this
 * module invents none.
 */
export function goalBudgetFrom(reading: Pick<TargetReading, 'hoursCeiling'> | null, unitsPerHour: number): GoalBudget {
  if (!reading || reading.hoursCeiling === null) return { units: null, basis: 'the goal states no hours ceiling' };
  return { units: Math.max(0, Math.floor(reading.hoursCeiling * unitsPerHour)), basis: `${reading.hoursCeiling} hours at ${unitsPerHour} units/hour` };
}

export interface Selection {
  chosen: Ranked[];
  /** Left for later, never dropped: budget ran out or it did not fit. */
  deferred: Ranked[];
  spentUnits: number;
}

/** Takes questions in order while the budget lasts; a question that does not fit waits, and smaller ones behind it may still run. */
export function selectWithinBudget(questions: readonly OpenQuestion[], budget: GoalBudget): Selection {
  const ranked = orderQuestions(questions);
  if (budget.units === null) return { chosen: ranked, deferred: [], spentUnits: ranked.reduce((n, r) => n + r.question.costUnits, 0) };
  const chosen: Ranked[] = [];
  const deferred: Ranked[] = [];
  let spent = 0;
  for (const r of ranked) {
    if (spent + r.question.costUnits <= budget.units) { chosen.push(r); spent += r.question.costUnits; } else deferred.push(r);
  }
  return { chosen, deferred, spentUnits: spent };
}
