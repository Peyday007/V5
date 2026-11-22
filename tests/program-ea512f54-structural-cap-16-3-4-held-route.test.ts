/**
 * CAP-16-3, structural review (episode 4): a held model route admits no work item at all.
 *
 * r01.cap-16-3 read 57–67% of six hours' free-lane outcomes as provider failures after three
 * breaker repairs (2026-11-16 00:17Z → 2026-11-22 06:45Z). The shared cause: a held route was
 * re-probed by admitting a real item onto it, and a provider failure cooled only that one
 * (model, item) pair, so each queued item was tried on the failing provider in turn — one outage,
 * many FREE_LANE_ITEM "model call failed" rows. Now the route is held as a whole, probed by the
 * tick with one minimal call (FREE_LANE_ROUTE_PROBE), and its queue stays untouched.
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
  ROUTE_PAUSE_STREAK,
  routeAdmits,
  routeHold,
  routeProbeDueAt,
  takeOne,
  type FreeWorker,
} from '../server/services/freeLane/worker.ts';
import { nextReprobeDelay, ROUTE_PROBE_EVENT } from '../server/services/freeLane/routeProbe.ts';

const BUSY = 'model call failed [provider availability]: cheap lane HTTP 503';

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


async function laneRows(model: string): Promise<{ at: string; outcome: string; reason: string }[]> {
  return getDb().all<{ at: string; outcome: string; reason: string }>(
    `SELECT at, outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND reason LIKE ? ORDER BY at, id`,
    [`model ${model}%`],
  );
}
async function probeRows(model: string): Promise<{ at: string; outcome: string; reason: string }[]> {
  return getDb().all<{ at: string; outcome: string; reason: string }>(
    `SELECT at, outcome, reason FROM bin_events WHERE event_type = ? AND reason LIKE ? ORDER BY at, id`,
    [ROUTE_PROBE_EVENT, `model ${model}%`],
  );
}
async function queued(): Promise<{ queued: number; other: number }> {
  const rows = await getDb().all<{ state: string; n: number | string }>(`SELECT state, COUNT(*) AS n FROM work_items GROUP BY state`);
  let q = 0;
  let other = 0;
  for (const row of rows) {
    if (row.state === 'QUEUED') q += Number(row.n);
    else other += Number(row.n);
  }
  return { queued: q, other };
}

let seq = 0;
async function probeRow(at: number, model: string, why: string | null): Promise<void> {
  seq += 1;
  await getDb().run(`INSERT INTO bin_events (id, event_type, at, outcome, reason) VALUES (?, ?, ?, ?, ?)`, [
    `bev_held_probe_${seq}`,
    ROUTE_PROBE_EVENT,
    new Date(at).toISOString(),
    why === null ? 'OK' : 'FAILED',
    why === null ? `model ${model}` : `model ${model}: ${why}`,
  ]);
}

describe('a held route admits nothing; the tick probes it (CAP-16-3 structural)', () => {
  let play: TestProject;
  let layerId = '';
  let workers: FreeWorker[] = [];

  beforeEach(async () => {
    play = await freshProject();
    resetFreeLaneFitness();
    resetRouteHealth();
    endFreeLaneCooldowns();
    layerId = (await play.layerByName('Monetization Logic')).id;
    await setBrainOnlyMode(true, 'test', 'held route suite');
    workers = await ensureFreeWorkers(CONFIG);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = (completer: Completer, worker = 0) => ({
    workers,
    completer,
    fetchSource,
    search: async () => [],
    config: CONFIG,
    worker: workers[worker]!,
    index: worker,
  });

  it('a route failing every call over six simulated hours writes item failures only until it is held, then probe rows at the backoff cadence', async () => {
    const N = 6;
    for (let i = 0; i < N; i += 1) await enqueueFragment(play, layerId, `outage ${i}`);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    let calls = 0;
    const down: Completer = async () => {
      calls += 1;
      throw new Error('cheap lane HTTP 503');
    };
    let heldAt: number | null = null;
    let callsAtHold = 0;
    const STEP = 60_000;
    for (let t = 0; t <= 6 * 3_600_000; t += STEP) {
      vi.setSystemTime(start + t);
      await probeHeldRoutes({ workers: [workers[0]!], completer: down, config: CONFIG });
      const result = await takeOne(base(down));
      if (heldAt === null && routeAdmits('brain-a') !== null) {
        heldAt = Date.now();
        callsAtHold = calls;
      }
      if (heldAt !== null && Date.now() > heldAt) expect(result.claimed).toBeNull();
    }
    expect(heldAt).not.toBeNull();
    const items = await laneRows('brain-a');
    const failures = items.filter((row) => /model call failed/.test(row.reason));
    // Only the run that found the outage: the rest of the queue was never tried on the route.
    expect(failures).toHaveLength(ROUTE_PAUSE_STREAK);
    for (const row of failures) expect(Date.parse(row.at)).toBeLessThanOrEqual(heldAt!);
    const probes = await probeRows('brain-a');
    expect(probes.length).toBeGreaterThanOrEqual(5);
    expect(probes.length).toBeLessThanOrEqual(12);
    for (const row of probes) expect(row.outcome).toBe('FAILED');
    // The cadence: 5 minutes, doubling, capped at an hour — to within one tick.
    const times = [heldAt!, ...probes.map((row) => Date.parse(row.at))];
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      const delay = nextReprobeDelay(i - 1);
      expect(gap).toBeGreaterThanOrEqual(delay);
      expect(gap).toBeLessThan(delay + STEP);
    }
    // Every model call after the hold was a probe: one call each.
    expect(calls - callsAtHold).toBe(probes.length);
    // The queue is intact: nothing leased, nothing failed.
    expect(await queued()).toEqual({ queued: N, other: 0 });
  }, 120_000);

  it('a provider failure on an open route holds the route, not only that item', async () => {
    for (let i = 0; i < 5; i += 1) await enqueueFragment(play, layerId, `queue ${i}`);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 429');
    };
    const claimed: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await takeOne(base(down));
      if (result.claimed) claimed.push(result.claimed.workItemId);
    }
    expect(claimed).toHaveLength(ROUTE_PAUSE_STREAK);
    expect(routeAdmits('brain-a')).toMatch(/held until a route probe answers/);
    // The breaker's own window did not hold it (two failures are under its bar): this is the route-level hold.
    expect(routeHold('brain-a')).toBeNull();
    // The other route is untouched by it.
    expect(routeAdmits('brain-b')).toBeNull();
    expect((await takeOne({ ...base(answering, 1), spillover: true })).claimed).not.toBeNull();
  });

  it('a held route whose probe answers, with its window no longer failing, reopens and the queue advances', async () => {
    for (let i = 0; i < 4; i += 1) await enqueueFragment(play, layerId, `recovering ${i}`);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    for (let i = 0; i < ROUTE_PAUSE_STREAK; i += 1) expect((await takeOne(base(down))).claimed).not.toBeNull();
    expect(routeAdmits('brain-a')).not.toBeNull();
    // Not due yet: the tick asks nothing.
    expect(await probeHeldRoutes({ workers, completer: answering, config: CONFIG })).toEqual([]);
    expect((await takeOne(base(answering))).claimed).toBeNull();
    vi.setSystemTime(routeProbeDueAt('brain-a')!);
    const [probe] = await probeHeldRoutes({ workers, completer: answering, config: CONFIG });
    expect(probe).toMatchObject({ model: 'brain-a', ok: true, open: true });
    expect(routeAdmits('brain-a')).toBeNull();
    const advanced = await takeOne(base(answering));
    expect(advanced.claimed).not.toBeNull();
    expect(advanced.ok).toBe(true);
    // The outage cooldowns ended with it: the two items that failed are offered to brain-a again.
    let taken = 1;
    for (let i = 0; i < 6; i += 1) {
      const next = await takeOne(base(answering));
      if (!next.claimed) break;
      taken += 1;
    }
    expect(taken).toBe(4);
  });

  it('a probe that answers on a route whose window still mostly fails keeps it held until a later probe', async () => {
    await enqueueFragment(play, layerId, 'window');
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    for (let i = 0; i < 8; i += 1) recordRouteOutcome('brain-a', { ok: false, why: BUSY }, start - 60_000 + i);
    expect(routeAdmits('brain-a')).not.toBeNull();
    vi.setSystemTime(routeProbeDueAt('brain-a')!);
    // Due: the breaker's own reading says re-probe, but admission still takes no item.
    expect(routeHold('brain-a')).toBeNull();
    expect((await takeOne(base(answering))).claimed).toBeNull();
    const [first] = await probeHeldRoutes({ workers, completer: answering, config: CONFIG });
    expect(first).toMatchObject({ ok: true, open: false }); // 1 of 9 answered
    expect((await takeOne(base(answering))).claimed).toBeNull();
    vi.setSystemTime(routeProbeDueAt('brain-a')!);
    const [second] = await probeHeldRoutes({ workers, completer: answering, config: CONFIG });
    expect(second).toMatchObject({ ok: true, open: true }); // 2 of 10: back under the bar
    expect((await takeOne(base(answering))).ok).toBe(true);
    expect((await laneRows('brain-a')).filter((row) => /model call failed/.test(row.reason))).toHaveLength(0);
  });

  it('a healthy route answering through occasional 503s is never held (2026-11-15 07:46Z)', async () => {
    for (let i = 0; i < 8; i += 1) await enqueueFragment(play, layerId, `mostly answering ${i}`);
    let n = 0;
    // Seven in nine answer; never two failures in a row.
    const pattern = [true, true, false, true, true, true, false, true, true];
    const flaky: Completer = async (...args) => {
      const ok = pattern[n % pattern.length]!;
      n += 1;
      if (!ok) throw new Error('cheap lane HTTP 503');
      return answering(...args);
    };
    let taken = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = await takeOne(base(flaky));
      expect(routeAdmits('brain-a')).toBeNull();
      if (result.claimed) taken += 1;
    }
    expect(taken).toBeGreaterThan(ROUTE_PAUSE_STREAK);
    expect(await probeRows('brain-a')).toHaveLength(0);
  });

  it('after a restart a held route is still held from its probe rows, and probed on the same cadence', async () => {
    await enqueueFragment(play, layerId, 'restart');
    const now = Date.now();
    // A route held for two hours: every probe failed, the last one 50 minutes ago (older than the window's half hour).
    const marks = [now - 115 * 60_000, now - 100 * 60_000, now - 80 * 60_000, now - 50 * 60_000];
    for (const at of marks) await probeRow(at, 'brain-a', BUSY);
    // A healthy route beside it, whose last probe answered.
    await probeRow(now - 100 * 60_000, 'brain-b', BUSY);
    await probeRow(now - 40 * 60_000, 'brain-b', null);
    resetRouteHealth();
    expect(routeAdmits('brain-a')).toBeNull(); // the defect, before the rows are read
    await restoreRouteHealth(['brain-a', 'brain-b'], now);
    expect(routeAdmits('brain-a')).toMatch(/held until a route probe answers/);
    expect(routeProbeDueAt('brain-a')).toBe(marks[3]! + nextReprobeDelay(4));
    expect(routeAdmits('brain-b')).toBeNull();
    expect((await takeOne(base(answering))).claimed).toBeNull();
    expect(await queued()).toEqual({ queued: 1, other: 0 });
  });

  it('when every route is held the queue stays untouched: no lease, no item row', async () => {
    for (let i = 0; i < 3; i += 1) await enqueueFragment(play, layerId, `all held ${i}`);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    for (const index of [0, 1]) for (let i = 0; i < ROUTE_PAUSE_STREAK + 2; i += 1) await takeOne({ ...base(down, index), spillover: true });
    expect(routeAdmits('brain-a')).not.toBeNull();
    expect(routeAdmits('brain-b')).not.toBeNull();
    const rowsBefore = (await laneRows('brain-a')).length + (await laneRows('brain-b')).length;
    const tick = await freeLaneTick({ config: CONFIG, completer: down, fetchSource, search: async () => [], slots: 4, perWorker: 3 });
    expect(tick.claimed).toBe(0);
    for (const index of [0, 1]) expect((await takeOne({ ...base(answering, index), spillover: true })).claimed).toBeNull();
    expect((await laneRows('brain-a')).length + (await laneRows('brain-b')).length).toBe(rowsBefore);
    expect(await queued()).toEqual({ queued: 3, other: 0 });
  });
});
