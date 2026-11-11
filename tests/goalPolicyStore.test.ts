/**
 * A goal's policy reaches production through a row, not through a test passing
 * `kind` by hand. `goal_policies` stores the decision (written on a terminal by
 * `npm run goals -- policy`), and `readGoalPolicy` is how the plan reads it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { currentGoalPolicy, goalPolicyHistory, setGoalPolicy } from '../server/repos/economy.ts';
import { gateRecommendation, policySentence, readGoalPolicy } from '../server/services/goals/policy.ts';
import type { GoalTarget } from '../server/domain/register.ts';

let projectId = '';
let userId = '';
let goalId = '';

const target = (p: string): GoalTarget => ({
  metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId: p,
  capitalCeilingCents: 50_000, hoursCeiling: null, resources: null,
  capitalBeforeProofCents: 20_000, capitalPerWeekCents: 10_000, setAt: '2026-10-01T00:00:00.000Z',
});

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `gp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'gp', password: 'correct horse battery staple' })).id;
  goalId = (await createWorkstream({ projectId, title: 'Build a studio', intent: 'Build a long-term studio', purpose: 'REVENUE_DIRECT', createdByUserId: userId })).id;
});

describe('a stored goal policy', () => {
  it('a goal nobody gave a policy reads as SQUEEZE and says it was not set', async () => {
    const stored = await readGoalPolicy({ id: goalId, target: target(projectId), daysLeft: 30 });
    expect(stored.record).toBeNull();
    expect(stored.policy.kind).toBe('SQUEEZE');
    expect(stored.policy.reliability).toEqual({ normal: 0.9, adverse: 0.8 });
    expect(policySentence(stored)).toMatch(/not set/);
  });

  it('a long-term or creative goal reaches its own policy from the row and is not held to squeeze rules', async () => {
    for (const kind of ['LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME'] as const) {
      await setGoalPolicy({ goalId, kind, reason: 'owner said so', setByUserId: userId });
      const stored = await readGoalPolicy({ id: goalId, target: target(projectId), daysLeft: 3 });
      expect(stored.record?.kind).toBe(kind);
      expect(stored.policy).toMatchObject({ kind, judgedOnTarget: false, target: null, deadlineDays: null, reliability: null });
      const gate = gateRecommendation({ policy: stored.policy, probability: { measured: null, modelled: null }, combinedSetbacks: [] });
      expect(gate).toMatchObject({ notSqueeze: true, recommendable: true, reasons: [], policy: kind });
      expect(policySentence(stored)).toMatch(/not held to squeeze rules/);
    }
  });

  it('a SQUEEZE goal keeps its own reliability standard, read back from the row', async () => {
    await setGoalPolicy({ goalId, kind: 'SQUEEZE', reliabilityNormal: 0.95, reliabilityAdverse: 0.85, setByUserId: userId });
    const stored = await readGoalPolicy({ id: goalId, target: target(projectId), daysLeft: 30 });
    expect(stored.policy.reliability).toEqual({ normal: 0.95, adverse: 0.85 });
    const gate = gateRecommendation({
      policy: stored.policy,
      probability: { measured: { lowerBound: 0.92, sampleSize: 20 }, modelled: null },
      combinedSetbacks: [{ setbacks: ['a', 'b'], goalMet: true }],
      adverseShare: { lowerBound: 0.9 },
    });
    expect(gate.recommendable).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/95%/);
  });

  it('is append-only: a change is a new row and the earlier one stays as history', async () => {
    await setGoalPolicy({ goalId, kind: 'SQUEEZE', setByUserId: userId });
    await setGoalPolicy({ goalId, kind: 'CREATIVE', setByUserId: userId });
    expect((await currentGoalPolicy(goalId))?.kind).toBe('CREATIVE');
    expect((await goalPolicyHistory(goalId)).map((r) => r.kind)).toEqual(['SQUEEZE', 'CREATIVE']);
  });

  it('refuses nonsense in the writer and in the database', async () => {
    await expect(setGoalPolicy({ goalId, kind: 'CREATIVE', reliabilityNormal: 0.9 })).rejects.toThrow(/only SQUEEZE/);
    await expect(setGoalPolicy({ goalId, kind: 'SQUEEZE', reliabilityNormal: 0.7, reliabilityAdverse: 0.9 })).rejects.toThrow(/adverse/);
    await expect(setGoalPolicy({ goalId, kind: 'SQUEEZE', reliabilityNormal: 1.5 })).rejects.toThrow(/share/);
    await expect(setGoalPolicy({ goalId, kind: 'WHATEVER' as never })).rejects.toThrow(/one of/);
    await expect(getDb().run(
      `INSERT INTO goal_policies (id, goal_id, kind, created_at) VALUES ('gpl_x', ?, 'WHATEVER', 'now')`, [goalId])).rejects.toThrow();
    await expect(getDb().run(
      `INSERT INTO goal_policies (id, goal_id, kind, reliability_normal, created_at) VALUES ('gpl_y', ?, 'CREATIVE', 0.9, 'now')`, [goalId])).rejects.toThrow();
  });
});
