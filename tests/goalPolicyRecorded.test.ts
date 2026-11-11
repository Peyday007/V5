/**
 * F2: a goal's policy kind must be reachable in production. A goal record
 * carries it (`goal_policies`), `goalPolicy` reads it, and a long-term or
 * creative goal recorded as such is never held to squeeze rules — read from
 * the database, not passed in by the test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { gateRecommendation, goalPolicy, setGoalPolicy } from '../server/services/goals/policy.ts';
import type { GoalTarget } from '../server/domain/register.ts';

const target: GoalTarget = {
  metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId: 'p',
  capitalCeilingCents: 50_000, hoursCeiling: null, resources: null,
  capitalBeforeProofCents: 20_000, capitalPerWeekCents: 10_000, setAt: '2026-10-01T00:00:00.000Z',
};
const unsupported = { measured: null, modelled: null, sweepCoverage: 0.97 };

let goalId = '';
beforeEach(async () => {
  const projectId = (await freshProject()).project.id;
  goalId = (await createWorkstream({ projectId, title: 'Build a venture', intent: 'Build a venture', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
});

describe('a goal’s recorded policy', () => {
  it('is SQUEEZE with the default standard when nothing was recorded', async () => {
    const policy = await goalPolicy({ goalId, target, daysLeft: 30 });
    expect(policy.recorded).toBe(false);
    expect(policy.kind).toBe('SQUEEZE');
    expect(policy.reliability).toEqual({ normal: 0.9, adverse: 0.8 });
  });

  it('reaches a long-term or creative goal from its record, and squeeze rules do not apply', async () => {
    for (const kind of ['LONG_TERM_VENTURE', 'CREATIVE'] as const) {
      expect(await setGoalPolicy({ goalId, kind, setBy: 'person:test' })).toEqual({ ok: true, kind });
      const policy = await goalPolicy({ goalId, target, daysLeft: 30 });
      expect(policy).toMatchObject({ recorded: true, kind, judgedOnTarget: false, target: null, deadlineDays: null, reliability: null });
      const gate = gateRecommendation({ policy, probability: unsupported, combinedSetbacks: [] });
      expect(gate).toMatchObject({ notSqueeze: true, policy: kind, reasons: [] });
    }
  });

  it('the latest record wins, and a goal moved back to SQUEEZE is gated again with its own standard', async () => {
    await setGoalPolicy({ goalId, kind: 'RESEARCH', setBy: 'person:test' });
    await new Promise((r) => setTimeout(r, 5));
    await setGoalPolicy({ goalId, kind: 'SQUEEZE', reliability: { normal: 0.95, adverse: 0.85 }, setBy: 'person:test' });
    const policy = await goalPolicy({ goalId, target, daysLeft: 30 });
    expect(policy.kind).toBe('SQUEEZE');
    expect(policy.reliability).toEqual({ normal: 0.95, adverse: 0.85 });
    const gate = gateRecommendation({ policy, probability: unsupported, combinedSetbacks: [] });
    expect(gate.notSqueeze).toBe(false);
    expect(gate.recommendable).toBe(false);
  });

  it('refuses an unknown kind, a standard on a non-squeeze kind, and a nonsense standard', async () => {
    expect(await setGoalPolicy({ goalId, kind: 'WHATEVER', setBy: 'person:test' })).toMatchObject({ ok: false });
    expect(await setGoalPolicy({ goalId, kind: 'CREATIVE', reliability: { normal: 0.9 }, setBy: 'person:test' })).toMatchObject({ ok: false });
    expect(await setGoalPolicy({ goalId, kind: 'SQUEEZE', reliability: { normal: 0.7, adverse: 0.9 }, setBy: 'person:test' })).toMatchObject({ ok: false });
    expect((await goalPolicy({ goalId })).recorded).toBe(false);
  });

  it('the table refuses a row that skips the checks', async () => {
    const insert = (kind: string, normal: number | null) => getDb().run(
      `INSERT INTO goal_policies (id, goal_id, kind, reliability_normal, reliability_adverse, set_by, set_at)
       VALUES (?, ?, ?, ?, NULL, 'person:test', '2026-11-11T00:00:00.000Z')`,
      [`gpl_${Math.random().toString(36).slice(2)}`, goalId, kind, normal],
    );
    await expect(insert('WHATEVER', null)).rejects.toThrow();
    await expect(insert('CREATIVE', 0.9)).rejects.toThrow();
    await expect(insert('SQUEEZE', 1.5)).rejects.toThrow();
  });
});
