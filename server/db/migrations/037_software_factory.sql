-- The Software Factory control plane.
--
-- Brain already knows how to hold work, hand it to an authenticated worker
-- under a fenced lease, refuse an effect it has already performed, and fire a
-- session at a Routine. What it has never held is the *shape* of a software
-- change: an objective a person approved, the acceptance conditions that
-- decide whether it happened, a dependency graph of bounded units, and the
-- evidence that each unit's code was written by one session and judged by a
-- different one.
--
-- Everything here is that shape. Nothing here is a second orchestration
-- universe: the claim is the same compare-and-swap on a generation that
-- `work_items` and `bins` use, the refusals are the same deny-by-default
-- decision `services/identity/policy.ts` already makes, and the metrics are
-- one append-only ledger rather than a second table that must agree with it.
--
-- Four properties the tables are arranged to have:
--
--   * **A campaign cannot be created twice.** `factory_campaigns` has a UNIQUE
--     change request, and a change request has a UNIQUE submission key inside
--     its project. A duplicate submission therefore collides rather than
--     forking the work, whether it arrives from a retried HTTP request, a
--     redelivered queue item or a person pressing the button twice.
--
--   * **An approved contract is immutable, and a change to it is a row.**
--     `factory_contract_amendments` is append-only and carries both values,
--     the actor, the affected units and whether re-verification is required.
--     A factory that could silently redefine success would always pass.
--
--   * **A unit's ownership is declared before it runs.** `owned_paths` is what
--     the integrator holds the diff against, so a worker that wandered outside
--     its contract is rejected on the evidence rather than on a reviewer
--     noticing. Two units whose ownership intersects are never leased at once.
--
--   * **A lease exists iff the unit is LEASED**, enforced by CHECK, and the
--     lease generation is the fencing token. A worker that died and came back
--     holding generation 7 against a row now on 8 matches nothing: it cannot
--     resurrect the unit, overwrite the new owner's commit, or report success
--     for work somebody else already redid.

/* ------------------------------------------------------------------------- */
/* The contract                                                               */
/* ------------------------------------------------------------------------- */

CREATE TABLE factory_change_requests (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  -- The logical identity of the ask, supplied by whoever submits it. Two
  -- submissions carrying the same key are the same change request, which is
  -- what makes "submit twice, get one campaign" a property of the schema
  -- rather than of a caller remembering to check first.
  submission_key        TEXT NOT NULL,
  contract_version      INTEGER NOT NULL DEFAULT 1,

  -- What a person supplies.
  objective             TEXT NOT NULL,
  expected_outcome      TEXT NOT NULL,
  non_goals             TEXT NOT NULL DEFAULT '[]',
  acceptance_conditions TEXT NOT NULL DEFAULT '[]',

  -- What Brain derives from the repository and the objective. A person is not
  -- asked to configure any of it.
  repository            TEXT NOT NULL,
  base_branch           TEXT NOT NULL,
  base_sha              TEXT NOT NULL,
  environment           TEXT NOT NULL DEFAULT 'LOCAL',
  risk_class            TEXT NOT NULL DEFAULT 'MEDIUM',
  mutation_scope        TEXT NOT NULL DEFAULT '[]',
  deployment_policy     TEXT NOT NULL DEFAULT 'NONE',
  external_spend_policy TEXT NOT NULL DEFAULT 'PROHIBITED',
  rollback_requirement  TEXT NOT NULL,
  verification_commands TEXT NOT NULL DEFAULT '[]',

  -- Who authorized it. Exactly one of the two is meaningful, and the standing
  -- authority is Russell's own grant rather than a second policy engine.
  approved_by_user_id   TEXT REFERENCES users(id),
  approved_via          TEXT,
  authority_id          TEXT,
  approved_at           TEXT,

  state                 TEXT NOT NULL DEFAULT 'DRAFT',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,

  CHECK (state IN ('DRAFT','APPROVED','WITHDRAWN')),
  CHECK (environment IN ('LOCAL','STAGING','PRODUCTION')),
  CHECK (risk_class IN ('LOW','MEDIUM','HIGH')),
  CHECK (deployment_policy IN ('NONE','STAGING_ONLY','CONTROL_PLANE_AFTER_VERIFICATION')),
  -- The one value this product issues. A paid external effect is not something
  -- a factory may authorize for itself; widening this is a code change.
  CHECK (external_spend_policy IN ('PROHIBITED')),
  CHECK (approved_via IS NULL OR approved_via IN ('PERSON','STANDING_AUTHORITY')),
  CHECK (contract_version >= 1),
  -- An approved change request has an approval. Deny by default, in the schema.
  CHECK (
    (state <> 'APPROVED')
    OR (approved_via IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_factory_cr_submission
  ON factory_change_requests (project_id, submission_key);
CREATE INDEX idx_factory_cr_project ON factory_change_requests (project_id, state);

CREATE TABLE factory_contract_amendments (
  id                    TEXT PRIMARY KEY,
  change_request_id     TEXT NOT NULL,
  campaign_id           TEXT,
  field                 TEXT NOT NULL,
  old_value             TEXT NOT NULL,
  new_value             TEXT NOT NULL,
  reason                TEXT NOT NULL,
  actor_type            TEXT NOT NULL,
  actor_id              TEXT,
  affected_work         TEXT NOT NULL DEFAULT '[]',
  requires_reverification INTEGER NOT NULL DEFAULT 1,
  from_contract_version INTEGER NOT NULL,
  to_contract_version   INTEGER NOT NULL,
  created_at            TEXT NOT NULL,

  CHECK (actor_type IN ('PERSON','FACTORY')),
  CHECK (requires_reverification IN (0,1))
);

CREATE INDEX idx_factory_amendments_cr
  ON factory_contract_amendments (change_request_id, created_at);

/* ------------------------------------------------------------------------- */
/* The campaign                                                               */
/* ------------------------------------------------------------------------- */

CREATE TABLE factory_campaigns (
  id                  TEXT PRIMARY KEY,
  -- One campaign per change request. The whole of acceptance condition 2.
  change_request_id   TEXT NOT NULL UNIQUE REFERENCES factory_change_requests(id),
  project_id          TEXT NOT NULL REFERENCES projects(id),
  state               TEXT NOT NULL DEFAULT 'PLANNING',
  stage_detail        TEXT,
  base_sha            TEXT NOT NULL,
  integration_branch  TEXT NOT NULL,
  integration_sha     TEXT,
  -- What the scheduler currently believes it should run at once, and why it
  -- believes it. Adaptive, derived from `factory_events`, never configured by
  -- a person.
  lane_target         INTEGER NOT NULL DEFAULT 3,
  lane_target_reason  TEXT NOT NULL DEFAULT 'initial',
  -- An operational fact with an operational remedy, from a closed vocabulary.
  blocker_kind        TEXT,
  blocker_detail      TEXT,
  -- The campaign tick's lease. A second dispatcher that reads generation 7 and
  -- swaps on it loses, exactly like a second worker claiming a unit.
  generation          INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  review_rounds       INTEGER NOT NULL DEFAULT 0,
  pr_ref              TEXT,
  pr_url              TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN (
    'PLANNING','EXECUTING','INTEGRATING','REVIEWING','REPAIRING',
    'VERIFYING','ASSEMBLING','AWAITING_RELEASE','COMPLETE','BLOCKED','CANCELLED'
  )),
  CHECK (lane_target >= 1),
  CHECK (generation >= 0),
  CHECK (review_rounds >= 0),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX idx_factory_campaigns_project ON factory_campaigns (project_id, state);

/* ------------------------------------------------------------------------- */
/* The work                                                                   */
/* ------------------------------------------------------------------------- */

CREATE TABLE factory_work_units (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES factory_campaigns(id),
  -- The unit's logical identity. A retry raises `attempt`; it never creates a
  -- second row, so "retries do not create duplicate logical WorkUnits" is a
  -- UNIQUE index rather than a convention.
  unit_key          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  role              TEXT NOT NULL,
  title             TEXT NOT NULL,
  objective         TEXT NOT NULL,
  acceptance        TEXT NOT NULL DEFAULT '[]',
  -- The mutation surface this unit owns. The integrator holds the diff against
  -- it, and the scheduler refuses to lease two units whose surfaces intersect.
  owned_paths       TEXT NOT NULL DEFAULT '[]',
  required_context  TEXT NOT NULL DEFAULT '[]',
  verification      TEXT NOT NULL DEFAULT '[]',
  expected_artifact TEXT NOT NULL DEFAULT '',
  risk              TEXT NOT NULL DEFAULT 'MEDIUM',
  critical_path     INTEGER NOT NULL DEFAULT 0,
  downstream_count  INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER NOT NULL DEFAULT 5,
  model_class       TEXT NOT NULL DEFAULT 'FAST',
  state             TEXT NOT NULL DEFAULT 'BLOCKED',
  attempt           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,

  lease_generation  INTEGER NOT NULL DEFAULT 0,
  lease_id          TEXT,
  lease_worker_id   TEXT,
  lease_session_id  TEXT,
  leased_at         TEXT,
  lease_expires_at  TEXT,

  worktree_path     TEXT,
  branch            TEXT,
  head_sha          TEXT,
  base_sha          TEXT,

  -- What the worker said, kept as evidence, and never the thing that decides
  -- whether the unit succeeded. The repository decides that.
  worker_summary    TEXT,
  terminal_result   TEXT,
  failure_category  TEXT,
  failure_detail    TEXT,
  -- Rate limiting is backpressure. A deferred unit is not a failed one, so the
  -- deferral lives here and `attempt` is left alone.
  not_before        TEXT,
  repairs_finding_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  CHECK (state IN (
    'BLOCKED','READY','LEASED','IMPLEMENTED','INTEGRATED',
    'FAILED','CANCELLED','SUPERSEDED'
  )),
  CHECK (kind IN (
    'INTERFACE','IMPLEMENTATION','TEST','MIGRATION','REPAIR',
    'REVIEW','INTEGRATION','VERIFICATION','DOCS'
  )),
  CHECK (role IN ('ARCHITECT','IMPLEMENTER','REVIEWER','INTEGRATOR','VERIFIER')),
  CHECK (model_class IN ('STRONGEST','FAST')),
  CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  CHECK (attempt >= 0),
  CHECK (max_attempts >= 1),
  CHECK (lease_generation >= 0),
  CHECK (critical_path IN (0,1)),
  -- A lease exists if and only if the unit is LEASED.
  CHECK (
    (state = 'LEASED'
       AND lease_id IS NOT NULL AND lease_worker_id IS NOT NULL
       AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'LEASED'
       AND lease_id IS NULL AND lease_worker_id IS NULL
       AND lease_expires_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_factory_units_key ON factory_work_units (campaign_id, unit_key);
CREATE INDEX idx_factory_units_state ON factory_work_units (campaign_id, state, priority);
CREATE INDEX idx_factory_units_lease ON factory_work_units (state, lease_expires_at);

CREATE TABLE factory_unit_dependencies (
  campaign_id         TEXT NOT NULL REFERENCES factory_campaigns(id),
  unit_id             TEXT NOT NULL REFERENCES factory_work_units(id),
  depends_on_unit_id  TEXT NOT NULL REFERENCES factory_work_units(id),
  reason              TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  PRIMARY KEY (unit_id, depends_on_unit_id),
  -- A unit cannot depend on itself. A graph with a self-edge has no order.
  CHECK (unit_id <> depends_on_unit_id)
);

CREATE INDEX idx_factory_deps_campaign ON factory_unit_dependencies (campaign_id);
CREATE INDEX idx_factory_deps_reverse ON factory_unit_dependencies (depends_on_unit_id);

-- A worker's own handover. The point of it is that a *different* worker can
-- resume without reconstructing the investigation, so it is append-only and
-- the newest row for a unit is the one a resuming assignment carries.
CREATE TABLE factory_checkpoints (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL,
  unit_id         TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  session_id      TEXT,
  worker_id       TEXT,
  established     TEXT NOT NULL,
  commits         TEXT NOT NULL DEFAULT '[]',
  tests_run       TEXT NOT NULL DEFAULT '[]',
  unresolved      TEXT NOT NULL DEFAULT '',
  next_action     TEXT NOT NULL,
  created_at      TEXT NOT NULL,

  CHECK (attempt >= 0)
);

-- Ordered by insertion, which is `rowid` locally and `seq` in the cloud —
-- `dialect.ts` rewrites the one into the other. Two checkpoints written in the
-- same millisecond would otherwise come back in an arbitrary order, and the
-- newest is the one a resuming assignment carries.
CREATE INDEX idx_factory_checkpoints_unit
  ON factory_checkpoints (unit_id, created_at);

/* ------------------------------------------------------------------------- */
/* The fleet                                                                  */
/* ------------------------------------------------------------------------- */

-- The worker registry. Adding a worker is an INSERT here plus whatever grant
-- its surface needs; it is never a change to factory code. `kind` selects an
-- executor that already exists, and a kind nothing implements is refused at
-- registration rather than discovered at dispatch.
CREATE TABLE factory_workers (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL,
  -- The account or surface this worker draws its allowance from, by name. An
  -- account is not a worker and a worker is not a Routine: §23's distinction,
  -- kept because sizing a fleet by multiplying a label is sizing it on a
  -- fiction.
  account_ref           TEXT NOT NULL,
  model                 TEXT NOT NULL,
  model_class           TEXT NOT NULL DEFAULT 'FAST',
  capabilities          TEXT NOT NULL DEFAULT '[]',
  repositories          TEXT NOT NULL DEFAULT '[]',
  max_concurrency       INTEGER NOT NULL DEFAULT 1,
  availability          TEXT NOT NULL DEFAULT 'AVAILABLE',
  -- The NAME of the secret, and a digest of the value taken once. Never the
  -- value: a row that held a credential would put it in every projection that
  -- reads the row.
  credential_ref        TEXT,
  credential_digest     TEXT,
  brain_worker_id       TEXT REFERENCES workers(id),
  -- Provider backpressure. Advances on a refusal and leaves the failure streak
  -- alone, because an account at its ceiling is busy rather than broken.
  rate_limited_until    TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  registered_by_user_id TEXT REFERENCES users(id),
  last_seen_at          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,

  CHECK (kind IN ('LOCAL_CLI','COWORK_ROUTINE','REMOTE_SESSION')),
  CHECK (model_class IN ('STRONGEST','FAST','EITHER')),
  CHECK (availability IN ('AVAILABLE','PAUSED','QUARANTINED')),
  CHECK (max_concurrency >= 1),
  CHECK (consecutive_failures >= 0)
);

CREATE INDEX idx_factory_workers_available
  ON factory_workers (availability, rate_limited_until);

-- One execution of one worker. This is the lineage an independence check reads:
-- a review whose session is the session that wrote the code is not a review,
-- and "we could not tell" must never read the same as "we checked".
CREATE TABLE factory_sessions (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL,
  unit_id             TEXT,
  worker_id           TEXT NOT NULL,
  account_ref         TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 0,
  role                TEXT NOT NULL,
  -- The executor's own identifier for the session it ran. Observed from the
  -- run, never supplied by the worker's output.
  external_session_id TEXT,
  model               TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'RUNNING',
  exit_reason         TEXT,
  duration_ms         INTEGER,
  num_turns           INTEGER,
  -- Token counts and nothing else. No credential, no prompt, no reply.
  usage               TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN ('RUNNING','FINISHED','FAILED','RATE_LIMITED','ABANDONED')),
  CHECK (role IN ('ARCHITECT','IMPLEMENTER','REVIEWER','INTEGRATOR','VERIFIER')),
  CHECK (attempt >= 0)
);

CREATE INDEX idx_factory_sessions_unit ON factory_sessions (unit_id, started_at);
CREATE INDEX idx_factory_sessions_campaign ON factory_sessions (campaign_id, state);
CREATE INDEX idx_factory_sessions_worker ON factory_sessions (worker_id, state);

/* ------------------------------------------------------------------------- */
/* Judgement                                                                  */
/* ------------------------------------------------------------------------- */

CREATE TABLE factory_reviews (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES factory_campaigns(id),
  round               INTEGER NOT NULL DEFAULT 1,
  scope               TEXT NOT NULL DEFAULT 'CAMPAIGN',
  unit_id             TEXT,
  reviewer_session_id TEXT,
  reviewed_sha        TEXT NOT NULL,
  verdict             TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',
  -- What separation was actually achieved, never rounded up.
  independence        TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at          TEXT NOT NULL,

  CHECK (scope IN ('CAMPAIGN','UNIT')),
  CHECK (verdict IN ('PASS','CHANGES_REQUIRED','BLOCKED')),
  CHECK (independence IN (
    'UNKNOWN','SESSION_SEPARATED','WORKER_SEPARATED','ACCOUNT_SEPARATED'
  )),
  CHECK (round >= 1)
);

CREATE INDEX idx_factory_reviews_campaign ON factory_reviews (campaign_id, round);

CREATE TABLE factory_findings (
  id                      TEXT PRIMARY KEY,
  review_id               TEXT NOT NULL REFERENCES factory_reviews(id),
  campaign_id             TEXT NOT NULL REFERENCES factory_campaigns(id),
  -- The finding's logical identity inside its review. A re-reported finding
  -- collides rather than queueing a second repair for the same defect.
  finding_key             TEXT NOT NULL,
  severity                TEXT NOT NULL,
  category                TEXT NOT NULL,
  statement               TEXT NOT NULL,
  evidence                TEXT NOT NULL DEFAULT '',
  acceptance_condition_id TEXT,
  state                   TEXT NOT NULL DEFAULT 'OPEN',
  repair_unit_id          TEXT,
  resolution              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,

  CHECK (severity IN ('BLOCKER','MAJOR','MINOR')),
  CHECK (state IN ('OPEN','REPAIR_QUEUED','REPAIRED','REJECTED','ACCEPTED_LIMITATION'))
);

CREATE UNIQUE INDEX idx_factory_findings_key
  ON factory_findings (review_id, finding_key);
CREATE INDEX idx_factory_findings_state ON factory_findings (campaign_id, state);

CREATE TABLE factory_integrations (
  id                    TEXT PRIMARY KEY,
  campaign_id           TEXT NOT NULL REFERENCES factory_campaigns(id),
  unit_id               TEXT NOT NULL REFERENCES factory_work_units(id),
  attempt               INTEGER NOT NULL,
  outcome               TEXT NOT NULL,
  reason                TEXT NOT NULL DEFAULT '',
  rejected_paths        TEXT NOT NULL DEFAULT '[]',
  before_sha            TEXT NOT NULL,
  after_sha             TEXT,
  verification          TEXT NOT NULL DEFAULT '[]',
  integrator_session_id TEXT,
  created_at            TEXT NOT NULL,

  CHECK (outcome IN ('MERGED','REJECTED','CONFLICT','DEFERRED','VERIFICATION_FAILED')),
  CHECK (attempt >= 0)
);

CREATE UNIQUE INDEX idx_factory_integrations_attempt
  ON factory_integrations (unit_id, attempt, outcome);
CREATE INDEX idx_factory_integrations_campaign
  ON factory_integrations (campaign_id, created_at);

/* ------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* ------------------------------------------------------------------------- */

-- The capacity and provenance ledger, append-only and without foreign keys: a
-- row a cascade can delete is not a ledger row. Every throughput and
-- concurrency number the factory reports is counted from here, so there is no
-- second table that could drift out of agreement with it.
--
-- `evidence_class` is the honesty requirement. A duration the factory timed is
-- MEASURED; a refusal a provider issued is PROVIDER_ENFORCED; a number
-- computed from other rows is DERIVED; a ceiling nobody has observed is
-- UNKNOWN and stays UNKNOWN.
CREATE TABLE factory_events (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT,
  unit_id        TEXT,
  worker_id      TEXT,
  session_id     TEXT,
  account_ref    TEXT,
  kind           TEXT NOT NULL,
  phase          TEXT,
  duration_ms    INTEGER,
  evidence_class TEXT NOT NULL DEFAULT 'DERIVED',
  detail         TEXT NOT NULL DEFAULT '{}',
  at             TEXT NOT NULL,

  CHECK (evidence_class IN ('MEASURED','PROVIDER_ENFORCED','DERIVED','UNKNOWN'))
);

CREATE INDEX idx_factory_events_campaign ON factory_events (campaign_id, at);
CREATE INDEX idx_factory_events_kind ON factory_events (kind, at);
CREATE INDEX idx_factory_events_unit ON factory_events (unit_id, at);

-- Large evidence lives in the store; its hash and reference live here. UNIQUE
-- on the hash inside a campaign is the deduplication: the same worker log
-- written twice is one row.
CREATE TABLE factory_artifacts (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES factory_campaigns(id),
  unit_id      TEXT,
  session_id   TEXT,
  kind         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  storage_key  TEXT,
  inline_text  TEXT,
  created_at   TEXT NOT NULL,

  CHECK (kind IN (
    'WORKER_LOG','PATCH','TEST_OUTPUT','BUILD_OUTPUT','REVIEW_INPUT','PR_BODY'
  )),
  CHECK (byte_size >= 0)
);

CREATE UNIQUE INDEX idx_factory_artifacts_dedupe
  ON factory_artifacts (campaign_id, kind, sha256);

-- The human boundary, as a row with a guarded answer. A release a person has
-- not answered is REQUESTED, and nothing about a REQUESTED release lets the
-- factory proceed past it.
CREATE TABLE factory_releases (
  id                 TEXT PRIMARY KEY,
  campaign_id        TEXT NOT NULL REFERENCES factory_campaigns(id),
  kind               TEXT NOT NULL,
  decision           TEXT NOT NULL DEFAULT 'REQUESTED',
  evidence           TEXT NOT NULL DEFAULT '{}',
  decided_by_user_id TEXT REFERENCES users(id),
  decided_reason     TEXT,
  decided_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  CHECK (kind IN ('CONTROL_PLANE','PRODUCT_CHANGE')),
  CHECK (decision IN ('REQUESTED','APPROVED','REFUSED')),
  CHECK ((decision = 'REQUESTED') = (decided_at IS NULL))
);

CREATE INDEX idx_factory_releases_campaign ON factory_releases (campaign_id, decision);
