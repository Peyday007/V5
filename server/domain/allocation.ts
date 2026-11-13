/**
 * Where the next unit of capacity is worth the most (§108).
 *
 * Every live goal is an activity competing for the same pools — model and GPU
 * capacity, research slots, the Factory line, outreach. Each is read from its
 * rows (never assumed): what is at stake, how far its evidence has climbed,
 * how soon it can pay, what it consumed recently and what that bought, and
 * how much an answer would change its plan. From those, one number: the
 * marginal value of the next unit of capacity, in dollars per unit, with its
 * reasoning in words. The recommendation follows from it — EXPAND, HOLD,
 * REDUCE, PAUSE — and the shares are proportional to marginal value, not equal.
 *
 * Nothing caps the number of activities, and nothing forces concentration:
 * a single activity takes everything only when the others' marginal values are
 * near zero. A paused activity keeps its rows and is reconsidered every run, so
 * it can be restarted when its reading improves.
 *
 * Pure. Unknowns are never read as favourable (invariant 39): an unknown stake
 * contributes nothing until research states it — it earns capacity only
 * through the value of the information that would state it.
 */

export interface Activity {
  id: string;
  title: string;
  /** Dollars the activity can still bring in (remaining target, or an opening's stated value); null when nobody stated it. */
  stakeUsd: number | null;
  /** Probability-like reach of its best plan, 0..1; null when unread. Coverage is not a probability, and is passed as such. */
  reach: number | null;
  reachIsProbability: boolean;
  /** Evidence ladder: 0 theoretical … 5 collected. */
  evidenceLevel: number;
  /** Days until it can produce usable cash; null when unknown. */
  daysToCash: number | null;
  daysLeft: number | null;
  /** Capacity units it consumed in the window (research jobs, model calls, Factory runs). */
  unitsUsed: number;
  /** What those units bought: accepted claims, openings, plan movement — counted, not judged. */
  unitsProductive: number;
  /** Change in reach over the window; null when there is no earlier reading. */
  reachDelta: number | null;
  /** Could more capacity be used at all right now (work is executable, not waiting on a person). */
  executable: boolean;
  /** Owed to a customer or committed internally: never recommended for PAUSE. */
  committed: boolean;
  paused: boolean;
}

export type Stance = 'EXPAND' | 'HOLD' | 'REDUCE' | 'PAUSE' | 'RESTART';

export interface Allocation {
  id: string;
  title: string;
  marginalUsdPerUnit: number;
  /** The part of it that is the value of reducing uncertainty, not of expected cash. */
  informationUsdPerUnit: number;
  share: number;
  stance: Stance;
  why: string;
}

/** Productivity of recent capacity, smoothed so one quiet window is not a verdict. */
function yieldRate(a: Activity): number {
  return (a.unitsProductive + 1) / (a.unitsUsed + 2);
}

export function marginalValue(a: Activity): { expected: number; information: number; why: string[] } {
  const why: string[] = [];
  const stake = a.stakeUsd ?? 0;
  if (a.stakeUsd === null) why.push('stake not stated');
  // Urgency: cash that cannot arrive before the deadline is worth nothing to this goal.
  const late = a.daysToCash !== null && a.daysLeft !== null && a.daysToCash > a.daysLeft;
  if (late) why.push(`cash takes ${a.daysToCash}d and only ${a.daysLeft}d are left`);
  const urgency = a.daysLeft === null ? 0.5 : late ? 0 : Math.min(1, 14 / Math.max(1, a.daysLeft) + 0.25);
  // Expected cash per unit: the stake, at the reach its plan shows, times what recent units actually bought.
  const reach = a.reach ?? 0;
  const expected = stake * reach * yieldRate(a) * urgency * (a.executable ? 1 : 0) / 10;
  if (a.reach !== null) why.push(`reach ${(reach * 100).toFixed(1)}%${a.reachIsProbability ? '' : ' (coverage, not probability)'}`);
  why.push(`recent yield ${a.unitsProductive}/${a.unitsUsed}`);
  // Information: an answer is worth most where the stake is large and the evidence low —
  // the plan could change most. It decays as evidence climbs and as answers stop arriving.
  const uncertainty = Math.max(0, 1 - a.evidenceLevel / 5) * (a.reachIsProbability ? 1 - Math.abs(2 * reach - 1) : 1);
  const information = stake * uncertainty * yieldRate(a) * urgency * (a.executable ? 1 : 0) / 40;
  if (!a.executable) why.push('no executable work (waiting on a person or a dependency)');
  if (a.reachDelta !== null && a.reachDelta !== 0) why.push(`reach moved ${(a.reachDelta * 100).toFixed(1)} pts`);
  return { expected, information, why };
}

/** Allocate shares by marginal value; recommend a stance for each. */
export function allocate(activities: Activity[]): Allocation[] {
  const scored = activities.map((a) => {
    const m = marginalValue(a);
    return { a, value: m.expected + m.information, information: m.information, why: m.why };
  });
  const total = scored.reduce((s, x) => s + x.value, 0);
  const top = Math.max(0, ...scored.map((x) => x.value));
  return scored
    .map(({ a, value, information, why }) => {
      let stance: Stance;
      if (a.paused) stance = value > 0 && value >= top * 0.25 ? 'RESTART' : 'HOLD';
      else if (value <= 0 || (a.unitsUsed >= 20 && a.unitsProductive === 0 && (a.reachDelta ?? 0) <= 0)) stance = a.committed ? 'REDUCE' : 'PAUSE';
      else if (value >= top * 0.6) stance = 'EXPAND';
      else if (value >= top * 0.2) stance = 'HOLD';
      else stance = 'REDUCE';
      return {
        id: a.id,
        title: a.title.slice(0, 120),
        marginalUsdPerUnit: Math.round(value * 100) / 100,
        informationUsdPerUnit: Math.round(information * 100) / 100,
        share: total > 0 && !a.paused ? value / total : 0,
        stance,
        why: why.join('; '),
      };
    })
    .sort((x, y) => y.marginalUsdPerUnit - x.marginalUsdPerUnit);
}
