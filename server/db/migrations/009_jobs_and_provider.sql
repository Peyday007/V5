-- ---------------------------------------------------------------------------
-- JOB BUNDLES, QUOTA, AND THE PROVIDER CONNECTION
--
-- A fragment is a logical evidence unit. An Antigravity job is an execution
-- container. They are not the same thing, and pretending they were meant six
-- fragments about the same statute cost six separate conversations, six
-- retrievals of the same sources, and six slices of the user's quota.
--
-- So compatible fragments share a job while keeping completely separate claims,
-- verdicts and repair histories — which is what these tables record: which
-- fragments went into which job, what the job did, and what it cost.
-- ---------------------------------------------------------------------------
CREATE TABLE research_jobs (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Why these fragments are together, in one sentence a person can check.
  rationale         TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL,
  model             TEXT,
  -- DISCOVERY | INVESTIGATION | VERIFICATION | SYNTHESIS — what the job is for,
  -- which decides how much model it deserves.
  job_kind          TEXT NOT NULL DEFAULT 'INVESTIGATION',
  -- QUEUED | RUNNING | COMPLETE | FAILED | CANCELLED | PAUSED_QUOTA
  status            TEXT NOT NULL DEFAULT 'QUEUED',
  priority          INTEGER NOT NULL DEFAULT 5,

  -- The provider's own identifier for the conversation, when it exposes one.
  external_job_id   TEXT,
  prompt_sha256     TEXT,
  -- Bytes in and out, so a bundle's cost is visible rather than inferred.
  prompt_bytes      INTEGER,
  output_bytes      INTEGER,
  duration_ms       INTEGER,
  failure_reason    TEXT,

  queued_at         TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_research_jobs_orchestration ON research_jobs (orchestration_id, status);
CREATE INDEX idx_research_jobs_status ON research_jobs (status, priority, queued_at);

-- Which fragments a job carries. A bundled fragment keeps its own identity,
-- its own claims and its own verdict; only the execution is shared.
CREATE TABLE research_job_fragments (
  job_id       TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  fragment_id  TEXT NOT NULL REFERENCES research_fragments(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL DEFAULT 0,
  -- Whether this fragment's part of the job produced usable output.
  outcome      TEXT,
  detail       TEXT,
  PRIMARY KEY (job_id, fragment_id)
);
CREATE INDEX idx_job_fragments_fragment ON research_job_fragments (fragment_id);

-- ---------------------------------------------------------------------------
-- QUOTA PAUSES
--
-- Running out of quota is an ordinary event, not a failure. It must not lose
-- work, and it must never be a reason to lower the evidence bar — so it is
-- recorded as a pause with what was completed and what is still queued, and the
-- run resumes when the allowance comes back.
-- ---------------------------------------------------------------------------
CREATE TABLE quota_pauses (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  -- EXHAUSTED | LIMITED | UNKNOWN, as the provider reported it.
  quota_state       TEXT NOT NULL,
  detail            TEXT NOT NULL,
  jobs_completed    INTEGER NOT NULL DEFAULT 0,
  jobs_pending      INTEGER NOT NULL DEFAULT 0,
  paused_at         TEXT NOT NULL,
  resumed_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_quota_pauses_orchestration ON quota_pauses (orchestration_id, paused_at);

-- ---------------------------------------------------------------------------
-- PROVIDER CONNECTION STATE
--
-- What the last connection test found, kept so the settings page can show a
-- result rather than re-probing on every render — and so a user can see when it
-- last actually worked, which is the question they are really asking.
--
-- Paid overages live here too, defaulting to off. Spending the user's money is
-- never a default.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_connections (
  provider              TEXT PRIMARY KEY,
  installed             INTEGER NOT NULL DEFAULT 0,
  authenticated         INTEGER NOT NULL DEFAULT 0,
  automation_ready      INTEGER NOT NULL DEFAULT 0,
  executable_path       TEXT,
  version               TEXT,
  model                 TEXT,
  quota_state           TEXT,
  message               TEXT,
  -- The diagnostic detail, sanitized: no credentials, no environment, no paths
  -- beyond the executable the user chose to install.
  diagnostics           TEXT,
  last_checked_at       TEXT,
  -- The last time a real job actually ran, which is what "connected" means.
  last_success_at       TEXT,
  last_failure_at       TEXT,
  last_failure_reason   TEXT,
  -- Off unless the user turns it on, and recorded when they do.
  paid_overage_enabled  INTEGER NOT NULL DEFAULT 0,
  paid_overage_note     TEXT,
  paid_overage_set_at   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- research_passes already carries the provider's job id from checkpoint B; the
-- bundle id it belonged to is added beside it so a pass traces to both.
ALTER TABLE research_passes ADD COLUMN bundle_id TEXT;
