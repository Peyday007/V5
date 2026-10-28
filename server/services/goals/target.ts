/**
 * A goal's measurable target, and how far the real ledger has got toward it.
 *
 * A rough goal — "collect $10,000 in 30 days with almost no money" — becomes
 * four numbers a person stated: the figure, the amount, the currency and the
 * project whose ledger it is read from, plus the capital and hours a plan may
 * use. Nothing here is a forecast. Progress is read from `cash_money_entries`
 * on every call, counted from the moment the target was set, and the figure
 * counted is exactly the one named:
 *
 *   * `SETTLED_CASH` — money settled and usable, less refunds. A customer
 *     payment still with the provider is not settled, and an invoice, a quote
 *     or an agreement is not money at all; each is reported beside the figure
 *     as *not counted*, so a person can see it without it being added.
 *   * `COLLECTED_CASH` — verified customer payments, less refunds.
 *   * `CONTRIBUTION` — the one contribution formula over the same window.
 *
 * A targeted goal is complete when — and only when — this reading reaches the
 * target. Never because work reported itself done.
 */
import { getDb } from '../../db/database.ts';
import { totalsByKind } from '../../repos/cashLedger.ts';
import { getProject } from '../../repos/projects.ts';
import { contributionFrom } from '../cash/money.ts';
import { GOAL_METRICS, type GoalMetric, type GoalTarget, type Workstream } from '../../domain/register.ts';

export const GOAL_METRIC_LABEL: Record<GoalMetric, string> = {
  SETTLED_CASH: 'settled cash',
  COLLECTED_CASH: 'collected customer payments',
  CONTRIBUTION: 'contribution (payments less every incremental cost)',
};

export interface TargetReading {
  metric: GoalMetric;
  metricLabel: string;
  currency: string;
  projectId: string;
  targetCents: number;
  achievedCents: number;
  remainingCents: number;
  achieved: boolean;
  /** Days until the goal's own due date, or null when it has none. */
  daysLeft: number | null;
  /** Real money facts that are deliberately NOT counted toward the target. */
  notCounted: { label: string; cents: number }[];
  since: string;
  capitalCeilingCents: number | null;
  hoursCeiling: number | null;
  /** What the owner said they have to work with, in their words; null when nobody has said. */
  resources: string | null;
  capitalBeforeProofCents: number | null;
  capitalPerWeekCents: number | null;
  /** Whether a verified customer payment has arrived since the target was set. */
  proven: boolean;
}

const DAY = 86_400_000;

export async function readTarget(goal: Workstream, now: Date = new Date()): Promise<TargetReading | null> {
  const target = goal.target;
  if (!target) return null;
  const totals = await totalsByKind({ projectId: target.projectId, currency: target.currency, since: target.setAt });
  const t = (kind: string) => Number((totals as Record<string, number>)[kind] ?? 0);
  const refunds = t('REFUND');
  const payments = t('CUSTOMER_PAYMENT');
  const settled = t('SETTLEMENT');
  const unpaid = Math.max(0, t('UNPAID_COMMITMENT') - t('COMMITMENT_PAID') - t('COMMITMENT_RELEASED'));
  const achieved =
    target.metric === 'SETTLED_CASH'
      ? settled - refunds
      : target.metric === 'COLLECTED_CASH'
        ? payments - refunds
        : contributionFrom({ payments, refunds, costs: t('COST'), unpaidCommitments: unpaid });
  const pipeline = Math.max(0, t('PIPELINE_AGREED') - t('PIPELINE_RELEASED'));
  const notCounted = [
    { label: 'agreed but not paid (pipeline)', cents: pipeline },
    ...(target.metric === 'SETTLED_CASH' ? [{ label: 'paid but not yet settled', cents: Math.max(0, payments - settled) }] : []),
  ].filter((one) => one.cents > 0);
  return {
    metric: target.metric,
    metricLabel: GOAL_METRIC_LABEL[target.metric],
    currency: target.currency,
    projectId: target.projectId,
    targetCents: target.amountCents,
    achievedCents: achieved,
    remainingCents: Math.max(0, target.amountCents - achieved),
    achieved: achieved >= target.amountCents,
    daysLeft: goal.dueAt ? Math.ceil((Date.parse(goal.dueAt) - now.getTime()) / DAY) : null,
    notCounted,
    since: target.setAt,
    capitalCeilingCents: target.capitalCeilingCents,
    hoursCeiling: target.hoursCeiling,
    resources: target.resources,
    capitalBeforeProofCents: target.capitalBeforeProofCents,
    capitalPerWeekCents: target.capitalPerWeekCents,
    proven: payments - refunds > 0,
  };
}

export type SetTargetResult = { ok: true; target: GoalTarget } | { ok: false; reason: string };

/**
 * Record a person's target on a goal. Refuses what it cannot count honestly:
 * an unknown figure, a non-positive amount, a project with no ledger, or a
 * currency the sprint is not in. Re-setting restarts the count from now and is
 * recorded, so moving the target is visible rather than silent.
 */
export async function setTarget(input: {
  goal: Workstream;
  metric: string;
  amountCents: number;
  currency: string;
  projectId: string;
  capitalCeilingCents?: number | null;
  hoursCeiling?: number | null;
  /** People, equipment, relationships, licences — what the owner has. Never permission to spend. */
  resources?: string | null;
  /** At most this much tied up before any money comes in. */
  capitalBeforeProofCents?: number | null;
  /** At most this much newly tied up in any seven days. */
  capitalPerWeekCents?: number | null;
  now?: Date;
}): Promise<SetTargetResult> {
  if (!(GOAL_METRICS as readonly string[]).includes(input.metric)) {
    return { ok: false, reason: `The figure must be one of ${GOAL_METRICS.join(', ')}.` };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return { ok: false, reason: 'The amount must be a positive whole number of cents.' };
  if (!/^[A-Z]{3}$/.test(input.currency)) return { ok: false, reason: 'The currency must be a three-letter code.' };
  if (!(await getProject(input.projectId))) return { ok: false, reason: 'No project with that id.' };
  for (const [name, value] of [['capital', input.capitalCeilingCents], ['hours', input.hoursCeiling], ['before-proof', input.capitalBeforeProofCents], ['per-week', input.capitalPerWeekCents]] as const) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) return { ok: false, reason: `The ${name} ceiling must be a whole number, zero or more.` };
  }
  const resources = input.resources?.trim() ? input.resources.trim().slice(0, 2000) : null;
  const at = (input.now ?? new Date()).toISOString();
  await getDb().run(
    `UPDATE workstreams SET target_metric = ?, target_amount_cents = ?, target_currency = ?, target_project_id = ?,
            capital_ceiling_cents = ?, hours_ceiling = ?, target_resources = ?,
            target_capital_before_proof_cents = ?, target_capital_per_week_cents = ?, target_set_at = ?, updated_at = ? WHERE id = ?`,
    [input.metric, input.amountCents, input.currency, input.projectId, input.capitalCeilingCents ?? null, input.hoursCeiling ?? null, resources, input.capitalBeforeProofCents ?? null, input.capitalPerWeekCents ?? null, at, at, input.goal.id],
  );
  return {
    ok: true,
    target: {
      metric: input.metric as GoalMetric,
      amountCents: input.amountCents,
      currency: input.currency,
      projectId: input.projectId,
      capitalCeilingCents: input.capitalCeilingCents ?? null,
      hoursCeiling: input.hoursCeiling ?? null,
      resources,
      capitalBeforeProofCents: input.capitalBeforeProofCents ?? null,
      capitalPerWeekCents: input.capitalPerWeekCents ?? null,
      setAt: at,
    },
  };
}
