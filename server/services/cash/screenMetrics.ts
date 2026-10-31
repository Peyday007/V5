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
