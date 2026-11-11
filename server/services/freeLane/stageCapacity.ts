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
import { classifyRouteFailure, type RouteFailureCause } from './worker.ts';

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

/**
 * One model route's standing in the window, read from its FREE_LANE_ITEM rows.
 * `restored` is true only when the route answered after its last model-call
 * failure, so a route is never called restored because its failures stopped
 * being counted or because nothing was sent to it.
 */
export interface RouteReading {
  model: string;
  submitted: number;
  modelCallFailures: number;
  /** Model-call failures by the cause the route's own error named. */
  causes: Partial<Record<RouteFailureCause, number>>;
  lastFailureAt: string | null;
  lastSubmittedAt: string | null;
  standing: 'HEALTHY' | 'RESTORED' | 'FAILING' | 'IDLE';
}

/** Whether queued work moved: answered items in the window's last hour against what waits now. */
export interface QueueAdvance {
  queuedNow: number;
  submittedLastHour: number;
  advancing: boolean;
}

export interface StageCapacityReport {
  windowHours: number;
  since: string;
  stages: StageReading[];
  routes: RouteReading[];
  queue: QueueAdvance;
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
export function chooseConstraint(stages: StageReading[]): Constraint {
  const recommendation =
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
      basis: 'No measured stage has work waiting, so none is shown to be constraining.',
      expectedGain: NOT('no constrained stage'),
      recommendation,
    };
  }
  const { stage } = worst;
  return {
    stage: stage.stage,
    basis: `${stage.label}: ${worst.waiting} waiting, ${Math.round(worst.rate * 100)}% of processed items accepted.`,
    // Dollars per job are not recorded, so a gain per dollar cannot be claimed.
    expectedGain: NOT('accepted facts per hour per dollar needs a recorded dollar cost, which the lane does not keep'),
    recommendation,
  };
}

export interface RouteEventRow {
  at: string;
  outcome: string | null;
  reason: string | null;
  measures: string | null;
}

const parseMeasures = (raw: string | null): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Per-route standing from FREE_LANE_ITEM rows. The structured `measures.route`
 * written since route health was recorded is preferred; an older row is read
 * from the reason the worker has always written (`model <name>: <why>`), so the
 * history already on production answers too. Exported for tests.
 */
export function summarizeRoutes(rows: readonly RouteEventRow[]): RouteReading[] {
  const routes = new Map<string, RouteReading>();
  for (const row of rows) {
    const route = parseMeasures(row.measures).route as { model?: unknown; cause?: unknown } | undefined;
    const fromReason = /^model (\S+?):? /.exec(`${row.reason ?? ''} `);
    const model = typeof route?.model === 'string' ? route.model : fromReason?.[1];
    if (!model) continue;
    const reading = routes.get(model) ?? {
      model, submitted: 0, modelCallFailures: 0, causes: {}, lastFailureAt: null, lastSubmittedAt: null, standing: 'IDLE' as const,
    };
    if (row.outcome === 'SUBMITTED') {
      reading.submitted += 1;
      if (!reading.lastSubmittedAt || row.at > reading.lastSubmittedAt) reading.lastSubmittedAt = row.at;
    } else if ((row.reason ?? '').includes('model call failed')) {
      const cause: RouteFailureCause =
        typeof route?.cause === 'string' ? (route.cause as RouteFailureCause) : classifyRouteFailure(row.reason ?? '');
      reading.modelCallFailures += 1;
      reading.causes[cause] = (reading.causes[cause] ?? 0) + 1;
      if (!reading.lastFailureAt || row.at > reading.lastFailureAt) reading.lastFailureAt = row.at;
    }
    routes.set(model, reading);
  }
  for (const reading of routes.values()) {
    if (!reading.lastFailureAt) reading.standing = reading.submitted > 0 ? 'HEALTHY' : 'IDLE';
    else if (reading.lastSubmittedAt && reading.lastSubmittedAt > reading.lastFailureAt) reading.standing = 'RESTORED';
    else reading.standing = 'FAILING';
  }
  return [...routes.values()].sort((a, b) => b.modelCallFailures - a.modelCallFailures || a.model.localeCompare(b.model));
}

async function readRoutes(since: string): Promise<RouteReading[]> {
  const rows = await getDb().all<RouteEventRow>(
    `SELECT at, outcome, reason, measures FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ?`,
    [since],
  );
  return summarizeRoutes(rows);
}

async function readQueueAdvance(nowMs: number): Promise<QueueAdvance> {
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();
  const row = await getDb().get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?",
    [hourAgo],
  );
  const queued = await queuedNow();
  const submittedLastHour = n(row?.k);
  return { queuedNow: queued, submittedLastHour, advancing: submittedLastHour > 0 };
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
  return {
    windowHours: hours,
    since,
    stages,
    routes: await readRoutes(since),
    queue: await readQueueAdvance(nowMs),
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    process: readProcess(),
    constrained: chooseConstraint(stages),
  };
}

/** Jobs queued and claimable now, across every stage the lane answers. */
export async function queuedNow(): Promise<number> {
  return waitingNow({ includeImprovement: false });
}
