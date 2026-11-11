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
import { classifyRouteFailure, routeHealthReadings, type RouteFailureCause, type RouteHealthReading } from './worker.ts';

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

/** One model route's outcomes in the window, with each failure's cause read from its own recorded error. */
export interface RouteReading {
  model: string;
  submitted: number;
  failed: number;
  failuresByCause: Partial<Record<RouteFailureCause, number>>;
}

/**
 * Why model / verification throughput is failing, read from the lane's own
 * failure rows rather than assumed (provider availability, credentials, task
 * routing, broken GPU, database, or unclassified).
 */
export interface Diagnosis {
  /** The cause behind most model-call failures in the window, or null when none failed. */
  cause: RouteFailureCause | null;
  /** The model route that failure is concentrated on, when one carries most of it. */
  model: string | null;
  failures: number;
  failuresByCause: Partial<Record<RouteFailureCause, number>>;
  routes: RouteReading[];
  /** Routes this process is holding off work right now, and why. */
  heldRoutes: RouteHealthReading[];
  /** True when the failure rows were more than the reader reads, so the split is a sample. */
  sampled: boolean;
}

/** Whether queued work moved between this reading and the one before it. */
export interface Advance {
  verdict: 'ADVANCING' | 'STALLED' | 'IDLE' | 'NO_PRIOR_READING';
  previousAt: string | null;
  previousQueued: number | null;
  queuedNow: number;
  acceptedSincePrevious: number | null;
  basis: string;
}

export interface StageCapacityReport {
  windowHours: number;
  since: string;
  diagnosis: Diagnosis;
  stages: StageReading[];
  purposes: PurposeAttribution[];
  totalProductiveJobs: number;
  purposesSumToTotal: boolean;
  process: ProcessReading;
  constrained: Constraint;
}

const n = (value: unknown): number => Number(value ?? 0) || 0;
const NOT = (reason: string): { measured: false; reason: string } => ({ measured: false, reason });
const ok = <T>(value: T): { measured: true; value: T } => ({ measured: true, value });
const placeholders = (items: readonly unknown[]): string => items.map(() => '?').join(', ');

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
  let ms = 0;
  for (const row of events) {
    total += n(row.k);
    ms += n(row.ms);
    if (row.outcome === 'SUBMITTED') accepted += n(row.k);
    if (n(row.failed) === 1) providerFailures += n(row.k);
  }
  const oldest = queued?.oldest ? Math.max(0, Math.round((nowMs - Date.parse(queued.oldest)) / 60_000)) : null;
  return {
    stage: def.id,
    label: def.label,
    queueSize: ok(n(queued?.n)),
    oldestUsefulItemMinutes: ok(oldest),
    itemsProcessedPerHour: ok(total / hours),
    uniqueUsableFacts: ok(n(facts?.n)),
    // Outcomes that did not become an accepted submission: dropped or repeated work.
    droppedOrDuplicate: ok(total - accepted),
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
export function chooseConstraint(stages: StageReading[], diagnosis: Diagnosis | null = null): Constraint {
  const recommendation = restoreFirst(diagnosis);
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
      basis: 'No measured stage has work waiting, so none is shown to be constraining.',
      expectedGain: NOT('no constrained stage'),
      recommendation,
    };
  }
  const { stage } = worst;
  return {
    stage: stage.stage,
    basis:
      `${stage.label}: ${worst.waiting} waiting, ${Math.round(worst.rate * 100)}% of processed items accepted` +
      (diagnosis?.cause ? `; model-call failures are mostly ${diagnosis.cause}${diagnosis.model ? ` on ${diagnosis.model}` : ''}.` : '.'),
    // Dollars per job are not recorded, so a gain per dollar cannot be claimed.
    expectedGain: NOT('accepted facts per hour per dollar needs a recorded dollar cost, which the lane does not keep'),
    recommendation,
  };
}

const FAILURE_SAMPLE = 5000;
const SCALE_LATER = 'Scale independent workers only after a measured gain. Do not enlarge the web process because a queue is long.';

/** What restoring throughput means for the cause the rows name: the first remedial action, never a scale-up. */
export function restoreFirst(diagnosis: Diagnosis | null): string {
  const where = diagnosis?.model ? ` on ${diagnosis.model}` : '';
  switch (diagnosis?.cause ?? null) {
    case 'credentials':
      return `Model calls${where} are refused for credentials: replace the provider key or GPU endpoint secret, then watch whether queued work advances. ${SCALE_LATER}`;
    case 'task routing':
      return `Model calls${where} name a model the endpoint does not serve: correct the routed model, then watch whether queued work advances. ${SCALE_LATER}`;
    case 'broken GPU':
      return `The GPU route${where} is failing: restart or replace the pod and re-probe it while the fallback model takes its work, then watch whether queued work advances. ${SCALE_LATER}`;
    case 'provider availability':
      return `The provider${where} is busy or unreachable: the route is held and re-probed while another model takes the work; watch whether queued work advances. ${SCALE_LATER}`;
    case 'database':
      return `Brain's own database is refusing the lane: relieve database pressure before any model change, then watch whether queued work advances. ${SCALE_LATER}`;
    case 'unclassified':
      return `Model calls${where} fail for a reason the error does not name: read the recorded reasons and restore that route first, then watch whether queued work advances. ${SCALE_LATER}`;
    default:
      return `Restore the failing provider, credential, route or verification path first and watch whether queued work advances; ${SCALE_LATER.charAt(0).toLowerCase()}${SCALE_LATER.slice(1)}`;
  }
}

/** The model a free-lane row names: its reason starts `model <name>` (worker.ts writes it so). */
export function modelOf(reason: string | null): string | null {
  const match = /^model (\S+?)(?::|$|\s)/.exec(reason ?? '');
  return match?.[1] ?? null;
}

/**
 * Split the window's model-call failures by the cause each one's own error
 * names, per model route. Older rows that predate the bracketed cause are
 * classified from the same message, by the same function the worker uses.
 */
export async function diagnose(since: string, now = Date.now()): Promise<Diagnosis> {
  const db = getDb();
  const failures = await db.all<{ reason: string | null }>(
    `SELECT reason FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND outcome <> 'SUBMITTED'
        AND reason LIKE '%model call failed%'
      ORDER BY at DESC LIMIT ?`,
    [since, FAILURE_SAMPLE + 1],
  );
  const submitted = await db.all<{ reason: string | null; k: number | string }>(
    `SELECT reason, COUNT(*) AS k FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND outcome = 'SUBMITTED'
      GROUP BY reason`,
    [since],
  );
  const sampled = failures.length > FAILURE_SAMPLE;
  const routes = new Map<string, RouteReading>();
  const route = (model: string): RouteReading => {
    let r = routes.get(model);
    if (!r) routes.set(model, (r = { model, submitted: 0, failed: 0, failuresByCause: {} }));
    return r;
  };
  for (const row of submitted) route(modelOf(row.reason) ?? 'unknown').submitted += n(row.k);
  const byCause: Partial<Record<RouteFailureCause, number>> = {};
  for (const row of failures.slice(0, FAILURE_SAMPLE)) {
    const reason = row.reason ?? '';
    const bracket = /model call failed \[([^\]]+)\]/.exec(reason)?.[1] as RouteFailureCause | undefined;
    const cause = bracket ?? classifyRouteFailure(reason);
    byCause[cause] = (byCause[cause] ?? 0) + 1;
    const r = route(modelOf(reason) ?? 'unknown');
    r.failed += 1;
    r.failuresByCause[cause] = (r.failuresByCause[cause] ?? 0) + 1;
  }
  const total = Object.values(byCause).reduce((sum, k) => sum + (k ?? 0), 0);
  const top = (Object.entries(byCause) as [RouteFailureCause, number][]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const cause = top ? top[0] : null;
  let model: string | null = null;
  if (cause) {
    const carriers = [...routes.values()]
      .map((r) => ({ model: r.model, k: r.failuresByCause[cause] ?? 0 }))
      .sort((a, b) => b.k - a.k || a.model.localeCompare(b.model));
    // A route is named only when it carries most of that cause's failures.
    if (carriers[0] && carriers[0].k * 2 > (byCause[cause] ?? 0)) model = carriers[0].model;
  }
  return {
    cause,
    model,
    failures: total,
    failuresByCause: byCause,
    routes: [...routes.values()].sort((a, b) => b.failed - a.failed || a.model.localeCompare(b.model)),
    heldRoutes: routeHealthReadings(now),
    sampled,
  };
}

/**
 * Compare queued work and accepted submissions with the previous recorded
 * reading: the observation that restoring a route actually moved the queue.
 */
export async function readAdvance(queued: number, nowMs = Date.now()): Promise<Advance> {
  const db = getDb();
  const previous = await db.get<{ at: string; measures: unknown }>(
    `SELECT at, measures FROM bin_events
      WHERE event_type = ? AND outcome = 'MEASURED' AND at < ?
      ORDER BY at DESC LIMIT 1`,
    [STAGE_CAPACITY_EVENT, new Date(nowMs).toISOString()],
  );
  if (!previous) {
    return { verdict: 'NO_PRIOR_READING', previousAt: null, previousQueued: null, queuedNow: queued, acceptedSincePrevious: null, basis: 'first recorded reading; the next one says whether queued work advanced' };
  }
  let measures: Record<string, unknown> = {};
  try {
    measures = (typeof previous.measures === 'string' ? JSON.parse(previous.measures) : previous.measures ?? {}) as Record<string, unknown>;
  } catch {
    measures = {};
  }
  const previousQueued = typeof measures.queuedNow === 'number' ? measures.queuedNow : null;
  const since = await db.get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ? AND at < ?",
    [previous.at, new Date(nowMs).toISOString()],
  );
  const accepted = n(since?.k);
  const verdict: Advance['verdict'] = accepted > 0 ? 'ADVANCING' : queued > 0 || (previousQueued ?? 0) > 0 ? 'STALLED' : 'IDLE';
  const moved = previousQueued === null ? '' : `, queue ${previousQueued} → ${queued}`;
  return {
    verdict,
    previousAt: previous.at,
    previousQueued,
    queuedNow: queued,
    acceptedSincePrevious: accepted,
    basis: `${accepted} accepted since ${previous.at}${moved}`,
  };
}

/** The per-stage, per-purpose measurement for the last `hours` hours (default 6). */
export async function stageCapacity(options: { hours?: number; now?: number } = {}): Promise<StageCapacityReport> {
  const hours = options.hours && options.hours > 0 ? options.hours : 6;
  const nowMs = options.now ?? Date.now();
  const since = new Date(nowMs - hours * 3_600_000).toISOString();
  const stages: StageReading[] = [];
  for (const def of STAGES) stages.push(await readStage(def, since, hours, nowMs));
  const diagnosis = await diagnose(since, nowMs);
  const purposes = await readPurposes(since);
  const totalProductiveJobs = purposes.reduce((sum, p) => sum + p.productiveJobs, 0);
  const total = await getDb().get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?",
    [since],
  );
  return {
    windowHours: hours,
    since,
    diagnosis,
    stages,
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    process: readProcess(),
    constrained: chooseConstraint(stages, diagnosis),
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
export async function recordStageCapacity(options: { hours?: number; now?: number } = {}): Promise<(StageCapacityReport & { advance: Advance }) | null> {
  const started = Date.now();
  try {
    const report = await stageCapacity(options);
    const waiting = await queuedNow();
    const advance = await readAdvance(waiting, options.now ?? Date.now());
    const cause = report.diagnosis.cause
      ? `cause ${report.diagnosis.cause}${report.diagnosis.model ? ` on ${report.diagnosis.model}` : ''} (${report.diagnosis.failures} model-call failures)`
      : 'no model-call failures';
    await recordBinEvent({
      eventType: STAGE_CAPACITY_EVENT,
      outcome: 'MEASURED',
      reason: `${advance.verdict}: ${advance.basis}; ${cause}; ${report.constrained.basis}`,
      durationMs: Date.now() - started,
      evidenceClass: 'MEASURED',
      measures: { ...report, queuedNow: waiting, advance } as unknown as Record<string, unknown>,
    });
    return { ...report, advance };
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
