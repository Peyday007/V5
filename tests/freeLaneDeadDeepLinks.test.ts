/**
 * FREE_LANE:NO_READABLE_SOURCE, dead deep links — every candidate is a 404 on a host that is
 * alive, so the fragment ended "no readable source" although the host's own pages were readable.
 * A 404/410 on a non-root path now opens that host's origin once per fragment; a 403, a 429 and a
 * host-level failure open nothing extra.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { deadDeepLinkOrigin, freeLaneTick, resetUnreachableHosts } from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
let play: TestProject;
let layerId = '';

function refused(url: string, reason: string, status: number | null = null): SourceFetch {
  return { readable: false, requestedUrl: url, finalUrl: null, status, retrievedAt: new Date().toISOString(), reason: reason as never, detail: reason };
}

async function packet(projectId: string, title: string): Promise<{ orchestration: ResearchOrchestration; fragment: ResearchFragment }> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'What does a human receptionist cost per hour in the US?',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'receptionist-wage',
      question: 'What is the US median hourly wage of a receptionist?',
      geography: 'United States',
      timeframe: '2024',
      population: 'Receptionists',
      definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'an official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official statistics'],
      excludedSourceTypes: [],
      completionCriteria: ['One official wage figure'],
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
  return { orchestration, fragment: fragment! };
}

async function enqueue(projectId: string, orchestration: ResearchOrchestration, fragment: ResearchFragment): Promise<void> {
  const definition = workType('RESEARCH_FRAGMENT');
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_FRAGMENT',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment.id,
    createdByType: 'SYSTEM',
  });
}

/** Run one fragment whose model names `urls`, with `answer` deciding every fetch; returns what was fetched. */
async function run(
  urls: string[],
  answer: (url: string) => SourceFetch,
  title: string,
  claims: Record<string, unknown>[] = [],
): Promise<{ fetched: string[]; failed: number; submitted: number }> {
  const fetched: string[] = [];
  const fetchSource = async (url: string): Promise<SourceFetch> => {
    fetched.push(url);
    return answer(url);
  };
  // One model, two questions: which pages to read, then (when Brain shows it sentences) which claims they state.
  const completer: Completer = async (_c, _m, _s, prompt) =>
    JSON.stringify(/numbered sentences/.test(prompt) ? { claims } : { urls, search: 'q' });
  const p = await packet(play.project.id, title);
  await enqueue(play.project.id, p.orchestration, p.fragment);
  const result = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
  return { fetched, failed: result.failed, submitted: result.submitted };
}

beforeEach(async () => {
  resetUnreachableHosts();
  play = await freshProject();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane dead deep links');
});

describe('deadDeepLinkOrigin', () => {
  it('is the origin for a 404 or 410 on a non-root path, and nothing else', () => {
    expect(deadDeepLinkOrigin('https://live.example/a/b?x=1', 'HTTP_ERROR', 404)).toBe('https://live.example/');
    expect(deadDeepLinkOrigin('http://live.example:8080/a', 'HTTP_ERROR', 410)).toBe('http://live.example:8080/');
    expect(deadDeepLinkOrigin('https://live.example/', 'HTTP_ERROR', 404)).toBeNull();
    expect(deadDeepLinkOrigin('https://live.example/a', 'HTTP_ERROR', 403)).toBeNull();
    expect(deadDeepLinkOrigin('https://live.example/a', 'HTTP_ERROR', 429)).toBeNull();
    expect(deadDeepLinkOrigin('https://live.example/a', 'HTTP_ERROR', null)).toBeNull();
    for (const reason of ['DNS_FAILED', 'NETWORK_ERROR', 'TIMEOUT', 'EMPTY']) {
      expect(deadDeepLinkOrigin('https://live.example/a', reason, 404)).toBeNull();
    }
    expect(deadDeepLinkOrigin('not a url', 'HTTP_ERROR', 404)).toBeNull();
  });
});

describe('dead deep links on a live host', () => {
  it('reads the origin once per host when every candidate is a 404 deep link', async () => {
    const answer = (url: string): SourceFetch => refused(url, 'HTTP_ERROR', 404);
    const { fetched, failed } = await run(
      ['https://live.example/a', 'https://live.example/b', 'https://other.example/x'],
      answer,
      'origin once per host',
    );
    expect(failed).toBe(1);
    expect(fetched.filter((u) => u === 'https://live.example/').length).toBe(1);
    expect(fetched.filter((u) => u === 'https://other.example/').length).toBe(1);
    // The origin itself answering 404 queues nothing further.
    expect(fetched.length).toBe(5);
  });

  it('turns the recorded failure into a readable source when the origin is readable', async () => {
    const text = 'The median hourly wage of receptionists in the United States was 17.50 dollars in 2024. '.repeat(6);
    const answer = (url: string): SourceFetch =>
      url === 'https://live.example/'
        ? { readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: new Date().toISOString(), sha256: 'x', text, truncated: false, totalChars: text.length }
        : refused(url, 'HTTP_ERROR', 404);
    const claim = {
      source: 1,
      sentences: [1],
      claim: 'The US median hourly wage of a receptionist was 17.50 dollars in 2024.',
      evidence_lane: 'wage',
      confidence: 0.8,
      source_class: 'PRIMARY',
    };
    const { fetched, failed, submitted } = await run(['https://live.example/deep/dead-link'], answer, 'origin readable', [claim]);
    expect(fetched).toContain('https://live.example/');
    // The recorded failure was "no readable source": with a readable origin the fragment must not fail.
    expect(failed).toBe(0);
    expect(submitted).toBe(1);
  });

  it('opens nothing extra for a 403, a 429 or a host-level failure', async () => {
    for (const [reason, status] of [['HTTP_ERROR', 403], ['HTTP_ERROR', 429], ['DNS_FAILED', null], ['NETWORK_ERROR', null], ['TIMEOUT', null]] as const) {
      resetUnreachableHosts();
      const { fetched } = await run([`https://${reason.toLowerCase()}${status ?? ''}.example/deep`], (url) => refused(url, reason, status), `no fallback ${reason} ${status}`);
      expect(fetched.every((u) => u.endsWith('/deep'))).toBe(true);
    }
  });
});
