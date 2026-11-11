/**
 * Brain originating work from its own observations (AUTO-20-1, §87/§98).
 *
 * The improvement loop already turns failure records into work (free-lane
 * failures, rejected claims, stalled packets, owner asks, broken capability
 * maps). What it did not read were the other things a person would otherwise
 * have to notice: capacity standing idle beside work, openings that closed
 * before Brain acted on them, a resource many opportunities need and none can
 * get, a goal whose constraints have not moved, and an opening whose window is
 * closing. Each of those is a row already. This reads them and states what it
 * sees as a `Weakness`, the loop's existing unit of work, so it is ranked,
 * researched or engineered, measured and decided like every other weakness. No
 * new table, scheduler, queue or authority path is added.
 *
 * Every weakness carries the judgment that made it one (`judgment`). The
 * minimums below are where that judgment starts, not a whitelist: no
 * mechanism, industry or capability name is preferred, and a key is formed
 * from what the row says.
 */
import { getDb } from '../../db/database.ts';
import type { Weakness } from '../../domain/improvement.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The watchdog records at most one idle intervention per ten minutes, so six in a day is an hour idle beside waiting work. */
export const IDLE_MIN_RECORDS = 6;
/** Openings that closed unpursued: at least this many, and this share of the openings that closed in the window. */
export const MISSED_MIN_COUNT = 3;
export const MISSED_MIN_SHARE = 0.25;
/** A blocked action named by this many distinct opportunities is a missing resource, not one deal's problem. */
export const NEED_MIN_OPPORTUNITIES = 2;
/** A goal whose blocking constraints have not changed for this long is not being unblocked by the method in use. */
export const GOAL_STUCK_DAYS = 7;
/** An unpursued opening that closes within this many days is a changing condition that needs work now. */
export const CLOSING_WINDOW_DAYS = 7;
export const CLOSING_MIN_COUNT = 2;

export const ORIGINATED_KINDS = ['IDLE_CAPACITY', 'MISSED_OPPORTUNITY', 'UNMET_NEED', 'GOAL_CONSTRAINT', 'CLOSING_WINDOW'] as const;
export type OriginatedKind = (typeof ORIGINATED_KINDS)[number];

export interface OriginatedWeakness extends Weakness {
  kind: `ORIGINATED_${OriginatedKind}`;
  /** Why Brain judged this worth work: the figures read and the minimum they cleared. */
  judgment: string;
}

export function isOriginated(weakness: { kind: string }): boolean {
  return weakness.kind.startsWith('ORIGINATED_');
}

/** A key fragment from free text a row holds: stable, short, never a payload. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unnamed';
}

/* ------------------------------------------------------------------------- */
/* What the rows say (pure over their inputs)                                  */
/* ------------------------------------------------------------------------- */

export interface IdleObservation {
  /** The actor that recorded idle capacity beside executable work (the watchdog, the free lane, …). */
  actor: string;
  records: number;
  samples: string[];
}

/** Capacity idle beside executable work, recurring past the one continuation the watchdog asks for (§98). */
export function idleCapacityWeaknesses(observations: readonly IdleObservation[], windowHours = 24): OriginatedWeakness[] {
  const windows = Math.max(1, Math.round((windowHours * 60) / 10));
  return observations
    .filter((o) => o.records >= IDLE_MIN_RECORDS)
    .map((o) => ({
      key: `ORIGINATE:IDLE:${slugOf(o.actor)}`,
      kind: 'ORIGINATED_IDLE_CAPACITY' as const,
      title: `Capacity stands idle beside executable work (${o.actor})`,
      problem: `${o.actor} recorded idle capacity beside executable work ${o.records} time(s) in ${windowHours} hours. The one dispatch pass it asks for did not keep the capacity fed, so the work waited.`,
      metric: 'AUTO_RECOVERY_RATE' as const,
      downstreamMetric: 'OBJECTIVE_HOURS_MEDIAN' as const,
      ownerComponent: 'server/services/dispatch/loop.ts',
      mutationScope: ['server/services/dispatch/**', 'server/services/engineering/watchdog.ts', 'tests/dispatch*.test.ts', 'tests/engineering*.test.ts'],
      frequency: o.records,
      denominator: windows,
      scope: 'GENERAL' as const,
      severity: o.records >= windows / 4 ? ('HIGH' as const) : ('MEDIUM' as const),
      researchQuestion: 'Why does a dispatch pass leave capacity idle while executable work waits, and what keeps a pool fed?',
      samples: o.samples.slice(0, 5),
      knownCause: `Idle capacity beside executable work recurred ${o.records} times after the watchdog's continuation; the continuation path does not consume what is waiting.`,
      judgment: `${o.records} idle record(s) in ${windowHours}h is at least ${IDLE_MIN_RECORDS} (an hour of idle capacity at one record per ten minutes).`,
    }));
}

export interface MissedObservation {
  /** Openings whose expiry passed in the window while still unpursued (DISCOVERED, EVIDENCE_CARD or READY). */
  missed: { state: string; title: string; mechanism: string }[];
  /** Every opening whose expiry passed in the window. */
  closed: number;
  windowDays: number;
}

/** Openings that closed before Brain acted, grouped by the stage they stalled at: each stage has a different cause. */
export function missedOpportunityWeaknesses(observation: MissedObservation): OriginatedWeakness[] {
  const { closed, windowDays } = observation;
  if (closed <= 0) return [];
  const byState = new Map<string, MissedObservation['missed']>();
  for (const one of observation.missed) byState.set(one.state, [...(byState.get(one.state) ?? []), one]);
  const out: OriginatedWeakness[] = [];
  for (const [state, list] of byState) {
    const share = list.length / closed;
    if (list.length < MISSED_MIN_COUNT || share < MISSED_MIN_SHARE) continue;
    const stage = state.toLowerCase().replace(/_/g, ' ');
    out.push({
      key: `ORIGINATE:MISSED:${state}`,
      kind: 'ORIGINATED_MISSED_OPPORTUNITY',
      title: `Openings close while still ${stage}`,
      problem: `${list.length} of ${closed} openings that closed in ${windowDays} days expired while still ${stage}: Brain did not move them to execution before their window ended.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY',
      ownerComponent: 'server/services/cash/lifecycle.ts',
      mutationScope: ['server/services/cash/**', 'tests/cash*.test.ts'],
      frequency: list.length,
      denominator: closed,
      scope: 'GENERAL',
      severity: share >= 0.5 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `What moves a time-limited opening from ${stage} to execution before it expires?`,
      samples: list.slice(0, 5).map((o) => `${o.title} (${o.mechanism})`),
      knownCause: null,
      judgment: `${list.length} missed of ${closed} closed (${Math.round(share * 100)}%) is at least ${MISSED_MIN_COUNT} and ${Math.round(MISSED_MIN_SHARE * 100)}%.`,
    });
  }
  return out;
}

export interface NeedObservation {
  blockedAction: string;
  opportunities: number;
  /** The newest recorded remedy, verbatim from the row. */
  recommendedPath: string;
  samples: string[];
}

/**
 * A resource, skill, dataset, integration, provider or relationship that several
 * opportunities name as what blocks them. Whether obtaining it is worthwhile is
 * a judgment the method research makes, so no cause is assumed here.
 */
export function unmetNeedWeaknesses(needs: readonly NeedObservation[], openOpportunities: number): OriginatedWeakness[] {
  return needs
    .filter((n) => n.opportunities >= NEED_MIN_OPPORTUNITIES)
    .map((n) => ({
      key: `ORIGINATE:NEED:${slugOf(n.blockedAction)}`,
      kind: 'ORIGINATED_UNMET_NEED' as const,
      title: `Several opportunities need what Brain cannot do: ${n.blockedAction.slice(0, 80)}`,
      problem: `${n.opportunities} opportunities are blocked on "${n.blockedAction.slice(0, 160)}". The recorded remedy is "${n.recommendedPath.slice(0, 160)}" and nobody has acquired it.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY' as const,
      downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY' as const,
      ownerComponent: 'server/services/cash/needs.ts',
      mutationScope: ['server/services/cash/**', 'tests/cash*.test.ts'],
      frequency: n.opportunities,
      denominator: Math.max(n.opportunities, openOpportunities),
      scope: 'GENERAL' as const,
      severity: n.opportunities >= 5 ? ('HIGH' as const) : ('MEDIUM' as const),
      researchQuestion: `Is obtaining "${n.blockedAction.slice(0, 120)}" worthwhile, and what is the cheapest permitted way to obtain or build it?`,
      samples: n.samples.slice(0, 5),
      knownCause: null,
      judgment: `${n.opportunities} distinct opportunities name this blocked action, at least ${NEED_MIN_OPPORTUNITIES}: it is a missing resource, not one deal's problem.`,
    }));
}

export interface GoalObservation {
  goalId: string;
  intent: string;
  blocking: string[];
  /** When the current blocking set was first recorded. */
  since: string;
}

/** A goal whose constraints have not moved: the gaps it waits on are not being closed by the method in use. */
export function goalConstraintWeaknesses(goals: readonly GoalObservation[], now: Date): OriginatedWeakness[] {
  const out: OriginatedWeakness[] = [];
  for (const goal of goals) {
    if (goal.blocking.length === 0) continue;
    const days = (now.getTime() - Date.parse(goal.since)) / DAY;
    if (!(days >= GOAL_STUCK_DAYS)) continue;
    out.push({
      key: `ORIGINATE:GOAL:${goal.goalId}`,
      kind: 'ORIGINATED_GOAL_CONSTRAINT',
      title: `A goal's constraints have not moved in ${Math.floor(days)} days`,
      problem: `Goal "${goal.intent.slice(0, 120)}" has waited on the same ${goal.blocking.length} gap(s) since ${goal.since}: ${goal.blocking.slice(0, 5).join(', ')}. Brain has not closed them or found another way to reach the goal.`,
      metric: 'OBJECTIVE_HOURS_MEDIAN',
      downstreamMetric: 'READY_OPPORTUNITIES_PER_DAY',
      ownerComponent: 'server/services/selfmodel/objectives.ts',
      mutationScope: ['server/services/selfmodel/**', 'tests/selfmodel*.test.ts'],
      frequency: goal.blocking.length,
      denominator: goal.blocking.length,
      scope: 'LOCAL',
      severity: days >= GOAL_STUCK_DAYS * 2 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `How else can "${goal.intent.slice(0, 120)}" be reached when ${goal.blocking.slice(0, 3).join(', ')} stay unavailable?`,
      samples: goal.blocking.slice(0, 5),
      knownCause: null,
      judgment: `The blocking set has been unchanged for ${days.toFixed(1)} days, at least ${GOAL_STUCK_DAYS}.`,
    });
  }
  return out;
}

export interface ClosingObservation {
  /** Unpursued openings whose expiry falls inside the coming window. */
  closing: { title: string; expiresAt: string; reason: string | null }[];
  open: number;
}

/** Economic conditions changing under an opening: its window is closing and nothing is pursuing it. */
export function closingWindowWeaknesses(observation: ClosingObservation): OriginatedWeakness[] {
  const n = observation.closing.length;
  if (n < CLOSING_MIN_COUNT) return [];
  return [
    {
      key: 'ORIGINATE:CLOSING',
      kind: 'ORIGINATED_CLOSING_WINDOW',
      title: 'Openings are closing with nothing pursuing them',
      problem: `${n} unpursued openings close within ${CLOSING_WINDOW_DAYS} days. The conditions that made them worth having are ending, and none of them is executing.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY',
      ownerComponent: 'server/services/cash/portfolio.ts',
      mutationScope: ['server/services/cash/**', 'tests/cash*.test.ts'],
      frequency: n,
      denominator: Math.max(n, observation.open),
      scope: 'GENERAL',
      severity: n >= 5 ? 'HIGH' : 'MEDIUM',
      researchQuestion: 'How should a portfolio re-rank openings whose window is closing against those that will still be there later?',
      samples: observation.closing.slice(0, 5).map((c) => `${c.title} closes ${c.expiresAt}${c.reason ? ` (${c.reason})` : ''}`),
      knownCause: null,
      judgment: `${n} unpursued openings close within ${CLOSING_WINDOW_DAYS} days, at least ${CLOSING_MIN_COUNT}.`,
    },
  ];
}

/* ------------------------------------------------------------------------- */
/* Reading the rows                                                            */
/* ------------------------------------------------------------------------- */

const UNPURSUED = ['DISCOVERED', 'EVIDENCE_CARD', 'READY'] as const;

export interface OriginationObservations {
  idle: IdleObservation[];
  missed: MissedObservation;
  needs: NeedObservation[];
  openOpportunities: number;
  goals: GoalObservation[];
  closing: ClosingObservation;
}

/** Every observation origination reads. About six bounded reads; nothing is written. */
export async function readOriginationObservations(now: Date): Promise<OriginationObservations> {
  const db = getDb();
  const to = now.toISOString();
  const day = new Date(now.getTime() - DAY).toISOString();
  const month = new Date(now.getTime() - 30 * DAY).toISOString();
  const ahead = new Date(now.getTime() + CLOSING_WINDOW_DAYS * DAY).toISOString();
  const marks = UNPURSUED.map(() => '?').join(', ');

  const idleRows = await db.all<{ actor_id: string; n: number | string; sample: string | null }>(
    `SELECT actor_id, COUNT(*) AS n, MAX(attempted_action) AS sample FROM engineering_interventions
      WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND created_at > ? AND created_at <= ?
      GROUP BY actor_id ORDER BY n DESC LIMIT 20`,
    [day, to],
  );
  const idle = idleRows.map((r) => ({ actor: r.actor_id, records: Number(r.n), samples: r.sample ? [r.sample.slice(0, 200)] : [] }));

  const closedRows = await db.all<{ state: string; title: string; mechanism: string }>(
    `SELECT state, title, mechanism FROM cash_opportunities
      WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ? AND duplicate_of_id IS NULL
      ORDER BY expires_at DESC LIMIT 2000`,
    [month, to],
  );
  const missed: MissedObservation = {
    missed: closedRows.filter((r) => (UNPURSUED as readonly string[]).includes(r.state)),
    closed: closedRows.length,
    windowDays: 30,
  };

  const needRows = await db.all<{ blocked_action: string; opportunity_id: string | null; recommended_path: string; created_at: string }>(
    `SELECT blocked_action, opportunity_id, recommended_path, created_at FROM cash_needs
      WHERE state = 'OPEN' ORDER BY created_at DESC LIMIT 2000`,
  );
  const grouped = new Map<string, { blockedAction: string; opportunities: Set<string>; recommendedPath: string; samples: string[] }>();
  for (const row of needRows) {
    const key = slugOf(row.blocked_action);
    const entry = grouped.get(key) ?? { blockedAction: row.blocked_action, opportunities: new Set<string>(), recommendedPath: row.recommended_path, samples: [] };
    if (row.opportunity_id) entry.opportunities.add(row.opportunity_id);
    if (entry.samples.length < 5) entry.samples.push(row.blocked_action.slice(0, 200));
    grouped.set(key, entry);
  }
  const needs = [...grouped.values()].map((g) => ({ blockedAction: g.blockedAction, opportunities: g.opportunities.size, recommendedPath: g.recommendedPath, samples: g.samples }));

  const openRow = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM cash_opportunities WHERE state IN (${marks}) AND duplicate_of_id IS NULL`,
    [...UNPURSUED],
  );
  const openOpportunities = Number(openRow?.n ?? 0);

  const closingRows = await db.all<{ title: string; expires_at: string; expiry_reason: string | null }>(
    `SELECT title, expires_at, expiry_reason FROM cash_opportunities
      WHERE state IN (${marks}) AND duplicate_of_id IS NULL AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
      ORDER BY expires_at ASC LIMIT 200`,
    [...UNPURSUED, to, ahead],
  );
  const closing: ClosingObservation = {
    closing: closingRows.map((r) => ({ title: r.title, expiresAt: r.expires_at, reason: r.expiry_reason })),
    open: openOpportunities,
  };

  const assessed = await db.all<{ entity_id: string; payload: string; created_at: string; intent: string }>(
    `SELECT e.entity_id, e.payload, e.created_at, w.intent FROM project_events e
       JOIN workstreams w ON w.id = e.entity_id
      WHERE e.entity_type = 'WORKSTREAM' AND e.event_type = 'CAPABILITY_ASSESSED'
        AND w.archived_at IS NULL AND w.cancelled_at IS NULL
      ORDER BY e.entity_id, e.created_at DESC LIMIT 2000`,
  );
  const goals = goalsFromAssessments(assessed);

  return { idle, missed, needs, openOpportunities, goals, closing };
}

/**
 * The current blocking set of each goal and when that set was first recorded.
 * A re-record of the same set (one per release) does not reset the age. Pure.
 * Rows are grouped by goal, newest first.
 */
export function goalsFromAssessments(rows: readonly { entity_id: string; payload: string; created_at: string; intent: string }[]): GoalObservation[] {
  const blockingOf = (payload: string): string[] | null => {
    try {
      const parsed = JSON.parse(payload) as { blocking?: unknown };
      return Array.isArray(parsed.blocking) ? (parsed.blocking as unknown[]).map(String).sort() : null;
    } catch {
      return null;
    }
  };
  const byGoal = new Map<string, typeof rows[number][]>();
  for (const row of rows) byGoal.set(row.entity_id, [...(byGoal.get(row.entity_id) ?? []), row]);
  const out: GoalObservation[] = [];
  for (const [goalId, list] of byGoal) {
    const newestFirst = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const current = blockingOf(newestFirst[0]!.payload);
    if (!current) continue;
    let since = newestFirst[0]!.created_at;
    for (const row of newestFirst.slice(1)) {
      const set = blockingOf(row.payload);
      if (!set || set.join('|') !== current.join('|')) break;
      since = row.created_at;
    }
    out.push({ goalId, intent: newestFirst[0]!.intent, blocking: current, since });
  }
  return out;
}

/** Every weakness Brain originates from its own observations, minus what an earlier detector or open candidate already owns. */
export function originatedFrom(observations: OriginationObservations, now: Date, exclude: readonly string[] = []): OriginatedWeakness[] {
  const owned = new Set(exclude.map((k) => k.replace(/#\d+$/, '')));
  return [
    ...idleCapacityWeaknesses(observations.idle),
    ...missedOpportunityWeaknesses(observations.missed),
    ...unmetNeedWeaknesses(observations.needs, observations.openOpportunities),
    ...goalConstraintWeaknesses(observations.goals, now),
    ...closingWindowWeaknesses(observations.closing),
  ].filter((w) => !owned.has(w.key));
}

export async function originatedWeaknesses(now: Date, exclude: readonly string[] = []): Promise<OriginatedWeakness[]> {
  return originatedFrom(await readOriginationObservations(now), now, exclude);
}

/**
 * The gap loop's NOTICE step for an originated weakness (AUTO-20-2): the record
 * a resuming worker reads to know the loop began, what was observed and why it
 * was judged worth work. Recorded once, when the candidate is created.
 */
export async function recordOriginationNotice(weakness: OriginatedWeakness, candidateKey: string): Promise<void> {
  const { recordGapStep } = await import('../selfmodel/gapLoop.ts');
  await recordGapStep({
    gapKey: candidateKey,
    step: 'NOTICE',
    summary: weakness.title.slice(0, 200),
    detail: {
      observation: weakness.problem,
      origin: weakness.kind,
      judgment: weakness.judgment,
      frequency: weakness.frequency,
      denominator: weakness.denominator,
      samples: weakness.samples,
    },
  });
}
