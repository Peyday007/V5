-- ---------------------------------------------------------------------------
-- THE CLOUD MIGRATION LEDGER
--
-- Moving a Brain from a laptop to the cloud is a long operation over a network,
-- and the useful assumption is that it will be interrupted at least once. What
-- makes an interrupted migration safe to resume is not cleverness in the tool
-- but a record of what has already been done, kept in the place the work landed.
--
-- So it lives in the target. If the target is reachable the ledger is
-- reachable, and a resume asks the destination what it already holds rather
-- than trusting a file on the machine that may have been the thing that died.
--
-- It records what happened; it is not what makes the migration idempotent.
-- Every row insert is ON CONFLICT DO NOTHING and every upload is checked
-- against its checksum, so a resume that re-reads work already done cannot
-- duplicate it even if this ledger were empty. The ledger exists so the final
-- report can be truthful about which run did what, and when.
--
-- Nothing in the application reads this table. It has no repository and no row
-- type on purpose: it is the migration tool's own bookkeeping, and the day the
-- last Brain has moved it can be dropped without touching anything else.
-- ---------------------------------------------------------------------------
CREATE TABLE cloud_migration_runs (
  id            text PRIMARY KEY,
  -- MIGRATE, DRY_RUN or VERIFY_ONLY. A dry run is recorded too: knowing that
  -- somebody looked and what they were told is worth keeping.
  mode          text NOT NULL,
  -- The project this run was scoped to, or null for the whole Brain.
  project_id    text,
  -- Where the rows came from, described rather than quoted: a path or a host,
  -- never a connection string, because this table is readable by anything with
  -- access to the database.
  source        text NOT NULL,
  started_at    text NOT NULL,
  finished_at   text,
  -- COMPLETE, FAILED or RUNNING. A run left RUNNING is one that was
  -- interrupted, which is exactly what a resume needs to see.
  status        text NOT NULL,
  rows_copied   integer NOT NULL DEFAULT 0,
  files_copied  integer NOT NULL DEFAULT 0,
  bytes_copied  bigint  NOT NULL DEFAULT 0,
  -- The full report, as JSON text. Text rather than jsonb for the same reason
  -- every other serialized column here is text: one representation, both
  -- backends, no driver deciding to parse it on the way out.
  report        text,
  error         text
);

-- What one run did to one table. The pair is unique, so a resumed run updates
-- its own line rather than adding a second account of the same work.
CREATE TABLE cloud_migration_tables (
  run_id        text NOT NULL,
  table_name    text NOT NULL,
  source_rows   integer NOT NULL DEFAULT 0,
  inserted      integer NOT NULL DEFAULT 0,
  -- Rows already present in the target and therefore skipped. On a first run
  -- this is zero; on a resume it is the measure of what did not have to be
  -- done twice.
  skipped       integer NOT NULL DEFAULT 0,
  completed_at  text,
  PRIMARY KEY (run_id, table_name)
);

-- One line per object moved, keyed by the object key so a resume can ask
-- "is this file already there, and is it the same file" without re-uploading
-- it to find out.
CREATE TABLE cloud_migration_files (
  storage_key   text PRIMARY KEY,
  run_id        text NOT NULL,
  document_id   text,
  size          bigint NOT NULL DEFAULT 0,
  -- The sha-256 Brain computed from the bytes it read locally. Verification
  -- compares this against what the target returns, so a truncated upload is
  -- found rather than assumed away.
  checksum      text NOT NULL,
  verified      integer NOT NULL DEFAULT 0,
  copied_at     text NOT NULL
);

CREATE INDEX idx_cloud_migration_tables_run ON cloud_migration_tables (run_id);
CREATE INDEX idx_cloud_migration_files_run ON cloud_migration_files (run_id);
CREATE INDEX idx_cloud_migration_files_document ON cloud_migration_files (document_id);
