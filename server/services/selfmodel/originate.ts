/**
 * Brain originating work from its own observations (AUTO-20-1, §87/§88/§98).
 *
 * The improvement loop's detectors read failure records of the research
 * pipeline (free-lane items, rejected claims, settled packets, owner asks) and
 * the capability maps. Nobody told Brain to look at anything else, so anything
 * else waited for the owner to notice it. This reads the other rows that say
 * an objective is not advancing and states each as a `Weakness` — the loop's
 * existing unit of work — so it is ranked, researched or engineered through
 * Factory, measured against a baseline and decided exactly as every other
 * weakness is. No table, scheduler, queue or authority path is added: the
 * candidate row is the work, `gapLoopSync.ts` records its capability-gap loop.
 *
 * What is read, one family each, because each has a different cause:
 *
 *   GOAL_CONSTRAINT   a live goal held by the same capability gaps for days. A
 *                     gap the map's own route skipped (too few failures to
 *                     pass the loop's count threshold) still blocks a real
 *                     objective, and a gap an earlier repair was decided on and
 *                     that still blocks the goal is a method that did not work.
 *   FAILURE_PATTERN   bins of one kind ending FAILED or NEEDS_HUMAN for the
 *                     same reason, again and again — work that fails the same
 *                     way across workers, not one job's bad luck.
 *   IDLE_CAPACITY     capacity standing idle beside executable work, recorded
 *                     by the watchdog (§98) more often than its one dispatch
 *                     continuation can explain.
 *   MISSED_OPPORTUNITY openings whose window closed while still unpursued, and
 *                     openings whose window is closing now (a changing
 *                     condition: the work is worth more today than next week).
 *   UNMET_NEED        a missing resource, skill, dataset, integration,
 *                     provider or relationship that several opportunities name
 *                     as what blocks them.
 *
 * Every weakness carries `origination`: the family, the figures read, and the
 * judgment that made the observation into work, so the decision can be
 * inspected and argued with later. The minimums below are where that judgment
 * starts, not a whitelist: no mechanism, industry, vendor, bin kind or
 * capability is named or preferred, and keys are formed from what the rows say.
 * Whether closing a gap is worthwhile is the loop's VALUE step, not this file's.
 */
import { getDb } from '../../db/database.ts';
import { CAPABILITY_MAPS, type CapabilityRequirement } from '../../domain/capabilityMap.ts';
import type { Weakness } from '../../domain/improvement.ts';
import { ownerExists } from './capabilities.ts';
import { needExecutionOwner } from '../cash/needs.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A goal whose blocking set has not changed for this long is not being unblocked by what Brain is doing. */
export const GOAL_STUCK_DAYS = 5;
/** A goal due within this many days while still blocked makes its gaps urgent. */
export const GOAL_DUE_SOON_DAYS = 7;
/** Bins ending the same way: at least this many in the window, and this share of the kind's terminal bins. */
export const FAILURE_MIN_COUNT = 5;
export const FAILURE_MIN_SHARE = 0.25;
export const FAILURE_WINDOW_DAYS = 7;
/** The watchdog records at most once per ten minutes, so six in a day is an hour idle beside waiting work. */
export const IDLE_MIN_RECORDS = 6;
/** Openings that closed unpursued: at least this many, and this share of the openings that closed. */
export const MISSED_MIN_COUNT = 3;
export const MISSED_MIN_SHARE = 0.25;
export const MISSED_WINDOW_DAYS = 14;
/** Unpursued openings whose window ends within this many days. */
export const CLOSING_WINDOW_DAYS = 5;
export const CLOSING_MIN_COUNT = 2;
/** A blocker named by this many distinct opportunities is a missing resource, not one deal's problem. */
export const NEED_MIN_OPPORTUNITIES = 2;

export const ORIGIN_FAMILIES = ['GOAL_CONSTRAINT', 'FAILURE_PATTERN', 'IDLE_CAPACITY', 'MISSED_OPPORTUNITY', 'UNMET_NEED'] as const;
export type OriginFamily = (typeof ORIGIN_FAMILIES)[number];

export interface Origination {
  family: OriginFamily;
  /** Why Brain judged this worth work: the figures read and what they were weighed against. */
  judgment: string;
  /** The rows the judgment was made from (ids), so it can be re-read. */
  observed: string[];
  /** Set when the observation says an earlier method did not work, not that work is missing. */
  methodInadequate?: string;
  /**
   * The execution owner that acquires the missing piece, when it is not a software change
   * (S-0249): a connector, a commercial interaction, information, a watched fact or a person.
   * Absent means the Factory or method research may own it, as for every other weakness.
   */
  route?: { kind: 'INTEGRATION' | 'COMMERCIAL' | 'RESEARCH' | 'WATCH' | 'PERSON'; owner: string; why: string };
  /** The rows that owner is handed, when they are not the ones observed (openings still inside their window). */
  handTo?: string[];
}

export interface OriginatedWeakness extends Weakness {
  origination: Origination;
}

export function isOriginated(weakness: object): weakness is OriginatedWeakness {
  return 'origination' in weakness && Boolean((weakness as { origination?: unknown }).origination);
}

/** A key fragment from free text a row holds: stable, short, never a payload. */
export function slugOf(text: string, max = 48): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'unnamed'
  );
}

/** A reason with its identifiers, numbers and quoted values removed, so one cause reads as one cause. */
export function normalizeReason(reason: string): string {
  return reason
    .replace(/\b[a-z]{2,6}_[0-9a-z]{8,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/"[^"]*"|'[^']*'/g, '<v>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function clip(text: string, n = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The first owner path that exists in the running image, else the fallback — never a path that is not there. */
function existingOwner(candidates: readonly string[], fallback: string): string {
  for (const one of candidates) if (one && ownerExists(one)) return one;
  return fallback;
}

/* ------------------------------------------------------------------------- */
/* Goal constraints                                                           */
/* ------------------------------------------------------------------------- */

export interface GoalConstraintObservation {
  goalId: string;
  intent: string;
  dueAt: string | null;
  /** The gaps that block it now, with the moment the current unchanged blocking set was first recorded. */
  blocking: { id: string; status: string; why: string }[];
  blockedSince: string;
}

export interface PriorRepair {
  /** The capability key family (`CAPABILITY:MAP.ID`) and how its latest attempt was decided. */
  key: string;
  decision: string | null;
  attempt: number;
}

function requirementFor(id: string): { map: string; requirement: CapabilityRequirement } | null {
  for (const [map, definition] of Object.entries(CAPABILITY_MAPS)) {
    const requirement = definition.requirements.find((r) => r.id === id);
    if (requirement) return { map, requirement };
  }
  return null;
}

/**
 * One weakness per gap that holds live goals back for days. Pure over its inputs.
 *
 * A gap with an open repair is left to that repair; a gap whose repair was
 * decided and that still blocks a goal is the method failing, and says so.
 */
export function goalConstraintWeaknesses(
  goals: readonly GoalConstraintObservation[],
  repairs: readonly PriorRepair[],
  now: Date,
): OriginatedWeakness[] {
  const byGap = new Map<string, { gap: GoalConstraintObservation['blocking'][number]; goals: GoalConstraintObservation[] }>();
  for (const goal of goals) {
    const days = (now.getTime() - Date.parse(goal.blockedSince)) / DAY;
    if (!(days >= GOAL_STUCK_DAYS)) continue;
    for (const gap of goal.blocking) {
      const entry = byGap.get(gap.id) ?? { gap, goals: [] };
      entry.goals.push(goal);
      byGap.set(gap.id, entry);
    }
  }
  const out: OriginatedWeakness[] = [];
  for (const [gapId, { gap, goals: held }] of byGap) {
    const found = requirementFor(gapId);
    if (found?.requirement.externalLimit) continue; // waits on the world, stated on the map; not Brain's to engineer
    const capabilityKey = found ? `CAPABILITY:${found.map}.${gapId}` : null;
    const prior = capabilityKey ? repairs.filter((r) => r.key === capabilityKey || r.key.startsWith(`${capabilityKey}#`)) : [];
    const latest = [...prior].sort((a, b) => a.attempt - b.attempt).at(-1);
    if (latest && latest.decision === null) continue; // an open repair owns it
    const oldest = held.map((g) => Date.parse(g.blockedSince)).reduce((a, b) => Math.min(a, b), now.getTime());
    const days = Math.floor((now.getTime() - oldest) / DAY);
    const dueSoon = held.filter((g) => g.dueAt && Date.parse(g.dueAt) - now.getTime() <= GOAL_DUE_SOON_DAYS * DAY);
    const methodInadequate = latest
      ? `A repair of ${capabilityKey} was decided ${latest.decision} at attempt ${latest.attempt}, and the gap still blocks ${held.length} live goal(s) ${days} day(s) later: that method did not unblock the objective.`
      : undefined;
    const owner = existingOwner(found?.requirement.owner ?? [], 'server/services/goals/plan.ts');
    const route = found?.requirement.improvement;
    out.push({
      key: `ORIGINATED:GOAL_CONSTRAINT:${gapId}`,
      kind: 'ORIGINATED_GOAL_CONSTRAINT',
      title: clip(`Live goals held by ${gapId} for ${days} day(s)${found ? `: ${found.requirement.ability}` : ''}`),
      problem:
        `${held.length} live goal(s) have been blocked by ${gapId} (${gap.status}: ${clip(gap.why, 160)}) with no change for ${days} day(s)` +
        (dueSoon.length ? `, ${dueSoon.length} of them due within ${GOAL_DUE_SOON_DAYS} days` : '') +
        '. ' +
        (methodInadequate ?? 'No repair is open or was attempted for it, so nothing was working toward the objective.'),
      metric: route?.metric ?? 'OBJECTIVE_HOURS_MEDIAN',
      downstreamMetric: route?.metric && route.metric !== 'OBJECTIVE_HOURS_MEDIAN' ? 'OBJECTIVE_HOURS_MEDIAN' : null,
      ownerComponent: owner,
      mutationScope: route?.mutationScope.length ? route.mutationScope : [owner, 'tests/**'],
      frequency: held.length,
      denominator: Math.max(goals.length, held.length),
      scope: 'GENERAL',
      severity: dueSoon.length > 0 || held.length >= 2 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `${found?.requirement.ability ?? gapId} What would unblock a live objective that has waited ${days} days on it${methodInadequate ? ', given the earlier repair did not' : ''}?`,
      samples: held.slice(0, 5).map((g) => clip(`goal ${g.goalId}: ${g.intent}`, 160)),
      knownCause: null,
      origination: {
        family: 'GOAL_CONSTRAINT',
        judgment:
          `Blocked ${days} day(s) unchanged (at least ${GOAL_STUCK_DAYS}) on ${held.length} live goal(s)` +
          (latest ? `; prior repair ${latest.decision}` : '; no prior repair') +
          (dueSoon.length ? `; ${dueSoon.length} due within ${GOAL_DUE_SOON_DAYS} days` : '') +
          '.',
        observed: held.map((g) => g.goalId),
        ...(methodInadequate ? { methodInadequate } : {}),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Failure patterns                                                           */
/* ------------------------------------------------------------------------- */

export interface TerminalBin {
  id: string;
  kind: string;
  state: string;
  reason: string | null;
}

/** Bins of one kind ending the same way across workers. Pure. */
export function failurePatternWeaknesses(bins: readonly TerminalBin[]): OriginatedWeakness[] {
  const totals = new Map<string, number>();
  const groups = new Map<string, { kind: string; reason: string; bins: TerminalBin[] }>();
  for (const bin of bins) {
    totals.set(bin.kind, (totals.get(bin.kind) ?? 0) + 1);
    if (bin.state !== 'FAILED' && bin.state !== 'NEEDS_HUMAN') continue;
    const reason = normalizeReason(bin.reason ?? '(no reason recorded)');
    const key = `${bin.kind}\u0000${reason}`;
    const group = groups.get(key) ?? { kind: bin.kind, reason, bins: [] };
    group.bins.push(bin);
    groups.set(key, group);
  }
  const owner = existingOwner(['server/services/bins/contracts.ts', 'server/repos/bins.ts'], 'server/repos/bins.ts');
  const out: OriginatedWeakness[] = [];
  for (const group of groups.values()) {
    const total = totals.get(group.kind) ?? group.bins.length;
    const share = group.bins.length / total;
    if (group.bins.length < FAILURE_MIN_COUNT || share < FAILURE_MIN_SHARE) continue;
    const needsHuman = group.bins.filter((b) => b.state === 'NEEDS_HUMAN').length;
    out.push({
      key: `ORIGINATED:FAILURE_PATTERN:${slugOf(group.kind, 32)}:${slugOf(group.reason, 40)}`,
      kind: 'ORIGINATED_FAILURE_PATTERN',
      title: clip(`${group.kind} work keeps ending the same way: ${group.reason}`),
      problem:
        `${group.bins.length} of ${total} ${group.kind} bin(s) that ended in ${FAILURE_WINDOW_DAYS} days ended ` +
        `${needsHuman ? `${needsHuman} NEEDS_HUMAN and ` : ''}${group.bins.length - needsHuman} FAILED for the same reason: ${group.reason}. ` +
        'The same failure across workers is a missing capability or a defective method, not one job.',
      metric: 'AUTO_RECOVERY_RATE',
      downstreamMetric: needsHuman ? 'OWNER_INTERVENTIONS_PER_DAY' : null,
      ownerComponent: owner,
      mutationScope: ['server/services/bins/**', 'server/services/dispatch/**', 'server/repos/bins.ts', 'tests/**'],
      frequency: group.bins.length,
      denominator: total,
      scope: 'GENERAL',
      severity: share >= 0.5 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `Why does ${group.kind} work end "${group.reason}", and what capability or method would let it finish?`,
      samples: group.bins.slice(0, 5).map((b) => clip(b.reason ?? '(no reason recorded)', 160)),
      knownCause: null,
      origination: {
        family: 'FAILURE_PATTERN',
        judgment: `${group.bins.length} of ${total} (${Math.round(share * 100)}%) is at least ${FAILURE_MIN_COUNT} and ${Math.round(FAILURE_MIN_SHARE * 100)}% of the kind's terminal bins in ${FAILURE_WINDOW_DAYS} days.`,
        observed: group.bins.slice(0, 20).map((b) => b.id),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Idle capacity                                                              */
/* ------------------------------------------------------------------------- */

export interface IdleRecord {
  id: string;
  actorId: string;
  attemptedAction: string;
}

/** Capacity idle beside executable work, recurring past the one continuation the watchdog asks for (§98). Pure. */
export function idleCapacityWeaknesses(records: readonly IdleRecord[], windowHours = 24): OriginatedWeakness[] {
  const byActor = new Map<string, IdleRecord[]>();
  for (const one of records) byActor.set(one.actorId, [...(byActor.get(one.actorId) ?? []), one]);
  const windows = Math.max(1, Math.round((windowHours * 60) / 10));
  const owner = existingOwner(['server/services/dispatch/loop.ts', 'server/services/engineering/watchdog.ts'], 'server/services/engineering/watchdog.ts');
  const out: OriginatedWeakness[] = [];
  for (const [actor, list] of byActor) {
    if (list.length < IDLE_MIN_RECORDS) continue;
    out.push({
      key: `ORIGINATED:IDLE_CAPACITY:${slugOf(actor)}`,
      kind: 'ORIGINATED_IDLE_CAPACITY',
      title: clip(`Capacity stands idle beside executable work (${actor})`),
      problem:
        `${actor} recorded idle capacity beside executable work ${list.length} time(s) in ${windowHours} hours ` +
        `(${list.length} of ${windows} ten-minute windows). The dispatch pass it asks for each time did not keep the capacity fed.`,
      metric: 'AUTO_RECOVERY_RATE',
      downstreamMetric: 'OBJECTIVE_HOURS_MEDIAN',
      ownerComponent: owner,
      mutationScope: ['server/services/dispatch/**', 'server/services/engineering/watchdog.ts', 'server/services/fleet/**', 'tests/**'],
      frequency: list.length,
      denominator: windows,
      scope: 'GENERAL',
      severity: list.length >= windows / 4 ? 'HIGH' : 'MEDIUM',
      researchQuestion: 'Why does a dispatch pass leave capacity idle while executable work waits, and what keeps every pool fed?',
      samples: list.slice(0, 5).map((r) => clip(r.attemptedAction, 160)),
      knownCause: null,
      origination: {
        family: 'IDLE_CAPACITY',
        judgment: `${list.length} idle record(s) in ${windowHours}h is at least ${IDLE_MIN_RECORDS}: an hour or more of idle capacity the continuation path did not consume.`,
        observed: list.slice(0, 20).map((r) => r.id),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Missed and closing opportunities                                           */
/* ------------------------------------------------------------------------- */

export interface OpeningRow {
  id: string;
  title: string;
  state: string;
  expiresAt: string;
}

const UNPURSUED = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY']);
/** An unpursued opening is moved by the cash lifecycle that owns it, not by a code change (S-0249). */
const OPENING_ROUTE_WHY = 'an opening is moved to execution by the cash lifecycle and its decisions; the openings are handed back to it to be re-decided while their window is open';

/** Openings whose window ended unpursued (per stage they stalled at), and openings closing now. Pure. */
export function opportunityWeaknesses(rows: readonly OpeningRow[], now: Date): OriginatedWeakness[] {
  const owner = existingOwner(['server/services/cash/lifecycle.ts', 'server/services/cash/opportunities.ts'], 'server/services/cash/opportunities.ts');
  const scope = ['server/services/cash/**', 'tests/**'];
  const closed = rows.filter((r) => Date.parse(r.expiresAt) <= now.getTime());
  const out: OriginatedWeakness[] = [];
  const byState = new Map<string, OpeningRow[]>();
  for (const one of closed.filter((r) => UNPURSUED.has(r.state))) byState.set(one.state, [...(byState.get(one.state) ?? []), one]);
  for (const [state, list] of byState) {
    const share = list.length / closed.length;
    if (list.length < MISSED_MIN_COUNT || share < MISSED_MIN_SHARE) continue;
    const stage = state.toLowerCase().replace(/_/g, ' ');
    out.push({
      key: `ORIGINATED:MISSED_OPPORTUNITY:${state}`,
      kind: 'ORIGINATED_MISSED_OPPORTUNITY',
      title: `Openings close while still ${stage}`,
      problem: `${list.length} of ${closed.length} openings whose window ended in ${MISSED_WINDOW_DAYS} days expired while still ${stage}: Brain did not move them to execution before the window closed.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: owner,
      mutationScope: scope,
      frequency: list.length,
      denominator: closed.length,
      scope: 'GENERAL',
      severity: share >= 0.5 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `What moves a time-limited opening from ${stage} to execution before its window closes?`,
      samples: list.slice(0, 5).map((r) => clip(r.title, 160)),
      knownCause: null,
      origination: {
        family: 'MISSED_OPPORTUNITY',
        route: { kind: 'COMMERCIAL', owner, why: OPENING_ROUTE_WHY },
        // The ones that expired cannot be pursued; the ones stalled at the same stage and still open can.
        handTo: rows.filter((r) => r.state === state && Date.parse(r.expiresAt) > now.getTime()).slice(0, 50).map((r) => r.id),
        judgment: `${list.length} missed of ${closed.length} closed (${Math.round(share * 100)}%) is at least ${MISSED_MIN_COUNT} and ${Math.round(MISSED_MIN_SHARE * 100)}%.`,
        observed: list.slice(0, 20).map((r) => r.id),
      },
    });
  }
  const closing = rows.filter(
    (r) => UNPURSUED.has(r.state) && Date.parse(r.expiresAt) > now.getTime() && Date.parse(r.expiresAt) - now.getTime() <= CLOSING_WINDOW_DAYS * DAY,
  );
  if (closing.length >= CLOSING_MIN_COUNT) {
    out.push({
      key: 'ORIGINATED:MISSED_OPPORTUNITY:CLOSING',
      kind: 'ORIGINATED_MISSED_OPPORTUNITY',
      title: `${closing.length} unpursued openings close within ${CLOSING_WINDOW_DAYS} days`,
      problem: `${closing.length} openings are still unpursued and their window ends within ${CLOSING_WINDOW_DAYS} days. Conditions are changing faster than Brain is acting on them; this work is worth more now than after the window.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: owner,
      mutationScope: scope,
      frequency: closing.length,
      denominator: Math.max(rows.filter((r) => UNPURSUED.has(r.state)).length, closing.length),
      scope: 'GENERAL',
      severity: 'HIGH',
      researchQuestion: 'What lets Brain act on a time-limited opening before its window closes?',
      samples: closing.slice(0, 5).map((r) => clip(`${r.title} (closes ${r.expiresAt})`, 160)),
      knownCause: null,
      origination: {
        family: 'MISSED_OPPORTUNITY',
        route: { kind: 'COMMERCIAL', owner, why: OPENING_ROUTE_WHY },
        handTo: closing.slice(0, 50).map((r) => r.id),
        judgment: `${closing.length} unpursued openings closing within ${CLOSING_WINDOW_DAYS} days is at least ${CLOSING_MIN_COUNT}.`,
        observed: closing.slice(0, 20).map((r) => r.id),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Unmet needs                                                                */
/* ------------------------------------------------------------------------- */

export interface NeedRow {
  id: string;
  opportunityId: string | null;
  blockerKey: string | null;
  blockedAction: string;
  recommendedPath: string;
  expectedCostCents: number | null;
}

/**
 * A resource, skill, dataset, integration, provider or relationship several
 * opportunities name as what blocks them. Whether obtaining it is worthwhile is
 * judged later from evidence (VALUE); no kind of need is assumed here. Pure.
 */
export function unmetNeedWeaknesses(needs: readonly NeedRow[]): OriginatedWeakness[] {
  const groups = new Map<string, NeedRow[]>();
  for (const need of needs) {
    const key = need.blockerKey?.trim() || normalizeReason(need.blockedAction).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), need]);
  }
  const out: OriginatedWeakness[] = [];
  for (const [key, list] of groups) {
    const opportunities = new Set(list.map((n) => n.opportunityId).filter(Boolean));
    if (opportunities.size < NEED_MIN_OPPORTUNITIES) continue;
    const newest = list.at(-1)!;
    // A missing resource is acquired by the owner its typed cause names (S-0249): a connector by the
    // capability registry, a supplier or payer by the commercial workflow, information by research,
    // a watched fact by reconsideration. It is never a code change to the need module.
    const route = needExecutionOwner(newest.blockerKey);
    const owner = existingOwner([route.owner], route.owner);
    const costs = list.map((n) => n.expectedCostCents).filter((c): c is number => c !== null);
    out.push({
      key: `ORIGINATED:UNMET_NEED:${slugOf(key)}`,
      kind: 'ORIGINATED_UNMET_NEED',
      title: clip(`${opportunities.size} opportunities wait on the same missing resource: ${newest.blockedAction}`),
      problem:
        `${opportunities.size} distinct opportunities are blocked by the same open need (${clip(newest.blockedAction, 160)}). ` +
        `The newest recorded path is: ${clip(newest.recommendedPath, 200)}. ` +
        (costs.length ? `Recorded expected cost: ${Math.min(...costs)}–${Math.max(...costs)} cents. ` : 'No cost is recorded; it is unknown. ') +
        'Obtaining it once unblocks all of them.',
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY',
      ownerComponent: owner,
      mutationScope: [owner, 'tests/**'],
      frequency: opportunities.size,
      denominator: Math.max(new Set(needs.map((n) => n.opportunityId).filter(Boolean)).size, opportunities.size),
      scope: 'GENERAL',
      severity: opportunities.size >= 4 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `How can Brain obtain or construct what "${clip(newest.blockedAction, 120)}" needs, and is it worth it for ${opportunities.size} opportunities?`,
      samples: list.slice(0, 5).map((n) => clip(`${n.blockedAction} → ${n.recommendedPath}`, 160)),
      knownCause: null,
      origination: {
        family: 'UNMET_NEED',
        judgment: `${opportunities.size} distinct opportunities name it (at least ${NEED_MIN_OPPORTUNITIES}); one acquisition serves all of them. Acquired by ${route.owner} (${route.route}): ${route.why}.`,
        observed: list.slice(0, 20).map((n) => n.id),
        route: { kind: route.route, owner, why: route.why },
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The reads                                                                  */
/* ------------------------------------------------------------------------- */

async function readGoalConstraints(now: Date): Promise<GoalConstraintObservation[]> {
  const db = getDb();
  const goals = await db.all<{ id: string; intent: string; due_at: string | null }>(
    `SELECT id, intent, due_at FROM workstreams
      WHERE archived_at IS NULL AND cancelled_at IS NULL AND project_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 20`,
    [],
  );
  const out: GoalConstraintObservation[] = [];
  const since = new Date(now.getTime() - 60 * DAY).toISOString();
  for (const goal of goals) {
    const events = await db.all<{ payload: string; created_at: string }>(
      `SELECT payload, created_at FROM project_events
        WHERE entity_type = 'WORKSTREAM' AND entity_id = ? AND event_type = 'CAPABILITY_ASSESSED' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 30`,
      [goal.id, since],
    );
    const parsed = events.flatMap((e) => {
      try {
        const p = JSON.parse(e.payload) as { ready?: boolean; blocking?: string[]; gaps?: { id: string; status: string; why: string }[] };
        return [{ at: e.created_at, ready: Boolean(p.ready), blocking: [...(p.blocking ?? [])].sort().join('|'), gaps: p.gaps ?? [] }];
      } catch {
        return [];
      }
    });
    const latest = parsed[0];
    if (!latest || latest.ready || !latest.blocking) continue;
    // The current run of unchanged blocking sets: walk back while the set is the same.
    let blockedSince = latest.at;
    for (const one of parsed) {
      if (one.blocking !== latest.blocking) break;
      blockedSince = one.at;
    }
    out.push({ goalId: goal.id, intent: goal.intent, dueAt: goal.due_at, blocking: latest.gaps, blockedSince });
  }
  return out;
}

async function readPriorRepairs(): Promise<PriorRepair[]> {
  const rows = await getDb().all<{ weakness_key: string; decision: string | null; attempt: number | string }>(
    "SELECT weakness_key, decision, attempt FROM improvement_candidates WHERE weakness_key LIKE 'CAPABILITY:%'",
    [],
  );
  return rows.map((r) => ({ key: r.weakness_key, decision: r.decision, attempt: Number(r.attempt) }));
}

async function readTerminalBins(now: Date): Promise<TerminalBin[]> {
  const from = new Date(now.getTime() - FAILURE_WINDOW_DAYS * DAY).toISOString();
  const rows = await getDb().all<{ id: string; kind: string; state: string; terminal_reason: string | null }>(
    `SELECT id, kind, state, terminal_reason FROM bins
      WHERE state IN ('COMPLETE', 'FAILED', 'NEEDS_HUMAN') AND updated_at >= ? AND updated_at <= ?
      ORDER BY updated_at DESC LIMIT 2000`,
    [from, now.toISOString()],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, state: r.state, reason: r.terminal_reason }));
}

async function readIdle(now: Date): Promise<IdleRecord[]> {
  const rows = await getDb().all<{ id: string; actor_id: string; attempted_action: string }>(
    `SELECT id, actor_id, attempted_action FROM engineering_interventions
      WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC LIMIT 500`,
    [new Date(now.getTime() - DAY).toISOString(), now.toISOString()],
  );
  return rows.map((r) => ({ id: r.id, actorId: r.actor_id, attemptedAction: r.attempted_action }));
}

async function readOpenings(now: Date): Promise<OpeningRow[]> {
  const rows = await getDb().all<{ id: string; title: string; state: string; expires_at: string }>(
    `SELECT id, title, state, expires_at FROM cash_opportunities
      WHERE expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ? AND duplicate_of_id IS NULL
      ORDER BY expires_at LIMIT 2000`,
    [new Date(now.getTime() - MISSED_WINDOW_DAYS * DAY).toISOString(), new Date(now.getTime() + CLOSING_WINDOW_DAYS * DAY).toISOString()],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, state: r.state, expiresAt: r.expires_at }));
}

async function readNeeds(): Promise<NeedRow[]> {
  const rows = await getDb().all<{
    id: string;
    opportunity_id: string | null;
    blocker_key: string | null;
    blocked_action: string;
    recommended_path: string;
    expected_cost_cents: number | string | null;
  }>(
    `SELECT id, opportunity_id, blocker_key, blocked_action, recommended_path, expected_cost_cents FROM cash_needs
      WHERE state = 'OPEN' ORDER BY created_at LIMIT 1000`,
    [],
  );
  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunity_id,
    blockerKey: r.blocker_key,
    blockedAction: r.blocked_action,
    recommendedPath: r.recommended_path,
    expectedCostCents: r.expected_cost_cents === null ? null : Number(r.expected_cost_cents),
  }));
}

export interface OriginationReport {
  weaknesses: OriginatedWeakness[];
  /** A family whose read failed: it raises nothing, and the failure is said rather than read as "nothing to do". */
  errors: string[];
}

/**
 * Everything the rows originate now, minus what a detector already raised this
 * pass. Each family is read independently, so one failed read never hides the
 * others.
 */
export async function originatedWeaknesses(now: Date, alreadyDetected: readonly string[] = []): Promise<OriginationReport> {
  const errors: string[] = [];
  const attempt = async <T>(family: OriginFamily, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${family}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return [];
    }
  };
  const all = [
    ...(await attempt('GOAL_CONSTRAINT', async () => goalConstraintWeaknesses(await readGoalConstraints(now), await readPriorRepairs(), now))),
    ...(await attempt('FAILURE_PATTERN', async () => failurePatternWeaknesses(await readTerminalBins(now)))),
    ...(await attempt('IDLE_CAPACITY', async () => idleCapacityWeaknesses(await readIdle(now)))),
    ...(await attempt('MISSED_OPPORTUNITY', async () => opportunityWeaknesses(await readOpenings(now), now))),
    ...(await attempt('UNMET_NEED', async () => unmetNeedWeaknesses(await readNeeds()))),
  ];
  const taken = new Set(alreadyDetected);
  return { weaknesses: all.filter((w) => !taken.has(w.key)), errors };
}

