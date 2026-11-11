/**
 * CAP-16-3, restoring throughput first: a failing model route's cause is read
 * from its own error and recorded on production rows (not only in a reason
 * string), the per-stage reading names that cause as the thing to restore, and
 * the reading records whether existing queued work advanced since the previous
 * one — STALLED while the route fails, ADVANCING once it answers again, with the
 * route's restoration written as its own row.
 *
 * Drives the real producer (`freeLaneTick` in worker.ts) and the real recorder
 * (`recordStageCapacity` in stageCapacity.ts) against the test database.
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
import {
  endFreeLaneCooldowns,
  freeLaneTick,
  recordRouteOutcome,
  resetFreeLaneFitness,
  resetPurposeCache,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_HELD_EVENT,
  ROUTE_RESTORED_EVENT,
  routeHealthSnapshot,
} from '../server/services/freeLane/worker.ts';
import {
  chooseConstraint,
  parseFailureCause,
  primaryCause,
  readQueueAdvance,
  recordStageCapacity,
  STAGE_CAPACITY_EVENT,
  stageCapacity,
} from '../server/services/freeLane/stageCapacity.ts';
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
  resetRouteHealth();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane route cause suite');
});


async function queueOneFragment(): Promise<string> {
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
  return item.id;
}

const unauthorized: Completer = async () => {
  throw new Error('HTTP 401 Unauthorized: invalid api key');
};

describe('parseFailureCause', () => {
  it('reads the model and the cause worker.ts writes into a failed item reason', () => {
    expect(parseFailureCause('model brain-a: model call failed [broken GPU]: CUDA out of memory')).toEqual({ model: 'brain-a', cause: 'broken GPU' });
    expect(parseFailureCause('model brain-a: no JSON in a 12-character reply')).toBeNull();
    expect(parseFailureCause(null)).toBeNull();
  });
});

describe('a failing route is diagnosed from the rows, and its restoration is observed (CAP-16-3)', () => {
  it('names the real producer’s cause, records STALLED while it fails and ADVANCING once it answers', async () => {
    const itemId = await queueOneFragment();

    // 1. The route fails: the real producer writes the cause into the item row.
    const failing = await freeLaneTick({ config: CONFIG, completer: unauthorized, fetchSource, search: async () => [] });
    expect(failing.submitted).toBe(0);
    const failedRows = await getDb().all<{ reason: string | null }>(
      "SELECT reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ?",
      [itemId],
    );
    expect(failedRows.length).toBeGreaterThan(0);
    expect(failedRows.some((row) => parseFailureCause(row.reason)?.cause === 'credentials')).toBe(true);

    const diagnosed = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    expect(diagnosed.primaryCause?.cause).toBe('credentials');
    expect(diagnosed.routeCauses.every((route) => !route.restored)).toBe(true);
    expect(diagnosed.constrained.recommendation).toMatch(/^Restore model route \S+ first: \d+ failures in the window name credentials as the cause\./);
    expect(diagnosed.constrained.recommendation).toMatch(/Do not enlarge the web process/);

    // 2. Two readings with the route failing in between: the queue is recorded as stalled.
    await recordStageCapacity({ hours: 1 });
    await recordStageCapacity({ hours: 1 });
    const stalled = await latestReading();
    expect(stalled.queueAdvance.verdict).toBe('STALLED');
    expect(stalled.queueAdvance.acceptedSincePrevious).toBe(0);
    expect(stalled.primaryCause?.cause).toBe('credentials');
    expect(stalled.reason).toMatch(/Cause: credentials on /);

    // 3. The route answers again: the same queued item is accepted, the next reading says the queue advanced.
    resetFreeLaneFitness();
    await getDb().run("UPDATE work_items SET available_at = ?, attempt_count = 0 WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), itemId]);
    // The cooldown is time-bound: end it as if its time had passed. The route hold is not
    // reset, so the route earns its way back through the single re-probe it is owed.
    endFreeLaneCooldowns();
    let submitted = 0;
    for (let i = 0; i < 3 && submitted === 0; i += 1) {
      submitted += (await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] })).submitted;
    }
    expect(submitted).toBe(1);
    await recordStageCapacity({ hours: 1 });
    const advanced = await latestReading();
    expect(advanced.queueAdvance.verdict).toBe('ADVANCING');
    expect(advanced.queueAdvance.acceptedSincePrevious).toBe(1);
    expect(advanced.reason).toMatch(/Queue advancing\./);
    // The route that failed has since submitted, so it is restored on the rows and no longer the cause to fix.
    const accepting = advanced.routeCauses.filter((route) => route.lastSubmittedAt !== null);
    expect(accepting.length).toBeGreaterThan(0);
    expect(accepting.every((route) => route.restored)).toBe(true);
  });

  it('writes a route’s hold and its restoration as rows, with the cause', async () => {
    const now = Date.now();
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) {
      recordRouteOutcome('gpu-model', { ok: false, why: 'model call failed [broken GPU]: CUDA out of memory on the RunPod pod' }, now);
    }
    expect(routeHealthSnapshot()).toEqual([{ model: 'gpu-model', failures: ROUTE_FAILURE_LIMIT, cause: 'broken GPU', held: true }]);
    recordRouteOutcome('gpu-model', { ok: true }, now + 1);
    expect(routeHealthSnapshot()).toEqual([]);
    // recordRouteOutcome is synchronous and writes its rows without waiting; give them a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = await getDb().all<{ event_type: string; outcome: string; provider: string | null; measures: string | null }>(
      'SELECT event_type, outcome, provider, measures FROM bin_events WHERE event_type IN (?, ?) ORDER BY at, rowid',
      [ROUTE_HELD_EVENT, ROUTE_RESTORED_EVENT],
    );
    expect(rows.map((row) => [row.event_type, row.outcome, row.provider])).toEqual([
      [ROUTE_HELD_EVENT, 'HELD', 'gpu-model'],
      [ROUTE_RESTORED_EVENT, 'RESTORED', 'gpu-model'],
    ]);
    expect(JSON.parse(rows[0]!.measures ?? '{}')).toMatchObject({ cause: 'broken GPU', failures: ROUTE_FAILURE_LIMIT });
  });

  it('does not name a route restored by a submission that came before its failure', async () => {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordBinEvent({
      eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'RELEASED_TRANSIENT',
      reason: 'model brain-a: model call failed [task routing]: HTTP 404 model not found',
    });
    const report = await stageCapacity({ hours: 1, now: Date.now() + 1000 });
    expect(report.routeCauses).toHaveLength(1);
    expect(report.routeCauses[0]).toMatchObject({ model: 'brain-a', cause: 'task routing', failures: 1, restored: false });
    expect(primaryCause(report.routeCauses)).toEqual({ model: 'brain-a', cause: 'task routing', failures: 1 });
    expect(chooseConstraint(report.stages, report.primaryCause).recommendation).toMatch(/^Restore model route brain-a first/);
  });

  it('calls an empty queue with no earlier reading IDLE, and a waiting one FIRST_READING', async () => {
    expect((await readQueueAdvance(0)).verdict).toBe('IDLE');
    expect((await readQueueAdvance(4)).verdict).toBe('FIRST_READING');
  });
});

async function latestReading(): Promise<{
  reason: string;
  queueAdvance: { verdict: string; acceptedSincePrevious: number | null };
  primaryCause: { cause: string } | null;
  routeCauses: Array<{ lastSubmittedAt: string | null; restored: boolean }>;
}> {
  const row = await getDb().get<{ reason: string; measures: string }>(
    "SELECT reason, measures FROM bin_events WHERE event_type = ? AND outcome = 'MEASURED' ORDER BY at DESC, rowid DESC LIMIT 1",
    [STAGE_CAPACITY_EVENT],
  );
  const measures = JSON.parse(row!.measures) as Omit<Awaited<ReturnType<typeof latestReading>>, 'reason'>;
  return { reason: row!.reason, ...measures };
}
