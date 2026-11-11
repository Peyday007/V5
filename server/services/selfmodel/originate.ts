/**
 * Brain originating its own work from what it observes (AUTO-20-1, §87/§88).
 *
 * The improvement loop's other detectors read failure records: a free-lane
 * failure class, a rejected claim, a packet that stopped short, an owner who
 * had to step in. Those are failure patterns. This module covers the other
 * observations the requirement names, from rows only, where nothing has failed
 * yet and nobody asked:
 *
 *   GOAL_CONSTRAINT     a live goal near or past its due date with no recorded
 *                       movement: the constraint is the date, not an error
 *   IDLE_CAPACITY       executable work sat beside eligible, unused capacity
 *                       (the watchdog's rule-9 rows, and free-lane idle rows)
 *   MISSED_OPPORTUNITY  openings whose own expiry passed while they were
 *                       never taken up
 *   SHARED_NEED         one missing resource or capability (`cash_needs`)
 *                       holding up several opportunities at once
 *
 * Each becomes a `Weakness`, so it reaches Factory or research through the
 * same candidate, method and measurement path as any other (§10.3): no
 * scheduler, table or authority path is added. Keys are by what is weak,
 * never by one row, so a recurring condition is one candidate and, after a
 * decided attempt, a new attempt rather than a duplicate.
 *
 * The thresholds below decide only whether a condition is worth a candidate.
 * They are not a whitelist of kinds of work (R01-A1): the problem text records
 * the measured figures behind each judgment, so a later reader can see why it
 * was raised, and an unknown figure is never read as a favourable one.
 */
import { getDb } from '../../db/database.ts';
import type { Weakness } from '../../domain/improvement.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A goal due within this many days, with no movement in `GOAL_QUIET_HOURS`, is constrained. */
export const GOAL_DUE_WITHIN_DAYS = 14;
export const GOAL_QUIET_HOURS = 72;
/** Rule-9 idle windows in a day (each is at most one row per ten minutes) that make a pattern. */
export const IDLE_MIN_WINDOWS = 3;
/** Lapsed openings in a week that make a pattern. */
export const MISSED_MIN = 2;
/** Distinct opportunities one open need must hold up. */
export const SHARED_NEED_MIN = 2;
/** At most this many shared needs a pass, most consequential first. */
export const SHARED_NEED_LIMIT = 3;

export interface GoalObservation {
  id: string;
  title: string;
  dueAt: string;
  /** The latest recorded movement: a register event or a plan reading. Null when none. */
  lastMovementAt: string | null;
}

export interface OpportunityObservation {
  id: string;
  title: string;
  state: string;
  expiresAt: string;
}

export interface NeedObservation {
  /** What is missing, as the need row names it (`blocker_key`, else `blocked_action`). */
  key: string;
  blockedAction: string;
  opportunityIds: string[];
  expectedCostCents: number | null;
}

export interface OriginObservations {
  now: Date;
  /** Live, unpaused goals that have a due date. */
  goals: GoalObservation[];
  /** Rule-9 rows in the last day. */
  idleWindows: number;
  /** Free-lane idle-with-work rows in the last day, when known. */
  freeLaneIdle: number | null;
  /** Opportunities whose expiry fell in the last week, whatever their state. */
  expired: OpportunityObservation[];
  needs: NeedObservation[];
}

/** States in which an opening was never taken up. */
const UNTAKEN = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY']);

function clip(text: string, n = 160): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
}

/** The weaknesses these observations justify. Pure: the same rows give the same answer. */
export function originateFromObservations(o: OriginObservations): Weakness[] {
  const out: Weakness[] = [];
  const now = o.now.getTime();

  // Goal constraints: a due date approaching with nothing moving.
  const quietBefore = now - GOAL_QUIET_HOURS * HOUR;
  const stalled = o.goals.filter((g) => {
    const due = Date.parse(g.dueAt);
    if (!Number.isFinite(due) || due - now > GOAL_DUE_WITHIN_DAYS * DAY) return false;
    const moved = g.lastMovementAt ? Date.parse(g.lastMovementAt) : NaN;
    return !Number.isFinite(moved) || moved < quietBefore;
  });
  if (stalled.length > 0) {
    const overdue = stalled.filter((g) => Date.parse(g.dueAt) <= now).length;
    out.push({
      key: 'ORIGIN:GOAL_CONSTRAINT.stalled-near-due',
      kind: 'ORIGIN_GOAL_CONSTRAINT',
      title: `${stalled.length} goal(s) due within ${GOAL_DUE_WITHIN_DAYS} days with no movement for ${GOAL_QUIET_HOURS}h`,
      problem:
        `${stalled.length} of ${o.goals.length} dated live goal(s) are due within ${GOAL_DUE_WITHIN_DAYS} days (${overdue} already past due) ` +
        `and have no register event or plan reading in ${GOAL_QUIET_HOURS}h. Nothing failed: the goal is waiting on work nobody originated. ` +
        'Find what each is missing (a capability, a source, a decision path) and originate that work.',
      metric: 'OBJECTIVE_HOURS_MEDIAN',
      downstreamMetric: 'READY_OPPORTUNITIES_PER_DAY',
      ownerComponent: 'server/services/goals/goalWork.ts',
      mutationScope: ['server/services/goals/**'],
      frequency: stalled.length,
      denominator: Math.max(o.goals.length, stalled.length),
      scope: 'GENERAL',
      severity: overdue > 0 ? 'HIGH' : 'MEDIUM',
      researchQuestion: 'goal deadline no progress missing capability work origination',
      samples: stalled.slice(0, 5).map((g) => clip(`${g.title} — due ${g.dueAt.slice(0, 10)}, last movement ${g.lastMovementAt?.slice(0, 16) ?? 'never'}`)),
      knownCause: null,
    });
  }

  // Idle resources: executable work beside unused capacity.
  const idle = o.idleWindows + (o.freeLaneIdle ?? 0);
  if (idle >= IDLE_MIN_WINDOWS) {
    out.push({
      key: 'ORIGIN:IDLE_CAPACITY.idle-beside-work',
      kind: 'ORIGIN_IDLE_CAPACITY',
      title: `Capacity idle beside executable work in ${idle} recorded window(s) in 24h`,
      problem:
        `The rule-9 watchdog recorded ${o.idleWindows} idle-with-executable-work window(s) in the last day` +
        (o.freeLaneIdle === null ? '' : ` and the free lane ${o.freeLaneIdle} idle-with-work row(s)`) +
        '. Capacity that could have run work did not: find why dispatch did not feed it and fix the cause.',
      metric: 'OBJECTIVE_HOURS_MEDIAN',
      downstreamMetric: null,
      ownerComponent: 'server/services/dispatch/loop.ts',
      mutationScope: ['server/services/dispatch/**', 'server/services/freeLane/capacity.ts', 'server/services/engineering/watchdog.ts'],
      frequency: idle,
      denominator: 144,
      scope: 'GENERAL',
      severity: idle >= 12 ? 'HIGH' : 'MEDIUM',
      researchQuestion: 'idle capacity executable work dispatch not fed',
      samples: [`watchdog windows ${o.idleWindows}`, `free-lane idle rows ${o.freeLaneIdle ?? 'unknown'}`],
      knownCause: null,
    });
  }

  // Missed opportunities: an opening's own expiry passed while it was never taken up.
  const missed = o.expired.filter((x) => UNTAKEN.has(x.state) && Date.parse(x.expiresAt) <= now);
  if (missed.length >= MISSED_MIN) {
    const ready = missed.filter((x) => x.state === 'READY').length;
    out.push({
      key: 'ORIGIN:MISSED_OPPORTUNITY.lapsed-untaken',
      kind: 'ORIGIN_MISSED_OPPORTUNITY',
      title: `${missed.length} opening(s) lapsed untaken in 7 days (${ready} were READY)`,
      problem:
        `${missed.length} of ${o.expired.length} opening(s) whose expiry fell in the last week passed it without being taken up ` +
        `(${ready} READY, the rest with an incomplete card). Find what stopped each from advancing before its window closed.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'server/services/cash/opportunities.ts',
      mutationScope: ['server/services/cash/opportunities.ts', 'server/services/cash/portfolio.ts'],
      frequency: missed.length,
      denominator: Math.max(o.expired.length, missed.length),
      scope: 'GENERAL',
      severity: ready > 0 ? 'HIGH' : 'MEDIUM',
      researchQuestion: 'opportunity expired before action missed window',
      samples: missed.slice(0, 5).map((x) => clip(`${x.title} — ${x.state}, expired ${x.expiresAt.slice(0, 16)}`)),
      knownCause: null,
    });
  }

  // A missing resource several opportunities wait on.
  const shared = o.needs
    .map((n) => ({ ...n, opportunityIds: [...new Set(n.opportunityIds)] }))
    .filter((n) => n.opportunityIds.length >= SHARED_NEED_MIN)
    .sort((a, b) => b.opportunityIds.length - a.opportunityIds.length || (a.key < b.key ? -1 : 1))
    .slice(0, SHARED_NEED_LIMIT);
  for (const need of shared) {
    out.push({
      key: `ORIGIN:SHARED_NEED.${slug(need.key)}`,
      kind: 'ORIGIN_SHARED_NEED',
      title: clip(`One missing resource holds up ${need.opportunityIds.length} opportunities: ${need.blockedAction}`, 200),
      problem:
        `${need.opportunityIds.length} opportunities have an open need for the same thing (${need.key}): ${need.blockedAction}. ` +
        `Expected cost ${need.expectedCostCents === null ? 'unknown' : `${need.expectedCostCents} cents`}. ` +
        'Check what already exists before building, then acquire it once for all of them.',
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'server/services/cash/needs.ts',
      mutationScope: ['server/services/cash/needs.ts'],
      frequency: need.opportunityIds.length,
      denominator: need.opportunityIds.length,
      scope: 'GENERAL',
      severity: need.opportunityIds.length >= 4 ? 'HIGH' : 'MEDIUM',
      researchQuestion: clip(`${need.key} ${need.blockedAction}`, 200),
      samples: need.opportunityIds.slice(0, 5),
      knownCause: null,
    });
  }
  return out;
}

/** Read the observations from rows. Pure reads; a table that cannot be read yields nothing from it. */
export async function observeOrigins(now: Date): Promise<OriginObservations> {
  const db = getDb();
  const to = now.toISOString();
  const day = new Date(now.getTime() - DAY).toISOString();
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  // One unreadable source must not silence the others; it is said, not swallowed.
  const soft = async <T>(read: () => Promise<T>, fallback: T, source: string): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      console.warn(`origination: ${source} unreadable: ${String((error as Error)?.message ?? error)}`);
      return fallback;
    }
  };

  const goals = await soft(async () => {
    const rows = await db.all<{ id: string; title: string; due_at: string; last_event: string | null; last_reading: string | null }>(
      `SELECT w.id, w.title, w.due_at,
              (SELECT MAX(e.created_at) FROM workstream_events e WHERE e.workstream_id = w.id) AS last_event,
              (SELECT MAX(r.created_at) FROM goal_plan_readings r WHERE r.workstream_id = w.id) AS last_reading
         FROM workstreams w
        WHERE w.archived_at IS NULL AND w.cancelled_at IS NULL AND w.paused_at IS NULL AND w.due_at IS NOT NULL
        ORDER BY w.due_at LIMIT 200`,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      dueAt: r.due_at,
      lastMovementAt: [r.last_event, r.last_reading].filter((x): x is string => !!x).sort().at(-1) ?? null,
    }));
  }, [] as GoalObservation[], 'goals');

  const idleWindows = await soft(async () => {
    const r = await db.get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND created_at >= ? AND created_at <= ?",
      [day, to],
    );
    return Number(r?.n ?? 0);
  }, 0, 'idle windows');

  const freeLaneIdle = await soft<number | null>(async () => {
    const r = await db.get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_IDLE' AND at >= ? AND at <= ?",
      [day, to],
    );
    return Number(r?.n ?? 0);
  }, null, 'free-lane idle');

  const expired = await soft(async () => {
    const rows = await db.all<{ id: string; title: string; state: string; expires_at: string }>(
      `SELECT id, title, state, expires_at FROM cash_opportunities
        WHERE expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ? AND duplicate_of_id IS NULL
        ORDER BY expires_at DESC LIMIT 500`,
      [week, to],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, state: r.state, expiresAt: r.expires_at }));
  }, [] as OpportunityObservation[], 'opportunities');

  const needs = await soft(async () => {
    const rows = await db.all<{ need_key: string; blocked_action: string; opportunity_id: string; expected_cost_cents: number | string | null }>(
      `SELECT COALESCE(blocker_key, blocked_action) AS need_key, blocked_action, opportunity_id, expected_cost_cents
         FROM cash_needs WHERE state = 'OPEN' AND opportunity_id IS NOT NULL
        ORDER BY created_at LIMIT 2000`,
    );
    const byKey = new Map<string, NeedObservation>();
    for (const r of rows) {
      let n = byKey.get(r.need_key);
      if (!n) {
        n = { key: r.need_key, blockedAction: r.blocked_action, opportunityIds: [], expectedCostCents: null };
        byKey.set(r.need_key, n);
      }
      n.opportunityIds.push(r.opportunity_id);
      if (r.expected_cost_cents != null) {
        const cost = Number(r.expected_cost_cents);
        if (Number.isFinite(cost)) n.expectedCostCents = Math.max(n.expectedCostCents ?? 0, cost);
      }
    }
    return [...byKey.values()];
  }, [] as NeedObservation[], 'needs');

  return { now, goals, idleWindows, freeLaneIdle, expired, needs };
}

/** What Brain originates now, leaving out any key another detector or an open candidate already owns. */
export async function originatedWeaknesses(now: Date, alreadyRaised: readonly string[]): Promise<Weakness[]> {
  const taken = new Set(alreadyRaised);
  return originateFromObservations(await observeOrigins(now)).filter((w) => !taken.has(w.key));
}
