-- The Postgres half of SQLite migration 092. See that file for why every
-- column here is a person's decision or a record of what Brain did, and never
-- a stored verdict about where the work has got to.
--
-- Postgres can carry the closed-set CHECKs SQLite's ADD COLUMN makes awkward,
-- so it does: a backstop that only runs on one backend is still a backstop on
-- the backend production runs.

ALTER TABLE workstreams ADD COLUMN outcome TEXT;
ALTER TABLE workstreams ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workstreams ADD COLUMN due_at TEXT;
ALTER TABLE workstreams ADD COLUMN commitment TEXT NOT NULL DEFAULT 'NONE'
  CHECK (commitment IN ('NONE', 'INTERNAL', 'CUSTOMER'));
ALTER TABLE workstreams ADD COLUMN paused_at TEXT;
ALTER TABLE workstreams ADD COLUMN paused_reason TEXT;
ALTER TABLE workstreams ADD COLUMN cancelled_at TEXT;
ALTER TABLE workstreams ADD COLUMN cancelled_reason TEXT;

ALTER TABLE bins ADD COLUMN held_by_workstream_id TEXT;
ALTER TABLE bins ADD COLUMN held_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_bins_held ON bins (held_by_workstream_id);

CREATE TABLE IF NOT EXISTS goal_priority_snapshots (
  seq            BIGSERIAL,
  id             TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  owner_key      TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  previous_rank  INTEGER,
  criterion      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_priority_snapshots ON goal_priority_snapshots (workstream_id, created_at);
