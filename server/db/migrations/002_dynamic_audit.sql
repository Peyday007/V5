-- 002_dynamic_audit.sql
-- The dynamic audit engine extends the existing audit record rather than
-- standing beside it: `audits` stays the single row an audit is identified by,
-- and everything below hangs off it.

-- Which question the audit answered, and how much research it says remains.
ALTER TABLE audits ADD COLUMN mode TEXT NOT NULL DEFAULT 'SINGLE_DOCUMENT';
ALTER TABLE audits ADD COLUMN profile_id TEXT;
ALTER TABLE audits ADD COLUMN foundational_gap_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audits ADD COLUMN targeted_research_runs_required INTEGER NOT NULL DEFAULT 0;
-- Which documents the audit actually read, so a packet verdict is reproducible.
ALTER TABLE audits ADD COLUMN audited_document_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE audits ADD COLUMN provider TEXT;
ALTER TABLE audits ADD COLUMN model TEXT;

-- ---------------------------------------------------------------------------
-- GAP CLASSIFICATION
-- Every issue an audit raises is classified, because "more could be researched"
-- and "more research is required" are different answers and only one of them
-- may hold a layer open.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_gaps (
  id                TEXT PRIMARY KEY,
  audit_id          TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL DEFAULT 0,
  classification    TEXT NOT NULL,
  title             TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '',
  -- Set when the gap belongs to a different layer; the audit records a handoff
  -- instead of holding this layer open for it.
  owning_layer_id   TEXT REFERENCES layers(id) ON DELETE SET NULL,
  owning_layer_name TEXT,
  -- Why this classification and not another. A gap without a justification is
  -- an opinion, not a finding.
  justification     TEXT NOT NULL DEFAULT '',
  -- The bounded question a TARGETED_RESEARCH_GAP would answer.
  research_question TEXT,
  expected_contribution TEXT,
  source_pass       TEXT NOT NULL DEFAULT 'JUDGE',
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_audit_gaps_audit ON audit_gaps (audit_id, ordinal);
CREATE INDEX idx_audit_gaps_classification ON audit_gaps (classification);

-- ---------------------------------------------------------------------------
-- AUDIT PASSES
-- One row per model call. The exact prompt and the raw response are kept for
-- every pass, including failed ones, so a verdict can always be traced back to
-- what the model actually said.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_passes (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT REFERENCES audits(id) ON DELETE CASCADE,
  -- Passes are written before the audit row exists, so they are also keyed by
  -- the pipeline run that produced them.
  pipeline_id   TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id      TEXT REFERENCES layers(id) ON DELETE SET NULL,
  pass_key      TEXT NOT NULL,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  provider      TEXT,
  model         TEXT,
  prompt        TEXT NOT NULL,
  raw_response  TEXT,
  parsed        TEXT NOT NULL DEFAULT 'null',
  ok            INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_audit_passes_audit ON audit_passes (audit_id, ordinal);
CREATE INDEX idx_audit_passes_pipeline ON audit_passes (pipeline_id, ordinal);
