/**
 * Reading Brain's capability maps against production rows (§88).
 *
 * `domain/capabilityMap.ts` says what a complete system must do and how each
 * requirement is proved; this reads each proof over a window and answers
 * WORKING, BROKEN, MISSING or UNPROVEN. It only reads. A gap reaches
 * engineering through the improvement loop (`capabilityWeaknesses`, called by
 * `detectWeaknesses`), never from here.
 *
 * One query per probe, bounded to the window, so an assessment is cheap enough
 * to run in the improvement pass — which already runs at most every ten
 * minutes and defers under database pressure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/database.ts';
import {
  CAPABILITY_MAPS,
  classify,
  connectedGaps,
  gapsForImprovement,
  type Assessed,
  type CapabilityMap,
  type Gap,
  type Probe,
  type ProbeReading,
} from '../../domain/capabilityMap.ts';
import { classifyFreeLaneFailure, WEAKNESS_MIN_COUNT, type Weakness } from '../../domain/improvement.ts';
import { BRAIN_PROJECT_SLUG } from '../../domain/binPurpose.ts';
import { readMetric } from '../improvement/scoreboard.ts';

const HOUR = 3_600_000;
const n = (value: number | string | null | undefined): number => Number(value ?? 0);

export interface MapAssessment {
  map: string;
  objective: string;
  from: string;
  to: string;
  assessed: Assessed[];
  gaps: Gap[];
  counts: Record<string, number>;
}

/** Whether a requirement's owning module is in the running image. */
export function ownerExists(owner: string, root: string = process.cwd()): boolean {
  return fs.existsSync(path.resolve(root, owner));
}

const PROVIDER_CLASSES = new Set(['PROVIDER_EXHAUSTED', 'NO_USABLE_ANSWER']);

async function freeLaneFragments(from: string, to: string): Promise<{ outcome: string; reason: string | null; measures: string | null }[]> {
  return getDb().all(
    `SELECT outcome, reason, measures FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? AND at < ?
        AND outcome IN ('SUBMITTED', 'FAILED_RETRYABLE')
      LIMIT 5000`,
    [from, to],
  );
}

async function itemsOf(workType: string, from: string, to: string): Promise<ProbeReading> {
  const rows = await getDb().all<{ state: string; n: number | string }>(
    `SELECT state, COUNT(*) AS n FROM work_items
      WHERE work_type = ? AND state IN ('SUCCEEDED', 'FAILED') AND updated_at >= ? AND updated_at < ?
      GROUP BY state`,
    [workType, from, to],
  );
  const ok = n(rows.find((r) => r.state === 'SUCCEEDED')?.n);
  const total = rows.reduce((a, r) => a + n(r.n), 0);
  return { ok, total, detail: `${workType} items settled ${from.slice(0, 16)}Z → ${to.slice(0, 16)}Z` };
}

/** One probe over [from, to). */
export async function readProbe(probe: Probe, from: string, to: string): Promise<ProbeReading> {
  const db = getDb();
  const settledBefore = new Date(Date.parse(to) - HOUR).toISOString();
  switch (probe) {
    case 'PLAN_APPROVED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status <> 'PLANNED') THEN 1 ELSE 0 END) AS ok
           FROM research_orchestrations o
          WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'CANCELLED'`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'packets created (not cancelled) whose fragments left PLANNED' };
    }
    case 'DISCOVERY_SEARCHED': {
      const rows = (await freeLaneFragments(from, to)).filter((r) => r.outcome === 'SUBMITTED' || !PROVIDER_CLASSES.has(classifyFreeLaneFailure(r.reason)));
      const ok = rows.filter((r) => /"searched":[1-9]/.test(r.measures ?? '')).length;
      return { ok, total: rows.length, detail: 'free-lane fragments (provider failures excluded) whose candidates included search results' };
    }
    case 'DISCOVERY_READABLE':
    case 'CLAIMS_SURVIVE_CITATION': {
      const rows = await freeLaneFragments(from, to);
      let submitted = 0;
      let unreadable = 0;
      let citation = 0;
      for (const row of rows) {
        if (row.outcome === 'SUBMITTED') {
          submitted += 1;
          continue;
        }
        const cls = classifyFreeLaneFailure(row.reason);
        if (PROVIDER_CLASSES.has(cls)) continue;
        if (cls === 'NO_READABLE_SOURCE') unreadable += 1;
        else citation += 1;
      }
      if (probe === 'DISCOVERY_READABLE') {
        const total = submitted + unreadable + citation;
        return { ok: total - unreadable, total, detail: 'free-lane fragments (provider failures excluded) that read at least one source' };
      }
      return { ok: submitted, total: submitted + citation, detail: 'free-lane fragments with a readable source that submitted claims' };
    }
    case 'ACCESS_READ':
    case 'ACCESS_ROUTINE_FETCH': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'READ' THEN 1 ELSE 0 END) AS ok FROM bin_events
          WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND at < ? ${probe === 'ACCESS_ROUTINE_FETCH' ? "AND workload_class = 'brain_fetch_source'" : "AND workload_class <> 'compare'"}`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: probe === 'ACCESS_READ' ? 'source reads by research' : 'brain_fetch_source reads' };
    }
    case 'CLAIMS_ACCEPTED': {
      const r = await readMetric('ACCEPTED_CLAIM_RATE', from, to);
      return { ok: r.numerator, total: r.denominator, detail: 'claims the evidence gate accepted' };
    }
    case 'REJECTIONS_EXPLAINED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        // Judged claims only: a claim whose fragment has no verdict yet is unjudged, not unexplained.
        `SELECT COUNT(*) AS total, SUM(CASE WHEN c.rejection_reason IS NOT NULL AND c.rejection_reason <> '' THEN 1 ELSE 0 END) AS ok
           FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
          WHERE c.accepted = 0 AND f.status IN ('ACCEPTED', 'BLOCKED') AND c.created_at >= ? AND c.created_at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'rejected claims with a recorded reason' };
    }
    case 'GATE_VERDICTS': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) AS ok FROM research_fragments
          WHERE status IN ('ACCEPTED', 'BLOCKED') AND updated_at >= ? AND updated_at < ?`,
        [from, to],
      );
      const causes = await db.all<{ cause: string | null; n: number | string }>(
        `SELECT block_cause AS cause, COUNT(*) AS n FROM research_fragments
          WHERE status = 'BLOCKED' AND updated_at >= ? AND updated_at < ? GROUP BY block_cause ORDER BY n DESC`,
        [from, to],
      );
      const why = causes.map((c) => `${c.cause ?? 'UNRECORDED'}:${n(c.n)}`).join(' ');
      return { ok: n(row?.ok), total: n(row?.total), detail: `fragments settled ACCEPTED of ACCEPTED+BLOCKED; blocked by ${why || 'nothing'}` };
    }
    case 'VERIFY_ITEMS':
      return itemsOf('RESEARCH_VERIFY', from, to);
    case 'SYNTHESIS_ITEMS':
      return itemsOf('RESEARCH_SYNTHESIZE', from, to);
    case 'AUDIT_ITEMS':
      return itemsOf('RESEARCH_AUDIT', from, to);
    case 'PACKETS_FILED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END) AS ok FROM research_orchestrations
          WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND completed_at >= ? AND completed_at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'completed packets carrying a filed document' };
    }
    case 'JOBS_SUCCEED': {
      const r = await readMetric('RESEARCH_JOB_SUCCESS_RATE', from, to);
      const ends = await db.all<{ status: string; reason: string | null; n: number | string }>(
        `SELECT status, SUBSTR(COALESCE(failure_reason, cancel_reason, ''), 1, 90) AS reason, COUNT(*) AS n FROM research_orchestrations
          WHERE status IN ('FAILED', 'NEEDS_HUMAN', 'CANCELLED')
            AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) >= ? AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) < ?
          GROUP BY status, SUBSTR(COALESCE(failure_reason, cancel_reason, ''), 1, 90) ORDER BY n DESC LIMIT 5`,
        [from, to],
      );
      const why = ends.map((e) => `${e.status}×${n(e.n)} "${e.reason ?? ''}"`).join('; ');
      return { ok: r.numerator, total: r.denominator, detail: `settled packets that completed (cancelled excluded: ${String(r.context?.['cancelled'] ?? 0)}); ended: ${why || 'none'}` };
    }
    case 'PARKS_DECIDED_BY_BRAIN': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN answered_reason LIKE 'Decided by Brain%' THEN 1 ELSE 0 END) AS ok
           FROM russell_human_requests WHERE mission_id IS NOT NULL AND created_at >= ? AND created_at < ?`,
        [from, settledBefore],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'mission cards over an hour old that Brain answered itself' };
    }
    case 'MISSIONS_WRITTEN_BACK': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN m.state = 'DONE' THEN 1 ELSE 0 END) AS ok
           FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id
          WHERE o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND o.completed_at >= ? AND o.completed_at < ?`,
        [from, settledBefore],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'missions whose packet completed over an hour ago that reached DONE' };
    }
    case 'AUTO_RECOVERY': {
      const r = await readMetric('AUTO_RECOVERY_RATE', from, to);
      return { ok: r.numerator, total: r.denominator, detail: 'retried work items that eventually succeeded' };
    }
    case 'LEASES_RECLAIMED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) AS ok FROM work_leases
          WHERE expires_at >= ? AND expires_at < ?`,
        [from, settledBefore],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'leases that expired over an hour ago and were ended' };
    }
    case 'PROVIDERS_ANSWER': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome <> 'RELEASED_TRANSIENT' THEN 1 ELSE 0 END) AS ok FROM bin_events
          WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'free-lane items not released for a provider failure' };
    }
    case 'PACKETS_MOVING': {
      const sixHours = new Date(Date.parse(to) - 6 * HOUR).toISOString();
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS ok FROM research_orchestrations
          WHERE status NOT IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')`,
        [sixHours],
      );
      // Why the idle ones are idle: by status, and whether any of their work is still waiting.
      const idle = await db.all<{ status: string; waiting: number | string; n: number | string }>(
        `SELECT o.status,
                CASE WHEN EXISTS (SELECT 1 FROM work_items w WHERE w.orchestration_id = o.id AND w.state IN ('QUEUED', 'LEASED')) THEN 1 ELSE 0 END AS waiting,
                COUNT(*) AS n
           FROM research_orchestrations o
          WHERE o.status NOT IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED') AND o.updated_at < ?
          GROUP BY o.status, waiting`,
        [sixHours],
      );
      const why = idle.map((r) => `${r.status}${n(r.waiting) ? '+work' : '+nothing queued'}:${n(r.n)}`).join(' ');
      return { ok: n(row?.ok), total: n(row?.total), detail: `live packets updated within six hours (now); idle: ${why || 'none'}` };
    }
    case 'WORK_CLAIMED_PROMPTLY': {
      const hourAgo = new Date(Date.parse(to) - HOUR).toISOString();
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN available_at >= ? THEN 1 ELSE 0 END) AS ok FROM work_items
          WHERE state = 'QUEUED' AND available_at <= ? AND attempt_count < max_attempts
            AND work_type IN ('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')`,
        [hourAgo, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'claimable research items that have waited under an hour (now)' };
    }
    case 'WEAKNESSES_TRACKED': {
      const twoDays = new Date(Date.parse(to) - 48 * HOUR).toISOString();
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM improvement_events e WHERE e.candidate_id = c.id AND e.at >= ?) THEN 1 ELSE 0 END) AS ok
           FROM improvement_candidates c WHERE c.decision IS NULL`,
        [twoDays],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'open improvement candidates with an event in 48 h (now)' };
    }
    case 'IMPROVEMENTS_DELIVERED': {
      const dayAgo = new Date(Date.parse(to) - 24 * HOUR).toISOString();
      const week = new Date(Date.parse(to) - 7 * 24 * HOUR).toISOString();
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS ok FROM improvement_candidates
          WHERE change_request_id IS NOT NULL AND created_at >= ? AND created_at < ?`,
        [week, dayAgo],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: 'candidates sent to Factory in the last week (over a day ago) that were delivered' };
    }
    case 'METHOD_POOL': {
      const row = await db.get<{ total: number | string }>(
        // The method pool's own joins (`readMethodRulePool`): a claim carries no project column.
        `SELECT COUNT(*) AS total FROM research_claims c
           JOIN research_orchestrations o ON o.id = c.orchestration_id
           JOIN russell_goals g ON g.id = o.goal_id
           JOIN projects p ON p.id = g.project_id
          WHERE p.slug = ? AND g.purpose = 'RESEARCH_GOAL' AND c.accepted = 1`,
        [BRAIN_PROJECT_SLUG],
      );
      const total = n(row?.total);
      return { ok: total, total: Math.max(total, 1), detail: 'accepted method claims Brain holds (lifetime)' };
    }
    default:
      return readGoalProbe(probe, from, to);
  }
}

/** Live goals with a target, not yet due-passed: the goals a plan is owed to. */
async function liveTargetGoals(to: string): Promise<{ id: string; projectId: string | null }[]> {
  const rows = await getDb().all<{ id: string; target_project_id: string | null }>(
    `SELECT id, target_project_id FROM workstreams
      WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL
        AND (due_at IS NULL OR due_at > ?)
      ORDER BY created_at DESC LIMIT 20`,
    [to],
  );
  return rows.map((r) => ({ id: r.id, projectId: r.target_project_id }));
}

/** The latest reading of each live goal: its progress figures (`planProgress`), or null. */
async function latestProgress(to: string): Promise<{ goalId: string; considered: number; modelled: number; evidenced: number; verdict: string }[]> {
  const out: { goalId: string; considered: number; modelled: number; evidenced: number; verdict: string }[] = [];
  for (const goal of await liveTargetGoals(to)) {
    const row = await getDb().get<{ forecast: string | null; verdict: string }>(
      `SELECT forecast, verdict FROM goal_plan_readings WHERE workstream_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`,
      [goal.id, to],
    );
    if (!row) continue;
    let f: { considered?: unknown; modelled?: unknown; evidencedBuyerAndPrice?: unknown } = {};
    try {
      f = row.forecast ? (JSON.parse(row.forecast) as typeof f) : {};
    } catch {
      f = {};
    }
    out.push({ goalId: goal.id, considered: n(f.considered as number), modelled: n(f.modelled as number), evidenced: n(f.evidencedBuyerAndPrice as number), verdict: row.verdict });
  }
  return out;
}

/** Brain's own database refusing work, in the words the pool and the driver use. */
const DATABASE_FAILURE_SQL = `(reason LIKE '%database pool%' OR reason LIKE '%Connection terminated%' OR reason LIKE '%not queryable%'
  OR reason LIKE '%Query read timeout%' OR reason LIKE '%statement timeout%' OR reason LIKE '%Brain database%')`;

/** The goal-plan map's probes (GOAL_PLAN_MAP). One bounded read each. */
async function readGoalProbe(probe: Probe, from: string, to: string): Promise<ProbeReading> {
  const db = getDb();
  const window = `${from.slice(0, 16)}Z → ${to.slice(0, 16)}Z`;
  const settled = (alias: string) => `${alias}.state <> 'OPEN' AND COALESCE(${alias}.harvested_at, ${alias}.updated_at) >= ? AND COALESCE(${alias}.harvested_at, ${alias}.updated_at) < ?`;
  switch (probe) {
    case 'GOAL_PLAN_EVALUATED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS ok FROM scenario_runs
          WHERE label LIKE 'goal %' AND started_at >= ? AND started_at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: `goal scenario runs started ${window}` };
    }
    case 'GOAL_PLAN_FRESH': {
      const twoHours = new Date(Date.parse(to) - 2 * HOUR).toISOString();
      const goals = await liveTargetGoals(to);
      let ok = 0;
      for (const goal of goals) {
        const row = await db.get<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM scenario_runs WHERE label = ? AND started_at >= ? AND started_at < ?`,
          [`goal ${goal.id}`, twoHours, to],
        );
        if (n(row?.n) > 0) ok += 1;
      }
      return { ok, total: goals.length, detail: 'live targeted goals with a scenario run in the last two hours (now)' };
    }
    case 'GOAL_SEARCH_WIDENS': {
      const short = (await latestProgress(to)).filter((p) => p.verdict !== 'RECOMMENDABLE');
      let ok = 0;
      for (const goal of short) {
        const row = await db.get<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM cash_discovery_rounds WHERE (bucket_id = ? OR bucket_id LIKE ?) AND opened_at >= ? AND opened_at < ?`,
          [`goal-${goal.goalId}`, `goal-${goal.goalId}-%`, from, to],
        );
        if (n(row?.n) > 0) ok += 1;
      }
      return { ok, total: short.length, detail: `live goals short of a recommendable plan that opened a round ${window}` };
    }
    case 'GOAL_ROUNDS_FILE':
    case 'CONSTRUCTED_ROUNDS_FILE': {
      const constructed = probe === 'CONSTRUCTED_ROUNDS_FILE';
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN r.found > 0 THEN 1 ELSE 0 END) AS ok FROM cash_discovery_rounds r
          WHERE r.bucket_id LIKE ? ${constructed ? '' : "AND r.bucket_id NOT LIKE 'goal-%-mx-%'"} AND ${settled('r')}`,
        [constructed ? 'goal-%-mx-%' : 'goal-%', from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: `${constructed ? 'constructed' : 'goal discovery'} rounds settled ${window} that filed an opening` };
    }
    case 'GOAL_PACKETS_COMPLETE': {
      const rows = await db.all<{ status: string; n: number | string }>(
        `SELECT o.status, COUNT(DISTINCT o.id) AS n FROM cash_discovery_rounds r
           JOIN russell_missions m ON m.candidate_id = r.candidate_id
           JOIN research_orchestrations o ON o.id = m.orchestration_id
          WHERE r.bucket_id LIKE 'goal-%' AND o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')
            AND o.updated_at >= ? AND o.updated_at < ?
          GROUP BY o.status`,
        [from, to],
      );
      const ok = rows.filter((r) => r.status.startsWith('COMPLETE')).reduce((a, r) => a + n(r.n), 0);
      const total = rows.reduce((a, r) => a + n(r.n), 0);
      return { ok, total, detail: `packets behind goal rounds settled ${window}: ${rows.map((r) => `${r.status}=${n(r.n)}`).join(' ') || 'none'}` };
    }
    case 'PATH_QUESTIONS_ANSWERED': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'RESOLVED' THEN 1 ELSE 0 END) AS ok FROM cash_needs
          WHERE request_key LIKE 'question:%' AND opportunity_id IS NOT NULL AND state IN ('RESOLVED', 'WITHDRAWN')
            AND updated_at >= ? AND updated_at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: `opening questions closed ${window} that were resolved` };
    }
    case 'OPENINGS_BUYER_PRICE':
    case 'OPENINGS_MODELLED': {
      const readings = await latestProgress(to);
      const buyer = probe === 'OPENINGS_BUYER_PRICE';
      const ok = readings.reduce((a, r) => a + (buyer ? r.evidenced : r.modelled), 0);
      const total = readings.reduce((a, r) => a + r.considered, 0);
      return { ok, total, detail: `openings in ${readings.length} live goal(s)' latest reading ${buyer ? 'with buyer, demand and price established' : 'modelled by the quant engine'} (now)` };
    }
    case 'OPENINGS_REACH_PLAN': {
      const settledBy = new Date(Date.parse(to) - HOUR / 2).toISOString();
      let ok = 0;
      let total = 0;
      for (const goal of await liveTargetGoals(to)) {
        if (!goal.projectId) continue;
        const row = await db.get<{ total: number | string; ok: number | string | null }>(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN EXISTS (SELECT 1 FROM scenario_runs s WHERE s.label = ? AND s.started_at > o.created_at) THEN 1 ELSE 0 END) AS ok
             FROM cash_opportunities o WHERE o.project_id = ? AND o.created_at >= ? AND o.created_at < ?`,
          [`goal ${goal.id}`, goal.projectId, from, settledBy],
        );
        ok += n(row?.ok);
        total += n(row?.total);
      }
      return { ok, total, detail: `openings filed ${window} (over 30 min old) followed by a goal plan run` };
    }
    case 'GPU_SERVES': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'SUBMITTED' THEN 1 ELSE 0 END) AS ok FROM bin_events
          WHERE event_type = 'FREE_LANE_ITEM' AND reason LIKE 'model runpod/%' AND at >= ? AND at < ?`,
        [from, to],
      );
      const pod = await db.get<{ refused: number | string | null }>(
        `SELECT SUM(CASE WHEN outcome = 'START_FAILED' THEN 1 ELSE 0 END) AS refused FROM bin_events
          WHERE event_type = 'RUNPOD_POD' AND at >= ? AND at < ?`,
        [from, to],
      );
      const refused = n(pod?.refused);
      return { ok: n(row?.ok), total: n(row?.total) + refused, detail: `GPU-model attempts ${window}; ${refused} pod start(s) refused` };
    }
    case 'FREE_MODELS_SERVE': {
      const row = await db.get<{ total: number | string; ok: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'SUBMITTED' THEN 1 ELSE 0 END) AS ok FROM bin_events
          WHERE event_type = 'FREE_LANE_ITEM' AND outcome IN ('SUBMITTED', 'FAILED_RETRYABLE')
            AND reason NOT LIKE 'model runpod/%' AND at >= ? AND at < ?`,
        [from, to],
      );
      return { ok: n(row?.ok), total: n(row?.total), detail: `free-model attempts ${window} (provider releases excluded)` };
    }
    case 'DATABASE_AVAILABLE': {
      const row = await db.get<{ total: number | string; bad: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ${DATABASE_FAILURE_SQL} THEN 1 ELSE 0 END) AS bad FROM bin_events
          WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ?`,
        [from, to],
      );
      const total = n(row?.total);
      return { ok: total - n(row?.bad), total, detail: `free-lane attempts ${window} that did not fail on Brain's database` };
    }
    default:
      return { ok: 0, total: 0, detail: `no reader for ${probe}` };
  }
}

/** One map over the last `hours`. */
export async function assessMap(map: CapabilityMap, input: { now?: Date; hours?: number; root?: string } = {}): Promise<MapAssessment> {
  const now = input.now ?? new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - (input.hours ?? 24) * HOUR).toISOString();
  const assessed: Assessed[] = [];
  for (const requirement of map.requirements) {
    const exists = ownerExists(requirement.owner[0]!, input.root);
    let reading: ProbeReading | null = null;
    try {
      reading = await readProbe(requirement.proof.probe, from, to);
    } catch {
      reading = null;
    }
    assessed.push(classify(requirement, exists, reading));
  }
  const counts: Record<string, number> = { WORKING: 0, BROKEN: 0, MISSING: 0, UNPROVEN: 0 };
  for (const a of assessed) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return { map: map.key, objective: map.objective, from, to, assessed, gaps: connectedGaps(map, assessed), counts };
}

export async function assessAll(input: { now?: Date; hours?: number } = {}): Promise<MapAssessment[]> {
  const out: MapAssessment[] = [];
  for (const map of Object.values(CAPABILITY_MAPS)) out.push(await assessMap(map, input));
  return out;
}

/**
 * Gaps the improvement loop should own, as its own `Weakness` shape (§87).
 *
 * Only a BROKEN or MISSING requirement with an owner route, past the loop's
 * minimum count, not sitting behind another gap, and not already raised by one
 * of the loop's own detectors in this pass.
 */
export async function capabilityWeaknesses(now: Date, alreadyDetected: readonly string[]): Promise<Weakness[]> {
  const out: Weakness[] = [];
  for (const map of Object.values(CAPABILITY_MAPS)) {
    const assessment = await assessMap(map, { now, hours: 24 });
    for (const { gap, requirement, route } of gapsForImprovement(assessment.gaps, map, alreadyDetected, WEAKNESS_MIN_COUNT)) {
      const reading = assessment.assessed.find((a) => a.requirement.id === gap.id)?.reading;
      out.push({
        key: `CAPABILITY:${map.key}.${gap.id}`,
        kind: gap.status === 'MISSING' ? 'CAPABILITY_MISSING' : 'CAPABILITY_BROKEN',
        title: `${map.key} capability ${gap.status.toLowerCase()}: ${requirement.ability}`.slice(0, 200),
        problem:
          `The ${map.key.toLowerCase()} map requires: ${requirement.ability}. Production reads it ${gap.status}: ${gap.why}. ` +
          `It holds up ${gap.downstream.length} downstream requirement(s): ${gap.downstream.join(', ') || 'none'}.`,
        metric: route.metric,
        downstreamMetric: null,
        ownerComponent: requirement.owner[0]!,
        mutationScope: route.mutationScope,
        frequency: gap.failures,
        denominator: Math.max(reading?.total ?? gap.failures, gap.failures),
        scope: 'GENERAL',
        severity: gap.status === 'MISSING' || gap.downstream.length >= 3 ? 'HIGH' : 'MEDIUM',
        researchQuestion: `${requirement.ability} ${requirement.failureConditions.join(' ')}`,
        samples: [gap.why, ...requirement.failureConditions].slice(0, 5),
        knownCause: gap.status === 'MISSING' ? `No implementation of ${requirement.owner[0]} exists.` : null,
      });
    }
  }
  return out;
}

/** Lines for `admin capabilities show`. */
export function formatAssessment(a: MapAssessment): string[] {
  const lines = [
    `  MAP ${a.map}  window ${a.from.slice(0, 16)}Z → ${a.to.slice(0, 16)}Z  ${JSON.stringify(a.counts)}`,
    `    objective: ${a.objective}`,
  ];
  let stage = '';
  for (const one of a.assessed) {
    if (one.requirement.stage !== stage) {
      stage = one.requirement.stage;
      lines.push(`    ${stage}`);
    }
    lines.push(`      ${one.status.padEnd(8)} ${one.requirement.id.padEnd(26)} ${one.why}${one.status === 'BROKEN' && one.reading ? ` — ${one.reading.detail}` : ''}`);
  }
  lines.push('    CONNECTED GAPS (most consequential first)');
  for (const g of a.gaps) {
    lines.push(
      `      #${String(g.rank).padStart(5)} ${g.status.padEnd(8)} ${g.id.padEnd(26)} failures=${g.failures} downstream=${g.downstream.length}` +
        (g.behind.length ? ` behind=${g.behind.join(',')}` : '') +
        (g.externalLimit ? ` external: ${g.externalLimit}` : ''),
    );
  }
  return lines;
}
