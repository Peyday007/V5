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
  topic_key: string | null;
  topic_question: string | null;
}

/** Every rule considered, newest first; a selection is made per assignment. */
export const METHOD_RULE_POOL = 300;
/** No one method question may fill the whole block. */
export const MAX_RULES_PER_TOPIC = 3;

/** The accepted method claims, newest first, with the question each answers. */
export async function readMethodRulePool(): Promise<MethodRuleRow[]> {
  return getDb().all<MethodRuleRow>(
    `SELECT c.claim, c.source_url, f.fragment_key AS topic_key, f.question AS topic_question
       FROM research_claims c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
       JOIN russell_goals g ON g.id = o.goal_id
       JOIN projects p ON p.id = g.project_id
       LEFT JOIN research_fragments f ON f.id = c.fragment_id
      WHERE p.slug = ? AND g.purpose = 'RESEARCH_GOAL'
        AND c.accepted = 1 AND c.sourced = 1
        AND c.contradiction_state IN ('UNCHALLENGED', 'SUPPORTED')
      ORDER BY c.created_at DESC
      LIMIT ?`,
    [ARCHITECTURE_SLUG, METHOD_RULE_POOL],
  );
}

const STOP = new Set(
  ('a an and are as at be by for from has have how in is it its of on or that the this to was were what ' +
    'when where which who why will with not no do does can could should would than then them they their ' +
    'there these those you your our we us any all each one into about over under more most less fast').split(' '),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP.has(word))
      .map((word) => (word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)),
  );
}

/**
 * Choose the rules that bear on this assignment. Pure.
 *
 * A rule bears on a question by the words its own text and the question it
 * answered share with the assignment's question. Most relevant first, newest
 * first among equals, at most `MAX_RULES_PER_TOPIC` from any one method
 * question so one topic cannot crowd out the rest. With nothing to match on,
 * the newest rules spread across topics. It reads no gate input and changes
 * none: which rules a worker reads is all it decides.
 */
export function selectMethodRules(pool: MethodRuleRow[], question: string | null): MethodRule[] {
  const wanted = question ? words(question) : new Set<string>();
  const scored = pool.map((row, index) => {
    const have = words(`${row.claim} ${row.topic_question ?? ''}`);
    let overlap = 0;
    for (const word of wanted) if (have.has(word)) overlap += 1;
    return { row, index, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
  const perTopic = new Map<string, number>();
  const chosen: MethodRule[] = [];
  const seen = new Set<string>();
  for (const { row } of scored) {
    if (chosen.length >= MAX_GUIDANCE_METHOD_RULES) break;
    // A claim with no fragment came from a packet-level pass; it answers no one question.
    const topic = row.topic_key;
    if (topic && (perTopic.get(topic) ?? 0) >= MAX_RULES_PER_TOPIC) continue;
    const key = row.claim.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (topic) perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
    chosen.push({ rule: row.claim, source: row.source_url });
  }
  return chosen;
}

/** The newest rules, unselected, for a reader with no question. */
export async function readMethodRules(): Promise<MethodRule[]> {
  return selectMethodRules(await readMethodRulePool(), null);
}

/** The pool is read at most every ten minutes per process, like the lessons beside it. */
const CACHE_MS = 10 * 60_000;
let cache: { at: number; value: MethodRuleRow[] } | null = null;

export function resetMethodRuleCache(): void {
  cache = null;
}

export async function methodRulesFor(now: number, question: string | null = null): Promise<MethodRule[]> {
  if (!cache || now - cache.at < 0 || now - cache.at >= CACHE_MS) {
    cache = { at: now, value: await readMethodRulePool() };
  }
  return selectMethodRules(cache.value, question);
}
