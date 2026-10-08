-- Automatic release of a Factory campaign, and the owner's grant that permits it.
--
-- Until now a hosted campaign stopped at a pull request and a person merged it.
-- `factory_release_grants` is the owner saying, once, at approval time, that a
-- particular change request may be released without them *if* it passes every
-- gate — and what "live" means for it. `factory_release_runs` is each attempt to
-- do that, as a state machine whose every transition is a guarded UPDATE.
--
-- Brain decides eligibility and records outcomes; it still holds no forge write
-- credential and no deployment credential. The merge and the deploy are done by
-- the protected `factory-release.yml` workflow, which asks Brain first.

CREATE TABLE factory_release_grants (
  id                  TEXT PRIMARY KEY,
  change_request_id   TEXT NOT NULL REFERENCES factory_change_requests(id),
  project_id          TEXT NOT NULL REFERENCES projects(id),
  policy              TEXT NOT NULL DEFAULT 'AUTO_LOW_RISK',
  -- What "live" means for this change: checks run inside the released Brain.
  live_checks         TEXT NOT NULL DEFAULT '[]',
  -- The Brain page a person opens to see the feature, when it has one.
  page_path           TEXT,
  granted_by_user_id  TEXT NOT NULL REFERENCES users(id),
  authority_channel   TEXT NOT NULL DEFAULT 'SHELL',
  executed_by_ref     TEXT,
  reason              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_by_user_id  TEXT REFERENCES users(id),
  revoked_reason      TEXT,

  CHECK (policy IN ('AUTO_LOW_RISK')),
  CHECK (authority_channel IN ('BROWSER','SHELL')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX idx_factory_release_grants_live
  ON factory_release_grants (change_request_id) WHERE revoked_at IS NULL;

CREATE TABLE factory_release_runs (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES factory_campaigns(id),
  change_request_id   TEXT NOT NULL REFERENCES factory_change_requests(id),
  grant_id            TEXT NOT NULL REFERENCES factory_release_grants(id),
  head_sha            TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL,
  refusal             TEXT NOT NULL DEFAULT '[]',
  merge_sha           TEXT,
  workflow_run_id     TEXT,
  deploy_run_id       TEXT,
  failure_stage       TEXT,
  failure_detail      TEXT,
  verification        TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT,

  CHECK (state IN ('REFUSED','GATING','MERGED','DEPLOYING','VERIFYING','LIVE','FAILED','ROLLED_BACK')),
  CHECK (attempt >= 1)
);

CREATE UNIQUE INDEX idx_factory_release_runs_attempt
  ON factory_release_runs (campaign_id, head_sha, attempt);
-- At most one release in flight per campaign, decided by the database.
CREATE UNIQUE INDEX idx_factory_release_runs_live
  ON factory_release_runs (campaign_id)
  WHERE state IN ('GATING','MERGED','DEPLOYING','VERIFYING');
CREATE INDEX idx_factory_release_runs_campaign ON factory_release_runs (campaign_id, created_at);
