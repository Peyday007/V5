/**
 * A cash goal a person set on a project with no sprint gets the sprint its
 * research runs under (`server/services/russell/goalSprint.ts`). Production,
 * 2026-11-19: goals on Cash Mode 2/3/4 planned research and launched none,
 * because those projects had no `cash_modes` row and no research grant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { listGoals, checkAuthority } from '../server/repos/russellAuthority.ts';
import { listLayers } from '../server/repos/layers.ts';
import { listWorkstreamEvents } from '../server/repos/register.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { setLifecycle } from '../server/services/cash/lifecycle.ts';
import { knowledgeResearchAllowed } from '../server/services/cash/lifecycle.ts';
import { activateGoalSprints, GOAL_SPRINT_EVENT } from '../server/services/russell/goalSprint.ts';

const OBJECTIVE = 'Earn 3000 dollars of settled cash in 30 days selling services with no starting capital';

async function person(admin = false) {
  return createUser({ email: `goal-sprint-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: admin });
}

let projectId = '';

beforeEach(async () => {
  await freshProject();
  projectId = (await createProject({ name: 'Cash Mode 2' })).id;
});

describe('a person-set cash goal starts its project\'s research sprint', () => {
  it('activates Cash Mode with a research-only grant and a layer, once, and records it on the goal', async () => {
    const admin = await person(true);
    const created = await createGoal({ projectId, objective: OBJECTIVE, actorRef: `person:${admin.id}`, userId: admin.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await getCashMode(projectId)).toBeNull();
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(false);

    const out = await activateGoalSprints();
    expect(out).toEqual([expect.objectContaining({ goalId: created.goal.id, projectId, activated: true })]);

    const mode = await getCashMode(projectId);
    expect(mode).toMatchObject({ state: 'ACTIVE', ownerUserId: admin.id, createdByUserId: admin.id, currency: 'USD' });
    expect((await listLayers(projectId)).length).toBeGreaterThan(0);
    const grants = await listGoals(projectId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ allowedWork: ['RESEARCH'], ownerUserId: admin.id });
    expect(grants[0]!.prohibitions).toEqual(expect.arrayContaining(['NEW_SPENDING', 'PURCHASE', 'CONTACT_PERSON', 'PUBLISH_EXTERNALLY']));
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(true);
    expect((await knowledgeResearchAllowed(projectId)).allowed).toBe(true);
    expect((await listWorkstreamEvents(created.goal.id)).some((e) => e.kind === GOAL_SPRINT_EVENT)).toBe(true);

    // Idempotent: a second tick changes nothing.
    expect(await activateGoalSprints()).toEqual([]);
    expect(await listGoals(projectId)).toHaveLength(1);
  });

  it('never activates for a goal a machine set, or for a person without ADMIN on the project', async () => {
    const machine = await createGoal({ projectId, objective: OBJECTIVE, actorRef: 'operator:run', userId: null });
    expect(machine.ok).toBe(true);
    expect(await activateGoalSprints()).toEqual([]);
    expect(await getCashMode(projectId)).toBeNull();

    const other = (await createProject({ name: 'Cash Mode 3' })).id;
    const member = await person(false);
    await grantMembership({ projectId: other, principalType: 'HUMAN', principalId: member.id, role: 'MEMBER', grantedByType: 'SYSTEM', grantedById: 'test' });
    const memberGoal = await createGoal({ projectId: other, objective: OBJECTIVE, actorRef: `person:${member.id}`, userId: member.id });
    expect(memberGoal.ok).toBe(true);
    const out = await activateGoalSprints();
    expect(out).toEqual([expect.objectContaining({ projectId: other, activated: false })]);
    expect(await getCashMode(other)).toBeNull();
    expect(await listGoals(other)).toHaveLength(0);
  });

  it('leaves a sprint a person archived alone', async () => {
    const admin = await person(true);
    expect((await createGoal({ projectId, objective: OBJECTIVE, actorRef: `person:${admin.id}`, userId: admin.id })).ok).toBe(true);
    await activateGoalSprints();
    expect((await setLifecycle({ projectId, to: 'ARCHIVED', actorUserId: admin.id, reason: 'stopping this one' })).ok).toBe(true);
    expect(await activateGoalSprints()).toEqual([]);
    expect((await getCashMode(projectId))!.state).toBe('ARCHIVED');
  });
});
