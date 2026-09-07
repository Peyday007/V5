-- The link from a follow-on idea back to the mission that produced it.
--
-- Condition 15 of the acceptance scenario asks for exactly one automatic
-- follow-on, and `russell_missions.next_mission_id` has existed since 027 with
-- nothing ever writing it: the mechanism to *produce* a follow-on did not
-- exist, so the column could only ever be null.
--
-- Producing one needs a durable link in the other direction. A mission's
-- follow-on begins as an ordinary idea, so it is judged against the archive
-- like any other (invariant 13 — and the archive has just changed, because the
-- parent mission filed into it). Only when that idea launches does the parent
-- learn its `next_mission_id`, which may be several ticks later or never.
--
-- Kept as a column rather than a key inside `judgment` because the step that
-- creates it has to be re-entrant: it asks "does a follow-on for this mission
-- already exist" on every tick, and answering that by pattern-matching JSON
-- text is a query that works until somebody reformats the JSON.
ALTER TABLE russell_candidates ADD COLUMN follow_on_of_mission_id text
  REFERENCES russell_missions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_russell_candidates_follow_on
  ON russell_candidates(follow_on_of_mission_id);
