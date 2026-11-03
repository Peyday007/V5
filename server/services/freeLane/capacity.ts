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
import { fetchForWorker, type SourceFetch } from '../sources/fetchForWorker.ts';
import {
  closeFiledFreeLaneBins,
  ensureFreeWorkers,
  takeOne,
  wikipediaCandidates,
  type FreeWorker,
} from './worker.ts';

export const SAFETY_CEILING = 256;
export const MIN_TARGET = 1;
const START_TARGET = 2;
const WINDOW_MS = 3 * 60_000;
const CONTROL_MS = 30_000;
const IDLE_SLEEP_MS = 20_000;

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
  if (pressure.lagMs > 300) return { target: half, reason: `Brain event loop lagging ${Math.round(pressure.lagMs)} ms`, stable: false };
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
export async function waitingNow(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts
        AND w.work_type IN ('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND b.purpose IN ('PLAY_RESEARCH', 'GRUNT'))`,
    [new Date().toISOString()],
  );
  return Number(row?.n ?? 0);
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
        fetchSource: poolOptions.fetchSource ?? ((url: string) => fetchForWorker(url)),
        search: poolOptions.search ?? wikipediaCandidates,
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

let lastReading: ControlReading | null = null;
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
  for (const pool of pools.values()) {
    const window = await windowFor(pool.worker.model);
    const peak = Math.max(pool.peakBusy, pool.busy);
    const decision = decideTarget({ target: pool.target, active: peak, waiting, window, pressure });
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
  try {
    await closeFiledFreeLaneBins();
  } catch (error) {
    console.warn('[free-lane] closing filed bins failed:', (error as Error).message);
  }
  lastReading = reading;
  return reading;
}

/** Start the adaptive pool. Off when no free model is configured. */
export function startAdaptivePool(options: PoolOptions = {}, intervalMs = CONTROL_MS): void {
  if (controlTimer) return;
  poolOptions = options;
  stopped = false;
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
  if (!laneConfig()) return 0;
  const db = getDb();
  const rows = await readCapacity();
  const granted = rows.reduce((sum, r) => sum + r.target, 0) || START_TARGET * 2;
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
