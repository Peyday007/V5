import { describe, expect, it } from 'vitest';
import { orderResearchWork, type PriorityGoal, type ResearchWork } from '../server/services/economy/priority/order.ts';

const goal = (id: string, o: Partial<PriorityGoal> = {}): PriorityGoal =>
  ({ id, ownerUserId: 'u1', active: true, configuredRank: null, daysLeft: null, ...o });
const work = (id: string, goalId: string | null, o: Partial<ResearchWork> = {}): ResearchWork =>
  ({ id, ownerUserId: 'u1', goalId, createdAt: '2026-10-01T00:00:00.000Z', ...o });

describe('orderResearchWork', () => {
  it('dispatches active-goal work ahead of older unrelated long-term work', () => {
    const out = orderResearchWork('u1', [goal('g')], [
      work('old', null, { createdAt: '2026-01-01T00:00:00.000Z' }), work('new', 'g')]);
    expect(out.map((o) => o.work.id)).toEqual(['new', 'old']);
    expect(out[0]?.premium).toBe(true);
    expect(out[1]?.premium).toBe(false);
  });
  it('uses the configured rank, then nearer deadline, then age', () => {
    const goals = [goal('a', { configuredRank: 2, daysLeft: 1 }), goal('b', { configuredRank: 1, daysLeft: 20 }),
      goal('c', { configuredRank: 1, daysLeft: 5 })];
    const out = orderResearchWork('u1', goals, [work('wa', 'a'), work('wb', 'b'), work('wc', 'c')]);
    expect(out.map((o) => o.work.id)).toEqual(['wc', 'wb', 'wa']);
  });
  it('treats an inactive goal as background', () => {
    const out = orderResearchWork('u1', [goal('g', { active: false })], [work('w', 'g')]);
    expect(out[0]?.class).toBe('BACKGROUND');
  });
  it("ignores another user's goals and work", () => {
    const goals = [goal('theirs', { ownerUserId: 'u2', configuredRank: 0 }), goal('mine', { configuredRank: 5 })];
    const w = [work('x', 'theirs', { ownerUserId: 'u2' }), work('y', 'theirs'), work('z', 'mine')];
    const out = orderResearchWork('u1', goals, w);
    expect(out.map((o) => o.work.id)).toEqual(['z', 'y']);
    expect(out[1]?.class).toBe('BACKGROUND');
  });
  it('reserves no share: background runs when nothing active waits', () => {
    const out = orderResearchWork('u1', [], [work('w', null)]);
    expect(out).toHaveLength(1);
  });
});
