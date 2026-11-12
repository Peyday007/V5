/**
 * The free lane's concurrency is a controller's output, not a constant (§86).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  controlStep,
  decideTarget,
  slotShare,
  SLOTS_PER_DB_CONNECTION,
  readCapacity,
  startAdaptivePool,
  stopAdaptivePool,
  waitingNow,
  freeLaneSpareSurfaces,
} from '../server/services/freeLane/capacity.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { resetFreeLaneMemberships } from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const calm = { db: false, lagMs: 5, cpu: 0.1 };

describe('the decision', () => {
  it('doubles while useful work waits and errors are acceptable', () => {
    const d = decideTarget({ target: 4, active: 4, waiting: 100, window: { ok: 8, content: 2, transient: 0 }, pressure: calm });
    expect(d.target).toBe(8);
    expect(d.stable).toBe(true);
  });
  it('grows through 8, 16, 32, 64 and beyond with the queue to fill them', () => {
    let target = 8;
    for (const next of [16, 32, 64, 128, 256]) {
      target = decideTarget({ target, active: target, waiting: 10_000, window: { ok: 20, content: 5, transient: 1 }, pressure: calm }).target;
      expect(target).toBe(next);
    }
  });
  it('halves when the provider overloads, and when Brain is under pressure', () => {
    expect(decideTarget({ target: 32, active: 32, waiting: 99, window: { ok: 5, content: 1, transient: 6 }, pressure: calm }).target).toBe(16);
    expect(decideTarget({ target: 32, active: 32, waiting: 99, window: { ok: 9, content: 0, transient: 0 }, pressure: { ...calm, db: true } }).target).toBe(16);
    expect(decideTarget({ target: 32, active: 32, waiting: 99, window: { ok: 9, content: 0, transient: 0 }, pressure: { ...calm, lagMs: 900 } }).target).toBe(16);
  });
  it('holds, rather than shrinks, while database connections are only contended', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 99, window: { ok: 9, content: 1, transient: 0 }, pressure: { ...calm, dbContended: true } });
    expect(d.target).toBe(16);
    expect(d.reason).toMatch(/contended/);
  });

  it('does not multiply failed work', () => {
    const d = decideTarget({ target: 8, active: 8, waiting: 99, window: { ok: 1, content: 9, transient: 0 }, pressure: calm });
    expect(d.target).toBe(8);
    expect(d.reason).toMatch(/not multiplying failed work/);
  });
  it('decays when nothing is waiting, and never grows past what is waiting', () => {
    expect(decideTarget({ target: 16, active: 2, waiting: 0, window: { ok: 2, content: 0, transient: 0 }, pressure: calm }).target).toBe(12);
    expect(decideTarget({ target: 2, active: 2, waiting: 1, window: { ok: 2, content: 0, transient: 0 }, pressure: calm }).target).toBe(3);
  });
});

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
let play: TestProject;
let inFlight = 0;
let peak = 0;

/** A model that takes a moment, so concurrency is observable. */
const completer: Completer = async (_c, _m, _s, prompt) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 40));
  inFlight -= 1;
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

async function queueFragments(n: number): Promise<void> {
  const layerId = (await play.layerByName('Monetization Logic')).id;
  for (let i = 0; i < n; i += 1) {
    const run = await createRun({ projectId: play.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
    const orchestration = await createOrchestration({ projectId: play.project.id, layerId, runId: run.id, title: `Receptionist wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([{
      orchestrationId: orchestration.id, projectId: play.project.id, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
      question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
      population: 'Receptionists', definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    }]);
    await createBin({
      projectId: play.project.id, kind: 'RESEARCH_PACKET', title: `Receptionist wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
      manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const def = workType('RESEARCH_FRAGMENT');
    await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
  }
}

beforeEach(async () => {
  play = await freshProject();
  await setBrainOnlyMode(true, 'test', 'capacity suite');
  inFlight = 0;
  peak = 0;
});
afterEach(() => stopAdaptivePool());

describe('the adaptive pool on a real queue', () => {
  it('scales up past the old four slots, persists what it learned, and finishes the work', async () => {
    await queueFragments(30);
    await new Promise((r) => setTimeout(r, 20));
    expect(await waitingNow()).toBe(30);
    // Brain calm by construction: this test is about growth, and the pressure rules have their own.
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm }, 60_000);
    const succeeded = async (): Promise<number> =>
      Number((await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM work_items WHERE work_type = 'RESEARCH_FRAGMENT' AND state = 'SUCCEEDED'", []))?.n ?? 0);
    // Until every job has finished, not merely been taken.
    for (let step = 0; step < 200 && (await succeeded()) < 30; step += 1) {
      await new Promise((r) => setTimeout(r, 150));
      await controlStep();
    }
    expect(await succeeded()).toBe(30);
    // The packet runner may already have queued next-stage items; no fragment is left waiting.
    const fragmentsWaiting = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM work_items WHERE work_type = 'RESEARCH_FRAGMENT' AND state = 'QUEUED'", []);
    expect(Number(fragmentsWaiting?.n)).toBe(0);
    expect(peak).toBeGreaterThan(4);
    const rows = await readCapacity();
    expect(rows.length).toBe(2);
    // What it learned is persisted for both models. How high `stableHigh` has
    // climbed when the 30 jobs run out depends on how many control steps a
    // runner fits in before then (CI read 1 twice, 2026-11-09/10, and skipped two
    // releases); the growth itself is proven by the peak above and the GROW rows.
    expect(Math.min(...rows.map((r) => r.stableHigh))).toBeGreaterThanOrEqual(1);
    const grew = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'GROW'", []);
    expect(Number(grew?.n)).toBeGreaterThan(0);
  }, 60_000);
});

describe('idle capacity is room, even after the controller lowered its target (production, 2026-11-07)', () => {
  it('reads proven capacity, not a target lowered because nothing was waiting', async () => {
    process.env['BRAIN_CHEAP_LLM_URL'] = 'http://lane.test/v1';
    process.env['BRAIN_CHEAP_LLM_MODELS'] = 'brain-a,brain-c';
    try {
      await getDb().run('DELETE FROM free_lane_capacity', []);
      await getDb().run('DELETE FROM bin_events', []);
      await getDb().run(
        "INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 2, 19, '2026-11-07T16:07:00Z', 'no research waiting'), ('brain-c', 2, 26, '2026-11-07T16:07:00Z', 'no research waiting')",
        [],
      );
      // 19 + 26 proven slots, nothing busy or waiting: the most room a reading opens.
      // The old reading summed the targets (2 + 2) and opened one.
      expect(await freeLaneSpareSurfaces()).toBe(8);
    } finally {
      delete process.env['BRAIN_CHEAP_LLM_URL'];
      delete process.env['BRAIN_CHEAP_LLM_MODELS'];
    }
  });
});

describe('generation follows the free lane, not idle Claude surfaces', () => {
  it('opens room in proportion to granted-but-idle slots, and none while answers mostly fail', async () => {
    process.env['BRAIN_CHEAP_LLM_URL'] = 'http://lane.test/v1';
    try {
      await getDb().run("INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 16, 16, '2026-11-03T00:00:00Z', 't'), ('brain-b', 8, 8, '2026-11-03T00:00:00Z', 't')", []);
      expect(await freeLaneSpareSurfaces()).toBe(6);
      for (let i = 0; i < 12; i += 1) {
        await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model brain-a: x' });
      }
      expect(await freeLaneSpareSurfaces()).toBe(0);
    } finally {
      delete process.env['BRAIN_CHEAP_LLM_URL'];
    }
  });
});

describe('the lane stays within what the database pool can carry', () => {
  it('splits a multiple of the pool ceiling across the models, and is unbounded only when the pool is not measured', () => {
    // Production, 2026-11-05: three models, eight connections, 593 callers waiting.
    expect(SLOTS_PER_DB_CONNECTION).toBe(3);
    expect(slotShare(3, 8)).toBe(8);
    expect(slotShare(2, 8)).toBe(12);
    expect(slotShare(30, 8)).toBe(1);
    expect(slotShare(3, null)).toBeNull();
    expect(slotShare(3, 0)).toBeNull();
  });
});

describe('the control step heals the pool it owns (rule 9: nothing claimable waits)', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const healed = async (): Promise<Array<{ reason: string }>> =>
    getDb().all<{ reason: string }>("SELECT reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'HEALED' ORDER BY at", []);
  const taken = async (): Promise<number> =>
    Number((await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM work_items WHERE work_type = 'RESEARCH_FRAGMENT' AND state <> 'QUEUED'", []))?.n ?? 0);

  it('membership lost: work queued after the lane cached no projects is claimed on the next step, not after the hourly recovery', async () => {
    resetFreeLaneMemberships();
    // The lane starts with nothing to do: its slots read their memberships (none), cache them, and sleep.
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm }, 60_000);
    await pause(400);
    await queueFragments(3);
    // The recorded failure: work waits, the cached membership is stale, and the slots claim nothing.
    await pause(600);
    expect(await waitingNow()).toBe(3);
    expect(await taken()).toBe(0);
    await controlStep();
    for (let i = 0; i < 40 && (await taken()) === 0; i += 1) await pause(100);
    expect(await taken()).toBeGreaterThan(0);
    const rows = await healed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toMatch(/memberships re-read/);
  }, 30_000);

  it('heals at most once per idle-record interval while the cause persists', async () => {
    resetFreeLaneMemberships();
    await queueFragments(2);
    // No bin the lane may be granted membership through: the work stays unclaimable however often the step heals.
    await getDb().run("UPDATE bins SET state = 'DRAFT'", []);
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm }, 60_000);
    await pause(400);
    await controlStep();
    await pause(200);
    await controlStep();
    await controlStep();
    expect(await waitingNow()).toBe(2);
    expect(await taken()).toBe(0);
    expect(await healed()).toHaveLength(1);
  }, 30_000);

  /*
   * The recorded failure class is claimable research waiting an hour or more beside
   * idle slots. The two tests below reproduce states in which waiting longer changes
   * nothing under the earlier code: no cache TTL expires and no idle sleep ends that
   * clears them. So each one fails on that code however long it is given, rather
   * than only being slower there. Neither forces a control step: the pool's own
   * interval (60 s here) never fires inside the test.
   */
  it('membership lost, for good: work whose bin has moved on is claimed, where re-reading the old grant never finds its project', async () => {
    resetFreeLaneMemberships();
    await queueFragments(2);
    // A retry queued after its owning bin moved on (FAILED, not withdrawn). The earlier grant took only
    // projects with a READY, LEASED or NEEDS_HUMAN bin, so this project was never joined. Every minute's
    // re-read gave the same answer, and the item waited for good while waitingNow counted it.
    await getDb().run("UPDATE bins SET state = 'FAILED'", []);
    const openBins = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM bins WHERE purpose IN ('PLAY_RESEARCH', 'GRUNT') AND state IN ('READY', 'LEASED', 'NEEDS_HUMAN')", []);
    expect(Number(openBins?.n ?? 0)).toBe(0);
    expect(await waitingNow()).toBe(2);
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm }, 60_000);
    for (let i = 0; i < 50 && (await taken()) === 0; i += 1) await pause(100);
    expect(await taken()).toBeGreaterThan(0);
    // No control step healed it: the grant itself now reaches the work.
    expect(await healed()).toHaveLength(0);
  }, 30_000);

  it('lane pool stopped while the control step keeps failing: the pool refills its exited slots itself and claims the waiting work', async () => {
    let broken = true;
    let steps = 0;
    const options = {
      config: CONFIG,
      fetchSource,
      search: async () => [],
      // The first step starts the slots. After that, the same database fault that ended them makes every
      // step throw before `fill`. Under the earlier code that step was the only refill, so the pool stayed
      // empty however long it ran.
      pressure: () => {
        steps += 1;
        if (steps > 1) throw new Error('database unavailable');
        return calm;
      },
      get completer(): Completer {
        if (broken) throw new Error('slot crashed');
        return completer;
      },
    };
    startAdaptivePool(options, 200);
    await pause(400);
    broken = false;
    await queueFragments(2);
    for (let i = 0; i < 100 && (await taken()) === 0; i += 1) await pause(100);
    expect(steps).toBeGreaterThan(5);
    expect(await taken()).toBeGreaterThan(0);
  }, 30_000);

  it('lane pool stopped: a pool whose slots all exited is refilled by the next step without restarting the pool', async () => {
    let broken = true;
    const options = {
      config: CONFIG,
      fetchSource,
      search: async () => [],
      pressure: () => calm,
      // Every slot reads this before it claims: while broken, each slot ends the moment it starts.
      get completer(): Completer {
        if (broken) throw new Error('slot crashed');
        return completer;
      },
    };
    startAdaptivePool(options, 60_000);
    await pause(400);
    broken = false;
    await queueFragments(2);
    const reading = await controlStep();
    expect(reading?.models.length).toBe(2);
    for (const model of reading!.models) expect(model.running).toBe(model.target);
    const rows = await healed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toMatch(/brain-a: 2 slot\(s\) had exited \(0 of \d+ running\); refilled to \d+/);
    for (let i = 0; i < 40 && (await taken()) === 0; i += 1) await pause(100);
    expect(await taken()).toBeGreaterThan(0);
  }, 30_000);
});
