/**
 * Production probe for GOAL-02: a goal keeps its own metric and deadline, and a
 * collected- or settled-cash goal is met only by collected or settled cash.
 *
 * For every live targeted goal it reads the target through `readTarget` (the one
 * reader every screen and the plan use) and checks that reading against the
 * ledger rows counted a second, independent way:
 *  - the reading carries the goal's own metric, amount and deadline;
 *  - SETTLED_CASH is settlements less refunds, COLLECTED_CASH is customer payments
 *    less refunds, summed straight from `cash_money_entries` since the goal began
 *    in its currency — so an agreed sale, a quote, an invoice, a pipeline figure or
 *    anything else the ledger holds cannot move it, and `counted` names no such kind;
 *  - CONTRIBUTION equals the contribution arithmetic of `cash/money.ts`;
 *  - the reading says "achieved" exactly when its figure reaches the target.
 * With no live targeted goal the answer is a failure: nothing to look at is not a
 * demonstration (§39). Registered here because `probes.ts` is a protected path;
 * `target.ts` imports this module so it is registered wherever targets are read.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';
import type { TargetReading } from '../../../goals/target.ts';
import { goalConditionsHoldOnRows } from './goalConditionProbe.ts';

export const GOAL_METRIC_PROBE = 'r01.goal-02';

const DAY = 86_400_000;
/** Ledger kinds that are cash that happened. Anything else a metric names is a promise, a quote or a plan. */
const CASH_KINDS = new Set(['CUSTOMER_PAYMENT', 'SETTLEMENT', 'REFUND', 'COST', 'UNPAID_COMMITMENT', 'COMMITMENT_PAID', 'COMMITMENT_RELEASED']);

export interface GoalRow {
  id: string;
  target_metric: string;
  target_amount_cents: number | string;
  target_currency: string;
  target_project_id: string;
  target_set_at: string;
  due_at: string | null;
}

/** Why a reading contradicts its goal row and the raw ledger totals, or null. Pure. */
export function metricProblem(goal: GoalRow, reading: TargetReading, raw: Record<string, number>, contribution: number, now: Date): string | null {
  const amount = Number(goal.target_amount_cents);
  if (reading.metric !== goal.target_metric) return `reads metric ${reading.metric}, not the goal's ${goal.target_metric}`;
  if (reading.targetCents !== amount) return 'reads a different target amount than the goal states';
  if (reading.currency !== goal.target_currency) return 'reads a different currency than the goal states';
  const expectedDays = goal.due_at ? Math.ceil((Date.parse(goal.due_at) - now.getTime()) / DAY) : null;
  if (reading.daysLeft !== expectedDays) return 'does not carry the goal\'s own deadline';
  const t = (kind: string) => Number(raw[kind] ?? 0);
  const expected =
    goal.target_metric === 'SETTLED_CASH' ? t('SETTLEMENT') - t('REFUND')
    : goal.target_metric === 'COLLECTED_CASH' ? t('CUSTOMER_PAYMENT') - t('REFUND')
    : goal.target_metric === 'CONTRIBUTION' ? contribution
    : null;
  if (expected === null) return `names a metric (${goal.target_metric}) this check does not know`;
  if (reading.achievedCents !== expected) return `counts ${reading.achievedCents} cents where the ledger rows give ${expected}`;
  for (const kind of reading.counted) {
    const bare = kind.replace(/^[-+]/, '');
    if (!CASH_KINDS.has(bare)) return `counts ${bare}, which is not cash that happened`;
  }
  if (goal.target_metric !== 'CONTRIBUTION' && reading.counted.some((k) => k.replace(/^[-+]/, '') === 'COST')) return 'a cash goal subtracts costs';
  if (reading.achieved !== (reading.achievedCents >= amount)) return 'says achieved inconsistently with its own figure';
  return null;
}

export async function goalMetricsHoldOnRows(): Promise<ProbeResult> {
  const db = getDb();
  const { readTarget } = await import('../../../goals/target.ts');
  const { getWorkstream } = await import('../../../../repos/register.ts');
  const { contributionFrom } = await import('../../../cash/money.ts');
  const now = new Date();
  const goals = await db.all<GoalRow>(
    `SELECT id, target_metric, target_amount_cents, target_currency, target_project_id, target_set_at, due_at FROM workstreams
      WHERE target_metric IS NOT NULL AND target_amount_cents IS NOT NULL AND target_project_id IS NOT NULL
        AND target_currency IS NOT NULL AND target_set_at IS NOT NULL AND due_at IS NOT NULL AND due_at > ?
        AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL ORDER BY id`,
    [now.toISOString()],
  );
  if (goals.length === 0) return { ok: false, detail: 'no live goal carries a target and a deadline: no metric to read' };
  const shapes = new Set<string>();
  for (const goal of goals) {
    const ws = await getWorkstream(goal.id);
    const reading = ws ? await readTarget(ws, now) : null;
    if (!reading) return { ok: false, detail: `goal ${goal.id}: its target could not be read` };
    const rows = await db.all<{ kind: string; total: number }>(
      `SELECT kind, SUM(amount_cents) AS total FROM cash_money_entries
        WHERE project_id = ? AND currency = ? AND occurred_at >= ? GROUP BY kind`,
      [goal.target_project_id, goal.target_currency, goal.target_set_at],
    );
    const raw: Record<string, number> = {};
    for (const row of rows) raw[row.kind] = Number(row.total ?? 0);
    const r = (kind: string) => Number(raw[kind] ?? 0);
    const contribution = contributionFrom({
      payments: r('CUSTOMER_PAYMENT'),
      refunds: r('REFUND'),
      costs: r('COST'),
      unpaidCommitments: Math.max(0, r('UNPAID_COMMITMENT') - r('COMMITMENT_PAID') - r('COMMITMENT_RELEASED')),
    });
    const problem = metricProblem(goal, reading, raw, contribution, now);
    if (problem) return { ok: false, detail: `goal ${goal.id} ${problem}` };
    shapes.add(`${goal.target_metric}|${goal.due_at}`);
  }
  return {
    ok: true,
    detail: `${goals.length} live goal(s), ${shapes.size} distinct metric/deadline pair(s): each reading carries its goal's own metric, amount and deadline and equals the ledger rows counted independently; none counts a promise, quote or pipeline figure`,
  };
}

/**
 * The one `r01.goal-02` check: the settled-cash clauses of goalConditionProbe
 * (which needs a settled-cash goal to exist) and the ledger cross-check above,
 * the cross-check first. Both must hold; the first failure is the answer.
 */
export async function goalTwoHoldsOnRows(): Promise<ProbeResult> {
  const metrics = await goalMetricsHoldOnRows();
  if (!metrics.ok) return metrics;
  const conditions = await goalConditionsHoldOnRows();
  if (!conditions.ok) return conditions;
  return { ok: true, detail: `${metrics.detail}; ${conditions.detail}` };
}

// Registered by the protected probes module (§97); a campaign never registers its own judge.
