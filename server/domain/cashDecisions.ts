/**
 * A decision about one opportunity under one goal: reject it, hold it until a
 * named fact arrives, or prioritize it. Words, never a score.
 */
export const DECISION_VERDICTS = ['REJECT', 'HOLD', 'PRIORITIZE'] as const;
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number];

export interface CashDecision {
  id: string;
  projectId: string;
  opportunityId: string;
  goalId: string;
  verdict: DecisionVerdict;
  reason: string;
  detail: string;
  /** The goal limit that decided it, when one did. */
  bindingConstraint: string | null;
  missingFacts: string[];
  evidenceIds: string[];
  /** What would reopen it, in words. */
  reopenCondition: string;
  /** The distinct change that produced this decision. */
  changeRef: string;
  isCurrent: boolean;
  recomputeChangeRef: string | null;
  recomputeRequestedAt: string | null;
  decidedAt: string;
  supersededAt: string | null;
}

/** What reopens each kind of decision. A HOLD reopens when what it lacks arrives. */
export const REOPEN_CONDITION: Readonly<Record<string, string>> = Object.freeze({
  EXPIRED: 'a later closing date is published for it',
  DUPLICATE: 'the opening it repeats is withdrawn or found to differ',
  EXCLUDED_REQUIREMENT: 'the operation stops excluding what it requires',
  NOT_ELIGIBLE: 'the capability it requires is recorded as held',
  CAPITAL_TOO_HIGH: "the goal's capital limit changes, or a route needing no capital is named",
  PAID_TOO_LATE: "the goal's deadline moves, or payment is shown to arrive sooner",
  NO_CAPITAL_ROUTE_TO_CONFIRM: 'the named no-capital route is confirmed or ruled out',
  MISSING_FACTS: 'the missing facts are established',
  ELIGIBILITY_UNKNOWN: 'the operation records what capabilities it holds',
  STALE_SOURCE: 'its source is read again',
  UNFAMILIAR_TYPE: 'research shows what this kind of opportunity has paid',
  CLEAR: "the goal's limits change, or new evidence contradicts a fact it rests on",
});

export function reopenConditionFor(reason: string): string {
  return REOPEN_CONDITION[reason] ?? 'new evidence or a changed goal limit arrives';
}
