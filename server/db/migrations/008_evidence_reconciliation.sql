-- ---------------------------------------------------------------------------
-- EXISTING-EVIDENCE RECONCILIATION
--
-- The engine could already fragment an assignment and research it. What it could
-- not do is notice that the answer was already sitting in the project.
--
-- These tables are the memory of that reasoning: what the goal actually requires,
-- what the archive already establishes, how well each requirement is covered, and
-- which gaps are genuinely worth spending research on. They exist so that
-- "we already knew this" is a recorded, inspectable decision rather than an
-- accident of what someone remembered.
-- ---------------------------------------------------------------------------

-- The boundary contract: what this assignment is and is not about.
--
-- Written before any research, because almost every wasted research run is a
-- scope failure — the right answer to a slightly different question. A boundary
-- that cannot be settled becomes a research fragment of its own rather than
-- being guessed at silently.
CREATE TABLE boundary_contracts (
  id                    TEXT PRIMARY KEY,
  orchestration_id      TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id              TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,

  primary_question      TEXT NOT NULL,
  decision_supported    TEXT,
  audience              TEXT,
  -- JSON arrays throughout: these are lists the user can correct, not prose.
  included_subjects     TEXT NOT NULL DEFAULT '[]',
  excluded_subjects     TEXT NOT NULL DEFAULT '[]',
  geography             TEXT,
  timeframe             TEXT,
  population            TEXT,
  definitions           TEXT NOT NULL DEFAULT '[]',
  required_comparisons  TEXT NOT NULL DEFAULT '[]',
  required_calculations TEXT NOT NULL DEFAULT '[]',
  expected_output       TEXT,
  required_confidence   TEXT,
  acceptable_uncertainty TEXT,
  prohibited_assumptions TEXT NOT NULL DEFAULT '[]',
  source_constraints    TEXT NOT NULL DEFAULT '[]',
  completion_standard   TEXT,
  -- Boundaries the plan could not settle. Each one is a candidate fragment.
  ambiguities           TEXT NOT NULL DEFAULT '[]',

  -- DRAFT | APPROVED | SUPERSEDED — a person may correct it before execution.
  status                TEXT NOT NULL DEFAULT 'DRAFT',
  approved_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_boundary_orchestration ON boundary_contracts (orchestration_id);

-- ---------------------------------------------------------------------------
-- The requirement graph.
--
-- Every material conclusion has to map back to one of these, which is what makes
-- "is this packet finished?" answerable rather than a matter of taste. A
-- requirement that belongs to another layer, or to implementation work, is
-- recorded as such rather than researched.
-- ---------------------------------------------------------------------------
CREATE TABLE requirements (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id          TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,

  requirement_key   TEXT NOT NULL,
  ordinal           INTEGER NOT NULL DEFAULT 0,
  statement         TEXT NOT NULL,
  -- MANDATORY | SUPPORTING | OPTIONAL
  necessity         TEXT NOT NULL DEFAULT 'MANDATORY',
  -- RESEARCH | DEFINITION | COMPARISON | CALCULATION | OTHER_LAYER
  -- | IMPLEMENTATION | EMPIRICAL_VALIDATION | TUNING | OPTIONAL_ENRICHMENT
  -- | IRRELEVANT
  kind              TEXT NOT NULL DEFAULT 'RESEARCH',
  rationale         TEXT,
  required_evidence TEXT NOT NULL DEFAULT '[]',
  completion_criteria TEXT NOT NULL DEFAULT '[]',
  -- Requirement keys this one rests on.
  depends_on        TEXT NOT NULL DEFAULT '[]',
  -- When the kind is OTHER_LAYER, which layer owns it.
  owning_layer_id   TEXT REFERENCES layers(id) ON DELETE SET NULL,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_requirements_orchestration ON requirements (orchestration_id, ordinal);
CREATE UNIQUE INDEX idx_requirements_key ON requirements (orchestration_id, requirement_key);

-- ---------------------------------------------------------------------------
-- Claims recovered from documents the project already has.
--
-- A previous research packet is not automatically a primary source: what matters
-- is the claim inside it and the citation underneath that. These rows are those
-- claims, with the locator that lets a reader find them again.
-- ---------------------------------------------------------------------------
CREATE TABLE existing_claims (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_run_id   TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  layer_id            TEXT REFERENCES layers(id) ON DELETE SET NULL,

  claim               TEXT NOT NULL,
  -- SOURCED_FACT | SELF_REPORT | UNSUPPORTED_ASSERTION | QUOTATION | INFERENCE
  -- | CALCULATION | FORECAST | RECOMMENDATION | DECISION | INSTRUCTION
  claim_type          TEXT NOT NULL DEFAULT 'UNSUPPORTED_ASSERTION',
  -- Where in the document it was found. A claim without a locator is not evidence.
  page                INTEGER,
  block_index         INTEGER,
  char_start          INTEGER,
  char_end            INTEGER,
  locator             TEXT,
  -- The external citation the document itself gave, if any.
  source_url          TEXT,
  source_title        TEXT,
  source_publisher    TEXT,
  source_date         TEXT,
  retrieved_at        TEXT,
  supporting_passage  TEXT,

  geography           TEXT,
  timeframe           TEXT,
  population          TEXT,
  definition          TEXT,

  extraction_confidence REAL NOT NULL DEFAULT 0,
  evidence_confidence   REAL NOT NULL DEFAULT 0,
  contradiction_state   TEXT NOT NULL DEFAULT 'UNCHALLENGED',
  -- UNVERIFIED | VERIFIED | UNVERIFIABLE | SUPERSEDED | REJECTED
  verification_state    TEXT NOT NULL DEFAULT 'UNVERIFIED',
  verification_detail   TEXT,
  -- The audit that already ruled on the document this came from, if any.
  prior_audit_id      TEXT REFERENCES audits(id) ON DELETE SET NULL,
  document_version    TEXT,
  superseded          INTEGER NOT NULL DEFAULT 0,

  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_existing_claims_project ON existing_claims (project_id, document_id);
CREATE INDEX idx_existing_claims_hash ON existing_claims (project_id, content_hash);

-- ---------------------------------------------------------------------------
-- The coverage matrix: one row per requirement, per assignment.
--
-- This is the table that decides whether research happens at all. Its status is
-- the answer to "do we already know this?", and its reasons are why — so a user
-- who disagrees can see exactly which claim persuaded Brain, and override it.
-- ---------------------------------------------------------------------------
CREATE TABLE requirement_coverage (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  requirement_id    TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,

  -- SATISFIED | PARTIALLY_SATISFIED | PRESENT_BUT_UNVERIFIED | STALE
  -- | CONTRADICTED | DEFINITION_MISMATCH | SUPERSEDED | OWNED_ELSEWHERE
  -- | NOT_REQUIRED | MISSING
  status            TEXT NOT NULL DEFAULT 'MISSING',
  -- Why, in sentences a person can argue with.
  reasons           TEXT NOT NULL DEFAULT '[]',
  -- The existing claims that produced this status, best first.
  claim_ids         TEXT NOT NULL DEFAULT '[]',
  document_ids      TEXT NOT NULL DEFAULT '[]',
  confidence        REAL NOT NULL DEFAULT 0,
  -- MISSING_FOUNDATIONAL | MISSING_SUPPORTING | MISSING_CALCULATION_INPUT | ...
  gap_type          TEXT,
  gap_detail        TEXT,
  -- True when this gap genuinely needs somebody to go and look things up.
  needs_research    INTEGER NOT NULL DEFAULT 0,
  -- A person may overrule any of it.
  user_override     TEXT,
  overridden_at     TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_coverage_orchestration ON requirement_coverage (orchestration_id, status);
CREATE UNIQUE INDEX idx_coverage_requirement ON requirement_coverage (orchestration_id, requirement_id);

-- Fragments gain their requirement links and the rest of the fragment contract.
ALTER TABLE research_fragments ADD COLUMN requirement_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN evidence_lane TEXT;
ALTER TABLE research_fragments ADD COLUMN why_it_matters TEXT;
ALTER TABLE research_fragments ADD COLUMN missing_evidence TEXT;
ALTER TABLE research_fragments ADD COLUMN why_existing_insufficient TEXT;
ALTER TABLE research_fragments ADD COLUMN existing_claim_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN excluded_scope TEXT;
ALTER TABLE research_fragments ADD COLUMN expected_claim_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN preferred_source_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN prohibited_evidence TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN required_comparisons TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN required_calculations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN contradiction_targets TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN failure_conditions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_fragments ADD COLUMN uncertainty_tolerance TEXT;
ALTER TABLE research_fragments ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
ALTER TABLE research_fragments ADD COLUMN estimated_effort TEXT;
ALTER TABLE research_fragments ADD COLUMN max_repairs INTEGER NOT NULL DEFAULT 2;
ALTER TABLE research_fragments ADD COLUMN split_from_id TEXT;

-- Claims gain the vocabulary the evidence standards need.
ALTER TABLE research_claims ADD COLUMN claim_type TEXT NOT NULL DEFAULT 'SOURCED_FACT';
ALTER TABLE research_claims ADD COLUMN source_group TEXT;
ALTER TABLE research_claims ADD COLUMN primary_source INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_claims ADD COLUMN geography TEXT;
ALTER TABLE research_claims ADD COLUMN timeframe TEXT;
ALTER TABLE research_claims ADD COLUMN population TEXT;
ALTER TABLE research_claims ADD COLUMN definition TEXT;
ALTER TABLE research_claims ADD COLUMN requirement_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_claims ADD COLUMN job_id TEXT;
-- How this finding relates to what the project already had.
ALTER TABLE research_claims ADD COLUMN reconciliation TEXT;
ALTER TABLE research_claims ADD COLUMN reconciled_claim_id TEXT;
