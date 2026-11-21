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
import { availableParallelism } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { databasePoolReadings } from '../../db/database.ts';
import { recentInfraFailures } from '../../db/infra.ts';
import { httpCompleter, laneConfig, routeLabel, type Completer, type LaneConfig } from '../cheap/lane.ts';
import { isRunpodSlot, runpodCallWindow, RUNPOD_PREFIX } from '../cheap/runpod.ts';
import { superviseRunpodPod } from '../cheap/runpodPod.ts';
import { RECIPES, recipeFor, type PodRecipe } from '../cheap/runpodRestore.ts';
import type { SourceFetch } from '../sources/fetchForWorker.ts';
import type { RecordedStageCapacity } from './stageCapacity.ts';
import { readSource } from '../sources/access.ts';
import { setSearchEventRecorder } from '../sources/discover.ts';
import { firecrawlSearch, FIRECRAWL_PROVIDER_ID, KEYED_SEARCH_PROVIDERS, seedKeyedSearchUsage } from '../sources/keyedSearch.ts';
import { FIRECRAWL_SCRAPE_COST, FIRECRAWL_SCRAPE_EVENT } from '../sources/firecrawl.ts';
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
  /** The busier of the server's own loop and the whole machine, 0–1 (`brainCpu`). */
  cpu: number;
  /** What `cpu` was taken from, for the record. */
  loop?: number;
  processCpu?: number;
  /** The process's CPU as a share of the whole machine (all cores), 0–1. */
  machine?: number;
}

/**
 * Which half of `brainCpu` a CPU shrink was read from, in the reason itself.
 * Production 2026-11-17 18:28Z (56bc7f12): the lane halved the GPU slots on
 * "Brain CPU at 85%" while the machine read 72% idle, and the record could not
 * say that the 85% was the server's event loop (one thread, busy 85% of the
 * step, stalling 2–4 s a minute) and not the cores. More vCPUs do not shorten
 * one thread's work; the reason has to say which it was.
 */
export function cpuReason(pressure: Pressure): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const head = `Brain CPU at ${pct(pressure.cpu)}`;
  if (pressure.loop === undefined || pressure.machine === undefined) return head;
  return pressure.loop >= pressure.machine
    ? `${head}: the server's event loop busy ${pct(pressure.loop)} of the step (machine ${pct(pressure.machine)} of its cores)`
    : `${head}: the process using ${pct(pressure.machine)} of the machine's cores (event loop ${pct(pressure.loop)})`;
}

export interface Decision {
  target: number;
  reason: string;
  stable: boolean;
}

/**
 * Whether a model's live window shows its route answering: work accepted and at
 * most one in five calls failing on the provider. Pure. The growth gate reads
 * it so a route restored since the hourly stage-capacity reading is not held
 * by that reading's failure count.
 */
export function answering(window: Window): boolean {
  const samples = window.ok + window.content + window.transient;
  return window.ok > 0 && window.transient * 5 <= samples;
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
  if (pressure.cpu > 0.85) return { target: half, reason: cpuReason(pressure), stable: false };
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
/* The research allocation's capacity verdict (RES-15-5, S-0153)               */
/* ------------------------------------------------------------------------- */

/**
 * The goals tick decides, once an hour, whether queued qualified research is
 * delayed by a measured machine limit, and records an `ADD_CAPACITY` verdict
 * for the lane when it is (`goals/researchAllocation.ts` `decideCapacity`,
 * recorded as `RESEARCH_ALLOCATION_DECIDED`). A free-lane lane is
 * `free-lane:<model>`, and its units never exceed the headroom the controller
 * itself measured (`stable_high − target`): concurrency the same provider has
 * already sustained without overload. This controller is the one owner of a
 * model's target, so it is the one place the verdict is applied — nowhere else
 * adds slots, and no second scheduler exists to do it.
 *
 * A grant raises a target the controller would grow or hold; it never
 * overrides a shrink (pressure, provider overload) or the decay when nothing
 * waits, so the controller's own measurements still bind. The safety ceiling,
 * the boot grace and the database-pool share are applied after it, unchanged.
 * Each decision is applied at most once per model (its fingerprint), and a
 * decision older than `GRANT_MAX_AGE_MS` is not applied: by then the hourly
 * tick has measured again.
 */
export const FREE_LANE_PREFIX = 'free-lane:';
export const GRANT_MAX_AGE_MS = 2 * 60 * 60_000;

export interface CapacityGrant {
  model: string;
  units: number;
  fingerprint: string;
  reason: string;
  decidedAt: string;
}

/** The free-lane ADD_CAPACITY verdicts in a recorded allocation decision. Pure. */
export function grantsFromDecision(decision: { detail: Record<string, unknown>; at: string } | null, nowMs = Date.now()): CapacityGrant[] {
  if (!decision) return [];
  const at = Date.parse(decision.at);
  if (!Number.isFinite(at) || nowMs - at > GRANT_MAX_AGE_MS || at > nowMs + 60_000) return [];
  const fingerprint = typeof decision.detail['fingerprint'] === 'string' ? (decision.detail['fingerprint'] as string) : null;
  if (!fingerprint) return [];
  const capacity = Array.isArray(decision.detail['capacity']) ? (decision.detail['capacity'] as unknown[]) : [];
  const out: CapacityGrant[] = [];
  for (const one of capacity) {
    const c = one as { lane?: unknown; kind?: unknown; units?: unknown; reason?: unknown };
    if (c.kind !== 'ADD_CAPACITY' || typeof c.lane !== 'string' || !c.lane.startsWith(FREE_LANE_PREFIX)) continue;
    const units = Number(c.units);
    if (!Number.isFinite(units) || units < 1) continue;
    out.push({ model: c.lane.slice(FREE_LANE_PREFIX.length), units: Math.floor(units), fingerprint, reason: typeof c.reason === 'string' ? c.reason : '', decidedAt: decision.at });
  }
  return out;
}

/**
 * One model's target with a grant applied. Pure. Applied only to a decision
 * that does not lower the target, raised to at most `target + units`, and
 * never above the measured sustainable concurrency, the ceiling, or — when the
 * grant is already met — changed at all.
 */
export function applyGrant(input: { target: number; stableHigh: number; decision: Decision; grant: CapacityGrant | null; ceiling?: number }): { decision: Decision; applied: boolean } {
  const { target, decision, grant } = input;
  if (!grant || decision.target < target) return { decision, applied: false };
  const ceiling = input.ceiling ?? SAFETY_CEILING;
  const bound = Math.min(ceiling, Math.max(target, input.stableHigh), target + grant.units);
  if (bound <= decision.target) return { decision, applied: false };
  return {
    decision: { target: bound, reason: `research allocation added ${bound - target} slot(s) for queued qualified research held by a measured limit (allocation ${grant.fingerprint}): ${grant.reason}`.slice(0, 400), stable: decision.stable },
    applied: true,
  };
}

/* ------------------------------------------------------------------------- */
/* Measurements                                                               */
/* ------------------------------------------------------------------------- */

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
let lastLoop = performance.eventLoopUtilization();
const CORES = (() => {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return 1;
  }
})();

/**
 * Brain's CPU as the lane's guard reads it: the busier of the server's own loop
 * (the share of the step it spent running, `eventLoopUtilization`) and the whole
 * process's CPU across the machine's cores. Pure.
 *
 * `process.cpuUsage()` sums every thread. Production, 2026-11-16 21:07Z: the
 * lane was halved on "Brain CPU at 87%" — one core's worth on a 2-vCPU machine,
 * which is what the goal-plan evaluator thread spends by design on the spare
 * core (`goals/reasoning/evaluatorPool.ts`: 238 evaluations and a 75,103-variation
 * sweep in 89 s per plan run, off the server's loop). Read as a fraction of one
 * core, that thread alone held the lane at half while the loop the lane's slots
 * share was not the constraint. A saturated loop and a saturated machine both
 * still shrink the lane; the loop's stalls are read separately as lag.
 */
export function brainCpu(input: { loop: number; processCoreSeconds: number; seconds: number; cores: number }): number {
  const machine = input.processCoreSeconds / Math.max(0.001, input.seconds) / Math.max(1, input.cores);
  return Math.max(Number.isFinite(input.loop) ? input.loop : 0, machine);
}

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
  const seconds = Math.max(1, now - lastCpuAt) / 1000;
  const processCoreSeconds = (used.user + used.system) / 1e6;
  const loopNow = performance.eventLoopUtilization();
  const loop = performance.eventLoopUtilization(loopNow, lastLoop).utilization;
  const cpu = brainCpu({ loop, processCoreSeconds, seconds, cores: CORES });
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  lastLoop = loopNow;
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
  return { db, dbContended, lagMs: Number.isFinite(lagMs) ? lagMs : 0, cpu, loop: Number.isFinite(loop) ? loop : 0, processCpu: processCoreSeconds / seconds, machine: processCoreSeconds / seconds / CORES };
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
export function gpuCeiling(env: NodeJS.ProcessEnv = process.env, served: number | null = null): number {
  const n = Number(env['BRAIN_RUNPOD_MAX_SLOTS']);
  // A data-parallel pod serves more than 32 at once; the guard stays above what it serves.
  return Number.isFinite(n) && n >= 1 ? Math.min(SAFETY_CEILING, Math.floor(n)) : Math.min(SAFETY_CEILING, Math.max(32, served ?? 0));
}

/**
 * The sequences the GPU slot's pod serves at once (vLLM `--max-num-seqs` in the
 * recipe that serves this model), or null when it is not a GPU slot or no
 * recipe serves it. Pure in its inputs.
 *
 * It is the growth gate's floor for "proven" on the GPU. The pod is billed by
 * the hour whatever it holds, and vLLM batches up to this many sequences in one
 * forward pass by design, so filling them is using capacity already deployed,
 * not growing past what was measured. A fresh pod — a new model starts its
 * `free_lane_capacity` row at a highest-stable of 1 — was otherwise held at two
 * slots by any stage reading that named a non-lane constraint, while it served
 * eight (production 2026-11-16 08:24Z: `runpod/Qwen/Qwen3-4B-AWQ` held at 2,
 * "the constrained stage is commercial-execution", 17 items waiting, 0 busy).
 * Every other control still binds: pressure and provider overload halve, nothing
 * waiting decays, the GPU ceiling and the database-pool share cap the step.
 */
export function servedSequences(model: string, recipes: Record<string, PodRecipe> = RECIPES, active: PodRecipe | null = activeRecipe()): number | null {
  if (!isRunpodSlot(model)) return null;
  const served = model.slice(RUNPOD_PREFIX.length);
  const recipe = active && active.served === served ? active : Object.values(recipes).find((r) => r.served === served);
  if (!recipe) return null;
  const at = recipe.args.indexOf('--max-num-seqs');
  const n = at >= 0 ? Number(recipe.args[at + 1]) : NaN;
  // `--max-num-seqs` is per replica: a data-parallel pod serves that many on each card.
  const dp = recipe.args.indexOf('--data-parallel-size');
  const replicas = dp >= 0 && Number(recipe.args[dp + 1]) >= 1 ? Math.floor(Number(recipe.args[dp + 1])) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) * replicas : null;
}

function activeRecipe(): PodRecipe | null {
  try {
    return recipeFor(null);
  } catch {
    return null;
  }
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
  /** Test seam: the research allocation's grants, instead of the newest recorded decision. */
  grants?: () => Promise<CapacityGrant[]>;
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
  /**
   * `route` is the slot as the model that answers it now: the slot alone, or
   * `slot → fallback (why)` while a GPU slot is answered by its fallback (`routeLabel`).
   */
  models: Array<{ model: string; route: string; target: number; running: number; busy: number; stableHigh: number; window: Window; reason: string }>;
}

/** Slots per connection the lane may hold across all its models. */
export const SLOTS_PER_DB_CONNECTION = 3;

/** One model's share of the slots the database pool can carry, or null when the pool is not measured. Pure in its inputs. */
export function slotShare(models: number, poolMax: number | null = databasePoolReadings()?.workload.max ?? null): number | null {
  if (!poolMax || poolMax <= 0 || models <= 0) return null;
  return Math.max(MIN_TARGET, Math.floor((poolMax * SLOTS_PER_DB_CONNECTION) / models));
}

/** Allocation fingerprints already applied, per model; backed by the FREE_LANE_CAPACITY rows across a restart. */
const appliedGrants = new Map<string, string>();

async function grantAlreadyApplied(model: string, fingerprint: string): Promise<boolean> {
  if (appliedGrants.get(model) === fingerprint) return true;
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class = ? AND reason LIKE ?`,
    [model, `%(allocation ${fingerprint})%`],
  );
  const seen = Number(row?.n ?? 0) > 0;
  if (seen) appliedGrants.set(model, fingerprint);
  return seen;
}

/** The newest allocation decision's free-lane grants; an unreadable decision grants nothing. */
async function pendingGrants(): Promise<CapacityGrant[]> {
  try {
    const { latestResearchDecision } = await import('../goals/tick.ts');
    return grantsFromDecision(await latestResearchDecision());
  } catch {
    return [];
  }
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
  const grants = poolOptions.grants ? await poolOptions.grants() : await pendingGrants();
  for (const pool of pools.values()) {
    const gpu = config.runpod && isRunpodSlot(pool.worker.model);
    const window = gpu ? gpuWindow(await windowFor(pool.worker.model)) : await windowFor(pool.worker.model);
    const peak = Math.max(pool.peakBusy, pool.busy);
    let decision = decideTarget({ target: pool.target, active: peak, waiting, window, pressure, ...(gpu ? { ceiling: gpuCeiling(process.env, servedSequences(pool.worker.model)) } : {}) });
    const offered = grants.find((g) => g.model === pool.worker.model) ?? null;
    const grant = offered && !(await grantAlreadyApplied(pool.worker.model, offered.fingerprint)) ? offered : null;
    const granted = applyGrant({ target: pool.target, stableHigh: pool.stableHigh, decision, grant, ...(gpu ? { ceiling: gpuCeiling(process.env, servedSequences(pool.worker.model)) } : {}) });
    decision = granted.decision;
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
      // A GPU's served sequences count as proven: the pod already runs them in one batch (`servedSequences`).
      const proven = gpu ? Math.max(pool.stableHigh, servedSequences(pool.worker.model) ?? 0) : pool.stableHigh;
      const verdict = gateGrowth({ model: pool.worker.model, gpu: !!gpu, current: pool.target, proposed: decision.target, stableHigh: proven, recorded: stages, answering: answering(window) });
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
    // An applied verdict is consumed once, whatever the caps below left of it; one the
    // controller's own measurements refused (a shrink, nothing waiting) is offered again next step.
    if (grant && granted.applied) appliedGrants.set(pool.worker.model, grant.fingerprint);
    if (granted.applied && decision.target === pool.target) {
      await recordBinEvent({
        eventType: 'FREE_LANE_CAPACITY',
        workloadClass: pool.worker.model,
        outcome: 'HOLD',
        reason: `${pool.target} -> ${pool.target}: grant held by the controller's caps (allocation ${grant!.fingerprint}): ${decision.reason}`.slice(0, 400),
        measures: { waiting, busy: pool.busy, peakBusy: peak, granted: grant!.units },
        evidenceClass: 'MEASURED',
      });
    }
    if (decision.target !== pool.target) {
      await recordBinEvent({
        eventType: 'FREE_LANE_CAPACITY',
        workloadClass: pool.worker.model,
        outcome: decision.target > pool.target ? 'GROW' : 'SHRINK',
        reason: `${pool.target} -> ${decision.target}: ${decision.reason}`.slice(0, 340) + (granted.applied && !decision.reason.includes(`(allocation ${grant!.fingerprint})`) ? ` (allocation ${grant!.fingerprint})` : ''),
        measures: { waiting, busy: pool.busy, peakBusy: peak, ...(granted.applied ? { granted: grant!.units } : {}), ...window, lagMs: Math.round(pressure.lagMs), cpu: Number(pressure.cpu.toFixed(2)), ...(pressure.loop !== undefined ? { loop: Number(pressure.loop.toFixed(2)), processCpu: Number((pressure.processCpu ?? 0).toFixed(2)), ...(pressure.machine !== undefined ? { machine: Number(pressure.machine.toFixed(2)) } : {}) } : {}), db: pressure.db, dbContended: pressure.dbContended ?? false },
        evidenceClass: 'MEASURED',
      });
    }
    pool.target = decision.target;
    await writeCapacity(pool.worker.model, pool.target, pool.stableHigh, decision.reason);
    fill(pool, config);
    reading.models.push({
      model: pool.worker.model,
      route: routeLabel(config, pool.worker.model),
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

/**
 * The keyed search queries already sent today, read back from the recorded
 * search events, so a restart does not hand the daily ceiling out a second time
 * (invariant 18). Every recorded outcome but CEILING was a sent query.
 */
async function seedKeyedSearchCeilings(): Promise<void> {
  const now = Date.now();
  const since = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
  for (const provider of KEYED_SEARCH_PROVIDERS) {
    const row = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM bin_events
        WHERE event_type = 'SOURCE_SEARCH' AND at >= ? AND provider = ? AND outcome <> 'CEILING'`,
      [since, provider.id],
    );
    seedKeyedSearchUsage(provider.id, Number(row?.n ?? 0) * provider.cost, now);
  }
  // Firecrawl's scrape route spends from the same daily credit count as its search.
  const scrapes = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events
      WHERE event_type = '${FIRECRAWL_SCRAPE_EVENT}' AND at >= ? AND outcome <> 'CEILING'`,
    [since],
  );
  const searches = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events
      WHERE event_type = 'SOURCE_SEARCH' AND at >= ? AND provider = ? AND outcome <> 'CEILING'`,
    [since, FIRECRAWL_PROVIDER_ID],
  );
  seedKeyedSearchUsage(FIRECRAWL_PROVIDER_ID, Number(searches?.n ?? 0) * firecrawlSearch.cost + Number(scrapes?.n ?? 0) * FIRECRAWL_SCRAPE_COST, now);
}

/** Start the adaptive pool. Off when no free model is configured. */
export function startAdaptivePool(options: PoolOptions = {}, intervalMs = CONTROL_MS): void {
  if (controlTimer) return;
  poolOptions = options;
  stopped = false;
  poolStartedAt = options.pressure ? 0 : Date.now();
  // Every sent search is a row naming the provider that answered or refused it
  // (§88, DISCOVERY.SEARCH): a refusal is not a silence, and production can
  // measure the keyed provider against DuckDuckGo.
  setSearchEventRecorder((event) => {
    void recordBinEvent({
      eventType: 'SOURCE_SEARCH',
      provider: event.provider,
      outcome: event.outcome,
      reason: event.detail,
      measures: { status: event.status, results: event.results },
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
  });
  void seedKeyedSearchCeilings().catch(() => undefined);
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
  appliedGrants.clear();
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

/**
 * One model's proven room in slots. Pure.
 *
 * What it has proven it runs (`stable_high`) or holds now (`target`), and for a
 * GPU slot also the sequences its pod batches at once (`servedSequences`) —
 * the same "proven" `controlStep`'s growth gate already reads. Without it a
 * GPU's room was its own decayed target: production, 2026-11-17 08:28Z, an
 * H200 serving gpt-oss-120b (up to 128 sequences) read as 3 slots with 3 busy,
 * no spare, so the discovery grant could not grow and 568 ideas waited beside
 * a GPU running two jobs. The served room is still bounded by the GPU's
 * runaway guard and the lane's share of the database pool, so it never claims
 * more than the controller could actually grant.
 */
export function provenSlots(input: { target: number; stableHigh: number; served: number | null; share: number | null; ceiling?: number }): number {
  const served = input.served === null ? 0 : Math.min(input.served, input.ceiling ?? SAFETY_CEILING, input.share ?? Number.POSITIVE_INFINITY);
  return Math.max(input.target, input.stableHigh, served);
}

/**
 * The lane's database-pool ceiling as `slotShare` reads it. A test seam: the
 * pool the lane shares is measured on Postgres and absent on SQLite, so a
 * reading that depends on it states which pool it was taken against.
 */
export interface PoolSeam {
  /** The workload pool's ceiling; null for an unmeasured pool. Omitted, this process's own. */
  poolMax?: number | null;
}

/** The lane's proven room in slots across its models now; 0 when there is no lane. */
export async function freeLaneProvenSlots(seam: PoolSeam = {}): Promise<number> {
  const config = laneConfig();
  if (!config) return 0;
  const recorded = await readCapacity();
  // The lane's models now; a row for a model no longer configured is history.
  const current = recorded.filter((r) => config.models.includes(r.model));
  const rows = current.length > 0 ? current : recorded;
  const share = 'poolMax' in seam ? slotShare(Math.max(1, rows.length), seam.poolMax ?? null) : slotShare(Math.max(1, rows.length));
  return (
    rows.reduce((sum, r) => {
      const served = config.runpod && isRunpodSlot(r.model) ? servedSequences(r.model) : null;
      return sum + provenSlots({ target: r.target, stableHigh: r.stableHigh, served, share, ceiling: gpuCeiling(process.env, served) });
    }, 0) || START_TARGET * 2
  );
}

export async function freeLaneSpareSurfaces(now = Date.now(), seam: PoolSeam = {}): Promise<number> {
  const config = laneConfig();
  if (!config) return 0;
  const db = getDb();
  /*
   * The room is what each model has proven it runs (`stable_high`), not its
   * current target. The controller lowers a target when nothing is waiting, so
   * reading the target made idleness self-sustaining: production, 2026-11-07,
   * targets 2 and 2 against stable highs 19 and 26 left one surface of room,
   * the $10K goal could open no new round over seven still open, and the GPU
   * reported "no research waiting" while the plan lacked evidence on 17 of 19
   * openings. Room opened here is work queued, which raises the target again.
   * A GPU's served sequences count as proven too (`provenSlots`).
   */
  const granted = await freeLaneProvenSlots(seam);
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
