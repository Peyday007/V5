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
                    WHERE gr3.bucket_id LIKE 'goal-%' AND gn.state = 'OPEN' AND gn.candidate_id IS NOT NULL))`;
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
