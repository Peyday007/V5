/**
 * Production probe for GOAL-09: the $10K SQUEEZE constraints bind only the goal
 * that carries them, and a candidate plan is never an accepted one.
 *
 * Read from rows, never from a constructed case:
 *  - every live targeted goal resolves its project to SQUEEZE (a goal with a
 *    target and a deadline is pursued, not tested), and a project no such goal
 *    targets resolves to EVIDENCE_FIRST — the goal's ceilings are not a default;
 *  - every persisted plan reading from the acceptance rule's day on says what it
 *    was: RECOMMENDABLE only with an ACCEPTED acceptance whose probability rests
 *    on the ledger, an evidenced portfolio or this Brain's measured record, read
 *    at a lower bound that clears the required probability — coverage of assumed
 *    inputs is never that basis; a CANDIDATE_ONLY or NO_CANDIDATE reading holds no
 *    accepted plan and no probability, and is not RECOMMENDABLE;
 *  - a goal whose latest reading is not accepted is still a SQUEEZE goal, so
 *    execution of authorized offers continues while the plan is unproven.
 * With no live goal, or no reading that carries an acceptance, the answer is a
 * failure: nothing to look at is not a demonstration (§39).
 *
 * Registered here because `probes.ts` is a protected path; `policy.ts` imports
 * this module so it is registered wherever the policy is resolved.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';
import { executionPolicyForProject, forgetExecutionPolicies } from '../../../goals/policy.ts';

export const GOAL_ACCEPTANCE_PROBE = 'r01.goal-09';

/** The day the owner's acceptance rule took effect; earlier readings carry no acceptance and are not judged by it. */
export const ACCEPTANCE_RULE_FROM = '2026-11-09';

const DEFENSIBLE_BASES = new Set(['TARGET_MET', 'EVIDENCED_PORTFOLIO', 'MEASURED_RECORD']);

interface Acceptance {
  status?: string;
  required?: number;
  probability?: { basis?: string; lowerBound?: number } | null;
  accepted?: unknown;
}

/** Why a persisted reading contradicts the acceptance rule, or null when it keeps it. Pure. */
export function readingProblem(verdict: string, acceptance: Acceptance | null, requiredProbability: number): string | null {
  if (!acceptance || typeof acceptance.status !== 'string') return 'carries no acceptance record';
  const { status, probability, accepted } = acceptance;
  if (status === 'ACCEPTED') {
    if (verdict !== 'RECOMMENDABLE') return 'is ACCEPTED but its verdict is not RECOMMENDABLE';
    if (!probability || !accepted) return 'is ACCEPTED without a probability and an accepted plan';
    if (!probability.basis || !DEFENSIBLE_BASES.has(probability.basis)) return `is ACCEPTED on basis "${probability.basis ?? 'none'}", which is not a defensible probability`;
    if (typeof acceptance.required !== 'number' || acceptance.required < requiredProbability) return 'was accepted under a bar lower than the one required';
    if (probability.basis !== 'TARGET_MET' && !(typeof probability.lowerBound === 'number' && probability.lowerBound >= acceptance.required)) {
      return 'is ACCEPTED with a lower bound under the required probability';
    }
    return null;
  }
  // NOT_SUPPORTED: the goal as stated is out of reach by arithmetic — no plan, held to the candidate's rule.
  if (status === 'CANDIDATE_ONLY' || status === 'NO_CANDIDATE' || status === 'NOT_SUPPORTED') {
    if (verdict === 'RECOMMENDABLE') return 'is only a candidate but its verdict says RECOMMENDABLE';
    if (accepted || probability) return 'is only a candidate yet holds an accepted plan or a probability';
    return null;
  }
  return `has unknown acceptance status "${status}"`;
}

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function goalAcceptanceHoldsOnRows(): Promise<ProbeResult> {
  const db = getDb();
  const { RECOMMENDATION_POLICY } = await import('../../../goals/plan.ts');
  forgetExecutionPolicies();
  const goals = await db.all<{ id: string; target_project_id: string }>(
    `SELECT id, target_project_id FROM workstreams
      WHERE target_metric IS NOT NULL AND target_amount_cents IS NOT NULL AND target_project_id IS NOT NULL AND due_at IS NOT NULL AND due_at > ?
        AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL ORDER BY id`,
    [new Date().toISOString()],
  );
  if (goals.length === 0) return { ok: false, detail: 'no live goal carries a target and a deadline: nothing to read the constraints from' };

  const targeted = new Set(goals.map((g) => g.target_project_id));
  for (const g of goals) {
    if ((await executionPolicyForProject(g.target_project_id)) !== 'SQUEEZE') return { ok: false, detail: `goal ${g.id} has a target and a deadline but its project is not pursued as SQUEEZE` };
  }
  const others = await db.all<{ id: string }>(`SELECT id FROM projects ORDER BY id LIMIT 50`);
  let unbound = 0;
  for (const p of others.filter((one) => !targeted.has(one.id))) {
    if ((await executionPolicyForProject(p.id)) !== 'EVIDENCE_FIRST') return { ok: false, detail: `project ${p.id} has no live targeted goal yet resolves a SQUEEZE policy: the goal's ceilings became a default` };
    unbound += 1;
  }

  const all = await db.all<{ id: string; workstream_id: string; verdict: string; forecast: string | null; created_at: string }>(
    `SELECT id, workstream_id, verdict, forecast, created_at FROM goal_plan_readings WHERE created_at >= ? ORDER BY created_at, id`,
    [ACCEPTANCE_RULE_FROM],
  );
  // The rule is judged from the first reading the released writer stamped with an acceptance:
  // a reading written on the rule's day by the Brain released before it carries none, and is
  // history, not a counterfeit (production 2026-11-10, gpr_8c679e2aefba4625a30f).
  const firstStamped = all.findIndex((r) => parse(r.forecast)?.acceptance !== undefined);
  const readings = firstStamped < 0 ? [] : all.slice(firstStamped);
  let accepted = 0;
  let candidates = 0;
  for (const r of readings) {
    const acceptance = (parse(r.forecast)?.acceptance ?? null) as Acceptance | null;
    const problem = readingProblem(r.verdict, acceptance, RECOMMENDATION_POLICY.requiredProbability);
    if (problem) return { ok: false, detail: `plan reading ${r.id} (goal ${r.workstream_id}) ${problem}` };
    if (acceptance!.status === 'ACCEPTED') accepted += 1;
    else candidates += 1;
  }
  if (readings.length === 0) return { ok: false, detail: `no plan reading since ${ACCEPTANCE_RULE_FROM} carries an acceptance: the candidate/accepted separation is not yet demonstrated` };
  return {
    ok: true,
    detail: `${goals.length} live goal(s) pursued as SQUEEZE, ${unbound} other project(s) evidence-first; ${readings.length} reading(s) keep the rule: ${accepted} accepted on a defensible probability, ${candidates} candidate-only with no probability claimed`,
  };
}

// Registered by the protected probes module (§97); a campaign never registers its own judge.
