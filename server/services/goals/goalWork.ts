/**
 * Which research is an approved goal's own (owner, 2026-11-03: the openings the
 * $10K goal's constructed rounds filed are researched first).
 *
 * An idea is the goal's when it is one of the goal's own search rounds
 * (`goal-…` buckets: lenses and constructed arrangements), or when it asks
 * about an opening one of those rounds found — the opening's deep dive, or a
 * narrow question raised about it. Read from rows, so every selector that
 * orders work (judging, launching, the shared work queue) applies the same rule
 * and none of them keeps a second list.
 */

/** A boolean SQL expression over a `russell_candidates` row aliased `c`; true for the goal's own ideas. No parameters. */
export function goalIdeaSql(c: string): string {
  return `(EXISTS (SELECT 1 FROM cash_discovery_rounds gr WHERE gr.candidate_id = ${c}.id AND gr.bucket_id LIKE 'goal-%')
    OR EXISTS (
      SELECT 1 FROM cash_opportunities gop JOIN cash_discovery_rounds gr2 ON gr2.id = gop.discovery_round_id
       WHERE gr2.bucket_id LIKE 'goal-%'
         AND (gop.candidate_id = ${c}.id
              OR EXISTS (SELECT 1 FROM cash_needs gn WHERE gn.candidate_id = ${c}.id AND gn.opportunity_id = gop.id))))`;
}

/** An `ORDER BY` key: the goal's own ideas first. */
export function goalFirstSql(c: string): string {
  return `CASE WHEN ${goalIdeaSql(c)} THEN 0 ELSE 1 END`;
}
