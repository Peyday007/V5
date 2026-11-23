import { describe, expect, it } from 'vitest';
import { activityFrom } from '../server/services/operator/allocation.ts';

/** §116: capacity follows the reach a plan supports, never coverage over legs nobody can execute. */
describe('allocation reads the supported reach', () => {
  const goal = { id: 'wst_1', title: 'Collect $10,000', target: { amountCents: 1_000_000 }, dueAt: null, commitment: 'NONE', pausedAt: null } as never;
  it('uses the supported reach when the plan is assumption-only', () => {
    const a = activityFrom({ goal, latest: { forecast: { reach: 0.98, reachBasis: 'ASSUMPTION_ONLY', supportedReach: 0, remainingCents: 1_000_000, acceptance: { candidate: { reach: 0.98, reachBasis: 'COVERAGE' } } } } as never, before: null, jobs: 12, productive: 56, executable: true, nowMs: Date.now() });
    expect(a.reach).toBe(0);
  });
  it('keeps the reach when the plan is supported', () => {
    const a = activityFrom({ goal, latest: { forecast: { reach: 0.4, reachBasis: 'SUPPORTED', supportedReach: 0.4, remainingCents: 1_000_000 } } as never, before: null, jobs: 1, productive: 1, executable: true, nowMs: Date.now() });
    expect(a.reach).toBe(0.4);
  });
});
