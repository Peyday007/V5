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
  generatedAt: string;
}

export function briefFrom(goals: GoalView[], generatedAt: string): GoalBriefing {
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
    headline: live.length === 0 ? parts[0]! : `${parts.join(' · ')}.`,
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
    generatedAt,
  };
}

export async function goalBriefing(projectIds: string[]): Promise<{ briefing: GoalBriefing; goals: GoalView[] }> {
  const snapshot = await assembleGoals({ projectIds });
  return { briefing: briefFrom(snapshot.goals, snapshot.generatedAt), goals: snapshot.goals };
}
