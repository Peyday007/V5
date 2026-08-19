-- ---------------------------------------------------------------------------
-- PROJECT-LEVEL SOURCES
--
-- Until now every document belonged to exactly one layer, because every document
-- was a research report about one layer. A master transcript is not that. It is
-- a project-wide record that spans layers, assignments, decisions, revisions and
-- artifacts, and forcing it into a single layer would file most of its content
-- under the wrong heading.
--
-- So a document gains a scope, and the parts of it gain their own identity. One
-- transcript, many segments, many links — and the original file is still one
-- file on disk, registered once. Nothing is duplicated to achieve the fan-out.
-- ---------------------------------------------------------------------------

-- LAYER (the default, and everything that already exists) or a project-wide
-- source such as PROJECT_MASTER_TRANSCRIPT.
ALTER TABLE documents ADD COLUMN scope TEXT NOT NULL DEFAULT 'LAYER';

-- How the layer was decided: FILENAME is a hint, CONTENT is understanding, and
-- the difference has to be visible rather than implied.
ALTER TABLE documents ADD COLUMN classification_source TEXT;
ALTER TABLE documents ADD COLUMN classification_confidence REAL;

-- ---------------------------------------------------------------------------
-- SEGMENTS
--
-- The meaningful units inside a project source: a conversation turn, a research
-- assignment, a returned report, an audit, a decision, an open question. Their
-- boundaries come from the text's own structure — speaker, timestamp, heading,
-- topic — which is why they are stored separately from the fixed-size chunks the
-- retrieval index uses. A chunk is for finding text; a segment is for
-- understanding it.
-- ---------------------------------------------------------------------------
CREATE TABLE document_segments (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  segment_index     INTEGER NOT NULL,
  -- CONVERSATION | RESEARCH_ASSIGNMENT | RETURNED_RESEARCH | AUDIT | DECISION
  -- | REVISION | SUPERSEDED | OPEN_GAP | ATTACHMENT_REF | OTHER
  segment_type      TEXT NOT NULL DEFAULT 'CONVERSATION',
  title             TEXT NOT NULL DEFAULT '',
  speaker           TEXT,
  timestamp_text    TEXT,
  -- Anchors back into the run's blocks, so a segment resolves to real source text.
  block_start       INTEGER NOT NULL DEFAULT 0,
  block_end         INTEGER NOT NULL DEFAULT 0,
  char_start        INTEGER NOT NULL DEFAULT 0,
  char_end          INTEGER NOT NULL DEFAULT 0,
  text              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  -- Why this type was chosen, and how sure. Never presented as certain.
  confidence        REAL NOT NULL DEFAULT 0,
  rationale         TEXT NOT NULL DEFAULT '',
  warnings          TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_segments_document ON document_segments (document_id, segment_index);
CREATE INDEX idx_segments_run ON document_segments (extraction_run_id, segment_type);

-- ---------------------------------------------------------------------------
-- PROPOSED LINKS
--
-- A segment's connection to a layer. Proposed by classification, decided by a
-- person: nothing here becomes layer evidence until someone accepts it, because
-- a transcript is a record of thinking, not a set of audited artifacts.
--
-- A null segment_id is a whole-document link, which is how an ordinary imported
-- file expresses the same relationship.
-- ---------------------------------------------------------------------------
CREATE TABLE segment_layer_links (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  segment_id    TEXT REFERENCES document_segments(id) ON DELETE CASCADE,
  layer_id      TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
  version       TEXT,
  -- REFERENCE | RESEARCH_INPUT | COMPLETED_ARTIFACT | EXCLUDED
  link_type     TEXT NOT NULL DEFAULT 'REFERENCE',
  confidence    REAL NOT NULL DEFAULT 0,
  rationale     TEXT NOT NULL DEFAULT '',
  -- PROPOSED | ACCEPTED | EXCLUDED
  status        TEXT NOT NULL DEFAULT 'PROPOSED',
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_links_document ON segment_layer_links (document_id, status);
CREATE INDEX idx_links_layer ON segment_layer_links (layer_id, status);
CREATE INDEX idx_links_segment ON segment_layer_links (segment_id);

-- ---------------------------------------------------------------------------
-- INGESTION REPORTS
--
-- What one ingestion actually read and concluded, kept so the answer to "what
-- did Brain make of this file" survives the page refresh that follows it.
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_reports (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL,
  -- The whole counted report as JSON: characters, tokens, chunks, segment counts
  -- by type, proposed links, warnings.
  report            TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_ingestion_document ON ingestion_reports (document_id, created_at);
