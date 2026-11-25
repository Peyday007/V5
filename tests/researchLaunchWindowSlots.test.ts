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
import { listLayers } from '../server/repos/layers.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { nextLaunchable } from '../server/services/russell/loop.ts';
import { brainUtilization, researchSlotsFree, watchUtilization } from '../server/services/engineering/watchdog.ts';

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

/**
 * An idle research pool is continued, not only recorded (§98, rule 9).
 *
 * The recorded class: "RESEARCH_SLOTS: 5x launchable idea(s) have a free slot
 * in their own project's grant" in window after window, each written down with
 * "its own pass on the next tick" while the launch pass sat behind the rest of
 * a long Russell tick. The watchdog now takes the launch pass's own step.
 */
/** An idea carrying a complete specification, so `launch()` can actually start it. */
async function launchableIdea(projectId: string, title: string, priority: 'MUST_DO' | 'EXPLORE'): Promise<string> {
  const id = await idea(projectId, title, priority);
  const layerId = (await listLayers(projectId))[0]!.id;
  const missionSpec = {
    projectId,
    layerId,
    visibility: 'SHARED',
    title,
    assignment: `Establish ${title} from published sources.`,
    objective: `Settle ${title} from the primary text.`,
    whyNow: `The layer names ${title} as open.`,
    acceptableSources: ['primary sources'],
    excludedSources: ['secondary summaries'],
    evidence: ['the passage relied on'],
    startedBy: { kind: 'PERSON', id: userId },
    envelopeId: 'RUSSELL_STATE_LICENSING_V1',
    authorizedBy: userId,
  };
  await getDb().run('UPDATE russell_candidates SET judgment = ? WHERE id = ?', [JSON.stringify({ missionSpec }), id]);
  return id;
}

describe('the watchdog continues an idle research pool', () => {
  it('launches the ideas that fit a free slot, and the pool stops reading idle', async () => {
    // The seeded project, because a launch needs a real layer to put the packet in.
    await grant(fullProject, 'free', 2);
    await launchableIdea(fullProject, 'free a', 'MUST_DO');
    await launchableIdea(fullProject, 'free b', 'MUST_DO');
    await launchableIdea(fullProject, 'free c', 'EXPLORE');
    expect(await researchSlotsFree()).toBe(2);

    const result = await watchUtilization({});
    expect(result.recorded).toContain('RESEARCH_SLOTS');
    expect(result.continued).toContain('RESEARCH_SLOTS');
    const missions = await getDb().get<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM russell_missions WHERE project_id = ?',
      [fullProject],
    );
    expect(Number(missions?.n ?? 0)).toBe(2);
    expect(await researchSlotsFree()).toBe(0);
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    expect(slots.idle).toBe(false);
    expect(slots.because).toMatch(/at-once ceiling/);
  });

  it('starts nothing over a full grant', async () => {
    await grant(fullProject, 'full', 0);
    await launchableIdea(fullProject, 'held', 'MUST_DO');
    const result = await watchUtilization({});
    expect(result.continued).not.toContain('RESEARCH_SLOTS');
    const missions = await getDb().get<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM russell_missions WHERE project_id = ?',
      [fullProject],
    );
    expect(Number(missions?.n ?? 0)).toBe(0);
  });
});
