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
import { classifyRouteFailure, ROUTE_STATE_EVENT, type RouteFailureCause } from './worker.ts';

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

/** One model route's standing in the window, read from its own item rows. */
export interface RouteDiagnosis {
  model: string;
  /** Model-call failures, by the cause their own error names (database pressure excluded). */
  failures: number;
  causes: Partial<Record<RouteFailureCause, number>>;
  dominantCause: RouteFailureCause | null;
  submitted: number;
  lastFailureAt: string | null;
  lastSubmittedAt: string | null;
  /** Route standing changes the worker recorded (`FREE_LANE_ROUTE`). */
  held: number;
  restored: number;
  /**
   * FAILING: its latest item was a model-call failure. RESTORED: it failed in the
   * window and its latest item was accepted. HEALTHY: accepted, no model-call failure.
   */
  status: 'FAILING' | 'RESTORED' | 'HEALTHY' | 'IDLE';
}

/** Whether queued work advanced since the previous recorded reading. */
export interface QueueAdvance {
  previousAt: string;
  previousQueued: number;
  queuedNow: number;
  submittedSince: number;
  advancing: boolean;
}

/**
 * The first remedial action of CAP-16-3, measured: which cause is failing model
 * throughput, what restores it, and whether queued work advanced afterwards.
 */
export interface ThroughputRestoration {
  routes: RouteDiagnosis[];
  /** The cause behind the failing routes, the most frequent one; null when none fails. */
  cause: RouteFailureCause | null;
  action: string;
  queue: Measured<QueueAdvance>;
  verdict: 'RESTORED' | 'FAILING' | 'NOT_ADVANCING' | 'NO_FAILURE_SEEN';
  basis: string;
}

export interface StageCapacityReport {
  windowHours: number;
  since: string;
  stages: StageReading[];
  purposes: PurposeAttribution[];
  totalProductiveJobs: number;
  purposesSumToTotal: boolean;
  process: ProcessReading;
  queuedNow: number;
  throughput: ThroughputRestoration;
  constrained: Constraint;
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
export function chooseConstraint(stages: StageReading[], throughput?: ThroughputRestoration): Constraint {
  const general =
    'Restore the failing provider, credential, route or verification path first and watch whether queued work advances; ' +
    'scale independent workers only after a measured gain. Do not enlarge the web process because a queue is long.';
  const recommendation =
    throughput && (throughput.verdict === 'FAILING' || throughput.verdict === 'NOT_ADVANCING')
      ? `${throughput.basis} ${throughput.action} ${general}`
      : general;
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

/** What restores a route failing for each cause. Data, not a whitelist: an unnamed cause gets the last entry. */
export const RESTORE_ACTION: Record<RouteFailureCause, string> = {
  credentials: 'The provider refused the credential: the route stays held and other models take its work until the credential is replaced by whoever holds it.',
  'task routing': 'The provider does not serve the requested model: correct the route or model name; the route stays held meanwhile.',
  'broken GPU': 'The GPU host is failing: the route stays held, other models take its work, and one item re-probes it every interval.',
  'provider availability': 'The provider is busy or unreachable: items back off and one re-probes the route every interval.',
  database: 'Brain\'s own database was busy; this is not a model-route failure.',
  unclassified: 'The failure names no known cause: read the recorded reasons for the route before changing capacity.',
};

const ROUTE_REASON = /^model (.+?)(?:: ([\s\S]*))?$/;
const CAUSE_TAG = /model call failed \[([^\]]+)\]/;

/** Reads each route's failures by cause and its latest standing from the lane's own item rows. */
async function readRoutes(since: string, nowIso: string): Promise<RouteDiagnosis[]> {
  const db = getDb();
  const rows = await db.all<{ outcome: string | null; reason: string | null; at: string }>(
    `SELECT outcome, reason, at FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at <= ?
        AND (outcome = 'SUBMITTED' OR reason LIKE '%model call failed%')
      ORDER BY at`,
    [since, nowIso],
  );
  const states = await db.all<{ outcome: string | null; measures: string | null }>(
    `SELECT outcome, measures FROM bin_events WHERE event_type = ? AND at >= ? AND at <= ?`,
    [ROUTE_STATE_EVENT, since, nowIso],
  );
  const routes = new Map<string, RouteDiagnosis & { last: 'ok' | 'fail' | null }>();
  const route = (model: string) => {
    let r = routes.get(model);
    if (!r) {
      r = { model, failures: 0, causes: {}, dominantCause: null, submitted: 0, lastFailureAt: null, lastSubmittedAt: null, held: 0, restored: 0, status: 'IDLE', last: null };
      routes.set(model, r);
    }
    return r;
  };
  for (const row of rows) {
    const match = ROUTE_REASON.exec(row.reason ?? '');
    if (!match) continue;
    const r = route(match[1]!);
    if (row.outcome === 'SUBMITTED') {
      r.submitted += 1;
      r.lastSubmittedAt = row.at;
      r.last = 'ok';
      continue;
    }
    const why = match[2] ?? '';
    const tagged = CAUSE_TAG.exec(why)?.[1] as RouteFailureCause | undefined;
    const cause = tagged && tagged in RESTORE_ACTION ? tagged : classifyRouteFailure(why);
    if (cause === 'database') continue;
    r.failures += 1;
    r.causes[cause] = (r.causes[cause] ?? 0) + 1;
    r.lastFailureAt = row.at;
    r.last = 'fail';
  }
  for (const row of states) {
    let model: unknown;
    try {
      model = (JSON.parse(row.measures ?? '{}') as { model?: unknown }).model;
    } catch {
      continue;
    }
    if (typeof model !== 'string') continue;
    const r = route(model);
    if (row.outcome === 'HELD') r.held += 1;
    if (row.outcome === 'RESTORED') r.restored += 1;
  }
  return [...routes.values()]
    .map(({ last, ...r }) => {
      const ranked = (Object.entries(r.causes) as [RouteFailureCause, number][]).sort((a, b) => b[1] - a[1]);
      const status: RouteDiagnosis['status'] =
        last === 'fail' ? 'FAILING' : last === 'ok' ? (r.failures > 0 ? 'RESTORED' : 'HEALTHY') : 'IDLE';
      return { ...r, dominantCause: ranked[0]?.[0] ?? null, status };
    })
    .sort((a, b) => b.failures - a.failures || a.model.localeCompare(b.model));
}

/** Queued work since the previous recorded reading: did items leave the queue as accepted work? */
async function readQueueAdvance(nowIso: string, queuedNow: number): Promise<Measured<QueueAdvance>> {
  const db = getDb();
  const previous = await db.get<{ at: string; measures: string | null }>(
    `SELECT at, measures FROM bin_events WHERE event_type = ? AND outcome = 'MEASURED' AND at < ? ORDER BY at DESC LIMIT 1`,
    [STAGE_CAPACITY_EVENT, nowIso],
  );
  if (!previous) return NOT('no earlier stage-capacity reading to compare with');
  let previousQueued: unknown;
  try {
    previousQueued = (JSON.parse(previous.measures ?? '{}') as { queuedNow?: unknown }).queuedNow;
  } catch {
    previousQueued = undefined;
  }
  if (typeof previousQueued !== 'number') return NOT('the earlier reading recorded no queue size');
  const since = await db.get<{ k: number | string }>(
    "SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at > ? AND at <= ?",
    [previous.at, nowIso],
  );
  const submittedSince = n(since?.k);
  return ok({ previousAt: previous.at, previousQueued, queuedNow, submittedSince, advancing: submittedSince > 0 || (previousQueued === 0 && queuedNow === 0) });
}

/** Names the cause of failing model throughput and whether restoring it moved queued work. Exported for tests. */
export function judgeThroughput(routes: RouteDiagnosis[], queue: Measured<QueueAdvance>): ThroughputRestoration {
  const failing = routes.filter((r) => r.status === 'FAILING');
  const tally = new Map<RouteFailureCause, number>();
  for (const r of failing) for (const [cause, k] of Object.entries(r.causes) as [RouteFailureCause, number][]) tally.set(cause, (tally.get(cause) ?? 0) + k);
  const cause = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const recovered = routes.filter((r) => r.status === 'RESTORED');
  const queueText = queue.measured
    ? `${queue.value.submittedSince} accepted since ${queue.value.previousAt}; ${queue.value.previousQueued} → ${queue.value.queuedNow} queued.`
    : `Queue advance not measured: ${queue.reason}.`;
  if (failing.length > 0) {
    const names = failing.map((r) => `${r.model} (${r.dominantCause ?? 'unclassified'}, ${r.failures} failures)`).join(', ');
    return { routes, cause, action: RESTORE_ACTION[cause ?? 'unclassified'], queue, verdict: 'FAILING', basis: `Failing model routes: ${names}. ${queueText}` };
  }
  if (queue.measured && !queue.value.advancing) {
    return {
      routes, cause: null, queue, verdict: 'NOT_ADVANCING',
      action: 'No model route is failing, yet no queued item was accepted: look at admission, routing and verification before capacity.',
      basis: `No route failing but queued work did not advance. ${queueText}`,
    };
  }
  if (recovered.length > 0) {
    const names = recovered.map((r) => `${r.model} (was ${r.dominantCause ?? 'unclassified'})`).join(', ');
    return { routes, cause: null, queue, verdict: 'RESTORED', action: 'Throughput restored; keep measuring before any scale-up.', basis: `Routes answering again: ${names}. ${queueText}` };
  }
  return { routes, cause: null, queue, verdict: 'NO_FAILURE_SEEN', action: 'No model-call failure in the window.', basis: `No model-call failure in the window. ${queueText}` };
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
  const nowIso = new Date(nowMs).toISOString();
  const waiting = await queuedNow();
  const throughput = judgeThroughput(await readRoutes(since, nowIso), await readQueueAdvance(nowIso, waiting));
  return {
    windowHours: hours,
    since,
    stages,
    purposes,
    totalProductiveJobs,
    purposesSumToTotal: totalProductiveJobs === n(total?.k),
    process: readProcess(),
    queuedNow: waiting,
    throughput,
    constrained: chooseConstraint(stages, throughput),
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
    await recordBinEvent({
      eventType: STAGE_CAPACITY_EVENT,
      outcome: 'MEASURED',
      // The throughput verdict leads: it is the first remedial action, before any scale-up.
      reason: `${report.throughput.verdict}: ${report.throughput.basis} | ${report.constrained.basis}`,
      durationMs: Date.now() - started,
      evidenceClass: 'MEASURED',
      measures: report as unknown as Record<string, unknown>,
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
