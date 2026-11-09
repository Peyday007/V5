-- ---------------------------------------------------------------------------
-- FACTORY PROGRAMS: ONE SPECIFICATION, MANY CAMPAIGNS (§96)
--
-- A program is one approved specification implemented across many campaigns.
-- It owns what no campaign could hold: the verbatim source (authoritative, never
-- edited), the requirement map derived from it, the plan of campaigns covering
-- that map, and the requirement-level ledger of production verification. A
-- campaign is still one change request, admitted by the line and released by
-- the release gate; the program only says which campaigns exist and why.
--
-- Maps and plans are versioned and append-only: a revision is a new row, so an
-- approved map is never overwritten (invariant 17), and status is derived on
-- read from these rows and the campaigns' own.
-- ---------------------------------------------------------------------------
CREATE TABLE factory_programs (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  submission_key      TEXT NOT NULL,
  title               TEXT NOT NULL,
  source_text         TEXT NOT NULL,
  source_sha256       TEXT NOT NULL,
  repository          TEXT NOT NULL,
  base_branch         TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'DRAFT',
  auto_release        INTEGER NOT NULL DEFAULT 0,
  approved_by_user_id TEXT REFERENCES users(id),
  approved_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (state IN ('DRAFT', 'APPROVED', 'WITHDRAWN')),
  CHECK (auto_release IN (0, 1)),
  CHECK ((state <> 'APPROVED') OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_factory_programs_submission ON factory_programs (project_id, submission_key);

CREATE TABLE factory_program_maps (
  program_id   TEXT NOT NULL REFERENCES factory_programs(id),
  version      INTEGER NOT NULL,
  map_json     TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (program_id, version),
  CHECK (version >= 1),
  CHECK (actor_type IN ('PERSON', 'FACTORY'))
);

CREATE TABLE factory_program_plans (
  program_id   TEXT NOT NULL REFERENCES factory_programs(id),
  version      INTEGER NOT NULL,
  map_version  INTEGER NOT NULL,
  plan_json    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (program_id, version),
  CHECK (version >= 1)
);

-- One planned campaign becomes one change request, once. The unique key is what
-- makes "submit twice, get one campaign" true across ticks, restarts and sessions.
CREATE TABLE factory_program_campaigns (
  program_id        TEXT NOT NULL REFERENCES factory_programs(id),
  campaign_key      TEXT NOT NULL,
  change_request_id TEXT NOT NULL REFERENCES factory_change_requests(id),
  plan_version      INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (program_id, campaign_key)
);

CREATE UNIQUE INDEX idx_factory_program_campaigns_cr ON factory_program_campaigns (change_request_id);

CREATE TABLE factory_program_verifications (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES factory_programs(id),
  requirement_key TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  revision        TEXT,
  checks          TEXT NOT NULL DEFAULT '[]',
  at              TEXT NOT NULL,
  CHECK (outcome IN ('PASS', 'FAIL', 'UNKNOWN'))
);

CREATE INDEX idx_factory_program_verifications ON factory_program_verifications (program_id, requirement_key, at);

CREATE TABLE factory_program_dependencies (
  program_id      TEXT NOT NULL REFERENCES factory_programs(id),
  requirement_key TEXT NOT NULL,
  depends_on      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (program_id, requirement_key, depends_on),
  CHECK (actor_type IN ('PERSON', 'FACTORY')),
  CHECK (requirement_key <> depends_on)
);
