/**
 * CAP-16-3, structural review (episode 4): a held model route admits nothing.
 *
 * Three breaker repairs did not hold — r01.cap-16-3 read 57–67% of six hours' lane outcomes as
 * provider failures (2026-11-16 00:17Z → 2026-11-22 06:45Z) — because the structure that produced
 * them was never the breaker's tuning: a held route was re-probed by admitting a real work item onto
 * it, a provider failure cooled only that one (model, item) pair so every other queued item
 * discovered the same outage again, and the production pool (`capacity.ts`) never ran the restore at
 * all. Each discovery was a `FREE_LANE_ITEM` "model call failed" row. Now a held route refuses every
 * item, is asked with its own probe on a backoff, a provider failure cools the route, and the hold is
 * rebuilt from the probe rows after a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  endFreeLaneCooldowns,
  ensureFreeWorkers,
  freeLaneTick,
  probeHeldRoutes,
  recordRouteOutcome,
  resetFreeLaneFitness,
  resetRouteHealth,
  restoreRouteHealth,
  ROUTE_COOLDOWN_FIRST_MS,
  ROUTE_FAILURE_LIMIT,
  routeHeld,
  routeHold,
  routeProbeDue,
  takeOne,
} from '../server/services/freeLane/worker.ts';
import { nextReprobeDelay, ROUTE_PROBE_EVENT } from '../server/services/freeLane/routeProbe.ts';

const BUSY = 'model call failed [provider availability]: cheap lane HTTP 503';
const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100_000, timeoutMs: 1000 };
const ONE: LaneConfig = { ...CONFIG, models: ['brain-a'] };
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


interface LaneRow {
  at: string;
  event_type: string;
  outcome: string | null;
  reason: string | null;
}

async function laneRows(): Promise<LaneRow[]> {
  return getDb().all<LaneRow>(
    `SELECT at, event_type, outcome, reason FROM bin_events WHERE event_type IN ('FREE_LANE_ITEM', ?) ORDER BY at, id`,
    [ROUTE_PROBE_EVENT],
  );
}

async function leased(): Promise<number> {
  const row = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE state = 'LEASED'");
  return Number(row?.n ?? 0);
}

const MINUTE = 60_000;
const START = Date.parse('2026-11-22T00:00:00.000Z');

describe('a held route admits nothing and is asked with its own probe (CAP-16-3 structural)', () => {
  let play: TestProject;
  let layerId = '';

  beforeEach(async () => {
    play = await freshProject();
    resetFreeLaneFitness();
    resetRouteHealth();
    endFreeLaneCooldowns();
    layerId = (await play.layerByName('Monetization Logic')).id;
    await setBrainOnlyMode(true, 'test', 'held route suite');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('over six simulated hours of a route failing every call, writes no item failure after the hold — only probes at the backoff', async () => {
    const N = 6;
    for (let i = 0; i < N; i += 1) await enqueueFragment(play, layerId, `outage ${i}`);
    let heldAt: number | null = null;
    for (let minute = 0; minute < 6 * 60; minute += 1) {
      await freeLaneTick({ config: ONE, completer: busy, fetchSource, search: async () => [], slots: 2, perWorker: 2 });
      if (heldAt === null && /model route failing/.test(routeHeld('brain-a') ?? '')) heldAt = Date.now();
      vi.setSystemTime(Date.now() + MINUTE);
    }
    expect(heldAt).not.toBeNull();
    const rows = await laneRows();
    const items = rows.filter((r) => r.event_type === 'FREE_LANE_ITEM');
    const probes = rows.filter((r) => r.event_type === ROUTE_PROBE_EVENT);
    // Before the hold: at most a few item failures, one per route cooldown, never one per queued item at once.
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(ROUTE_FAILURE_LIMIT + 1);
    // After it: no item row for the route at all.
    expect(items.filter((r) => Date.parse(r.at) > heldAt! && /model call failed/.test(r.reason ?? ''))).toEqual([]);
    // Only the route's own probes, each failed, at the doubling backoff capped at an hour.
    expect(probes.length).toBeGreaterThanOrEqual(5);
    expect(probes.length).toBeLessThanOrEqual(12);
    expect(probes.every((p) => p.outcome === 'FAILED' && /model call failed \[provider availability\]/.test(p.reason ?? ''))).toBe(true);
    for (let k = 1; k < probes.length; k += 1) {
      const gap = Date.parse(probes[k]!.at) - Date.parse(probes[k - 1]!.at);
      expect(gap).toBeGreaterThanOrEqual(nextReprobeDelay(k));
      expect(gap).toBeLessThan(nextReprobeDelay(k) + 2 * MINUTE);
    }
    // The queue was left alone: nothing leased, every item still waiting.
    expect(await leased()).toBe(0);
  }, 120_000);

  it('a held route whose probe answers on a window no longer failing reopens, and the queued items advance', async () => {
    for (let i = 0; i < 3; i += 1) await enqueueFragment(play, layerId, `recovering ${i}`);
    let completer: Completer = busy;
    const lane: Completer = (...args) => completer(...args);
    const options = { config: ONE, completer: lane, fetchSource, search: async () => [], slots: 2, perWorker: 2 };
    for (let minute = 0; minute < 10; minute += 1) {
      await freeLaneTick(options);
      vi.setSystemTime(Date.now() + MINUTE);
    }
    expect(routeHeld('brain-a')).toMatch(/model route failing/);
    // The provider recovers. Nothing is admitted until the route's own probe answers.
    completer = answering;
    let submitted = 0;
    for (let minute = 0; minute < 90 && submitted === 0; minute += 1) {
      const tick = await freeLaneTick(options);
      submitted += tick.submitted;
      vi.setSystemTime(Date.now() + MINUTE);
    }
    const rows = await laneRows();
    const answered = rows.find((r) => r.event_type === ROUTE_PROBE_EVENT && r.outcome === 'OK');
    expect(answered).toBeDefined();
    const firstSubmit = rows.find((r) => r.event_type === 'FREE_LANE_ITEM' && r.outcome === 'SUBMITTED');
    expect(firstSubmit).toBeDefined();
    expect(Date.parse(firstSubmit!.at)).toBeGreaterThanOrEqual(Date.parse(answered!.at));
    expect(submitted).toBeGreaterThan(0);
    expect(routeHeld('brain-a')).toBeNull();
  }, 120_000);

  it('a provider failure cools the route rather than one item, and the route\'s next answer ends it without a hold (2026-11-15 stays green)', async () => {
    for (let i = 0; i < 3; i += 1) await enqueueFragment(play, layerId, `occasional 503 ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    let unavailable = true;
    // A route that answers most calls: one item meets a 503, then the provider answers again.
    const lane: Completer = async (...args) => {
      if (unavailable) throw new Error('cheap lane HTTP 503');
      return answering(...args);
    };
    const base = { workers, completer: lane, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    const first = await takeOne(base);
    expect(first.ok).toBe(false);
    // Every queued item waits the route's short cooldown, not only the one that failed.
    expect(routeHeld('brain-a')).toMatch(/cooling down after a provider failure/);
    expect((await takeOne(base)).claimed).toBeNull();
    expect(routeHold('brain-a')).toBeNull(); // never held by the breaker for it
    unavailable = false;
    vi.setSystemTime(Date.now() + ROUTE_COOLDOWN_FIRST_MS + 1);
    const next = await takeOne(base);
    expect(next.ok).toBe(true);
    expect(routeHeld('brain-a')).toBeNull();
    expect(routeHold('brain-a')).toBeNull();

    // The recorded pattern itself: seven calls in nine answered, never held.
    resetRouteHealth();
    let at = Date.now();
    const pattern = [true, true, false, true, true, true, false, true, true];
    for (let round = 0; round < 3; round += 1) {
      for (const ok of pattern) {
        recordRouteOutcome('brain-a', ok ? { ok: true } : { ok: false, why: BUSY }, (at += 1000));
        expect(routeHold('brain-a', at)).toBeNull();
      }
    }
  });

  it('after a restart, a route held only by its probe rows is still held, and probed where its backoff left it', async () => {
    const now = Date.now();
    // Held for hours: its item failures aged out of the window, only the probes are recent.
    const probes = [now - 80 * MINUTE, now - 20 * MINUTE];
    for (const [k, at] of probes.entries()) {
      await getDb().run(
        `INSERT INTO bin_events (id, event_type, at, outcome, reason) VALUES (?, ?, ?, 'FAILED', ?)`,
        [`bev_probe_${k}`, ROUTE_PROBE_EVENT, new Date(at).toISOString(), `model brain-a: ${BUSY}`],
      );
    }
    for (let i = 0; i < 2; i += 1) await enqueueFragment(play, layerId, `after restart ${i}`);
    resetRouteHealth();
    expect(routeHeld('brain-a')).toBeNull(); // the defect, before the rows are read

    await restoreRouteHealth(['brain-a', 'brain-b'], now);
    expect(routeHeld('brain-a', now)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHeld('brain-b', now)).toBeNull();
    // Two failed probes in a row: the next waits nextReprobeDelay(2) after the last one.
    const nextAt = probes[1]! + nextReprobeDelay(2);
    expect(routeProbeDue('brain-a', nextAt - 1)).toBe(false);
    expect(routeProbeDue('brain-a', nextAt)).toBe(true);

    const workers = await ensureFreeWorkers(CONFIG);
    const result = await takeOne({ workers, completer: busy, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 });
    expect(result.claimed).toBeNull();
    expect((await laneRows()).filter((r) => r.event_type === 'FREE_LANE_ITEM')).toEqual([]);
  });

  it('a probe answer recorded before the restart ends the hold its earlier failures had set', async () => {
    const now = Date.now();
    const rows: Array<[number, string, string]> = [
      [now - 50 * MINUTE, 'FAILED', `model brain-a: ${BUSY}`],
      [now - 10 * MINUTE, 'OK', 'model brain-a'],
    ];
    for (const [k, [at, outcome, reason]] of rows.entries()) {
      await getDb().run(`INSERT INTO bin_events (id, event_type, at, outcome, reason) VALUES (?, ?, ?, ?, ?)`, [
        `bev_probe_ok_${k}`,
        ROUTE_PROBE_EVENT,
        new Date(at).toISOString(),
        outcome,
        reason,
      ]);
    }
    await restoreRouteHealth(['brain-a'], now);
    expect(routeHeld('brain-a', now)).toBeNull();
  });

  it('when every route is held, the queue stays untouched: no lease, no item row, only probes', async () => {
    for (let i = 0; i < 4; i += 1) await enqueueFragment(play, layerId, `all held ${i}`);
    let at = Date.now() - 1000;
    for (const model of CONFIG.models) for (let i = 0; i < 6; i += 1) recordRouteOutcome(model, { ok: false, why: BUSY }, (at += 1));
    expect(CONFIG.models.every((m) => routeHeld(m) !== null)).toBe(true);
    for (let minute = 0; minute < 30; minute += 1) {
      const tick = await freeLaneTick({ config: CONFIG, completer: busy, fetchSource, search: async () => [], slots: 2, perWorker: 2 });
      expect(tick.claimed).toBe(0);
      vi.setSystemTime(Date.now() + MINUTE);
    }
    const rows = await laneRows();
    expect(rows.filter((r) => r.event_type === 'FREE_LANE_ITEM')).toEqual([]);
    expect(rows.filter((r) => r.event_type === ROUTE_PROBE_EVENT).length).toBeGreaterThanOrEqual(CONFIG.models.length);
    expect(await leased()).toBe(0);
    // Asking for the route's health directly is the probe's job alone, and it never claims an item.
    const results = await probeHeldRoutes({ models: CONFIG.models, completer: busy, config: CONFIG });
    expect(results.every((r) => !r.ok && !r.open)).toBe(true);
    expect(await leased()).toBe(0);
  });
});
