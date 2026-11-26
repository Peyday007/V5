/**
 * A cancelled goal's queued research gives up its goal boost, and a live goal's
 * research is claimed ahead of it.
 *
 * Production 2026-11-26 01:05Z: 837 evaluation fragments were QUEUED at
 * priority 8–9, most for goals already cancelled, while the free lane admitted
 * two fragments at a time; a fresh goal's dives at 8 waited behind cancelled
 * goals' dives at 9. Nothing may be discarded: the items stay QUEUED and are
 * lifted again on reinstatement.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { cancel, reinstate } from '../server/services/goals/decide.ts';
import { STOPPED_GOAL_RESEARCH_PRIORITY, yieldStoppedGoalResearch } from '../server/services/goals/goalWork.ts';

let ownerId = '';

async function goalIn(projectId: string, title: string) {
  const goal = await createWorkstream({
    projectId,
    title,
    intent: 'The outcome somebody actually asked for.',
    purpose: 'REVENUE_DIRECT',
    createdByUserId: ownerId,
  });
  await getDb().run(`UPDATE workstreams SET target_metric = 'SETTLED_CASH', target_project_id = ? WHERE id = ?`, [projectId, goal.id]);
  return goal;
}

async function queued(projectId: string, priority: number) {
  return enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: {}, priority, createdByType: 'SYSTEM' });
}

async function priorityOf(id: string): Promise<{ priority: number; state: string }> {
  return (await getDb().get<{ priority: number; state: string }>(`SELECT priority, state FROM work_items WHERE id = ?`, [id]))!;
}

beforeEach(async () => {
  await freshProject();
  ownerId = (
    await createUser({ email: `yield-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'The owner', password: 'correct horse battery staple' })
  ).id;
});

describe('a stopped goal yields its research to live goals', () => {
  it('drops a cancelled goal’s boosted items to base priority, keeps them queued, and restores them on reinstatement', async () => {
    const stoppedProject = (await createProject({ name: `Stopped ${Math.random().toString(36).slice(2, 7)}` })).id;
    const liveProject = (await createProject({ name: `Live ${Math.random().toString(36).slice(2, 7)}` })).id;
    const stopped = await goalIn(stoppedProject, 'Retired evaluation goal');
    await goalIn(liveProject, 'Fresh goal');
    const dive = await queued(stoppedProject, 9);
    const narrow = await queued(stoppedProject, 8);
    const unboosted = await queued(stoppedProject, 5);
    const live = await queued(liveProject, 8);

    const result = await cancel(stopped.id, 'retired', 'person:test');
    expect(result.ok).toBe(true);

    expect(await priorityOf(dive.id)).toEqual({ priority: STOPPED_GOAL_RESEARCH_PRIORITY, state: 'QUEUED' });
    expect(await priorityOf(narrow.id)).toEqual({ priority: STOPPED_GOAL_RESEARCH_PRIORITY, state: 'QUEUED' });
    expect((await priorityOf(unboosted.id)).priority).toBe(5);
    expect((await priorityOf(live.id)).priority).toBe(8);
    // Idempotent: asking again changes nothing.
    expect(await yieldStoppedGoalResearch(stopped.id)).toBe(0);

    const back = await reinstate(stopped.id, 'person:test');
    expect(back.ok).toBe(true);
    expect((await priorityOf(dive.id)).priority).toBeGreaterThan(STOPPED_GOAL_RESEARCH_PRIORITY);
    expect((await priorityOf(unboosted.id)).priority).toBe(5);
  });

  it('leaves a project another live goal still works in alone', async () => {
    const shared = (await createProject({ name: `Shared ${Math.random().toString(36).slice(2, 7)}` })).id;
    const stopped = await goalIn(shared, 'Stopped goal');
    await goalIn(shared, 'Still live in the same project');
    const item = await queued(shared, 8);
    await cancel(stopped.id, 'stopped', 'person:test');
    expect((await priorityOf(item.id)).priority).toBe(8);
  });
});
