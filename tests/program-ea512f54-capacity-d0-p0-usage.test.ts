/**
 * CAP-16-3 (S-0170): "Collect per-stage … model calls avoided … CPU/RAM/DB/network
 * use". A reviewer found the model-interpretation and evidence-verification
 * stages always reported model calls avoided as NOT_MEASURED, network was never
 * recorded, and CPU/RAM was one process-wide figure. Each free-lane item now
 * meters what it used while it ran (itemMeter.ts) onto its FREE_LANE_ITEM row,
 * and stageCapacity sums those readings by stage.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { freeLaneTick, meteredIo, resetFreeLaneFitness, resetPurposeCache } from '../server/services/freeLane/worker.ts';
import { ItemMeters, type ItemUsage } from '../server/services/freeLane/itemMeter.ts';
import { stageCapacity, sumUsage, usageOf } from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const SECOND_URL = 'https://www.bls.gov/oes/current/oes434171.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);

const completer: Completer = async (_config, _name, _system, prompt) => {
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL, SECOND_URL], search: 'receptionist wage' });
  if (prompt.includes('Extract the material claims')) {
    const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
    const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
    return JSON.stringify({
      claims: [
        {
          claim: 'The US median hourly wage for receptionists was $17.39 in May 2024.',
          claim_type: 'SOURCED_FACT',
          source: Number(ref?.[1]),
          sentences: [Number(ref?.[2])],
          source_title: 'Receptionists — Occupational Outlook Handbook',
          source_publisher: 'U.S. Bureau of Labor Statistics',
          source_date: '2025-04-18',
          evidence_lane: 'wage',
          primary_source: true,
          confidence: 0.9,
        },
      ],
    });
  }
  return '{}';
};

const fetchSource = async (url: string): Promise<SourceFetch> =>
  url === PAGE_URL || url === SECOND_URL
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

let play: TestProject;
let layerId = '';

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
  resetPurposeCache();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane usage suite');
});

const usage = (over: Partial<ItemUsage> = {}): ItemUsage => ({
  modelCalls: 0, modelCallsAvoided: 0, cpuMicros: 0, peakRssBytes: 0, rssShareBytes: 0,
  dbCalls: 0, dbMs: 0, networkBytesOut: 0, networkBytesIn: 0, ...over,
});

describe('ItemMeters apportions process CPU among the items in flight', () => {
  it('divides CPU equally while items overlap and keeps the peak RSS each saw', () => {
    let cpu = 0;
    let rss = 100;
    const meters = new ItemMeters({ cpu: () => cpu, rss: () => rss });
    meters.open('a');
    cpu += 1_000; // a alone
    meters.open('b');
    cpu += 2_000; // a and b together
    rss = 500;
    const a = meters.close('a')!;
    cpu += 4_000; // b alone
    rss = 300;
    const b = meters.close('b')!;
    expect(a.cpuMicros).toBe(1_000 + 1_000);
    expect(b.cpuMicros).toBe(1_000 + 4_000);
    // No CPU is attributed twice: the items' shares sum to what the process spent.
    expect(a.cpuMicros + b.cpuMicros).toBe(7_000);
    expect(a.peakRssBytes).toBe(500);
    expect(b.peakRssBytes).toBe(500);
    expect(a.rssShareBytes).toBe(250); // 500 bytes, two items in flight
    expect(b.rssShareBytes).toBe(300);
    expect(meters.size).toBe(0);
  });

  it('meteredIo counts model calls and the bytes each call, page and search moved', async () => {
    const u = usage();
    const io = meteredIo(u, {
      completer: async () => 'reply',
      fetchSource,
      search: async () => ['https://a.test/x'],
    });
    expect(await io.completer(CONFIG, 'brain-a', 'sys', 'prompt', { maxTokens: 10 })).toBe('reply');
    await io.fetchSource(PAGE_URL);
    await io.search('q');
    expect(u.modelCalls).toBe(1);
    expect(u.networkBytesOut).toBe(3 + 6 + PAGE_URL.length + 1);
    expect(u.networkBytesIn).toBe(5 + Buffer.byteLength(PAGE) + JSON.stringify(['https://a.test/x']).length);
  });
});

describe('stage capacity sums each stage\'s own usage (CAP-16-3)', () => {
  it('reports model calls avoided and CPU/RAM/DB/network for the evidence-verification stage from its items', async () => {
    const lane = (workloadClass: string, u: ItemUsage | null) =>
      recordBinEvent({
        eventType: 'FREE_LANE_ITEM', workloadClass, outcome: 'SUBMITTED', reason: 'model brain-a', durationMs: 10,
        ...(u ? { measures: { usage: u } } : {}),
      });
    await lane('RESEARCH_AUDIT', usage({ modelCalls: 1, modelCallsAvoided: 1, cpuMicros: 2_000_000, peakRssBytes: 900, rssShareBytes: 300, dbCalls: 4, dbMs: 40, networkBytesOut: 1000, networkBytesIn: 200 }));
    await lane('RESEARCH_VERIFY', usage({ modelCalls: 2, cpuMicros: 500_000, peakRssBytes: 700, rssShareBytes: 100, dbCalls: 3, dbMs: 30, networkBytesOut: 50, networkBytesIn: 5000 }));
    await lane('RESEARCH_VERIFY', null); // written before the meter existed: counted in the window, never guessed

    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    const verify = report.stages.find((s) => s.stage === 'evidence-verification')!;
    expect(verify.modelCallsAvoided).toEqual({ measured: true, value: 1 });
    expect(verify.resources).toEqual({
      measured: true,
      value: {
        scope: 'stage', itemsMetered: 2, itemsInWindow: 3, modelCalls: 3, cpuSeconds: 2.5, cpuBound: 'UPPER',
        peakRssBytes: 900, meanRssShareBytes: 200, dbCalls: 7, dbMs: 70, networkBytesOut: 1050, networkBytesIn: 5200,
      },
    });
    // A stage none of whose items recorded usage still says why, rather than reporting zero.
    const model = report.stages.find((s) => s.stage === 'model-interpretation')!;
    expect(model.modelCallsAvoided.measured).toBe(false);
    expect(model.resources.measured).toBe(false);
  });

  it('usageOf reads the row and sumUsage refuses to invent a reading', () => {
    expect(usageOf('{"discovery":{}}')).toBeNull();
    expect(usageOf('not json')).toBeNull();
    expect(usageOf({ usage: { modelCalls: 2, networkBytesIn: 'x' } })).toMatchObject({ modelCalls: 2, networkBytesIn: 0 });
    expect(sumUsage([null, null], 2)).toEqual({ measured: false });
  });

  it('a real free-lane fragment records its model calls, the call it avoided, and its network and database use', async () => {
    const projectId = play.project.id;
    const title = 'AI receptionist pricing';
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
    const orchestration = await createOrchestration({
      projectId, layerId, runId: run.id, title,
      assignment: 'What does a human receptionist cost per hour in the US?',
      provider: 'WORKER', autoApprove: false,
    });
    const [fragment] = await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'receptionist-wage',
        question: 'What is the US median hourly wage of a receptionist?',
        geography: 'United States', timeframe: '2024', population: 'Receptionists', definitions: 'Median hourly wage',
        requiredEvidence: [{ id: 'wage', description: 'an official wage statistic', necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['official statistics'], excludedSourceTypes: [], completionCriteria: ['One official wage figure'],
        dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
      },
    ]);
    await createBin({
      projectId, kind: 'RESEARCH_PACKET', title, objective: title, orchestrationId: orchestration.id,
      manifest: {
        objective: title, why: 'test', lineage: { projectId, layerId, goal: title, orchestrationId: orchestration.id },
        units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [],
        budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [],
      },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const definition = workType('RESEARCH_FRAGMENT');
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM',
    });

    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);

    const row = await getDb().get<{ measures: string }>(
      "SELECT measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ?",
      [item.id],
    );
    const recorded = usageOf(row!.measures)!;
    // One call naming pages, one extracting claims; two pages were readable, so
    // the second source round's call was not needed.
    expect(recorded.modelCalls).toBe(2);
    expect(recorded.modelCallsAvoided).toBe(1);
    expect(recorded.networkBytesIn).toBeGreaterThanOrEqual(2 * Buffer.byteLength(PAGE));
    expect(recorded.networkBytesOut).toBeGreaterThan(0);
    expect(recorded.dbCalls).toBeGreaterThan(0);
    expect(recorded.peakRssBytes).toBeGreaterThan(0);

    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    const model = report.stages.find((s) => s.stage === 'model-interpretation')!;
    expect(model.modelCallsAvoided).toEqual({ measured: true, value: 1 });
    expect(model.resources.measured).toBe(true);
    if (model.resources.measured) {
      expect(model.resources.value.networkBytesIn).toBe(recorded.networkBytesIn);
      expect(model.resources.value.itemsMetered).toBe(1);
    }
  });
});
