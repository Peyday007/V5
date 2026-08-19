-- 003_document_understanding.sql
-- Trustworthy document reading for the audit engine.
--
-- The chain is: document source -> extraction run -> pages/blocks -> chunks ->
-- structured findings -> audit evidence. Every link keeps the anchor back to the
-- original, because a finding that cannot point at its source is not evidence.

-- ---------------------------------------------------------------------------
-- DOCUMENT: identity and current extraction state
-- ---------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN mime_type TEXT;
ALTER TABLE documents ADD COLUMN detected_format TEXT;
ALTER TABLE documents ADD COLUMN page_count INTEGER;
-- QUEUED | EXTRACTING | OCR | INDEXING | READY | READY_WITH_WARNINGS | BLOCKED | FAILED | INTERRUPTED
ALTER TABLE documents ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'QUEUED';
ALTER TABLE documents ADD COLUMN extraction_run_id TEXT;
ALTER TABLE documents ADD COLUMN pipeline_version TEXT;
-- How it arrived: UPLOAD | FILESYSTEM | PASTED | RUN_RESULT
ALTER TABLE documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'UPLOAD';

-- ---------------------------------------------------------------------------
-- EXTRACTION RUN
-- One attempt at reading a document. Runs are never edited in place: a reprocess
-- creates a new run and the old one stays, so a historical audit keeps the exact
-- evidence it actually saw.
-- ---------------------------------------------------------------------------
CREATE TABLE extraction_runs (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'QUEUED',
  pipeline_version   TEXT NOT NULL,
  detected_format    TEXT,
  -- The source bytes this run read. A changed hash means a different document.
  source_hash        TEXT,
  pages_expected     INTEGER NOT NULL DEFAULT 0,
  pages_readable     INTEGER NOT NULL DEFAULT 0,
  pages_ocr          INTEGER NOT NULL DEFAULT 0,
  pages_failed       TEXT NOT NULL DEFAULT '[]',
  character_count    INTEGER NOT NULL DEFAULT 0,
  coverage_ratio     REAL NOT NULL DEFAULT 0,
  warnings           TEXT NOT NULL DEFAULT '[]',
  blocked_reason     TEXT,
  error              TEXT,
  -- Set when a later run replaces this one; provenance is never rewritten.
  superseded_by_run_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  started_at         TEXT,
  completed_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_extraction_runs_document ON extraction_runs (document_id, created_at DESC);
CREATE INDEX idx_extraction_runs_status ON extraction_runs (status);

-- ---------------------------------------------------------------------------
-- DOCUMENT BLOCK
-- A logical unit on a page, in reading order. Raw text is kept beside the
-- normalized text so normalization can never destroy evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE document_blocks (
  id                TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number       INTEGER NOT NULL,
  block_index       INTEGER NOT NULL,
  -- HEADING | PARAGRAPH | LIST_ITEM | TABLE | CAPTION | FOOTNOTE | CODE | PAGE_HEADER | PAGE_FOOTER
  block_type        TEXT NOT NULL DEFAULT 'PARAGRAPH',
  raw_text          TEXT NOT NULL,
  normalized_text   TEXT NOT NULL,
  -- Offsets into the run's concatenated normalized text, so a chunk can point back.
  char_start        INTEGER NOT NULL DEFAULT 0,
  char_end          INTEGER NOT NULL DEFAULT 0,
  -- NATIVE | OCR | DOCX | TEXT | PASTED
  extraction_method TEXT NOT NULL,
  confidence        REAL,
  warnings          TEXT NOT NULL DEFAULT '[]',
  content_hash      TEXT NOT NULL,
  -- [x0, y0, x1, y1] in PDF user space, when the format has geometry.
  bbox              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_blocks_run ON document_blocks (extraction_run_id, page_number, block_index);
CREATE INDEX idx_blocks_document ON document_blocks (document_id, page_number);

-- ---------------------------------------------------------------------------
-- DOCUMENT CHUNK
-- Retrieval and model-budget unit. Follows structure where it can, overlaps a
-- little, and always keeps the page/block range it came from.
-- ---------------------------------------------------------------------------
CREATE TABLE document_chunks (
  id                TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL,
  page_start        INTEGER NOT NULL,
  page_end          INTEGER NOT NULL,
  block_start       INTEGER NOT NULL,
  block_end         INTEGER NOT NULL,
  heading_path      TEXT NOT NULL DEFAULT '[]',
  text              TEXT NOT NULL,
  char_count        INTEGER NOT NULL DEFAULT 0,
  char_start        INTEGER NOT NULL DEFAULT 0,
  char_end          INTEGER NOT NULL DEFAULT 0,
  overlap_prev      INTEGER NOT NULL DEFAULT 0,
  has_ocr           INTEGER NOT NULL DEFAULT 0,
  content_hash      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_chunks_run ON document_chunks (extraction_run_id, chunk_index);
CREATE INDEX idx_chunks_document ON document_chunks (document_id, chunk_index);

-- ---------------------------------------------------------------------------
-- DOCUMENT FINDING
-- An index into the source, never a replacement for it: every finding carries
-- the chunk and page it came from plus the supporting quote.
-- ---------------------------------------------------------------------------
CREATE TABLE document_findings (
  id                TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id          TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  -- CLAIM | DEFINITION | COMPONENT | ACTOR | RELATIONSHIP | ASSUMPTION | EXCLUSION
  -- | REQUIREMENT_ANSWERED | OPEN_QUESTION | CONTRADICTION
  finding_type      TEXT NOT NULL,
  ordinal           INTEGER NOT NULL DEFAULT 0,
  content           TEXT NOT NULL,
  evidence_page     INTEGER,
  evidence_quote    TEXT NOT NULL DEFAULT '',
  confidence        REAL,
  source            TEXT NOT NULL DEFAULT 'PROVIDER',
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_doc_findings_run ON document_findings (extraction_run_id, finding_type, ordinal);
CREATE INDEX idx_doc_findings_chunk ON document_findings (chunk_id);

-- ---------------------------------------------------------------------------
-- AUDIT EVIDENCE
-- The citation trail from a verdict back to the exact passage. Historical audits
-- keep the extraction run they used, so reprocessing never rewrites the past.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_evidence (
  id                TEXT PRIMARY KEY,
  audit_id          TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  gap_id            TEXT REFERENCES audit_gaps(id) ON DELETE CASCADE,
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  extraction_run_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  chunk_id          TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  document_label    TEXT NOT NULL DEFAULT '',
  page_number       INTEGER,
  quote             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_audit_evidence_audit ON audit_evidence (audit_id);
CREATE INDEX idx_audit_evidence_gap ON audit_evidence (gap_id);

-- The manifest proving exactly which documents, versions, pages and extraction
-- runs a packet audit actually read.
ALTER TABLE audits ADD COLUMN evidence_manifest TEXT NOT NULL DEFAULT '{}';
