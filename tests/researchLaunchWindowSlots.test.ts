/**
 * The launch window and the capacity reader use one predicate (§78, §98).
 *
 * Production, 2026-11-15 07:46Z-07:49Z: the capacity reader said "3->5
 * launchable idea(s) have a free slot in their own project's grant" sample
 * after sample, with 504 waiting and 11 of 16 slots running, while nothing
 * launched. The launch window was the best fifty ideas Brain-wide; every one of
 * them sat in a project whose research grant was full, so `launch()` refused
 * each `AT_ONCE` and the ideas with a free slot were never reached.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createProject } from '../server/repos/projects.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { nextLaunchable } from '../server/services/russell/loop.ts';
import { brainUtilization, researchSlotsFree } from '../server/services/engineering/watchdog.ts';

let fullProject = '';
let freeProject = '';
let userId = '';

async function grant(projectId: string, name: string, maxConcurrent: number): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name,
    allowedWork: ['RESEARCH'],
    maxMissions: 50,
    maxFragments: 50,
    maxConcurrent,
    maxProbes: 1,
  });
}

async function idea(projectId: string, title: string, priority: 'MUST_DO' | 'EXPLORE'): Promise<string> {
  const captured = await capture({ title, statement: `establish ${title} from published sources`, projectId, visibility: 'SHARED' });
  const id = captured.candidate!.id;
  await getDb().run(`UPDATE russell_candidates SET state = 'QUEUED', priority = ?, judgment = ? WHERE id = ?`, [
    priority,
    JSON.stringify({ missionSpec: { title } }),
    id,
  ]);
  return id;
}

beforeEach(async () => {
  fullProject = (await freshProject()).project.id;
  freeProject = (await createProject({ name: `Free slots ${Math.random().toString(36).slice(2, 8)}` })).id;
  userId = (
    await createUser({
      email: `window-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

describe('ideas the reader calls launchable are in the launch window', () => {
  it('puts the ideas that fit a free slot ahead of better-ranked ideas whose grant is full', async () => {
    await grant(fullProject, 'full', 0);
    await grant(freeProject, 'free', 2);
    // More better-ranked ideas in the full project than the window holds.
    for (let i = 0; i < 6; i += 1) await idea(fullProject, `full ${i}`, 'MUST_DO');
    const a = await idea(freeProject, 'free a', 'EXPLORE');
    const b = await idea(freeProject, 'free b', 'EXPLORE');
    const c = await idea(freeProject, 'free c', 'EXPLORE');

    const window = await nextLaunchable(3);
    const fits = window.filter((entry) => entry.fitsFreeSlot).map((entry) => entry.candidateId);
    // Two free slots, so the free project's two best ideas — not its third.
    expect(fits).toEqual([a, b]);
    expect(window.slice(0, 2).map((entry) => entry.candidateId)).toEqual([a, b]);
    expect(fits).not.toContain(c);

    // The reader counts exactly what the window will launch.
    expect(await researchSlotsFree()).toBe(fits.length);
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    expect(slots.idle).toBe(true);
    expect(slots.because).toMatch(/^2 launchable idea/);
  });

  it('names the gate instead of calling ideas with no free slot launchable', async () => {
    await grant(fullProject, 'full', 0);
    await idea(fullProject, 'held', 'MUST_DO');
    await idea(freeProject, 'ungoverned', 'MUST_DO');
    const window = await nextLaunchable(10);
    expect(window.some((entry) => entry.fitsFreeSlot)).toBe(false);
    expect(await researchSlotsFree()).toBe(0);
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    expect(slots.idle).toBe(false);
    expect(slots.because).toMatch(/at-once ceiling/);
    expect(slots.because).toMatch(/no research grant governs/);
  });
});
