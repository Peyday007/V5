-- The Postgres half of SQLite migration 156 (§111): experiments that compare alternative fixes to one deficiency.
CREATE TABLE evolution_experiments (
  id                 TEXT PRIMARY KEY,
  candidate_id       TEXT NOT NULL REFERENCES improvement_candidates(id),
  deficiency         TEXT NOT NULL,
  capability_class   TEXT NOT NULL,
  suite              TEXT NOT NULL,
  baseline_sha       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('BUILDING', 'EVALUATING', 'DECIDED', 'HELD')),
  verdict            TEXT CHECK (verdict IS NULL OR verdict IN ('ADOPT', 'REJECTED_ALL', 'INSUFFICIENT')),
  winner_variant_id  TEXT,
  origin             TEXT NOT NULL DEFAULT 'OPERATOR',
  run_id             TEXT,
  cause              TEXT,
  rationale          TEXT,
  created_at         TEXT NOT NULL,
  decided_at         TEXT
);

CREATE INDEX idx_evolution_experiments_state ON evolution_experiments (state, created_at);

CREATE TABLE evolution_variants (
  id             TEXT PRIMARY KEY,
  experiment_id  TEXT NOT NULL REFERENCES evolution_experiments(id),
  label          TEXT NOT NULL,
  approach_type  TEXT NOT NULL,
  approach_text  TEXT NOT NULL,
  signature      TEXT NOT NULL,
  owner_paths    TEXT NOT NULL DEFAULT '[]',
  candidate_id   TEXT REFERENCES improvement_candidates(id),
  campaign_id    TEXT,
  pr_url         TEXT,
  head_sha       TEXT,
  branch         TEXT,
  lines_changed  INTEGER,
  state          TEXT NOT NULL CHECK (state IN ('BUILDING', 'PR_READY', 'FAILED', 'ADOPTED', 'REJECTED')),
  score          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (experiment_id, label)
);

CREATE INDEX idx_evolution_variants_experiment ON evolution_variants (experiment_id);

CREATE TABLE evolution_results (
  id             TEXT PRIMARY KEY,
  experiment_id  TEXT REFERENCES evolution_experiments(id),
  variant_id     TEXT,
  sha            TEXT NOT NULL,
  ref            TEXT,
  suite          TEXT NOT NULL,
  metrics_json   TEXT NOT NULL,
  cases_json     TEXT NOT NULL DEFAULT '[]',
  hidden         INTEGER NOT NULL DEFAULT 0,
  cause          TEXT,
  owner_paths    TEXT,
  ran_at         TEXT NOT NULL,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX idx_evolution_results_experiment ON evolution_results (experiment_id, variant_id, ran_at);
CREATE INDEX idx_evolution_results_suite ON evolution_results (suite, variant_id, ran_at);

CREATE TABLE evolution_hidden_cases (
  id          TEXT PRIMARY KEY,
  suite       TEXT NOT NULL,
  case_json   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_evolution_hidden_cases_suite ON evolution_hidden_cases (suite, created_at);

CREATE TABLE evolution_approach_stats (
  approach_type     TEXT NOT NULL,
  capability_class  TEXT NOT NULL,
  trials            INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  total_lift        DOUBLE PRECISION NOT NULL DEFAULT 0,
  retired_at        TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (approach_type, capability_class)
);
