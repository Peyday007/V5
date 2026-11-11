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
import { classifyLaneEvent } from './worker.ts';

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
  /** Answers the model returned that Brain refused. Never an outage: the work was not judged. */
  droppedOrDuplicate: Measured<number>;
  modelCallsAvoided: Measured<number>;
  /** Model or provider failures: a release, a failed or empty model call. */
  providerFailures: Measured<number>;
  /** Items handed back because Brain's own database was unavailable — neither dropped nor a provider's fault. */
  brainUnavailable: Measured<number>;
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
  constrained: Constraint;
}

const n = (value: unknown): number => Number(value ?? 0) || 0;
const NOT = (reason: string): { measured: false; reason: string } => ({ measured: false, reason });
const ok = <T>(value: T): { measured: true; value: T } => ({ measured: true, value });
const placeholders = (items: readonly unknown[]): string => items.map(() => '?').join(', ');

export interface EventTally {
  total: number;
  accepted: number;
  dropped: number;
  providerFailures: number;
  brainUnavailable: number;
  ms: number;
}

/**
 * Lane events counted into disjoint measures; `accepted + dropped +
 * providerFailures + brainUnavailable === total` always. Pure, exported for tests.
 */
export function tallyEvents(
  rows: readonly { outcome: string | null; reason: string | null; k: number | string; ms?: number | string | null }[],
): EventTally {
  const t: EventTally = { total: 0, accepted: 0, dropped: 0, providerFailures: 0, brainUnavailable: 0, ms: 0 };
  for (const row of rows) {
    const k = n(row.k);
    t.total += k;
    t.ms += n(row.ms);
    const cls = classifyLaneEvent(row.outcome, row.reason);
    if (cls === 'ACCEPTED') t.accepted += k;
    else if (cls === 'PROVIDER_FAILURE') t.providerFailures += k;
    else if (cls === 'BRAIN_UNAVAILABLE') t.brainUnavailable += k;
    else t.dropped += k;
  }
  return t;
}

/** Per-stage reading from the rows. */
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
    brainUnavailable: NOT(reason),
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
  const events = await db.all<{ outcome: string | null; reason: string | null; k: number | string; ms: number | string | null }>(
    `SELECT outcome, reason, COUNT(*) AS k, SUM(duration_ms) AS ms
       FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND workload_class IN (${placeholders(types)})
      GROUP BY outcome, reason`,
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

  const tally = tallyEvents(events);
  const { total, accepted, ms } = tally;
  const oldest = queued?.oldest ? Math.max(0, Math.round((nowMs - Date.parse(queued.oldest)) / 60_000)) : null;
  return {
    stage: def.id,
    label: def.label,
    queueSize: ok(n(queued?.n)),
    oldestUsefulItemMinutes: ok(oldest),
    itemsProcessedPerHour: ok(total / hours),
    uniqueUsableFacts: ok(n(facts?.n)),
    // Only refused answers: an outage or a busy Brain is counted below, never here.
    droppedOrDuplicate: ok(tally.dropped),
    modelCallsAvoided: NOT('model calls avoided are not recorded'),
    providerFailures: ok(tally.providerFailures),
    brainUnavailable: ok(tally.brainUnavailable),
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
