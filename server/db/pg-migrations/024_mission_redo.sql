-- The Postgres half of migration 033. See that file for why.
ALTER TABLE russell_missions
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

ALTER TABLE russell_missions
  ADD COLUMN supersedes_mission_id TEXT NULL REFERENCES russell_missions(id);

CREATE INDEX IF NOT EXISTS idx_russell_missions_candidate_attempt
  ON russell_missions (candidate_id, attempt);
