/**
 * Why an opportunity or a method did not work, in a small closed vocabulary.
 *
 * Two kinds of reason, and the difference is the point. An *opportunity*
 * reason is a fact about the thing itself under a particular goal: it needed
 * too much capital, nobody would pay, it paid too late. A *method* reason is a
 * fact about how Brain looked: the source could not be read, the search angle
 * returned noise, the research was inconclusive. A method failure says nothing
 * about the opportunity and must never mark it down - the next method may find
 * what this one did not.
 *
 * An opportunity reason only counts against a candidate under a goal where it
 * binds: "capital too high" means nothing to a goal with no capital limit.
 */
export const OPPORTUNITY_REASONS = [
  'CAPITAL_TOO_HIGH',
  'NO_BUYER_FOUND',
  'PAID_TOO_LATE',
  'NOT_ELIGIBLE',
  'EXPIRED',
  'DELIVERY_INFEASIBLE',
] as const;
export type OpportunityReason = (typeof OPPORTUNITY_REASONS)[number];

export const METHOD_REASONS = ['SOURCE_UNREADABLE', 'SEARCH_ANGLE_NOISE', 'RESEARCH_INCONCLUSIVE'] as const;
export type MethodReason = (typeof METHOD_REASONS)[number];

export const OUTCOME_REASONS = [...OPPORTUNITY_REASONS, ...METHOD_REASONS] as const;
export type OutcomeReason = (typeof OUTCOME_REASONS)[number];

/** What happened to the candidate, for which a reason is recorded. */
export const OUTCOME_VERDICTS = ['REJECT', 'DEPRIORITIZE', 'PROMOTE', 'PROVEN', 'FAILED'] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export type ReasonClass = 'OPPORTUNITY' | 'METHOD';

export function reasonClass(reason: OutcomeReason): ReasonClass {
  return (METHOD_REASONS as readonly string[]).includes(reason) ? 'METHOD' : 'OPPORTUNITY';
}

/** A stored text as a closed reason, or null when it is not one (free text stays free text). */
export function asReason(text: string | null | undefined): OutcomeReason | null {
  if (!text) return null;
  const code = text.trim().toUpperCase();
  return (OUTCOME_REASONS as readonly string[]).includes(code) ? (code as OutcomeReason) : null;
}

/** The goal conditions a reason can bind against. Read from the goal's own limits, never assumed. */
export interface GoalConditions {
  hasCapitalLimit: boolean;
  hasDeadline: boolean;
  /** Whether the goal counts cash by when it arrives (collected / settled) rather than contribution. */
  timedCashMetric: boolean;
}

/** Whether an opportunity reason is relevant to a goal. Method reasons never bind a candidate. */
export function reasonBinds(reason: OutcomeReason, goal: GoalConditions): boolean {
  switch (reason) {
    case 'CAPITAL_TOO_HIGH': return goal.hasCapitalLimit;
    case 'PAID_TOO_LATE': return goal.hasDeadline && goal.timedCashMetric;
    case 'NO_BUYER_FOUND':
    case 'NOT_ELIGIBLE':
    case 'EXPIRED':
    case 'DELIVERY_INFEASIBLE':
      return true;
    case 'SOURCE_UNREADABLE':
    case 'SEARCH_ANGLE_NOISE':
    case 'RESEARCH_INCONCLUSIVE':
      return false;
  }
}
