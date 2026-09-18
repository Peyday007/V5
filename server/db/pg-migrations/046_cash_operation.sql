-- The Postgres half of SQLite migration 055. See that file for why.
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS completion_condition TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS blocks_state TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS candidate_id TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS request_key TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS continued_at TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS continuation_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_needs_key
  ON cash_needs(project_id, request_key);

CREATE TABLE IF NOT EXISTS cash_actions (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  authority_id    TEXT NOT NULL REFERENCES cash_authorities(id),

  action          TEXT NOT NULL,
  performed_by    TEXT NOT NULL CHECK (performed_by IN ('BRAIN', 'PERSON')),

  reference       TEXT,
  detail          TEXT NOT NULL,
  confirmed_by    TEXT NOT NULL,
  request_key     TEXT NOT NULL,

  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_actions_key
  ON cash_actions(project_id, request_key);

CREATE INDEX IF NOT EXISTS idx_cash_actions_opportunity
  ON cash_actions(opportunity_id, created_at);
