-- The continuation pass's two durable marks. research_considered_at is when the
-- pass last looked at a goal, so candidates rotate least-recently-considered
-- first and a restart resumes from rows. research_archive_marker is what the
-- archive looked like when it was found to answer the goal, so the archive is
-- read again only when that changes. Additive and nullable; the index serves
-- the pass's one ordered query.
ALTER TABLE russell_goals ADD COLUMN research_considered_at TEXT;

ALTER TABLE russell_goals ADD COLUMN research_archive_marker TEXT;

CREATE INDEX IF NOT EXISTS idx_russell_goals_research_rotation
  ON russell_goals (purpose, state, research_considered_at);
