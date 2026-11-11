/**
 * CAP-16-3: productive free-lane work is attributed to the purpose of the bin
 * that owns it. The FREE_LANE_ITEM producer used to write no `bin_id`, so the
 * stage report's join to `bins.purpose` found nothing and every productive job
 * was reported UNATTRIBUTED.
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
import { freeLaneTick, resetPurposeCache } from '../server/services/freeLane/worker.ts';
import { stageCapacity } from '../server/services/freeLane/stageCapacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

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

let play: TestProject;

/** One research packet with one queued fragment, driven by one bin. */
async function queueFragment(i: number): Promise<{ binId: string; workItemId: string }> {
  const layerId = (await play.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId: play.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
  const orchestration = await createOrchestration({ projectId: play.project.id, layerId, runId: run.id, title: `Receptionist wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId: play.project.id, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
    question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
    population: 'Receptionists', definitions: 'Median hourly wage',
    requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
    acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
  }]);
  const bin = await createBin({
    projectId: play.project.id, kind: 'RESEARCH_PACKET', title: `Receptionist wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
    manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
    completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
  });
  const def = workType('RESEARCH_FRAGMENT');
  const item = await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
  return { binId: bin.id, workItemId: item.id };
}

async function purposeOf(binId: string): Promise<string | null> {
  return (await getDb().get<{ purpose: string | null }>('SELECT purpose FROM bins WHERE id = ?', [binId]))?.purpose ?? null;
}

beforeEach(async () => {
  play = await freshProject();
  await setBrainOnlyMode(true, 'test', 'purpose attribution suite');
  resetPurposeCache();
  await getDb().run('DELETE FROM bin_events', []);
});

describe('productive free-lane work is attributed to its owning bin (CAP-16-3)', () => {
  it('writes the owning bin on every FREE_LANE_ITEM event, so no productive job is UNATTRIBUTED', async () => {
    const queued = [await queueFragment(0), await queueFragment(1)];
    for (let step = 0; step < 5; step += 1) {
      await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    }
    const events = await getDb().all<{ bin_id: string | null; work_item_id: string; outcome: string }>(
      "SELECT bin_id, work_item_id, outcome FROM bin_events WHERE event_type = 'FREE_LANE_ITEM'",
      [],
    );
    const submitted = events.filter((e) => e.outcome === 'SUBMITTED');
    expect(submitted.length).toBeGreaterThan(0);
    for (const event of events) expect(event.bin_id).not.toBeNull();
    // The fragment items carry the bin that drives their packet.
    for (const q of queued) {
      const mine = events.find((e) => e.work_item_id === q.workItemId);
      if (mine) expect(mine.bin_id).toBe(q.binId);
    }

    const report = await stageCapacity({ hours: 1 });
    expect(report.totalProductiveJobs).toBe(submitted.length);
    expect(report.purposesSumToTotal).toBe(true);
    expect(report.purposes.find((p) => p.purpose === 'UNATTRIBUTED')).toBeUndefined();
    const expected = await purposeOf(queued[0]!.binId);
    expect(expected).not.toBeNull();
    expect(report.purposes.map((p) => p.purpose)).toContain(expected);
  }, 60_000);

  it('attributes an event written without a bin through its work item, once', async () => {
    const q = await queueFragment(7);
    // An event as the producer wrote it before the fix: no bin_id, only the item.
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', projectId: play.project.id, workItemId: q.workItemId, workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a' });
    // A second bin on the same packet must not count the job twice.
    await createBin({
      projectId: play.project.id, kind: 'RESEARCH_PACKET', title: 'again', objective: 'wage',
      orchestrationId: (await getDb().get<{ orchestration_id: string }>('SELECT orchestration_id FROM work_items WHERE id = ?', [q.workItemId]))!.orchestration_id,
      manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId: null, goal: 'wage', orchestrationId: null }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: false,
    });
    const report = await stageCapacity({ hours: 1 });
    expect(report.totalProductiveJobs).toBe(1);
    expect(report.purposesSumToTotal).toBe(true);
    expect(report.purposes).toHaveLength(1);
    expect(report.purposes[0]!.purpose).not.toBe('UNATTRIBUTED');
    expect(report.purposes[0]!.purpose).toBe(await purposeOf(q.binId));
  });
});
