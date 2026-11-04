/**
 * FREE_LANE:NO_READABLE_SOURCE — a fragment whose every candidate sits on a host Brain cannot
 * reach ends "no readable source", and the next fragment must not spend its candidates on those
 * hosts again. A page-level failure (404, empty) must not poison its host.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  forgiveHost,
  freeLaneTick,
  isRememberedUnreachable,
  rememberUnreachable,
  resetUnreachableHosts,
} from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
let play: TestProject;
let layerId = '';

function refused(url: string, reason: string, status: number | null = null): SourceFetch {
  return { readable: false, requestedUrl: url, finalUrl: null, status, retrievedAt: new Date().toISOString(), reason: reason as never, detail: reason };
}

async function packet(projectId: string, title = 'AI receptionist pricing'): Promise<{ orchestration: ResearchOrchestration; fragment: ResearchFragment }> {
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

async function enqueue(projectId: string, type: string, orchestration: ResearchOrchestration, fragment: ResearchFragment): Promise<string> {
  const definition = workType(type);
  const item = await enqueueWork({
    projectId,
    workType: type,
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment.id,
    createdByType: 'SYSTEM',
  });
  return item.id;
}

beforeEach(async () => {
  resetUnreachableHosts();
  play = await freshProject();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane unreachable hosts');
});

describe('unreachable host memory', () => {
  it('remembers only host-level refusals, and forgets them after the TTL', () => {
    rememberUnreachable('https://dead.example/a', 'DNS_FAILED', 1_000);
    rememberUnreachable('https://notfound.example/a', 'HTTP_ERROR', 1_000);
    rememberUnreachable('https://empty.example/a', 'EMPTY', 1_000);
    expect(isRememberedUnreachable('https://dead.example/other', 2_000)).toBe(true);
    expect(isRememberedUnreachable('https://notfound.example/b', 2_000)).toBe(false);
    expect(isRememberedUnreachable('https://empty.example/b', 2_000)).toBe(false);
    expect(isRememberedUnreachable('https://dead.example/other', 1_000 + 11 * 60_000)).toBe(false);
  });

  it('a single timeout does not hide a live host; a second inside the TTL does; a success clears the strike', () => {
    rememberUnreachable('https://slow.example/a', 'TIMEOUT', 1_000);
    expect(isRememberedUnreachable('https://slow.example/b', 2_000)).toBe(false);
    rememberUnreachable('https://slow.example/a', 'TIMEOUT', 3_000);
    expect(isRememberedUnreachable('https://slow.example/b', 4_000)).toBe(true);
    rememberUnreachable('https://ok.example/a', 'TIMEOUT', 1_000);
    forgiveHost('https://ok.example/a');
    rememberUnreachable('https://ok.example/a', 'TIMEOUT', 2_000);
    expect(isRememberedUnreachable('https://ok.example/a', 3_000)).toBe(false);
  });

  it('a second fragment does not fetch hosts the first found unreachable, and the retry prompt names them', async () => {
    const fetched: string[] = [];
    const fetchSource = async (url: string): Promise<SourceFetch> => {
      fetched.push(url);
      return refused(url, 'DNS_FAILED');
    };
    const prompts: string[] = [];
    const completer: Completer = async (_c, _n, _s, prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ urls: ['https://dead.example/a', 'https://dead.example/b', 'https://gone.example/x'], search: 'q' });
    };
    const one = await packet(play.project.id, 'first');
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', one.orchestration, one.fragment);
    const first = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(first.failed).toBe(1);
    const spent = fetched.length;
    expect(spent).toBeGreaterThan(0);

    const two = await packet(play.project.id, 'second');
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', two.orchestration, two.fragment);
    prompts.length = 0;
    const second = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(second.failed).toBe(1);
    expect(fetched.length).toBe(spent); // no fetch was spent on a remembered host
    expect(prompts.some((p) => p.includes('Brain cannot reach these hosts') && p.includes('dead.example'))).toBe(true);
  });

  it('a 404 does not poison its host', async () => {
    const fetched: string[] = [];
    const fetchSource = async (url: string): Promise<SourceFetch> => {
      fetched.push(url);
      return refused(url, 'HTTP_ERROR', 404);
    };
    const completer: Completer = async () => JSON.stringify({ urls: ['https://site.example/a'], search: 'q' });
    for (const title of ['one', 'two']) {
      const p = await packet(play.project.id, title);
      await enqueue(play.project.id, 'RESEARCH_FRAGMENT', p.orchestration, p.fragment);
      await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    }
    expect(fetched.filter((u) => u === 'https://site.example/a').length).toBeGreaterThanOrEqual(2);
    expect(isRememberedUnreachable('https://site.example/a')).toBe(false);
  });
});
