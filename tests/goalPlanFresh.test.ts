/**
 * CAPABILITY:GOAL_PLAN.GOAL.PLAN_FRESH — "goal tick stopped", "every pass busy".
 *
 * Every live goal's plan must have a run within the last two hours. Production
 * read 2 of 20. The plan pass (`advanceGoalPlans`) walked goals in row order,
 * read at most `maxReads` (one under database pressure) and stopped reading at
 * the first busy scenario slot, so the same front goals took the slot every
 * pass and the tail starved; and a ruled-out goal (NOT_SUPPORTED) with
 * unchanged inputs skipped its refresh with no upper bound on age.
 *
 * These tests drive the pass's own decisions — `orderGoalsForPlanPass`,
 * `planDue` and `skipRuledOutRefresh` — across simulated passes in which the
 * slot serves one read, which is the recorded failure class.
 */
import { describe, expect, it } from 'vitest';
import { orderGoalsForPlanPass, planDue, PLAN_REFRESH_MS, PLAN_STALE_MAX_MS, skipRuledOutRefresh } from '../server/services/goals/plan.ts';

const MINUTE = 60_000;
const TWO_HOURS = 120 * MINUTE;

interface Goal {
  id: string;
  since: number;
  ruledOut: boolean;
}

/**
 * Run `passes` plan passes `every` ms apart in which the scenario slot serves
 * exactly one read (the throttled pass, or a slot busy after one read). The
 * order function decides who is offered the slot. Returns the oldest plan age
 * any goal reached after the warm-up, and how often each goal was read.
 */
function simulate(goals: Goal[], order: (gs: Goal[]) => Goal[], passes: number, every: number, warmUp: number): { worstAge: number; reads: Map<string, number> } {
  const reads = new Map(goals.map((g) => [g.id, 0]));
  let worstAge = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const now = pass * every;
    let served = false;
    for (const goal of order(goals)) {
      if (served) break;
      let due = planDue({ now, since: goal.since, inputs: null, lastInputs: undefined });
      if (due === 'REFRESH' && skipRuledOutRefresh({ now, since: goal.since, ruledOut: goal.ruledOut, inputsUnchanged: true })) due = null;
      if (!due) continue;
      goal.since = now;
      reads.set(goal.id, reads.get(goal.id)! + 1);
      served = true;
    }
    if (now >= warmUp) for (const goal of goals) worstAge = Math.max(worstAge, now - goal.since);
  }
  return { worstAge, reads };
}

function fleet(n: number): Goal[] {
  // Row order as the database returns it; every goal read once, long ago, in that order.
  return Array.from({ length: n }, (_, i) => ({ id: `ws_${String(i).padStart(2, '0')}`, since: 1 + i, ruledOut: false }));
}

describe('GOAL.PLAN_FRESH: every live goal is read within two hours', () => {
  it('reproduces the failure: in row order, with one read per pass, goals that keep coming due starve the tail', () => {
    // A pass every two minutes, one read each, twenty goals: the front goals
    // come due again on the half hour before the tail is reached, and row order
    // hands them the slot first every time.
    const goals = fleet(20);
    const rowOrder = (gs: Goal[]) => gs;
    const { worstAge, reads } = simulate(goals, rowOrder, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeGreaterThanOrEqual(TWO_HOURS);
    expect(reads.get('ws_19')).toBe(0);
  });

  it('stalest first, the same passes read every goal and none reaches two hours', () => {
    const goals = fleet(20);
    const { worstAge, reads } = simulate(goals, orderGoalsForPlanPass, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeLessThan(TWO_HOURS);
    for (const [, n] of reads) expect(n).toBeGreaterThan(0);
  });

  it('orders never-read goals first, then the oldest read, ties by id', () => {
    const ordered = orderGoalsForPlanPass([
      { id: 'b', since: 500 },
      { id: 'c', since: 0 },
      { id: 'a', since: 500 },
      { id: 'd', since: 100 },
    ]);
    expect(ordered.map((g) => g.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('a ruled-out goal with unchanged inputs skips the half-hour refresh, but never past PLAN_STALE_MAX_MS', () => {
    expect(PLAN_STALE_MAX_MS).toBeLessThan(TWO_HOURS);
    expect(PLAN_STALE_MAX_MS).toBeGreaterThan(PLAN_REFRESH_MS);
    const since = 1_000_000;
    // Inside the bound: skipped, as before.
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: true, inputsUnchanged: true })).toBe(true);
    // At the bound: read, so the goal never goes stale.
    expect(skipRuledOutRefresh({ now: since + PLAN_STALE_MAX_MS, since, ruledOut: true, inputsUnchanged: true })).toBe(false);
    // Not ruled out, or inputs moved: never skipped.
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: false, inputsUnchanged: true })).toBe(false);
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: true, inputsUnchanged: false })).toBe(false);
  });

  it('a fleet of ruled-out goals is still read within two hours', () => {
    const goals = fleet(20).map((g) => ({ ...g, ruledOut: true }));
    const { worstAge } = simulate(goals, orderGoalsForPlanPass, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeLessThan(TWO_HOURS);
  });
});
