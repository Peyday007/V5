/**
 * What the goal screen did, counted from rows.
 *
 * Every figure is a count of rows that already exist; nothing is estimated and
 * nothing is written. A decision is a `cash_decisions` row, a released piece of
 * research is a withdrawn need or a cancelled mission that belongs to an
 * opening Brain rejected, and a skipped question is a `QUESTION_SKIPPED` cash
 * event. A figure nothing has recorded reads 0 and the notes say so, because
 * zero rows is a measurement and a guess is not.
 *
 * "Claude jobs avoided" is the one derived figure and it is deliberately
 * narrow: an opening the code rejected that never had a deep dive started, plus
 * the questions the value-of-information step recorded as skipped. It does not
 * count research that was cancelled mid-way — that is "released", and it was
 * already spent in part.
 */
import { getDb } from '../../db/database.ts';
import { cashEventsOfKind, cashEventsOfKindInProject, recordCashEvent } from '../../repos/cashMode.ts';
import type { DecisionVerdict } from '../../domain/cashDecisions.ts';

/** The cash event kind a caller writes when a question is skipped for want of any decision it could change. */
export const QUESTION_SKIPPED_EVENT = 'QUESTION_SKIPPED';

export interface ScreenMetrics {
  decisions: Record<DecisionVerdict, number>;
  /** Decisions that were replaced by a later one (the history, not the present). */
  superseded: number;
  /** Current decisions by their stated reason, most common first. */
  byReason: Array<{ reason: string; verdict: DecisionVerdict; count: number }>;
  questionsSkipped: number;
  research: { needsWithdrawn: number; missionsCancelled: number };
  claudeJobsAvoided: { rejectedBeforeAnyDive: number; questionsSkipped: number; total: number };
  notes: string[];
  /**
   * The system-wide rolling 1h/6h/24h reading, each measure as numerator over an
   * explicit denominator (TEL-07-1). It is not scoped to the project: job queues,
   * provider failure and utilization belong to the whole Brain, and `telemetryLines`
   * is the same reading rendered for a report.
   */
  telemetry: RollingTelemetry;
  telemetryLines: string[];
}

/** The reading is built from a few dozen aggregate queries, so a screen that loads often reuses one for a minute. */
const TELEMETRY_TTL_MS = 60_000;
let cachedTelemetry: { at: number; reading: RollingTelemetry } | null = null;

/** The current telemetry reading, reused for up to a minute so a busy screen cannot multiply the load. */
export async function currentTelemetry(now: Date = new Date()): Promise<RollingTelemetry> {
  if (cachedTelemetry && now.getTime() - cachedTelemetry.at < TELEMETRY_TTL_MS && now.getTime() >= cachedTelemetry.at) {
    return cachedTelemetry.reading;
  }
  const reading = await rollingTelemetry(now);
  cachedTelemetry = { at: now.getTime(), reading };
  return reading;
}

const VERDICTS: readonly DecisionVerdict[] = ['REJECT', 'HOLD', 'PRIORITIZE'];

export async function screenMetrics(projectId: string, goalId?: string): Promise<ScreenMetrics> {
  const db = getDb();
  const goalSql = goalId ? ' AND goal_id = ?' : '';
  const args = goalId ? [projectId, goalId] : [projectId];

  const decisions: Record<DecisionVerdict, number> = { REJECT: 0, HOLD: 0, PRIORITIZE: 0 };
  const reasons = await db.all<{ verdict: DecisionVerdict; reason: string; n: number }>(
    `SELECT verdict, reason, COUNT(*) AS n FROM cash_decisions
      WHERE project_id = ?${goalSql} AND is_current = 1 GROUP BY verdict, reason`,
    args,
  );
  for (const row of reasons) if (VERDICTS.includes(row.verdict)) decisions[row.verdict] = (decisions[row.verdict] ?? 0) + Number(row.n);

  const sup = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_decisions WHERE project_id = ?${goalSql} AND is_current = 0`,
    args,
  );

  const rejected = await db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT d.opportunity_id) AS n FROM cash_decisions d
       JOIN cash_opportunities o ON o.id = d.opportunity_id
      WHERE d.project_id = ?${goalId ? ' AND d.goal_id = ?' : ''} AND d.is_current = 1 AND d.verdict = 'REJECT'
        AND o.validation_orchestration_id IS NULL`,
    args,
  );

  const rejectedIds = `SELECT DISTINCT opportunity_id FROM cash_decisions
                        WHERE project_id = ?${goalSql} AND is_current = 1 AND verdict = 'REJECT'`;
  const needs = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_needs
      WHERE state = 'WITHDRAWN' AND resolution LIKE 'Not researched:%' AND opportunity_id IN (${rejectedIds})`,
    args,
  );
  const missions = await db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT m.id) AS n FROM russell_missions m
       JOIN cash_opportunities o ON o.candidate_id = m.candidate_id
      WHERE m.state = 'CANCELLED' AND o.id IN (${rejectedIds})`,
    args,
  );

  const skipped = (await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).length;
  const rejectedBeforeAnyDive = Number(rejected?.n ?? 0);

  const telemetry = await currentTelemetry();

  const notes: string[] = [];
  if (skipped === 0) notes.push('No question has been recorded as skipped; 0 is the count of recorded rows, not a measurement of questions asked.');
  if (decisions.REJECT + decisions.HOLD + decisions.PRIORITIZE === 0) notes.push('No decision has been recorded for this scope yet.');

  return {
    decisions,
    superseded: Number(sup?.n ?? 0),
    byReason: reasons
      .map((r) => ({ reason: r.reason, verdict: r.verdict, count: Number(r.n) }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    questionsSkipped: skipped,
    research: { needsWithdrawn: Number(needs?.n ?? 0), missionsCancelled: Number(missions?.n ?? 0) },
    claudeJobsAvoided: { rejectedBeforeAnyDive, questionsSkipped: skipped, total: rejectedBeforeAnyDive + skipped },
    notes,
    telemetry,
    telemetryLines: formatTelemetry(telemetry),
  };
}


/**
 * Record that a question was not asked because no answer to it could change the
 * decision, once per (opening, question). A question already recorded is left
 * alone, so a tick that skips the same question again writes nothing - the
 * counter above counts decisions not to ask, not ticks that made them.
 */
export async function recordQuestionsSkipped(input: {
  projectId: string;
  opportunityId: string;
  fields: readonly string[];
  why: string;
}): Promise<number> {
  if (input.fields.length === 0) return 0;
  /*
   * Read this opening's own events through the (opportunity_id, kind) index.
   * This runs for every screened-out opening on every Cash tick, and reading
   * the whole project's QUESTION_SKIPPED history each time grew with openings
   * times events (production, 2026-10-31).
   */
  const held = new Set(
    (await cashEventsOfKind(input.opportunityId, QUESTION_SKIPPED_EVENT))
      .filter((event) => event.projectId === input.projectId)
      .map((event) => String((event.detail as { field?: unknown } | null)?.field ?? '')),
  );
  let recorded = 0;
  for (const field of input.fields) {
    if (held.has(field)) continue;
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunityId,
      kind: QUESTION_SKIPPED_EVENT,
      actorRef: 'BRAIN',
      summary: `Not asked: ${field}. ${input.why}`,
      detail: { field, why: input.why },
    });
    recorded += 1;
  }
  return recorded;
}

/* ------------------------------------------------------------------------- */
/* Rolling 1h / 6h / 24h telemetry (TEL-07-1)                                 */
/* ------------------------------------------------------------------------- */

/**
 * One reading of every measure the owner listed, over rolling one-hour,
 * six-hour and 24-hour windows, read from the rows on every call.
 *
 * Every figure carries its numerator, its denominator and its window, so a
 * rate is never a bare number, and a figure whose rows cannot be read is
 * `UNKNOWN` — never 0. A count of jobs is its own figure: `jobs` says how much
 * work was submitted, `usefulClaims` says how much of what was researched
 * survived the gate, and `actionableOpenings` says how much reached a
 * commercially usable state. None of the three is derived from another.
 *
 * Nothing here is a remembered figure. Earlier window readings are not
 * throughput and not a machine's ceiling; whoever considers adding CPU,
 * memory, GPU or model capacity reads this first, because it is current.
 */
export const TELEMETRY_WINDOWS = [
  { key: '1h', ms: 3_600_000 },
  { key: '6h', ms: 6 * 3_600_000 },
  { key: '24h', ms: 24 * 3_600_000 },
] as const;
export type TelemetryWindowKey = (typeof TELEMETRY_WINDOWS)[number]['key'];

export interface TelemetryFigure {
  measure: string;
  label: string;
  window: { key: TelemetryWindowKey; since: string; until: string };
  /** Rows that count. Null when they could not be read. */
  numerator: number | null;
  /** The rows it is out of, said in `denominatorIs`. Null when unknown. */
  denominator: number | null;
  denominatorIs: string;
  /**
   * What numerator and denominator are counted in. A rate is only defined when both are
   * counts of rows; MINOR_UNITS numerators (money) never divide by a row count.
   */
  numeratorUnit: 'COUNT' | 'MINOR_UNITS';
  /** numerator / denominator, or null when either is unknown, the denominator is zero, or the units differ. */
  rate: number | null;
  basis: 'ROWS' | 'UNKNOWN';
  /** Breakdown (by provider, purpose, state…) whose counts sum to the numerator, or null. */
  groups: Array<{ key: string; count: number }> | null;
  note: string | null;
}

export interface RollingTelemetry {
  at: string;
  windows: Record<TelemetryWindowKey, TelemetryFigure[]>;
}

type Reader = (since: string, until: string) => Promise<{ numeratorUnit?: 'MINOR_UNITS'; numerator: number; denominator: number | null; groups?: Array<{ key: string; count: number }>; note?: string }>;

interface Measure {
  measure: string;
  label: string;
  denominatorIs: string;
  read: Reader;
}

const n = (value: unknown): number => Number(value ?? 0);

async function one(sql: string, params: unknown[]): Promise<number> {
  const row = await getDb().get<{ n: number | string | null }>(sql, params as never[]);
  return n(row?.n);
}

async function grouped(sql: string, params: unknown[]): Promise<Array<{ key: string; count: number }>> {
  const rows = await getDb().all<{ k: string | null; n: number | string }>(sql, params as never[]);
  return rows.map((row) => ({ key: row.k ?? '(none)', count: n(row.n) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

const LANE = `event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ?`;

/**
 * The spans of the window during which a lane item was running, merged so that
 * overlapping items count once. An item's event is recorded when it ends, so it
 * spans `duration_ms` back from `at`; an event with no duration is a point.
 * Shared by two measures that report different facts about the same spans.
 */
async function laneBusyIntervals(
  since: string,
  until: string,
): Promise<{ merged: Array<[number, number]>; windowMs: number; startMs: number; endMs: number; items: number }> {
  const startMs = Date.parse(since);
  const endMs = Date.parse(until);
  const rows = await getDb().all<{ at: string; duration_ms: number | string | null }>(
    `SELECT at, duration_ms FROM bin_events WHERE ${LANE} ORDER BY at LIMIT 20000`,
    [since, until],
  );
  const spans: Array<[number, number]> = [];
  for (const row of rows) {
    const stop = Date.parse(row.at);
    if (!Number.isFinite(stop)) continue;
    const length = Math.max(0, n(row.duration_ms));
    const a = Math.max(startMs, stop - length);
    const b = Math.min(endMs, stop);
    if (b >= a) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return { merged, windowMs: Math.max(0, endMs - startMs), startMs, endMs, items: rows.length };
}

const MEASURES: readonly Measure[] = [
  {
    measure: 'jobs',
    label: 'research jobs submitted, by provider and purpose',
    denominatorIs: 'research jobs the lane attempted (submitted or failed)',
    read: async (since, until) => {
      const rows = await getDb().all<{ provider: string | null; purpose: string | null; outcome: string | null; c: number | string }>(
        `SELECT provider, workload_class AS purpose, outcome, COUNT(*) AS c FROM bin_events
          WHERE ${LANE} GROUP BY provider, workload_class, outcome`,
        [since, until],
      );
      const groups = new Map<string, number>();
      let submitted = 0;
      let total = 0;
      for (const row of rows) {
        total += n(row.c);
        if (row.outcome !== 'SUBMITTED') continue;
        submitted += n(row.c);
        const key = `${row.provider ?? '(none)'} / ${row.purpose ?? '(none)'}`;
        groups.set(key, (groups.get(key) ?? 0) + n(row.c));
      }
      return { numerator: submitted, denominator: total, groups: [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count) };
    },
  },
  {
    measure: 'claimsAccepted',
    label: 'claims accepted by the gate',
    denominatorIs: 'claims produced in the window',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ? AND accepted = 1`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?`, [since, until]),
    }),
  },
  {
    measure: 'claimsRejected',
    label: 'claims rejected by the gate, by reason',
    denominatorIs: 'claims produced in the window',
    read: async (since, until) => {
      const groups = await grouped(
        `SELECT COALESCE(rejection_reason, '(no reason recorded)') AS k, COUNT(*) AS n FROM research_claims
          WHERE created_at >= ? AND created_at < ? AND accepted = 0 GROUP BY k`,
        [since, until],
      );
      return {
        numerator: groups.reduce((sum, g) => sum + g.count, 0),
        denominator: await one(`SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?`, [since, until]),
        groups: groups.slice(0, 10),
      };
    },
  },
  {
    measure: 'usefulClaims',
    label: 'useful claims: accepted, sourced and not refuted',
    denominatorIs: 'claims produced in the window (not jobs)',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?
            AND accepted = 1 AND sourced = 1 AND contradiction_state <> 'REFUTED'`,
        [since, until],
      ),
      denominator: await one(`SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?`, [since, until]),
    }),
  },
  {
    measure: 'auditCompletion',
    label: 'audit passes that completed',
    denominatorIs: 'audit passes started in the window',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM audit_passes WHERE created_at >= ? AND created_at < ? AND ok = 1`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM audit_passes WHERE created_at >= ? AND created_at < ?`, [since, until]),
    }),
  },
  {
    measure: 'readableSources',
    label: 'readable source quality: claims whose source was retrieved',
    denominatorIs: 'claims produced in the window',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ? AND retrieval_state = 'RETRIEVED' AND sourced = 1`,
        [since, until],
      ),
      denominator: await one(`SELECT COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ?`, [since, until]),
      groups: await grouped(
        `SELECT retrieval_state AS k, COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at < ? GROUP BY retrieval_state`,
        [since, until],
      ),
    }),
  },
  {
    measure: 'openingsFiled',
    label: 'commercial openings filed',
    denominatorIs: 'openings recorded in the window, duplicates included',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL`,
        [since, until],
      ),
      denominator: await one(`SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ?`, [since, until]),
    }),
  },
  {
    measure: 'actionableOpenings',
    label: 'openings with real buyer, price and fulfiller evidence',
    denominatorIs: 'distinct openings filed in the window',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL
            AND payer IS NOT NULL AND price_cents IS NOT NULL AND fulfillment_owner IS NOT NULL AND buying_signal IS NOT NULL`,
        [since, until],
      ),
      denominator: await one(
        `SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL`,
        [since, until],
      ),
    }),
  },
  {
    measure: 'mechanismDiversity',
    label: 'distinct mechanisms among openings filed',
    denominatorIs: 'distinct openings filed in the window',
    read: async (since, until) => {
      const groups = await grouped(
        `SELECT mechanism AS k, COUNT(*) AS n FROM cash_opportunities
          WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL GROUP BY mechanism`,
        [since, until],
      );
      return {
        numerator: groups.length,
        denominator: groups.reduce((sum, g) => sum + g.count, 0),
        groups,
        note: 'variety of mechanism among filed openings; the count of constructed variants is not recorded as its own row, so it is not claimed',
      };
    },
  },
  {
    measure: 'usableOffers',
    label: 'usable offers: scope, acceptance condition and price all stated',
    denominatorIs: 'distinct openings filed in the window',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL
            AND offer_scope IS NOT NULL AND acceptance_condition IS NOT NULL AND price_cents IS NOT NULL`,
        [since, until],
      ),
      denominator: await one(
        `SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ? AND duplicate_of_id IS NULL`,
        [since, until],
      ),
    }),
  },
  {
    measure: 'salesAndReceipts',
    label: 'real receipts: settled funds',
    denominatorIs: 'verified customer payments recorded in the window',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM cash_money_entries WHERE kind = 'SETTLEMENT' AND created_at >= ? AND created_at < ?`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM cash_money_entries WHERE kind = 'CUSTOMER_PAYMENT' AND created_at >= ? AND created_at < ?`, [since, until]),
      groups: await grouped(
        `SELECT currency AS k, COALESCE(SUM(amount_cents), 0) AS n FROM cash_money_entries
          WHERE kind = 'SETTLEMENT' AND created_at >= ? AND created_at < ? GROUP BY currency`,
        [since, until],
      ),
      note: 'groups are settled minor units by currency, not a count',
    }),
  },
  {
    measure: 'queue',
    label: 'work waiting in the queue now',
    denominatorIs: 'work items that exist and are not finished (queued or leased), at the time of reading',
    read: async () => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM work_items WHERE state = 'QUEUED'`, []),
      denominator: await one(`SELECT COUNT(*) AS n FROM work_items WHERE state IN ('QUEUED', 'LEASED')`, []),
      groups: await grouped(`SELECT work_type AS k, COUNT(*) AS n FROM work_items WHERE state = 'QUEUED' GROUP BY work_type`, []),
      note: 'a queue is a state, so every window reads it as of now',
    }),
  },
  {
    measure: 'utilization',
    label: 'utilization: share of the window with lane work running',
    denominatorIs: 'milliseconds in the window',
    read: async (since, until) => {
      const { merged, windowMs, items } = await laneBusyIntervals(since, until);
      const busyMs = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
      return {
        numerator: busyMs,
        denominator: windowMs,
        note: `wall-clock covered by at least one lane item (each item spans its recorded duration back from its event, overlaps counted once), over ${items} item(s); work that began before the window and ended inside it counts only the part inside`,
      };
    },
  },
  {
    // A different fact from utilization: the longest unbroken stretch with nothing running, which is what shows
    // capacity left idle in one piece. Busy coverage and longest gap are not complements: a window can be half
    // covered by many short gaps or by one long one, and only the second leaves a block of capacity unused.
    measure: 'idleTime',
    label: 'idle time: the longest unbroken stretch of the window with no lane work',
    denominatorIs: 'milliseconds in the window',
    read: async (since, until) => {
      const { merged, windowMs, startMs, endMs, items } = await laneBusyIntervals(since, until);
      let longest = 0;
      let cursor = startMs;
      for (const [a, b] of merged) {
        longest = Math.max(longest, a - cursor);
        cursor = Math.max(cursor, b);
      }
      longest = Math.max(longest, endMs - cursor);
      return { numerator: longest, denominator: windowMs, note: `gaps between merged lane items and at both edges of the window, over ${items} item(s)` };
    },
  },
  {
    measure: 'retries',
    label: 'work items that needed more than one attempt',
    denominatorIs: 'work items updated in the window',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM work_items WHERE updated_at >= ? AND updated_at < ? AND attempt_count > 1`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM work_items WHERE updated_at >= ? AND updated_at < ?`, [since, until]),
    }),
  },
  {
    measure: 'providerFailure',
    label: 'provider failures: lane jobs whose model call failed',
    denominatorIs: 'research jobs the lane attempted',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM bin_events WHERE ${LANE} AND reason LIKE '%model call failed%'`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM bin_events WHERE ${LANE}`, [since, until]),
      groups: await grouped(
        `SELECT COALESCE(provider, '(none)') AS k, COUNT(*) AS n FROM bin_events WHERE ${LANE} AND reason LIKE '%model call failed%' GROUP BY k`,
        [since, until],
      ),
    }),
  },
  {
    measure: 'providerQuota',
    label: 'provider quota pauses begun',
    denominatorIs: 'research jobs the lane attempted',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM quota_pauses WHERE paused_at >= ? AND paused_at < ?`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM bin_events WHERE ${LANE}`, [since, until]),
      groups: await grouped(`SELECT provider AS k, COUNT(*) AS n FROM quota_pauses WHERE paused_at >= ? AND paused_at < ? GROUP BY provider`, [since, until]),
    }),
  },
  {
    measure: 'cost',
    label: 'cost actually paid, minor units',
    denominatorIs: 'cost entries recorded in the window',
    read: async (since, until) => ({
      numeratorUnit: 'MINOR_UNITS',
      numerator: await one(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM cash_money_entries WHERE kind = 'COST' AND created_at >= ? AND created_at < ?`, [since, until]),
      denominator: await one(`SELECT COUNT(*) AS n FROM cash_money_entries WHERE kind = 'COST' AND created_at >= ? AND created_at < ?`, [since, until]),
      note: 'numerator is minor units and denominator is an entry count, so no rate is computed; model and compute run on subscriptions and record no per-job cost, so their cost is not included and not claimed to be zero',
    }),
  },
  {
    measure: 'improvementPrOutcomes',
    label: 'improvement changes delivered and decided',
    denominatorIs: 'improvement changes delivered in the window',
    read: async (since, until) => ({
      numerator: await one(
        `SELECT COUNT(*) AS n FROM improvement_candidates WHERE delivered_at >= ? AND delivered_at < ? AND decision IN ('KEPT')`,
        [since, until],
      ),
      denominator: await one(`SELECT COUNT(*) AS n FROM improvement_candidates WHERE delivered_at >= ? AND delivered_at < ?`, [since, until]),
      groups: await grouped(
        `SELECT COALESCE(decision, 'UNDECIDED') AS k, COUNT(*) AS n FROM improvement_candidates
          WHERE delivered_at >= ? AND delivered_at < ? GROUP BY k`,
        [since, until],
      ),
      note: 'numerator is changes kept for a measured effect; a merged change with no measured effect is not counted as success',
    }),
  },
];

/** Every measure over every window, read now. A measure that cannot be read is UNKNOWN for that window, never zero. */
export async function rollingTelemetry(now: Date = new Date()): Promise<RollingTelemetry> {
  const until = now.toISOString();
  const windows = {} as Record<TelemetryWindowKey, TelemetryFigure[]>;
  for (const window of TELEMETRY_WINDOWS) {
    const since = new Date(now.getTime() - window.ms).toISOString();
    windows[window.key] = await Promise.all(
      MEASURES.map(async (m): Promise<TelemetryFigure> => {
        const base = { measure: m.measure, label: m.label, window: { key: window.key, since, until }, denominatorIs: m.denominatorIs };
        try {
          const read = await m.read(since, until);
          const numeratorUnit = read.numeratorUnit ?? 'COUNT';
          const rate = numeratorUnit === 'COUNT' && read.denominator !== null && read.denominator > 0 ? read.numerator / read.denominator : null;
          return { ...base, numeratorUnit, numerator: read.numerator, denominator: read.denominator, rate, basis: 'ROWS', groups: read.groups ?? null, note: read.note ?? null };
        } catch (error) {
          return {
            ...base,
            numerator: null,
            denominator: null,
            numeratorUnit: 'COUNT',
            rate: null,
            basis: 'UNKNOWN',
            groups: null,
            note: `unreadable: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}`,
          };
        }
      }),
    );
  }
  return { at: until, windows };
}

/** The measures a reading must carry, for whoever checks it is complete. */
export function telemetryMeasureKeys(): string[] {
  return MEASURES.map((m) => m.measure);
}

/** Lines for a report: one row per measure, a column per window, each as numerator/denominator. */
export function formatTelemetry(reading: RollingTelemetry): string[] {
  const cell = (f: TelemetryFigure): string =>
    f.basis === 'UNKNOWN' ? 'unknown' : f.numeratorUnit === 'MINOR_UNITS' ? `${f.numerator} minor units over ${f.denominator === null ? 'unknown' : f.denominator} entries` : `${f.numerator}/${f.denominator === null ? 'unknown' : f.denominator}${f.rate === null ? '' : ` (${(f.rate * 100).toFixed(1)}%)`}`;
  const lines = [`TELEMETRY at ${reading.at.slice(0, 19)}Z (numerator/denominator; read from rows now)`];
  for (const [index, m] of MEASURES.entries()) {
    lines.push(`  ${m.measure.padEnd(22)} ${TELEMETRY_WINDOWS.map((w) => `${w.key} ${cell(reading.windows[w.key][index]!)}`).join('   ')}`);
  }
  return lines;
}
