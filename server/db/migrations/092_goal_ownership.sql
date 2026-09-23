-- A workstream becomes a goal Brain can own over time.
--
-- The register (082) holds an intent and a purpose and derives everything else.
-- That answers "where has this got to" and leaves four questions a person who
-- has walked away cannot get answered without reconstructing them by hand:
-- what outcome counts as finished, whose it is and by when, whether anybody
-- has told Brain to stop, and what Brain did with the capacity it had.
--
-- Everything added here is either a **decision a person made** or a **record
-- of something Brain did**. Nothing here is a stored verdict about where the
-- work has got to — that is still derived on every read from the rows the
-- workstream points at, and a test still asserts there is no `state` column.
--
--   * `outcome`, `owner_user_id`, `due_at`, `commitment` are what a person
--     said the goal is for. Brain cannot recover any of them from the graph.
--   * `paused_*` and `cancelled_*` are a person's decisions, like
--     `archived_*` beside them. Paused is not a state the work got into; it is
--     somebody saying "not now".
--   * `bins.held_by_workstream_id` is what makes a pause mean something. A
--     held bin is neither fired nor handed out, and it keeps every lease,
--     attempt, generation and event it had — so resuming continues the work
--     rather than restarting it.
--   * `goal_priority_snapshots` is append-only and written only when a goal's
--     position actually moves, so "why did this move" is answered from a row
--     rather than from a re-run against a database that has since changed.
--
-- No CHECK on the added columns: SQLite's ADD COLUMN is the one place a
-- constraint is awkward to add, and the closed sets are enforced by the one
-- module that writes them (`domain/goals.ts`) and asserted by its tests.

ALTER TABLE workstreams ADD COLUMN outcome TEXT;
ALTER TABLE workstreams ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workstreams ADD COLUMN due_at TEXT;
ALTER TABLE workstreams ADD COLUMN commitment TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE workstreams ADD COLUMN paused_at TEXT;
ALTER TABLE workstreams ADD COLUMN paused_reason TEXT;
ALTER TABLE workstreams ADD COLUMN cancelled_at TEXT;
ALTER TABLE workstreams ADD COLUMN cancelled_reason TEXT;

ALTER TABLE bins ADD COLUMN held_by_workstream_id TEXT;
ALTER TABLE bins ADD COLUMN held_reason TEXT;
CREATE INDEX idx_bins_held ON bins (held_by_workstream_id);

CREATE TABLE goal_priority_snapshots (
  id             TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  owner_key      TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  previous_rank  INTEGER,
  criterion      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_goal_priority_snapshots ON goal_priority_snapshots (workstream_id, created_at);
