import { getDb } from '../../db/database.ts';

/**
 * Which research is an approved goal's own (owner, 2026-11-03: the openings the
 * $10K goal's constructed rounds filed are researched first).
 *
 * An idea is the goal's when it is one of the goal's own search rounds
 * (`goal-…` buckets: lenses and constructed arrangements), or when it asks
 * about an opening one of those rounds found — the opening's deep dive, or a
 * narrow question raised about it that is still being asked. Read from rows,
 * so every selector that orders work (judging, launching, the shared work
 * queue) applies the same rule and none of them keeps a second list.
 *
 * **A withdrawn question is nobody's goal work** (2026-11-17, `goals plan
 * wst_7b4fcbb5f2384f31b6c3`). The goal's path research withdraws a question
 * when it is asked again a different way or its opening is let go, and the
 * question's idea stays QUEUED. Counted as the goal's, ~95 such moot ideas —
 * older than every round, so first by `created_at` — held the goal tier of the
 * launch order while the grant sat at its ceiling (26 live of 13): each slot
 * that freed went to a question nobody was asking any more, the goal's nine
 * open rounds never launched, and they expired ABANDONED
 * (`RESEARCH_NOT_FINISHING`, "opened 0 · harvested 0 · abandoned 4"). Only an
 * OPEN question is the goal's now; a withdrawn one keeps its row and its idea
 * and simply waits in the ordinary order.
 *
 * **Each branch is one uncorrelated set**, not a per-idea join. The earlier
 * form joined every goal-found opening to `cash_needs` (no index on
 * `candidate_id`) for every candidate, and the tick's judge pass died on it
 * ("judge-unjudged: canceling statement due to statement timeout", production
 * 03:30Z), so no idea — the goal's included — was judged on that tick. As
 * `IN (SELECT …)` each set is computed once per statement on both dialects.
 */

/**
 * The request-key prefix of a goal's own price questions (`sendPortfolioNeeds`):
 * what buyers of a population its refused designs share pay. Such a need has
 * no opening row — its design was refused for want of the very price it asks
 * — so the opening branches below never reached it, and its idea waited
 * unjudged behind the ordinary backlog (production 2026-11-19: 14,737 unjudged
 * ideas, the oldest from 2026-11-15). It is the goal's research, so it is the
 * goal's idea while the need is OPEN.
 */
export const GOAL_PRICE_KEY_PREFIX = 'goal-price';

/** A boolean SQL expression over a `russell_candidates` row aliased `c`; true for the goal's own ideas. No parameters. */
export function goalIdeaSql(c: string): string {
  return `(${c}.id IN (SELECT gr.candidate_id FROM cash_discovery_rounds gr
                      WHERE gr.bucket_id LIKE 'goal-%' AND gr.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gop.candidate_id FROM cash_opportunities gop
                     JOIN cash_discovery_rounds gr2 ON gr2.id = gop.discovery_round_id
                    WHERE gr2.bucket_id LIKE 'goal-%' AND gop.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gn.candidate_id FROM cash_needs gn
                     JOIN cash_opportunities gop3 ON gop3.id = gn.opportunity_id
                     JOIN cash_discovery_rounds gr3 ON gr3.id = gop3.discovery_round_id
                    WHERE gr3.bucket_id LIKE 'goal-%' AND gn.state = 'OPEN' AND gn.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gp.candidate_id FROM cash_needs gp
                    WHERE gp.request_key LIKE '${GOAL_PRICE_KEY_PREFIX}-%' AND gp.state = 'OPEN' AND gp.candidate_id IS NOT NULL))`;
}

/** A boolean SQL expression: this idea is one of a goal's own search rounds (`goal-…` bucket). No parameters. */
export function goalRoundSql(c: string): string {
  return `${c}.id IN (SELECT gr.candidate_id FROM cash_discovery_rounds gr
                      WHERE gr.bucket_id LIKE 'goal-%' AND gr.candidate_id IS NOT NULL)`;
}

/**
 * An `ORDER BY` key: the goal's own rounds first, then the rest of its ideas,
 * then everything else.
 *
 * Production, 2026-11-17 05:35–06:18Z: with ended missions no longer holding
 * slots, the grant turned over (missions 3588 → 3590) at 13 of 13, and every
 * freed slot still went past the $10K goal's nine AWAITING_LAUNCH rounds. The
 * goal tier was one rank, ordered inside by priority, ordinal and age, so the
 * deep dives and questions about openings the goal had already found — older
 * and often ranked higher — took each slot, and the rounds that find new
 * openings (the search the goal is waiting on) never launched and expired.
 * A round is the goal's search itself, so it goes first inside the tier.
 */
export function goalFirstSql(c: string): string {
  return `CASE WHEN ${goalRoundSql(c)} THEN 0 WHEN ${goalIdeaSql(c)} THEN 1 ELSE 2 END`;
}

/**
 * How many of a project's goal search rounds are waiting for a research slot:
 * an idea still live with no mission yet. What a lower-priority producer reads
 * to stand aside while the goal's own search is queued (W3c).
 */
export async function goalRoundsAwaitingLaunch(projectId: string): Promise<number> {
  const rows = await getDb().all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM russell_candidates c
      WHERE c.project_id = ?
        AND ${goalRoundSql('c')}
        AND c.state NOT IN ('REJECTED', 'PARKED', 'MERGED', 'DONE')
        AND NOT EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id)`,
    [projectId],
  );
  return Number(rows[0]?.n ?? 0);
}
