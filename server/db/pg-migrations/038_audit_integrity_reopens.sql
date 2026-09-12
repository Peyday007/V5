-- The Postgres half of migration 047. Same table, same rules.
--
-- `seq BIGSERIAL`, because `dialect.ts` rewrites `rowid` to `seq` and a table
-- without it fails every cursor-ordered query on this backend while passing the
-- whole SQLite suite. That has happened four times now, so it goes in whether
-- or not this table's own queries order by it.
CREATE TABLE IF NOT EXISTS audit_integrity_reopens (
  id                   TEXT PRIMARY KEY,
  seq                  BIGSERIAL,
  orchestration_id     TEXT NOT NULL REFERENCES research_orchestrations(id),
  project_id           TEXT NOT NULL REFERENCES projects(id),

  document_id          TEXT NOT NULL REFERENCES documents(id),
  document_version     TEXT NOT NULL,
  document_hash        TEXT NOT NULL,

  finding              TEXT NOT NULL
                       CHECK (finding IN ('AUTHOR_REVIEWED_OWN_WORK')),
  finding_detail       TEXT NOT NULL,

  superseded_audit_id  TEXT,

  roles_rerun          TEXT NOT NULL,
  roles_carried        TEXT NOT NULL,

  requested_by_type    TEXT NOT NULL CHECK (requested_by_type IN ('PERSON')),
  requested_by_id      TEXT NOT NULL,

  request_key          TEXT NOT NULL,

  round_started_at     TEXT NOT NULL,

  state                TEXT NOT NULL
                       CHECK (state IN ('OPEN', 'RESOLVED', 'SUPERSEDED_BY_VERSION')),
  resolved_audit_id    TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_integrity_reopens_key
  ON audit_integrity_reopens (request_key);

CREATE INDEX IF NOT EXISTS idx_audit_integrity_reopens_orchestration
  ON audit_integrity_reopens (orchestration_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_integrity_reopens_open
  ON audit_integrity_reopens (state, project_id);
