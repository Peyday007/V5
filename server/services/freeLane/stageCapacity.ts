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
  /** Each failing model route in the window, with the cause its own errors name. */
  routeCauses: RouteCauseReading[];
  /** The cause most failures in the window were recorded under, on a route that has not answered since. */
  primaryCause: { model: string; cause: string; failures: number } | null;
  constrained: Constraint;
}

/**
 * One model route's failures in the window, read from the cause `worker.ts`
 * writes into each failed item's reason (`model call failed [cause]: …`).
 * `restored` is true when the route submitted an accepted item after its last
 * failure: the route is working again on the rows, not only in memory.
 */
export interface RouteCauseReading {
  model: string;
  cause: string;
  failures: number;
  lastFailureAt: string;
  lastSubmittedAt: string | null;
  restored: boolean;
}

/**
 * Whether existing queued work advanced since the previous recorded reading.
 * `STALLED` is work waiting at both readings with nothing accepted between them;
 * `ADVANCING` is at least one accepted item since; `IDLE` is nothing waiting;
 * `FIRST_READING` is no earlier reading to compare with.
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
export function chooseConstraint(stages: StageReading[], cause: StageCapacityReport['primaryCause'] = null): Constraint {
  const first = cause
    ? `Restore model route ${cause.model} first: ${cause.failures} failures in the window name ${cause.cause} as the cause. `
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

/**
 * Reads the model and the cause out of a failed `FREE_LANE_ITEM` reason, as
 * worker.ts writes it: `model <m>: model call failed [<cause>]: <detail>`.
 * A reason in any other shape names no cause and returns null.
 */
export function parseFailureCause(reason: string | null): { model: string; cause: string } | null {
  const match = /^model (\S+): model call failed \[([^\]]+)\]/.exec(reason ?? '');
  return match ? { model: match[1]!, cause: match[2]! } : null;
}

/** Failing routes and their causes in the window, from the rows. */
export async function readRouteCauses(since: string): Promise<RouteCauseReading[]> {
  const db = getDb();
  const failed = await db.all<{ reason: string | null; at: string }>(
    `SELECT reason, at FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND reason LIKE '%model call failed [%'`,
    [since],
  );
  const submitted = await db.all<{ reason: string | null; last: string | null }>(
    `SELECT reason, MAX(at) AS last FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ?
      GROUP BY reason`,
    [since],
  );
  const lastOk = new Map<string, string>();
  for (const row of submitted) {
    const model = /^model (\S+)$/.exec(row.reason ?? '')?.[1];
    if (model && row.last) lastOk.set(model, row.last);
  }
  const byKey = new Map<string, RouteCauseReading>();
  for (const row of failed) {
    const parsed = parseFailureCause(row.reason);
    if (!parsed) continue;
    const key = `${parsed.model}\u0000${parsed.cause}`;
    const entry = byKey.get(key) ?? {
      model: parsed.model,
      cause: parsed.cause,
      failures: 0,
      lastFailureAt: row.at,
      lastSubmittedAt: lastOk.get(parsed.model) ?? null,
      restored: false,
    };
    entry.failures += 1;
    if (row.at > entry.lastFailureAt) entry.lastFailureAt = row.at;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((entry) => ({ ...entry, restored: entry.lastSubmittedAt !== null && entry.lastSubmittedAt > entry.lastFailureAt }))
    .sort((a, b) => b.failures - a.failures || a.model.localeCompare(b.model) || a.cause.localeCompare(b.cause));
}

/** The cause behind most failures on a route that has not answered since; null when none is failing. */
export function primaryCause(routes: readonly RouteCauseReading[]): StageCapacityReport['primaryCause'] {
  const open = routes.filter((route) => !route.restored);
  const top = open[0];
  return top ? { model: top.model, cause: top.cause, failures: top.failures } : null;
}

/** Compares the queue and accepted work with the previous recorded reading. */
export async function readQueueAdvance(queuedNowCount: number): Promise<QueueAdvance> {
  const db = getDb();
  const previous = await db.get<{ at: string; measures: string | null }>(
    `SELECT at, measures FROM bin_events
      WHERE event_type = ? AND outcome = 'MEASURED'
      ORDER BY at DESC LIMIT 1`,
    [STAGE_CAPACITY_EVENT],
  );
  if (!previous) {
    return { verdict: queuedNowCount > 0 ? 'FIRST_READING' : 'IDLE', previousAt: null, previousQueued: null, queuedNow: queuedNowCount, acceptedSincePrevious: null };
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
  const verdict: QueueAdvance['verdict'] =
    acceptedSincePrevious > 0 ? 'ADVANCING' : queuedNowCount > 0 || (previousQueued ?? 0) > 0 ? 'STALLED' : 'IDLE';
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
  const routeCauses = await readRouteCauses(since);
  const cause = primaryCause(routeCauses);
  return {
    windowHours: hours,
    since,
    stages,
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    process: readProcess(),
    routeCauses,
    primaryCause: cause,
    constrained: chooseConstraint(stages, cause),
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
    // The in-process route health (which routes are held right now), alongside the rows' view of the window.
    const { routeHealthSnapshot } = await import('./worker.ts');
    const cause = report.primaryCause
      ? ` Cause: ${report.primaryCause.cause} on ${report.primaryCause.model} (${report.primaryCause.failures} failures).`
      : ' No failing model route in the window.';
    await recordBinEvent({
      eventType: STAGE_CAPACITY_EVENT,
      outcome: 'MEASURED',
      reason: `${report.constrained.basis}${cause} Queue ${advance.verdict.toLowerCase()}.`,
      durationMs: Date.now() - started,
      evidenceClass: 'MEASURED',
      measures: { ...report, queuedNow: waiting, queueAdvance: advance, heldRoutes: routeHealthSnapshot() } as unknown as Record<string, unknown>,
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
