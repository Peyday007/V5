import { describe, expect, it } from 'vitest';
import { orderResearch } from '../server/services/economy/priority/index.ts';
import type { GoalSetting, ResearchDemand } from '../server/services/economy/priority/index.ts';

const goal = (o: Partial<GoalSetting> & { goalId: string; ownerKey: string }): GoalSetting => ({
  active: true, userPriority: null, dueAt: null, createdAt: '2026-01-01T00:00:00Z', ...o,
});
const demand = (id: string, ownerKey: string, goalId: string | null, createdAt = '2026-01-01T00:00:00Z'): ResearchDemand =>
  ({ id, ownerKey, goalId, createdAt });

describe('economy priority ordering', () => {
  it('dispatches active-goal research ahead of unrelated long-term research', () => {
    const out = orderResearch(
      [demand('far', 'u1', null, '2025-01-01T00:00:00Z'), demand('near', 'u1', 'g1')],
      [goal({ goalId: 'g1', ownerKey: 'u1' })],
    );
    expect(out.map((o) => o.id)).toEqual(['near', 'far']);
    expect(out[0]!.premium).toBe(true);
    expect(out[1]!.premium).toBe(false);
  });

  it('a paused goal is background work', () => {
    const out = orderResearch([demand('d', 'u1', 'g1')], [goal({ goalId: 'g1', ownerKey: 'u1', active: false })]);
    expect(out[0]!.premium).toBe(false);
  });

  it('follows the owner configured priority, then deadline; unset sorts last', () => {
    const out = orderResearch(
      [demand('a', 'u1', 'ga'), demand('b', 'u1', 'gb'), demand('c', 'u1', 'gc')],
      [
        goal({ goalId: 'ga', ownerKey: 'u1', userPriority: null, dueAt: '2026-02-01' }),
        goal({ goalId: 'gb', ownerKey: 'u1', userPriority: 2 }),
        goal({ goalId: 'gc', ownerKey: 'u1', userPriority: 1 }),
      ],
    );
    expect(out.map((o) => o.id)).toEqual(['c', 'b', 'a']);
  });

  it("another user's goals do not influence the ordering", () => {
    const mine = [demand('m1', 'u1', 'g1'), demand('m2', 'u1', 'g2')];
    const myGoals = [
      goal({ goalId: 'g1', ownerKey: 'u1', userPriority: 2 }),
      goal({ goalId: 'g2', ownerKey: 'u1', userPriority: 1 }),
    ];
    const alone = orderResearch(mine, myGoals).map((o) => o.id);
    const crowded = orderResearch(
      [...mine, demand('x1', 'u2', 'g1'), demand('x2', 'u2', 'gz')],
      [...myGoals, goal({ goalId: 'g1', ownerKey: 'u2', userPriority: 0, dueAt: '2020-01-01' })],
    );
    expect(crowded.filter((o) => o.ownerKey === 'u1').map((o) => o.id)).toEqual(alone);
    expect(crowded.filter((o) => o.ownerKey === 'u1').map((o) => o.rank)).toEqual([0, 1]);
  });

  it('a goal id belonging to another owner cannot lift a demand', () => {
    const out = orderResearch([demand('d', 'u1', 'g9')], [goal({ goalId: 'g9', ownerKey: 'u2' })]);
    expect(out[0]!.premium).toBe(false);
  });

  it('is deterministic and total', () => {
    const d = [demand('b', 'u1', null), demand('a', 'u1', null)];
    expect(orderResearch(d, []).map((o) => o.id)).toEqual(['a', 'b']);
    expect(orderResearch([...d].reverse(), []).map((o) => o.id)).toEqual(['a', 'b']);
  });
});
