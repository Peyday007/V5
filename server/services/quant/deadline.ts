/**
 * Research spends the calendar it is meant to protect.
 *
 * For a squeeze goal — little money, little time — a week of research is a
 * week less to sell, deliver and get paid in. Before an unknown becomes a
 * research question this decides, from numbers rather than habit, which of
 * four things to do about it:
 *
 *   * `IGNORE` — knowing it would not change the decision (its information
 *     value is nothing, or less than the research costs);
 *   * `RESEARCH_FIRST` — it changes the decision, and the research plus the
 *     slowest likely path to cash still fits before the deadline;
 *   * `LEARN_WHILE_EXECUTING` — it changes the decision, but waiting for it
 *     would cost the deadline, and the first real attempt reveals it anyway
 *     (a conversion rate is learned by asking buyers, not by reading about it);
 *   * `ACT_ON_RECONSTRUCTION` — it changes the decision, waiting would cost the
 *     deadline, and nothing during execution reveals it in time: the estimate
 *     already reconstructed is what the decision is made on, said so.
 *
 * A real-world test is never an automatic prerequisite: it is chosen only when
 * it fits the calendar and is worth more than it costs.
 */

export const RESEARCH_DECISIONS = ['IGNORE', 'RESEARCH_FIRST', 'LEARN_WHILE_EXECUTING', 'ACT_ON_RECONSTRUCTION'] as const;
export type ResearchDecision = (typeof RESEARCH_DECISIONS)[number];

export interface ResearchQuestion {
  key: string;
  /** Expected gain in the decision's score from knowing it (from `informationValue`). */
  informationValue: number;
  changesDecision: boolean;
  /** Days the research is expected to take before an answer lands. */
  researchDays: number;
  /** What the research costs, in the score's units (often 0 for subscription research). */
  researchCost?: number;
  /** True when the first real attempt reveals the answer anyway. */
  learnableInExecution: boolean;
}

export interface CalendarInput {
  daysLeft: number;
  /** The slowest likely path from starting to usable cash (a p90), in days. */
  executionDaysP90: number;
}

export interface ResearchVerdict {
  key: string;
  decision: ResearchDecision;
  reason: string;
}

export function decideResearch(question: ResearchQuestion, calendar: CalendarInput): ResearchVerdict {
  const cost = question.researchCost ?? 0;
  if (!question.changesDecision || question.informationValue <= cost) {
    return {
      key: question.key,
      decision: 'IGNORE',
      reason: !question.changesDecision
        ? 'whatever the answer, the same choice is best, so researching it buys nothing'
        : `it could change the choice, but by less (${fmt(question.informationValue)}) than the research costs (${fmt(cost)})`,
    };
  }
  const slack = calendar.daysLeft - calendar.executionDaysP90;
  if (question.researchDays <= slack) {
    return { key: question.key, decision: 'RESEARCH_FIRST', reason: `it changes the choice and ${fmt(question.researchDays)} days of research still leaves the slowest path (${fmt(calendar.executionDaysP90)} days) inside the ${fmt(calendar.daysLeft)} left` };
  }
  if (question.learnableInExecution) {
    return { key: question.key, decision: 'LEARN_WHILE_EXECUTING', reason: `waiting ${fmt(question.researchDays)} days for it would push the slowest path past the deadline; the first real attempt reveals it` };
  }
  return { key: question.key, decision: 'ACT_ON_RECONSTRUCTION', reason: `waiting ${fmt(question.researchDays)} days for it would cost the deadline and nothing during execution reveals it in time; decide on the reconstructed estimate, stated as such` };
}

/** Share of worlds in which a sequence of steps finishes inside the window after a delay. */
export function finishesInTime(steps: number[][], daysLeft: number, delayDays = 0): number {
  if (steps.length === 0) return 1;
  const n = Math.min(...steps.map((one) => one.length));
  let ok = 0;
  for (let i = 0; i < n; i++) {
    let total = delayDays;
    for (const step of steps) total += step[i]!;
    if (total <= daysLeft) ok += 1;
  }
  return n === 0 ? 0 : ok / n;
}

function fmt(x: number): string {
  return Math.abs(x) < 10 ? x.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(x));
}
