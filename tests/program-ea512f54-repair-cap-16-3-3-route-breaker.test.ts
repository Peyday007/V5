/**
 * CAP-16-3, repair episode 3: an intermittently failing model route is held by
 * its failure ratio, not only by consecutive failures.
 *
 * Production, 2026-11-16 16:48Z: brain-a's provider was "overloaded: 89% of 9
 * calls failed" beside a healthy GPU route, and r01.cap-16-3 read 62–98% of six
 * hours' free-lane outcomes as provider failures. The breaker forgot a route's
 * failures on a single answer, and that answer also ended every route cooldown,
 * so a provider answering about one call in nine was never held.
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
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import {
  coolingForEveryModel,
  endFreeLaneCooldowns,
  ensureFreeWorkers,
  resetFreeLaneFitness,
  takeOne,
  recordRouteOutcome,
  resetRouteHealth,
  restoreRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_WINDOW_MS,
  probeHeldRoutes,
  routeHold,
  routeHeld,
  routeWindowFailing,
  takeRouteProbe,
} from '../server/services/freeLane/worker.ts';

const BUSY = 'model call failed [provider availability]: cheap lane HTTP 503';
const LIMITED = 'model call failed [provider availability]: cheap lane HTTP 429';
const REPROBE_MS = 5 * 60_000;

describe('route breaker under an intermittent provider (the recorded failure class)', () => {
  beforeEach(() => resetRouteHealth());

  it('keeps a route held when one answer interrupts a run of mostly failing calls', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    // Five failures, one answer, four failures: nine in ten fail.
    for (let i = 0; i < 5; i += 1) recordRouteOutcome('brain-a', { ok: false, why: i % 2 ? LIMITED : BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    // The rare answer: before this repair it deleted the route's state, reopening it to every slot.
    const open = recordRouteOutcome('brain-a', { ok: true }, (at += 1000));
    expect(open).toBe(false); // the caller does not clear the route's cooldowns
    expect(routeWindowFailing('brain-a', at)).toBe(true);
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    for (let i = 0; i < 4; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();
  });

  it('after that one answer, the very next failure finds the route still held rather than starting a fresh count', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 5; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    recordRouteOutcome('brain-a', { ok: true }, (at += 1000));
    recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    // Before this repair: one failure after a reset, under ROUTE_FAILURE_LIMIT, so every slot took items again.
    expect(ROUTE_FAILURE_LIMIT).toBeGreaterThan(1);
    expect(routeHold('brain-a', at)).not.toBeNull();
  });

  it('offers a held route one re-probe per interval, and releases it once its window is back under the bar', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();

    at += REPROBE_MS;
    expect(routeHold('brain-a', at)).toBeNull(); // the single re-probe is due
    takeRouteProbe('brain-a', at);
    expect(routeHold('brain-a', at)).not.toBeNull(); // the next item waits for it
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(false); // 1 of 9 answered: still failing
    expect(routeHold('brain-a', at)).not.toBeNull();
    expect(routeHold('brain-a', at + REPROBE_MS - 1)).not.toBeNull();

    at += REPROBE_MS;
    expect(routeHold('brain-a', at)).toBeNull();
    takeRouteProbe('brain-a', at);
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(true); // 2 of 10 answered: no longer under one in five
    expect(routeHold('brain-a', at)).toBeNull();
    expect(routeWindowFailing('brain-a', at)).toBe(false);
  });

  it('forgets failures older than the window, so a recovered route is not held for its past', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    at += ROUTE_WINDOW_MS;
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(recordRouteOutcome('brain-a', { ok: true }, at)).toBe(true);
    expect(routeHold('brain-a', at)).toBeNull();
  });
});

describe('route breaker leaves a mostly answering route alone (2026-11-15 07:46Z)', () => {
  beforeEach(() => resetRouteHealth());

  it('never holds a route that answers seven calls in nine through occasional 503s', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const pattern = [true, true, false, true, true, true, false, true, true];
    for (let round = 0; round < 3; round += 1) {
      for (const ok of pattern) {
        const open = recordRouteOutcome('brain-a', ok ? { ok: true } : { ok: false, why: BUSY }, (at += 1000));
        if (ok) expect(open).toBe(true); // its answers still end the route's cooldowns
        expect(routeHold('brain-a', at)).toBeNull();
      }
    }
    expect(routeWindowFailing('brain-a', at)).toBe(false);
  });

  it('still never counts Brain\'s own database being unavailable against a model route', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const why = 'model call failed: The database pool had no free connection (12 caller(s) waiting)';
    for (let i = 0; i < 10; i += 1) recordRouteOutcome('brain-a', { ok: false, why }, (at += 1000));
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(routeHold('brain-a', at)).toBeNull();
  });

  it('a failing route does not hold another one', () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, (at += 1000));
    expect(routeHold('brain-a', at)).not.toBeNull();
    expect(routeHold('runpod/openai/gpt-oss-120b', at)).toBeNull();
    expect(recordRouteOutcome('runpod/openai/gpt-oss-120b', { ok: true }, at)).toBe(true);
  });
});

describe('route breaker survives a worker restart (review F1: the window was process memory)', () => {
  let seq = 0;
  async function laneRow(at: number, model: string, why: string | null): Promise<void> {
    seq += 1;
    await getDb().run(
      `INSERT INTO bin_events (id, event_type, at, outcome, reason) VALUES (?, 'FREE_LANE_ITEM', ?, ?, ?)`,
      [
        `bev_route_${seq}`,
        new Date(at).toISOString(),
        why === null ? 'SUBMITTED' : 'RELEASED_TRANSIENT',
        why === null ? `model ${model}` : `model ${model}: ${why}`,
      ],
    );
  }

  beforeEach(async () => {
    await freshProject();
    resetRouteHealth();
  });

  it('a failing route recorded before the restart is held on the first tick after it, with no new failure', async () => {
    const start = Date.parse('2026-11-16T16:00:00.000Z');
    let at = start;
    // Production pattern: about one call in nine answered.
    for (let i = 0; i < 9; i += 1) await laneRow((at += 10_000), 'brain-a', i === 4 ? null : i % 2 ? LIMITED : BUSY);
    // A healthy route beside it.
    for (let i = 0; i < 5; i += 1) await laneRow((at += 10_000), 'runpod/qwen', null);

    // The restart: every bit of memory is gone.
    resetRouteHealth();
    expect(routeHold('brain-a', at)).toBeNull(); // the defect, before the rows are read

    const replayed = await restoreRouteHealth(['brain-a', 'runpod/qwen'], at);
    expect(replayed).toBe(14);
    expect(routeWindowFailing('brain-a', at)).toBe(true);
    expect(routeHold('brain-a', at)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHold('runpod/qwen', at)).toBeNull();
    expect(routeWindowFailing('runpod/qwen', at)).toBe(false);
  });

  it('rows older than the window are not replayed, so a recovered route is not held for its past', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 8; i += 1) await laneRow((at += 1000), 'brain-a', BUSY);
    at += ROUTE_WINDOW_MS + 1000;
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(0);
    expect(routeHold('brain-a', at)).toBeNull();
  });

  it('replays once per process, and never double-counts a route already judged live', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    for (let i = 0; i < 3; i += 1) await laneRow((at += 1000), 'brain-a', BUSY);
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(3);
    // The next tick reads nothing again.
    expect(await restoreRouteHealth(['brain-a'], at)).toBe(0);

    // A route this process already called keeps its live window rather than adding the rows to it.
    resetRouteHealth();
    recordRouteOutcome('brain-b', { ok: true }, at);
    for (let i = 0; i < 6; i += 1) await laneRow((at += 1000), 'brain-b', BUSY);
    expect(await restoreRouteHealth(['brain-b'], at)).toBe(0);
    expect(routeHold('brain-b', at)).toBeNull();
  });

  it('Brain\'s own database outage recorded in the rows is still not counted against the route', async () => {
    let at = Date.parse('2026-11-16T16:00:00.000Z');
    const why = 'model call failed: The database pool had no free connection (12 caller(s) waiting)';
    for (let i = 0; i < 8; i += 1) await laneRow((at += 1000), 'brain-a', why);
    await restoreRouteHealth(['brain-a'], at);
    expect(routeWindowFailing('brain-a', at)).toBe(false);
    expect(routeHold('brain-a', at)).toBeNull();
  });
});

/*
 * Review F2: the gate in `takeOne` — `if (routeOpen) clearRouteCooldowns(worker.model)` — driven end
 * to end. Items really are claimed, answered and handed back by `takeOne` against the work queue, and
 * the cooldowns they leave are read from the lane itself, not inferred from `recordRouteOutcome`'s
 * return value.
 */
const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);

/** A model that answers a research fragment the way a capable one would. */
const answering: Completer = async (_config, _name, _system, prompt) => {
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
const busy: Completer = async () => {
  throw new Error('cheap lane HTTP 503');
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

async function enqueueFragment(play: TestProject, layerId: string, title: string): Promise<string> {
  const projectId = play.project.id;
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

/*
 * Structural review (episode 4) replaced the item re-probe this block used to drive: a held route
 * admits no item at all, and is asked with its own probe (`probeHeldRoutes`). The F2 gate is the same
 * — an answer on a still-failing window keeps the route held and its queued items waiting; an answer
 * that leaves it open lets them advance — driven end to end through `takeOne` and the probe.
 */
describe('takeOne end to end: a probe answer reopens the route only when its window is no longer failing (review F2)', () => {
  let play: TestProject;
  let layerId = '';

  beforeEach(async () => {
    play = await freshProject();
    resetFreeLaneFitness();
    resetRouteHealth();
    endFreeLaneCooldowns();
    layerId = (await play.layerByName('Monetization Logic')).id;
    await setBrainOnlyMode(true, 'test', 'route breaker suite');
  });

  it('keeps a held route closed to every item when its probe answers on a window that is still failing', async () => {
    for (let i = 0; i < 4; i += 1) await enqueueFragment(play, layerId, `mostly failing ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    let completer = busy;
    const lane: Completer = (...args) => completer(...args);
    const base = { workers, completer: lane, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };

    // Two real items fail in a row on brain-a's provider: the route cools, not only those items.
    for (let i = 0; i < 2; i += 1) expect((await takeOne(base)).ok).toBe(false);
    expect(routeHeld('brain-a')).toMatch(/cooling down after a provider failure/);
    expect((await takeOne(base)).claimed).toBeNull();

    // Earlier in the window the same route failed more calls; it is held and its probe is due.
    const earlier = Date.now() - 5 * 60_000 - 1000;
    for (let i = 0; i < 7; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, earlier + i);
    expect(routeHold('brain-a')).toBeNull(); // the breaker's due-ness, read alone
    expect(routeHeld('brain-a')).not.toBeNull(); // admission: no item is its re-probe
    expect((await takeOne(base)).claimed).toBeNull();

    // The probe is the route's own call, and it answers: 1 of 10 is still failing, so it stays held.
    completer = answering;
    const [probe] = await probeHeldRoutes({ models: ['brain-a'], completer: lane, config: CONFIG });
    expect(probe?.ok).toBe(true);
    expect(probe?.open).toBe(false);
    expect(routeHold('brain-a')).toMatch(/model route failing \(provider availability\)/);
    expect((await takeOne(base)).claimed).toBeNull();
    // Another model still takes an item at once: the hold is brain-a's alone.
    const other = await takeOne({ ...base, worker: workers[1]!, index: 1, spillover: true });
    expect(other.claimed).not.toBeNull();
  });

  it('lets the queued items advance once the route answers and is open', async () => {
    for (let i = 0; i < 3; i += 1) await enqueueFragment(play, layerId, `mostly answering ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    let completer = busy;
    const lane: Completer = (...args) => completer(...args);
    const base = { workers, completer: lane, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };

    const failed = await takeOne(base);
    expect(failed.ok).toBe(false);
    // One failure between answers leaves the route open; only that item waits for brain-a.
    expect(coolingForEveryModel(['brain-a'])).toBe(1);
    expect(routeHeld('brain-a')).toBeNull();

    // The route answers and is open: its outage cooldown ends, so brain-a may take that item again.
    completer = answering;
    const seen = new Set<string>();
    for (let i = 0; i < 10 && !seen.has(failed.claimed!.workItemId); i += 1) {
      const next = await takeOne(base);
      if (!next.claimed) break;
      expect(next.ok).toBe(true);
      seen.add(next.claimed.workItemId);
    }
    expect(seen.has(failed.claimed!.workItemId)).toBe(true);
  });
});
