-- The Postgres half of migration 049. Same tables, same rules.
--
-- `seq BIGSERIAL` on both, because `dialect.ts` rewrites `rowid` to `seq` and a
-- table without it fails every cursor-ordered query on this backend while
-- passing the whole SQLite suite. That has happened four times; it goes in
-- whether or not these tables' own queries order by it.
CREATE TABLE IF NOT EXISTS factory_project_repositories (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  grant_id        TEXT NOT NULL,
  seq             BIGSERIAL,
  repository_id   TEXT NOT NULL,
  scope_kind      TEXT NOT NULL
                  CHECK (scope_kind IN ('WHOLE_REPOSITORY', 'DIRECTORIES')),
  path_scope      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  set_by          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, grant_id)
);

CREATE INDEX IF NOT EXISTS idx_factory_project_repositories_repo
  ON factory_project_repositories(repository_id);

CREATE TABLE IF NOT EXISTS russell_software_requests (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  conversation_id       TEXT NOT NULL REFERENCES russell_conversations(id),
  message_id            TEXT,
  title                 TEXT NOT NULL,
  objective             TEXT NOT NULL,
  expected_outcome      TEXT NOT NULL,
  grant_id              TEXT,
  repository_id         TEXT,
  base_branch           TEXT,
  requested_scope       TEXT,
  submission_key        TEXT NOT NULL,
  state                 TEXT NOT NULL
                        CHECK (state IN ('PROPOSED', 'AUTHORIZED', 'DECLINED')),
  change_request_id     TEXT,
  campaign_id           TEXT,
  authorized_by_user_id TEXT,
  decline_reason        TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_software_requests_key
  ON russell_software_requests(project_id, submission_key);

CREATE INDEX IF NOT EXISTS idx_russell_software_requests_conversation
  ON russell_software_requests(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_russell_software_requests_open
  ON russell_software_requests(project_id, state, created_at);
