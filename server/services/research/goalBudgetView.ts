/**
 * Where each of a project's research goals stands, and which ceiling — if any —
 * is the one stopping new work.
 *
 * Derived on every read and stored nowhere: `goalBudgetStatus` already reads the
 * counts and the clock, and a stored "stopped by" would be stale the moment a
 * packet finished or the deadline passed. The sentence is composed here, once,
 * so the HTTP door, the terminal and the screen all say the same thing rather
 * than each paraphrasing it.
 *
 * Raising a ceiling is deliberately not offered anywhere: the sentence says it
 * is the person's decision, and the way to act on it is to revoke and open a
 * new goal.
 */
import { getDb } from '../../db/database.ts';
import { getUser } from '../../repos/identity.ts';
import { goalBudgetStatus } from '../../repos/russellAuthority.ts';
import type { GoalBudgetStatus } from '../../repos/russellAuthority.ts';

export type StoppingCeiling = 'REVOKED' | 'PAUSED' | 'DEADLINE' | 'PACKETS' | 'FRAGMENTS';

export interface GoalBudgetView extends GoalBudgetStatus {
  /** Who authorized it, as a person would read it; falls back to the id. */
  authorizedByName: string;
  /** The ceiling that currently stops new work, or null when nothing does. */
  stoppedBy: StoppingCeiling | null;
  /** The server's own sentence; clients render it and compose none of their own. */
  stoppingSentence: string;
}

/** Pure: which ceiling stops this goal now, and the sentence a person reads. */
export function stoppingReason(status: GoalBudgetStatus): {
  stoppedBy: StoppingCeiling | null;
  sentence: string;
} {
  const decision = 'Raising it is your decision: revoke this goal and open a new one with the ceiling you want.';
  if (status.state === 'REVOKED') {
    return { stoppedBy: 'REVOKED', sentence: `Stopped: this goal was revoked, so no new work starts under it. ${decision}` };
  }
  if (status.state === 'PAUSED') {
    return { stoppedBy: 'PAUSED', sentence: 'Stopped: this goal is paused, so no new work starts under it until it is resumed.' };
  }
  if (status.state === 'EXPIRED') {
    return {
      stoppedBy: 'DEADLINE',
      sentence: `Stopped by the deadline (${status.deadline ?? 'unknown'}): Brain's clock is past it, so no new packet or fragment starts. ${decision}`,
    };
  }
  const packetsHeld = Math.max(status.packets.used, status.packets.reserved);
  if (packetsHeld >= status.packets.ceiling) {
    return {
      stoppedBy: 'PACKETS',
      sentence: `Stopped by the packet ceiling: ${packetsHeld} of ${status.packets.ceiling} packets are used, so no new packet starts. ${decision}`,
    };
  }
  if (status.fragments.committed >= status.fragments.ceiling) {
    return {
      stoppedBy: 'FRAGMENTS',
      sentence: `Stopped by the fragment ceiling: ${status.fragments.committed} of ${status.fragments.ceiling} fragments are committed, so no new fragment starts. ${decision}`,
    };
  }
  return { stoppedBy: null, sentence: 'Nothing stops it: every ceiling still has headroom and the deadline has not passed.' };
}

export async function goalBudgetViewFor(goalId: string, at?: string): Promise<GoalBudgetView | null> {
  const status = await goalBudgetStatus(goalId, at);
  if (!status) return null;
  const { stoppedBy, sentence } = stoppingReason(status);
  const user = await getUser(status.authorizedBy);
  return {
    ...status,
    authorizedByName: user?.displayName || status.authorizedBy,
    stoppedBy,
    stoppingSentence: sentence,
  };
}

/** Every research goal the project holds, newest first, revoked ones included. */
export async function listGoalBudgetViews(projectId: string, at?: string): Promise<GoalBudgetView[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_goals WHERE project_id = ? AND purpose = 'RESEARCH_GOAL'
      ORDER BY created_at DESC, rowid DESC`,
    [projectId],
  );
  const views: GoalBudgetView[] = [];
  for (const row of rows) {
    const view = await goalBudgetViewFor(row.id, at);
    if (view) views.push(view);
  }
  return views;
}
