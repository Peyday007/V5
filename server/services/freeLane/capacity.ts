/**
 * How many free-lane jobs run at once, decided from measurements (§86).
 *
 * The lane began at a fixed two slots per model. Nothing measured said two:
 * each slot spends almost all of its time waiting on a model call over HTTP, so
 * neither the Brain machine nor its database is what limits it — the providers'
 * own rate limits are, together with how much useful work is queued and whether
 * Brain keeps up with what comes back. So the number is a controller's output:
 *
 *   - **grow** (double) while useful research is waiting, provider errors are
 *     acceptable, answers are mostly being accepted, and Brain itself is not
 *     under database, event-loop or CPU pressure;
 *   - **shrink** (halve) when providers overload (429/5xx/timeouts) or Brain is
 *     under pressure, per model, so one provider's trouble never stops the other;
 *   - **hold** when answers are mostly failing — more slots would multiply
 *     failed work, not useful work — or when the slots it has are not filled;
 *   - **decay** gently when nothing is waiting.
 *
 * Each model is its own controller, its target persists in `free_lane_capacity`
 * so a restart resumes from what was learned, and every change is a
 * `FREE_LANE_CAPACITY` event carrying the measurements that drove it. The only
 * fixed number is `SAFETY_CEILING`, a runaway guard far above anything the
 * measurements have reached; it is not the operating limit.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { databasePoolReadings } from '../../db/database.ts';
import { recentInfraFailures } from '../../db/infra.ts';
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../cheap/lane.ts';
import { isRunpodSlot, runpodCallWindow } from '../cheap/runpod.ts';
import { superviseRunpodPod } from '../cheap/runpodPod.ts';
import type { SourceFetch } from '../sources/fetchForWorker.ts';
import type { RecordedStageCapacity } from './stageCapacity.ts';
import { readSource } from '../sources/access.ts';
import { setSearchRefusalRecorder } from '../sources/discover.ts';
import {
  closeFiledFreeLaneBins,
  coolingForEveryModel,
  ensureFreeWorkers,
  takeOne,
  discoverCandidates,
  freeLaneSkips,
  type FreeWorker,
} from './worker.ts';

export const SAFETY_CEILING = 256;
export const MIN_TARGET = 1;
const START_TARGET = 2;
const WINDOW_MS = 3 * 60_000;
const CONTROL_MS = 30_000;
const IDLE_SLEEP_MS = 20_000;
/** Mean event-loop lag over a control window above which every model's slots halve. */
export const LAG_SHRINK_MS = 1_000;

export interface Window {
  ok: number;
  content: number;
  transient: number;
}

export interface Pressure {
  /** Saturated: an infrastructure failure in the last minute, or the pools' queues at their size. */
  db: boolean;
  /** Contended: callers waited for a connection since the last step. Holds growth; does not shrink. */
  dbContended?: boolean;
  lagMs: number;
  cpu: number;
}

export interface Decision {
  target: number;
  reason: string;
  stable: boolean;
}

/** One model's next target. Pure, so every decision can be replayed from its inputs. */
export function decideTarget(input: {
  target: number;
  active: number;
  waiting: number;
  window: Window;
  pressure: Pressure;
  ceiling?: number;
}): Decision {
  const ceiling = input.ceiling ?? SAFETY_CEILING;
  const { target, active, waiting, window, pressure } = input;
  const samples = window.ok + window.content + window.transient;
  const transientRate = samples > 0 ? window.transient / samples : 0;
  const okRate = samples > 0 ? window.ok / samples : 1;
  const half = Math.max(MIN_TARGET, Math.floor(target / 2));
  if (pressure.db) return { target: half, reason: 'Brain database saturated', stable: false };
  // The lane's slots wait on HTTP; the mean lag that should shrink them is Brain's own stall,
  // not a busy loop. At 300 ms the lane sat at one slot through ordinary bursts (production
  // 2026-11-14: halved at 474–974 ms with highest stable targets of 19–26).
  if (pressure.lagMs > LAG_SHRINK_MS) return { target: half, reason: `Brain event loop lagging ${Math.round(pressure.lagMs)} ms`, stable: false };
  if (pressure.cpu > 0.85) return { target: half, reason: `Brain CPU at ${Math.round(pressure.cpu * 100)}%`, stable: false };
  if (samples >= 4 && transientRate >= 0.3) {
    return { target: half, reason: `provider overloaded: ${Math.round(transientRate * 100)}% of ${samples} calls failed`, stable: false };
  }
  const stable = samples >= 4 && transientRate < 0.1;
  if (waiting <= 0) {
    return { target: Math.max(START_TARGET, Math.ceil(target * 0.75)), reason: 'no research waiting', stable };
  }
  if (pressure.dbContended) {
    return { target, reason: 'database connections contended; holding until they free up', stable };
  }
  if (samples >= 6 && okRate < 0.2) {
    return { target, reason: `answers mostly failing (${Math.round(okRate * 100)}% accepted); not multiplying failed work`, stable };
  }
  if (target >= 4 && active < target / 2) {
    return { target, reason: `slots not filled (${active} of ${target} busy)`, stable };
  }
  if (target >= ceiling) return { target: ceiling, reason: 'at the safety ceiling', stable };
  const grown = Math.min(ceiling, target * 2, Math.max(target + 1, active + waiting));
  return { target: grown, reason: `useful research waiting (${waiting}), errors acceptable`, stable };
}

/* ------------------------------------------------------------------------- */
/* Measurements                                                               */
/* ------------------------------------------------------------------------- */

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

/** The most callers seen waiting for a connection since the last step, sampled by every slot. */
let peakWaiting = 0;
let peakControlWaiting = 0;
function samplePools(): void {
  const pools = databasePoolReadings();
  if (!pools) return;
  peakWaiting = Math.max(peakWaiting, pools.workload.waiting);
  peakControlWaiting = Math.max(peakControlWaiting, pools.control?.waiting ?? 0);
}

function readPressure(): Pressure {
  const lagMs = lag.mean / 1e6;
  lag.reset();
  const now = Date.now();
  const used = process.cpuUsage(lastCpu);
  const cpu = (used.user + used.system) / 1000 / Math.max(1, now - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  /*
   * Graded, not `databaseUnderPressure`'s yes/no. That reads any single waiter
   * as pressure, which is right for deferring optional work (§63) and wrong for
   * sizing a pool: one momentary waiter would halve the lane every step, and it
   * did, on the test cluster. Saturation halves; contention only holds.
   */
  samplePools();
  const pools = databasePoolReadings();
  let failures = 0;
  try {
    failures = recentInfraFailures(new Date(now - 60_000).toISOString()).length;
  } catch {
    failures = 0;
  }
  const max = pools?.workload.max ?? 0;
  const db = failures > 0 || peakControlWaiting > 0 || (max > 0 && peakWaiting >= max);
  const dbContended = peakWaiting > 0;
  peakWaiting = 0;
  peakControlWaiting = 0;
  return { db, dbContended, lagMs: Number.isFinite(lagMs) ? lagMs : 0, cpu };
}

/*
 * The GPU slot is sized by what the GPU itself did. Its items always succeed or
 * fail on the fallback's answer too, so the item window would read an
 * overloaded GPU as healthy and keep growing it onto the free model.
 */
function gpuWindow(items: Window): Window {
  const calls = runpodCallWindow(WINDOW_MS);
  if (calls.ok + calls.failed === 0) return items;
  return { ok: calls.ok, content: items.content, transient: calls.failed };
}

/** A runaway guard for the GPU's slots, above what one vLLM pod serves at once; not the operating limit. */
export function gpuCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['BRAIN_RUNPOD_MAX_SLOTS']);
  return Number.isFinite(n) && n >= 1 ? Math.min(SAFETY_CEILING, Math.floor(n)) : 32;
}

async function windowFor(model: string, now = Date.now()): Promise<Window> {
  const rows = await getDb().all<{ outcome: string; n: number | string }>(
    `SELECT outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND (reason = ? OR reason LIKE ?)
      GROUP BY outcome`,
    [new Date(now - WINDOW_MS).toISOString(), `model ${model}`, `model ${model}:%`],
  );
  const get = (outcome: string): number => Number(rows.find((r) => r.outcome === outcome)?.n ?? 0);
  return { ok: get('SUBMITTED'), content: get('FAILED_RETRYABLE'), transient: get('RELEASED_TRANSIENT') };
}

/** Free-lane jobs queued and claimable now. */
export async function waitingNow(options: { includeImprovement?: boolean } = {}): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts
        AND w.work_type IN ('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND b.purpose IN ('PLAY_RESEARCH', 'GRUNT'))`,
    [new Date().toISOString()],
  );
  const commercial = Number(row?.n ?? 0);
  if (options.includeImprovement === false) return commercial;
  // §87: Brain research the free lane may take while its activation is ACTIVE, up to the lease cap.
  const { improvementResearchActive, improvementResearchWaiting } = await import('../improvement/activation.ts');
  if (!(await improvementResearchActive())) return commercial;
  const { IMPROVEMENT_RESEARCH_SLOT_CAP } = await import('../../domain/improvement.ts');
  const ours = { n: await improvementResearchWaiting() };
  return commercial + Math.min(IMPROVEMENT_RESEARCH_SLOT_CAP, Number(ours?.n ?? 0));
}

/* ------------------------------------------------------------------------- */
/* Persistence                                                                */
/* ------------------------------------------------------------------------- */

export interface CapacityRow {
  model: string;
  target: number;
  stableHigh: number;
  updatedAt: string;
  reason: string;
}

export async function readCapacity(): Promise<CapacityRow[]> {
  const rows = await getDb().all<{ model: string; target: number; stable_high: number; updated_at: string; reason: string }>(
    'SELECT model, target, stable_high, updated_at, reason FROM free_lane_capacity ORDER BY model',
    [],
  );
  return rows.map((r) => ({ model: r.model, target: Number(r.target), stableHigh: Number(r.stable_high), updatedAt: r.updated_at, reason: r.reason }));
}

async function writeCapacity(model: string, target: number, stableHigh: number, reason: string): Promise<void> {
  await getDb().run(
    `INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (model) DO UPDATE SET target = excluded.target, stable_high = excluded.stable_high,
       updated_at = excluded.updated_at, reason = excluded.reason`,
    [model, target, stableHigh, new Date().toISOString(), reason.slice(0, 400)],
  );
}

/* ------------------------------------------------------------------------- */
/* The pool                                                                   */
/* ------------------------------------------------------------------------- */

interface ModelPool {
  worker: FreeWorker;
  index: number;
  target: number;
  stableHigh: number;
  running: number;
  busy: number;
  /** The most slots busy at once since the last control step: simultaneous jobs, measured. */
  peakBusy: number;
}

const pools = new Map<string, ModelPool>();
let workersCache: FreeWorker[] = [];
let controlTimer: NodeJS.Timeout | null = null;
let stopped = true;

export interface PoolOptions {
  completer?: Completer;
  fetchSource?: (url: string) => Promise<SourceFetch>;
  search?: (query: string) => Promise<string[]>;
  config?: LaneConfig;
  /** Test seam: the pressure reading, instead of this process's own. */
  pressure?: () => Pressure;
  /** Test seam: the recorded stage-capacity reading the growth gate consults, instead of the latest row. */
  stageReading?: () => Promise<RecordedStageCapacity | null>;
}
let poolOptions: PoolOptions = {};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** One slot: take jobs until the pool's target no longer includes it. */
async function slot(pool: ModelPool, k: number, config: LaneConfig): Promise<void> {
  pool.running += 1;
  try {
    while (!stopped && k < pool.target) {
      const base = {
        workers: workersCache,
        worker: pool.worker,
        index: pool.index,
        completer: poolOptions.completer ?? httpCompleter,
        fetchSource: poolOptions.fetchSource ?? ((url: string) => readSource(url, { caller: 'free-lane' })),
        search: poolOptions.search ?? discoverCandidates,
        config,
      };
      samplePools();
      pool.busy += 1;
      pool.peakBusy = Math.max(pool.peakBusy, pool.busy);
      let result: Awaited<ReturnType<typeof takeOne>> = { claimed: null, ok: false, ms: 0 };
      try {
        result = await takeOne(base);
        // Nothing for this model's own roles: take the other model's, so idle capacity is used.
        if (!result.claimed) result = await takeOne({ ...base, spillover: true });
      } catch (error) {
        console.warn('[free-lane] slot failed:', (error as Error).message);
      } finally {
        pool.busy -= 1;
      }
      if (!result.claimed) await sleep(IDLE_SLEEP_MS);
    }
  } finally {
    pool.running -= 1;
  }
}

function fill(pool: ModelPool, config: LaneConfig): void {
  for (let k = pool.running; k < pool.target; k += 1) void slot(pool, k, config);
}

export interface ControlReading {
  waiting: number;
  pressure: Pressure;
  models: Array<{ model: string; target: number; running: number; busy: number; stableHigh: number; window: Window; reason: string }>;
}

/** Slots per connection the lane may hold across all its models. */
export const SLOTS_PER_DB_CONNECTION = 3;

/** One model's share of the slots the database pool can carry, or null when the pool is not measured. Pure in its inputs. */
export function slotShare(models: number, poolMax: number | null = databasePoolReadings()?.workload.max ?? null): number | null {
  if (!poolMax || poolMax <= 0 || models <= 0) return null;
  return Math.max(MIN_TARGET, Math.floor((poolMax * SLOTS_PER_DB_CONNECTION) / models));
}

let lastReading: ControlReading | null = null;
const IDLE_RECORD_MS = 10 * 60_000;
const BOOT_GRACE_MS = 10 * 60_000;
let poolStartedAt = 0;
let lastIdleRecord = 0;
export function lastControlReading(): ControlReading | null {
  return lastReading;
}

/** One control step: measure, decide each model's target, persist, and resize the pool. */
export async function controlStep(): Promise<ControlReading | null> {
  const config = poolOptions.config ?? laneConfig();
  if (!config) return null;
  if (workersCache.length === 0) workersCache = await ensureFreeWorkers(config);
  const persisted = new Map((await readCapacity()).map((r) => [r.model, r]));
  for (const [index, worker] of workersCache.entries()) {
    if (!pools.has(worker.model)) {
      const saved = persisted.get(worker.model);
      // After a restart, resume at half of what was learned: fast to regain, gentle on a cold machine.
      const target = saved ? Math.max(START_TARGET, Math.floor(saved.target / 2)) : START_TARGET;
      pools.set(worker.model, { worker, index, target, stableHigh: saved?.stableHigh ?? 1, running: 0, busy: 0, peakBusy: 0 });
    }
  }
  const waiting = await waitingNow();
  const pressure = poolOptions.pressure ? poolOptions.pressure() : readPressure();
  const reading: ControlReading = { waiting, pressure, models: [] };
  // One read of the recorded measurement per step, shared by every model's growth gate.
  const { gateGrowth, readStageCapacity } = await import('./stageCapacity.ts');
  const stages = await (poolOptions.stageReading ?? (() => readStageCapacity()))().catch(() => null);
  for (const pool of pools.values()) {
    const gpu = config.runpod && isRunpodSlot(pool.worker.model);
    const window = gpu ? gpuWindow(await windowFor(pool.worker.model)) : await windowFor(pool.worker.model);
    const peak = Math.max(pool.peakBusy, pool.busy);
    let decision = decideTarget({ target: pool.target, active: peak, waiting, window, pressure, ...(gpu ? { ceiling: gpuCeiling() } : {}) });
    // Just after a restart the database is busiest (boot passes, a deploy's verification):
    // the lane stays at its starting size until it has been up BOOT_GRACE_MS.
    if (Date.now() - poolStartedAt < BOOT_GRACE_MS && decision.target > START_TARGET) {
      decision = { ...decision, target: START_TARGET, reason: 'starting up: held at its starting size for the first minutes', stable: false };
    }
    /*
     * Restore first, then scale only the measured constraint (S-0171). Growth
     * past what this model has already proven runs is allowed only when the
     * latest recorded stage-capacity reading names no failing route, a
     * constrained stage these slots serve, and a measured gain above zero
     * (`gateGrowth`). Regaining proven capacity is restoring, never held.
     */
    if (decision.target > pool.target) {
      const verdict = gateGrowth({ model: pool.worker.model, gpu: !!gpu, current: pool.target, proposed: decision.target, stableHigh: pool.stableHigh, recorded: stages });
      if (verdict.held) decision = { ...decision, target: verdict.target, reason: verdict.reason!, stable: false };
      else if (verdict.reason) decision = { ...decision, reason: `${decision.reason}; ${verdict.reason}` };
    }
    // Every slot reaches the same database pool. Production, 2026-11-05 11:29Z: three
    // models' slots left 593 callers waiting on 8 connections, and audits threw. The
    // lane's slots together stay within a multiple of the pool's own ceiling.
    const share = slotShare(pools.size);
    if (share !== null && decision.target > share) {
      // The cap bounds the step; it does not erase why the step was taken (the gate's
      // measured constraint stays on the record beside it).
      decision = { ...decision, target: share, reason: `${decision.reason}; held to its share of the database pool (${share} of ${share * pools.size} slots)`, stable: false };
    }
    if (decision.stable) pool.stableHigh = Math.max(pool.stableHigh, peak);
    pool.peakBusy = pool.busy;
    if (decision.target !== pool.target) {
      await recordBinEvent({
        eventType: 'FREE_LANE_CAPACITY',
        workloadClass: pool.worker.model,
        outcome: decision.target > pool.target ? 'GROW' : 'SHRINK',
        reason: `${pool.target} -> ${decision.target}: ${decision.reason}`,
        measures: { waiting, busy: pool.busy, peakBusy: peak, ...window, lagMs: Math.round(pressure.lagMs), cpu: Number(pressure.cpu.toFixed(2)), db: pressure.db, dbContended: pressure.dbContended ?? false },
        evidenceClass: 'MEASURED',
      });
    }
    pool.target = decision.target;
    await writeCapacity(pool.worker.model, pool.target, pool.stableHigh, decision.reason);
    fill(pool, config);
    reading.models.push({
      model: pool.worker.model,
      target: pool.target,
      running: pool.running,
      busy: peak,
      stableHigh: pool.stableHigh,
      window,
      reason: decision.reason,
    });
  }
  // The pod's power follows the same reading: stopped when nothing is left, started when work arrives.
  if (config.runpod) {
    const inFlight = [...pools.values()].reduce((sum, p) => sum + p.busy, 0);
    // An item every model is waiting out keeps nothing busy: the pod is not kept on for it.
    const takeable = Math.max(0, waiting - coolingForEveryModel([...pools.values()].map((p) => p.worker.model)));
    void superviseRunpodPod({ waiting: takeable, inFlight }).catch(() => undefined);
  }
  // Work waits and no slot holds any: say why the lane declined what it was offered (rule 9).
  const anyBusy = [...pools.values()].some((p) => p.busy > 0 || p.peakBusy > 0);
  if (waiting > 0 && !anyBusy && Date.now() - lastIdleRecord >= IDLE_RECORD_MS) {
    lastIdleRecord = Date.now();
    await recordBinEvent({
      eventType: 'FREE_LANE_IDLE',
      outcome: 'IDLE_WITH_WORK',
      reason: `${waiting} item(s) waiting and no slot busy`,
      measures: { waiting, declined: freeLaneSkips() },
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
  }
  try {
    await closeFiledFreeLaneBins();
  } catch (error) {
    console.warn('[free-lane] closing filed bins failed:', (error as Error).message);
  }
  lastReading = reading;
  return reading;
}

/** Whether this process's pool is running (the activation's recovery restarts one that is not). */
export function adaptivePoolRunning(): boolean {
  return controlTimer !== null;
}

/** Start the adaptive pool. Off when no free model is configured. */
export function startAdaptivePool(options: PoolOptions = {}, intervalMs = CONTROL_MS): void {
  if (controlTimer) return;
  poolOptions = options;
  stopped = false;
  poolStartedAt = options.pressure ? 0 : Date.now();
  // A search endpoint that refuses is a row, not a silence (§88, DISCOVERY.SEARCH).
  setSearchRefusalRecorder((endpoint, status) => {
    void recordBinEvent({
      eventType: 'SOURCE_SEARCH',
      provider: endpoint,
      outcome: 'REFUSED',
      reason: `search endpoint ${endpoint} answered ${status}; paused ten minutes`,
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
  });
  const tick = (): void => {
    void controlStep().catch((error) => console.warn('[free-lane] control step failed:', (error as Error).message));
  };
  tick();
  controlTimer = setInterval(tick, intervalMs);
  controlTimer.unref?.();
}

export function stopAdaptivePool(): void {
  stopped = true;
  if (controlTimer) clearInterval(controlTimer);
  controlTimer = null;
  pools.clear();
  workersCache = [];
}

/**
 * Spare free-lane capacity, in research "surfaces", for §78's generation sizing.
 *
 * §78 grows a goal's search with the idle fleet, and counted the fleet as
 * Claude routine surfaces. Under §84 those cannot take play research, so for a
 * non-Brain project the spare is the free lane's: slots its controller has
 * granted that are neither busy nor already spoken for by waiting work, in
 * units of `SLOTS_PER_SURFACE` (a round queues several jobs). Zero while answers
 * are mostly failing, so generation never outruns useful work, and capped per
 * reading so a burst of room is opened in steps the controller can follow.
 */
export const SLOTS_PER_SURFACE = 4;
const MAX_SPARE_SURFACES = 8;

export async function freeLaneSpareSurfaces(now = Date.now()): Promise<number> {
  const config = laneConfig();
  if (!config) return 0;
  const db = getDb();
  const recorded = await readCapacity();
  // The lane's models now; a row for a model no longer configured is history.
  const current = recorded.filter((r) => config.models.includes(r.model));
  const rows = current.length > 0 ? current : recorded;
  /*
   * The room is what each model has proven it runs (`stable_high`), not its
   * current target. The controller lowers a target when nothing is waiting, so
   * reading the target made idleness self-sustaining: production, 2026-11-07,
   * targets 2 and 2 against stable highs 19 and 26 left one surface of room,
   * the $10K goal could open no new round over seven still open, and the GPU
   * reported "no research waiting" while the plan lacked evidence on 17 of 19
   * openings. Room opened here is work queued, which raises the target again.
   */
  const granted = rows.reduce((sum, r) => sum + Math.max(r.target, r.stableHigh), 0) || START_TARGET * 2;
  const busy = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items WHERE state = 'LEASED' AND lease_expires_at > ?
       AND worker_id IN (SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))`,
    [new Date(now).toISOString()],
  );
  const recent = await db.all<{ outcome: string; n: number | string }>(
    "SELECT outcome, COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY outcome",
    [new Date(now - 30 * 60_000).toISOString()],
  );
  const ok = Number(recent.find((r) => r.outcome === 'SUBMITTED')?.n ?? 0);
  const all = recent.reduce((sum, r) => sum + Number(r.n), 0);
  if (all >= 10 && ok / all < 0.3) return 0;
  const free = granted - Number(busy?.n ?? 0) - (await waitingNow());
  return Math.max(0, Math.min(MAX_SPARE_SURFACES, Math.floor(free / SLOTS_PER_SURFACE)));
}
