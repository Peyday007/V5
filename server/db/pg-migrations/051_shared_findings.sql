-- The Postgres half of SQLite migration 060. See that file for why.
--
-- `seq` exists because `dialect.ts` rewrites `rowid` to `seq`, and a tiebreak
-- on a column only one backend has is the easiest way to write an ORDER BY that
-- is true in one dialect and throws in the other.
CREATE TABLE IF NOT EXISTS shared_findings (
  id                      TEXT PRIMARY KEY,
  seq                     BIGSERIAL,

  claim_id                TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,

  origin_project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin_orchestration_id TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  origin_fragment_id      TEXT REFERENCES research_fragments(id) ON DELETE SET NULL,
  origin_layer_id         TEXT REFERENCES layers(id) ON DELETE SET NULL,
  origin_worker_id        TEXT,
  origin_session_ref      TEXT,

  rule_version            TEXT NOT NULL,

  state                   TEXT NOT NULL DEFAULT 'ACTIVE',
  valid_until             TEXT,

  revoked_at              TEXT,
  revoked_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason          TEXT,

  promoted_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,

  CHECK (state IN ('ACTIVE','REVOKED')),
  CHECK (state <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_findings_claim
  ON shared_findings (claim_id);
CREATE INDEX IF NOT EXISTS idx_shared_findings_state
  ON shared_findings (state, origin_project_id);
CREATE INDEX IF NOT EXISTS idx_shared_findings_origin
  ON shared_findings (origin_project_id, promoted_at);
