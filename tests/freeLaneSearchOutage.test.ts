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
import {
  ensureFreeWorkers,
  fragmentAdmissible,
  fragmentsWorkedNow,
  freeLaneSkips,
  freeLaneTick,
  resetFreeLaneFitness,
  SEARCH_CANNOT_FEED,
  takeOne,
} from '../server/services/freeLane/worker.ts';
import {
  fragmentSearchRoom,
  maxWaiters,
  readWithoutAnswerFor,
  rememberedFor,
  resetSearchState,
  SEARCH_OUTAGE_FRAGMENTS,
  SEARCHES_PER_FRAGMENT,
  webSearch,
  webSearchRefusing,
} from '../server/services/sources/discover.ts';
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

/*
 * Production, 2026-11-18 15:00–17:00Z: with DuckDuckGo refusing, every candidate
 * was a Wikipedia page; the model read them and listed nothing ("None of the
 * provided sources contain any sentence about GitHub's bug bounty program"), and
 * the fragment and its repair spent twelve attempts on the same four pages.
 */
const WIKI = ['https://en.wikipedia.org/wiki/Mine_reclamation', 'https://en.wikipedia.org/wiki/Pennsylvania_Department_of_Environmental_Protection'];
const PAGE =
  'Abandoned mine reclamation in Pennsylvania is overseen by the PA DEP. ' +
  'Reclamation contractors restore land disturbed by mining, and the history of abandoned mine lands goes back two centuries. '.repeat(4);
const readWiki = async (url: string): Promise<SourceFetch> => ({
  readable: true,
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  contentType: 'text/html',
  retrievedAt: new Date().toISOString(),
  sha256: 'x',
  text: PAGE,
  truncated: false,
  totalChars: PAGE.length,
});
const listsNone: Completer = async (_config, _name, _system, prompt) =>
  prompt.includes('Name up to')
    ? JSON.stringify({ urls: [] })
    : JSON.stringify({ claims: [], none_because: 'the sources are about something else: none states a contractor payment' });

describe('a fragment whose model read only encyclopedia pages and listed nothing', () => {
  it('is handed back with its attempt refunded while web search is refusing', async () => {
    await searchRefuses();
    const id = await fragmentQueued();
    await freeLaneTick({ config: CONFIG, completer: listsNone, fetchSource: readWiki, search: async () => WIKI });
    const seen = await events(id);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toMatch(/0 claim\(s\) offered.*listed none because/);
    expect(seen[0]!.outcome).toBe('RELEASED_TRANSIENT');
    expect((await getWorkItem(id))?.attemptCount).toBe(0);
  });

  it('spends its attempt when web search answered, and the next attempt at the question does not reopen those pages', async () => {
    const id = await fragmentQueued();
    await freeLaneTick({ config: CONFIG, completer: listsNone, fetchSource: readWiki, search: async () => WIKI });
    expect((await events(id)).map((e) => e.outcome)).toEqual(['FAILED_RETRYABLE']);
    expect((await getWorkItem(id))?.attemptCount).toBe(1);
    const question = 'What does PA DEP pay abandoned mine reclamation contractors per job?';
    expect([...readWithoutAnswerFor(question)].sort()).toEqual([...WIKI].sort());

    // A replacement item for the same question (§15): the same search answers the same pages, and they are not opened.
    const again = await fragmentQueued();
    const opened: string[] = [];
    await freeLaneTick({
      config: CONFIG,
      completer: listsNone,
      fetchSource: async (url) => {
        opened.push(url);
        return readWiki(url);
      },
      search: async () => WIKI,
    });
    expect(opened.filter((url) => WIKI.includes(url))).toEqual([]);
    const [row] = await events(again);
    expect(row?.reason).toMatch(/no readable source among 0 candidate page\(s\).*READ_BEFORE_NO_CLAIM/);
  });
});

/*
 * Production, 24 h to 2026-11-25 06:00Z: the GPU free lane handed 2,627
 * research fragments back RELEASED_TRANSIENT and submitted 342. With the keyed
 * provider's daily ceiling spent and DuckDuckGo answering 202, 1,773 runs ended
 * "no readable source … none from web search" and most of the rest "0 claim(s)
 * offered" over encyclopedia pages — each run its model calls and two refused
 * searches, refunded, and claimed again at once by the next free slot. A
 * fragment is now started only while web search can feed it; the rest wait
 * QUEUED with no lease, no attempt and no model call.
 */
describe('how many fragments web search can feed', () => {
  it('is what the search queue holds, a few while search refuses, and unbounded while a keyed provider answers', async () => {
    expect(fragmentSearchRoom({})).toBe(Math.floor(maxWaiters() / SEARCHES_PER_FRAGMENT));
    expect(fragmentSearchRoom({ BRAIN_SEARCH_API_KEY: 'AIzaSyTEST-not-a-real-key-0123456789abc', BRAIN_SEARCH_ENGINE_ID: 'a1b2c3d4e5f6g7h8i' })).toBe(Number.POSITIVE_INFINITY);
    await searchRefuses();
    expect(fragmentSearchRoom({})).toBe(SEARCH_OUTAGE_FRAGMENTS);
    expect(fragmentAdmissible(SEARCH_OUTAGE_FRAGMENTS - 1, fragmentSearchRoom({}))).toBe(true);
    expect(fragmentAdmissible(SEARCH_OUTAGE_FRAGMENTS, fragmentSearchRoom({}))).toBe(false);
  });

  it('a query that returned pages is not bought again for hours; an empty answer is asked again after ten minutes', async () => {
    expect(rememberedFor(['https://a.example/'])).toBe(6 * 3_600_000);
    expect(rememberedFor([])).toBe(10 * 60_000);
    const clock = { t: Date.parse('2026-11-25T01:00:00Z') };
    let sent = 0;
    const answers = (async () => {
      sent += 1;
      return new Response('<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpages.example%2Frates">r</a>', { status: 200 });
    }) as unknown as typeof fetch;
    const deps = { fetchImpl: answers, nowMs: () => clock.t, env: {} as NodeJS.ProcessEnv, sleepMs: async () => {} };
    expect(await webSearch('pa dep reclamation contractor award values', deps)).toEqual(['https://pages.example/rates']);
    clock.t += 60 * 60_000;
    expect(await webSearch('pa dep reclamation contractor award values', deps)).toEqual(['https://pages.example/rates']);
    expect(sent).toBe(1);
  });
});

describe('while web search is refusing', () => {
  it('works only the fragments it can feed, and the next waits queued, unleased and unspent until search answers', async () => {
    await searchRefuses();
    const ids: string[] = [];
    for (let i = 0; i < SEARCH_OUTAGE_FRAGMENTS + 1; i += 1) ids.push(await fragmentQueued());
    const workers = await ensureFreeWorkers(CONFIG);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = 0;
    let allIn!: () => void;
    const working = new Promise<void>((resolve) => (allIn = resolve));
    // Each admitted fragment's first model call waits, so the admitted ones are all in flight together.
    const held: Completer = async (config, name, system, prompt, options) => {
      if (prompt.includes('Name up to') && entered < SEARCH_OUTAGE_FRAGMENTS) {
        entered += 1;
        if (entered === SEARCH_OUTAGE_FRAGMENTS) allIn();
        await gate;
      }
      return completer(config, name, system, prompt, options);
    };
    const base = { workers, completer: held, fetchSource, search: async () => [], config: CONFIG };
    const admitted = Array.from({ length: SEARCH_OUTAGE_FRAGMENTS }, () => takeOne({ ...base, worker: workers[0]!, index: 0 }));
    await working;
    expect(fragmentsWorkedNow()).toBe(SEARCH_OUTAGE_FRAGMENTS);
    expect((await takeOne({ ...base, worker: workers[0]!, index: 0 })).claimed).toBeNull();
    expect((await takeOne({ ...base, worker: workers[1]!, index: 1, spillover: true })).claimed).toBeNull();
    expect(Object.keys(freeLaneSkips()).some((key) => key.includes(SEARCH_CANNOT_FEED.slice(0, 40)))).toBe(true);
    release();
    const done = await Promise.all(admitted);
    expect(done.every((one) => one.claimed?.workType === 'RESEARCH_FRAGMENT')).toBe(true);
    expect(fragmentsWorkedNow()).toBe(0);

    const waiting = ids.filter((id) => !done.some((one) => one.claimed?.workItemId === id));
    expect(waiting).toHaveLength(1);
    const row = await getDb().get<{ state: string; attempt_count: number; lease_generation: number }>(
      'SELECT state, attempt_count, lease_generation FROM work_items WHERE id = ?',
      [waiting[0]!],
    );
    expect(row).toMatchObject({ state: 'QUEUED', attempt_count: 0, lease_generation: 0 });
    expect(await events(waiting[0]!)).toEqual([]);

    // Search answers again: the waiting fragment is worked.
    resetSearchState();
    const next = await takeOne({ workers, worker: workers[0]!, index: 0, completer, fetchSource, search: async () => [], config: CONFIG });
    expect(next.claimed?.workItemId).toBe(waiting[0]);
    expect(fragmentsWorkedNow()).toBe(0);
  });
});
