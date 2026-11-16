/**
 * A refusing model route stops being fed, is re-probed one item at a time, and
 * its work goes to a healthy model meanwhile (worker.ts route health).
 *
 * The recorded failure class (ORIGINATED:IDLE_CAPACITY:free-lane-coverage,
 * production 2026-11-15): "Displaced research is not progressing … the free
 * lane failed every item it took in the last hour" / "submitted 0". One model's
 * provider refused every call. The hold engaged only after three failures,
 * every slot of that model kept claiming items onto the refusing route, and the
 * other model never took that model's role, so the lane spent its capacity on
 * refusals and submitted nothing.
 *
 * The first part pins the route-health state machine exactly (the limits, the
 * backoff and its cap, the probe timeout, the probe and its undo, stragglers,
 * success clearing it). The second part drives the real `takeOne` against
 * queued research with one model refusing, and asserts the outcome: the
 * refusing route is called a bounded number of times, not once per item, and
 * the healthy model's slot adopts its role and submits every item.
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
import {
  adoptedRoles,
  claimAsks,
  ensureFreeWorkers,
  recordRouteOutcome,
  resetFreeLaneFitness,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  ROUTE_PROBE_TIMEOUT_MS,
  ROUTE_REPROBE_BASE_MS,
  ROUTE_REPROBE_MAX_MS,
  routeHold,
  routeReprobeDelay,
  takeOne,
  takeRouteProbe,
  UNCLASSIFIED_FAILURE_LIMIT,
} from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const T0 = 1_000_000;
const NAMED = 'model call failed: cheap lane HTTP 503';
const UNCLASSIFIED = 'model call failed: something nobody has seen before';

beforeEach(() => {
  resetRouteHealth();
});

/* ------------------------------------------------------------------------- */
/* The state machine                                                          */
/* ------------------------------------------------------------------------- */

describe('routeReprobeDelay', () => {
  it('starts at the base wait, doubles per failed probe, and is capped', () => {
    expect(ROUTE_REPROBE_BASE_MS).toBe(30_000);
    expect(ROUTE_REPROBE_MAX_MS).toBe(30 * 60_000);
    expect(routeReprobeDelay(0)).toBe(30_000);
    expect(routeReprobeDelay(1)).toBe(60_000);
    expect(routeReprobeDelay(2)).toBe(120_000);
    expect(routeReprobeDelay(5)).toBe(960_000);
    // 30s × 2^6 = 32 min passes the cap.
    expect(routeReprobeDelay(6)).toBe(ROUTE_REPROBE_MAX_MS);
    expect(routeReprobeDelay(1_000)).toBe(ROUTE_REPROBE_MAX_MS);
    expect(Number.isFinite(routeReprobeDelay(1_000))).toBe(true);
    // A negative level is never shorter than the base.
    expect(routeReprobeDelay(-3)).toBe(ROUTE_REPROBE_BASE_MS);
  });
});

describe('engaging the hold', () => {
  it('holds a route after ONE failure with a named cause, for every slot at once', () => {
    expect(ROUTE_FAILURE_LIMIT).toBe(1);
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    expect(routeHold('m', T0)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS - 1)).not.toBeNull();
    expect(routeHold('other', T0)).toBeNull();
  });

  it('waits for three failures nothing classifies before holding', () => {
    expect(UNCLASSIFIED_FAILURE_LIMIT).toBe(3);
    recordRouteOutcome('m', { ok: false, why: UNCLASSIFIED }, T0);
    expect(routeHold('m', T0)).toBeNull();
    recordRouteOutcome('m', { ok: false, why: UNCLASSIFIED }, T0);
    expect(routeHold('m', T0)).toBeNull();
    recordRouteOutcome('m', { ok: false, why: UNCLASSIFIED }, T0);
    expect(routeHold('m', T0)).toMatch(/model route failing \(unclassified\)/);
  });

  it('a named cause after unclassified failures holds at once', () => {
    recordRouteOutcome('m', { ok: false, why: UNCLASSIFIED }, T0);
    expect(routeHold('m', T0)).toBeNull();
    recordRouteOutcome('m', { ok: false, why: 'model call failed: HTTP 401' }, T0);
    expect(routeHold('m', T0)).toMatch(/\(credentials\)/);
  });

  it('never holds a route for Brain\'s own database or for a non-model failure', () => {
    for (let i = 0; i < 5; i += 1) {
      recordRouteOutcome('m', { ok: false, why: 'database pool had no free connection' }, T0);
      recordRouteOutcome('m', { ok: false, why: 'model call failed: database did not answer in time' }, T0);
      recordRouteOutcome('m', { ok: false, why: 'the answer cited no source' }, T0);
    }
    expect(routeHold('m', T0)).toBeNull();
  });
});

describe('re-probing a held route', () => {
  it('without probeNow, the first probe waits the base delay', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS - 1)).not.toBeNull();
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });

  it('with probeNow (what takeOne passes), the probe is due at once and one slot takes it', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    // Due: routeHold only reads, so asking twice does not spend the slot.
    expect(routeHold('m', T0)).toBeNull();
    expect(routeHold('m', T0)).toBeNull();
    const undo = takeRouteProbe('m', T0);
    expect(undo).toBeTypeOf('function');
    // Every other slot of the model waits for the probe's answer.
    expect(routeHold('m', T0)).not.toBeNull();
    expect(takeRouteProbe('m', T0)).toBeNull();
  });

  it('a failed probe doubles the wait each time; a success clears hold and backoff', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    // Probe 1 fails: level 1, 60s.
    takeRouteProbe('m', T0);
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    expect(routeHold('m', T0 + routeReprobeDelay(1) - 1)).not.toBeNull();
    expect(routeHold('m', T0 + routeReprobeDelay(1))).toBeNull();
    // Probe 2 fails: level 2, 120s — probeNow does not shorten a failed probe's backoff.
    const t1 = T0 + routeReprobeDelay(1);
    takeRouteProbe('m', t1);
    recordRouteOutcome('m', { ok: false, why: NAMED }, t1, { probeNow: true });
    expect(routeHold('m', t1 + routeReprobeDelay(2) - 1)).not.toBeNull();
    expect(routeHold('m', t1 + routeReprobeDelay(2))).toBeNull();
    // Probe 3 answers: healthy.
    const t2 = t1 + routeReprobeDelay(2);
    takeRouteProbe('m', t2);
    recordRouteOutcome('m', { ok: true }, t2);
    expect(routeHold('m', t2)).toBeNull();
    expect(takeRouteProbe('m', t2)).toBeNull();
    // The backoff is gone too: the next failure starts again from level 0.
    recordRouteOutcome('m', { ok: false, why: NAMED }, t2);
    expect(routeHold('m', t2 + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });

  it('a probe whose slot never reports stops blocking the next one after ROUTE_PROBE_TIMEOUT_MS', () => {
    expect(ROUTE_PROBE_TIMEOUT_MS).toBe(3 * 60_000);
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    takeRouteProbe('m', T0);
    expect(routeHold('m', T0 + ROUTE_PROBE_TIMEOUT_MS - 1)).not.toBeNull();
    expect(routeHold('m', T0 + ROUTE_PROBE_TIMEOUT_MS)).toBeNull();
    expect(takeRouteProbe('m', T0 + ROUTE_PROBE_TIMEOUT_MS)).toBeTypeOf('function');
  });

  it('a straggler admitted before the hold engaged leaves the hold as it is', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    // Two more items that were already on the route fail after the hold engaged.
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0 + 1_000, { probeNow: true });
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0 + 2_000);
    // Neither moved the probe (not sooner via probeNow, not later) nor raised the backoff.
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS - 1)).not.toBeNull();
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS)).toBeNull();
    // The probe that then fails is the first failed probe: level 1, not 3.
    const due = T0 + ROUTE_REPROBE_BASE_MS;
    takeRouteProbe('m', due);
    recordRouteOutcome('m', { ok: false, why: NAMED }, due);
    expect(routeHold('m', due + routeReprobeDelay(1))).toBeNull();
  });

  it('takeRouteProbe\'s undo returns a probe a later filter declined, so the next item can be it', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    const undo = takeRouteProbe('m', T0)!;
    expect(routeHold('m', T0)).not.toBeNull();
    undo();
    expect(routeHold('m', T0)).toBeNull();
    // Taken again and this time it runs and fails: an ordinary failed probe.
    takeRouteProbe('m', T0);
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    expect(routeHold('m', T0 + routeReprobeDelay(1) - 1)).not.toBeNull();
    expect(routeHold('m', T0 + routeReprobeDelay(1))).toBeNull();
  });

  it('an undo after the route recovered and failed afresh does not touch the new hold', () => {
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0, { probeNow: true });
    const stale = takeRouteProbe('m', T0)!;
    recordRouteOutcome('m', { ok: true }, T0);
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    stale();
    // The new hold still waits its own base delay.
    expect(routeHold('m', T0)).not.toBeNull();
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });

  it('takeRouteProbe leaves a healthy or not-yet-due route untouched', () => {
    expect(takeRouteProbe('healthy', T0)).toBeNull();
    expect(routeHold('healthy', T0)).toBeNull();
    recordRouteOutcome('m', { ok: false, why: NAMED }, T0);
    expect(takeRouteProbe('m', T0 + 1)).toBeNull();
    expect(routeHold('m', T0 + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });
});

describe('adopting a held route\'s roles', () => {
  const workers = [{ model: 'brain-a' }, { model: 'brain-b' }];

  it('adoptedRoles names the held workers, never the slot itself or its own model', () => {
    expect(adoptedRoles(workers, 0, T0)).toEqual([]);
    expect(adoptedRoles(workers, 1, T0)).toEqual([]);
    recordRouteOutcome('brain-a', { ok: false, why: NAMED }, T0);
    expect(adoptedRoles(workers, 1, T0)).toEqual([0]);
    expect(adoptedRoles(workers, 0, T0)).toEqual([]);
    // Two slots of the same model never adopt each other.
    expect(adoptedRoles([{ model: 'brain-a' }, { model: 'brain-a' }], 1, T0)).toEqual([]);
    // Once the probe is due the route is offered work again, and nobody adopts it.
    expect(adoptedRoles(workers, 1, T0 + ROUTE_REPROBE_BASE_MS)).toEqual([]);
  });

  it('claimAsks asks for an adopted worker\'s types, and only then', () => {
    const flat = (asks: string[][]) => asks.map((one) => one.join(','));
    expect(flat(claimAsks(workers, 1))).toEqual(['RESEARCH_AUDIT', 'RESEARCH_VERIFY']);
    expect(flat(claimAsks(workers, 1, false, [0]))).toEqual([
      'RESEARCH_SYNTHESIZE',
      'RESEARCH_AUDIT',
      'RESEARCH_VERIFY',
      'RESEARCH_PLAN',
      'RESEARCH_FRAGMENT',
    ]);
    expect(flat(claimAsks(workers, 0))).not.toContain('RESEARCH_VERIFY');
    expect(flat(claimAsks(workers, 0, false, [1]))).toContain('RESEARCH_VERIFY');
  });
});

/* ------------------------------------------------------------------------- */
/* The recorded failure class, through the real takeOne                       */
/* ------------------------------------------------------------------------- */

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);

/** A model that answers a research fragment, and the verification it queues, the way a capable one would. */
const answers: Completer = async (_config, _name, _system, prompt) => {
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL], search: 'receptionist wage' });
  if (prompt.includes('For each claim decide')) {
    const id = /"claimId":\s*"([^"]+)"/.exec(prompt)?.[1] ?? '';
    return JSON.stringify({
      verdicts: [{
        claim_id: id, supports_claim: true, geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH',
        geography_basis: 'The page is the US national figure.', timeframe_basis: 'May 2024, inside the fragment window.',
        population_basis: 'Receptionists, the population asked about.', definitions_basis: 'Median hourly wage as asked.',
      }],
      sufficiency: 'SUFFICIENT',
      missing_lanes: [],
    });
  }
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
        evidence_lane: 'wage',
        primary_source: true,
        confidence: 0.9,
      },
    ],
  });
};

const fetchSource = async (url: string): Promise<SourceFetch> =>
  url === PAGE_URL
    ? {
        readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
        retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length,
      }
    : { readable: false, requestedUrl: url, finalUrl: null, status: 404, retrievedAt: new Date().toISOString(), reason: 'HTTP_ERROR' as never, detail: '404' };

let project: TestProject;

/** One queued research fragment of its own packet: brain-a's role (worker 0). */
async function queueFragment(title: string): Promise<string> {
  const projectId = project.project.id;
  const layerId = (await project.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title, assignment: 'What does a human receptionist cost per hour in the US?', provider: 'WORKER', autoApprove: false,
  });
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'receptionist-wage',
    question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
    population: 'Receptionists', definitions: 'Median hourly wage',
    requiredEvidence: [{ id: 'wage', description: 'an official wage statistic', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['official statistics'], excludedSourceTypes: [], completionCriteria: ['One official wage figure'],
    dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
  }]);
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

async function itemState(id: string): Promise<string | undefined> {
  return (await getDb().get<{ state: string }>('SELECT state FROM work_items WHERE id = ?', [id]))?.state;
}

async function laneRows(model: string, outcome: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = ? AND project_id = ? AND reason LIKE ?",
    [outcome, project.project.id, `model ${model}%`],
  );
  return Number(row?.n ?? 0);
}

describe('one model\'s route refuses every call (the recorded failure class)', () => {
  beforeEach(async () => {
    project = await freshProject();
    resetFreeLaneFitness();
    await setBrainOnlyMode(true, 'test', 'route-hold suite');
  });

  it('the refusing route is called twice, not once per item; the healthy model adopts its role and submits every item', async () => {
    const ids = [await queueFragment('wage 1'), await queueFragment('wage 2'), await queueFragment('wage 3'), await queueFragment('wage 4')];
    const workers = await ensureFreeWorkers(CONFIG);
    expect(workers.map((w) => w.model)).toEqual(['brain-a', 'brain-b']);
    const calls: Record<string, number> = { 'brain-a': 0, 'brain-b': 0 };
    const completer: Completer = async (config, name, system, prompt, options) => {
      calls[name] = (calls[name] ?? 0) + 1;
      if (name === 'brain-a') throw new Error('cheap lane HTTP 503');
      return answers(config, name, system, prompt, options);
    };
    const base = { workers, completer, fetchSource, search: async () => [], config: CONFIG };
    const slotA = { ...base, worker: workers[0]!, index: 0 };
    const slotB = { ...base, worker: workers[1]!, index: 1 };

    // While brain-a is healthy, brain-b's slot does not take brain-a's role.
    expect((await takeOne(slotB)).claimed).toBeNull();

    // brain-a's first item is refused. One named-cause failure engages the hold,
    // and (probeNow) the very next brain-a slot is the single probe.
    const first = await takeOne(slotA);
    expect(first.claimed).not.toBeNull();
    expect(first.ok).toBe(false);
    expect(routeHold('brain-a')).toBeNull(); // the probe is due at once
    const probe = await takeOne(slotA);
    expect(probe.claimed).not.toBeNull();
    expect(probe.claimed!.workItemId).not.toBe(first.claimed!.workItemId);
    expect(probe.ok).toBe(false);
    // The probe failed: the route is held for the backoff, for every brain-a slot.
    expect(routeHold('brain-a')).toMatch(/provider availability/);
    for (let i = 0; i < 5; i += 1) expect((await takeOne(slotA)).claimed).toBeNull();
    expect(await laneRows('brain-a', 'RELEASED_TRANSIENT')).toBe(2);
    const refusedCalls = calls['brain-a'];

    // brain-b's slot adopts brain-a's role and takes every item, including the
    // two brain-a handed back.
    const done = new Set<string>();
    for (let i = 0; i < 20 && done.size < ids.length; i += 1) {
      const next = await takeOne(slotB);
      if (!next.claimed) break;
      expect(next.ok).toBe(true);
      if (ids.includes(next.claimed.workItemId)) done.add(next.claimed.workItemId);
    }
    expect([...done].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await itemState(id)).toBe('SUCCEEDED');
    expect(await laneRows('brain-b', 'SUBMITTED')).toBeGreaterThanOrEqual(ids.length);
    // And the refusing route was not called once more meanwhile.
    expect(calls['brain-a']).toBe(refusedCalls);
    expect(await laneRows('brain-a', 'RELEASED_TRANSIENT')).toBe(2);
  }, 60_000);

  it('an intermittent refusal does not idle the model: the immediate probe answers and its slots carry on', async () => {
    const ids = [await queueFragment('wage 1'), await queueFragment('wage 2'), await queueFragment('wage 3')];
    const workers = await ensureFreeWorkers(CONFIG);
    let refuse = true;
    const completer: Completer = async (config, name, system, prompt, options) => {
      if (refuse) throw new Error('cheap lane HTTP 503');
      return answers(config, name, system, prompt, options);
    };
    const slotA = { workers, completer, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };

    const first = await takeOne(slotA);
    expect(first.ok).toBe(false);
    refuse = false;
    // The probe is the next item, at once — no clock to wait out.
    const probe = await takeOne(slotA);
    expect(probe.claimed).not.toBeNull();
    expect(probe.ok).toBe(true);
    expect(routeHold('brain-a')).toBeNull();
    // Healthy again: the route's cooldowns end with its success, so its slot takes the rest, the refused one included.
    const done = new Set<string>([probe.claimed!.workItemId]);
    for (let i = 0; i < 10 && done.size < ids.length; i += 1) {
      const next = await takeOne(slotA);
      if (!next.claimed) break;
      expect(next.ok).toBe(true);
      if (ids.includes(next.claimed.workItemId)) done.add(next.claimed.workItemId);
    }
    expect([...done].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await itemState(id)).toBe('SUCCEEDED');
  }, 60_000);
});
