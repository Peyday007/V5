/**
 * How a goal is executed, read from the goal itself (owner, 2026-11-06).
 *
 * A SQUEEZE goal is a time-constrained cash-generation objective: a money
 * target with a deadline. Its calendar is the scarce thing, so it has no
 * separate market-testing phase:
 *
 *   - an opening ready for a commercially responsible offer is sold, not
 *     tested — the first offer pursues an actual sale, contract, deposit or
 *     paid transaction, and its outcome is a sale or a refusal, never a pass
 *     or fail that gates "normal selling";
 *   - what selling reveals (whether buyers reply, how many agree, how many
 *     buy again) is learned by selling, not by research rounds run first to
 *     qualify the opening for an experiment;
 *   - several independent sources are pursued at once, ranked by what each
 *     can collect before the deadline and adds to the whole goal;
 *   - the money limits and the permission to contact buyers, contract and
 *     take payment are unchanged. A missing permission is a blocker on the
 *     sale, never a reason to run a test first.
 *
 * Every goal with a target and a due date is a SQUEEZE goal; one without a
 * deadline keeps the evidence-first order. Pure.
 */

export const GOAL_EXECUTION_POLICIES = ['SQUEEZE', 'EVIDENCE_FIRST'] as const;
export type GoalExecutionPolicy = (typeof GOAL_EXECUTION_POLICIES)[number];

export function goalExecutionPolicy(target: { daysLeft: number | null; remainingCents: number }): GoalExecutionPolicy {
  return target.daysLeft !== null && target.remainingCents > 0 ? 'SQUEEZE' : 'EVIDENCE_FIRST';
}

/**
 * The links of a plan's chain that a SQUEEZE goal learns by selling. Asking
 * buyers is how a reply rate, a close rate, buyers' willingness to pay the
 * offered price and repeat volume are measured, so none of them is researched
 * first or required before an offer goes out.
 */
export const LEARNED_BY_SELLING = ['CONVERSION', 'MARKET_VOLUME'] as const;

/** At most this many openings are sold at once for one goal (each still inside the money limits). */
export const MAX_CONCURRENT_SALES = 6;

/**
 * What an opening must answer before a SQUEEZE goal sells it: what a
 * commercially responsible offer needs and selling cannot tell us — who pays,
 * what we offer, how we reach them, that it can be delivered and by whom,
 * that nothing rules us out, and what it costs us and ties up (the money
 * limits). Revenue range, time to cash, labour, phone dependence and the deep
 * dive's confidence and recommendation are learned from the sale itself.
 * Keys are the qualification keys of `cash/tier.ts`.
 */
export const SQUEEZE_QUALIFICATION = [
  'payer',
  'offer',
  'access',
  'delivery',
  'fulfillment',
  'directCosts',
  'requiredCapital',
  'eligibility',
  'disqualifiers',
] as const;
