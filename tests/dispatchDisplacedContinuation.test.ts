/**
 * Stranded displaced research is continued by the dispatch pass, not only
 * recorded (§85, §98, rule 9).
 *
 * Production, 2026-11-15 (ORIGINATED:IDLE_CAPACITY:free-lane-coverage): the
 * brain-only pass of the dispatch tick called `watchDisplacedWork`, which
 * recorded "Displaced research is not progressing: N item(s) waiting" with the
 * replacement "free-lane tick", and then threw the result away — so nothing
 * ran, and the same fault recurred in 6 of 144 ten-minute windows. The pass now
 * continues the work through the free lane's own controller: it starts a
 * stopped pool, or gives a running one a control step. A healthy lane is not
 * prodded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({ running: false, started: 0, steps: 0 }));

vi.mock('../server/services/freeLane/capacity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/freeLane/capacity.ts')>();
  return {
    ...actual,
    adaptivePoolRunning: () => pool.running,
    startAdaptivePool: () => {
      pool.started += 1;
      pool.running = true;
    },
    controlStep: async () => {
      pool.steps += 1;
      return null;
    },
  };
});

// A configured free lane, so a recent submission reads as a healthy lane.
vi.mock('../server/services/cheap/lane.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/cheap/lane.ts')>();
  return {
    ...actual,
    laneConfig: () => ({ url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 }),
  };
});

// Isolate the continuation under test from the pass's other self-corrections.
vi.mock('../server/services/bins/brainOnly.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/bins/brainOnly.ts')>();
  return { ...actual, enforceBrainOnly: async () => undefined };
});
vi.mock('../server/services/improvement/activation.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/improvement/activation.ts')>();
  return { ...actual, activationFallback: async () => null };
});

import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { continueDisplacedWork, dispatchTick, forgetBrainOnlyPass } from '../server/services/dispatch/loop.ts';

let project: TestProject;

/** Displaced research: a QUEUED item under a PLAY_RESEARCH bin, waiting since `ageMs` ago. */
async function displaced(ageMs: number): Promise<void> {
  const projectId = project.project.id;
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'displaced play research',
    objective: 'displaced play research',
    manifest: {
      objective: 'displaced play research',
      why: 'test',
      lineage: { projectId, layerId: null, goal: 'displaced play research', orchestrationId: null },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 60 },
      stoppingConditions: [],
    },
    completionContract: 'RESEARCH_PACKET_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
  const definition = workType('RESEARCH_FRAGMENT');
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_FRAGMENT',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    binId: bin.id,
    availableAt: new Date(Date.now() - ageMs).toISOString(),
    createdByType: 'SYSTEM',
  });
}

async function coverageInterventions(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage'",
  );
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  project = await freshProject();
  pool.running = false;
  pool.started = 0;
  pool.steps = 0;
  forgetBrainOnlyPass();
});

describe('the dispatch pass continues stranded displaced research through the free lane', () => {
  it('records the fault and starts a stopped free-lane pool (the recorded failure class)', async () => {
    await displaced(60 * 60_000);
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(1);
    expect(pool.started).toBe(1);
  });

  it('gives a running pool a control step instead of starting a second one', async () => {
    pool.running = true;
    await displaced(60 * 60_000);
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(1);
    expect(pool.started).toBe(0);
    expect(pool.steps).toBe(1);
  });

  it('does not prod the lane when nothing is displaced', async () => {
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(0);
    expect(pool.started + pool.steps).toBe(0);
  });

  it('does not prod a lane that submitted recently', async () => {
    await displaced(60 * 60_000);
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a: ok' });
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(0);
    expect(pool.started + pool.steps).toBe(0);
  });

  it('does nothing when the coverage watch reports nothing stranded', async () => {
    expect(await continueDisplacedWork(false)).toBeNull();
    expect(pool.started + pool.steps).toBe(0);
  });
});
