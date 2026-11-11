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
 * is whatever `bins.purpose` says; neither is a list of what Brain may do.
 */
import { getDb } from '../../db/database.ts';
import { databasePoolReadings } from '../../db/database.ts';
import { waitingNow } from './capacity.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { isRunpodSlot } from '../cheap/runpod.ts';
import { causeOfReason, type RouteFailureCause } from './worker.ts';

export type Measured<T> = { measured: true; value: T } | { measured: false; reason: string };

export interface StageDefinition {
  id: string;
  label: string;
  /** Work types whose queue and outcomes belong to this stage, or none when the rows cannot see it. */
  workTypes: readonly string[];
  /** Why the stage has no row-level measure, when `workTypes` is empty. */
  unseen?: string;
}

export const STAGES: readonly StageDefinition[] = [
  { id: 'source-ingestion', label: 'source fetching / ingestion', workTypes: [], unseen: 'source reads are recorded per request in the access report, not per lane job' },
  { id: 'parsing-indexing', label: 'parsing and indexing', workTypes: [], unseen: 'no per-job parse or index row is written' },
  { id: 'graph-quant', label: 'graph / detection / quant computation', workTypes: [], unseen: 'computation runs outside the lane and writes no lane row' },
  { id: 'model-interpretation', label: 'model-based interpretation', workTypes: ['RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_SYNTHESIZE'] },
  { id: 'evidence-verification', label: 'evidence verification', workTypes: ['RESEARCH_VERIFY', 'RESEARCH_AUDIT'] },
  { id: 'commercial-execution', label: 'human / authorized commercial execution', workTypes: [], unseen: 'executed by a person or an authorized connector outside the lane' },
];

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
  accepted: number;
  acceptedPerHour: number;
}

export interface PurposeAttribution {
  /** From `bins.purpose`; `UNATTRIBUTED` when the item's bin carries none. */
  purpose: string;
  productiveJobs: number;
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
  /** Present only when a measurement supports it. */
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
  process: ProcessReading;
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
    accepted: 0,
    acceptedPerHour: 0,
  });
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
    modelCallsAvoided: NOT('model calls avoided are not recorded'),
    providerFailures: ok(providerFailures),
    elapsedMs: ok(ms),
    incrementalDollars: NOT('the lane records no dollar cost per job'),
    accepted,
    acceptedPerHour: accepted / hours,
  };
}

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
    network: NOT('no per-stage network counter is recorded'),
  };
}

/**
 * The constrained stage, named from measurements only. A stage with work waiting
 * and a poor accepted rate is the one that limits accepted facts; a stage with
 * nothing waiting is not constrained, however slow. A gain is projected only
 * where it can be measured, and never as a reason to scale the web process.
 */
export function chooseConstraint(stages: StageReading[], failing: ThroughputDiagnosis['primary'] = null): Constraint {
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
    // Dollars per job are not recorded, so a gain per dollar cannot be claimed.
    expectedGain: NOT('accepted facts per hour per dollar needs a recorded dollar cost, which the lane does not keep'),
    recommendation,
  };
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
  const purposes = await readPurposes(since);
  const totalProductiveJobs = purposes.reduce((sum, p) => sum + p.productiveJobs, 0);
  const total = await getDb().get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?",
    [since],
  );
  const diagnosis = await diagnoseThroughput(since);
  return {
    windowHours: hours,
    since,
    stages,
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    process: readProcess(),
    diagnosis,
    constrained: chooseConstraint(stages, diagnosis.primary),
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
