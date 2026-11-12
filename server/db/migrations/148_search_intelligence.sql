-- ---------------------------------------------------------------------------
-- SEARCH INTELLIGENCE: A COMPARISON OF METHODS IS A RECORD, NOT A PRINTOUT
-- ---------------------------------------------------------------------------
--
-- Additive only. When two or more methods for one subject are judged on the
-- same shared data, the comparison is kept (`search_method_comparisons`) with
-- each method's metrics on that data and its rank
-- (`search_method_comparison_entries`), so a later decision can read which
-- method outranked which, on how many items, and why. Nothing here is deleted.
--
-- `scope` follows the other search-intelligence tables: a PROJECT row names its
-- project, a USER row its user, a GENERAL row neither. `item_refs` is the
-- shared data the methods were judged on, as a JSON array.
CREATE TABLE search_method_comparisons (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id    TEXT,
  user_id       TEXT,
  subject_id    TEXT NOT NULL,
  items         INTEGER NOT NULL,
  item_refs     TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE INDEX idx_search_method_comparisons_subject ON search_method_comparisons (subject_id, created_at);

-- One row per compared method: its rank and what it earned on the shared data.
-- `precision_rate` is confirmed / verified, NULL when nothing was verified.
CREATE TABLE search_method_comparison_entries (
  comparison_id TEXT NOT NULL,
  method_id     TEXT NOT NULL,
  rank_order    INTEGER NOT NULL,
  examined      INTEGER NOT NULL,
  surfaced      INTEGER NOT NULL,
  confirmed     INTEGER NOT NULL,
  rejected      INTEGER NOT NULL,
  verified      INTEGER NOT NULL,
  precision_rate REAL,
  PRIMARY KEY (comparison_id, method_id)
);
CREATE INDEX idx_search_method_comparison_entries_method ON search_method_comparison_entries (method_id);
