-- ---------------------------------------------------------------------------
-- A CASE-INSENSITIVE NAME LOOKUP THAT AN INDEX CAN ANSWER (§89)
--
-- `findDocumentByCanonicalName` and the dependency lookup compare a canonical
-- name `COLLATE NOCASE`. The existing indexes are on the plain column, which a
-- comparison under another collation cannot use, so on Postgres every call read
-- the whole table. Production, 2026-11-05 20:01-20:12Z: 3 124 such lookups took
-- about 10 000 s of database time, the largest share by two orders of
-- magnitude, the pool timed out 924 checkouts, Brain shed load, and Deploy's
-- hosted verification could not get a pooler client (EMAXCONNSESSION).
--
-- An index built under the same collation answers the same comparison. On
-- Postgres the `nocase` collation is the baseline's ICU one (an unquoted
-- name folds to it); on SQLite it is the built-in NOCASE. Same statement on both.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_project_canonical_nocase
  ON documents (project_id, canonical_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_dependencies_required_nocase
  ON dependencies (project_id, required_canonical_name COLLATE NOCASE);
