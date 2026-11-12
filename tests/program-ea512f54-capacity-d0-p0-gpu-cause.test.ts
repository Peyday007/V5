/**
 * CAP-16-3, A01: the cause behind failing model throughput is identified from
 * current signals and recorded, and whether queued work advances afterwards is
 * read from the rows.
 *
 * Production case reproduced here (Cheap lane run 42577770227, 2026-11-09): the
 * RunPod pod had been deleted, RunPod's API could not return it (the
 * supervisor's samples were UNKNOWN, none RUNNING), every GPU call got a 404,
 * the call fell back to the free provider, and the failure was recorded under
 * the fallback's words — "model call failed: cheap lane HTTP N" — which named
 * the fallback and hid the GPU. Run 42977317943 (2026-11-11), after the pod was
 * recreated, shows the route serving again: 165 GPU jobs submitted, 0 fallbacks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { resetRunpod, routeRunpod } from '../server/services/cheap/runpod.ts';
import type { LaneConfig } from '../server/services/cheap/lane.ts';
import {
  diagnoseThroughput,
  readQueueAdvance,
  recordStageCapacity,
  routeOfReason,
  STAGE_CAPACITY_EVENT,
  stageCapacity,
} from '../server/services/freeLane/stageCapacity.ts';
import {
  causeOfReason,
  classifyRouteFailure,
  gpuDown,
  recordRouteOutcome,
  resetRouteHealth,
  ROUTE_FAILURE_LIMIT,
  routeHold,
} from '../server/services/freeLane/worker.ts';

const GPU = 'runpod/Qwen/Qwen3-4B';
const FREE = 'brain-a';

/* ------------------------------------------------------------------------- */
/* The worker names the GPU, not the fallback                                 */
/* ------------------------------------------------------------------------- */

describe('a GPU-slot failure is attributed to the GPU (worker.ts)', () => {
  beforeEach(() => {
    resetRunpod();
    resetRouteHealth();
  });
  afterEach(() => {
    resetRunpod();
    resetRouteHealth();
  });

  const config: LaneConfig = {
    url: 'http://free.invalid/v1',
    key: null,
    models: [GPU, FREE],
    dailyBudget: 100,
    timeoutMs: 1000,
    runpod: { url: 'http://pod.invalid/v1', key: null, model: 'Qwen/Qwen3-4B', label: GPU },
    fallbackModel: FREE,
  };
  // The deleted pod: RunPod's proxy answers 404 for every path.
  const deletedPod = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

  async function oneFailedGpuCall(): Promise<string> {
    try {
      await routeRunpod(config, 's', 'p', { maxTokens: 10 }, async () => {
        throw new Error('cheap lane HTTP 429');
      }, { fetchImpl: deletedPod });
      return 'answered';
    } catch (error) {
      return (error as Error).message;
    }
  }

  it('the error that reaches the worker is the fallback’s, and text alone would blame the provider', async () => {
    const message = await oneFailedGpuCall();
    expect(message).toBe('cheap lane HTTP 429');
    expect(classifyRouteFailure(message)).toBe('provider availability');
  });

  it('reads the GPU slot as down from its own calls, and classifies the failure as the GPU', async () => {
    expect(gpuDown(GPU)).toBe(false);
    const message = await oneFailedGpuCall();
    expect(gpuDown(GPU)).toBe(true);
    // A free-provider route is never "GPU down", whatever the GPU is doing.
    expect(gpuDown(FREE)).toBe(false);
    expect(classifyRouteFailure(message, { gpuDown: gpuDown(GPU) })).toBe('broken GPU');
    // The GPU's own error text, when it is the one recorded, names the GPU even
    // though it carries an HTTP 404 (which on a free provider means task routing).
    expect(classifyRouteFailure('runpod HTTP 404')).toBe('broken GPU');
    expect(classifyRouteFailure('cheap lane HTTP 404')).toBe('task routing');
  });

  it('holds the route under the tagged cause, even when the detail would classify differently', () => {
    const why = "model call failed [broken GPU]: GPU slot's own calls failing; the fallback then said: cheap lane HTTP 404";
    expect(causeOfReason(why)).toBe('broken GPU');
    for (let i = 0; i < ROUTE_FAILURE_LIMIT; i += 1) recordRouteOutcome(GPU, { ok: false, why });
    expect(routeHold(GPU)).toContain('broken GPU');
  });

  it('reads an untagged historical reason by its text, and nothing from a non-model failure', () => {
    expect(causeOfReason('model x: model call failed: cheap lane HTTP 401')).toBe('credentials');
    expect(causeOfReason('model x: no JSON in a 12-character reply')).toBeNull();
    expect(causeOfReason(null)).toBeNull();
    expect(routeOfReason(`model ${GPU}: model call failed: cheap lane HTTP 404`)).toBe(GPU);
    expect(routeOfReason(`model ${GPU}`)).toBe(GPU);
    expect(routeOfReason('something else')).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* The rows name the cause, the restoration, and whether work advanced         */
/* ------------------------------------------------------------------------- */

describe('diagnoseThroughput / recordStageCapacity (stageCapacity.ts)', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  /** Writes a row and dates it, since recordBinEvent stamps the current time. */
  async function at(iso: string, input: Parameters<typeof recordBinEvent>[0]): Promise<void> {
    await recordBinEvent(input);
    await getDb().run(
      'UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events ORDER BY rowid DESC LIMIT 1)',
      [iso],
    );
  }
  const item = (iso: string, outcome: string, reason: string) =>
    at(iso, { eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_VERIFY', outcome, reason, durationMs: 1000 });
  const sample = (iso: string, status: string) =>
    at(iso, { eventType: 'RUNPOD_POD', provider: 'runpod', outcome: `SAMPLE_${status}`, reason: 'sample' });

  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 1, 0, 0) + minutes * 60_000).toISOString();

  /** The failing window of run 42577770227, in miniature, with the rows' own words. */
  async function failingWindow(): Promise<void> {
    for (let m = 0; m < 30; m += 5) await sample(t(m), 'UNKNOWN');
    for (let m = 1; m <= 6; m += 1) await item(t(m), 'RELEASED_TRANSIENT', `model ${GPU}: model call failed: cheap lane HTTP 404`);
    await item(t(7), 'RELEASED_TRANSIENT', `model ${FREE}: model call failed: cheap lane HTTP 429`);
    await item(t(8), 'RELEASED_TRANSIENT', `model ${FREE}: model call failed: cheap lane HTTP 429`);
    await item(t(9), 'SUBMITTED', `model ${FREE}`);
  }

  it('names the deleted GPU as the cause of the window, though every failure’s text named the fallback', async () => {
    await failingWindow();
    const diagnosis = await diagnoseThroughput(t(-1));
    const gpu = diagnosis.routes.find((r) => r.route === GPU)!;
    expect(gpu.providerFailures).toBe(6);
    expect(gpu.causeCounts).toEqual({ 'task routing': 6 });
    expect(gpu.cause).toBe('broken GPU');
    expect(gpu.evidence).toContain('never saw the pod running while the route failed');
    expect(gpu.evidence).toContain('UNKNOWN 2'); // the samples up to its last failure (t+0, t+5)
    expect(gpu.restored).toBe(false);
    expect(diagnosis.gpu.notRunning).toBe(true);
    // The free route answered after its last failure: not what to restore.
    expect(diagnosis.routes.find((r) => r.route === FREE)!.restored).toBe(true);
    expect(diagnosis.primary).toEqual({ route: GPU, cause: 'broken GPU', failures: 6, evidence: gpu.evidence });

    // The measurement consumes the cause: the constraint says what to restore first.
    const report = await stageCapacity({ hours: 1, now: Date.parse(t(30)) });
    expect(report.diagnosis.primary?.route).toBe(GPU);
    expect(report.constrained.recommendation).toMatch(new RegExp(`^Restore model route ${GPU.replace(/\//g, '\\/')} first: 6 failure\\(s\\) in the window name broken GPU`));
    expect(report.constrained.recommendation).toContain('Do not enlarge the web process');
  });

  it('keeps the failures’ own cause when the supervisor saw the pod running', async () => {
    await sample(t(0), 'RUNNING');
    await item(t(1), 'RELEASED_TRANSIENT', `model ${GPU}: model call failed: cheap lane HTTP 401`);
    const diagnosis = await diagnoseThroughput(t(-1));
    expect(diagnosis.primary).toMatchObject({ route: GPU, cause: 'credentials' });
  });

  it('records the cause, then the restoration and the queue advancing, as production rows', async () => {
    await failingWindow();
    await recordStageCapacity({ hours: 1, now: Date.parse(t(30)) });
    await getDb().run('UPDATE bin_events SET at = ? WHERE event_type = ?', [t(30), STAGE_CAPACITY_EVENT]);

    // The pod recreated: the supervisor sees it running and the GPU's work is accepted again.
    await sample(t(35), 'RUNNING');
    await item(t(36), 'SUBMITTED', `model ${GPU}`);
    await item(t(37), 'SUBMITTED', `model ${GPU}`);
    await recordStageCapacity({ hours: 1, now: Date.parse(t(40)) });

    const rows = await getDb().all<{ reason: string; measures: string }>(
      'SELECT reason, measures FROM bin_events WHERE event_type = ? ORDER BY rowid',
      [STAGE_CAPACITY_EVENT],
    );
    expect(rows).toHaveLength(2);
    const [failing, restored] = rows.map((r) => ({ reason: r.reason, measures: JSON.parse(r.measures) as Record<string, any> }));

    expect(failing!.reason).toContain(`Failing: ${GPU} (broken GPU; 6 failure(s))`);
    expect(failing!.measures['diagnosis'].primary.cause).toBe('broken GPU');
    expect(failing!.measures['queueAdvance'].verdict).toBe('FIRST_READING');

    expect(restored!.reason).toContain(`Restored:`);
    expect(restored!.reason).toContain(`${GPU} (broken GPU)`);
    expect(restored!.reason).toContain('Queued work advancing.');
    expect(restored!.measures['diagnosis'].primary).toBeNull();
    expect(restored!.measures['queueAdvance']).toMatchObject({ verdict: 'ADVANCING', acceptedSincePrevious: 2 });
  });

  it('reads a stall when work waits and nothing is accepted between readings', async () => {
    await recordStageCapacity({ hours: 1 });
    const advance = await readQueueAdvance(4);
    expect(advance.verdict).toBe('STALLED');
    expect(advance.acceptedSincePrevious).toBe(0);
    expect(await readQueueAdvance(0)).toMatchObject({ verdict: 'IDLE' });
  });
});
