/**
 * Whether Brain is getting better, counted from production rows (§87).
 *
 * Every metric has a definition, a numerator and a denominator
 * (`domain/improvement.ts` METRICS), and says INSUFFICIENT_DATA below its
 * minimum sample rather than a number. Nothing here is estimated, and nothing
 * here writes: the loop records what it reads as an `improvement_events` row.
 */
import { getDb } from '../../db/database.ts';
import {
  classifyClaimRejection,
  classifyFreeLaneFailure,
  compare,
  type Comparison,
  METRIC_KEYS,
  reading,
  type FailureCount,
  type MetricKey,
  type MetricReading,
} from '../../domain/improvement.ts';

const n = (value: number | string | null | undefined): number => Number(value ?? 0);

async function freeLane(from: string, to: string, fragmentsOnly: boolean): Promise<{ ok: number; failed: number; provider: number }> {
  const rows = await getDb().all<{ outcome: string; n: number | string }>(
    `SELECT outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ? ${fragmentsOnly ? "AND workload_class = 'RESEARCH_FRAGMENT'" : ''}
      GROUP BY outcome`,
    [from, to],
  );
  const get = (outcome: string): number => n(rows.find((r) => r.outcome === outcome)?.n);
  return { ok: get('SUBMITTED'), failed: get('FAILED_RETRYABLE'), provider: get('RELEASED_TRANSIENT') };
}

/** One metric over [from, to). */
export async function readMetric(key: MetricKey, from: string, to: string): Promise<MetricReading> {
  const db = getDb();
  switch (key) {
    case 'FREE_LANE_PASS_RATE':
    case 'FREE_LANE_FRAGMENT_PASS_RATE': {
      const lane = await freeLane(from, to, key === 'FREE_LANE_FRAGMENT_PASS_RATE');
      const all = lane.ok + lane.failed + lane.provider;
      return reading(key, from, to, lane.ok, lane.ok + lane.failed, undefined, {
        providerErrorShare: all > 0 ? Number((lane.provider / all).toFixed(3)) : 0,
      });
    }
    case 'ACCEPTED_CLAIM_RATE': {
      const row = await db.get<{ total: number | string; accepted: number | string | null }>(
        'SELECT COUNT(*) AS total, SUM(accepted) AS accepted FROM research_claims WHERE created_at >= ? AND created_at < ?',
        [from, to],
      );
      return reading(key, from, to, n(row?.accepted), n(row?.total));
    }
    case 'RESEARCH_JOB_SUCCESS_RATE': {
      const rows = await db.all<{ status: string; n: number | string }>(
        `SELECT status, COUNT(*) AS n FROM research_orchestrations
          WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')
            AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) >= ?
            AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) < ?
          GROUP BY status`,
        [from, to],
      );
      const ok = rows.filter((r) => r.status === 'COMPLETE' || r.status === 'COMPLETE_WITH_GAPS').reduce((a, r) => a + n(r.n), 0);
      // A packet Brain cancelled (superseded, retired) was not a job that failed; it is reported beside the rate.
      const cancelled = n(rows.find((r) => r.status === 'CANCELLED')?.n);
      const all = rows.reduce((a, r) => a + n(r.n), 0) - cancelled;
      return reading(key, from, to, ok, all, undefined, { cancelled });
    }
    case 'CONSTRUCTED_ROUND_YIELD': {
      const row = await db.get<{ total: number | string; yielded: number | string | null }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN found > 0 THEN 1 ELSE 0 END) AS yielded FROM cash_discovery_rounds
          WHERE bucket_id LIKE ? AND state IN ('HARVESTED', 'ABANDONED') AND updated_at >= ? AND updated_at < ?`,
        ['%-mx-%', from, to],
      );
      return reading(key, from, to, n(row?.yielded), n(row?.total));
    }
    case 'READY_OPPORTUNITIES_PER_DAY': {
      const row = await db.get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM cash_events WHERE kind = 'CASH_OPPORTUNITY_READY' AND created_at >= ? AND created_at < ?",
        [from, to],
      );
      return reading(key, from, to, n(row?.n), 0);
    }
    case 'OBJECTIVE_HOURS_MEDIAN': {
      const rows = await db.all<{ created_at: string; completed_at: string }>(
        `SELECT created_at, completed_at FROM research_orchestrations
          WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS') AND completed_at >= ? AND completed_at < ?`,
        [from, to],
      );
      const hours = rows
        .map((r) => (Date.parse(r.completed_at) - Date.parse(r.created_at)) / 3_600_000)
        .filter((h) => Number.isFinite(h) && h >= 0)
        .sort((a, b) => a - b);
      const mid = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
      return reading(key, from, to, hours.length, hours.length, mid);
    }
    case 'OWNER_INTERVENTIONS_PER_DAY': {
      const asks = await db.get<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM russell_human_requests WHERE created_at >= ? AND created_at < ?',
        [from, to],
      );
      const parked = await db.get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM research_orchestrations WHERE status = 'NEEDS_HUMAN' AND updated_at >= ? AND updated_at < ?",
        [from, to],
      );
      return reading(key, from, to, n(asks?.n) + n(parked?.n), 0);
    }
    case 'AUTO_RECOVERY_RATE': {
      const rows = await db.all<{ state: string; n: number | string }>(
        `SELECT state, COUNT(*) AS n FROM work_items
          WHERE attempt_count > 1 AND state IN ('SUCCEEDED', 'FAILED') AND updated_at >= ? AND updated_at < ?
          GROUP BY state`,
        [from, to],
      );
      const ok = n(rows.find((r) => r.state === 'SUCCEEDED')?.n);
      return reading(key, from, to, ok, rows.reduce((a, r) => a + n(r.n), 0));
    }
  }
}

export interface Scoreboard {
  from: string;
  to: string;
  metrics: MetricReading[];
}

/** Every metric over one window. */
export async function readScoreboard(from: string, to: string): Promise<Scoreboard> {
  const metrics: MetricReading[] = [];
  for (const key of METRIC_KEYS) metrics.push(await readMetric(key, from, to));
  return { from, to, metrics };
}

/** Free-lane failures by class over [from, to), with up to five verbatim reasons each. */
export async function freeLaneFailures(from: string, to: string): Promise<{ attempts: number; failures: FailureCount[] }> {
  const rows = await getDb().all<{ outcome: string; reason: string | null }>(
    `SELECT outcome, reason FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? AND at < ?
        AND outcome IN ('SUBMITTED', 'FAILED_RETRYABLE')`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    if (row.outcome !== 'FAILED_RETRYABLE') continue;
    const cls = classifyFreeLaneFailure(row.reason);
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.reason) entry.samples.push(row.reason.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { attempts: rows.length, failures: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/** Rejected claims by class over [from, to). */
export async function claimRejections(from: string, to: string): Promise<{ claims: number; rejections: FailureCount[] }> {
  const total = await getDb().get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?',
    [from, to],
  );
  // Judged claims only. A claim whose fragment has no gate verdict yet carries accepted = 0 and no
  // reason because nothing has judged it; counting it as "NO_REASON_RECORDED" (373 in a week,
  // 2026-11-04) reported unjudged work as unexplained rejections.
  const rows = await getDb().all<{ rejection_reason: string | null }>(
    `SELECT c.rejection_reason FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
      WHERE c.accepted = 0 AND f.status IN ('ACCEPTED', 'BLOCKED') AND c.created_at >= ? AND c.created_at < ? LIMIT 5000`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    const cls = classifyClaimRejection(row.rejection_reason);
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.rejection_reason) entry.samples.push(row.rejection_reason.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { claims: n(total?.n), rejections: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/** How packets that settled over [from, to) ended, by status and block cause. */
export async function packetOutcomes(from: string, to: string): Promise<{ settled: number; causes: FailureCount[] }> {
  const rows = await getDb().all<{ status: string; failure_reason: string | null }>(
    `SELECT status, failure_reason FROM research_orchestrations
      WHERE status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')
        AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) >= ?
        AND COALESCE(completed_at, failed_at, cancelled_at, updated_at) < ?`,
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    if (row.status === 'CANCELLED') continue;
    if (row.status !== 'NEEDS_HUMAN' && row.status !== 'FAILED') continue;
    const entry = byClass.get(row.status) ?? { cls: row.status, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.failure_reason) entry.samples.push(row.failure_reason.slice(0, 300));
    byClass.set(row.status, entry);
  }
  return { settled: rows.filter((r) => r.status !== 'CANCELLED').length, causes: [...byClass.values()] };
}

/** Needs-You requests opened over [from, to), by the authority each asked for. */
export async function ownerInterventions(from: string, to: string): Promise<{ total: number; causes: FailureCount[] }> {
  const rows = await getDb().all<{ authority_needed: string; why_not_russell: string | null }>(
    'SELECT authority_needed, why_not_russell FROM russell_human_requests WHERE created_at >= ? AND created_at < ? LIMIT 5000',
    [from, to],
  );
  const byClass = new Map<string, FailureCount>();
  for (const row of rows) {
    const cls = row.authority_needed.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60).toUpperCase().replace(/\s+/g, '_') || 'UNSTATED';
    const entry = byClass.get(cls) ?? { cls, n: 0, samples: [] };
    entry.n += 1;
    if (entry.samples.length < 5 && row.why_not_russell) entry.samples.push(row.why_not_russell.slice(0, 300));
    byClass.set(cls, entry);
  }
  return { total: rows.length, causes: [...byClass.values()].sort((a, b) => b.n - a.n) };
}

/* ------------------------------------------------------------------------- */
/* Gaps Brain found and closed by itself (AUTO-20-4)                          */
/* ------------------------------------------------------------------------- */

/** A figure Brain has no row for is said to be unmeasured; it is never a zero. */
export interface Unmeasured {
  status: 'NOT_MEASURED';
  reason: string;
}

export interface GapMeasures {
  from: string;
  to: string;
  /** Candidates opened in the window: weaknesses Brain detected, not recommendations anyone wrote. */
  identified: number;
  /**
   * Closed = decided KEPT, which `decideAfterMeasurement` reaches only when the
   * measured metric moved in production. A delivered or merged change is not
   * closed, and KEPT_NO_EFFECT is not a success.
   */
  closed: number;
  /** Closed candidates whose recorded history holds no OWNER_* event. The loop records none, so this is read, not assumed. */
  closedWithoutOwnerInput: number;
  /** Delivered (merged) but not shown to have worked: reported beside, never counted as success. */
  deliveredNotProven: number;
  /**
   * Median hours from first detection (`created_at`, which re-detection never
   * moves) to the moment the capability went into production use
   * (`delivered_at`, set once by the delivery the KEPT decision later proved),
   * over the gaps closed in the window. Never `updated_at`: that column moves
   * on every re-detection and patch, so it measures the last write, not use.
   */
  hoursToUseMedian: number | null;
  regressions: { reverted: number; keptNoEffect: number };
  /** The constructed-round yield, this window against the one before it, through the existing comparison. */
  goalQuality: Comparison;
  productiveWorkResumed: Unmeasured;
  cost: Unmeasured;
}

interface DecidedGap {
  id: string;
  decision: string;
  createdAt: string;
  deliveredAt: string | null;
  decidedAt: string;
}

/**
 * Each decided candidate once, at the time of the DECIDED event that recorded
 * its final decision (the earliest such event whose detail names that
 * decision), kept when that time falls in [from, to). A candidate with no such
 * event has no recorded decision time and is not counted in a window.
 */
export function decidedInWindow(
  rows: readonly { id: string; decision: string; created_at: string; delivered_at: string | null; detail: string; at: string }[],
  from: string,
  to: string,
): DecidedGap[] {
  const first = new Map<string, DecidedGap>();
  for (const row of rows) {
    let named: unknown;
    try {
      named = (JSON.parse(row.detail) as Record<string, unknown> | null)?.['decision'];
    } catch {
      named = undefined;
    }
    if (named !== row.decision) continue;
    const seen = first.get(row.id);
    if (!seen || row.at < seen.decidedAt) {
      first.set(row.id, { id: row.id, decision: row.decision, createdAt: row.created_at, deliveredAt: row.delivered_at, decidedAt: row.at });
    }
  }
  return [...first.values()].filter((g) => g.decidedAt >= from && g.decidedAt < to);
}

/** Gaps identified and closed over [from, to), counted from improvement rows. */
export async function readGapMeasures(from: string, to: string): Promise<GapMeasures> {
  const db = getDb();
  const [opened, decisions, delivered, owner] = await Promise.all([
    db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM improvement_candidates WHERE created_at >= ? AND created_at < ?', [from, to]),
    // The decision time is the append-only DECIDED event the loop writes beside
    // `decideCandidate`, never the row's `updated_at`.
    db.all<{ id: string; decision: string; created_at: string; delivered_at: string | null; detail: string; at: string }>(
      `SELECT c.id, c.decision, c.created_at, c.delivered_at, e.detail, e.at
         FROM improvement_candidates c
         JOIN improvement_events e ON e.candidate_id = c.id AND e.kind = 'DECIDED'
        WHERE c.decision IN ('KEPT', 'KEPT_NO_EFFECT', 'REVERTED')`,
      [],
    ),
    db.get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM improvement_candidates WHERE delivered_at >= ? AND delivered_at < ? AND (decision IS NULL OR decision <> 'KEPT')",
      [from, to],
    ),
    db.all<{ candidate_id: string }>(
      "SELECT DISTINCT candidate_id FROM improvement_events WHERE kind LIKE 'OWNER_%' AND candidate_id IS NOT NULL",
      [],
    ),
  ]);
  const decided = decidedInWindow(decisions, from, to);
  const kept = decided.filter((r) => r.decision === 'KEPT');
  const touched = new Set(owner.map((r) => r.candidate_id));
  const hours = kept
    .map((r) => (r.deliveredAt ? (Date.parse(r.deliveredAt) - Date.parse(r.createdAt)) / 3_600_000 : Number.NaN))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const median = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
  const span = Date.parse(to) - Date.parse(from);
  const before = new Date(Date.parse(from) - span).toISOString();
  const goalQuality = compare(await readMetric('CONSTRUCTED_ROUND_YIELD', before, from), await readMetric('CONSTRUCTED_ROUND_YIELD', from, to));
  return {
    from,
    to,
    identified: n(opened?.n),
    closed: kept.length,
    closedWithoutOwnerInput: kept.filter((r) => !touched.has(r.id)).length,
    deliveredNotProven: n(delivered?.n),
    hoursToUseMedian: median === null ? null : Number(median.toFixed(2)),
    regressions: {
      reverted: decided.filter((r) => r.decision === 'REVERTED').length,
      keptNoEffect: decided.filter((r) => r.decision === 'KEPT_NO_EFFECT').length,
    },
    goalQuality,
    productiveWorkResumed: { status: 'NOT_MEASURED', reason: 'no row links a closed gap to the work it released' },
    cost: { status: 'NOT_MEASURED', reason: 'no append-only entry attributes spend to a gap' },
  };
}
