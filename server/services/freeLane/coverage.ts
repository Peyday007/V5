/**
 * Whether displaced work has a worker that is actually doing it (§85).
 *
 * Brain-only mode (§84) displaced every non-Brain bin from Claude routines and
 * named a replacement — "the free lane" — that did not exist as a worker. The
 * work parked as WAITING_FOR_FREE_LANE and nothing noticed. So a restriction is
 * now asked, before it goes live and on every tick after:
 *
 *   1. what work it displaces (queued items by type, under free-lane bins);
 *   2. whether a replacement is configured and supports each of those types;
 *   3. whether that replacement has completed real work recently — an accepted
 *      submission, not a dispatch;
 *   4. whether the packet runner consumed it (the next stage was queued).
 *
 * `setBrainOnlyMode(true)` refuses to switch when the answer is no, keeping the
 * previous route; while it is on, the watchdog records an intervention when
 * displaced work waits with no replacement progress (reusing
 * `engineering_interventions`, rule 9).
 */
import { getDb } from '../../db/database.ts';
import { recordIntervention } from '../../repos/engineering.ts';
import { laneConfig } from '../cheap/lane.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { redactCredentials } from '../effects/failureDetail.ts';
import { failureClass } from '../goals/researchYield.ts';
import { FREE_LANE_WORK_TYPES, answerRows, answerTally, isFailing, routeHold } from './worker.ts';
import { readStageCapacity, recordedCause, stageCapacityLines, type RecordedStageCapacity } from './stageCapacity.ts';

export interface LaneCoverage {
  configured: boolean;
  models: number;
  displaced: Record<string, number>;
  unsupported: Record<string, number>;
  submittedLastHour: number;
  failedLastHour: number;
  lastSubmittedAt: string | null;
  /**
   * Items the packet runner queued after a free-lane submission, in the last
   * day. Null unless the caller asked for it (`{ consumption: true }`): only
   * `admin free-lane show` prints it, and on production the count took 48-82 s
   * a read (2026-11-15) while the dispatch tick's per-minute coverage watch
   * awaited it, so every tick that minute was skipped.
   */
  consumedLastDay: number | null;
  ready: boolean;
  reason: string;
}

const OWNED_BY_FREE_LANE_BIN = `EXISTS (SELECT 1 FROM bins b
   WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
     AND b.purpose IN ('PLAY_RESEARCH', 'GRUNT'))`;

export async function laneCoverage(
  now = new Date(),
  options: { consumption?: boolean } = {},
): Promise<LaneCoverage> {
  const db = getDb();
  const config = laneConfig();
  const displacedRows = await db.all<{ work_type: string; n: number | string }>(
    `SELECT w.work_type, COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND ${OWNED_BY_FREE_LANE_BIN}
      GROUP BY w.work_type`,
    [],
  );
  const displaced: Record<string, number> = {};
  const unsupported: Record<string, number> = {};
  for (const row of displacedRows) {
    displaced[row.work_type] = Number(row.n);
    if (!(FREE_LANE_WORK_TYPES as readonly string[]).includes(row.work_type)) unsupported[row.work_type] = Number(row.n);
  }
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const outcomes = await db.all<{ outcome: string; n: number | string; last: string | null }>(
    `SELECT outcome, COUNT(*) AS n, MAX(at) AS last FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY outcome`,
    [hourAgo],
  );
  const submitted = outcomes.find((o) => o.outcome === 'SUBMITTED');
  const failed = outcomes.find((o) => o.outcome === 'FAILED_RETRYABLE');
  const last = await db.get<{ last: string | null }>(
    "SELECT MAX(at) AS last FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED'",
    [],
  );
  // Consumption: research items the runner queued for a packet after the free lane submitted in it.
  const consumed = !options.consumption ? null : await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.created_at >= ? AND w.orchestration_id IN (
        SELECT DISTINCT wi.orchestration_id FROM work_items wi
          JOIN bin_events e ON e.work_item_id = wi.id
         WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?)
        AND w.created_at > (SELECT MIN(e2.at) FROM bin_events e2
                             JOIN work_items w2 ON w2.id = e2.work_item_id
                            WHERE e2.event_type = 'FREE_LANE_ITEM' AND e2.outcome = 'SUBMITTED'
                              AND w2.orchestration_id = w.orchestration_id)`,
    [dayAgo, dayAgo],
  );
  const coverage: LaneCoverage = {
    configured: config !== null,
    models: config?.models.length ?? 0,
    displaced,
    unsupported,
    submittedLastHour: Number(submitted?.n ?? 0),
    failedLastHour: Number(failed?.n ?? 0),
    lastSubmittedAt: last?.last ?? null,
    consumedLastDay: options.consumption ? Number(consumed?.n ?? 0) : null,
    ready: false,
    reason: '',
  };
  const waiting = Object.values(displaced).reduce((a, b) => a + b, 0);
  if (waiting === 0) {
    coverage.ready = true;
    coverage.reason = 'Nothing is displaced.';
  } else if (!coverage.configured) {
    coverage.reason = 'No free model is configured (BRAIN_CHEAP_LLM_URL), so displaced research has no worker.';
  } else if (Object.keys(unsupported).length > 0) {
    coverage.reason = `The free lane does not answer ${Object.keys(unsupported).join(', ')}.`;
  } else if (waiting > 0 && coverage.failedLastHour > 0 && coverage.submittedLastHour === 0) {
    coverage.reason = `${waiting} displaced item(s) are waiting and the free lane failed every item it took in the last hour.`;
  } else {
    coverage.ready = true;
    coverage.reason = `${waiting} displaced item(s); the free lane submitted ${coverage.submittedLastHour} in the last hour.`;
  }
  if (!coverage.ready) {
    // CAP-16-3: the hourly stage-capacity reading names the failing route; a refusal carries it.
    const cause = recordedCause(await readStageCapacity(now.getTime()).catch(() => null));
    if (cause) coverage.reason = `${coverage.reason} ${cause}`;
  }
  return coverage;
}

const RECORD_WINDOW_MS = 30 * 60_000;
const STALE_MS = 30 * 60_000;

/**
 * The monitor: displaced research has waited past the window with no free-lane
 * submission in it. Recorded at most once per window, never notifies a person.
 */
export async function watchDisplacedWork(now = new Date()): Promise<{ stranded: boolean; reason: string }> {
  const coverage = await laneCoverage(now);
  const waiting = Object.values(coverage.displaced).reduce((a, b) => a + b, 0);
  const oldest = await getDb().get<{ at: string | null }>(
    `SELECT MIN(w.available_at) AS at FROM work_items w WHERE w.state = 'QUEUED' AND ${OWNED_BY_FREE_LANE_BIN}`,
    [],
  );
  const staleSince = new Date(now.getTime() - STALE_MS).toISOString();
  const stranded =
    waiting > 0 &&
    (oldest?.at ?? now.toISOString()) < staleSince &&
    (!coverage.ready || coverage.lastSubmittedAt === null || coverage.lastSubmittedAt < staleSince);
  if (!stranded) return { stranded, reason: coverage.reason };
  const since = new Date(now.getTime() - RECORD_WINDOW_MS).toISOString();
  const recent = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE actor_id = 'free-lane:coverage' AND created_at > ?",
    [since],
  );
  if (Number(recent?.n ?? 0) === 0) {
    await recordIntervention({
      kind: 'IDLE_WITH_EXECUTABLE_WORK',
      rule: 'RULE_9_KEEP_CAPACITY_FED',
      attemptedAction: `Displaced research is not progressing: ${waiting} item(s) waiting. ${coverage.reason}`,
      replacementAction: 'free-lane tick; a failing model is skipped and its role routed to the other model',
      actorType: 'BRAIN',
      actorId: 'free-lane:coverage',
    });
  }
  return { stranded, reason: coverage.reason };
}

/* ------------------------------------------------------------------------- */
/* A model whose answers stopped being usable                                  */
/* ------------------------------------------------------------------------- */

/**
 * A sustained drop in useful output for one (model, kind of work), read from
 * the lane's own rows. Production, 2026-11-16 18:05–19:04Z: gpt-oss-120b's
 * fragment answers listed "0 claim(s)" 28 times, `unfitPairs` held it back,
 * brain-a's route was held on HTTP 429s, and 33 fragments waited with nothing
 * running for an hour while nothing anywhere said so. #992 lets the held model
 * take the work when nobody else can; this says that it happened, why, and
 * whether any model still functions for the kind.
 *
 * The bar is `unfitPairs`' own (`isFailing` over the same day of answers), so
 * the incident and the routing can never disagree about which model failed.
 * `model` is `*` when every route for a kind is held and no model's answers
 * were the problem: the work then has no functioning model either.
 */
export interface ModelOutputIncident {
  /** Stable for the condition, never for its counts: what dedupes the record. */
  key: string;
  model: string;
  workType: string;
  accepted: number;
  rejected: number;
  /** Queued items of this kind under free-lane bins. */
  waiting: number;
  /** No model can take the kind now: every one is failing it or its route is held. */
  noFunctioningModel: boolean;
  /** Why the rejected answers were refused, ids and counts stripped, most frequent first. */
  reasons: { reason: string; n: number }[];
  /** The most frequent refusal as recorded (what the model sent), credentials removed. */
  sample: string | null;
  /** Each other model's state for the kind: failing, route held, or able. */
  others: { model: string; state: string }[];
}

/** Incidents from rows and route holds. Pure. */
export function modelOutputIncidents(input: {
  rows: Parameters<typeof answerTally>[0];
  models: readonly string[];
  waiting: Readonly<Record<string, number>>;
  hold: (model: string) => string | null;
}): ModelOutputIncident[] {
  const tally = answerTally(input.rows);
  const failing = (model: string, type: string): boolean => {
    const e = tally.get(`${model}|${type}`);
    return !!e && isFailing(e);
  };
  const able = (model: string, type: string): boolean => !failing(model, type) && input.hold(model) === null;
  const types = new Set<string>([...Object.keys(input.waiting), ...[...tally.keys()].map((k) => k.slice(k.indexOf('|') + 1))]);
  const out: ModelOutputIncident[] = [];
  for (const type of [...types].sort()) {
    const waiting = input.waiting[type] ?? 0;
    const none = waiting > 0 && input.models.length > 0 && !input.models.some((m) => able(m, type));
    const others = (model: string) =>
      input.models.filter((m) => m !== model).map((m) => ({ model: m, state: failing(m, type) ? 'failing' : (input.hold(m) ?? 'able') }));
    const failed = input.models.filter((m) => failing(m, type));
    for (const model of failed) {
      const e = tally.get(`${model}|${type}`)!;
      const byClass = new Map<string, number>();
      for (const [reason, n] of e.reasons) byClass.set(failureClass(reason), (byClass.get(failureClass(reason)) ?? 0) + n);
      const top = [...e.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      out.push({
        key: `${model}|${type}`,
        model,
        workType: type,
        accepted: e.ok,
        rejected: e.bad,
        waiting,
        noFunctioningModel: none,
        reasons: [...byClass].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, n]) => ({ reason, n })),
        sample: top ? redactCredentials(top).slice(0, 400) : null,
        others: others(model),
      });
    }
    if (none && failed.length === 0) {
      out.push({
        key: `*|${type}`,
        model: '*',
        workType: type,
        accepted: 0,
        rejected: 0,
        waiting,
        noFunctioningModel: true,
        reasons: [],
        sample: null,
        others: input.models.map((m) => ({ model: m, state: input.hold(m) ?? 'able' })),
      });
    }
  }
  return out;
}

/** The incidents true now, from the lane's rows and this process's route holds. */
export async function readModelOutput(options: { now?: Date; models?: readonly string[] } = {}): Promise<ModelOutputIncident[]> {
  const now = options.now ?? new Date();
  const models = options.models ?? laneConfig()?.models ?? [];
  if (models.length === 0) return [];
  const rows = await answerRows(now.getTime());
  const queued = await getDb().all<{ work_type: string; n: number | string }>(
    `SELECT w.work_type, COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND ${OWNED_BY_FREE_LANE_BIN}
      GROUP BY w.work_type`,
    [],
  );
  const waiting: Record<string, number> = {};
  for (const row of queued) if ((FREE_LANE_WORK_TYPES as readonly string[]).includes(row.work_type)) waiting[row.work_type] = Number(row.n);
  return modelOutputIncidents({ rows, models, waiting, hold: (m) => routeHold(m, now.getTime()) });
}

export const MODEL_OUTPUT_DROP = 'FREE_LANE_MODEL_OUTPUT_DROP';
export const MODEL_OUTPUT_RECOVERED = 'FREE_LANE_MODEL_OUTPUT_RECOVERED';

/** The latest record per incident key: open when it is a drop. */
export async function openModelOutputIncidents(now = new Date()): Promise<Map<string, { at: string; noFunctioningModel: boolean }>> {
  const rows = await getDb().all<{ event_type: string; at: string; workload_class: string | null; measures: string }>(
    `SELECT event_type, at, workload_class, measures FROM bin_events
      WHERE event_type IN (?, ?) AND at >= ? ORDER BY at ASC`,
    [MODEL_OUTPUT_DROP, MODEL_OUTPUT_RECOVERED, new Date(now.getTime() - 14 * 86_400_000).toISOString()],
  );
  const open = new Map<string, { at: string; noFunctioningModel: boolean }>();
  for (const row of rows) {
    const key = row.workload_class ?? '';
    if (row.event_type === MODEL_OUTPUT_RECOVERED) {
      open.delete(key);
      continue;
    }
    let none = false;
    try {
      none = (JSON.parse(row.measures) as { noFunctioningModel?: boolean }).noFunctioningModel === true;
    } catch {
      none = false;
    }
    open.set(key, { at: row.at, noFunctioningModel: none });
  }
  return open;
}

/** One line a person or Hermes reads for an incident. */
export function describeModelOutput(one: ModelOutputIncident): string {
  const who = one.model === '*' ? `every free-lane route for ${one.workType} is held` : `${one.model} had ${one.rejected} of ${one.accepted + one.rejected} ${one.workType} answers refused in 24h`;
  const why = one.reasons.length ? `; refused for: ${one.reasons.map((r) => `${r.n}× ${r.reason}`).join(' | ')}` : '';
  const others = one.others.length ? `; other models: ${one.others.map((o) => `${o.model} ${o.state}`).join(', ')}` : '';
  const state = one.noFunctioningModel ? `NO functioning model for ${one.workType}, ${one.waiting} waiting` : `${one.waiting} waiting, routed to another model`;
  return `${who}${why}${others}; ${state}`;
}

/**
 * The incident record: a drop is written once when it starts (and again if it
 * worsens to no functioning model), a recovery once when useful output returns
 * — so the record is the incident's start and end, never a row a tick.
 * Rows go to `bin_events` beside the lane's FREE_LANE_ITEM rows; the incident
 * key is `workload_class`, the evidence is `measures`. Hermes reads the same
 * incidents as deficiencies (`readDeficiencies`), and the standing director
 * commissions the repair when no model functions. Queued work is never
 * touched: it stays QUEUED for whichever model can take it (#992).
 */
export async function watchModelOutput(options: { now?: Date; models?: readonly string[] } = {}): Promise<{ opened: string[]; recovered: string[]; incidents: ModelOutputIncident[] }> {
  const now = options.now ?? new Date();
  const incidents = await readModelOutput({ now, ...(options.models ? { models: options.models } : {}) });
  const open = await openModelOutputIncidents(now);
  const opened: string[] = [];
  const recovered: string[] = [];
  for (const one of incidents) {
    const was = open.get(one.key);
    if (was && (was.noFunctioningModel || !one.noFunctioningModel)) continue;
    await recordBinEvent({
      eventType: MODEL_OUTPUT_DROP,
      workloadClass: one.key,
      outcome: one.noFunctioningModel ? 'NO_FUNCTIONING_MODEL' : 'ROUTED_TO_ANOTHER_MODEL',
      reason: describeModelOutput(one),
      measures: { ...one },
    });
    opened.push(one.key);
  }
  const current = new Set(incidents.map((one) => one.key));
  for (const key of open.keys()) {
    if (current.has(key)) continue;
    await recordBinEvent({
      eventType: MODEL_OUTPUT_RECOVERED,
      workloadClass: key,
      outcome: 'USEFUL_OUTPUT_RETURNED',
      reason: `${key}: no longer failing, and the kind has a functioning model`,
      measures: { key },
    });
    recovered.push(key);
  }
  return { opened, recovered, incidents };
}

/** What `admin free-lane show` prints: coverage, outcomes, and what reached Brain. */
export async function freeLaneReading(): Promise<{
  coverage: LaneCoverage;
  outcomesLastDay: Record<string, number>;
  packetsTouched: number;
  claimsAccepted: number;
  claimsSubmitted: number;
  documentsFiled: number;
  recentFailures: string[];
  /** The latest recorded per-stage capacity reading (CAP-16-3) and the lines `admin free-lane show` prints for it. */
  stageCapacity: RecordedStageCapacity | null;
  stageCapacityLines: string[];
}> {
  const db = getDb();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const outcomes = await db.all<{ k: string; n: number | string }>(
    `SELECT workload_class || ':' || outcome AS k, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY workload_class, outcome`,
    [dayAgo],
  );
  const packets = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT w.orchestration_id) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'`,
    [],
  );
  const freeWorkers = "(SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))";
  const claims = await db.get<{ total: number | string; accepted: number | string }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(c.accepted), 0) AS accepted FROM research_claims c
      JOIN research_passes p ON p.id = c.pass_id WHERE p.executor_worker_id IN ${freeWorkers}`,
    [],
  );
  const filed = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT p.orchestration_id) AS n FROM research_passes p
      JOIN research_orchestrations o ON o.id = p.orchestration_id
     WHERE p.executor_worker_id IN ${freeWorkers} AND p.pass_key = 'SYNTHESIS' AND p.status = 'COMPLETE'
       AND o.document_id IS NOT NULL`,
    [],
  );
  const failures = await db.all<{ at: string; workload_class: string | null; reason: string | null }>(
    `SELECT at, workload_class, reason FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'FAILED_RETRYABLE' ORDER BY at DESC LIMIT 8`,
    [],
  );
  const stageCapacity = await readStageCapacity();
  return {
    stageCapacity,
    stageCapacityLines: stageCapacityLines(stageCapacity),
    recentFailures: failures.map((f) => `${f.at} ${f.workload_class ?? '?'} ${f.reason ?? ''}`),
    coverage: await laneCoverage(new Date(), { consumption: true }),
    outcomesLastDay: Object.fromEntries(outcomes.map((o) => [o.k, Number(o.n)])),
    packetsTouched: Number(packets?.n ?? 0),
    claimsAccepted: Number(claims?.accepted ?? 0),
    claimsSubmitted: Number(claims?.total ?? 0),
    documentsFiled: Number(filed?.n ?? 0),
  };
}

/**
 * Throughput, measured from rows (§86): what `admin free-lane show` prints under
 * "throughput". Every figure is counted, none is estimated; cost is the free
 * lane's own (no paid call is ever made from it).
 */
export async function freeLaneThroughput(now = new Date()): Promise<{
  runningNow: number;
  capacity: Array<{ model: string; target: number; stableHigh: number; updatedAt: string; reason: string }>;
  maxTargetReached: number;
  lastHour: { completed: number; accepted: number; failed: number; providerErrors: number; claimsAccepted: number; documents: number; nextStage: number };
  last10Min: { completed: number; perMinute: number };
  recentScaling: string[];
}> {
  const db = getDb();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const tenAgo = new Date(now.getTime() - 600_000).toISOString();
  const freeWorkers = "(SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))";
  const running = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items WHERE state = 'LEASED' AND lease_expires_at > ? AND worker_id IN ${freeWorkers}`,
    [now.toISOString()],
  );
  const capacity = await db.all<{ model: string; target: number; stable_high: number; updated_at: string; reason: string }>(
    'SELECT model, target, stable_high, updated_at, reason FROM free_lane_capacity ORDER BY model',
    [],
  );
  const outcomes = async (since: string) =>
    db.all<{ outcome: string; n: number | string }>(
      "SELECT outcome, COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY outcome",
      [since],
    );
  const count = (rows: { outcome: string; n: number | string }[], outcome: string): number =>
    Number(rows.find((r) => r.outcome === outcome)?.n ?? 0);
  const hour = await outcomes(hourAgo);
  const ten = await outcomes(tenAgo);
  const claims = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM research_claims c JOIN research_passes p ON p.id = c.pass_id
      WHERE c.accepted = 1 AND c.created_at >= ? AND p.executor_worker_id IN ${freeWorkers}`,
    [hourAgo],
  );
  const documents = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT p.orchestration_id) AS n FROM research_passes p
      JOIN research_orchestrations o ON o.id = p.orchestration_id
     WHERE p.executor_worker_id IN ${freeWorkers} AND p.pass_key = 'SYNTHESIS' AND p.status = 'COMPLETE'
       AND p.completed_at >= ? AND o.document_id IS NOT NULL`,
    [hourAgo],
  );
  const nextStage = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.created_at >= ? AND w.orchestration_id IN (
        SELECT DISTINCT wi.orchestration_id FROM work_items wi JOIN bin_events e ON e.work_item_id = wi.id
         WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?)`,
    [hourAgo, hourAgo],
  );
  const scaling = await db.all<{ at: string; workload_class: string | null; reason: string | null }>(
    "SELECT at, workload_class, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' ORDER BY at DESC LIMIT 10",
    [],
  );
  const reached = await db.all<{ reason: string | null }>(
    "SELECT reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'GROW'",
    [],
  );
  const maxTargetReached = Math.max(
    0,
    ...capacity.map((c) => Number(c.target)),
    ...reached.map((r) => Number(/->\s*(\d+)/.exec(r.reason ?? '')?.[1] ?? 0)),
  );
  const completed10 = count(ten, 'SUBMITTED') + count(ten, 'FAILED_RETRYABLE');
  return {
    runningNow: Number(running?.n ?? 0),
    capacity: capacity.map((c) => ({ model: c.model, target: Number(c.target), stableHigh: Number(c.stable_high), updatedAt: c.updated_at, reason: c.reason })),
    maxTargetReached,
    lastHour: {
      completed: count(hour, 'SUBMITTED') + count(hour, 'FAILED_RETRYABLE'),
      accepted: count(hour, 'SUBMITTED'),
      failed: count(hour, 'FAILED_RETRYABLE'),
      providerErrors: count(hour, 'RELEASED_TRANSIENT'),
      claimsAccepted: Number(claims?.n ?? 0),
      documents: Number(documents?.n ?? 0),
      nextStage: Number(nextStage?.n ?? 0),
    },
    last10Min: { completed: completed10, perMinute: Number((count(ten, 'SUBMITTED') / 10).toFixed(2)) },
    recentScaling: scaling.map((s) => `${s.at} ${s.workload_class ?? '?'} ${s.reason ?? ''}`),
  };
}
