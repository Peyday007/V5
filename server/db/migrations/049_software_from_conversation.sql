-- Two tables that together make "talk to Russell about a site, and Brain does
-- the software work" a real journey rather than two products in one app.
--
-- ---------------------------------------------------------------------------
-- factory_project_repositories — the boundary, established rather than defaulted
-- ---------------------------------------------------------------------------
--
-- Until now a submission's reach was `mutationScope`, an *optional* field
-- defaulting to `['**']`. That is not a boundary: it is a value a caller may
-- omit, and omitting it granted the whole repository. Narrowing it afterwards
-- does not repair that either, because `amendContract` may only narrow what the
-- submission already claimed — so an over-broad initial scope is the widest the
-- campaign will ever be judged against, and the amendment path cannot reach back
-- past it.
--
-- The boundary therefore has to be a fact recorded *before* any objective is
-- written, by a person with ADMIN on the project, in the same action that
-- authorizes the repository for that project at all. That action already exists:
-- onboarding. So this row is written there, from an explicit answer with no
-- default, and `submitObjective` reads it.
--
-- `scope_kind` is not decoration over `path_scope`. `['**']` has to be
-- *chosen* — a project that owns its whole repository is an ordinary and correct
-- arrangement — and the difference between "somebody said whole repository" and
-- "nobody said anything" is exactly the difference this table exists to record.
-- One is a decision; the other was a default, and a default is what let the
-- widest possible scope be the quiet one.
--
-- Keyed by (project, grant) rather than by repository, because a shared
-- repository holding one directory per site is the arrangement this makes
-- workable: two projects, one grant, two disjoint boundaries, one worker
-- surface. Nothing here decides which arrangement anybody uses.
CREATE TABLE IF NOT EXISTS factory_project_repositories (
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- The envelope grant's id, so the row cannot outlive an authorization being
  -- withdrawn in code: a grant that is gone resolves to nothing and the
  -- submission is refused with the envelope's own reason.
  grant_id        TEXT NOT NULL,

  -- `owner/name`, lowercased — the same id `worker_routing` and
  -- `services/bins/routing.ts` compare on, so the authorization a submission is
  -- checked against and the routing a bin is handed out under are the same
  -- string rather than two spellings of it.
  repository_id   TEXT NOT NULL,

  scope_kind      TEXT NOT NULL
                  CHECK (scope_kind IN ('WHOLE_REPOSITORY', 'DIRECTORIES')),

  -- JSON array of globs. `["**"]` iff scope_kind is WHOLE_REPOSITORY; otherwise
  -- one `dir/**` per declared directory, built by the server from directory
  -- names a person typed. A caller never supplies a glob: a pattern is a small
  -- language, and a boundary written in one is a boundary somebody can widen by
  -- accident.
  path_scope      TEXT NOT NULL,

  reason          TEXT NOT NULL,
  set_by          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  PRIMARY KEY (project_id, grant_id)
);

CREATE INDEX IF NOT EXISTS idx_factory_project_repositories_repo
  ON factory_project_repositories(repository_id);

-- ---------------------------------------------------------------------------
-- russell_software_requests — the conversation's link to a campaign
-- ---------------------------------------------------------------------------
--
-- A person says what they want changed; a worker reading the thread proposes
-- that this was a request for work rather than a remark about it; and **nothing
-- is submitted**. This row is what exists at that point: a proposal, in the
-- person's own words, carrying the repository and the exact scope it would run
-- under, waiting in Needs You for the one decision that spends anything.
--
-- It is `services/russell/proposal.ts`'s rule at a new seam. A model may propose
-- and may never execute, and the thing that makes that true here is not a check
-- inside the turn — it is that the turn's whole effect is an unauthorized row.
--
-- Duplicate submissions are refused in two independent places and both are
-- needed. `UNIQUE (project_id, submission_key)` means the same ask captured
-- twice — a second conversation, a redelivered turn, a person repeating
-- themselves — is one row rather than two cards. And `submissionKeyFor` at the
-- factory means that even if two rows somehow reached authorization, they would
-- collide on one change request rather than fork the work. Neither is sufficient
-- alone: the first cannot see a rewording, and the second cannot stop two
-- decisions being asked for.
--
-- The state is advanced by a guarded UPDATE on `state = 'PROPOSED'`, so two
-- clicks on Authorize, a retried request and a redelivered event produce exactly
-- one campaign — the compare-and-swap this codebase uses everywhere a claim
-- happens, on a value the caller does not supply.
CREATE TABLE IF NOT EXISTS russell_software_requests (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  conversation_id       TEXT NOT NULL REFERENCES russell_conversations(id),

  -- The person's own message, so the card quotes what was actually asked rather
  -- than a worker's restatement of it. Nullable because a thread whose source
  -- message cannot be resolved is a broken link rather than a licence to invent
  -- provenance.
  message_id            TEXT,

  title                 TEXT NOT NULL,
  objective             TEXT NOT NULL,
  expected_outcome      TEXT NOT NULL,

  -- Chosen by the person at authorization, from the repositories onboarded for
  -- this project. Null while proposed: a worker does not pick the repository,
  -- because the repository is the authorization.
  grant_id              TEXT,
  repository_id         TEXT,
  base_branch           TEXT,

  -- The scope this would actually run under, resolved from the project's
  -- boundary and shown before anybody approves. Recorded so the card a person
  -- said yes to is reconstructable afterwards.
  requested_scope       TEXT,

  submission_key        TEXT NOT NULL,

  state                 TEXT NOT NULL
                        CHECK (state IN ('PROPOSED', 'AUTHORIZED', 'DECLINED')),

  change_request_id     TEXT,
  campaign_id           TEXT,
  authorized_by_user_id TEXT,
  decline_reason        TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_software_requests_key
  ON russell_software_requests(project_id, submission_key);

CREATE INDEX IF NOT EXISTS idx_russell_software_requests_conversation
  ON russell_software_requests(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_russell_software_requests_open
  ON russell_software_requests(project_id, state, created_at);
