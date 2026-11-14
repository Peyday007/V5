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
import { getWorkstream } from '../../repos/register.ts';
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
  /** The ledger entry kinds this reading adds up, read from the goal's own metric. */
  counted: string[];
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

/**
 * The one statement of what each metric adds up. `counted` and the arithmetic
 * are both derived from these rules, so the list a person reads cannot drift
 * from the figure they are shown. A term adds (`+1`) or subtracts (`-1`) the
 * ledger total of its kind; a `netOf` term is the amount still open — the kind's
 * total less the kinds that close it, never below zero — so an unpaid commitment
 * stops counting once it is paid (`COMMITMENT_PAID`, which brings its own `COST`)
 * or released (`COMMITMENT_RELEASED`). Anything not named here is never added.
 */
export interface MetricTerm {
  kind: string;
  sign: 1 | -1;
  netOf?: readonly string[];
}

export const METRIC_RULES: Record<GoalMetric, readonly MetricTerm[]> = {
  SETTLED_CASH: [
    { kind: 'SETTLEMENT', sign: 1 },
    { kind: 'REFUND', sign: -1 },
  ],
  COLLECTED_CASH: [
    { kind: 'CUSTOMER_PAYMENT', sign: 1 },
    { kind: 'REFUND', sign: -1 },
  ],
  // The same arithmetic as `contributionFrom` in cash/money.ts (payments − refunds − costs − unpaid commitments).
  CONTRIBUTION: [
    { kind: 'CUSTOMER_PAYMENT', sign: 1 },
    { kind: 'REFUND', sign: -1 },
    { kind: 'COST', sign: -1 },
    { kind: 'UNPAID_COMMITMENT', sign: -1, netOf: ['COMMITMENT_PAID', 'COMMITMENT_RELEASED'] },
  ],
};

/** The ledger kinds a metric reads, as a person sees them: `-` is taken off, `+` added back by a closing entry. */
export function countedKinds(metric: GoalMetric): string[] {
  return METRIC_RULES[metric].flatMap((term) => [
    `${term.sign < 0 ? '-' : ''}${term.kind}`,
    ...(term.netOf ?? []).map((closing) => `${term.sign < 0 ? '+' : '-'}${closing}`),
  ]);
}

/** Evaluate a metric over ledger totals by kind. */
export function achievedFrom(metric: GoalMetric, totals: Record<string, number>): number {
  const t = (kind: string) => Number(totals[kind] ?? 0);
  return METRIC_RULES[metric].reduce((sum, term) => {
    const amount = term.netOf ? Math.max(0, t(term.kind) - term.netOf.reduce((open, closing) => open + t(closing), 0)) : t(term.kind);
    return sum + term.sign * amount;
  }, 0);
}

export async function readTarget(goal: Workstream, now: Date = new Date()): Promise<TargetReading | null> {
  const target = goal.target;
  if (!target) return null;
  const totals = await totalsByKind({ projectId: target.projectId, currency: target.currency, since: target.setAt });
  const t = (kind: string) => Number((totals as Record<string, number>)[kind] ?? 0);
  const refunds = t('REFUND');
  const payments = t('CUSTOMER_PAYMENT');
  const settled = t('SETTLEMENT');
  const achieved = achievedFrom(target.metric, totals as Record<string, number>);
  const pipeline = Math.max(0, t('PIPELINE_AGREED') - t('PIPELINE_RELEASED'));
  // What the reading says it counts decides what it reports as left out: a customer
  // payment is "not yet settled" only when the metric counts settlements and not payments.
  const counted = countedKinds(target.metric);
  const countsPayments = counted.includes('CUSTOMER_PAYMENT');
  const countsSettlements = counted.includes('SETTLEMENT');
  const notCounted = [
    { label: 'agreed but not paid (pipeline)', cents: pipeline },
    ...(!countsPayments && countsSettlements ? [{ label: 'paid but not yet settled', cents: Math.max(0, payments - settled) }] : []),
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
    counted,
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
 * The live targeted goal already counting the same figure on this project's
 * ledger in this currency, other than `exceptGoalId` (G-7). Progress is the
 * ledger total since the target was set, so two live targets of one metric on
 * one project and currency would both count the same dollars; the second one
 * is refused instead. Two goals reading different figures of one ledger
 * (settled cash and collected cash, GOAL-02) measure different things and
 * stay allowed.
 */
export async function liveTargetOn(projectId: string, currency: string, exceptGoalId: string | null, metric: string): Promise<{ id: string; title: string } | null> {
  const row = await getDb().get<{ id: string; title: string }>(
    `SELECT id, title FROM workstreams
      WHERE target_project_id = ? AND target_currency = ? AND target_metric = ? AND target_set_at IS NOT NULL
        AND archived_at IS NULL AND cancelled_at IS NULL AND id <> ?
      ORDER BY created_at, id LIMIT 1`,
    [projectId, currency, metric, exceptGoalId ?? ''],
  );
  return row ?? null;
}

export function sharedLedgerReason(other: { id: string; title: string }, currency: string): string {
  return `Goal ${other.id} ("${other.title.slice(0, 80)}") already counts this figure on this project's ${currency} ledger; two live targets of one figure on one ledger would both count the same money. Cancel or archive it, or use another project.`;
}

interface TargetLimits {
  capitalCeilingCents?: number | null;
  hoursCeiling?: number | null;
  capitalBeforeProofCents?: number | null;
  capitalPerWeekCents?: number | null;
}

function badLimit(input: TargetLimits): string | null {
  for (const [name, value] of [['capital', input.capitalCeilingCents], ['hours', input.hoursCeiling], ['before-proof', input.capitalBeforeProofCents], ['per-week', input.capitalPerWeekCents]] as const) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) return `The ${name} ceiling must be a whole number, zero or more.`;
  }
  return null;
}

/**
 * Record a person's target on a goal. Refuses what it cannot count honestly:
 * an unknown figure, a non-positive amount, a project with no ledger, a
 * currency the sprint is not in, or a ledger another live goal already counts
 * (G-7). Moving the figure, the amount, the currency or the project restarts
 * the count from now and is recorded, so moving the target is visible rather
 * than silent; re-setting the same target with other limits keeps the count
 * (G-5) — `setTargetLimits` is the writer for limits alone.
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
  const bad = badLimit(input);
  if (bad) return { ok: false, reason: bad };
  const other = await liveTargetOn(input.projectId, input.currency, input.goal.id, input.metric);
  if (other) return { ok: false, reason: sharedLedgerReason(other, input.currency) };
  const resources = input.resources?.trim() ? input.resources.trim().slice(0, 2000) : null;
  const now = (input.now ?? new Date()).toISOString();
  // The count restarts only when what is counted moves; the row, not the caller's copy, says what it was.
  const before = (await getWorkstream(input.goal.id))?.target ?? null;
  const same = before !== null && before.metric === input.metric && before.amountCents === input.amountCents && before.currency === input.currency && before.projectId === input.projectId;
  const at = same ? before.setAt : now;
  await getDb().run(
    `UPDATE workstreams SET target_metric = ?, target_amount_cents = ?, target_currency = ?, target_project_id = ?,
            capital_ceiling_cents = ?, hours_ceiling = ?, target_resources = ?,
            target_capital_before_proof_cents = ?, target_capital_per_week_cents = ?, target_set_at = ?, updated_at = ? WHERE id = ?`,
    [input.metric, input.amountCents, input.currency, input.projectId, input.capitalCeilingCents ?? null, input.hoursCeiling ?? null, resources, input.capitalBeforeProofCents ?? null, input.capitalPerWeekCents ?? null, at, now, input.goal.id],
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

/**
 * Change only what a targeted goal may use — capital, hours, the before-proof
 * and per-week limits, and the resources — never what it counts or since when
 * (G-5). A limit left out is kept; `null` clears it. `updated_at` moves, so the
 * plan's fingerprint reads the goal again.
 */
export async function setTargetLimits(input: TargetLimits & { goal: Workstream; resources?: string | null; now?: Date }): Promise<SetTargetResult> {
  const current = (await getWorkstream(input.goal.id))?.target ?? null;
  if (!current) return { ok: false, reason: 'The goal has no target; set one first.' };
  const bad = badLimit(input);
  if (bad) return { ok: false, reason: bad };
  const keep = <T>(value: T | undefined, kept: T): T => (value === undefined ? kept : value);
  const next: GoalTarget = {
    ...current,
    capitalCeilingCents: keep(input.capitalCeilingCents, current.capitalCeilingCents),
    hoursCeiling: keep(input.hoursCeiling, current.hoursCeiling),
    capitalBeforeProofCents: keep(input.capitalBeforeProofCents, current.capitalBeforeProofCents),
    capitalPerWeekCents: keep(input.capitalPerWeekCents, current.capitalPerWeekCents),
    resources: input.resources === undefined ? current.resources : input.resources?.trim() ? input.resources.trim().slice(0, 2000) : null,
  };
  await getDb().run(
    `UPDATE workstreams SET capital_ceiling_cents = ?, hours_ceiling = ?, target_resources = ?,
            target_capital_before_proof_cents = ?, target_capital_per_week_cents = ?, updated_at = ? WHERE id = ?`,
    [next.capitalCeilingCents, next.hoursCeiling, next.resources, next.capitalBeforeProofCents, next.capitalPerWeekCents, (input.now ?? new Date()).toISOString(), input.goal.id],
  );
  return { ok: true, target: next };
}
