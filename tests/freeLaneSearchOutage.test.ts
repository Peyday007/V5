/**
 * A fragment that found no readable source while web search was refusing is
 * handed back with its attempt refunded (production 0ba2eb30, 2026-11-18
 * 01:00–01:45Z: DuckDuckGo refused for longer than a fragment waits, 27
 * fragments failed "no readable source … none from web search", each spending
 * one of its two attempts, and goal wst_7b4fcbb5f2384f31b6c3's rounds ended
 * without a report). When search answered, the same failure is still the
 * fragment's own and spends its attempt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { freeLaneTick, resetFreeLaneFitness } from '../server/services/freeLane/worker.ts';
import { resetSearchState, webSearch, webSearchRefusing } from '../server/services/sources/discover.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };

/** Every page the model names is gone. */
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: false,
  requestedUrl: url,
  finalUrl: null,
  status: 404,
  retrievedAt: new Date().toISOString(),
  reason: 'HTTP_ERROR' as never,
  detail: '404',
});

const completer: Completer = async (_config, _name, _system, prompt) =>
  prompt.includes('Name up to') ? JSON.stringify({ urls: ['https://www.example.gov/rates/2026-contractor-rates.htm'] }) : '{}';

let play: TestProject;

async function fragmentQueued(): Promise<string> {
  const projectId = play.project.id;
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const title = 'Contractor rates';
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'What does PA DEP pay abandoned mine reclamation contractors?',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'amr-rates',
      question: 'What does PA DEP pay abandoned mine reclamation contractors per job?',
      geography: 'Pennsylvania',
      timeframe: '2026',
      population: 'Reclamation contractors',
      definitions: 'Contract award value',
      requiredEvidence: [{ id: 'price', description: 'a published award value', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official procurement records'],
      excludedSourceTypes: [],
      completionCriteria: ['One award value'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  await createBin({
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
  const definition = workType('RESEARCH_FRAGMENT');
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_FRAGMENT',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment!.id,
    createdByType: 'SYSTEM',
  });
  return item.id;
}

async function events(workItemId: string): Promise<{ outcome: string; reason: string }[]> {
  return getDb().all<{ outcome: string; reason: string }>(
    "SELECT outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ?",
    [workItemId],
  );
}

/** Both DuckDuckGo endpoints answer with an anomaly page. */
async function searchRefuses(): Promise<void> {
  const refused = (async () => new Response('', { status: 202 })) as unknown as typeof fetch;
  expect(await webSearch('pa dep abandoned mine reclamation contractor rates', { fetchImpl: refused, sleepMs: async () => {} })).toEqual([]);
  expect(webSearchRefusing()).toBe(true);
}

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
  resetSearchState();
  await setBrainOnlyMode(true, 'test', 'free lane search outage suite');
});

afterEach(() => resetSearchState());

describe('a fragment with no readable source', () => {
  it('is handed back with its attempt refunded while web search is refusing', async () => {
    await searchRefuses();
    const id = await fragmentQueued();
    await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    const seen = await events(id);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toMatch(/no readable source among \d+ candidate page\(s\), none from web search/);
    expect(seen[0]!.outcome).toBe('RELEASED_TRANSIENT');
    const item = await getWorkItem(id);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(0);
  });

  it('spends its attempt when web search answered', async () => {
    expect(webSearchRefusing()).toBe(false);
    const id = await fragmentQueued();
    await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    const seen = await events(id);
    expect(seen.map((e) => e.outcome)).toEqual(['FAILED_RETRYABLE']);
    expect((await getWorkItem(id))?.attemptCount).toBe(1);
  });
});
