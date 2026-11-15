/**
 * CAP-16-3 repair, episode 2 — the free lane stops spending items on a model
 * route the provider is refusing.
 *
 * Production, 2026-11-15 20:03–21:51Z (probe r01.cap-16-3): 2 accepted of 187
 * lane outcomes, 98% provider failures. The route hold engaged only after three
 * consecutive failures and re-probed on a fixed five-minute clock, while every
 * concurrent slot of the model kept claiming items onto the refusing route.
 * These tests pin the repair: one named-cause failure holds the route for every
 * slot, one probe item at a time with exponential backoff, a success clears it,
 * a released item goes to a healthy model first, Brain's own database being
 * busy never holds a model route, and every attempt's row keeps its real reason.
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
  adoptedRoles,
  claimAsks,
  endFreeLaneCooldowns,
  ensureFreeWorkers,
  recordRouteOutcome,
  resetFreeLaneFitness,
  resetRouteHealth,
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
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Route health, pure                                                         */
/* ------------------------------------------------------------------------- */

describe('route hold: one named-cause failure holds the route (worker.ts)', () => {
  beforeEach(() => resetRouteHealth());
  afterEach(() => resetRouteHealth());

  it('holds after a single provider-busy failure, for every slot of that model only', () => {
    const now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    expect(routeHold('x', now)).toMatch(/model route failing \(provider availability\)/);
    expect(routeHold('x', now + ROUTE_REPROBE_BASE_MS - 1)).not.toBeNull();
    expect(routeHold('y', now)).toBeNull();
  });

  it('holds at once for credentials, task routing and a broken GPU too', () => {
    const now = 5_000_000;
    recordRouteOutcome('a', { ok: false, why: 'model call failed: cheap lane HTTP 401' }, now);
    recordRouteOutcome('b', { ok: false, why: 'model call failed: cheap lane HTTP 404' }, now);
    recordRouteOutcome('c', { ok: false, why: 'model call failed [broken GPU]: runpod HTTP 404' }, now);
    expect(routeHold('a', now)).toContain('credentials');
    expect(routeHold('b', now)).toContain('task routing');
    expect(routeHold('c', now)).toContain('broken GPU');
  });

  it('an error nothing classifies is not yet evidence the route is down', () => {
    const now = 5_000_000;
    for (let i = 0; i < UNCLASSIFIED_FAILURE_LIMIT - 1; i += 1) {
      recordRouteOutcome('x', { ok: false, why: 'model call failed: something odd' }, now);
      expect(routeHold('x', now)).toBeNull();
    }
    recordRouteOutcome('x', { ok: false, why: 'model call failed: something odd' }, now);
    expect(routeHold('x', now)).toContain('unclassified');
  });

  it('admits exactly one probe when it is due, and holds every other slot until it answers', () => {
    const now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    const due = now + ROUTE_REPROBE_BASE_MS;
    expect(routeHold('x', due)).toBeNull();
    expect(takeRouteProbe('x', due)).not.toBeNull(); // the probe
    expect(takeRouteProbe('x', due)).toBeNull(); // a second slot gets none
    expect(routeHold('x', due + 1)).not.toBeNull();
    // A probe whose slot died stops blocking the next one.
    expect(routeHold('x', due + ROUTE_PROBE_TIMEOUT_MS)).toBeNull();
  });

  it('a probe declined by a later filter hands the slot back', () => {
    const now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    const due = now + ROUTE_REPROBE_BASE_MS;
    const undo = takeRouteProbe('x', due);
    expect(routeHold('x', due)).not.toBeNull();
    undo!();
    expect(routeHold('x', due)).toBeNull();
    expect(takeRouteProbe('x', due)).not.toBeNull();
  });

  it('each failed probe doubles the wait, up to the cap', () => {
    let now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    let expected = ROUTE_REPROBE_BASE_MS;
    for (let round = 1; round <= 12; round += 1) {
      now += expected;
      expect(takeRouteProbe('x', now)).not.toBeNull();
      recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
      expected = Math.min(ROUTE_REPROBE_MAX_MS, ROUTE_REPROBE_BASE_MS * 2 ** round);
      expect(routeReprobeDelay(round)).toBe(expected);
      expect(routeHold('x', now + expected - 1)).not.toBeNull();
      expect(routeHold('x', now + expected)).toBeNull();
    }
    expect(routeReprobeDelay(40)).toBe(ROUTE_REPROBE_MAX_MS);
  });

  it('a failure from an item already in flight when the hold engaged neither raises the backoff nor extends the hold', () => {
    const now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now + 10);
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now + 20);
    expect(routeHold('x', now + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });

  it('a successful answer clears the hold and the backoff', () => {
    let now = 5_000_000;
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    for (let round = 0; round < 3; round += 1) {
      now += routeReprobeDelay(round);
      takeRouteProbe('x', now);
      recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    }
    expect(routeHold('x', now + 1)).not.toBeNull();
    recordRouteOutcome('x', { ok: true }, now + 1);
    expect(routeHold('x', now + 1)).toBeNull();
    // The next outage starts again at the base wait, not where the last one left off.
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now + 2);
    expect(routeHold('x', now + 2 + ROUTE_REPROBE_BASE_MS)).toBeNull();
  });

  it('Brain’s own database being unavailable never holds a model route', () => {
    const now = 5_000_000;
    for (let i = 0; i < 5; i += 1) {
      recordRouteOutcome('x', { ok: false, why: 'database pool had no free connection' }, now);
      recordRouteOutcome('x', { ok: false, why: 'model call failed: Brain is temporarily busy' }, now);
    }
    expect(routeHold('x', now)).toBeNull();
  });

  it('a held route’s roles are adopted by the other model’s slots', () => {
    const now = 5_000_000;
    const workers = [{ model: 'x' }, { model: 'y' }];
    expect(adoptedRoles(workers, 1, now)).toEqual([]);
    expect(claimAsks(workers, 1).flat()).toEqual(['RESEARCH_AUDIT', 'RESEARCH_VERIFY']);
    recordRouteOutcome('x', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, now);
    expect(adoptedRoles(workers, 1, now)).toEqual([0]);
    expect(adoptedRoles(workers, 0, now)).toEqual([]);
    expect(claimAsks(workers, 1, false, [0]).flat()).toEqual(
      expect.arrayContaining(['RESEARCH_SYNTHESIZE', 'RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_AUDIT']),
    );
  });
});

/* ------------------------------------------------------------------------- */
/* Through takeOne, on real queue rows                                        */
/* ------------------------------------------------------------------------- */

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const QUOTE = 'The median hourly wage for receptionists was $17.39 in May 2024.';
const PAGE = `Receptionists. Summary. ${QUOTE} ` + 'Employment of receptionists is projected to show little or no change. '.repeat(3);

/** A model that answers a fragment's stages the way a capable one would. */
const answers: Completer = async (_config, _name, _system, prompt) => {
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL], search: 'receptionist wage' });
  if (prompt.includes('Extract the material claims')) {
    return JSON.stringify({
      claims: [
        {
          claim: 'The US median hourly wage for receptionists was $17.39 in May 2024.',
          claim_type: 'SOURCED_FACT',
          source_url: PAGE_URL,
          source_title: 'Receptionists — Occupational Outlook Handbook',
          source_publisher: 'U.S. Bureau of Labor Statistics',
          source_date: '2025-04-18',
          evidence_excerpt: QUOTE,
          evidence_lane: 'wage',
          primary_source: true,
          confidence: 0.9,
        },
      ],
    });
  }
  if (prompt.includes('For each claim decide')) {
    const id = /"claimId":\s*"([^"]+)"/.exec(prompt)?.[1] ?? '';
    return JSON.stringify({
      verdicts: [
        {
          claim_id: id,
          supports_claim: true,
          geography: 'MATCH',
          timeframe: 'MATCH',
          population: 'MATCH',
          definitions: 'MATCH',
          geography_basis: 'US national figure.',
          timeframe_basis: 'May 2024.',
          population_basis: 'Receptionists.',
          definitions_basis: 'Median hourly wage.',
        },
      ],
      sufficiency: 'SUFFICIENT',
      missing_lanes: [],
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

async function fragmentItem(title: string): Promise<string> {
  const projectId = play.project.id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration: ResearchOrchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'What does a human receptionist cost per hour in the US?',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = (await createFragments([
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
  ])) as ResearchFragment[];
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

async function laneRows(): Promise<{ outcome: string; reason: string | null; work_item_id: string | null }[]> {
  return getDb().all(
    "SELECT outcome, reason, work_item_id FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND project_id = ? ORDER BY at, id",
    [play.project.id],
  );
}

describe('route hold through takeOne (worker.ts)', () => {
  beforeEach(async () => {
    play = await freshProject();
    resetFreeLaneFitness();
    resetRouteHealth();
    endFreeLaneCooldowns();
    layerId = (await play.layerByName('Monetization Logic')).id;
    await setBrainOnlyMode(true, 'test', 'route hold suite');
  });
  afterEach(() => {
    resetRouteHealth();
    endFreeLaneCooldowns();
  });

  it('after one provider failure, exactly one probe item is admitted while every other slot of the model waits; its success clears the hold', async () => {
    for (let i = 0; i < 3; i += 1) await fragmentItem(`outage ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    let mode: 'down' | 'gate' | 'up' = 'down';
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let gated = false;
    let calls = 0;
    const completer: Completer = async (config, name, system, prompt, options) => {
      calls += 1;
      if (mode === 'down') throw new Error('cheap lane HTTP 503');
      if (mode === 'gate' && !gated) {
        gated = true;
        await gate;
      }
      return answers(config, name, system, prompt, options);
    };
    const base = { workers, completer, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };

    const failed = await takeOne(base);
    expect(failed.claimed).not.toBeNull();
    expect(failed.ok).toBe(false);
    expect(routeHold('brain-a')).toBeNull(); // the single probe is due

    mode = 'gate';
    const probe = takeOne(base); // takes the probe and waits on the provider
    for (let i = 0; i < 200 && !gated; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(gated).toBe(true);
    expect(routeHold('brain-a')).not.toBeNull();
    const callsBefore = calls;
    // Two more slots of brain-a: neither admits an item while the probe is out.
    const [second, third] = await Promise.all([takeOne(base), takeOne(base)]);
    expect(second.claimed).toBeNull();
    expect(third.claimed).toBeNull();
    expect(calls).toBe(callsBefore);

    openGate();
    const answered = await probe;
    expect(answered.ok).toBe(true);
    expect(answered.claimed?.workItemId).not.toBe(failed.claimed!.workItemId);
    expect(routeHold('brain-a')).toBeNull();
    mode = 'up';
    const next = await takeOne(base);
    expect(next.claimed).not.toBeNull();
  });

  it('a failed probe backs the route off: no item is admitted onto it until the longer wait has passed', async () => {
    for (let i = 0; i < 3; i += 1) await fragmentItem(`down ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    const base = { workers, completer: down, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    expect((await takeOne(base)).claimed).not.toBeNull(); // engages the hold
    expect((await takeOne(base)).claimed).not.toBeNull(); // the probe, which fails
    expect(routeHold('brain-a')).toMatch(/provider availability/);
    expect((await takeOne(base)).claimed).toBeNull(); // held: the third item waits
    const rows = await laneRows();
    expect(rows).toHaveLength(2);
  });

  it('an item released after a route failure on brain-a is admitted by healthy brain-b while brain-a is held', async () => {
    const itemId = await fragmentItem('spill');
    const workers = await ensureFreeWorkers(CONFIG);
    const completer: Completer = async (config, name, system, prompt, options) => {
      if (name === 'brain-a') throw new Error('cheap lane HTTP 503');
      return answers(config, name, system, prompt, options);
    };
    const base = { workers, completer, fetchSource, search: async () => [], config: CONFIG };
    const failed = await takeOne({ ...base, worker: workers[0]!, index: 0 });
    expect(failed.claimed?.workItemId).toBe(itemId);
    // Hold brain-a on the clock as well, as a failed probe would.
    recordRouteOutcome('brain-a', { ok: false, why: 'model call failed: cheap lane HTTP 503' }, Date.now());
    // brain-b's own (non-spillover) pass takes it: brain-a's role is adopted.
    const taken = await takeOne({ ...base, worker: workers[1]!, index: 1 });
    expect(taken.claimed?.workItemId).toBe(itemId);
    expect(taken.ok).toBe(true);
  });

  it('without a route failure, the other model still leaves brain-a’s role alone on its own pass', async () => {
    await fragmentItem('own role');
    const workers = await ensureFreeWorkers(CONFIG);
    const base = { workers, completer: answers, fetchSource, search: async () => [], config: CONFIG };
    expect((await takeOne({ ...base, worker: workers[1]!, index: 1 })).claimed).toBeNull();
    expect((await takeOne({ ...base, worker: workers[0]!, index: 0 })).ok).toBe(true);
  });

  it('a database-unavailable failure does not hold the route', async () => {
    await fragmentItem('db busy');
    const workers = await ensureFreeWorkers(CONFIG);
    const busy: Completer = async () => {
      throw new Error('The database pool had no free connection (593 caller(s) waiting)');
    };
    const base = { workers, completer: busy, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    expect((await takeOne(base)).claimed).not.toBeNull();
    expect(routeHold('brain-a')).toBeNull();
    recordRouteOutcome('brain-a', { ok: false, why: 'database pool had no free connection' });
    expect(routeHold('brain-a')).toBeNull();
  });

  it('every failed attempt keeps its real “model call failed [cause]” reason on its FREE_LANE_ITEM row', async () => {
    for (let i = 0; i < 2; i += 1) await fragmentItem(`reason ${i}`);
    const workers = await ensureFreeWorkers(CONFIG);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    const base = { workers, completer: down, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    await takeOne(base);
    await takeOne(base);
    const rows = await laneRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.outcome).toBe('RELEASED_TRANSIENT');
      expect(row.reason).toMatch(/^model brain-a: model call failed/);
      expect(row.reason).toMatch(/HTTP 503/);
    }
  });
});
