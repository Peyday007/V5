-- ---------------------------------------------------------------------------
-- STAGED RESEARCH ORCHESTRATION
--
-- One giant prompt is not deep research, and one conversation is not
-- responsible for a broad subject. An assignment is decomposed into bounded
-- fragments, each fragment is researched and validated as its own job, only the
-- fragments that pass their evidence gate contribute claims, the synthesis is
-- assembled from those accepted ledgers, and Brain's own audit judges the
-- result.
--
-- The state of that work is written down after every single step. That is what
-- makes the loop survivable: a crash, a cancelled job, a machine that went to
-- sleep, or a research tool that hung all leave a record of exactly how far the
-- work got and what it had found, rather than an empty run and a shrug.
--
-- The orchestration is the assignment. It hangs off the existing research_run
-- (the assignment Brain issued) so nothing about runs, prompts, dependencies or
-- redo lineage has to change to accommodate it.
-- ---------------------------------------------------------------------------
CREATE TABLE research_orchestrations (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id                TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
  -- The assignment this executes. A run always exists: Brain issues the
  -- assignment, and the orchestration is how it gets carried out.
  run_id                  TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,

  title                   TEXT NOT NULL,
  assignment              TEXT NOT NULL,
  target_version          TEXT,

  provider                TEXT NOT NULL,
  model                   TEXT,

  -- QUEUED | PLANNING | RESEARCHING | SYNTHESIZING | AUDITING | AWAITING_REPAIR
  -- | COMPLETE | FAILED | CANCELLED | INTERRUPTED | NEEDS_HUMAN
  status                  TEXT NOT NULL DEFAULT 'QUEUED',
  -- The pass it is on, or the last one it reached.
  current_pass            TEXT,
  -- Repair attempt number within one lineage. 1 is the original attempt.
  attempt                 INTEGER NOT NULL DEFAULT 1,
  parent_orchestration_id TEXT REFERENCES research_orchestrations(id) ON DELETE SET NULL,
  -- Why a repair exists, in the audit's own words. Never invented here.
  repair_reason           TEXT,

  -- The synthesis text, kept even when the audit later rejects it: a rejected
  -- report is the evidence for why the repair was needed.
  report_text             TEXT,
  -- The registered artifact, once the report has been filed.
  document_id             TEXT REFERENCES documents(id) ON DELETE SET NULL,
  audit_id                TEXT REFERENCES audits(id) ON DELETE SET NULL,
  verdict                 TEXT,

  queued_at               TEXT NOT NULL,
  started_at              TEXT,
  completed_at            TEXT,
  failed_at               TEXT,
  failure_reason          TEXT,
  cancelled_at            TEXT,
  cancel_reason           TEXT,
  -- Written while a pass is in flight. A RUNNING row whose heartbeat stopped
  -- belongs to a process that is gone, which is how restart recovery tells a
  -- live job from the wreckage of a dead one.
  heartbeat_at            TEXT,

  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_orchestrations_project ON research_orchestrations (project_id, status);
CREATE INDEX idx_orchestrations_layer ON research_orchestrations (layer_id, created_at);
CREATE INDEX idx_orchestrations_run ON research_orchestrations (run_id);
CREATE INDEX idx_orchestrations_parent ON research_orchestrations (parent_orchestration_id);


-- ---------------------------------------------------------------------------
-- FRAGMENTS
--
-- One conversation is not responsible for a broad subject. An assignment is
-- decomposed into bounded fragments first — each with a single question it can
-- actually answer, and the boundaries that make an answer checkable: which
-- geography, which timeframe, which population, whose definitions, which source
-- types count and which are inadequate, and how many independent sources it
-- takes before the fragment is considered covered.
--
-- Breadth comes from having many fragments. Correctness is enforced inside each
-- one, because a fragment that cannot meet its own evidence bar must not be
-- allowed to contribute a single claim to the synthesis.
-- ---------------------------------------------------------------------------
CREATE TABLE research_fragments (
  id                      TEXT PRIMARY KEY,
  orchestration_id        TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id                TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,

  fragment_index          INTEGER NOT NULL,
  -- Stable handle used by dependencies and by the synthesis citations.
  fragment_key            TEXT NOT NULL,
  question                TEXT NOT NULL,

  -- The boundaries. Stored as given, because a fragment whose scope drifted is
  -- the most common way a plausible answer turns out to be the wrong answer.
  geography               TEXT,
  timeframe               TEXT,
  population              TEXT,
  definitions             TEXT,

  -- JSON arrays: the evidence lanes that must be filled, what may be cited,
  -- what may not, what "done" means, and which fragments must land first.
  required_evidence       TEXT NOT NULL DEFAULT '[]',
  acceptable_source_types TEXT NOT NULL DEFAULT '[]',
  excluded_source_types   TEXT NOT NULL DEFAULT '[]',
  completion_criteria     TEXT NOT NULL DEFAULT '[]',
  depends_on              TEXT NOT NULL DEFAULT '[]',
  min_independent_sources INTEGER NOT NULL DEFAULT 2,

  -- PLANNED | QUEUED | RUNNING | VALIDATING | ACCEPTED | BLOCKED | REJECTED
  -- | CANCELLED | NEEDS_HUMAN
  status                  TEXT NOT NULL DEFAULT 'PLANNED',
  attempt                 INTEGER NOT NULL DEFAULT 1,
  parent_fragment_id      TEXT REFERENCES research_fragments(id) ON DELETE SET NULL,
  -- Why this attempt exists and what was done differently. A rerun that changes
  -- nothing is a waste of the user's quota.
  repair_reason           TEXT,
  repair_strategy         TEXT,

  -- Two separate verdicts, because they fail for different reasons: evidence can
  -- be impeccable and still not answer the question, and a complete answer can
  -- rest on sources that do not support it.
  -- PASS | FAIL | null
  integrity_verdict       TEXT,
  -- SUFFICIENT | INSUFFICIENT | null
  sufficiency_verdict     TEXT,
  -- The gate's full working: which conditions failed, coverage per lane, counts.
  verdict_detail          TEXT,
  blocked_reason          TEXT,

  queued_at               TEXT,
  started_at              TEXT,
  completed_at            TEXT,
  accepted_at             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_fragments_orchestration
  ON research_fragments (orchestration_id, fragment_index);
CREATE INDEX idx_fragments_status ON research_fragments (status, queued_at);
CREATE INDEX idx_fragments_parent ON research_fragments (parent_fragment_id);

-- ---------------------------------------------------------------------------
-- PASSES
--
-- One row per attempt at one pass, written before the provider is called and
-- completed after it answers. The exact prompt and the raw reply are both kept:
-- a result you cannot trace back to what was asked is not reproducible, and a
-- failure with no record of the reply cannot be diagnosed.
--
-- Append-only. A retried pass is a new row with a higher attempt, never an edit.
-- ---------------------------------------------------------------------------
CREATE TABLE research_passes (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  -- Null for the assignment-level passes (PLAN, SYNTHESIS, AUDIT); set for every
  -- pass that belongs to one fragment's own job.
  fragment_id       TEXT REFERENCES research_fragments(id) ON DELETE CASCADE,
  -- PLAN | BROAD_SCAN | TARGETED | ADVERSARIAL | VERIFICATION | SYNTHESIS | AUDIT
  pass_key          TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  -- RUNNING | COMPLETE | FAILED | CANCELLED
  status            TEXT NOT NULL DEFAULT 'RUNNING',

  provider          TEXT NOT NULL,
  model             TEXT,
  prompt            TEXT NOT NULL,
  prompt_sha256     TEXT NOT NULL,
  raw_response      TEXT,
  -- The validated structure. Only this may be acted on; the prose never is.
  parsed            TEXT,
  error             TEXT,
  -- The provider's own job identifier, so a pass resolves to its execution log.
  job_id            TEXT,

  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  duration_ms       INTEGER
);
CREATE INDEX idx_research_passes_orchestration
  ON research_passes (orchestration_id, ordinal, attempt);
CREATE INDEX idx_research_passes_fragment ON research_passes (fragment_id, ordinal, attempt);

-- ---------------------------------------------------------------------------
-- THE CLAIM LEDGER
--
-- Every material claim keeps its own evidence: what was claimed, where it came
-- from, when it was retrieved, how confident the pass was, whether anything
-- later contradicted it, and which pass produced it.
--
-- The rule that gives the ledger its value: no URL means the claim is not
-- treated as sourced. An unsourced claim is still recorded — hiding it would
-- make the report look better than it is — but it is marked, counted, and it
-- cannot be cited as evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE research_claims (
  id                  TEXT PRIMARY KEY,
  orchestration_id    TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  -- The fragment that produced it. A claim with no fragment came from an
  -- assignment-level pass and may never be cited as fragment evidence.
  fragment_id         TEXT REFERENCES research_fragments(id) ON DELETE CASCADE,
  pass_id             TEXT REFERENCES research_passes(id) ON DELETE SET NULL,
  -- Which pass produced it, kept by name so it survives a pass row being cleared.
  pass_key            TEXT NOT NULL,

  claim               TEXT NOT NULL,
  source_url          TEXT,
  source_title        TEXT,
  source_publisher    TEXT,
  source_date         TEXT,
  evidence_excerpt    TEXT,
  evidence_locator    TEXT,
  -- Which of the fragment's required evidence lanes this claim fills. Coverage
  -- is counted per lane, so a claim outside every lane fills nothing.
  evidence_lane       TEXT,
  retrieved_at        TEXT,
  confidence          REAL NOT NULL DEFAULT 0,

  -- UNCHALLENGED | SUPPORTED | CONTESTED | REFUTED
  contradiction_state TEXT NOT NULL DEFAULT 'UNCHALLENGED',
  contradiction_note  TEXT,

  -- The verdict of structural source validation, and whether the claim counts
  -- as sourced at all.
  -- SOURCED | NO_URL | INVALID_URL | UNSUPPORTED_SCHEME | LOCAL_ADDRESS | NO_EVIDENCE
  validation_state    TEXT NOT NULL DEFAULT 'NO_URL',
  validation_detail   TEXT,
  sourced             INTEGER NOT NULL DEFAULT 0,

  -- Whether a claim derives from other claims rather than from a source, and
  -- which ones. An unsupported calculation is rejected rather than believed.
  derived             INTEGER NOT NULL DEFAULT 0,
  derived_from        TEXT NOT NULL DEFAULT '[]',

  -- The gate's decision. Only an accepted claim may reach the synthesis, and a
  -- rejected one keeps its rejection reason forever so it cannot quietly return.
  accepted            INTEGER NOT NULL DEFAULT 0,
  rejection_reason    TEXT,
  -- What the verification pass said about scope, date, geography and definitions.
  scope_match         TEXT,

  -- Identity of the claim's text, so the same claim restated is recognisable.
  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_research_claims_orchestration
  ON research_claims (orchestration_id, pass_key);
CREATE INDEX idx_research_claims_fragment ON research_claims (fragment_id, accepted);
CREATE INDEX idx_research_claims_hash ON research_claims (orchestration_id, content_hash);
