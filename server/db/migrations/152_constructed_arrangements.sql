-- brain:rebuild-without-foreign-keys
--
-- ---------------------------------------------------------------------------
-- CONSTRUCTED ARRANGEMENTS ARE A LIBRARY, NOT A CACHE (Surge B, K-1..K-8)
-- ---------------------------------------------------------------------------
--
-- Brain composes arrangements nobody published (§81/§82): a buyer population,
-- a need, a way to fulfil it and a transaction design. Until this migration
-- every one of them lived in two process Maps with 10- and 30-minute
-- lifetimes, so a restart, a deploy, a second goal or a second process
-- recomposed the whole space from zero, and nothing about an arrangement —
-- that it was asked about, that research refuted it, that a goal's model
-- picked it — survived except a 12-hex hash inside a round's bucket id.
--
-- They are stored in the §49 ledger, which already is "a way of being paid,
-- for a subject, with evidence-vs-recommendation facts", rather than in a
-- third payment vocabulary beside `MonetizationMethod` and `Structure`:
--
--   * `origin = 'CONSTRUCTED'` — a hypothesis by definition. Its quantities
--     (value p10/p50/p90, unknown parts, stress) are Brain's reconstruction
--     and live in `design_json`; what research *observed* about it is an
--     EVIDENCE row in `monetization_path_facts`, which the existing CHECK
--     already ties to a gated claim. The two can never be confused.
--   * `design_signature` — identity by structure, never by text or row id:
--     a hash of the design key and, for buyer, need and supply, the node kind
--     and normalised name path from the map root. A re-created node, a second
--     goal or a model change composing the same structure lands on the same
--     row (unique per project), so near-identical recompositions cannot
--     inflate the count.
--   * the counters and the last evaluation are what a derivation cannot
--     recover: that a round asked about it, that a goal model weighed it and
--     whether it picked it, and what research concluded under which inputs.
--
-- A reverse arrangement has no buyer yet, so the subject CHECK admits a
-- CONSTRUCTED row with neither subject; every other origin keeps exactly-one.
-- The subject unique index gains the signature so several constructed designs
-- on one buyer and one method are distinct rows, while every non-constructed
-- row (signature NULL → '-') is constrained exactly as before.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt; every column, every
-- other constraint and every index 090 wrote is restated. The children
-- (facts, judgments, edges, snapshots, commissions) reference the table by
-- name and are untouched; the runner checks foreign keys before committing.
-- ---------------------------------------------------------------------------

CREATE TABLE monetization_paths_rebuilt (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),

  opportunity_id    TEXT REFERENCES cash_opportunities(id),
  industry_node_id  TEXT REFERENCES industry_nodes(id),

  method            TEXT NOT NULL,
  title             TEXT NOT NULL,
  thesis            TEXT,

  origin            TEXT NOT NULL CHECK (origin IN ('SEED', 'ENUMERATED', 'EVIDENCED', 'CONSTRUCTED')),

  source_claim_id   TEXT REFERENCES research_claims(id),

  merged_into_id    TEXT REFERENCES monetization_paths(id),
  split_from_id     TEXT REFERENCES monetization_paths(id),

  last_evaluated_at TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  -- The constructed arrangement. All NULL on every other origin.
  design_signature  TEXT,
  legacy_key        TEXT,
  design_json       TEXT,
  construction_origin TEXT CHECK (construction_origin IS NULL OR construction_origin IN ('FORWARD', 'TRANSFER', 'REVERSE')),
  precedent_opportunity_id TEXT REFERENCES cash_opportunities(id),
  first_goal_id     TEXT,
  inputs_digest     TEXT,
  last_composed_at  TEXT,

  -- Prior planning uses and research, as counts plus the last of each.
  asked_count       INTEGER NOT NULL DEFAULT 0 CHECK (asked_count >= 0),
  last_asked_at     TEXT,
  evaluated_count   INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_count >= 0),
  last_evaluation_goal_id TEXT,
  last_evaluation_reading_id TEXT,
  last_evaluation_contribution_cents INTEGER,
  last_evaluation_picked INTEGER CHECK (last_evaluation_picked IS NULL OR last_evaluation_picked IN (0, 1)),

  -- What research concluded, and under which inputs: a refutation holds only
  -- while the arrangement's inputs are the ones it was refuted under.
  research_verdict  TEXT CHECK (research_verdict IS NULL OR research_verdict IN ('CONFIRMED', 'REFUTED')),
  verdict_inputs_digest TEXT,
  verdict_round_id  TEXT,
  verdict_at        TEXT,

  CHECK ((opportunity_id IS NULL) <> (industry_node_id IS NULL)
         OR (origin = 'CONSTRUCTED' AND opportunity_id IS NULL AND industry_node_id IS NULL)),
  CHECK (origin <> 'EVIDENCED' OR source_claim_id IS NOT NULL),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (split_from_id IS NULL OR split_from_id <> id),
  CHECK ((origin = 'CONSTRUCTED') = (design_signature IS NOT NULL)),
  CHECK (origin <> 'CONSTRUCTED'
         OR (design_json IS NOT NULL AND construction_origin IS NOT NULL AND inputs_digest IS NOT NULL)),
  CHECK (research_verdict IS NULL OR verdict_inputs_digest IS NOT NULL)
);

INSERT INTO monetization_paths_rebuilt
  (rowid, id, project_id, opportunity_id, industry_node_id, method, title, thesis, origin,
   source_claim_id, merged_into_id, split_from_id, last_evaluated_at, created_at, updated_at)
SELECT rowid, id, project_id, opportunity_id, industry_node_id, method, title, thesis, origin,
       source_claim_id, merged_into_id, split_from_id, last_evaluated_at, created_at, updated_at
  FROM monetization_paths;

DROP TABLE monetization_paths;

ALTER TABLE monetization_paths_rebuilt RENAME TO monetization_paths;

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_subject
  ON monetization_paths(project_id, COALESCE(opportunity_id, '-'),
                        COALESCE(industry_node_id, '-'), method,
                        COALESCE(design_signature, '-'));

CREATE INDEX IF NOT EXISTS idx_monetization_paths_project
  ON monetization_paths(project_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_opportunity
  ON monetization_paths(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_node
  ON monetization_paths(industry_node_id);

-- One row per structure per project: the arbiter for two goals or two
-- processes composing the same arrangement at once. NULLs are distinct in a
-- unique index in both dialects, so every non-constructed row is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_signature
  ON monetization_paths(project_id, design_signature);

-- The census and cross-project reuse look a structure up across projects.
CREATE INDEX IF NOT EXISTS idx_monetization_paths_signature_any
  ON monetization_paths(design_signature);

-- Existing round history is keyed by the 12-hex key in `goal-<id>-mx-<key>`.
CREATE INDEX IF NOT EXISTS idx_monetization_paths_legacy_key
  ON monetization_paths(project_id, legacy_key);


-- ---------------------------------------------------------------------------
-- EACH TIME A GOAL'S MODEL WEIGHED A CONSTRUCTED ARRANGEMENT
--
-- Append-only, one row per arrangement per stored plan reading (a reading is
-- written only when its conclusion changes, so this is a history of distinct
-- conclusions, not of passes). `picked` is whether the model's best
-- combination used it; `contribution_cents` is its settled-cash p50 in that
-- model. The path row carries the count and the last one; this carries all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_path_evaluations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  path_id            TEXT NOT NULL REFERENCES monetization_paths(id),
  goal_id            TEXT NOT NULL,
  reading_id         TEXT NOT NULL,
  picked             INTEGER NOT NULL CHECK (picked IN (0, 1)),
  refused            INTEGER NOT NULL CHECK (refused IN (0, 1)),
  contribution_cents INTEGER,
  evaluated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_evaluations_reading
  ON monetization_path_evaluations(path_id, reading_id);

CREATE INDEX IF NOT EXISTS idx_monetization_evaluations_goal
  ON monetization_path_evaluations(goal_id, evaluated_at);
