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
 * stopped pool. A running pool is left to its own 30s control timer — a second
 * control step from the dispatch tick could overlap the timer's and would put
 * the controller's database work inside the tick (review finding F4). A
 * healthy lane is not prodded.
 *
 * Review finding F2: this suite used to mock the pool itself and seed an item
 * no worker could execute, so it proved only that mocked functions were
 * called. It now runs the real adaptive pool (only the model, the source
 * reader and the web search are faked) against a real research fragment under
 * a PLAY_RESEARCH bin, in the two states production actually reaches:
 *
 *   - after a restart, the free-lane loop starts the pool only after a delay
 *     (`startFreeLaneLoop`, 3 min), while research queued before the restart
 *     has already waited past the coverage window — the pool is stopped beside
 *     stale displaced work;
 *   - in steady state the pool is running, its slots asleep between empty
 *     looks, when displaced work arrives already past the window.
 *
 * Each case asserts the outcome, not the call: the displaced item leaves the
 * queue, succeeds, and a FREE_LANE_ITEM SUBMITTED row is recorded for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);

// The model: a configured lane whose completer answers from the page it was given.
vi.mock('../server/services/cheap/lane.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/cheap/lane.ts')>();
  return {
    ...actual,
    laneConfig: () => ({ url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 }),
    httpCompleter: async (_c: unknown, _m: unknown, _s: unknown, prompt: string) => {
      if (prompt.includes('Name up to')) return JSON.stringify({ urls: ['https://www.bls.gov/x'] });
      const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
      const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
      return JSON.stringify({
        claims: [{ claim: 'US median receptionist wage was $17.39 an hour in May 2024.', claim_type: 'SOURCED_FACT', source: Number(ref?.[1]), sentences: [Number(ref?.[2])], evidence_lane: 'wage' }],
      });
    },
  };
});
// The network: one readable page, and a search that finds nothing more.
vi.mock('../server/services/sources/access.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/sources/access.ts')>();
  return {
    ...actual,
    readSource: async (url: string) => ({
      readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
      retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length,
    }),
  };
});
vi.mock('../server/services/sources/discover.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/sources/discover.ts')>();
  return { ...actual, webSearch: async () => [] };
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
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { adaptivePoolRunning, lastControlReading, startAdaptivePool, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import { watchDisplacedWork } from '../server/services/freeLane/coverage.ts';
import { continueDisplacedWork, dispatchTick, forgetBrainOnlyPass } from '../server/services/dispatch/loop.ts';

let project: TestProject;
const HOUR = 60 * 60_000;

/**
 * Displaced research a free worker can actually execute: a QUEUED fragment of
 * a real orchestration, under a PLAY_RESEARCH bin, waiting since `ageMs` ago.
 */
async function displaced(ageMs: number): Promise<string> {
  return (await playPacket())(ageMs);
}

/**
 * A live PLAY_RESEARCH packet — which is what makes its project one the free
 * workers are members of — and a way to queue its fragment later, already
 * `ageMs` old.
 */
async function playPacket(): Promise<(ageMs: number) => Promise<string>> {
  const projectId = project.project.id;
  const layerId = (await project.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'wage' });
  const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'Receptionist wage', assignment: 'wage', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'wage',
    question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
    population: 'Receptionists', definitions: 'Median hourly wage',
    requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
    acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
  }]);
  const bin = await createBin({
    projectId, kind: 'RESEARCH_PACKET', title: 'displaced play research', objective: 'wage', orchestrationId: orchestration.id,
    manifest: { objective: 'wage', why: 'test', lineage: { projectId, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
    completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
  });
  await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
  const definition = workType('RESEARCH_FRAGMENT');
  return async (ageMs: number) => {
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment!.id, binId: bin.id,
      availableAt: new Date(Date.now() - ageMs).toISOString(), createdByType: 'SYSTEM',
    });
    return item.id;
  };
}

async function coverageInterventions(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage'",
  );
  return Number(row?.n ?? 0);
}

async function itemState(id: string): Promise<string | undefined> {
  return (await getDb().get<{ state: string }>('SELECT state FROM work_items WHERE id = ?', [id]))?.state;
}

async function submittedFor(id: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND work_item_id = ?",
    [id],
  );
  return Number(row?.n ?? 0);
}

/** Wait for the real pool to finish the item, without driving its controller. */
async function untilSucceeded(id: string, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && (await itemState(id)) !== 'SUCCEEDED') await new Promise((r) => setTimeout(r, 100));
  return itemState(id);
}

beforeEach(async () => {
  stopAdaptivePool();
  project = await freshProject();
  forgetBrainOnlyPass();
});
afterEach(() => stopAdaptivePool());

describe('the dispatch pass continues stranded displaced research through the free lane', () => {
  it('after a restart, inside the free-lane start delay: records the fault, starts the pool, and the displaced item is claimed and submitted (the recorded failure class)', async () => {
    const id = await displaced(HOUR);
    expect(adaptivePoolRunning()).toBe(false);
    expect((await watchDisplacedWork()).stranded).toBe(true);

    await dispatchTick({});

    expect(await coverageInterventions()).toBe(1);
    expect(adaptivePoolRunning()).toBe(true);
    expect(await untilSucceeded(id, 20_000)).toBe('SUCCEEDED');
    expect(await submittedFor(id)).toBe(1);
    // The lane has progressed, so the watch no longer calls it stranded.
    expect((await watchDisplacedWork()).stranded).toBe(false);
  }, 30_000);

  it('in steady state leaves the running pool to its own timer — no second pool, no control step from the tick — and the pool submits the displaced item', async () => {
    // The pool is running for a project with live play research, and its slots
    // have looked, found nothing queued, and gone to sleep.
    const queue = await playPacket();
    // (The reading is module state; an earlier case may have left one, so wait for this pool's own first step.)
    const earlier = lastControlReading();
    startAdaptivePool();
    for (let i = 0; i < 100 && lastControlReading() === earlier; i += 1) await new Promise((r) => setTimeout(r, 50));
    const reading = lastControlReading();
    expect(reading).not.toBe(earlier);
    expect(reading?.waiting).toBe(0);
    // Displaced research then arrives already past the coverage window.
    const id = await queue(HOUR);

    await dispatchTick({});

    expect(await coverageInterventions()).toBe(1);
    expect(await continueDisplacedWork(true)).toBe('RUNNING');
    // No control step ran from the tick: the reading is still the pool's own last one.
    expect(lastControlReading()).toBe(reading);
    // The running pool's own slots take the item when they next look.
    expect(await untilSucceeded(id, 40_000)).toBe('SUCCEEDED');
    expect(await submittedFor(id)).toBe(1);
  }, 60_000);

  it('does not prod the lane when nothing is displaced', async () => {
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(0);
    expect(adaptivePoolRunning()).toBe(false);
  });

  it('does not prod a lane that submitted recently', async () => {
    const id = await displaced(HOUR);
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a: ok' });
    await dispatchTick({});
    expect(await coverageInterventions()).toBe(0);
    expect(adaptivePoolRunning()).toBe(false);
    expect(await itemState(id)).toBe('QUEUED');
  });

  it('does nothing when the coverage watch reports nothing stranded', async () => {
    expect(await continueDisplacedWork(false)).toBeNull();
    expect(adaptivePoolRunning()).toBe(false);
  });
});
