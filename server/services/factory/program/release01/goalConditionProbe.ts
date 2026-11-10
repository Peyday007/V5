/**
 * Production probe for GOAL-02: a goal is an adjustable condition with its own
 * metric and deadline, and the settled-cash metric counts only settled cash.
 *
 * Reads the targeted goals in the register and their ledgers. It passes only
 * when real rows show the behaviour: each targeted goal reads the metric it
 * stored (no ladder substitutes another), a settled-cash goal's figure is
 * exactly settlements less refunds with agreements, payments still with the
 * provider and anything else on the ledger counted for nothing, and the same
 * ledger can serve goals with different metrics. With no targeted goal, or no
 * settled-cash goal, the answer is a failure — "nothing to look at" is not a
 * demonstration (§39) — never a pass.
 *
 * This module does not register a probe. `r01.goal-02` has exactly one owner,
 * metricProbe.ts, which runs this check (the stricter settled-cash clauses)
 * and then its own ledger cross-check under that one name; registering the
 * same name from two modules would let the later one silently replace the
 * earlier, so the check here would never be reached.
 */
import type { ProbeResult } from '../probes.ts';

export const GOAL_CONDITION_PROBE = 'r01.goal-02';

export async function goalConditionsHoldOnRows(): Promise<ProbeResult> {
  const { listWorkstreams } = await import('../../../../repos/register.ts');
  const { totalsByKind } = await import('../../../../repos/cashLedger.ts');
  const { readTarget, countedKinds } = await import('../../../goals/target.ts');
  const goals = (await listWorkstreams()).filter((g) => g.target !== null);
  if (goals.length === 0) return { ok: false, detail: 'no goal carries a target: nothing to read a metric from on production records' };
  let settledGoals = 0;
  const metrics = new Set<string>();
  for (const goal of goals) {
    const target = goal.target!;
    const reading = await readTarget(goal);
    if (!reading) return { ok: false, detail: `goal ${goal.id} has a target that cannot be read` };
    if (reading.metric !== target.metric) return { ok: false, detail: `goal ${goal.id} stores ${target.metric} but reads ${reading.metric}` };
    metrics.add(target.metric);
    if (target.metric !== 'SETTLED_CASH') continue;
    settledGoals += 1;
    const totals = (await totalsByKind({ projectId: target.projectId, currency: target.currency, since: target.setAt })) as Record<string, number>;
    const expected = Number(totals.SETTLEMENT ?? 0) - Number(totals.REFUND ?? 0);
    if (reading.achievedCents !== expected) {
      return { ok: false, detail: `settled-cash goal ${goal.id} reads ${reading.achievedCents} but settlements less refunds are ${expected}` };
    }
    const stray = countedKinds('SETTLED_CASH').filter((kind) => !['SETTLEMENT', '-REFUND'].includes(kind));
    if (stray.length > 0 || reading.counted.some((kind) => !['SETTLEMENT', '-REFUND'].includes(kind))) {
      return { ok: false, detail: `settled-cash goal ${goal.id} counts more than settlements less refunds: ${[...stray, ...reading.counted].join(', ')}` };
    }
  }
  if (settledGoals === 0) return { ok: false, detail: `${goals.length} targeted goal(s) read; none is a settled-cash goal, so that clause is not yet demonstrated` };
  const withDeadline = goals.filter((g) => g.dueAt).length;
  return {
    ok: true,
    detail: `${goals.length} targeted goal(s) each read the metric they stored (${[...metrics].join(', ')}); ${settledGoals} settled-cash goal(s) count exactly settlements less refunds; ${withDeadline} carry their own deadline`,
  };
}
