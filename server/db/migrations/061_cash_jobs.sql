-- Where privacy actually begins.
--
-- The four private operations were applied to discovery, which made four
-- frontiers out of one. Discovery is shared: evidence about the world is not
-- anybody's private state, and §31 already settled that a validated finding
-- belongs to the Brain. What *is* private starts later, at the first moment
-- there is something private to hold — an owner, a budget, a credential, a
-- decision, a payment.
--
-- That moment is an execution job. An opportunity is shared and stays shared;
-- a job over it carries the parts that are somebody's.
--
-- A job is deliberately not a second opportunity. It points at one, adds who is
-- doing it and what they may spend, and owns nothing about the evidence — so
-- reassigning a job moves none of the research, and unassigning one loses none
-- of it either.
CREATE TABLE cash_jobs (
  id                TEXT PRIMARY KEY,
  -- The shared opportunity this executes. Many jobs may point at one over its
  -- life (a reassignment is a second job), and the opportunity is untouched.
  opportunity_id    TEXT NOT NULL REFERENCES cash_opportunities (id),
  -- The root the shared frontier lives in, carried so a job can be read without
  -- joining back through the opportunity on every query.
  project_id        TEXT NOT NULL REFERENCES projects (id),

  -- UNASSIGNED -> ASSIGNED -> EXECUTING -> DELIVERING -> COLLECTED
  --                       \-> RELEASED (back to unassigned, keeping this row)
  state             TEXT NOT NULL,

  -- Null is a real and ordinary state: a job may exist while its dependencies
  -- are resolved, before anybody is the right person to hold it.
  owner_user_id     TEXT REFERENCES users (id),

  -- SHARED: any member of the root may read this job's working state.
  -- PRIVATE: only the owner and the people on cash_job_participants may.
  -- The default is PRIVATE because the safe answer must not be the one somebody
  -- has to remember — §27's `mutationScope` lesson, at the row that holds money.
  visibility        TEXT NOT NULL DEFAULT 'PRIVATE',

  -- What this job may spend, independently of every other job. Null means it
  -- has no ceiling of its own and falls back to the grant on the root, which is
  -- how a job created before anybody set one still behaves safely: the grant is
  -- the outer bound either way and a job can only ever be narrower.
  budget_cents      INTEGER,
  currency          TEXT NOT NULL,

  -- Free text a person wrote about why this job exists, kept so a reassignment
  -- does not lose the reason the work was started.
  note              TEXT,

  assigned_at       TEXT,
  released_at       TEXT,
  release_reason    TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- At most one job may be live against one opportunity at a time. A released or
-- collected job keeps its row, so history survives a reassignment; what the
-- index forbids is two people simultaneously believing the work is theirs.
CREATE UNIQUE INDEX idx_cash_jobs_live
  ON cash_jobs (opportunity_id)
  WHERE state NOT IN ('RELEASED', 'COLLECTED');

CREATE INDEX idx_cash_jobs_owner ON cash_jobs (owner_user_id, state);
CREATE INDEX idx_cash_jobs_project ON cash_jobs (project_id, state);

-- A job may be several people's. Kept as rows rather than a list column so a
-- membership can be added and removed without rewriting the job.
CREATE TABLE cash_job_participants (
  job_id     TEXT NOT NULL REFERENCES cash_jobs (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  added_by   TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (job_id, user_id)
);
