/**
 * A goal's policy is a recorded decision, not an argument a test passes.
 *
 * F2: no goal record carried a policy kind and no caller passed one, so a
 * long-term or creative goal could never reach a non-SQUEEZE policy outside a
 * test. These drive the production path: the writer records the decision on
 * the goal, and the one reader the plan uses returns it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { gateRecommendation, readGoalPolicy, setGoalPolicy } from '../server/services/goals/policy.ts';

let goalId = '';

beforeEach(async () => {
  const projectId = (await freshProject()).project.id;
  goalId = (await createWorkstream({ projectId, title: 'Build a studio', intent: 'Build a studio over two years', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
});

describe('a recorded goal policy', () => {
  it('reads a goal nobody has set a policy on as SQUEEZE, as before', async () => {
    const policy = await readGoalPolicy({ goalId });
    expect(policy.kind).toBe('SQUEEZE');
    expect(policy.reliability).toEqual({ normal: 0.9, adverse: 0.8 });
  });

  it('carries a long-term or creative goal to its own policy, which no squeeze rule touches', async () => {
    for (const kind of ['LONG_TERM_VENTURE', 'CREATIVE'] as const) {
      const set = await setGoalPolicy({ goalId, kind, actorRef: 'person:test' });
      expect(set.ok).toBe(true);
      const policy = await readGoalPolicy({ goalId, daysLeft: 30 });
      expect(policy).toMatchObject({ kind, judgedOnTarget: false, reliability: null, deadlineDays: null });
      const gate = gateRecommendation({ policy, probability: { measured: null, modelled: null }, combinedSetbacks: [] });
      expect(gate).toMatchObject({ policy: kind, notSqueeze: true, reasons: [] });
    }
    const events = await listWorkstreamEvents(goalId);
    expect(events.filter((e) => e.kind === 'GOAL_POLICY_SET').map((e) => e.summary)).toEqual(['Policy: CREATIVE.', 'Policy: LONG_TERM_VENTURE.']);
  });

  it('keeps a configured squeeze standard, and returns a goal to SQUEEZE when a person says so', async () => {
    await setGoalPolicy({ goalId, kind: 'CREATIVE', actorRef: 'person:test' });
    const set = await setGoalPolicy({ goalId, kind: 'SQUEEZE', reliability: { normal: 0.95, adverse: 0.85 }, actorRef: 'person:test' });
    expect(set.ok).toBe(true);
    const policy = await readGoalPolicy({ goalId, daysLeft: 10 });
    expect(policy).toMatchObject({ kind: 'SQUEEZE', judgedOnTarget: true, deadlineDays: 10, reliability: { normal: 0.95, adverse: 0.85 } });
  });

  it('refuses what it cannot record honestly', async () => {
    expect(await setGoalPolicy({ goalId: 'wst_missing', kind: 'CREATIVE', actorRef: 'person:test' })).toMatchObject({ ok: false });
    expect(await setGoalPolicy({ goalId, kind: 'HOBBY', actorRef: 'person:test' })).toMatchObject({ ok: false });
    expect(await setGoalPolicy({ goalId, kind: 'RESEARCH', reliability: { normal: 0.9 }, actorRef: 'person:test' })).toMatchObject({ ok: false });
    expect(await setGoalPolicy({ goalId, kind: 'SQUEEZE', reliability: { normal: 0.7, adverse: 0.8 }, actorRef: 'person:test' })).toMatchObject({ ok: false });
    expect((await readGoalPolicy({ goalId })).kind).toBe('SQUEEZE');
    // The database refuses a reliability standard on a policy that has none, whoever writes it.
    await expect(getDb().run(
      `INSERT INTO goal_policies (workstream_id, kind, reliability_normal, set_by, set_at) VALUES (?, 'CREATIVE', 0.9, 'x', 'now')`, [goalId],
    )).rejects.toThrow();
  });
});
