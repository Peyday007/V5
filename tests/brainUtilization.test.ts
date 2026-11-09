/**
 * The Brain-wide resource rule (§98): every pool Brain schedules work onto is
 * read from its own scheduler's counts, and capacity left idle beside waiting
 * work is recorded once per window and continued through that pool's own path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { brainUtilization, idleCounts, watchUtilization } from '../server/services/engineering/watchdog.ts';
import { claimDispatchIntent, createBin, ensureDispatchIntent, getBin } from '../server/repos/bins.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `util-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function launchableIdea(title: string): Promise<string> {
  const captured = await capture({ title, statement: `establish ${title} from published sources`, projectId, visibility: 'SHARED' });
  const id = captured.candidate!.id;
  await getDb().run(`UPDATE russell_candidates SET state = 'QUEUED', judgment = ? WHERE id = ?`, [
    JSON.stringify({ missionSpec: { title } }),
    id,
  ]);
  return id;
}

describe('every pool is read, and idle capacity beside waiting work is acted on', () => {
  it('reads research slots from the grants, the holds and the launchable ideas', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'utilization',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 3,
      maxProbes: 1,
    });
    await launchableIdea('Florida bonding');
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    expect(slots.waiting).toBeGreaterThanOrEqual(1);
    expect(slots.capacity).toBeGreaterThanOrEqual(3);
    expect(slots.idle).toBe(true);
    // The routines pool is always read, from the dispatcher's own counts.
    expect((await brainUtilization()).some((one) => one.pool === 'ROUTINES')).toBe(true);
  });

  it('records an idle pool once per window, naming the pool and the reason', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'utilization-record',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 2,
      maxProbes: 1,
    });
    await launchableIdea('Ohio permits');
    const first = await watchUtilization({ continueWork: false });
    expect(first.recorded).toContain('RESEARCH_SLOTS');
    const second = await watchUtilization({ continueWork: false });
    expect(second.recorded).not.toContain('RESEARCH_SLOTS');
    const rows = await getDb().all<{ attempted_action: string }>(
      "SELECT attempted_action FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND attempted_action LIKE 'RESEARCH_SLOTS:%'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.attempted_action).toMatch(/launchable idea/);
  });

  it('does not count another project\u2019s free slots for ideas whose own grant is full', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'full-grant',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 0,
      maxProbes: 1,
    });
    const { createProject } = await import('../server/repos/projects.ts');
    const other = await createProject({ name: `Elsewhere ${Math.random().toString(36).slice(2, 8)}` });
    await createGoal({
      projectId: other.id,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'idle-elsewhere',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 9,
      maxProbes: 1,
    });
    await launchableIdea('Kansas permits');
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    expect(slots.waiting).toBeGreaterThanOrEqual(1);
    expect(slots.idle).toBe(false);
    expect(slots.because).toMatch(/at-once ceiling/);
  });

  it('says nothing is idle when nothing is waiting', async () => {
    const slots = (await brainUtilization()).find((one) => one.pool === 'RESEARCH_SLOTS')!;
    if (slots.waiting === 0) expect(slots.idle).toBe(false);
  });
});

describe('the most important work fires first', () => {
  it('claims the higher-priority bin\u2019s dispatch intent before an older, lower-priority one', async () => {
    const manifest = {
      objective: 'Return the sha-256 of one value carried in this manifest.',
      why: 'a bounded proof',
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'echo', establishes: 'answered', input: 'nonce', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['one unit result'],
      outputs: ['the sha-256'],
      authorizedActions: ['submit the unit result', 'complete this bin'],
      prohibitedActions: ['anything with an external effect'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 30 },
    } as unknown as BinManifest;
    const make = async (title: string, priority: number) =>
      (
        await createBin({
          projectId,
          kind: 'DETERMINISTIC_CHECK',
          title,
          objective: 'do the work',
          manifest,
          completionContract: 'DETERMINISTIC_UNITS_V1',
          workloadClass: 'SURFACE_PROBE_RESEARCH_V1',
          createdByType: 'SYSTEM',
          createdById: 'test',
          ready: true,
          maxAttempts: 2,
          priority,
        })
      ).id;
    // A bin the router just refused waits on that refusal, not on idle capacity.
    const refused = await make('refused by the router', 5);
    const before = (await idleCounts()).executableWork;
    const { recordBinEvent } = await import('../server/repos/bins.ts');
    await recordBinEvent({ eventType: 'DISPATCH_UNROUTED', binId: refused, projectId, outcome: 'NO_SURFACE_SERVES_THIS_FAMILY', reason: 'test' });
    expect((await idleCounts()).executableWork).toBe(before - 1);
    await getDb().run("UPDATE bins SET state = 'CANCELLED' WHERE id = ?", [refused]);
    const older = await make('older, ordinary', 5);
    await ensureDispatchIntent((await getBin(older))!);
    const urgent = await make('newer, revenue goal', 8);
    await ensureDispatchIntent((await getBin(urgent))!);
    expect((await claimDispatchIntent())?.binId).toBe(urgent);
    expect((await claimDispatchIntent())?.binId).toBe(older);
  });
});
