-- ---------------------------------------------------------------------------
-- ARCHIVE IMPORT
--
-- Importing forty-odd research documents out of a synced Drive folder is not a
-- bigger version of dropping three PDFs on a page. It takes minutes, it will be
-- interrupted, and the interruption must not cost the work already done — so the
-- job and the state of every single file inside it are rows, written as the work
-- happens rather than at the end.
--
-- The rule this table exists to enforce: a file that finished stays finished. A
-- restart, a cancellation, an OCR failure or a machine going to sleep leaves a
-- record saying exactly which files were read, which failed and why, and which
-- were never reached — and resuming continues from there instead of starting
-- again.
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- The folder the user chose, as they see it on their own machine. Kept for the
  -- report and for retrying: it is never used as a path to read from without
  -- confinement.
  source_label      TEXT NOT NULL,
  -- Where Brain actually read from, data-root-relative when inside the tree.
  root_path         TEXT NOT NULL,

  -- DISCOVERING | QUEUED | RUNNING | PAUSED | CANCELLED | COMPLETE | FAILED
  status            TEXT NOT NULL DEFAULT 'DISCOVERING',
  scope             TEXT NOT NULL DEFAULT 'LAYER',

  discovered        INTEGER NOT NULL DEFAULT 0,
  processed         INTEGER NOT NULL DEFAULT 0,
  -- A counted report rather than a mood: every file lands in exactly one of these.
  registered        INTEGER NOT NULL DEFAULT 0,
  duplicates        INTEGER NOT NULL DEFAULT 0,
  unsupported       INTEGER NOT NULL DEFAULT 0,
  unreadable        INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  needs_review      INTEGER NOT NULL DEFAULT 0,

  message           TEXT,
  cancel_reason     TEXT,
  heartbeat_at      TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_import_jobs_project ON import_jobs (project_id, status);

-- ---------------------------------------------------------------------------
-- One row per discovered file, from discovery to disposition.
--
-- Provenance is kept in full — where it came from, what it was called, its hash,
-- its size, its timestamps, how it was read and what went wrong — because months
-- from now "which file was this claim in, and when did we read it" has to be
-- answerable without the folder still existing.
-- ---------------------------------------------------------------------------
CREATE TABLE import_files (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Identity as the user knows it.
  absolute_path     TEXT NOT NULL,
  relative_path     TEXT NOT NULL,
  filename          TEXT NOT NULL,
  file_size         INTEGER,
  file_hash         TEXT,
  detected_format   TEXT,
  source_modified_at TEXT,

  -- DISCOVERED | QUEUED | EXTRACTING | OCR | REGISTERED | DUPLICATE
  -- | UNSUPPORTED | UNREADABLE | FAILED | NEEDS_REVIEW | SKIPPED
  status            TEXT NOT NULL DEFAULT 'DISCOVERED',
  -- What became of it, if anything did.
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  duplicate_of_id   TEXT REFERENCES documents(id) ON DELETE SET NULL,
  extraction_status TEXT,
  extraction_method TEXT,
  pages             INTEGER,
  ocr_pages         INTEGER,
  -- Plain-language reason a person can act on, never a stack trace.
  detail            TEXT,
  warnings          TEXT NOT NULL DEFAULT '[]',
  -- The classifier's proposal, and whether a person still has to confirm it.
  classification    TEXT,
  needs_confirmation INTEGER NOT NULL DEFAULT 0,

  attempts          INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_import_files_job ON import_files (job_id, status);
CREATE INDEX idx_import_files_hash ON import_files (project_id, file_hash);
CREATE UNIQUE INDEX idx_import_files_path ON import_files (job_id, relative_path);

-- Where a document came from, when it came from a folder import. Kept on the
-- document itself so provenance survives the import job being cleaned up.
ALTER TABLE documents ADD COLUMN import_job_id TEXT;
ALTER TABLE documents ADD COLUMN source_path TEXT;
ALTER TABLE documents ADD COLUMN source_modified_at TEXT;
