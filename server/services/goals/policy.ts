/**
 * Which execution policy governs a project's cash work (`domain/goalPolicy.ts`).
 *
 * A project serves a SQUEEZE goal when a live goal targets it with an amount
 * and a due date still ahead. Read from the goal rows, so it holds for every
 * such goal, now and later, with nothing to switch on. Cached for a minute:
 * every opening of a pass asks the same question.
 */
import { getDb } from '../../db/database.ts';
import type { GoalExecutionPolicy } from '../../domain/goalPolicy.ts';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; policy: GoalExecutionPolicy }>();

export async function executionPolicyForProject(projectId: string, now: Date = new Date()): Promise<GoalExecutionPolicy> {
  const held = cache.get(projectId);
  if (held && now.getTime() - held.at >= 0 && now.getTime() - held.at < TTL_MS) return held.policy;
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM workstreams
      WHERE target_project_id = ? AND target_metric IS NOT NULL AND target_amount_cents IS NOT NULL
        AND due_at IS NOT NULL AND due_at > ?
        AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL`,
    [projectId, now.toISOString()],
  );
  const policy: GoalExecutionPolicy = Number(row?.n ?? 0) > 0 ? 'SQUEEZE' : 'EVIDENCE_FIRST';
  cache.set(projectId, { at: now.getTime(), policy });
  return policy;
}

/** Tests. */
export function forgetExecutionPolicies(): void {
  cache.clear();
}
