-- ---------------------------------------------------------------------------
-- THE SCENARIO ENGINE: saved models, and every run with exactly what it was asked
-- ---------------------------------------------------------------------------
--
-- A model is a definition a person can revise. A run copies the definition it
-- was evaluated against into `config_json`, beside the seed and the options, so
-- a result always resolves to the exact assumptions that produced it however
-- the model changes afterwards. `result_digest` is the hash of the result minus
-- its elapsed time: re-running the same config must reproduce it, and that is
-- the reproducibility check rather than a promise.
--
-- `state` is a fact about the process, not about the model: RUNNING is written
-- before the engine starts and COMPLETE or FAILED after. A RUNNING row whose
-- process died is reported as interrupted on the read path and can be re-run;
-- nothing is overwritten (§5). No money figure here is ledger money: every
-- result carries `simulated: true`, and nothing reads these tables to decide a
-- live Cash action.
CREATE TABLE IF NOT EXISTS scenario_models (
  id               TEXT PRIMARY KEY,
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
  model_id         TEXT NOT NULL REFERENCES scenario_models(id),
  project_id       TEXT NOT NULL REFERENCES projects(id),
  label            TEXT,
  seed             INTEGER NOT NULL,
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
