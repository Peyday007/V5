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

/** Drop the reused reading, so the next capacity decision or screen reads the rows again. */
export function forgetTelemetryReading(): void {
  cachedTelemetry = null;
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

/** A constructed arrangement's round: `openConstructedRound` names its bucket `goal-<goalId>-mx-<key>` (§81). */
const CONSTRUCTED_BUCKET_LIKE = 'goal-%-mx-%';

const LANE = `event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ?`;

/*
 * Work reaches a provider by two paths, and a figure labelled as the system's
 * reads both (§85, §98). The free lane drains work items in-process and writes
 * one `FREE_LANE_ITEM` per item. Everything else is a bin dispatched to a
 * worker: `DISPATCH_SENT` when Brain fires a surface, `BIN_ASSIGNED` when a
 * session takes the bin, a lease held until `BIN_TERMINAL`, `BIN_RELEASED`,
 * `BIN_LEASE_EXPIRED` or a `BIN_TAKEOVER`, and a no-show row when a fire never
 * produced a session.
 */

/** A bin handed to a worker in the window — one dispatched job begun. Alias `e`. */
const BIN_JOB = `e.event_type = 'BIN_ASSIGNED' AND e.at >= ? AND e.at < ?`;

/**
 * Who ran a dispatched job. An assignment carries no provider; the fire that
 * started it does, so it is the latest `DISPATCH_SENT` for that bin at or before
 * the event. A worker that arrived with no fire on record reads `(none)` — an
 * unknown provider stays unknown rather than being filled with a guess.
 */
const BIN_PROVIDER = `COALESCE(e.provider,
  (SELECT d.provider FROM bin_events d
    WHERE d.event_type = 'DISPATCH_SENT' AND d.bin_id = e.bin_id AND d.at <= e.at
    ORDER BY d.at DESC LIMIT 1),
  '(none)')`;

/** Fires no session ever took up, whoever is charged with the miss. Counted as attempted, never as submitted. */
const UNSTARTED = `event_type IN ('DISPATCH_NO_SHOW', 'DISPATCH_AUTH_NO_SHOW', 'DISPATCH_INFRA_NO_SHOW') AND at >= ? AND at < ?`;

/** Attempts that reached a provider: free-lane items plus fires Brain sent. */
async function providerAttempts(since: string, until: string): Promise<number> {
  return (
    (await one(`SELECT COUNT(*) AS n FROM bin_events WHERE ${LANE}`, [since, until])) +
    (await one(`SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'DISPATCH_SENT' AND at >= ? AND at < ?`, [since, until]))
  );
}

const sumGroups = (...lists: Array<Array<{ key: string; count: number }>>): Array<{ key: string; count: number }> => {
  const totals = new Map<string, number>();
  for (const list of lists) for (const g of list) totals.set(g.key, (totals.get(g.key) ?? 0) + g.count);
  return [...totals].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

/** How far before the window a lease still open at its start is looked for. */
const LEASE_LOOKBACK_MS = 24 * 3_600_000;
const LEASE_OPENS = new Set(['BIN_ASSIGNED', 'BIN_TAKEOVER']);
const LEASE_CLOSES = new Set(['BIN_TERMINAL', 'BIN_RELEASED', 'BIN_LEASE_EXPIRED']);

/**
 * The spans during which a worker held a bin's lease, clipped to the window.
 *
 * Read from each bin's own events in order: an assignment or takeover opens a
 * lease; a terminal, release, expiry or the next takeover closes it. A lease
 * whose close is not in the rows runs to the window's end only if the bin is
 * LEASED at that generation now; otherwise it ends at its last heartbeat or
 * checkpoint, because nothing says it ran past that.
 */
async function binLeaseSpans(startMs: number, endMs: number, until: string): Promise<{ spans: Array<[number, number]>; leases: number }> {
  const from = new Date(startMs - LEASE_LOOKBACK_MS).toISOString();
  const rows = await getDb().all<{ bin_id: string; event_type: string; at: string; lease_generation: number | string | null }>(
    `SELECT bin_id, event_type, at, lease_generation FROM bin_events
      WHERE bin_id IS NOT NULL AND at >= ? AND at < ?
        AND event_type IN ('BIN_ASSIGNED', 'BIN_TAKEOVER', 'BIN_TERMINAL', 'BIN_RELEASED', 'BIN_LEASE_EXPIRED')
      ORDER BY bin_id, at LIMIT 50000`,
    [from, until],
  );
  const beats = await getDb().all<{ bin_id: string; lease_generation: number | string | null; last_at: string }>(
    `SELECT bin_id, lease_generation, MAX(at) AS last_at FROM bin_events
      WHERE bin_id IS NOT NULL AND at >= ? AND at < ? AND event_type IN ('BIN_HEARTBEAT', 'BIN_CHECKPOINT')
      GROUP BY bin_id, lease_generation`,
    [from, until],
  );
  const lastBeat = new Map(beats.map((b) => [`${b.bin_id}#${n(b.lease_generation)}`, Date.parse(b.last_at)]));
  const held = await getDb().all<{ id: string; lease_generation: number | string }>(`SELECT id, lease_generation FROM bins WHERE state = 'LEASED'`, []);
  const heldNow = new Set(held.map((h) => `${h.id}#${n(h.lease_generation)}`));

  const spans: Array<[number, number]> = [];
  const clip = (a: number, b: number) => {
    const lo = Math.max(startMs, a);
    const hi = Math.min(endMs, b);
    if (hi >= lo && b >= startMs && a <= endMs) spans.push([lo, hi]);
  };
  let bin: string | null = null;
  let open: { at: number; generation: number } | null = null;
  const settle = () => {
    if (!open || bin === null) return;
    const key = `${bin}#${open.generation}`;
    clip(open.at, heldNow.has(key) ? endMs : Math.max(open.at, lastBeat.get(key) ?? open.at));
    open = null;
  };
  for (const row of rows) {
    if (row.bin_id !== bin) {
      settle();
      bin = row.bin_id;
    }
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    if (LEASE_OPENS.has(row.event_type)) {
      if (open) clip(open.at, at);
      open = { at, generation: n(row.lease_generation) };
    } else if (LEASE_CLOSES.has(row.event_type) && open) {
      clip(open.at, at);
      open = null;
    }
  }
  settle();
  return { spans, leases: spans.length };
}

/**
 * The spans of the window during which any work was running — a free-lane
 * item or a bin lease a worker held — merged so overlapping work counts once.
 * A lane item's event is recorded when it ends, so it spans `duration_ms` back
 * from `at`; an event with no duration is a point. Shared by two measures that
 * report different facts about the same spans.
 */
async function workBusyIntervals(
  since: string,
  until: string,
): Promise<{ merged: Array<[number, number]>; windowMs: number; startMs: number; endMs: number; items: number; leases: number }> {
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
  const bins = await binLeaseSpans(startMs, endMs, until);
  spans.push(...bins.spans);
  spans.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return { merged, windowMs: Math.max(0, endMs - startMs), startMs, endMs, items: rows.length, leases: bins.leases };
}

const MEASURES: readonly Measure[] = [
  {
    measure: 'jobs',
    label: 'research jobs submitted, by provider and purpose (free lane and dispatched bins)',
    denominatorIs: 'jobs attempted: free-lane items (submitted or failed), bins handed to a worker, and fired bins no session took up',
    read: async (since, until) => {
      const lane = await getDb().all<{ provider: string | null; purpose: string | null; outcome: string | null; c: number | string }>(
        `SELECT provider, workload_class AS purpose, outcome, COUNT(*) AS c FROM bin_events
          WHERE ${LANE} GROUP BY provider, workload_class, outcome`,
        [since, until],
      );
      const dispatched = await getDb().all<{ provider: string | null; purpose: string | null; c: number | string }>(
        `SELECT provider, purpose, COUNT(*) AS c FROM (
           SELECT ${BIN_PROVIDER} AS provider, COALESCE(e.workload_class, b.workload_class, b.kind) AS purpose
             FROM bin_events e LEFT JOIN bins b ON b.id = e.bin_id
            WHERE ${BIN_JOB}
         ) jobs GROUP BY provider, purpose`,
        [since, until],
      );
      const unstarted = await one(`SELECT COUNT(*) AS n FROM bin_events WHERE ${UNSTARTED}`, [since, until]);
      const groups = new Map<string, number>();
      const add = (provider: string | null, purpose: string | null, count: number) => {
        const key = `${provider ?? '(none)'} / ${purpose ?? '(none)'}`;
        groups.set(key, (groups.get(key) ?? 0) + count);
      };
      let laneSubmitted = 0;
      let laneTotal = 0;
      let binJobs = 0;
      for (const row of lane) {
        laneTotal += n(row.c);
        if (row.outcome !== 'SUBMITTED') continue;
        laneSubmitted += n(row.c);
        add(row.provider, row.purpose, n(row.c));
      }
      for (const row of dispatched) {
        binJobs += n(row.c);
        add(row.provider, row.purpose, n(row.c));
      }
      return {
        numerator: laneSubmitted + binJobs,
        denominator: laneTotal + binJobs + unstarted,
        groups: [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
        note: `${laneSubmitted} of ${laneTotal} free-lane item(s) submitted; ${binJobs} bin(s) handed to a worker; ${unstarted} fired bin(s) no session took up count in the denominator only. A job count is not useful claims (usefulClaims) or actionable findings (actionableOpenings)`,
      };
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
        note: 'variety of mechanism among filed openings; the variants Brain constructed itself are counted by constructedVariants',
      };
    },
  },
  {
    /*
     * A constructed arrangement (§81-83) is asked through `openConstructedRound`,
     * which records it as an ordinary discovery round whose bucket id is
     * `goal-<goalId>-mx-<key>`: the key is the arrangement's design, so one
     * bucket id is one constructed variant and each further round re-asks it.
     */
    measure: 'constructedVariants',
    label: 'constructed variants: rounds asking an arrangement Brain composed itself, by state',
    denominatorIs: 'discovery rounds opened in the window, constructed or not',
    read: async (since, until) => {
      const groups = await grouped(
        `SELECT state AS k, COUNT(*) AS n FROM cash_discovery_rounds
          WHERE opened_at >= ? AND opened_at < ? AND bucket_id LIKE '${CONSTRUCTED_BUCKET_LIKE}' GROUP BY state`,
        [since, until],
      );
      const distinct = await one(
        `SELECT COUNT(DISTINCT bucket_id) AS n FROM cash_discovery_rounds
          WHERE opened_at >= ? AND opened_at < ? AND bucket_id LIKE '${CONSTRUCTED_BUCKET_LIKE}'`,
        [since, until],
      );
      const found = await one(
        `SELECT COUNT(*) AS n FROM cash_discovery_rounds
          WHERE opened_at >= ? AND opened_at < ? AND bucket_id LIKE '${CONSTRUCTED_BUCKET_LIKE}' AND found > 0`,
        [since, until],
      );
      return {
        numerator: groups.reduce((sum, g) => sum + g.count, 0),
        denominator: await one(`SELECT COUNT(*) AS n FROM cash_discovery_rounds WHERE opened_at >= ? AND opened_at < ?`, [since, until]),
        groups,
        note: `${distinct} distinct constructed variant(s) asked; ${found} round(s) found at least one opening`,
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
    label: 'utilization: share of the window with work running (a free-lane item or a bin a worker held)',
    denominatorIs: 'milliseconds in the window',
    read: async (since, until) => {
      const { merged, windowMs, items, leases } = await workBusyIntervals(since, until);
      const busyMs = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
      return {
        numerator: busyMs,
        denominator: windowMs,
        note: `wall-clock covered by at least one free-lane item or held bin lease (a lane item spans its recorded duration back from its event, a lease spans assignment to its close; overlaps counted once), over ${items} lane item(s) and ${leases} lease span(s); work that began before the window counts only the part inside`,
      };
    },
  },
  {
    // A different fact from utilization: the longest unbroken stretch with nothing running, which is what shows
    // capacity left idle in one piece. Busy coverage and longest gap are not complements: a window can be half
    // covered by many short gaps or by one long one, and only the second leaves a block of capacity unused.
    measure: 'idleTime',
    label: 'idle time: the longest unbroken stretch of the window with no work running on either path',
    denominatorIs: 'milliseconds in the window',
    read: async (since, until) => {
      const { merged, windowMs, startMs, endMs, items, leases } = await workBusyIntervals(since, until);
      let longest = 0;
      let cursor = startMs;
      for (const [a, b] of merged) {
        longest = Math.max(longest, a - cursor);
        cursor = Math.max(cursor, b);
      }
      longest = Math.max(longest, endMs - cursor);
      return { numerator: longest, denominator: windowMs, note: `gaps between merged work spans and at both edges of the window, over ${items} lane item(s) and ${leases} lease span(s)` };
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
    label: 'provider failures: free-lane model calls that failed, and fired bins whose surface never produced a session',
    denominatorIs: 'attempts that reached a provider: free-lane items plus bin dispatches sent',
    read: async (since, until) => {
      const groups = sumGroups(
        await grouped(
          `SELECT COALESCE(provider, '(none)') AS k, COUNT(*) AS n FROM bin_events WHERE ${LANE} AND reason LIKE '%model call failed%' GROUP BY k`,
          [since, until],
        ),
        await grouped(
          `SELECT k, COUNT(*) AS n FROM (SELECT ${BIN_PROVIDER} AS k FROM bin_events e
             WHERE e.event_type = 'DISPATCH_NO_SHOW' AND e.at >= ? AND e.at < ?) misses GROUP BY k`,
          [since, until],
        ),
      );
      return {
        numerator: groups.reduce((sum, g) => sum + g.count, 0),
        denominator: await providerAttempts(since, until),
        groups,
        note: "a no-show charged to the connector's authentication or to Brain's own outage is not the provider's and is not counted",
      };
    },
  },
  {
    measure: 'providerQuota',
    label: 'provider quota pauses begun',
    denominatorIs: 'attempts that reached a provider: free-lane items plus bin dispatches sent',
    read: async (since, until) => ({
      numerator: await one(`SELECT COUNT(*) AS n FROM quota_pauses WHERE paused_at >= ? AND paused_at < ?`, [since, until]),
      denominator: await providerAttempts(since, until),
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

/* ------------------------------------------------------------------------- */
/* Capacity changes read fresh telemetry first (TEL-07-1, S-0083)             */
/* ------------------------------------------------------------------------- */

/**
 * What a capacity change adds. CPU, memory, GPU and model are machine
 * capacity; CONCURRENCY is how much of the existing fleet one grant may hold at
 * once — provider capacity, and an increase of it is an upgrade too.
 */
export type CapacityResource = 'CPU' | 'MEMORY' | 'GPU' | 'MODEL' | 'CONCURRENCY';

export interface CapacityProposal {
  resource: CapacityResource;
  direction: 'INCREASE' | 'DECREASE';
  from?: number | null;
  to?: number | null;
  /** Who is asking and why, for the record of the decision. */
  reason: string;
}

export interface CapacityGateDecision {
  allowed: boolean;
  /** FRESH_READING, NOT_AN_UPGRADE, or why it was refused. */
  code: 'FRESH_READING' | 'NOT_AN_UPGRADE' | 'STALE_READING' | 'UNREADABLE_TELEMETRY' | 'NOTHING_WAITING' | 'CAPACITY_IDLE';
  reason: string;
  /** When the reading the decision rests on was taken, and how old it was. Null only when no reading was needed. */
  readingAt: string | null;
  readingAgeMs: number | null;
  /** The figures the decision read, every window, so the decision can be replayed. */
  figures: TelemetryFigure[];
}

/**
 * How old a reading may be and still decide a capacity change. A reading is a
 * measurement of the present; one older than this is history, and earlier
 * window readings are "NOT a reliable daily throughput estimate or a current
 * machine-capacity ceiling" (S-0083).
 */
export const CAPACITY_READING_MAX_AGE_MS = 5 * 60_000;

/** The measures a capacity decision rests on. Any of them unreadable in any window refuses the change. */
export const CAPACITY_DECIDING_MEASURES = ['queue', 'utilization', 'idleTime', 'providerFailure', 'providerQuota'] as const;

/** A machine upgrade beside capacity that sat idle this long in one piece within the last hour buys idle capacity. */
export const CAPACITY_IDLE_REFUSAL_MS = 10 * 60_000;

const MACHINE: ReadonlySet<CapacityResource> = new Set(['CPU', 'MEMORY', 'GPU', 'MODEL']);

/**
 * The one gate every capacity upgrade passes: it reads current production
 * telemetry (or checks the reading it was handed is current) and refuses the
 * upgrade without it.
 *
 * - A reading older than `CAPACITY_READING_MAX_AGE_MS`, or dated in the future,
 *   refuses: a remembered figure is not a reading.
 * - Any deciding measure that is UNKNOWN in any window refuses: an unknown is
 *   never read as a favourable assumption (§7.39).
 * - A machine upgrade (CPU, memory, GPU, model) is refused when the fresh
 *   reading shows nothing waiting, or capacity idle in one piece for
 *   `CAPACITY_IDLE_REFUSAL_MS` within the last hour — more of a machine that is
 *   not saturated is not what is short.
 *
 * A decrease is not an upgrade and is not gated here. Pure apart from the read,
 * so a caller can pass the reading it already holds and the decision replays.
 */
export async function capacityChangeGate(
  proposal: CapacityProposal,
  options: { now?: Date; reading?: RollingTelemetry } = {},
): Promise<CapacityGateDecision> {
  if (proposal.direction === 'DECREASE') {
    return { allowed: true, code: 'NOT_AN_UPGRADE', reason: `${proposal.resource} decrease is not an upgrade; no reading needed`, readingAt: null, readingAgeMs: null, figures: [] };
  }
  const now = options.now ?? new Date();
  const reading = options.reading ?? (await currentTelemetry(now));
  const age = now.getTime() - Date.parse(reading.at);
  const deciding = TELEMETRY_WINDOWS.flatMap((w) =>
    reading.windows[w.key].filter((f) => (CAPACITY_DECIDING_MEASURES as readonly string[]).includes(f.measure)),
  );
  const base = { readingAt: reading.at, readingAgeMs: Number.isFinite(age) ? age : null, figures: deciding };
  if (!Number.isFinite(age) || age < 0 || age > CAPACITY_READING_MAX_AGE_MS) {
    return {
      ...base,
      allowed: false,
      code: 'STALE_READING',
      reason: `${proposal.resource} upgrade refused: the telemetry reading is ${Number.isFinite(age) ? `${Math.round(age / 1000)}s old` : 'undated'}, and a capacity change needs one no older than ${CAPACITY_READING_MAX_AGE_MS / 1000}s`,
    };
  }
  const missing = CAPACITY_DECIDING_MEASURES.filter(
    (measure) => !TELEMETRY_WINDOWS.every((w) => reading.windows[w.key].some((f) => f.measure === measure && f.basis === 'ROWS')),
  );
  if (missing.length > 0) {
    return {
      ...base,
      allowed: false,
      code: 'UNREADABLE_TELEMETRY',
      reason: `${proposal.resource} upgrade refused: ${missing.join(', ')} could not be read in every window, and an unknown never favours a change`,
    };
  }
  if (MACHINE.has(proposal.resource)) {
    const figure = (measure: string, key: TelemetryWindowKey) => reading.windows[key].find((f) => f.measure === measure)!;
    const waiting = figure('queue', '1h').numerator ?? 0;
    if (waiting === 0) {
      return { ...base, allowed: false, code: 'NOTHING_WAITING', reason: `${proposal.resource} upgrade refused: the fresh reading shows 0 work items waiting, so added capacity would sit idle` };
    }
    const idle = figure('idleTime', '1h');
    if ((idle.numerator ?? 0) >= CAPACITY_IDLE_REFUSAL_MS) {
      return {
        ...base,
        allowed: false,
        code: 'CAPACITY_IDLE',
        reason: `${proposal.resource} upgrade refused: in the last hour nothing ran on either path for ${Math.round((idle.numerator ?? 0) / 60_000)} min in one piece (of ${Math.round((idle.denominator ?? 0) / 60_000)} min), so the capacity it has is not saturated`,
      };
    }
  }
  return {
    ...base,
    allowed: true,
    code: 'FRESH_READING',
    reason: `${proposal.resource} upgrade rests on a telemetry reading ${Math.round(age / 1000)}s old with every deciding measure readable`,
  };
}
