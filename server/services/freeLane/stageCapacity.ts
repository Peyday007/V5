/**
 * Research capacity measured per stage (CAP-16-3), read from the free lane's own
 * rows. Extends the free-lane owner: it reads `bin_events` (FREE_LANE_ITEM),
 * `work_items`, `bins`, `research_claims` and the readers `capacity.ts` already
 * has. It schedules nothing, stores nothing and decides nothing; it is read-only
 * and is meant for a report or a tick, never the web request path.
 *
 * A figure is either measured or it says it was not. Nothing here is invented:
 * a stage the lane's rows cannot see reports `NOT_MEASURED` with the reason, and
 * process-level CPU/RAM/DB readings are labelled as the process's, because the
 * lane does not run each stage in its own process.
 *
 * Stage names and purposes are data. A stage is a row of `STAGES` and a purpose
 * is whatever `bins.purpose` says; neither is a list of what Brain may do. The
 * five S-0170 categories are a reporting partition of productive jobs, read
 * from the rows that consume each job's research, and never a filter on work.
 */
import { getDb } from '../../db/database.ts';
import { databasePoolReadings } from '../../db/database.ts';
import { waitingNow } from './capacity.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { isRunpodSlot } from '../cheap/runpod.ts';
import { readPodSpend, type PodSpend } from '../cheap/runpodPod.ts';
import { causeOfReason, type RouteFailureCause } from './worker.ts';
import type { ItemUsage } from './itemMeter.ts';

export type Measured<T> = { measured: true; value: T } | { measured: false; reason: string };

export interface StageDefinition {
  id: string;
  label: string;
  /** Work types whose queue and outcomes belong to this stage, or none when the rows cannot see it. */
  workTypes: readonly string[];
  /**
   * For a stage the lane does not run: the tables its own rows are in, read by
   * `ROW_STAGES`. A stage with neither work types nor rows has no measure.
   */
  rows?: readonly string[];
  /** Why the stage has no row-level measure, when it has neither work types nor rows. */
  unseen?: string;
}

export const STAGES: readonly StageDefinition[] = [
  { id: 'source-ingestion', label: 'source fetching / ingestion', workTypes: [], rows: ['feed_pulls'] },
  { id: 'parsing-indexing', label: 'parsing and indexing', workTypes: [], rows: ['extraction_runs'] },
  { id: 'graph-quant', label: 'graph / detection / quant computation', workTypes: [], rows: ['feed_detections', 'feed_item_coverage', 'scenario_runs'] },
  { id: 'model-interpretation', label: 'model-based interpretation', workTypes: ['RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_SYNTHESIZE'] },
  { id: 'evidence-verification', label: 'evidence verification', workTypes: ['RESEARCH_VERIFY', 'RESEARCH_AUDIT'] },
  { id: 'commercial-execution', label: 'human / authorized commercial execution', workTypes: [], rows: ['cash_actions', 'cash_needs'] },
];

/**
 * What one stage's items used in the window, summed from the usage each lane item
 * recorded while it ran (`itemMeter.ts`). `cpuSeconds` is the process's CPU
 * apportioned equally among the lane items in flight, so it is an upper bound on
 * the stage's own (`cpuBound: 'UPPER'`); network is application payload bytes.
 * `itemsMetered` of `itemsInWindow` carried a reading — rows written before the
 * meter existed carry none and are not guessed.
 */
export interface StageResources {
  scope: 'stage';
  itemsMetered: number;
  itemsInWindow: number;
  modelCalls: number;
  cpuSeconds: number;
  cpuBound: 'UPPER';
  peakRssBytes: number;
  meanRssShareBytes: number;
  dbCalls: number;
  dbMs: number;
  networkBytesOut: number;
  networkBytesIn: number;
}

export interface StageReading {
  stage: string;
  label: string;
  queueSize: Measured<number>;
  /** Age in minutes of the oldest queued item that could be claimed now. */
  oldestUsefulItemMinutes: Measured<number | null>;
  itemsProcessedPerHour: Measured<number>;
  uniqueUsableFacts: Measured<number>;
  droppedOrDuplicate: Measured<number>;
  modelCallsAvoided: Measured<number>;
  providerFailures: Measured<number>;
  elapsedMs: Measured<number>;
  incrementalDollars: Measured<number>;
  /** The stage's own CPU / RAM / DB / network use, where its items recorded it. */
  resources: Measured<StageResources>;
  accepted: number;
  acceptedPerHour: number;
  /** The tables the reading came from. */
  measuredFrom?: readonly string[];
}

export interface PurposeAttribution {
  /** From `bins.purpose`; `UNATTRIBUTED` when the item's bin carries none. */
  purpose: string;
  productiveJobs: number;
}

/**
 * The five kinds of productive work S-0170 names. `bins.purpose` cannot tell
 * four of them apart (commercial discovery, deal completion, broader research
 * and future-goal preparation are all PLAY_RESEARCH or GRUNT there), so each is
 * read from the rows that tie a job's research to what consumes it.
 */
export const ATTRIBUTION_CATEGORIES = [
  'IMMEDIATE_COMMERCIAL_DISCOVERY',
  'DEAL_COMPLETION',
  'BROADER_WORLD_RESEARCH',
  'SELF_IMPROVEMENT',
  'FUTURE_GOAL_PREPARATION',
] as const;
export type AttributionCategory = (typeof ATTRIBUTION_CATEGORIES)[number];

/** The row facts one productive job carries; every flag is read, never inferred from text. */
export interface AttributionFacts {
  /** `bins.purpose` of the owning bin, or null. */
  binPurpose: string | null;
  /** The project is Brain's own (`brain-architecture`, or purpose TECHNICAL). */
  brainProject: boolean;
  /** The orchestration is the bounded validation of a recorded opening (`cash_opportunities.validation_orchestration_id`). */
  validatesOpening: boolean;
  /** The orchestration's mission answers a deal round about a named deal, its parties, costs, compliance or structure. */
  dealRound: boolean;
  /** The orchestration serves a goal whose `starts_at` was still ahead when the job ran. */
  futureGoal: boolean;
  /** The orchestration produced an opening, answers a cash discovery or seed/adjacent deal round, or runs in a cash-mode project. */
  commercialDiscovery: boolean;
}

/**
 * Exactly one category per job, so no job is counted twice. Precedence is
 * most-specific consumer first: Brain's own work, then work on a deal that
 * already exists, then preparation for a goal not yet started, then discovery
 * of new openings; research no commercial row consumes is broader-world.
 * Returns the rule that decided it, so the attribution is auditable.
 */
export function attributeJob(facts: AttributionFacts): { category: AttributionCategory; basis: string } {
  if (facts.binPurpose === 'BRAIN_IMPROVEMENT') return { category: 'SELF_IMPROVEMENT', basis: 'BIN_PURPOSE:BRAIN_IMPROVEMENT' };
  if (facts.brainProject) return { category: 'SELF_IMPROVEMENT', basis: 'PROJECT:BRAIN' };
  if (facts.validatesOpening) return { category: 'DEAL_COMPLETION', basis: 'OPENING_VALIDATION' };
  if (facts.dealRound) return { category: 'DEAL_COMPLETION', basis: 'DEAL_ROUND' };
  if (facts.futureGoal) return { category: 'FUTURE_GOAL_PREPARATION', basis: 'GOAL_NOT_STARTED' };
  if (facts.commercialDiscovery) return { category: 'IMMEDIATE_COMMERCIAL_DISCOVERY', basis: 'COMMERCIAL_DISCOVERY' };
  return { category: 'BROADER_WORLD_RESEARCH', basis: 'NO_COMMERCIAL_CONSUMER' };
}

export interface CategoryAttribution {
  category: AttributionCategory;
  productiveJobs: number;
  /** How many of those jobs each rule decided. */
  bases: Record<string, number>;
}

export interface ProcessReading {
  scope: 'process';
  cpuSecondsSinceStart: number;
  rssBytes: number;
  heapUsedBytes: number;
  dbPool: Measured<{ workloadWaiting: number }>;
  network: Measured<never>;
}

export interface Constraint {
  stage: string | null;
  basis: string;
  /**
   * Present only when a measurement supports it: what one more replica of the
   * constrained stage would add at its measured rate, in accepted facts per hour
   * (capped by what is waiting), and what it would cost in `dollars` per hour at
   * the stage's measured spend.
   */
  expectedGain: Measured<{ acceptedFactsPerHour: number; dollars: number }>;
  /** Scaling the web process is never what this recommends. */
  recommendation: string;
}

export interface StageCapacityReport {
  windowHours: number;
  since: string;
  stages: StageReading[];
  purposes: PurposeAttribution[];
  totalProductiveJobs: number;
  purposesSumToTotal: boolean;
  /** Productive jobs across S-0170's five categories, each job in exactly one. */
  attribution: CategoryAttribution[];
  attributionSumsToTotal: boolean;
  process: ProcessReading;
  /** The GPU pod's spend in the window, from the supervisor's `RUNPOD_POD` samples; the free providers cost $0. */
  gpuSpend: Measured<PodSpend>;
  /** Which model route is failing, the cause the rows name, and whether it has answered since. */
  diagnosis: ThroughputDiagnosis;
  constrained: Constraint;
}

/**
 * One model route's window, read from its `FREE_LANE_ITEM` rows (`reason`
 * begins `model <route>`). `restored` is a row fact: the route had an item
 * accepted after its last failure.
 */
export interface RouteDiagnosis {
  route: string;
  submitted: number;
  providerFailures: number;
  /** The cause most of its failures name, or the GPU's when the supervisor's samples show the pod was not running. */
  cause: RouteFailureCause | null;
  causeCounts: Partial<Record<RouteFailureCause, number>>;
  lastFailureAt: string | null;
  lastSubmittedAt: string | null;
  restored: boolean;
  evidence: string;
}

/** What the pod supervisor (`runpodPod.ts`) recorded in the window, as `RUNPOD_POD` rows. */
export interface GpuPodReading {
  /** Supervisor samples by the pod status RunPod reported: RUNNING, EXITED, TERMINATED or UNKNOWN (RunPod could not return the pod). */
  samples: Record<string, number>;
  startFailures: number;
  lastStartFailure: string | null;
  /** Samples exist and none of them saw the pod running. */
  notRunning: boolean;
}

export interface ThroughputDiagnosis {
  routes: RouteDiagnosis[];
  gpu: GpuPodReading;
  /** The failing route with the most failures that has not answered since: what to restore first. */
  primary: { route: string; cause: RouteFailureCause; failures: number; evidence: string } | null;
  /** Routes that failed in the window and then had work accepted again. */
  restored: { route: string; cause: RouteFailureCause | null; at: string }[];
}

/**
 * Whether existing queued work advanced since the previous recorded reading
 * (`ADVANCING`: something was accepted since; `STALLED`: work waited and
 * nothing was accepted; `IDLE`: nothing waited; `FIRST_READING`: nothing to
 * compare with).
 */
export interface QueueAdvance {
  verdict: 'ADVANCING' | 'STALLED' | 'IDLE' | 'FIRST_READING';
  previousAt: string | null;
  previousQueued: number | null;
  queuedNow: number;
  acceptedSincePrevious: number | null;
}

const n = (value: unknown): number => Number(value ?? 0) || 0;
const NOT = (reason: string): { measured: false; reason: string } => ({ measured: false, reason });
const ok = <T>(value: T): { measured: true; value: T } => ({ measured: true, value });
const placeholders = (items: readonly unknown[]): string => items.map(() => '?').join(', ');

/**
 * Whether a `FREE_LANE_ITEM` outcome is a dropped (or repeated) record, as the
 * spec keeps it apart from model/provider failures. The worker records three
 * outcomes (worker.ts): `SUBMITTED` (accepted), `RELEASED_TRANSIENT` (handed
 * back with its attempt refunded because the provider or Brain itself was
 * unavailable — the work was neither dropped nor repeated, it waits to be done)
 * and `FAILED_RETRYABLE` (the lane produced no answer Brain accepted). Only the
 * last is dropped, and only when its reason is not a model call failure, which
 * is a provider failure and already counted under `providerFailures`. A total
 * minus the accepted count would mix the two measures.
 */
export function isDroppedOutcome(outcome: string | null, providerFailed: boolean): boolean {
  return outcome === 'FAILED_RETRYABLE' && !providerFailed;
}

/** Per-stage reading from the rows. Exported for tests. */
async function readStage(def: StageDefinition, since: string, hours: number, nowMs: number): Promise<StageReading> {
  const blank = (reason: string): StageReading => ({
    stage: def.id,
    label: def.label,
    queueSize: NOT(reason),
    oldestUsefulItemMinutes: NOT(reason),
    itemsProcessedPerHour: NOT(reason),
    uniqueUsableFacts: NOT(reason),
    droppedOrDuplicate: NOT(reason),
    modelCallsAvoided: NOT('model calls avoided are not recorded'),
    providerFailures: NOT(reason),
    elapsedMs: NOT(reason),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    resources: NOT(def.workTypes.length > 0
      ? reason
      : 'this stage runs outside the free lane, in code that records no per-run CPU, memory or network reading'),
    accepted: 0,
    acceptedPerHour: 0,
  });
  const rowReader = ROW_STAGES[def.id];
  if (def.workTypes.length === 0 && rowReader) {
    return { ...blank('not recorded for this stage'), ...(await rowReader(since, hours, nowMs)), stage: def.id, label: def.label, measuredFrom: def.rows ?? [] };
  }
  if (def.workTypes.length === 0) return blank(def.unseen ?? 'no lane row sees this stage');

  const db = getDb();
  const types = [...def.workTypes];
  const queued = await db.get<{ n: number | string; oldest: string | null }>(
    `SELECT COUNT(*) AS n, MIN(w.available_at) AS oldest FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts
        AND w.work_type IN (${placeholders(types)})`,
    [new Date(nowMs).toISOString(), ...types],
  );
  const events = await db.all<{ outcome: string | null; failed: number | string; k: number | string; ms: number | string | null }>(
    `SELECT outcome,
            CASE WHEN reason LIKE '%model call failed%' THEN 1 ELSE 0 END AS failed,
            COUNT(*) AS k, SUM(duration_ms) AS ms
       FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND workload_class IN (${placeholders(types)})
      GROUP BY outcome, CASE WHEN reason LIKE '%model call failed%' THEN 1 ELSE 0 END`,
    [since, ...types],
  );
  const facts = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT c.id) AS n
       FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
       JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?
        AND c.sourced = 1 AND e.workload_class IN (${placeholders(types)})`,
    [since, ...types],
  );
  const metered = await db.all<{ measures: string | Record<string, unknown> | null }>(
    `SELECT measures FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND workload_class IN (${placeholders(types)})
        AND measures LIKE '%"usage"%'`,
    [since, ...types],
  );

  let total = 0;
  let accepted = 0;
  let providerFailures = 0;
  let dropped = 0;
  let ms = 0;
  for (const row of events) {
    total += n(row.k);
    ms += n(row.ms);
    const providerFailed = n(row.failed) === 1;
    if (row.outcome === 'SUBMITTED') accepted += n(row.k);
    if (providerFailed) providerFailures += n(row.k);
    if (isDroppedOutcome(row.outcome, providerFailed)) dropped += n(row.k);
  }
  const oldest = queued?.oldest ? Math.max(0, Math.round((nowMs - Date.parse(queued.oldest)) / 60_000)) : null;
  const usage = sumUsage(metered.map((row) => usageOf(row.measures)), total);
  return {
    stage: def.id,
    label: def.label,
    queueSize: ok(n(queued?.n)),
    oldestUsefulItemMinutes: ok(oldest),
    itemsProcessedPerHour: ok(total / hours),
    uniqueUsableFacts: ok(n(facts?.n)),
    // Only work the lane gave up on without an accepted answer; a provider
    // failure or a handed-back item is counted under its own measure, not here.
    droppedOrDuplicate: ok(dropped),
    modelCallsAvoided: usage.measured
      ? ok(usage.avoided)
      : NOT('no lane item in the window recorded its model calls (items record them since the item meter was added)'),
    providerFailures: ok(providerFailures),
    elapsedMs: ok(ms),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    resources: usage.measured
      ? ok(usage.resources)
      : NOT('no lane item in the window recorded its CPU, memory, database or network use'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

/** The `usage` a `FREE_LANE_ITEM` row's measures carry, or null. Exported for tests. */
export function usageOf(measures: string | Record<string, unknown> | null | undefined): ItemUsage | null {
  let parsed: unknown = measures;
  if (typeof measures === 'string') {
    try {
      parsed = JSON.parse(measures);
    } catch {
      return null;
    }
  }
  const usage = (parsed as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (k: string): number => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  return {
    modelCalls: num('modelCalls'),
    modelCallsAvoided: num('modelCallsAvoided'),
    cpuMicros: num('cpuMicros'),
    peakRssBytes: num('peakRssBytes'),
    rssShareBytes: num('rssShareBytes'),
    dbCalls: num('dbCalls'),
    dbMs: num('dbMs'),
    networkBytesOut: num('networkBytesOut'),
    networkBytesIn: num('networkBytesIn'),
  };
}

/** One stage's items' usage, summed. Unmeasured when no item carried a reading. Pure; exported for tests. */
export function sumUsage(
  usages: readonly (ItemUsage | null)[],
  itemsInWindow: number,
): { measured: true; avoided: number; resources: StageResources } | { measured: false } {
  const present = usages.filter((u): u is ItemUsage => u !== null);
  if (present.length === 0) return { measured: false };
  const resources: StageResources = {
    scope: 'stage', itemsMetered: present.length, itemsInWindow: Math.max(itemsInWindow, present.length),
    modelCalls: 0, cpuSeconds: 0, cpuBound: 'UPPER', peakRssBytes: 0, meanRssShareBytes: 0,
    dbCalls: 0, dbMs: 0, networkBytesOut: 0, networkBytesIn: 0,
  };
  let avoided = 0;
  let share = 0;
  for (const u of present) {
    avoided += u.modelCallsAvoided;
    resources.modelCalls += u.modelCalls;
    resources.cpuSeconds += u.cpuMicros / 1e6;
    resources.peakRssBytes = Math.max(resources.peakRssBytes, u.peakRssBytes);
    share += u.rssShareBytes;
    resources.dbCalls += u.dbCalls;
    resources.dbMs += u.dbMs;
    resources.networkBytesOut += u.networkBytesOut;
    resources.networkBytesIn += u.networkBytesIn;
  }
  resources.meanRssShareBytes = Math.round(share / present.length);
  return { measured: true, avoided, resources };
}

type RowStageReading = Omit<StageReading, 'stage' | 'label' | 'measuredFrom' | 'resources'>;
type RowStageReader = (since: string, hours: number, nowMs: number) => Promise<RowStageReading>;

const minutesSince = (iso: string | null | undefined, nowMs: number): number | null =>
  iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000)) : null;

/**
 * Source fetching / ingestion, from `feed_pulls`: one row per pull of a source,
 * with what it fetched and how many of those were new (`feed_items` is unique
 * by source and external id, so `fetched - inserted` are records already held).
 * Pulls run on the feed tick's schedule, so nothing waits in a queue for one.
 */
async function readIngestion(since: string, hours: number): Promise<RowStageReading> {
  const row = await getDb().get<{ pulls: number | string; ok: number | string; failed: number | string; inserted: number | string | null; repeated: number | string | null }>(
    `SELECT COUNT(*) AS pulls,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS failed,
            SUM(CASE WHEN ok = 1 THEN inserted ELSE 0 END) AS inserted,
            SUM(CASE WHEN ok = 1 AND fetched > inserted THEN fetched - inserted ELSE 0 END) AS repeated
       FROM feed_pulls WHERE created_at >= ?`,
    [since],
  );
  const accepted = n(row?.ok);
  const noQueue = NOT('feeds are pulled on the feed tick\'s schedule; no fetch waits in a queue');
  return {
    queueSize: noQueue,
    oldestUsefulItemMinutes: noQueue,
    itemsProcessedPerHour: ok(n(row?.pulls) / hours),
    uniqueUsableFacts: ok(n(row?.inserted)),
    droppedOrDuplicate: ok(n(row?.repeated)),
    modelCallsAvoided: NOT('a fetch calls no model'),
    providerFailures: ok(n(row?.failed)),
    elapsedMs: NOT('feed_pulls records no duration'),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

/**
 * Parsing and indexing, from `extraction_runs`: the queue is runs still QUEUED;
 * a run finished in the window is processed; READY / READY_WITH_WARNINGS is
 * usable; FAILED or BLOCKED is dropped, and a run over bytes (document and
 * source hash) an earlier run already read is a duplicate.
 */
async function readParsing(since: string, hours: number, nowMs: number): Promise<RowStageReading> {
  const db = getDb();
  const queued = await db.get<{ n: number | string; oldest: string | null }>(
    "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM extraction_runs WHERE status = 'QUEUED'",
    [],
  );
  const done = await db.all<{ status: string; document_id: string; started_at: string | null; completed_at: string }>(
    'SELECT status, document_id, started_at, completed_at FROM extraction_runs WHERE completed_at IS NOT NULL AND completed_at >= ?',
    [since],
  );
  const repeated = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM extraction_runs r
      WHERE r.completed_at IS NOT NULL AND r.completed_at >= ? AND r.source_hash IS NOT NULL
        AND EXISTS (SELECT 1 FROM extraction_runs p
                     WHERE p.document_id = r.document_id AND p.source_hash = r.source_hash
                       AND p.id <> r.id AND p.created_at < r.created_at)`,
    [since],
  );
  const usable = new Set<string>();
  let accepted = 0;
  let failed = 0;
  let ms = 0;
  for (const run of done) {
    if (run.status === 'READY' || run.status === 'READY_WITH_WARNINGS') {
      accepted += 1;
      usable.add(run.document_id);
    }
    if (run.status === 'FAILED' || run.status === 'BLOCKED') failed += 1;
    if (run.started_at) ms += Math.max(0, Date.parse(run.completed_at) - Date.parse(run.started_at)) || 0;
  }
  return {
    queueSize: ok(n(queued?.n)),
    oldestUsefulItemMinutes: ok(minutesSince(queued?.oldest, nowMs)),
    itemsProcessedPerHour: ok(done.length / hours),
    uniqueUsableFacts: ok(usable.size),
    droppedOrDuplicate: ok(failed + n(repeated?.n)),
    modelCallsAvoided: NOT('parsing calls no model'),
    providerFailures: NOT('parsing runs in-process and calls no provider'),
    elapsedMs: ok(ms),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

/**
 * Graph / detection / quant computation, from `feed_detections` (detectors over
 * stored records), `feed_item_coverage` (records an ACTIVE detection covered, so
 * the free screen does not send them to a model one by one: model calls
 * avoided, `detectors.ts`) and `scenario_runs` (simulations). Detectors run over
 * each pull and a scenario runs when asked, so nothing waits in a queue.
 */
async function readComputation(since: string, hours: number): Promise<RowStageReading> {
  const db = getDb();
  const detections = await db.get<{ n: number | string; active: number | string | null }>(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN mode = 'ACTIVE' THEN 1 ELSE 0 END) AS active FROM feed_detections WHERE detected_at >= ?",
    [since],
  );
  const runs = await db.get<{ n: number | string; complete: number | string | null; failed: number | string | null; digests: number | string; ms: number | string | null }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS complete,
            SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            COUNT(DISTINCT CASE WHEN state = 'COMPLETE' THEN result_digest END) AS digests,
            SUM(elapsed_ms) AS ms
       FROM scenario_runs WHERE finished_at IS NOT NULL AND finished_at >= ?`,
    [since],
  );
  const recomputed = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM scenario_runs r
      WHERE r.state = 'COMPLETE' AND r.finished_at IS NOT NULL AND r.finished_at >= ?
        AND EXISTS (SELECT 1 FROM scenario_runs p
                     WHERE p.config_hash = r.config_hash AND p.state = 'COMPLETE'
                       AND p.id <> r.id AND p.started_at < r.started_at)`,
    [since],
  );
  const covered = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT c.item_id) AS n FROM feed_item_coverage c
      WHERE c.covered_at >= ?
        AND NOT EXISTS (SELECT 1 FROM feed_item_coverage e WHERE e.item_id = c.item_id AND e.covered_at < ?)`,
    [since, since],
  );
  const accepted = n(detections?.active) + n(runs?.complete);
  const noQueue = NOT('detectors run over each pull and a scenario runs when asked; nothing waits in a queue');
  return {
    queueSize: noQueue,
    oldestUsefulItemMinutes: noQueue,
    itemsProcessedPerHour: ok((n(detections?.n) + n(runs?.n)) / hours),
    uniqueUsableFacts: ok(n(detections?.active) + n(runs?.digests)),
    droppedOrDuplicate: ok(n(runs?.failed) + n(recomputed?.n)),
    modelCallsAvoided: ok(n(covered?.n)),
    providerFailures: NOT('computation calls no provider'),
    elapsedMs: ok(n(runs?.ms)),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

/**
 * Human / authorized commercial execution, from `cash_actions` (each action a
 * person or Brain performed under an authority) and `cash_needs` (an action
 * blocked on a person: OPEN is the queue, WITHDRAWN is dropped).
 */
async function readCommercial(since: string, hours: number, nowMs: number): Promise<RowStageReading> {
  const db = getDb();
  const open = await db.get<{ n: number | string; oldest: string | null }>(
    "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM cash_needs WHERE state = 'OPEN'",
    [],
  );
  const actions = await db.get<{ n: number | string; opportunities: number | string }>(
    'SELECT COUNT(*) AS n, COUNT(DISTINCT opportunity_id) AS opportunities FROM cash_actions WHERE created_at >= ?',
    [since],
  );
  const withdrawn = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM cash_needs WHERE state = 'WITHDRAWN' AND updated_at >= ?",
    [since],
  );
  const accepted = n(actions?.n);
  return {
    queueSize: ok(n(open?.n)),
    oldestUsefulItemMinutes: ok(minutesSince(open?.oldest, nowMs)),
    itemsProcessedPerHour: ok(accepted / hours),
    uniqueUsableFacts: ok(n(actions?.opportunities)),
    droppedOrDuplicate: ok(n(withdrawn?.n)),
    modelCallsAvoided: NOT('commercial execution calls no model'),
    providerFailures: NOT('executed by a person or an authorized connector, not a model provider'),
    elapsedMs: NOT('cash_actions records no duration'),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

/** Readers for the stages the lane does not run, keyed by stage id. */
const ROW_STAGES: Record<string, RowStageReader> = {
  'source-ingestion': readIngestion,
  'parsing-indexing': readParsing,
  'graph-quant': readComputation,
  'commercial-execution': readCommercial,
};

/**
 * Each productive (SUBMITTED) job is attributed to exactly one purpose: the
 * purpose of the bin the item is queued on. Joining on the item's own bin, never
 * on an orchestration, is what makes a job unable to match twice.
 */
async function readPurposes(since: string): Promise<PurposeAttribution[]> {
  const rows = await getDb().all<{ purpose: string | null; k: number | string }>(
    `SELECT b.purpose AS purpose, COUNT(*) AS k
       FROM bin_events e LEFT JOIN bins b ON b.id = e.bin_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?
      GROUP BY b.purpose`,
    [since],
  );
  return rows
    .map((r) => ({ purpose: r.purpose ?? 'UNATTRIBUTED', productiveJobs: n(r.k) }))
    .sort((a, b) => b.productiveJobs - a.productiveJobs || a.purpose.localeCompare(b.purpose));
}

const DISCOVERY_DEAL_ROUNDS = "('SEED_EQUIPMENT', 'ADJACENT')";

/**
 * Each productive (SUBMITTED) job, with the row facts `attributeJob` decides
 * on. The job's orchestration is the one its event row names, else its bin's,
 * else its work item's; every fact is
 * an EXISTS over the rows that consume that orchestration, so a job is one row
 * here however many consumers match, and is attributed once.
 */
async function readCategories(since: string): Promise<CategoryAttribution[]> {
  const rows = await getDb().all<{
    bin_purpose: string | null; brain_project: number | string | null; validates_opening: number | string;
    deal_round: number | string; future_goal: number | string; commercial: number | string;
  }>(
    `SELECT j.bin_purpose,
            CASE WHEN p.slug = 'brain-architecture' OR p.purpose = 'TECHNICAL' THEN 1 ELSE 0 END AS brain_project,
            CASE WHEN j.orch IS NOT NULL AND EXISTS (
              SELECT 1 FROM cash_opportunities o WHERE o.validation_orchestration_id = j.orch) THEN 1 ELSE 0 END AS validates_opening,
            CASE WHEN j.orch IS NOT NULL AND EXISTS (
              SELECT 1 FROM russell_missions m JOIN deal_rounds d ON d.candidate_id = m.candidate_id
               WHERE m.orchestration_id = j.orch AND d.purpose NOT IN ${DISCOVERY_DEAL_ROUNDS}) THEN 1 ELSE 0 END AS deal_round,
            CASE WHEN j.orch IS NOT NULL AND EXISTS (
              SELECT 1 FROM research_orchestrations ro JOIN russell_goals g ON g.id = ro.goal_id
               WHERE ro.id = j.orch AND g.starts_at > j.at
              UNION ALL
              SELECT 1 FROM russell_missions m JOIN russell_goals g ON g.id = m.goal_id
               WHERE m.orchestration_id = j.orch AND g.starts_at > j.at) THEN 1 ELSE 0 END AS future_goal,
            CASE WHEN EXISTS (SELECT 1 FROM cash_modes c WHERE c.project_id = j.project_id)
                   OR (j.orch IS NOT NULL AND (
                        EXISTS (SELECT 1 FROM cash_opportunities o WHERE o.orchestration_id = j.orch)
                     OR EXISTS (SELECT 1 FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
                                 WHERE m.orchestration_id = j.orch)
                     OR EXISTS (SELECT 1 FROM russell_missions m JOIN deal_rounds d ON d.candidate_id = m.candidate_id
                                 WHERE m.orchestration_id = j.orch AND d.purpose IN ${DISCOVERY_DEAL_ROUNDS})))
                 THEN 1 ELSE 0 END AS commercial
       FROM (SELECT e.id, e.at, b.purpose AS bin_purpose,
                    COALESCE(e.project_id, b.project_id, w.project_id) AS project_id,
                    COALESCE(e.orchestration_id, b.orchestration_id, w.orchestration_id) AS orch
               FROM bin_events e
               LEFT JOIN bins b ON b.id = e.bin_id
               LEFT JOIN work_items w ON w.id = e.work_item_id
              WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?) j
       LEFT JOIN projects p ON p.id = j.project_id`,
    [since],
  );
  const byCategory = new Map<AttributionCategory, CategoryAttribution>(
    ATTRIBUTION_CATEGORIES.map((category) => [category, { category, productiveJobs: 0, bases: {} }]),
  );
  for (const row of rows) {
    const { category, basis } = attributeJob({
      binPurpose: row.bin_purpose,
      brainProject: n(row.brain_project) === 1,
      validatesOpening: n(row.validates_opening) === 1,
      dealRound: n(row.deal_round) === 1,
      futureGoal: n(row.future_goal) === 1,
      commercialDiscovery: n(row.commercial) === 1,
    });
    const entry = byCategory.get(category)!;
    entry.productiveJobs += 1;
    entry.bases[basis] = (entry.bases[basis] ?? 0) + 1;
  }
  return [...byCategory.values()];
}

function readProcess(): ProcessReading {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const pools = databasePoolReadings();
  return {
    scope: 'process',
    cpuSecondsSinceStart: (cpu.user + cpu.system) / 1e6,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    dbPool: pools ? ok({ workloadWaiting: pools.workload.waiting }) : NOT('the SQLite adapter has no connection pool to read'),
    network: NOT('the process keeps no network counter of its own; each lane stage\'s network bytes are in its resources'),
  };
}

/**
 * The constrained stage, named from measurements only. A stage with work waiting
 * and a poor accepted rate is the one that limits accepted facts; a stage with
 * nothing waiting is not constrained, however slow. A gain is projected only
 * where it can be measured, and never as a reason to scale the web process.
 */
export function chooseConstraint(
  stages: StageReading[],
  failing: ThroughputDiagnosis['primary'] = null,
  windowHours = 6,
): Constraint {
  const first = failing
    ? `Restore model route ${failing.route} first: ${failing.failures} failure(s) in the window name ${failing.cause} (${failing.evidence}). `
    : '';
  const recommendation =
    first +
    'Restore the failing provider, credential, route or verification path first and watch whether queued work advances; ' +
    'scale independent workers only after a measured gain. Do not enlarge the web process because a queue is long.';
  let worst: { stage: StageReading; waiting: number; rate: number } | null = null;
  for (const stage of stages) {
    if (!stage.queueSize.measured || !stage.itemsProcessedPerHour.measured) continue;
    const waiting = stage.queueSize.value;
    if (waiting <= 0) continue;
    const processed = stage.itemsProcessedPerHour.value;
    const rate = processed > 0 ? stage.acceptedPerHour / processed : 0;
    const score = waiting * (1 - rate);
    if (!worst || score > worst.waiting * (1 - worst.rate)) worst = { stage, waiting, rate };
  }
  if (!worst) {
    return {
      stage: null,
      basis: failing
        ? `No measured stage has work waiting; model route ${failing.route} is failing (${failing.cause}).`
        : 'No measured stage has work waiting, so none is shown to be constraining.',
      expectedGain: NOT('no constrained stage'),
      recommendation,
    };
  }
  const { stage } = worst;
  return {
    stage: stage.stage,
    basis:
      `${stage.label}: ${worst.waiting} waiting, ${Math.round(worst.rate * 100)}% of processed items accepted.` +
      (failing ? ` Failing route ${failing.route}: ${failing.cause}.` : ''),
    expectedGain: projectedGain(stage, worst.waiting, worst.rate, windowHours),
    recommendation,
  };
}

/**
 * What one more replica of the constrained stage would add, from its own
 * measurements: its measured accepted rate (never more than the waiting work at
 * its measured acceptance can yield), at its measured dollars per hour. A stage
 * whose spend is not measured projects nothing.
 */
export function projectedGain(stage: StageReading, waiting: number, acceptance: number, windowHours: number): Constraint['expectedGain'] {
  if (!stage.incrementalDollars.measured) {
    return NOT(`accepted facts per hour per dollar needs the stage's spend, which is not measured: ${stage.incrementalDollars.reason}`);
  }
  const hours = windowHours > 0 ? windowHours : 6;
  return ok({
    acceptedFactsPerHour: Math.min(stage.acceptedPerHour, waiting * acceptance),
    dollars: stage.incrementalDollars.value / hours,
  });
}

/** The lane stages a model call serves, and so the stages the GPU's spend belongs to. */
const LANE_STAGES = (): StageDefinition[] => STAGES.filter((s) => s.workTypes.length > 0);

/**
 * Each lane stage's share of the window's model spend. The free providers cost
 * $0, so the lane's model spend is the GPU pod's, measured from the supervisor's
 * samples. It is divided by the items each stage sent to a GPU slot, so a stage
 * that never used the GPU spent nothing on it. A pod that billed while no item
 * used it is idle spend: incremental to no stage, and reported in `gpuSpend`.
 * Without samples, or with a running sample RunPod gave no price for, the spend
 * is not known and is not invented. Pure.
 */
export function laneDollarsByStage(
  spend: PodSpend,
  gpuItemsByStage: ReadonlyMap<string, number>,
): Map<string, Measured<number>> {
  const out = new Map<string, Measured<number>>();
  const lane = LANE_STAGES().map((s) => s.id);
  if (spend.samples === 0) {
    for (const id of lane) out.set(id, NOT('no RunPod supervisor sample in the window, so the GPU pod\'s spend is not recorded (the free providers cost $0)'));
    return out;
  }
  if (spend.unpricedRunningSamples > 0) {
    for (const id of lane) out.set(id, NOT(`RunPod returned no price for ${spend.unpricedRunningSamples} running sample(s) in the window`));
    return out;
  }
  const gpuItems = lane.reduce((sum, id) => sum + (gpuItemsByStage.get(id) ?? 0), 0);
  for (const id of lane) {
    out.set(id, ok(gpuItems > 0 ? (spend.dollars * (gpuItemsByStage.get(id) ?? 0)) / gpuItems : 0));
  }
  return out;
}

/** Lane items each stage sent to a GPU slot in the window, from `FREE_LANE_ITEM` reasons (`model <route>…`). */
async function readGpuItemsByStage(since: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lane = LANE_STAGES();
  const types = lane.flatMap((s) => [...s.workTypes]);
  const rows = await getDb().all<{ workload_class: string | null; reason: string | null; k: number | string }>(
    `SELECT workload_class, reason, COUNT(*) AS k FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND reason LIKE 'model %' AND workload_class IN (${placeholders(types)})
      GROUP BY workload_class, reason`,
    [since, ...types],
  );
  for (const row of rows) {
    const route = routeOfReason(row.reason);
    if (!route || !isRunpodSlot(route)) continue;
    const stage = lane.find((s) => s.workTypes.includes(row.workload_class ?? ''));
    if (stage) out.set(stage.id, (out.get(stage.id) ?? 0) + n(row.k));
  }
  return out;
}

/** The model route a `FREE_LANE_ITEM` reason names (`model <route>` or `model <route>: …`). */
export function routeOfReason(reason: string | null): string | null {
  return /^model (\S+?)(?::|$)/.exec(reason ?? '')?.[1] ?? null;
}

/** `RUNPOD_POD` rows in the window: one sample per five minutes plus each power action, so a few dozen. */
async function readPodRows(since: string): Promise<{ outcome: string; at: string }[]> {
  const rows = await getDb().all<{ outcome: string | null; at: string }>(
    `SELECT outcome, at FROM bin_events WHERE event_type = 'RUNPOD_POD' AND at >= ? ORDER BY at`,
    [since],
  );
  return rows.map((r) => ({ outcome: r.outcome ?? '', at: r.at }));
}

/** The supervisor's view up to `until` (inclusive), or of the whole window when `until` is null. */
export function gpuPodReading(rows: readonly { outcome: string; at: string }[], until: string | null = null): GpuPodReading {
  const samples: Record<string, number> = {};
  let startFailures = 0;
  let lastStartFailure: string | null = null;
  for (const row of rows) {
    if (until !== null && row.at > until) continue;
    if (row.outcome.startsWith('SAMPLE_')) {
      const status = row.outcome.slice('SAMPLE_'.length);
      samples[status] = (samples[status] ?? 0) + 1;
    }
    if (row.outcome === 'START_FAILED') {
      startFailures += 1;
      lastStartFailure = row.at;
    }
  }
  const total = Object.values(samples).reduce((sum, k) => sum + k, 0);
  return { samples, startFailures, lastStartFailure, notRunning: total > 0 && !samples['RUNNING'] };
}

/**
 * Which model route is failing and why, from the rows alone (CAP-16-3: identify
 * the actual cause from current signals before any scale-up). A route's cause is
 * what most of its failures name; on a GPU slot whose supervisor samples never
 * saw the pod running, it is the GPU, whatever the fallback's error said.
 */
export async function diagnoseThroughput(since: string): Promise<ThroughputDiagnosis> {
  const rows = await getDb().all<{ outcome: string | null; reason: string | null; k: number | string; last: string | null }>(
    `SELECT outcome, reason, COUNT(*) AS k, MAX(at) AS last FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND reason LIKE 'model %'
      GROUP BY outcome, reason`,
    [since],
  );
  const podRows = await readPodRows(since);
  const gpu = gpuPodReading(podRows);
  const byRoute = new Map<string, RouteDiagnosis>();
  for (const row of rows) {
    const route = routeOfReason(row.reason);
    if (!route) continue;
    const entry = byRoute.get(route) ?? {
      route, submitted: 0, providerFailures: 0, cause: null, causeCounts: {}, lastFailureAt: null, lastSubmittedAt: null, restored: false, evidence: '',
    };
    if (row.outcome === 'SUBMITTED') {
      entry.submitted += n(row.k);
      if (row.last && (!entry.lastSubmittedAt || row.last > entry.lastSubmittedAt)) entry.lastSubmittedAt = row.last;
    }
    const cause = causeOfReason(row.reason);
    if (cause && cause !== 'database') {
      entry.providerFailures += n(row.k);
      entry.causeCounts[cause] = (entry.causeCounts[cause] ?? 0) + n(row.k);
      if (row.last && (!entry.lastFailureAt || row.last > entry.lastFailureAt)) entry.lastFailureAt = row.last;
    }
    byRoute.set(route, entry);
  }
  const routes = [...byRoute.values()].filter((r) => r.providerFailures > 0);
  for (const route of routes) {
    const ranked = (Object.entries(route.causeCounts) as [RouteFailureCause, number][]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0]!;
    // The pod as the supervisor saw it while the route was failing: a pod
    // recreated afterwards does not rewrite why the earlier calls failed.
    const during = gpuPodReading(podRows, route.lastFailureAt);
    if (isRunpodSlot(route.route) && during.notRunning) {
      const seen = Object.entries(during.samples).map(([status, k]) => `${status} ${k}`).join(', ');
      route.cause = 'broken GPU';
      route.evidence =
        `the pod supervisor never saw the pod running while the route failed (samples: ${seen}` +
        `${during.startFailures > 0 ? `; ${during.startFailures} refused start(s)` : ''}); the failures' own text named ${top[0]} ×${top[1]}`;
    } else {
      route.cause = top[0];
      route.evidence = ranked.map(([cause, k]) => `${cause} ×${k}`).join(', ');
    }
    route.restored = route.lastSubmittedAt !== null && route.lastFailureAt !== null && route.lastSubmittedAt > route.lastFailureAt;
  }
  routes.sort((a, b) => b.providerFailures - a.providerFailures || a.route.localeCompare(b.route));
  const open = routes.find((r) => !r.restored);
  return {
    routes,
    gpu,
    primary: open && open.cause ? { route: open.route, cause: open.cause, failures: open.providerFailures, evidence: open.evidence } : null,
    restored: routes.filter((r) => r.restored).map((r) => ({ route: r.route, cause: r.cause, at: r.lastSubmittedAt! })),
  };
}

/** Compares the queue and the accepted work with the previous recorded reading. Read it before writing the new one. */
export async function readQueueAdvance(queuedNowCount: number): Promise<QueueAdvance> {
  const db = getDb();
  const previous = await db.get<{ at: string; measures: string | null }>(
    `SELECT at, measures FROM bin_events WHERE event_type = ? AND outcome = 'MEASURED' ORDER BY at DESC LIMIT 1`,
    [STAGE_CAPACITY_EVENT],
  );
  if (!previous) {
    return { verdict: 'FIRST_READING', previousAt: null, previousQueued: null, queuedNow: queuedNowCount, acceptedSincePrevious: null };
  }
  let previousQueued: number | null = null;
  try {
    const parsed = JSON.parse(previous.measures ?? '{}') as { queuedNow?: unknown };
    previousQueued = typeof parsed.queuedNow === 'number' ? parsed.queuedNow : null;
  } catch {
    previousQueued = null;
  }
  const accepted = await db.get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at > ?",
    [previous.at],
  );
  const acceptedSincePrevious = n(accepted?.k);
  const waited = queuedNowCount > 0 || (previousQueued ?? 0) > 0;
  const verdict: QueueAdvance['verdict'] = acceptedSincePrevious > 0 ? 'ADVANCING' : waited ? 'STALLED' : 'IDLE';
  return { verdict, previousAt: previous.at, previousQueued, queuedNow: queuedNowCount, acceptedSincePrevious };
}

/** The per-stage, per-purpose measurement for the last `hours` hours (default 6). */
export async function stageCapacity(options: { hours?: number; now?: number } = {}): Promise<StageCapacityReport> {
  const hours = options.hours && options.hours > 0 ? options.hours : 6;
  const nowMs = options.now ?? Date.now();
  const since = new Date(nowMs - hours * 3_600_000).toISOString();
  const stages: StageReading[] = [];
  for (const def of STAGES) stages.push(await readStage(def, since, hours, nowMs));
  // The lane's dollars, measured from the GPU pod's own samples and divided by
  // which stage used the GPU (the free providers cost $0).
  const spend = await readPodSpend(since);
  const dollars = laneDollarsByStage(spend, await readGpuItemsByStage(since));
  for (const stage of stages) {
    const measured = dollars.get(stage.stage);
    if (measured) stage.incrementalDollars = measured;
  }
  const gpuSpend: Measured<PodSpend> = spend.samples === 0
    ? NOT('no RunPod supervisor sample in the window')
    : spend.unpricedRunningSamples > 0
      ? NOT(`RunPod returned no price for ${spend.unpricedRunningSamples} running sample(s) in the window`)
      : ok(spend);
  const purposes = await readPurposes(since);
  const totalProductiveJobs = purposes.reduce((sum, p) => sum + p.productiveJobs, 0);
  const total = await getDb().get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?",
    [since],
  );
  const attribution = await readCategories(since);
  const diagnosis = await diagnoseThroughput(since);
  return {
    windowHours: hours,
    since,
    stages,
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    attribution,
    attributionSumsToTotal: attribution.reduce((sum, c) => sum + c.productiveJobs, 0) === n(total?.k),
    process: readProcess(),
    gpuSpend,
    diagnosis,
    constrained: chooseConstraint(stages, diagnosis.primary, hours),
  };
}

/** Jobs queued and claimable now, across every stage the lane answers. */
export async function queuedNow(): Promise<number> {
  return waitingNow({ includeImprovement: false });
}

/** The `bin_events.event_type` a stage-capacity measurement is recorded under. */
export const STAGE_CAPACITY_EVENT = 'FREE_LANE_STAGE_CAPACITY';

/**
 * Measure every stage and record the result as one `bin_events` row, so the
 * per-stage reading exists on production records rather than only as a function
 * nobody calls (CAP-16-3). Runs from the free lane's background loop, never from
 * a web request. A measurement that fails is recorded as failed, with its reason,
 * rather than skipped silently.
 */
export async function recordStageCapacity(options: { hours?: number; now?: number } = {}): Promise<StageCapacityReport | null> {
  const started = Date.now();
  try {
    const report = await stageCapacity(options);
    const waiting = await queuedNow();
    // Read before this row is written, so the comparison is with the previous reading.
    const advance = await readQueueAdvance(waiting);
    const { primary, restored } = report.diagnosis;
    const cause = primary
      ? ` Failing: ${primary.route} (${primary.cause}; ${primary.failures} failure(s)).`
      : restored.length > 0
        ? ` Restored: ${restored.map((r) => `${r.route} (${r.cause ?? 'unclassified'})`).join(', ')}.`
        : ' No model route failing.';
    await recordBinEvent({
      eventType: STAGE_CAPACITY_EVENT,
      outcome: 'MEASURED',
      reason: `${report.constrained.basis}${cause} Queued work ${advance.verdict.toLowerCase().replace('_', ' ')}.`,
      durationMs: Date.now() - started,
      evidenceClass: 'MEASURED',
      measures: { ...report, queuedNow: waiting, queueAdvance: advance } as unknown as Record<string, unknown>,
    });
    return report;
  } catch (error) {
    await recordBinEvent({
      eventType: STAGE_CAPACITY_EVENT,
      outcome: 'NOT_MEASURED',
      reason: `stage capacity measurement failed: ${(error as Error).message}`.slice(0, 480),
      durationMs: Date.now() - started,
      evidenceClass: 'MEASURED',
    });
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Reading the recorded measurement back                                      */
/* ------------------------------------------------------------------------- */

/** A recorded reading older than this (two measurement intervals) is reported as stale, not as current. */
export const STAGE_CAPACITY_STALE_MS = 2 * 60 * 60_000;

/** The latest `FREE_LANE_STAGE_CAPACITY` row, parsed: what every reader of the measurement shares. */
export interface RecordedStageCapacity {
  at: string;
  outcome: 'MEASURED' | 'NOT_MEASURED';
  reason: string;
  ageMinutes: number;
  /** Older than `STAGE_CAPACITY_STALE_MS`: the hourly measurement has stopped, which is itself a finding. */
  stale: boolean;
  /** Null when the measurement failed (`NOT_MEASURED`) or its measures could not be read. */
  report: StageCapacityReport | null;
  queuedNow: number | null;
  queueAdvance: QueueAdvance | null;
}

/**
 * The most recent stage-capacity measurement, read from its production row, so
 * the per-stage figures, the diagnosed failing route and `chooseConstraint`'s
 * recommendation reach the lane's own readers (`coverage.ts`: `admin free-lane
 * show`, the Brain-only switch and the displaced-work watchdog) and the report
 * CLI (`stageCapacityReport.ts`) rather than only a hand-written query. Null
 * when nothing has been recorded yet.
 */
export async function readStageCapacity(now = Date.now()): Promise<RecordedStageCapacity | null> {
  const row = await getDb().get<{ at: string; outcome: string; reason: string | null; measures: string | null }>(
    'SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1',
    [STAGE_CAPACITY_EVENT],
  );
  if (!row) return null;
  let measures: Record<string, unknown> | null = null;
  try {
    measures = row.measures ? (JSON.parse(row.measures) as Record<string, unknown>) : null;
  } catch {
    measures = null;
  }
  const report = measures && Array.isArray(measures['stages']) ? (measures as unknown as StageCapacityReport) : null;
  const ageMs = Math.max(0, now - Date.parse(row.at));
  return {
    at: row.at,
    outcome: row.outcome === 'MEASURED' ? 'MEASURED' : 'NOT_MEASURED',
    reason: row.reason ?? '',
    ageMinutes: Math.round(ageMs / 60_000),
    stale: ageMs > STAGE_CAPACITY_STALE_MS,
    report,
    queuedNow: measures && typeof measures['queuedNow'] === 'number' ? measures['queuedNow'] : null,
    queueAdvance: (measures?.['queueAdvance'] as QueueAdvance | undefined) ?? null,
  };
}

const shown = <T>(m: Measured<T> | undefined, fmt: (v: T) => string = String): string =>
  !m ? '—' : m.measured ? fmt(m.value) : 'not measured';

/**
 * The recorded measurement as the lines an operator reads: freshness, the
 * failing or restored route, whether queued work advanced, the constrained
 * stage with its recommendation, then one line per stage and the attribution.
 */
export function stageCapacityLines(recorded: RecordedStageCapacity | null): string[] {
  if (!recorded) return ['stage capacity    not recorded yet (the free lane records it hourly once its loop starts)'];
  const lines = [
    `stage capacity    ${recorded.outcome} ${recorded.at} (${recorded.ageMinutes} min ago${recorded.stale ? ', STALE: the hourly measurement has stopped' : ''})`,
    `  reading         ${recorded.reason}`,
  ];
  const report = recorded.report;
  if (!report) return lines;
  const { primary, restored, gpu } = report.diagnosis;
  if (primary) lines.push(`  failing route   ${primary.route}: ${primary.cause}, ${primary.failures} failure(s) — ${primary.evidence}`);
  for (const r of restored) lines.push(`  restored route  ${r.route} (${r.cause ?? 'unclassified'}) at ${r.at}`);
  if (gpu.notRunning) lines.push(`  gpu pod         not running in any supervisor sample ${JSON.stringify(gpu.samples)}`);
  if (recorded.queueAdvance) {
    const a = recorded.queueAdvance;
    lines.push(
      `  queued work     ${a.verdict} (queued now ${a.queuedNow}` +
        `${a.acceptedSincePrevious === null ? '' : `, ${a.acceptedSincePrevious} accepted since ${a.previousAt ?? '—'}`})`,
    );
  }
  const c = report.constrained;
  lines.push(`  constrained     ${c.stage ?? 'none'} — ${c.basis}`);
  lines.push(
    `  expected gain   ${shown(c.expectedGain, (g) => `${g.acceptedFactsPerHour} accepted facts/h for $${g.dollars}/h per added replica`)}`,
  );
  lines.push(`  recommendation  ${c.recommendation}`);
  for (const s of report.stages) {
    lines.push(
      `  stage ${s.stage} queue=${shown(s.queueSize)} oldest=${shown(s.oldestUsefulItemMinutes, (v) => (v === null ? '—' : `${v}min`))}` +
        ` processed/h=${shown(s.itemsProcessedPerHour)} accepted/h=${s.acceptedPerHour} facts=${shown(s.uniqueUsableFacts)}` +
        ` dropped=${shown(s.droppedOrDuplicate)} avoided=${shown(s.modelCallsAvoided)} providerFailures=${shown(s.providerFailures)}` +
        ` $=${shown(s.incrementalDollars)}`,
    );
  }
  lines.push(
    `  attribution     ${report.attribution.map((a) => `${a.category}=${a.productiveJobs}`).join(' ')} (total ${report.totalProductiveJobs})`,
  );
  return lines;
}

/**
 * The failing route the latest fresh reading names, as one sentence a coverage
 * reason or an intervention can carry; null when there is none or the reading
 * is stale (a stale cause is not a current signal).
 */
export function recordedCause(recorded: RecordedStageCapacity | null): string | null {
  const primary = recorded && !recorded.stale ? recorded.report?.diagnosis.primary : null;
  if (!recorded || !primary) return null;
  const advance = recorded.queueAdvance ? `; queued work ${recorded.queueAdvance.verdict.toLowerCase().replace('_', ' ')}` : '';
  return `Stage capacity (${recorded.at}) names the cause: model route ${primary.route} failing (${primary.cause}, ${primary.failures} failure(s))${advance}.`;
}
