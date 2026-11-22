/**
 * ORIGINATED:IDLE_CAPACITY:free-lane-coverage — displaced research waited on
 * the free lane, the coverage watch recorded "Displaced research is not
 * progressing" every window, and nothing continued it (rule 9).
 *
 * The failure class is reproduced on a real queue, with a stub model in place
 * of the network: stranded displaced fragments, the free lane's pool not
 * running in this process. A bare controller step (attempt 1's continuation)
 * leaves every one of them QUEUED; the dispatch pass's continuation must leave
 * none waiting, each one submitted by the free lane, and the watch no longer
 * reporting them stranded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { adaptivePoolRunning, controlStep, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import { watchDisplacedWork } from '../server/services/freeLane/coverage.ts';
import { continueDisplacedWork } from '../server/services/dispatch/loop.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
const calm = { db: false, lagMs: 5, cpu: 0.1 };
const STRANDED_MS = 45 * 60_000;

let play: TestProject;

/** A model that answers every fragment with one sourced claim. */
const completer: Completer = async (_c, _m, _s, prompt) => {
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: ['https://www.bls.gov/x'] });
  const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
  const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
  return JSON.stringify({
    claims: [{ claim: 'US median receptionist wage was $17.39 an hour in May 2024.', claim_type: 'SOURCED_FACT', source: Number(ref?.[1]), sentences: [Number(ref?.[2])], evidence_lane: 'wage' }],
  });
};
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
  retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length,
});
const POOL = { config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm };

/** `n` displaced research fragments under PLAY_RESEARCH bins, queued `ageMs` ago. */
async function displaced(n: number, ageMs: number): Promise<void> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  for (let i = 0; i < n; i += 1) {
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
    const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: `Receptionist wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([{
      orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
      question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
      population: 'Receptionists', definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    }]);
    const bin = await createBin({
      projectId, kind: 'RESEARCH_PACKET', title: `Receptionist wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
      manifest: { objective: 'wage', why: 't', lineage: { projectId, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
    const def = workType('RESEARCH_FRAGMENT');
    const item = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
    await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [new Date(Date.now() - ageMs).toISOString(), item.id]);
  }
}

async function fragments(state: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM work_items WHERE work_type = 'RESEARCH_FRAGMENT' AND state = ?", [state]);
  return Number(row?.n ?? 0);
}

async function submittedByFreeLane(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED'", []);
  return Number(row?.n ?? 0);
}

async function coverageInterventions(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage' AND kind = 'IDLE_WITH_EXECUTABLE_WORK'",
    [],
  );
  return Number(row?.n ?? 0);
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  play = await freshProject();
  await setBrainOnlyMode(true, 'test', 'stranded continuation suite');
  stopAdaptivePool();
});
afterEach(() => {
  stopAdaptivePool();
  delete process.env['BRAIN_CHEAP_LLM_URL'];
  delete process.env['BRAIN_CHEAP_LLM_MODELS'];
});

describe('the dispatch tick continues displaced research the free lane left stranded', () => {
  it('a bare controller step on a pool that is not running leaves stranded research QUEUED (the recorded failure)', async () => {
    process.env['BRAIN_CHEAP_LLM_URL'] = CONFIG.url;
    process.env['BRAIN_CHEAP_LLM_MODELS'] = CONFIG.models.join(',');
    await displaced(3, STRANDED_MS);
    expect((await watchDisplacedWork()).stranded).toBe(true);
    expect(adaptivePoolRunning()).toBe(false);
    await controlStep();
    await pause(500);
    // Slots were sized, then exited at once: nothing was taken, nothing submitted.
    expect(await fragments('QUEUED')).toBe(3);
    expect(await submittedByFreeLane()).toBe(0);
    expect((await watchDisplacedWork()).stranded).toBe(true);
  });

  it('the continuation leaves no stranded item waiting: each is taken and submitted by the free lane', async () => {
    await displaced(3, STRANDED_MS);
    expect(adaptivePoolRunning()).toBe(false);
    const outcome = await continueDisplacedWork({ pool: POOL });
    expect(outcome).toEqual({ stranded: true, continued: true });
    expect(await coverageInterventions()).toBe(1);
    expect(adaptivePoolRunning()).toBe(true);
    for (let i = 0; i < 100 && (await fragments('SUCCEEDED')) < 3; i += 1) await pause(100);
    expect(await fragments('SUCCEEDED')).toBe(3);
    expect(await fragments('QUEUED')).toBe(0);
    expect(await submittedByFreeLane()).toBeGreaterThanOrEqual(3);
    // The watch the intervention came from no longer reads the work as stranded.
    expect((await watchDisplacedWork()).stranded).toBe(false);
  }, 30_000);

  it('steps a pool that is already running rather than starting a second one', async () => {
    await displaced(1, STRANDED_MS);
    const { startAdaptivePool } = await import('../server/services/freeLane/capacity.ts');
    startAdaptivePool(POOL, 60_000);
    for (let i = 0; i < 100 && (await fragments('SUCCEEDED')) < 1; i += 1) await pause(100);
    await displaced(2, STRANDED_MS);
    expect((await continueDisplacedWork({ pool: POOL })).continued).toBe(true);
    for (let i = 0; i < 100 && (await fragments('SUCCEEDED')) < 3; i += 1) await pause(100);
    expect(await fragments('QUEUED')).toBe(0);
    expect(await fragments('SUCCEEDED')).toBe(3);
  }, 30_000);

  it('does not touch the lane when nothing is stranded', async () => {
    await displaced(1, 60_000); // queued a minute ago: inside the window
    const step = vi.fn(async () => null);
    const outcome = await continueDisplacedWork({ step });
    expect(outcome).toEqual({ stranded: false, continued: false });
    expect(step).not.toHaveBeenCalled();
    expect(adaptivePoolRunning()).toBe(false);
    expect(await coverageInterventions()).toBe(0);
  });

  it('never throws when the watch or the step fails', async () => {
    const failingWatch = async (): Promise<{ stranded: boolean; reason: string }> => {
      throw new Error('watch down');
    };
    await expect(continueDisplacedWork({ watch: failingWatch })).resolves.toEqual({ stranded: false, continued: false });
    const failingStep = async (): Promise<never> => {
      throw new Error('step down');
    };
    await expect(
      continueDisplacedWork({ watch: async () => ({ stranded: true, reason: 'x' }), step: failingStep }),
    ).resolves.toEqual({ stranded: true, continued: false });
  });
});
