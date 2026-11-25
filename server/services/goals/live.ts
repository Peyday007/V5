/**
 * Which goals are live: the one definition the plan pass and the freshness
 * probe both read (CAPABILITY:GOAL_PLAN.GOAL.PLAN_FRESH, review F2).
 *
 * A live goal has a target and is neither archived, cancelled nor paused. The
 * plan pass (`advanceGoalPlans`) owns that word: a paused goal keeps its outcome
 * on the record and spends nothing — no re-read, no search round — so a probe
 * that counted it would read it stale forever and the 100% bar could never be
 * met. The probe narrows further to goals not yet past due; it never widens.
 */
export const LIVE_GOAL_SQL = 'target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL';

/** The same predicate over a row the pass already holds. Pure. */
export function isLiveGoal(row: { paused_at: string | null }): boolean {
  return !row.paused_at;
}
