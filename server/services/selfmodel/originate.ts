/**
 * Brain originating work from its own observations (AUTO-20-1, §87/§88).
 *
 * The improvement loop's other detectors read failures Brain was built to
 * count: free-lane classes, rejected claims, settled packets, owner asks and
 * the capability maps. None of them looks at the four things the specification
 * names as the places a need shows before anybody has noticed it:
 *
 *   GOAL_CONSTRAINT     live goals past their due date, or with no recorded
 *                       movement for a week — a goal held by something nobody
 *                       has named yet
 *   FAILURE_PATTERN     a kind of queued work that fails at a material share
 *                       and that no other detector already owns
 *   IDLE_RESOURCE       enabled routines that are checking in and being given
 *                       nothing, while Brain holds incomplete goals
 *   MISSED_OPPORTUNITY  openings that expired or spent their rounds before
 *                       anything was done with them
 *   ECONOMIC_CHANGE     a recorded condition that changed (a reopen condition
 *                       triggered) on an opening that nobody reconsidered
 *
 * Each is a `Weakness`, so it reaches Factory through the same loop — one
 * owner, one candidate, the same attempts and decisions — and no second
 * scheduler, store or authority path exists for it (§10.3, §20.4). What is
 * new is that each carries an `origination` record: which observation raised
 * it, what Brain judged from it, and why it judged the work worthwhile. That
 * judgment is per case and from the rows (the approved reading of S-0243); the
 * sources are where Brain looks, not a whitelist of what it may need.
 *
 * Pure reads. A source whose table this database does not have reads as no
 * observation, never as a failure of the tick.
 */
import { getDb } from '../../db/database.ts';
import type { MetricKey, Severity, Weakness } from '../../domain/improvement.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ORIGINATION_SOURCES = ['GOAL_CONSTRAINT', 'FAILURE_PATTERN', 'IDLE_RESOURCE', 'MISSED_OPPORTUNITY', 'ECONOMIC_CHANGE'] as const;
export type OriginationSource = (typeof ORIGINATION_SOURCES)[number];

/** A goal with no recorded movement for this long is stalled. */
export const GOAL_STALL_DAYS = 7;
/** Work of one kind is a failure pattern at this many failures and this share of what settled. */
export const FAILURE_MIN_COUNT = 10;
export const FAILURE_MIN_SHARE = 0.2;
/** Openings lost, or changes ignored, at or above this count in a week are a pattern, not an accident. */
export const OPPORTUNITY_MIN_COUNT = 3;

export interface Origination {
  source: OriginationSource;
  /** What the rows showed, as counts and identifiers — never a payload. */
  observation: string;
  /** What Brain concluded from it, for this case. */
  judgment: string;
  /** Why closing it is worth a Factory objective rather than a note. */
  worthwhile: string;
  /** Row identifiers the observation rests on, at most ten. */
  rows: string[];
}

export interface OriginatedWeakness extends Weakness {
  origination: Origination;
}

export function isOriginated(weakness: Weakness): weakness is OriginatedWeakness {
  return Boolean((weakness as Partial<OriginatedWeakness>).origination);
}

/* ------------------------------------------------------------------------- */
/* Readings: pure counts from rows                                            */
/* ------------------------------------------------------------------------- */

export interface GoalReading {
  live: number;
  overdue: { id: string; title: string }[];
  stalled: { id: string; title: string }[];
}

export interface FailureReading {
  workType: string;
  failed: number;
  settled: number;
  ids: string[];
}

export interface IdleReading {
  checkingIn: number;
  idle: { id: string; name: string }[];
  liveGoals: number;
}

export interface OpportunityReading {
  touched: number;
  lost: { id: string; from: string }[];
}

export interface ChangeReading {
  triggered: number;
  ignored: { id: string; blocker: string }[];
}

export interface OriginationReadings {
  goals: GoalReading | null;
  failures: FailureReading[];
  idle: IdleReading | null;
  opportunities: OpportunityReading | null;
  changes: ChangeReading | null;
}

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    // A table this backend does not have (or a role that cannot read it) is no observation.
    return fallback;
  }
}

export async function readGoals(now: Date): Promise<GoalReading | null> {
  return safe(async () => {
    const stallBefore = new Date(now.getTime() - GOAL_STALL_DAYS * DAY).toISOString();
    const rows = await getDb().all<{ id: string; title: string; due_at: string | null; created_at: string; last_event: string | null }>(
      `SELECT w.id AS id, w.title AS title, w.due_at AS due_at, w.created_at AS created_at,
              (SELECT MAX(e.created_at) FROM workstream_events e WHERE e.workstream_id = w.id) AS last_event
         FROM workstreams w
        WHERE w.archived_at IS NULL AND w.cancelled_at IS NULL`,
      [],
    );
    const nowIso = now.toISOString();
    const overdue: GoalReading['overdue'] = [];
    const stalled: GoalReading['stalled'] = [];
    for (const r of rows) {
      if (r.due_at && r.due_at < nowIso) overdue.push({ id: r.id, title: r.title });
      else if ((r.last_event ?? r.created_at) < stallBefore) stalled.push({ id: r.id, title: r.title });
    }
    return { live: rows.length, overdue, stalled };
  }, null);
}

export async function readFailures(now: Date): Promise<FailureReading[]> {
  return safe(async () => {
    const week = new Date(now.getTime() - 7 * DAY).toISOString();
    const rows = await getDb().all<{ work_type: string; failed: number | string; settled: number | string }>(
      `SELECT work_type,
              SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              COUNT(*) AS settled
         FROM work_items
        WHERE state IN ('SUCCEEDED', 'FAILED') AND updated_at >= ?
        GROUP BY work_type`,
      [week],
    );
    const out: FailureReading[] = [];
    for (const r of rows) {
      const failed = Number(r.failed);
      if (failed <= 0) continue;
      const ids = await getDb().all<{ id: string }>(
        `SELECT id FROM work_items WHERE work_type = ? AND state = 'FAILED' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10`,
        [r.work_type, week],
      );
      out.push({ workType: r.work_type, failed, settled: Number(r.settled), ids: ids.map((i) => i.id) });
    }
    return out;
  }, []);
}

export async function readIdle(now: Date): Promise<IdleReading | null> {
  return safe(async () => {
    const day = new Date(now.getTime() - DAY).toISOString();
    const routines = await getDb().all<{ id: string; name: string; worker_id: string | null }>(
      `SELECT id, name, worker_id FROM fleet_routines WHERE state = 'ENABLED' AND last_check_in_at IS NOT NULL AND last_check_in_at >= ?`,
      [day],
    );
    const idle: IdleReading['idle'] = [];
    for (const r of routines) {
      const served = await getDb().get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM worker_sessions WHERE routine_id = ? AND observed_at >= ?`,
        [r.id, day],
      );
      if (Number(served?.n ?? 0) === 0) idle.push({ id: r.id, name: r.name });
    }
    const goals = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM workstreams WHERE archived_at IS NULL AND cancelled_at IS NULL`,
      [],
    );
    return { checkingIn: routines.length, idle, liveGoals: Number(goals?.n ?? 0) };
  }, null);
}

export async function readOpportunities(now: Date): Promise<OpportunityReading | null> {
  return safe(async () => {
    const week = new Date(now.getTime() - 7 * DAY).toISOString();
    const touched = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM cash_opportunities WHERE updated_at >= ?`, [week]);
    const lost = await getDb().all<{ opportunity_id: string; recorded_from: string }>(
      `SELECT opportunity_id, recorded_from FROM cash_reopen_conditions
        WHERE recorded_from IN ('EXPIRY', 'ROUNDS_SPENT') AND created_at >= ?
        ORDER BY created_at DESC LIMIT 200`,
      [week],
    );
    const seen = new Set<string>();
    const unique = lost.filter((l) => (seen.has(l.opportunity_id) ? false : (seen.add(l.opportunity_id), true)));
    return { touched: Number(touched?.n ?? 0), lost: unique.map((l) => ({ id: l.opportunity_id, from: l.recorded_from })) };
  }, null);
}

export async function readChanges(now: Date): Promise<ChangeReading | null> {
  return safe(async () => {
    const week = new Date(now.getTime() - 7 * DAY).toISOString();
    // Older than a day, so the reconsideration path has had its chance to act.
    const settled = new Date(now.getTime() - DAY).toISOString();
    const rows = await getDb().all<{ opportunity_id: string; blocker_key: string; triggered_at: string; state: string; updated_at: string }>(
      `SELECT c.opportunity_id AS opportunity_id, c.blocker_key AS blocker_key, c.triggered_at AS triggered_at,
              o.state AS state, o.updated_at AS updated_at
         FROM cash_reopen_conditions c JOIN cash_opportunities o ON o.id = c.opportunity_id
        WHERE c.triggered_at IS NOT NULL AND c.triggered_at >= ? AND c.triggered_at <= ?`,
      [week, settled],
    );
    const ignored = rows
      .filter((r) => (r.state === 'ARCHIVED' || r.state === 'DECLINED') && r.updated_at <= r.triggered_at)
      .map((r) => ({ id: r.opportunity_id, blocker: r.blocker_key }));
    return { triggered: rows.length, ignored };
  }, null);
}

export async function readOrigination(now: Date): Promise<OriginationReadings> {
  const [goals, failures, idle, opportunities, changes] = await Promise.all([
    readGoals(now),
    readFailures(now),
    readIdle(now),
    readOpportunities(now),
    readChanges(now),
  ]);
  return { goals, failures, idle, opportunities, changes };
}

/* ------------------------------------------------------------------------- */
/* Judgment: pure, per case, from the readings                                */
/* ------------------------------------------------------------------------- */

function weakness(input: {
  key: string;
  kind: string;
  title: string;
  problem: string;
  metric: MetricKey;
  downstreamMetric?: MetricKey | null;
  ownerComponent: string;
  mutationScope: string[];
  frequency: number;
  denominator: number;
  severity: Severity;
  researchQuestion: string;
  samples: string[];
  knownCause: string | null;
  origination: Origination;
}): OriginatedWeakness {
  return {
    key: input.key,
    kind: input.kind,
    title: input.title.slice(0, 200),
    problem: input.problem,
    metric: input.metric,
    downstreamMetric: input.downstreamMetric ?? null,
    ownerComponent: input.ownerComponent,
    mutationScope: input.mutationScope,
    frequency: input.frequency,
    denominator: Math.max(input.denominator, input.frequency),
    scope: 'GENERAL',
    severity: input.severity,
    researchQuestion: input.researchQuestion,
    samples: input.samples.slice(0, 5).map((s) => s.slice(0, 300)),
    knownCause: input.knownCause,
    origination: { ...input.origination, rows: input.origination.rows.slice(0, 10) },
  };
}

/**
 * Turn readings into originated weaknesses. Each source is judged on its own
 * evidence: a reading below its bar is recorded nowhere and raises nothing,
 * because one stalled goal or one failed item is an incident, not a need.
 * Keys already raised by another detector or held by an open candidate are
 * skipped, so origination never races the owner of a weakness.
 */
export function judgeOrigination(r: OriginationReadings, alreadyDetected: readonly string[]): OriginatedWeakness[] {
  const taken = new Set(alreadyDetected.map((k) => k.split('#')[0]));
  const out: OriginatedWeakness[] = [];

  if (r.goals && r.goals.live > 0) {
    const held = [...r.goals.overdue, ...r.goals.stalled];
    const share = held.length / r.goals.live;
    if (held.length >= 1 && share >= 0.25) {
      out.push(
        weakness({
          key: 'ORIGINATED:GOAL_CONSTRAINT',
          kind: 'ORIGINATED_GOAL_CONSTRAINT',
          title: `${held.length} of ${r.goals.live} live goals are overdue or have not moved in ${GOAL_STALL_DAYS} days`,
          problem:
            `${r.goals.overdue.length} live goal(s) are past their due date and ${r.goals.stalled.length} more have recorded no event ` +
            `for ${GOAL_STALL_DAYS} days. Nobody named what holds them, so no detector raised it: the constraint is unnamed.`,
          metric: 'OBJECTIVE_HOURS_MEDIAN',
          downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY',
          ownerComponent: 'server/services/goals/tick.ts',
          mutationScope: ['server/services/goals/tick.ts', 'server/services/goals/goalWork.ts', 'tests/goal*.test.ts'],
          frequency: held.length,
          denominator: r.goals.live,
          severity: r.goals.overdue.length > 0 ? 'HIGH' : 'MEDIUM',
          researchQuestion: 'goal stalled overdue no progress constraint unnamed blocker executable next step',
          samples: held.map((g) => `${g.id}: ${g.title}`),
          knownCause: null,
          origination: {
            source: 'GOAL_CONSTRAINT',
            observation: `${r.goals.overdue.length} overdue + ${r.goals.stalled.length} stalled of ${r.goals.live} live goals`,
            judgment:
              `${Math.round(share * 100)}% of live goals are held. A goal tick that leaves this share without a named blocker or a next ` +
              'executable step is missing the step that names the constraint and produces the work it implies.',
            worthwhile: 'Each held goal is value Brain was asked for and is not pursuing; naming the constraint is cheap beside that.',
            rows: held.map((g) => g.id),
          },
        }),
      );
    }
  }

  for (const f of r.failures) {
    const share = f.settled > 0 ? f.failed / f.settled : 0;
    const key = `ORIGINATED:FAILURE_PATTERN:${f.workType}`;
    if (taken.has(key) || f.failed < FAILURE_MIN_COUNT || share < FAILURE_MIN_SHARE) continue;
    out.push(
      weakness({
        key,
        kind: 'ORIGINATED_FAILURE_PATTERN',
        title: `${f.workType} work fails ${Math.round(share * 100)}% of the time (${f.failed} of ${f.settled} this week)`,
        problem:
          `${f.failed} of ${f.settled} ${f.workType} work items that settled in the last week FAILED. No other detector owns this ` +
          'work type, so the pattern is recorded here rather than left to repeat.',
        metric: 'AUTO_RECOVERY_RATE',
        downstreamMetric: 'RESEARCH_JOB_SUCCESS_RATE',
        ownerComponent: 'server/services/queue/workTypes.ts',
        mutationScope: ['server/services/queue/**', 'tests/work*.test.ts'],
        frequency: f.failed,
        denominator: f.settled,
        severity: share >= 0.5 ? 'HIGH' : 'MEDIUM',
        researchQuestion: `${f.workType} work item failure recurring cause handler`,
        samples: f.ids.map((id) => `work item ${id} FAILED`),
        knownCause: null,
        origination: {
          source: 'FAILURE_PATTERN',
          observation: `${f.failed}/${f.settled} ${f.workType} items FAILED in 7 days`,
          judgment: `At ${Math.round(share * 100)}% the failures are a property of how ${f.workType} work is done, not of individual items.`,
          worthwhile: `Every future ${f.workType} item inherits the fix; at this rate roughly ${f.failed} items a week are lost.`,
          rows: f.ids,
        },
      }),
    );
  }

  if (r.idle && r.idle.checkingIn > 0 && r.idle.idle.length > 0 && r.idle.liveGoals > 0) {
    const share = r.idle.idle.length / r.idle.checkingIn;
    if (share >= 0.5) {
      out.push(
        weakness({
          key: 'ORIGINATED:IDLE_RESOURCE',
          kind: 'ORIGINATED_IDLE_RESOURCE',
          title: `${r.idle.idle.length} of ${r.idle.checkingIn} checking-in routines were given no work in 24 h while ${r.idle.liveGoals} goals are live`,
          problem:
            `${r.idle.idle.length} enabled routine(s) checked in within the last day and were assigned no bin, while ${r.idle.liveGoals} ` +
            'goals are still incomplete. Capacity sat idle beside unfinished goals (rule 9): the goals are not being turned into work it can take.',
          metric: 'OBJECTIVE_HOURS_MEDIAN',
          downstreamMetric: 'RESEARCH_JOB_SUCCESS_RATE',
          ownerComponent: 'server/services/goals/goalWork.ts',
          mutationScope: ['server/services/goals/goalWork.ts', 'server/services/dispatch/candidates.ts', 'tests/goal*.test.ts'],
          frequency: r.idle.idle.length,
          denominator: r.idle.checkingIn,
          severity: share >= 0.8 ? 'HIGH' : 'MEDIUM',
          researchQuestion: 'idle capacity incomplete goals generate executable work assignment',
          samples: r.idle.idle.map((i) => `routine ${i.name} (${i.id}) checked in, served nothing`),
          knownCause: null,
          origination: {
            source: 'IDLE_RESOURCE',
            observation: `${r.idle.idle.length}/${r.idle.checkingIn} routines idle 24 h; ${r.idle.liveGoals} live goals`,
            judgment: 'Idle capacity beside incomplete goals means goal work is not being decomposed into bins the fleet can take.',
            worthwhile: 'The capacity is already paid for by the subscription; using it costs nothing extra and advances live goals.',
            rows: r.idle.idle.map((i) => i.id),
          },
        }),
      );
    }
  }

  if (r.opportunities && r.opportunities.lost.length >= OPPORTUNITY_MIN_COUNT) {
    const lost = r.opportunities.lost;
    out.push(
      weakness({
        key: 'ORIGINATED:MISSED_OPPORTUNITY',
        kind: 'ORIGINATED_MISSED_OPPORTUNITY',
        title: `${lost.length} openings expired or spent their rounds this week before anything was done with them`,
        problem:
          `${lost.length} opportunities were closed this week by expiry or by exhausting their validation rounds ` +
          `(of ${r.opportunities.touched} touched). Each was found and then lost to time rather than to a decision.`,
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        downstreamMetric: 'CONSTRUCTED_ROUND_YIELD',
        ownerComponent: 'server/services/cash/opportunities.ts',
        mutationScope: ['server/services/cash/opportunities.ts', 'server/services/cash/readiness.ts', 'tests/cash*.test.ts'],
        frequency: lost.length,
        denominator: Math.max(r.opportunities.touched, lost.length),
        severity: lost.length >= 2 * OPPORTUNITY_MIN_COUNT ? 'HIGH' : 'MEDIUM',
        researchQuestion: 'opportunity expired validation rounds exhausted before execution missing capability',
        samples: lost.map((l) => `opportunity ${l.id} closed by ${l.from}`),
        knownCause: null,
        origination: {
          source: 'MISSED_OPPORTUNITY',
          observation: `${lost.length} openings closed by EXPIRY/ROUNDS_SPENT in 7 days`,
          judgment: 'Openings that time out are lost to a missing capability, resource or step, not to a judgment against them.',
          worthwhile: 'A found opening is the most expensive part of the search; losing it to time discards that cost.',
          rows: lost.map((l) => l.id),
        },
      }),
    );
  }

  if (r.changes && r.changes.ignored.length >= OPPORTUNITY_MIN_COUNT) {
    const ignored = r.changes.ignored;
    out.push(
      weakness({
        key: 'ORIGINATED:ECONOMIC_CHANGE',
        kind: 'ORIGINATED_ECONOMIC_CHANGE',
        title: `${ignored.length} openings whose blocking condition changed were never reconsidered`,
        problem:
          `${ignored.length} of ${r.changes.triggered} reopen conditions triggered this week (the fact that closed the opening changed), ` +
          'and the opening stayed closed and untouched for a day after. A change in conditions reached the record and not the decision.',
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        downstreamMetric: 'CONSTRUCTED_ROUND_YIELD',
        ownerComponent: 'server/services/cash/reconsider.ts',
        mutationScope: ['server/services/cash/reconsider.ts', 'tests/cash*.test.ts', 'tests/reconsider*.test.ts'],
        frequency: ignored.length,
        denominator: Math.max(r.changes.triggered, ignored.length),
        severity: 'MEDIUM',
        researchQuestion: 'reopen condition triggered opportunity not reconsidered changed economic conditions',
        samples: ignored.map((c) => `opportunity ${c.id}: ${c.blocker} changed, not reconsidered`),
        knownCause: null,
        origination: {
          source: 'ECONOMIC_CHANGE',
          observation: `${ignored.length}/${r.changes.triggered} triggered conditions with no reconsideration after 24 h`,
          judgment: 'The reconsideration path is not consuming the changes it records, so changing conditions do not change decisions.',
          worthwhile: 'A closed opening whose blocker has gone is a ready lead at no further discovery cost.',
          rows: ignored.map((c) => c.id),
        },
      }),
    );
  }

  return out.filter((w) => !taken.has(w.key));
}

/** What the loop calls: read, then judge. */
export async function originatedWeaknesses(now: Date, alreadyDetected: readonly string[]): Promise<OriginatedWeakness[]> {
  return judgeOrigination(await readOrigination(now), alreadyDetected);
}
