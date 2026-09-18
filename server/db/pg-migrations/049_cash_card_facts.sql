-- The Postgres half of SQLite migration 058. See that file for why.
CREATE TABLE IF NOT EXISTS cash_card_facts (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,

  field           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('EVIDENCE', 'RECOMMENDATION', 'PERSON')),
  value           TEXT NOT NULL,

  claim_id        TEXT,
  need_id         TEXT,

  basis           TEXT,
  assumptions     TEXT,
  uncertainty     TEXT,

  decided_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_card_facts_field
  ON cash_card_facts(opportunity_id, field);

CREATE INDEX IF NOT EXISTS idx_cash_card_facts_project
  ON cash_card_facts(project_id, kind);
