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
 * Brain-wide, so they are shown once here rather than as a copy per goal:
 * `research` is the newest recorded `GOAL_RESEARCH_REALLOCATED` decision read
 * back from the goals' own rows, and its sentence ends the headline that Home
 * and the goals page render. Nothing here decides; it only reads the row.
 */
import { assembleGoals, type GoalDecision, type GoalView } from './model.ts';

export interface GoalBriefing {
  headline: string;
  delivered: { goalId: string; title: string; evidence: string; ref: string }[];
  active: { goalId: string; title: string; waiting: string; next: string; by: string }[];
  milestones: { goalId: string; title: string; next: string; afterwards: string | null; dueAt: string | null; overdue: boolean }[];
  agingBlockers: { goalId: string; title: string; blocker: string; remedy: string; by: string; ageHours: number | null }[];
  commitments: { goalId: string; title: string; commitment: string; dueAt: string | null; overdue: boolean; obligations: string[] }[];
  decisions: (GoalDecision & { goalId: string; goalTitle: string })[];
  counts: { active: number; paused: number; cancelled: number; complete: number; needsYou: number; blocked: number };
  /** The research allocation in force and the capacity it found, from its recorded row; null when none was recorded. */
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
  /** Capacity verdicts per lane; an addition is a recommendation only. */
  capacity: { lane: string; kind: string; units: number; resource: string | null; reason: string }[];
  /** Lane remedies tried before any limit is raised. */
  laneActions: { lane: string; kind: string; reason: string }[];
  /** Resources the window measured as constraining. */
  bottlenecks: { lane: string; resource: string }[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** A recorded allocation decision, read for a person. Pure; a row that carries no shares reads as none. */
export function researchBriefingFrom(detail: Record<string, unknown> | null, decidedAt: string | null): ResearchBriefing | null {
  if (!detail || !detail.shares || typeof detail.shares !== 'object') return null;
  const sharesIn = detail.shares as Record<string, unknown>;
  const observedIn = (detail.observed && typeof detail.observed === 'object' ? detail.observed : {}) as Record<string, unknown>;
  const shares = Object.keys(RESEARCH_PURPOSE_WORDS)
    .filter((p) => num(sharesIn[p]) !== null)
    .map((p) => ({ purpose: p, share: num(sharesIn[p])!, observed: num(observedIn[p]) }));
  if (shares.length === 0) return null;
  const floorsIn = (detail.floors && typeof detail.floors === 'object' ? detail.floors : {}) as Record<string, unknown>;
  const floors = { exploration: num(floorsIn.exploration), systemHealth: num(floorsIn.systemHealth), commercial: num(floorsIn.commercial) };
  const capacity = list(detail.capacity).map((c) => ({ lane: str(c.lane), kind: str(c.kind), units: num(c.units) ?? 0, resource: typeof c.resource === 'string' ? c.resource : null, reason: str(c.reason) }));
  const laneActions = list(detail.laneActions).map((a) => ({ lane: str(a.lane), kind: str(a.kind), reason: str(a.reason) }));
  const bottlenecks = list(detail.bottlenecks).map((b) => ({ lane: str(b.lane), resource: str(b.resource) }));
  const w = detail.window as { since?: unknown; until?: unknown } | undefined;
  const window = w && typeof w.since === 'string' && typeof w.until === 'string' ? { since: w.since, until: w.until } : null;
  const held = detail.held === true;

  const parts: string[] = [];
  if (held) parts.push('Research allocation held: nothing in the last window was measured');
  else parts.push(`Research: ${shares.map((s) => `${RESEARCH_PURPOSE_WORDS[s.purpose]} ${pct(s.share)}${s.observed !== null ? ` (got ${pct(s.observed)})` : ''}`).join(', ')}`);
  const kept = [
    floors.exploration !== null ? `exploration ≥ ${pct(floors.exploration)}` : null,
    floors.systemHealth !== null ? `system health ≥ ${pct(floors.systemHealth)}` : null,
    floors.commercial !== null ? `commercial ≥ ${pct(floors.commercial)}` : null,
  ].filter(Boolean);
  if (kept.length) parts.push(`floors ${kept.join(', ')}`);
  const added = capacity.filter((c) => c.kind === 'ADD_CAPACITY');
  if (added.length) parts.push(`capacity recommended: ${added.map((c) => `${c.lane} +${c.units} (${c.resource ?? 'unknown'})`).join(', ')}`);
  else if (bottlenecks.length) parts.push(`constrained: ${bottlenecks.map((b) => `${b.lane} (${b.resource})`).join(', ')}, no capacity added`);
  else parts.push('no capacity constraint measured');
  if (laneActions.length) parts.push(`lanes: ${laneActions.map((a) => `${a.lane} ${a.kind.toLowerCase().replace(/_/g, ' ')}`).join(', ')}`);
  return { line: `${parts.join('; ')}.`, decidedAt, window, held, shares, floors, capacity, laneActions, bottlenecks };
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
        overdue: goal.overdue,
        obligations: goal.obligations,
      })),
    decisions,
    counts,
    research,
    generatedAt,
  };
}

/** How many live goals are read for the newest decision: a changed decision is written to every live goal, so a few suffice. */
const RESEARCH_GOALS_READ = 10;

/** The newest recorded research allocation decision on the live goals, or null. */
export async function researchInForceForBriefing(goals: GoalView[]): Promise<ResearchBriefing | null> {
  const active = goals.filter((one) => one.lifecycle === 'ACTIVE').slice(0, RESEARCH_GOALS_READ);
  if (active.length === 0) return null;
  const { listWorkstreamEvents } = await import('../../repos/register.ts');
  const { RESEARCH_REALLOCATED_EVENT } = await import('./tick.ts');
  let newest: { detail: Record<string, unknown>; at: string } | null = null;
  for (const goal of active) {
    const found = (await listWorkstreamEvents(goal.id, 200)).find((e) => e.kind === RESEARCH_REALLOCATED_EVENT);
    if (found && (!newest || found.createdAt > newest.at)) newest = { detail: found.detail as Record<string, unknown>, at: found.createdAt };
  }
  return newest ? researchBriefingFrom(newest.detail, newest.at) : null;
}

export async function goalBriefing(projectIds: string[]): Promise<{ briefing: GoalBriefing; goals: GoalView[] }> {
  const snapshot = await assembleGoals({ projectIds });
  const research = await researchInForceForBriefing(snapshot.goals);
  return { briefing: briefFrom(snapshot.goals, snapshot.generatedAt, research), goals: snapshot.goals };
}
