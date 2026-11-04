/**
 * The free research lane (§85): research Claude routines no longer take is
 * claimed, answered and gated through the ordinary queue and tools, with a free
 * model (stubbed here) as the worker and Brain opening every source itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, listBinEvents } from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, listClaimsForFragment } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { ensureFreeWorkers, firstJson, freeLaneTick, quotedIn, resetFreeLaneMemberships } from '../server/services/freeLane/worker.ts';
import { freeLaneMayTakeImprovement, resetActivationCache } from '../server/services/improvement/activation.ts';
import { createLayer } from '../server/repos/layers.ts';
import { IMPROVEMENT_RESEARCH_SLOT_CAP } from '../server/domain/improvement.ts';
import { createUser } from '../server/repos/identity.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { freeLaneReading, laneCoverage } from '../server/services/freeLane/coverage.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);
const QUOTE = 'The median hourly wage for receptionists was $17.39 in May 2024.';

let play: TestProject;
let layerId = '';

const fetchSource = async (url: string): Promise<SourceFetch> =>
  url === PAGE_URL
    ? {
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
      }
    : { readable: false, requestedUrl: url, finalUrl: null, status: 404, retrievedAt: new Date().toISOString(), reason: 'HTTP_ERROR' as never, detail: '404' };

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
  play = await freshProject();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane suite');
});

async function strikeThree(completer: Completer, itemId: string, rounds = 4): Promise<Array<{ failed: number; claimed: number }>> {
  const ticks = [];
  for (let i = 0; i < rounds; i += 1) {
    ticks.push(await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] }));
    vi.setSystemTime(Date.now() + 60 * 60_000); // past any cooldown
    resetFreeLaneMemberships();
  }
  void itemId;
  return ticks;
}

async function outcomes(itemId: string): Promise<Array<{ outcome: string }>> {
  return await getDb().all<{ outcome: string }>(
    "SELECT outcome FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ? ORDER BY at",
    [itemId],
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FREE_LANE:PROVIDER_EXHAUSTED', () => {
  for (const status of ['429', '503']) {
    it(`never spends the attempt on repeated HTTP ${status}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { orchestration, fragment } = await packet(play.project.id);
      const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
      const down: Completer = async () => {
        throw new Error(`cheap lane HTTP ${status}`);
      };
      await strikeThree(down, itemId);
      const item = await getWorkItem(itemId);
      expect(item?.state).toBe('QUEUED');
      expect(item?.attemptCount).toBe(0);
      const events = await outcomes(itemId);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every((e) => e.outcome === 'RELEASED_TRANSIENT')).toBe(true);
    });
  }

  it('still fails an item whose model keeps returning no usable JSON', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const junk: Completer = async () => 'not json at all';
    await strikeThree(junk, itemId);
    const events = await outcomes(itemId);
    expect(events.some((e) => e.outcome === 'FAILED_RETRYABLE')).toBe(true);
  });

  it('escalates a model that stays down for hours to a retryable failure instead of rotating forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 429');
    };
    await strikeThree(down, itemId, 14);
    const events = await outcomes(itemId);
    expect(events.filter((e) => e.outcome === 'RELEASED_TRANSIENT').length).toBeGreaterThanOrEqual(10);
    expect(events.some((e) => e.outcome === 'FAILED_RETRYABLE')).toBe(true);
  });
});
