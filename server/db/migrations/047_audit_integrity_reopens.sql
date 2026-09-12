-- The record behind a re-audit that exists because the audit was not independent.
--
-- An OTHER_LAYER handoff already reopens an audit round, and it is the wrong
-- instrument here: it asserts that the document moved layers, and this document
-- did not. Making the rows say something untrue to get a lookup to come out
-- right is precisely what `auditRound.ts` was written to refuse.
--
-- So this is a second, narrower reason a round may begin, with its own record.
-- Nothing it does destroys anything: the superseded audit keeps its row, its
-- verdict, its gaps and its timestamps; every pass stays exactly as written;
-- the document keeps its bytes, its version, its hash and its storage key. What
-- changes is that the roles become outstanding again, which is a fact about
-- time rather than an edit to history.
--
-- `request_key` is the whole idempotency design, and it is Step 6's shape at a
-- smaller scale: the key is derived from **server-controlled facts only** — the
-- orchestration, the document, the exact content hash and the finding — so
-- nothing the caller sent contributes to it, a duplicate request collides
-- rather than reopening twice, and a *changed document* produces a different
-- key because it is a different operation about different bytes.
CREATE TABLE IF NOT EXISTS audit_integrity_reopens (
  id                   TEXT PRIMARY KEY,
  orchestration_id     TEXT NOT NULL REFERENCES research_orchestrations(id),
  project_id           TEXT NOT NULL REFERENCES projects(id),

  -- Exactly which bytes this finding is about. A reopen that named only the
  -- document id would still read as current after the file was replaced, and
  -- an integrity finding about content nobody holds any more is worse than
  -- none: it would keep a healthy audit reported as pending correction.
  document_id          TEXT NOT NULL REFERENCES documents(id),
  document_version     TEXT NOT NULL,
  document_hash        TEXT NOT NULL,

  -- A closed vocabulary, checked here rather than described in prose, because
  -- a finding nothing can enumerate cannot be reported or counted.
  finding              TEXT NOT NULL
                       CHECK (finding IN ('AUTHOR_REVIEWED_OWN_WORK')),
  finding_detail       TEXT NOT NULL,

  -- The verdict that no longer stands on its own. Kept as a pointer; the audit
  -- row itself is never touched.
  superseded_audit_id  TEXT,

  -- Which roles this round must run again, and which are carried forward with
  -- the reason each one may be. JSON arrays, written once at request time from
  -- the recorded lineage rather than from anything a caller asked for.
  roles_rerun          TEXT NOT NULL,
  roles_carried        TEXT NOT NULL,

  -- The authenticated principal that initiated the recovery. Not an attribution
  -- string: it is resolved against the database before the row is written, and
  -- a replay re-authorizes rather than trusting what is stored here.
  requested_by_type    TEXT NOT NULL CHECK (requested_by_type IN ('PERSON')),
  requested_by_id      TEXT NOT NULL,

  request_key          TEXT NOT NULL,

  -- The boundary this reopen created. `auditRoundStartedAt` reads the matching
  -- append-only event rather than this column; it is here so the record can be
  -- read on its own without joining to the event log.
  round_started_at     TEXT NOT NULL,

  state                TEXT NOT NULL
                       CHECK (state IN ('OPEN', 'RESOLVED', 'SUPERSEDED_BY_VERSION')),
  resolved_audit_id    TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL
);

-- One reopen per (packet, document bytes, finding). The `INSERT ... ON CONFLICT
-- DO NOTHING` that uses it is what makes a duplicate request, a retried request
-- after a lost response, and a restart mid-request all the same outcome.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_integrity_reopens_key
  ON audit_integrity_reopens (request_key);

CREATE INDEX IF NOT EXISTS idx_audit_integrity_reopens_orchestration
  ON audit_integrity_reopens (orchestration_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_integrity_reopens_open
  ON audit_integrity_reopens (state, project_id);
