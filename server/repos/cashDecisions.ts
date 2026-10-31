/**
 * The decision record: one current decision per opportunity per goal, with the
 * ones it replaced kept behind it.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { CashDecision, DecisionVerdict } from '../domain/cashDecisions.ts';

interface Row {
  id: string; project_id: string; opportunity_id: string; goal_id: string; verdict: DecisionVerdict;
  reason: string; detail: string; binding_constraint: string | null; missing_facts: string; evidence_ids: string;
  reopen_condition: string; change_ref: string; is_current: number | string;
  recompute_change_ref: string | null; recompute_requested_at: string | null;
  decided_at: string; superseded_at: string | null;
}

const map = (r: Row): CashDecision => ({
  id: r.id, projectId: r.project_id, opportunityId: r.opportunity_id, goalId: r.goal_id, verdict: r.verdict,
  reason: r.reason, detail: r.detail, bindingConstraint: r.binding_constraint,
  missingFacts: parseJson<string[]>(r.missing_facts, []), evidenceIds: parseJson<string[]>(r.evidence_ids, []),
  reopenCondition: r.reopen_condition, changeRef: r.change_ref, isCurrent: Number(r.is_current) === 1,
  recomputeChangeRef: r.recompute_change_ref, recomputeRequestedAt: r.recompute_requested_at,
  decidedAt: r.decided_at, supersededAt: r.superseded_at,
});

class Lost extends Error {}

export interface NewDecision {
  projectId: string;
  opportunityId: string;
  goalId: string;
  verdict: DecisionVerdict;
  reason: string;
  detail: string;
  bindingConstraint?: string | null;
  missingFacts?: string[];
  evidenceIds?: string[];
  reopenCondition: string;
  changeRef: string;
  at?: string;
}

/**
 * Make this the current decision. True only when this change ref had not
 * already produced a decision for the pair: a replay, a restart or a second
 * instance records nothing and leaves the current decision where it was.
 */
export async function recordDecision(input: NewDecision): Promise<boolean> {
  const at = input.at ?? nowIso();
  const ref = input.changeRef.trim();
  if (!ref) return false;
  // The producer asks this for every opening on every pass, and almost every
  // pair is unchanged. Answer that from the unique index without opening a
  // transaction: production held one write transaction per pair per pass,
  // each superseding the current row only to roll it back (2026-10-31, 584
  // transactions in 32 minutes). A pair that changes between this read and the
  // insert is still decided by the transaction below.
  const seen = await getDb().get<{ one: number }>(
    'SELECT 1 AS one FROM cash_decisions WHERE opportunity_id = ? AND goal_id = ? AND change_ref = ?',
    [input.opportunityId, input.goalId, ref],
  );
  if (seen) return false;
  try {
    return await getDb().transaction(async () => {
      await getDb().run(
        `UPDATE cash_decisions SET is_current = 0, superseded_at = ?
          WHERE opportunity_id = ? AND goal_id = ? AND is_current = 1`,
        [at, input.opportunityId, input.goalId],
      );
      const inserted = await getDb().run(
        `INSERT INTO cash_decisions
           (id, project_id, opportunity_id, goal_id, verdict, reason, detail, binding_constraint,
            missing_facts, evidence_ids, reopen_condition, change_ref, is_current, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT DO NOTHING`,
        [newId('cdc'), input.projectId, input.opportunityId, input.goalId, input.verdict, input.reason, input.detail,
          input.bindingConstraint ?? null, toJson(input.missingFacts ?? []), toJson(input.evidenceIds ?? []),
          input.reopenCondition, ref, at],
      );
      if (inserted.changes !== 1) throw new Lost();
      return true;
    });
  } catch (error) {
    if (error instanceof Lost) return false;
    throw error;
  }
}

export async function currentDecision(opportunityId: string, goalId: string): Promise<CashDecision | null> {
  const row = await getDb().get<Row>(
    'SELECT * FROM cash_decisions WHERE opportunity_id = ? AND goal_id = ? AND is_current = 1',
    [opportunityId, goalId],
  );
  return row ? map(row) : null;
}

export async function decisionHistory(opportunityId: string, goalId: string): Promise<CashDecision[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_decisions WHERE opportunity_id = ? AND goal_id = ? ORDER BY decided_at, is_current, id',
    [opportunityId, goalId],
  );
  return rows.map(map);
}

export async function currentDecisionsForGoal(projectId: string, goalId: string): Promise<CashDecision[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_decisions WHERE project_id = ? AND goal_id = ? AND is_current = 1 ORDER BY decided_at, id',
    [projectId, goalId],
  );
  return rows.map(map);
}

/** Counts of current decisions by verdict, for the measurement report. */
/** Every current decision in a project, across its goals, for a reader that wants them all at once. */
export async function currentDecisionsForProject(projectId: string): Promise<CashDecision[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_decisions WHERE project_id = ? AND is_current = 1 ORDER BY decided_at, id',
    [projectId],
  );
  return rows.map(map);
}

export async function decisionCounts(projectId: string, goalId: string): Promise<Record<DecisionVerdict, number>> {
  const rows = await getDb().all<{ verdict: DecisionVerdict; n: number | string }>(
    `SELECT verdict, COUNT(*) AS n FROM cash_decisions
      WHERE project_id = ? AND goal_id = ? AND is_current = 1 GROUP BY verdict`,
    [projectId, goalId],
  );
  const out: Record<DecisionVerdict, number> = { REJECT: 0, HOLD: 0, PRIORITIZE: 0 };
  for (const r of rows) out[r.verdict] = Number(r.n);
  return out;
}

/**
 * Ask for this opportunity's current decisions to be recomputed for a change.
 * Re-asking with the same ref changes nothing; a decision already built from
 * that ref is not asked again.
 */
export async function requestDecisionRecompute(opportunityId: string, changeRef: string, at: string = nowIso()): Promise<number> {
  const result = await getDb().run(
    `UPDATE cash_decisions SET recompute_change_ref = ?, recompute_requested_at = ?
      WHERE opportunity_id = ? AND is_current = 1 AND change_ref <> ?
        AND (recompute_change_ref IS NULL OR recompute_change_ref <> ?)`,
    [changeRef, at, opportunityId, changeRef, changeRef],
  );
  return result.changes ?? 0;
}

/** Current decisions waiting to be recomputed for a project. */
export async function decisionsAwaitingRecompute(projectId: string): Promise<CashDecision[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_decisions WHERE project_id = ? AND is_current = 1 AND recompute_change_ref IS NOT NULL
      ORDER BY recompute_requested_at, id`,
    [projectId],
  );
  return rows.map(map);
}

/** Withdraw a recompute request that produced no new decision. */
export async function clearRecomputeRequest(decisionId: string): Promise<void> {
  await getDb().run(
    'UPDATE cash_decisions SET recompute_change_ref = NULL, recompute_requested_at = NULL WHERE id = ?',
    [decisionId],
  );
}
