/**
 * The briefing across goals, for somebody coming back.
 *
 * Five answers and a headline, in the order a person who walked away asks
 * them: what was delivered, what is running, what comes next, what has been
 * stuck and for how long, what is committed, and what needs them. Every line
 * is a goal's own derived reading — `model.ts` is the one derivation and this
 * only chooses and orders — so the briefing and a goal's own page cannot
 * disagree, which is §29's one-projection rule at a new surface.
 *
 * "Delivered" is evidence, never a claim: a goal appears there only with the
 * row that says it delivered, and "recently" is the time of that row.
 *
 * Research capacity and the allocation decision (RES-07, RES-15-5) are
 * Brain-wide, so they are shown once, here, and never as a copy per goal:
 * `research` reads the one newest `RESEARCH_ALLOCATION_DECIDED` row the goals
 * tick wrote, and its sentence ends the headline that Home and the goals page
 * render. Nothing here decides; it only reads the row.
 */
import { assembleGoals, type GoalDecision, type GoalView } from './model.ts';

export interface GoalBriefing {
  headline: string;
  delivered: { goalId: string; title: string; evidence: string; ref: string }[];
  active: { goalId: string; title: string; waiting: string; next: string; by: string }[];
  milestones: { goalId: string; title: string; next: string; afterwards: string | null; dueAt: string | null; deadline: string | null; overdue: boolean }[];
  agingBlockers: { goalId: string; title: string; blocker: string; remedy: string; by: string; ageHours: number | null }[];
  commitments: { goalId: string; title: string; commitment: string; dueAt: string | null; deadline: string | null; overdue: boolean; obligations: string[] }[];
  decisions: (GoalDecision & { goalId: string; goalTitle: string })[];
  counts: { active: number; paused: number; cancelled: number; complete: number; needsYou: number; blocked: number };
  /** The research allocation in force and the capacity it was measured at; null when no decision was recorded. */
  research?: ResearchBriefing | null;
  generatedAt: string;
}

const RESEARCH_PURPOSE_WORDS: Record<string, string> = {
  BROAD_DISCOVERY: 'broad discovery',
  TRANSACTION_ROUTES: 'transaction routes',
  OPERATING_SUPPORT: 'operating support',
  SELF_IMPROVEMENT: 'self-improvement',
  FORWARD_EXPLORATION: 'forward exploration',
};

export interface ResearchBriefing {
  /** The sentence the headline carries. */
  line: string;
  decidedAt: string | null;
  window: { since: string; until: string } | null;
  held: boolean;
  /** Decided share per purpose, and what the window actually gave it. */
  shares: { purpose: string; share: number; observed: number | null }[];
  floors: { exploration: number | null; systemHealth: number | null; commercial: number | null };
  /** The goals whose own deadlines put the commercial floor in force. */
  deadlineGoals: string[];
  /** Research capacity per lane, as the window measured it. */
  laneCapacity: { lane: string; utilization: number | null; inFlight: number | null; queueWaitMedianMs: number | null; rateLimited: number | null }[];
  /** Capacity verdicts per lane; an addition is a recommendation only. */
  capacity: { lane: string; kind: string; units: number; resource: string | null; reason: string }[];
  /** Lane remedies, each tried before any limit is raised. */
  laneActions: { lane: string; kind: string; reason: string }[];
  /**
   * Whether this decision's window shows each job's cost counted once, and the
   * earlier decisions the probe still reads that did not, with the earliest
   * one's cause as the row's own audit diagnosed it (`priorCostFailures`).
   */
  costCountedOnce: { holds: boolean | null; earlierFailures: number; earliestCause: string | null; earliestAt: string | null };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The Brain-wide decision row, read for a person. Pure; a row that carries no shares reads as none. */
export function researchBriefingFrom(detail: Record<string, unknown> | null, decidedAt: string | null): ResearchBriefing | null {
  if (!detail) return null;
  const sharesIn = obj(detail.shares);
  const observedIn = obj(detail.observed);
  const shares = Object.keys(RESEARCH_PURPOSE_WORDS)
    .filter((p) => num(sharesIn[p]) !== null)
    .map((p) => ({ purpose: p, share: num(sharesIn[p])!, observed: num(observedIn[p]) }));
  if (shares.length === 0) return null;
  const floorsIn = obj(detail.floors);
  const floors = { exploration: num(floorsIn.exploration), systemHealth: num(floorsIn.systemHealth), commercial: num(floorsIn.commercial) };
  const laneCapacity = records(detail.laneCapacity).map((c) => ({ lane: str(c.lane), utilization: num(c.utilization), inFlight: num(c.inFlight), queueWaitMedianMs: num(c.queueWaitMedianMs), rateLimited: num(c.rateLimited) }));
  const capacity = records(detail.capacity).map((c) => ({ lane: str(c.lane), kind: str(c.kind), units: num(c.units) ?? 0, resource: typeof c.resource === 'string' ? c.resource : null, reason: str(c.reason) }));
  const laneActions = records(detail.laneActions).map((a) => ({ lane: str(a.lane), kind: str(a.kind), reason: str(a.reason) }));
  const deadlineGoals = Array.isArray(detail.deadlineGoals) ? detail.deadlineGoals.filter((g): g is string => typeof g === 'string') : [];
  const w = obj(detail.window);
  const window = typeof w.since === 'string' && typeof w.until === 'string' ? { since: w.since, until: w.until } : null;
  const held = detail.held === true;
  const onceIn = obj(detail.costCountedOnce);
  const audit = obj(detail.priorCostFailures);
  const earliest = obj(audit.earliest);
  // The cause a person reads is what the job rows showed, when they showed one; otherwise what the row's own numbers did.
  const earliestCause =
    typeof earliest.shownByJobs === 'string' && earliest.shownByJobs !== 'NOT_SHOWN' ? earliest.shownByJobs : typeof earliest.cause === 'string' ? earliest.cause : null;
  const costCountedOnce = {
    holds: typeof onceIn.holds === 'boolean' ? onceIn.holds : null,
    earlierFailures: num(audit.failing) ?? 0,
    earliestCause,
    earliestAt: typeof earliest.at === 'string' ? earliest.at : null,
  };

  const parts: string[] = [];
  if (held) parts.push('Research allocation held: nothing in the last window was measured');
  else parts.push(`Research: ${shares.map((s) => `${RESEARCH_PURPOSE_WORDS[s.purpose]} ${pct(s.share)}${s.observed !== null ? ` (got ${pct(s.observed)})` : ''}`).join(', ')}`);
  const kept = [
    floors.exploration !== null ? `exploration ≥ ${pct(floors.exploration)}` : null,
    floors.systemHealth !== null ? `system health ≥ ${pct(floors.systemHealth)}` : null,
    floors.commercial !== null ? `commercial ≥ ${pct(floors.commercial)} (${deadlineGoals.length} goal deadline(s))` : null,
  ].filter(Boolean);
  if (kept.length) parts.push(`floors ${kept.join(', ')}`);
  if (laneCapacity.length) {
    parts.push(`capacity: ${laneCapacity.map((c) => `${c.lane} ${c.utilization !== null ? `avg ${c.utilization.toFixed(1)} running` : 'unmeasured'}${c.inFlight ? `, ${c.inFlight} in flight` : ''}${c.queueWaitMedianMs !== null ? `, wait ${Math.round(c.queueWaitMedianMs / 60_000)}m` : ''}${c.rateLimited ? `, ${c.rateLimited} rate-limited` : ''}`).join('; ')}`);
  }
  const added = capacity.filter((c) => c.kind === 'ADD_CAPACITY');
  if (added.length) parts.push(`capacity recommended: ${added.map((c) => `${c.lane} +${c.units} (${c.resource ?? 'unknown'})`).join(', ')}`);
  else parts.push('no capacity added');
  if (laneActions.length) parts.push(`lanes: ${laneActions.map((a) => `${a.lane} ${a.kind.toLowerCase().replace(/_/g, ' ')}`).join(', ')}`);
  if (costCountedOnce.earlierFailures > 0) {
    parts.push(
      `${costCountedOnce.earlierFailures} earlier decision(s) did not show cost counted once` +
        (costCountedOnce.earliestCause ? ` (earliest: ${costCountedOnce.earliestCause.toLowerCase().replace(/_/g, ' ')})` : ''),
    );
  }
  return { line: `${parts.join('; ')}.`, decidedAt, window, held, shares, floors, deadlineGoals, laneCapacity, capacity, laneActions, costCountedOnce };
}

export function briefFrom(goals: GoalView[], generatedAt: string, research: ResearchBriefing | null = null): GoalBriefing {
  const live = goals.filter((one) => one.lifecycle !== 'ARCHIVED');
  const active = live.filter((one) => one.lifecycle === 'ACTIVE');

  const delivered = live
    .filter((one) => one.lifecycle === 'COMPLETE' || one.evidence.length > 0)
    .flatMap((goal) =>
      goal.evidence.slice(0, 3).map((item) => ({
        goalId: goal.id,
        title: goal.title,
        evidence: item.what,
        ref: item.ref,
      })),
    );

  const decisions = live
    .flatMap((goal) => goal.decisions.map((decision) => ({ ...decision, goalId: goal.id, goalTitle: goal.title })))
    // What waits longest first: a decision a person has sat on for a week is
    // the one most worth their next minute.
    .sort((a, b) => (a.since ?? '9999') < (b.since ?? '9999') ? -1 : 1);

  const agingBlockers = live
    .flatMap((goal) =>
      goal.blockers.map((blocker) => ({
        goalId: goal.id,
        title: goal.title,
        blocker: blocker.text,
        remedy: blocker.remedy,
        by: blocker.by,
        ageHours: blocker.ageHours,
      })),
    )
    .sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));

  const counts = {
    active: active.length,
    paused: live.filter((one) => one.lifecycle === 'PAUSED').length,
    cancelled: live.filter((one) => one.lifecycle === 'CANCELLED').length,
    complete: live.filter((one) => one.lifecycle === 'COMPLETE').length,
    needsYou: new Set(decisions.map((one) => one.goalId)).size,
    blocked: new Set(agingBlockers.map((one) => one.goalId)).size,
  };

  const parts: string[] = [];
  if (live.length === 0) {
    parts.push('No goals are set. Brain is doing the work it was asked for, but nothing here says what that work is for.');
  } else {
    parts.push(`${counts.active} active goal(s)`);
    if (counts.complete) parts.push(`${counts.complete} delivered`);
    if (counts.paused) parts.push(`${counts.paused} paused`);
    if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
    parts.push(
      decisions.length
        ? `${decisions.length} decision(s) wait on you`
        : 'nothing waits on you',
    );
  }

  return {
    headline: [live.length === 0 ? parts[0]! : `${parts.join(' · ')}.`, research?.line].filter(Boolean).join(' '),
    delivered,
    active: active.map((goal) => ({
      goalId: goal.id,
      title: goal.title,
      waiting: `${goal.waiting.kind}: ${goal.waiting.detail}`,
      next: goal.next.action,
      by: goal.next.by,
    })),
    milestones: active.map((goal) => ({
      goalId: goal.id,
      title: goal.title,
      next: goal.next.action,
      afterwards: goal.next.afterwards,
      dueAt: goal.dueAt,
      deadline: goal.deadline,
      overdue: goal.overdue,
    })),
    agingBlockers,
    commitments: live
      .filter((goal) => goal.commitment !== 'NONE' || goal.obligations.length > 0 || goal.dueAt !== null)
      .map((goal) => ({
        goalId: goal.id,
        title: goal.title,
        commitment: goal.commitmentLabel,
        dueAt: goal.dueAt,
        deadline: goal.deadline,
        overdue: goal.overdue,
        obligations: goal.obligations,
      })),
    decisions,
    counts,
    research,
    generatedAt,
  };
}

export async function goalBriefing(projectIds: string[]): Promise<{ briefing: GoalBriefing; goals: GoalView[] }> {
  const snapshot = await assembleGoals({ projectIds });
  const { latestResearchDecision } = await import('./tick.ts');
  const decided = await latestResearchDecision();
  const research = decided ? researchBriefingFrom(decided.detail, decided.at) : null;
  return { briefing: briefFrom(snapshot.goals, snapshot.generatedAt, research), goals: snapshot.goals };
}
