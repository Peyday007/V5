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
import { FREE_LANE_WORK_TYPES } from './worker.ts';

export interface LaneCoverage {
  configured: boolean;
  models: number;
  displaced: Record<string, number>;
  unsupported: Record<string, number>;
  submittedLastHour: number;
  failedLastHour: number;
  lastSubmittedAt: string | null;
  /** Items the packet runner queued after a free-lane submission, in the last day. */
  consumedLastDay: number;
  ready: boolean;
  reason: string;
}

const OWNED_BY_FREE_LANE_BIN = `EXISTS (SELECT 1 FROM bins b
   WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
     AND b.purpose IN ('PLAY_RESEARCH', 'GRUNT'))`;

export async function laneCoverage(now = new Date()): Promise<LaneCoverage> {
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
  const consumed = await db.get<{ n: number | string }>(
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
    consumedLastDay: Number(consumed?.n ?? 0),
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

/** What `admin free-lane show` prints: coverage, outcomes, and what reached Brain. */
export async function freeLaneReading(): Promise<{
  coverage: LaneCoverage;
  outcomesLastDay: Record<string, number>;
  packetsTouched: number;
  claimsAccepted: number;
  claimsSubmitted: number;
  documentsFiled: number;
  recentFailures: string[];
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
  return {
    recentFailures: failures.map((f) => `${f.at} ${f.workload_class ?? '?'} ${f.reason ?? ''}`),
    coverage: await laneCoverage(),
    outcomesLastDay: Object.fromEntries(outcomes.map((o) => [o.k, Number(o.n)])),
    packetsTouched: Number(packets?.n ?? 0),
    claimsAccepted: Number(claims?.accepted ?? 0),
    claimsSubmitted: Number(claims?.total ?? 0),
    documentsFiled: Number(filed?.n ?? 0),
  };
}
