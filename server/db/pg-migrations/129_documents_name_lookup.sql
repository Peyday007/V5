-- ---------------------------------------------------------------------------
-- A DOCUMENT IS FOUND BY ITS NAME WITH AN INDEX, ON BOTH BACKENDS
--
-- Production, 2026-11-05 (connection report): the canonical-name lookup ran
-- 50 000 times an hour at 13 s each and held the pool empty, because Postgres
-- cannot use an index for the nondeterministic `nocase` collation and scanned
-- every document in the project. The lookup now compares lower() on both
-- sides, which this index serves on Postgres and SQLite alike.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_project_lower_name
  ON documents (project_id, lower(canonical_name));
