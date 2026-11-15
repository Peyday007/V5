-- ---------------------------------------------------------------------------
-- A STORED ARRANGEMENT CARRIES ITS §92 POSITION (K-6, W-8)
--
-- §92 positions were computed on every read and never stored, so "commercial
-- positions" could not be counted and a construction's decision could not be
-- compared with its predecessor's. The constructed-arrangement library row
-- (migration 152) now carries the Position its design occupies — the adapter
-- `industry/construction/designs.ts` reads it off the §82 design, money
-- timing and recurrence included — as JSON, and its key for counting and
-- comparison. Both NULL on every non-constructed row, and on a constructed
-- row written before this migration until its next construction pass.
-- ---------------------------------------------------------------------------

ALTER TABLE monetization_paths ADD COLUMN position_json TEXT;
ALTER TABLE monetization_paths ADD COLUMN position_key TEXT;

CREATE INDEX IF NOT EXISTS idx_monetization_paths_position
  ON monetization_paths(project_id, position_key);
