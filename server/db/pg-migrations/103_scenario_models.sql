-- The scenario engine (SQLite 112_scenario_models.sql), on the Postgres chain.
-- Saved models, and every run with the exact configuration it evaluated.
CREATE TABLE IF NOT EXISTS scenario_models (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  title            TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  definition_hash  TEXT NOT NULL,
  illustrative     INTEGER NOT NULL DEFAULT 0 CHECK (illustrative IN (0, 1)),
  created_by_id    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scenario_models_project ON scenario_models (project_id, updated_at);

CREATE TABLE IF NOT EXISTS scenario_runs (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  model_id         TEXT NOT NULL REFERENCES scenario_models(id),
  project_id       TEXT NOT NULL REFERENCES projects(id),
  label            TEXT,
  seed             BIGINT NOT NULL,
  evaluations      INTEGER NOT NULL,
  config_json      TEXT NOT NULL,
  config_hash      TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('RUNNING', 'COMPLETE', 'FAILED')),
  result_json      TEXT,
  result_digest    TEXT,
  failure          TEXT,
  elapsed_ms       INTEGER,
  created_by_id    TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scenario_runs_model ON scenario_runs (model_id, started_at);
