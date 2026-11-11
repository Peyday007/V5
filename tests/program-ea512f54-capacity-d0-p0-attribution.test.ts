/**
 * CAP-16-3, attribution: a productive free-lane job is counted against the
 * purpose of the bin that owns its work item. Research items carry no `bin_id`
 * (their owner is the newest bin of their orchestration), so the producer —
 * `takeOne` in worker.ts — must name that bin on the FREE_LANE_ITEM row it
 * writes. Before the fix every such row had bin_id NULL and stage capacity
 * reported every productive job as UNATTRIBUTED.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { freeLaneTick, resetFreeLaneFitness, resetPurposeCache } from '../server/services/freeLane/worker.ts';
import { stageCapacity } from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);

const completer: Completer = async (_config, _name, _system, prompt) => {
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL], search: 'receptionist wage' });
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

let play: TestProject;
let layerId = '';

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
  resetPurposeCache();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane attribution suite');
});

describe('free-lane purpose attribution (CAP-16-3)', () => {
  it('writes the owning bin on the FREE_LANE_ITEM row, so the job is attributed to that bin’s purpose', async () => {
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
    const bin = await createBin({
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
    // The research item itself carries no bin: its owner is reached through the orchestration.
    expect((await getDb().get<{ bin_id: string | null }>('SELECT bin_id FROM work_items WHERE id = ?', [item.id]))!.bin_id).toBeNull();
    const purpose = (await getDb().get<{ purpose: string | null }>('SELECT purpose FROM bins WHERE id = ?', [bin.id]))!.purpose;
    expect(purpose).toBe('PLAY_RESEARCH');

    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);

    const rows = await getDb().all<{ bin_id: string | null; outcome: string }>(
      "SELECT bin_id, outcome FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ?",
      [item.id],
    );
    expect(rows).toEqual([{ bin_id: bin.id, outcome: 'SUBMITTED' }]);

    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    expect(report.purposesSumToTotal).toBe(true);
    const byPurpose = Object.fromEntries(report.purposes.map((p) => [p.purpose, p.productiveJobs]));
    expect(byPurpose.PLAY_RESEARCH).toBe(1);
    expect(byPurpose.UNATTRIBUTED).toBeUndefined();
  });
});
