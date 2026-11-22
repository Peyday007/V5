/**
 * ORIGINATED:IDLE_CAPACITY:free-lane-coverage — displaced research waited on
 * the free lane, the coverage watch recorded "Displaced research is not
 * progressing" every window, and nothing continued it (rule 9).
 *
 * The first continuation repeated the pool's own control step, which is inert
 * when this process's pool is not running: its slots exit at once. The suite
 * below reproduces that on a real queue — a stranded displaced fragment stays
 * QUEUED through a control step — and shows the continuation the dispatch pass
 * now performs (re-read memberships, start the stopped pool through its own
 * `startAdaptivePool`) take the item and finish it.
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
import { adaptivePoolRunning, controlStep, startAdaptivePool, stopAdaptivePool } from '../server/services/freeLane/capacity.ts';
import { continueDisplacedWork, restartStrandedFreeLane } from '../server/services/dispatch/loop.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

let play: TestProject;

/** One displaced research item under a PLAY_RESEARCH bin, queued `ageMs` ago. */
async function displaced(ageMs: number): Promise<void> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const title = 'Stranded displaced research';
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title, assignment: 'A question', provider: 'WORKER', autoApprove: false,
  });
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title,
    objective: title,
    orchestrationId: orchestration.id,
    manifest: {
      objective: title,
      why: 'test',
      lineage: { projectId, layerId, goal: title, orchestrationId: orchestration.id },
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
  const definition = workType('RESEARCH_PLAN');
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_PLAN',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    createdByType: 'SYSTEM',
  });
  await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [new Date(Date.now() - ageMs).toISOString(), item.id]);
}

async function coverageInterventions(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage' AND kind = 'IDLE_WITH_EXECUTABLE_WORK'",
    [],
  );
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  play = await freshProject();
  delete process.env['BRAIN_CHEAP_LLM_URL'];
});
afterEach(() => stopAdaptivePool());

/* A free lane whose model answers, so a taken item can finish (the capacity suite's fixture). */
const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
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
const calm = { db: false, lagMs: 5, cpu: 0.1 };
const startLane = (): void => startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm }, 60_000);

/** One displaced research fragment under a PLAY_RESEARCH bin, queued `ageMs` ago; returns its work item id. */
async function displacedFragment(ageMs: number): Promise<string> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'wage' });
  const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'Receptionist wage', assignment: 'wage', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'wage-0',
    question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
    population: 'Receptionists', definitions: 'Median hourly wage',
    requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
    acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
  }]);
  const bin = await createBin({
    projectId, kind: 'RESEARCH_PACKET', title: 'Receptionist wage', objective: 'wage', orchestrationId: orchestration.id,
    manifest: { objective: 'wage', why: 't', lineage: { projectId, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
    completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
  });
  await getDb().run("UPDATE bins SET purpose = 'PLAY_RESEARCH' WHERE id = ?", [bin.id]);
  const def = workType('RESEARCH_FRAGMENT');
  const item = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
  await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [new Date(Date.now() - ageMs).toISOString(), item.id]);
  return item.id;
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await getDb().get<{ state: string }>('SELECT state FROM work_items WHERE id = ?', [id]))?.state;
}

/** The lane's own restart, with this suite's model in place of the configured one and past the boot delay. */
const restart = () => restartStrandedFreeLane({ configured: () => true, uptimeMs: () => 3_600_000, start: startLane });

describe('a stranded displaced fragment on a real queue', () => {
  it('stays QUEUED when the continuation only steps a pool that is not running (the recorded failure)', async () => {
    await setBrainOnlyMode(true, 'test', 'stranded continuation');
    const id = await displacedFragment(45 * 60_000);
    expect(adaptivePoolRunning()).toBe(false);
    await controlStep();
    await new Promise((r) => setTimeout(r, 300));
    expect(await stateOf(id)).toBe('QUEUED');
  });

  it('is taken and finished once the continuation starts the stopped pool', async () => {
    await setBrainOnlyMode(true, 'test', 'stranded continuation');
    const id = await displacedFragment(45 * 60_000);
    expect(adaptivePoolRunning()).toBe(false);
    const outcome = await continueDisplacedWork({ step: restart });
    expect(outcome).toEqual({ stranded: true, continued: true });
    expect(adaptivePoolRunning()).toBe(true);
    for (let i = 0; i < 100 && (await stateOf(id)) !== 'SUCCEEDED'; i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(await stateOf(id)).toBe('SUCCEEDED');
  }, 30_000);

  it('leaves a running pool to its own controller and reports nothing continued', async () => {
    await setBrainOnlyMode(true, 'test', 'stranded continuation');
    startLane();
    const start = vi.fn();
    const outcome = await continueDisplacedWork({
      watch: async () => ({ stranded: true, reason: 'x' }),
      step: () => restartStrandedFreeLane({ configured: () => true, uptimeMs: () => 3_600_000, start }),
    });
    expect(outcome).toEqual({ stranded: true, continued: false });
    expect(start).not.toHaveBeenCalled();
  });

  it('respects the lane deliberate boot delay and an unconfigured lane', async () => {
    const start = vi.fn();
    const base = { running: () => false, start, resetMemberships: () => undefined };
    expect(await restartStrandedFreeLane({ ...base, configured: () => true, uptimeMs: () => 60_000 })).toBe('BOOT_DELAY');
    expect(await restartStrandedFreeLane({ ...base, configured: () => false, uptimeMs: () => 3_600_000 })).toBe('NOT_CONFIGURED');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('the dispatch tick continues displaced research the free lane left stranded', () => {
  it('records the free-lane:coverage idle intervention and steps the free lane in the same pass', async () => {
    await displaced(45 * 60_000);
    const step = vi.fn(async () => null);
    const outcome = await continueDisplacedWork({ step });
    expect(await coverageInterventions()).toBe(1);
    expect(outcome).toEqual({ stranded: true, continued: true });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('does not step the lane when nothing is stranded', async () => {
    await displaced(60_000); // queued a minute ago: inside the window
    const step = vi.fn(async () => null);
    const outcome = await continueDisplacedWork({ step });
    expect(outcome).toEqual({ stranded: false, continued: false });
    expect(step).not.toHaveBeenCalled();
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
