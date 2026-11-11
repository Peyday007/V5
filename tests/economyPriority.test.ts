import { describe, expect, it } from 'vitest';
import { orderResearch } from '../server/services/economy/priority/index.ts';
import type { GoalSetting, ResearchDemand } from '../server/services/economy/priority/index.ts';
import {
  orderResearch as goalsOrderResearch,
  rankGoals,
} from '../server/services/goals/priority.ts';
import { binPriorityForRank } from '../server/domain/goals.ts';

const goal = (o: Partial<GoalSetting> & { id: string; ownerKey: string }): GoalSetting => ({
  workable: true,
  commitment: 'NONE',
  dueAt: null,
  purpose: 'REVENUE_DIRECT',
  dependents: 0,
  createdAt: '2026-01-01T00:00:00Z',
  ...o,
});
const demand = (id: string, ownerKey: string, goalId: string | null, createdAt = '2026-01-01T00:00:00Z'): ResearchDemand =>
  ({ id, ownerKey, goalId, createdAt });

describe('economy priority ordering', () => {
  it('is the goal ranking owner, not a second ordering mechanism', () => {
    // The finding: economy/priority reimplemented rankGoals. It must now be the
    // very function goals/priority.ts exports, which dispatch's rank comes from.
    expect(orderResearch).toBe(goalsOrderResearch);
  });

  it('gives research exactly the bin priority dispatch gives its goal', () => {
    const goals = [
      goal({ id: 'g1', ownerKey: 'u1', commitment: 'CUSTOMER' }),
      goal({ id: 'g2', ownerKey: 'u1' }),
      goal({ id: 'g3', ownerKey: 'u1', purpose: 'LONG_TERM' }),
    ];
    const ranks = new Map(rankGoals(goals).map((r) => [r.id, r.rank]));
    const out = orderResearch([demand('d3', 'u1', 'g3'), demand('d1', 'u1', 'g1'), demand('d2', 'u1', 'g2')], goals);
    for (const o of out) expect(o.binPriority).toBe(binPriorityForRank(ranks.get(o.goalId!)!));
    expect(out.map((o) => o.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('dispatches active-goal research ahead of unrelated long-term research', () => {
    const out = orderResearch(
      [demand('far', 'u1', null, '2025-01-01T00:00:00Z'), demand('near', 'u1', 'g1')],
      [goal({ id: 'g1', ownerKey: 'u1' })],
    );
    expect(out.map((o) => o.id)).toEqual(['near', 'far']);
    expect(out[0]!.premium).toBe(true);
    expect(out[1]!.premium).toBe(false);
    expect(out[1]!.binPriority).toBeNull();
  });

  it('a paused goal is background work', () => {
    const out = orderResearch([demand('d', 'u1', 'g1')], [goal({ id: 'g1', ownerKey: 'u1', workable: false })]);
    expect(out[0]!.premium).toBe(false);
  });

  it("follows the owner's configured commitment, then deadline, then purpose; unset deadline sorts last", () => {
    const out = orderResearch(
      [demand('a', 'u1', 'ga'), demand('b', 'u1', 'gb'), demand('c', 'u1', 'gc'), demand('d', 'u1', 'gd')],
      [
        goal({ id: 'ga', ownerKey: 'u1', purpose: 'LONG_TERM' }),
        goal({ id: 'gb', ownerKey: 'u1', dueAt: '2026-03-01' }),
        goal({ id: 'gc', ownerKey: 'u1', commitment: 'CUSTOMER' }),
        goal({ id: 'gd', ownerKey: 'u1' }),
      ],
    );
    expect(out.map((o) => o.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it("another user's goals do not influence the ordering", () => {
    const mine = [demand('m1', 'u1', 'g1'), demand('m2', 'u1', 'g2')];
    const myGoals = [
      goal({ id: 'g1', ownerKey: 'u1' }),
      goal({ id: 'g2', ownerKey: 'u1', commitment: 'CUSTOMER' }),
    ];
    const alone = orderResearch(mine, myGoals).map((o) => o.id);
    const crowded = orderResearch(
      [...mine, demand('x1', 'u2', 'g1'), demand('x2', 'u2', 'gz')],
      [...myGoals, goal({ id: 'g1', ownerKey: 'u2', commitment: 'CUSTOMER', dueAt: '2020-01-01' })],
    );
    expect(crowded.filter((o) => o.ownerKey === 'u1').map((o) => o.id)).toEqual(alone);
    expect(crowded.filter((o) => o.ownerKey === 'u1').map((o) => o.rank)).toEqual([0, 1]);
  });

  it('a goal id belonging to another owner cannot lift a demand', () => {
    const out = orderResearch([demand('d', 'u1', 'g9')], [goal({ id: 'g9', ownerKey: 'u2' })]);
    expect(out[0]!.premium).toBe(false);
  });

  it('is deterministic and total', () => {
    const d = [demand('b', 'u1', null), demand('a', 'u1', null)];
    expect(orderResearch(d, []).map((o) => o.id)).toEqual(['a', 'b']);
    expect(orderResearch([...d].reverse(), []).map((o) => o.id)).toEqual(['a', 'b']);
  });
});
