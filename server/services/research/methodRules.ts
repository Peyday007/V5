/**
 * Method rules: what Brain has researched about how to research, handed to
 * every research worker as context.
 *
 * A research goal opened in the Brain architecture project (`brain-architecture`)
 * asks how to judge an idea rather than whether one idea is good. What its
 * packets establish is gated like any other research — sourced, accepted,
 * uncontested — and then reaches every worker's guidance automatically, so a
 * finished method question changes how the next question is asked without
 * anybody copying it into a prompt.
 *
 * Context, never a control (§65). Nothing here is read by the evidence gate,
 * the depth allocator, the repair ladder, the approval envelope or any
 * allocation. A rule that should change a bar is a code change somebody
 * reviews; this only tells a worker what Brain has learned.
 */
import { getDb } from '../../db/database.ts';
import { ARCHITECTURE_SLUG } from '../capability/ingest.ts';
import { MAX_GUIDANCE_METHOD_RULES } from './prompts.ts';

export interface MethodRule {
  rule: string;
  source: string | null;
}

interface MethodRuleRow {
  claim: string;
  source_url: string | null;
}

/** Newest accepted method claims, at most `MAX_GUIDANCE_METHOD_RULES`. */
export async function readMethodRules(): Promise<MethodRule[]> {
  const rows = await getDb().all<MethodRuleRow>(
    `SELECT c.claim, c.source_url
       FROM research_claims c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
       JOIN russell_goals g ON g.id = o.goal_id
       JOIN projects p ON p.id = g.project_id
      WHERE p.slug = ? AND g.purpose = 'RESEARCH_GOAL'
        AND c.accepted = 1 AND c.sourced = 1
        AND c.contradiction_state IN ('UNCHALLENGED', 'SUPPORTED')
      ORDER BY c.created_at DESC
      LIMIT ?`,
    [ARCHITECTURE_SLUG, MAX_GUIDANCE_METHOD_RULES],
  );
  return rows.map((row) => ({ rule: row.claim, source: row.source_url }));
}

/** Read at most every ten minutes per process, like the lessons beside it. */
const CACHE_MS = 10 * 60_000;
let cache: { at: number; value: MethodRule[] } | null = null;

export function resetMethodRuleCache(): void {
  cache = null;
}

export async function methodRulesFor(now: number): Promise<MethodRule[]> {
  if (cache && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache.value;
  const value = await readMethodRules();
  cache = { at: now, value };
  return value;
}
