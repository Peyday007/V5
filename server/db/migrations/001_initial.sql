-- 001_initial.sql
-- Brain: initial schema.
-- Every table carries created_at/updated_at as ISO-8601 UTC strings.
-- Booleans are stored as INTEGER 0/1. JSON blobs are stored as TEXT.

-- ---------------------------------------------------------------------------
-- PROJECT
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  north_star        TEXT,
  current_wave      INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  version_policy    TEXT NOT NULL DEFAULT '{}',
  settings          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- LAYER
-- ---------------------------------------------------------------------------
CREATE TABLE layers (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  order_index            INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'NOT_STARTED',
  -- DERIVED means the state engine owns `status`; MANUAL means a human pinned it.
  status_source          TEXT NOT NULL DEFAULT 'DERIVED',
  manual_status          TEXT,
  manual_status_reason   TEXT,
  current_version        TEXT,
  current_wave           INTEGER NOT NULL DEFAULT 1,
  canonical_document_id  TEXT,
  -- JSON array of version strings the layer expects for its current wave,
  -- e.g. ["v1","v1B","v1C","v1D","v1E"]
  expected_versions      TEXT NOT NULL DEFAULT '[]',
  parked                 INTEGER NOT NULL DEFAULT 0,
  parked_note            TEXT,
  notes                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_layers_project ON layers (project_id, order_index);

-- ---------------------------------------------------------------------------
-- DOCUMENT
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id                  TEXT REFERENCES layers(id) ON DELETE SET NULL,
  canonical_name            TEXT NOT NULL,
  version                   TEXT NOT NULL,
  -- Deterministic, lexicographically sortable encoding of `version`.
  -- Never sort on `version` itself. See server/domain/version.ts.
  version_sort              TEXT NOT NULL,
  wave                      INTEGER,
  document_type             TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'EXPECTED',
  filename                  TEXT,
  -- Always POSIX-style and relative to the data root. Never absolute.
  filesystem_path           TEXT,
  file_size                 INTEGER,
  file_hash                 TEXT,
  file_missing              INTEGER NOT NULL DEFAULT 0,
  conversation_title        TEXT,
  source_run_id             TEXT,
  parent_document_id        TEXT REFERENCES documents(id) ON DELETE SET NULL,
  superseded_by_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  is_canonical              INTEGER NOT NULL DEFAULT 0,
  frozen                    INTEGER NOT NULL DEFAULT 0,
  notes                     TEXT,
  imported_at               TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (project_id, canonical_name)
);
CREATE INDEX idx_documents_layer ON documents (layer_id, version_sort);
CREATE INDEX idx_documents_project ON documents (project_id, status);
CREATE INDEX idx_documents_path ON documents (filesystem_path);

-- ---------------------------------------------------------------------------
-- RESEARCH RUN
-- ---------------------------------------------------------------------------
CREATE TABLE research_runs (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id               TEXT REFERENCES layers(id) ON DELETE SET NULL,
  target_document_id     TEXT REFERENCES documents(id) ON DELETE SET NULL,
  target_version         TEXT,
  run_type               TEXT NOT NULL,
  attempt_number         INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'PLANNED',
  provider               TEXT,
  model                  TEXT,
  -- The exact compiled prompt. Invariant 10: never generate a prompt without recording it.
  prompt                 TEXT,
  prompt_sections        TEXT NOT NULL DEFAULT '[]',
  required_attachments   TEXT NOT NULL DEFAULT '[]',
  expected_conversation_title TEXT,
  expected_filename      TEXT,
  result_text            TEXT,
  started_at             TEXT,
  completed_at           TEXT,
  failed_at              TEXT,
  failure_reason         TEXT,
  parent_run_id          TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  redo_reason            TEXT,
  dependency_override    INTEGER NOT NULL DEFAULT 0,
  dependency_override_reason TEXT,
  external_response_id   TEXT,
  conversation_id        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_runs_layer ON research_runs (layer_id, created_at);
CREATE INDEX idx_runs_project_status ON research_runs (project_id, status);
CREATE INDEX idx_runs_parent ON research_runs (parent_run_id);

-- ---------------------------------------------------------------------------
-- DEPENDENCY
-- A dependency may point at a document that does not exist yet; that is the
-- whole point of the dependency checker ("Missing: Discovery Logic v1G").
-- Hence required_canonical_name is authoritative and required_document_id is
-- the resolved link when (and only when) it resolves.
-- ---------------------------------------------------------------------------
CREATE TABLE dependencies (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dependent_document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
  dependent_run_id        TEXT REFERENCES research_runs(id) ON DELETE CASCADE,
  required_document_id    TEXT REFERENCES documents(id) ON DELETE SET NULL,
  required_canonical_name TEXT NOT NULL,
  required_layer_id       TEXT REFERENCES layers(id) ON DELETE SET NULL,
  dependency_type         TEXT NOT NULL DEFAULT 'SOURCE_PACKET',
  required                INTEGER NOT NULL DEFAULT 1,
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  CHECK (dependent_document_id IS NOT NULL OR dependent_run_id IS NOT NULL)
);
CREATE INDEX idx_dependencies_run ON dependencies (dependent_run_id);
CREATE INDEX idx_dependencies_document ON dependencies (dependent_document_id);
CREATE INDEX idx_dependencies_required ON dependencies (project_id, required_canonical_name);

-- ---------------------------------------------------------------------------
-- AUDIT  (+ structured child findings; invariant 11: never prose-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audits (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id             TEXT REFERENCES layers(id) ON DELETE SET NULL,
  run_id               TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  audited_document_id  TEXT REFERENCES documents(id) ON DELETE SET NULL,
  verdict              TEXT NOT NULL,
  summary              TEXT NOT NULL DEFAULT '',
  confidence           REAL,
  synthesis_required   INTEGER NOT NULL DEFAULT 0,
  freeze_eligible      INTEGER NOT NULL DEFAULT 0,
  next_version         TEXT,
  next_action          TEXT,
  source               TEXT NOT NULL DEFAULT 'MANUAL',
  raw                  TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_audits_layer ON audits (layer_id, created_at);
CREATE INDEX idx_audits_document ON audits (audited_document_id, created_at);

CREATE TABLE audit_findings (
  id           TEXT PRIMARY KEY,
  audit_id     TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL,
  ordinal      INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_findings_audit ON audit_findings (audit_id, finding_type, ordinal);

-- ---------------------------------------------------------------------------
-- CONVERSATION / MESSAGE  (the local DB is authoritative; a provider thread is
-- never the only copy)
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id                 TEXT REFERENCES layers(id) ON DELETE SET NULL,
  run_id                   TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  provider_conversation_id TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- PROJECT EVENT  (append-only; history is never rewritten)
-- ---------------------------------------------------------------------------
CREATE TABLE project_events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id    TEXT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_events_project ON project_events (project_id, created_at DESC);
CREATE INDEX idx_events_entity ON project_events (entity_type, entity_id);
CREATE INDEX idx_events_layer ON project_events (layer_id, created_at DESC);
