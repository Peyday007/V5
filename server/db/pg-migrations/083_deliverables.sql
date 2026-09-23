-- The Postgres twin of 092_deliverables.sql. The reasoning is there; §50.
CREATE TABLE IF NOT EXISTS deliverables (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  conversation_id       TEXT REFERENCES russell_conversations(id),
  requested_message_id  TEXT,
  requested_by_user_id  TEXT,

  title                 TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('WRITTEN', 'STRUCTURED')),
  format                TEXT NOT NULL CHECK (format IN ('DOCX', 'XLSX')),
  requested_format      TEXT,
  spec                  TEXT NOT NULL,
  needs                 TEXT NOT NULL DEFAULT '[]',

  state                 TEXT NOT NULL CHECK (state IN
                          ('BRIEFED', 'BUILDING', 'REVIEWING', 'DELIVERED', 'NEEDS_PERSON')),
  state_reason          TEXT,

  submission_key        TEXT NOT NULL,

  current_version_id    TEXT,

  active_bin_id         TEXT,
  active_stage          TEXT CHECK (active_stage IS NULL OR active_stage IN ('BUILD', 'REVIEW')),
  active_reason         TEXT CHECK (active_reason IS NULL OR active_reason IN ('INITIAL', 'REPAIR', 'REVISION')),
  active_reason_detail  TEXT,

  pending_correction    TEXT,

  build_count           INTEGER NOT NULL DEFAULT 0,
  review_count          INTEGER NOT NULL DEFAULT 0,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS deliverables_submission_key
  ON deliverables (project_id, submission_key);
CREATE INDEX IF NOT EXISTS deliverables_conversation
  ON deliverables (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS deliverables_state
  ON deliverables (state, updated_at);

CREATE TABLE IF NOT EXISTS deliverable_versions (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  deliverable_id        TEXT NOT NULL REFERENCES deliverables(id),
  version_number        INTEGER NOT NULL,
  build_bin_id          TEXT NOT NULL,
  reason                TEXT NOT NULL CHECK (reason IN ('INITIAL', 'REPAIR', 'REVISION')),
  reason_detail         TEXT,
  content               TEXT NOT NULL,
  cited_claim_ids       TEXT NOT NULL DEFAULT '[]',

  storage_key           TEXT NOT NULL,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  file_hash             TEXT NOT NULL,
  preview_key           TEXT,

  status                TEXT NOT NULL CHECK (status IN
                          ('CHECK_FAILED', 'CHECKED', 'REVIEW_PASSED', 'REVIEW_FAILED')),
  check_report          TEXT NOT NULL DEFAULT '{}',
  review_report         TEXT,
  review_bin_id         TEXT,
  reviewer_session_ref  TEXT,
  review_independence   TEXT,

  announced_at          TEXT,
  announced_message_id  TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS deliverable_versions_number
  ON deliverable_versions (deliverable_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_versions_build_bin
  ON deliverable_versions (build_bin_id);

CREATE TABLE IF NOT EXISTS deliverable_findings (
  id                      TEXT PRIMARY KEY,
  seq                     BIGSERIAL,
  deliverable_id          TEXT NOT NULL REFERENCES deliverables(id),
  version_id              TEXT REFERENCES deliverable_versions(id),
  stage                   TEXT NOT NULL CHECK (stage IN ('CHECK', 'REVIEW', 'PERSON', 'BUILD')),
  severity                TEXT NOT NULL CHECK (severity IN ('BLOCKER', 'MAJOR', 'MINOR')),
  code                    TEXT NOT NULL,
  message                 TEXT NOT NULL,
  resolved_by_version_id  TEXT,
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deliverable_findings_by_deliverable
  ON deliverable_findings (deliverable_id, created_at);
