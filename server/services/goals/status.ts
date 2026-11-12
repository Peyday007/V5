/**
 * Whether each cash goal is met — the second of the two statuses Release 01
 * requires (R01-C), kept apart from architecture coverage.
 *
 * Achievement is read from the ledger by `readTarget` and nothing else: a
 * shipped release, a verified requirement, a candidate plan or a forecast never
 * counts toward it. The plan verdict beside it is the goal's latest reading
 * under its own acceptance policy (§95), reported, not added.
 */
import { listWorkstreams } from '../../repos/register.ts';
import { latestReading } from './plan.ts';
import { readTarget } from './target.ts';

export interface CashGoalStatus {
  goalId: string;
  title: string;
  metric: string;
  achieved: boolean;
  achievedCents: number;
  targetCents: number;
  achievedLabel: string;
  targetLabel: string;
  daysLeft: number | null;
  planVerdict: string | null;
}

const money = (cents: number, currency: string): string => `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;

export async function cashGoalStatuses(now: Date = new Date()): Promise<CashGoalStatus[]> {
  const out: CashGoalStatus[] = [];
  for (const goal of await listWorkstreams()) {
    const target = await readTarget(goal, now);
    if (!target) continue;
    out.push({
      goalId: goal.id,
      title: goal.title,
      metric: target.metricLabel,
      achieved: target.achieved,
      achievedCents: target.achievedCents,
      targetCents: target.targetCents,
      achievedLabel: money(target.achievedCents, target.currency),
      targetLabel: money(target.targetCents, target.currency),
      daysLeft: target.daysLeft,
      planVerdict: (await latestReading(goal.id))?.verdict ?? null,
    });
  }
  return out;
}
