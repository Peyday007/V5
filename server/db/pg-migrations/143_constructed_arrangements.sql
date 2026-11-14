-- The Postgres half of SQLite migration 152. See that file for why a
-- constructed arrangement is a CONSTRUCTED row of the §49 ledger, why its
-- identity is a structural signature rather than text or a row id, and why a
-- research verdict is stored with the inputs it was reached under.
--
-- Postgres alters a CHECK in place, so nothing is rebuilt. The two CHECKs 081
-- wrote inline are dropped by the names Postgres gave them — a one-column
-- CHECK is `<table>_<column>_check`, the first multi-column one `<table>_check`
-- — and restated, relaxed, under explicit names.

ALTER TABLE monetization_paths ADD COLUMN design_signature TEXT;
ALTER TABLE monetization_paths ADD COLUMN legacy_key TEXT;
ALTER TABLE monetization_paths ADD COLUMN design_json TEXT;
ALTER TABLE monetization_paths ADD COLUMN construction_origin TEXT;
ALTER TABLE monetization_paths ADD COLUMN precedent_opportunity_id TEXT REFERENCES cash_opportunities(id);
ALTER TABLE monetization_paths ADD COLUMN first_goal_id TEXT;
ALTER TABLE monetization_paths ADD COLUMN inputs_digest TEXT;
ALTER TABLE monetization_paths ADD COLUMN last_composed_at TEXT;
ALTER TABLE monetization_paths ADD COLUMN asked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monetization_paths ADD COLUMN last_asked_at TEXT;
ALTER TABLE monetization_paths ADD COLUMN evaluated_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monetization_paths ADD COLUMN last_evaluation_goal_id TEXT;
ALTER TABLE monetization_paths ADD COLUMN last_evaluation_reading_id TEXT;
ALTER TABLE monetization_paths ADD COLUMN last_evaluation_contribution_cents INTEGER;
ALTER TABLE monetization_paths ADD COLUMN last_evaluation_picked INTEGER;
ALTER TABLE monetization_paths ADD COLUMN research_verdict TEXT;
ALTER TABLE monetization_paths ADD COLUMN verdict_inputs_digest TEXT;
ALTER TABLE monetization_paths ADD COLUMN verdict_round_id TEXT;
ALTER TABLE monetization_paths ADD COLUMN verdict_at TEXT;

ALTER TABLE monetization_paths DROP CONSTRAINT monetization_paths_origin_check;
ALTER TABLE monetization_paths DROP CONSTRAINT monetization_paths_check;

ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_origin_kinds
  CHECK (origin IN ('SEED', 'ENUMERATED', 'EVIDENCED', 'CONSTRUCTED'));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_subject
  CHECK ((opportunity_id IS NULL) <> (industry_node_id IS NULL)
         OR (origin = 'CONSTRUCTED' AND opportunity_id IS NULL AND industry_node_id IS NULL));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_construction_origin
  CHECK (construction_origin IS NULL OR construction_origin IN ('FORWARD', 'TRANSFER', 'REVERSE'));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_asked_count
  CHECK (asked_count >= 0);
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_evaluated_count
  CHECK (evaluated_count >= 0);
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_last_picked
  CHECK (last_evaluation_picked IS NULL OR last_evaluation_picked IN (0, 1));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_verdict
  CHECK (research_verdict IS NULL OR research_verdict IN ('CONFIRMED', 'REFUTED'));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_constructed_signature
  CHECK ((origin = 'CONSTRUCTED') = (design_signature IS NOT NULL));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_constructed_design
  CHECK (origin <> 'CONSTRUCTED'
         OR (design_json IS NOT NULL AND construction_origin IS NOT NULL AND inputs_digest IS NOT NULL));
ALTER TABLE monetization_paths ADD CONSTRAINT monetization_paths_verdict_inputs
  CHECK (research_verdict IS NULL OR verdict_inputs_digest IS NOT NULL);

DROP INDEX IF EXISTS idx_monetization_paths_subject;
CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_subject
  ON monetization_paths(project_id, COALESCE(opportunity_id, '-'),
                        COALESCE(industry_node_id, '-'), method,
                        COALESCE(design_signature, '-'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_signature
  ON monetization_paths(project_id, design_signature);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_signature_any
  ON monetization_paths(design_signature);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_legacy_key
  ON monetization_paths(project_id, legacy_key);


CREATE TABLE IF NOT EXISTS monetization_path_evaluations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  path_id            TEXT NOT NULL REFERENCES monetization_paths(id),
  goal_id            TEXT NOT NULL,
  reading_id         TEXT NOT NULL,
  picked             INTEGER NOT NULL,
  refused            INTEGER NOT NULL,
  contribution_cents INTEGER,
  evaluated_at       TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (picked IN (0, 1)),
  CHECK (refused IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_evaluations_reading
  ON monetization_path_evaluations(path_id, reading_id);

CREATE INDEX IF NOT EXISTS idx_monetization_evaluations_goal
  ON monetization_path_evaluations(goal_id, evaluated_at);
