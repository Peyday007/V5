-- ---------------------------------------------------------------------------
-- A DELIVERABLE IS A FILE SOMEBODY CAN OPEN, NOT A PLAN FOR MAKING ONE
--
-- Brain could research a question, file a report into a layer and audit it,
-- and it could not hand a person the thing they asked for: a dossier, a
-- comparison, a spreadsheet. A request for one produced an answer, an idea or
-- a prompt for some other model, and the file — when there was one — lived in
-- a worker's scratch directory that stopped existing when the session did.
--
-- These three tables are the record of carrying a request to a file. They are
-- not a second research pipeline: the source material is the project's own
-- citable claims, the work is two bins on the fleet Steps 10 and 11 already
-- fire, the bytes go through the storage layer every document uses, and the
-- delivery is a message in the Russell conversation that asked. See §50.
--
-- `deliverables` is the request and where it has got to. Its state is a
-- stage rather than a verdict: what a version *is* lives on the version.
--
-- `deliverable_versions` is append-only in the sense that matters: a version
-- is never replaced. A repair and a revision each make a new row with the next
-- number, the previous row keeps its bytes, its content, its checks and its
-- review, and `deliverables.current_version_id` names the one that passed. So
-- "which one is current" is one column, and "what did the earlier one say" is
-- still answerable.
--
-- `deliverable_findings` is every problem any check or reviewer found, per
-- version, with the version that resolved it. A finding is never deleted; a
-- repair that fixes it records where.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deliverables (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  conversation_id       TEXT REFERENCES russell_conversations(id),
  -- The person's own message, quoted rather than restated.
  requested_message_id  TEXT,
  requested_by_user_id  TEXT,

  title                 TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('WRITTEN', 'STRUCTURED')),
  -- The format Brain produces. The format somebody *asked* for may be one Brain
  -- cannot produce; that difference is a recorded need, never a silent swap.
  format                TEXT NOT NULL CHECK (format IN ('DOCX', 'XLSX')),
  requested_format      TEXT,
  -- Intended use, audience, required contents, source requirements and
  -- acceptance conditions, as validated JSON.
  spec                  TEXT NOT NULL,
  -- Missing integrations the request depends on, named with what they would
  -- take. The work that does not depend on them continues.
  needs                 TEXT NOT NULL DEFAULT '[]',

  state                 TEXT NOT NULL CHECK (state IN
                          ('BRIEFED', 'BUILDING', 'REVIEWING', 'DELIVERED', 'NEEDS_PERSON')),
  state_reason          TEXT,

  -- Idempotency of the ask: the same request arriving twice is one row.
  submission_key        TEXT NOT NULL,

  -- The version a person should open. Moves only when a later one passes.
  current_version_id    TEXT,

  -- The one bin working on this now, and which stage it is. Both change only
  -- by a guarded UPDATE naming the values that were read.
  active_bin_id         TEXT,
  active_stage          TEXT CHECK (active_stage IS NULL OR active_stage IN ('BUILD', 'REVIEW')),
  -- Why the active build was opened, and what it was told to fix, so the
  -- version it produces records its own provenance.
  active_reason         TEXT CHECK (active_reason IS NULL OR active_reason IN ('INITIAL', 'REPAIR', 'REVISION')),
  active_reason_detail  TEXT,

  -- A correction a person asked for that no build has taken yet.
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
  deliverable_id        TEXT NOT NULL REFERENCES deliverables(id),
  version_number        INTEGER NOT NULL,
  build_bin_id          TEXT NOT NULL,
  reason                TEXT NOT NULL CHECK (reason IN ('INITIAL', 'REPAIR', 'REVISION')),
  reason_detail         TEXT,
  -- What the worker submitted, exactly as validated. The file is rendered from
  -- this by Brain, so the file and its content cannot silently disagree.
  content               TEXT NOT NULL,
  cited_claim_ids       TEXT NOT NULL DEFAULT '[]',

  storage_key           TEXT NOT NULL,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  file_hash             TEXT NOT NULL,
  -- The rendered view the native check produced (HTML of the pages, or of the
  -- calculated cells), stored beside the file so a reviewer and a person read
  -- the same thing.
  preview_key           TEXT,

  status                TEXT NOT NULL CHECK (status IN
                          ('CHECK_FAILED', 'CHECKED', 'REVIEW_PASSED', 'REVIEW_FAILED')),
  check_report          TEXT NOT NULL DEFAULT '{}',
  review_report         TEXT,
  review_bin_id         TEXT,
  reviewer_session_ref  TEXT,
  review_independence   TEXT,

  -- The message in the conversation that delivered this version, once one did.
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
