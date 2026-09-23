-- The Postgres half of SQLite migration 092. See that file for why only the
-- objective's intent is stored and everything about where it has got to is
-- derived, and why the decision table is append-only.
--
-- `seq BIGSERIAL` is the identity column `db/dialect.ts` rewrites `rowid` to.
CREATE TABLE IF NOT EXISTS russell_objectives (
  seq                 BIGSERIAL,
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  conversation_id     TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL
                      CHECK (source_kind IN ('CASH_MODE', 'CONVERSATION')),
  source_ref          TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  closed_at           TEXT,
  closed_reason       TEXT,
  closed_by_user_id   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (closed_at IS NULL OR closed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_objectives_live_source
  ON russell_objectives (project_id, source_kind, source_ref)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_russell_objectives_project
  ON russell_objectives (project_id);

CREATE TABLE IF NOT EXISTS russell_objective_steps (
  seq              BIGSERIAL,
  id               TEXT PRIMARY KEY,
  objective_id     TEXT NOT NULL REFERENCES russell_objectives(id),
  kind             TEXT NOT NULL
                   CHECK (kind IN ('QUALIFY_OPENING', 'RESEARCH_QUESTION', 'SOFTWARE_REQUEST',
                                   'COMMERCIAL_ACTION', 'AWAIT_EXISTING')),
  path_ref         TEXT NOT NULL,
  serves           TEXT,
  description      TEXT NOT NULL,
  work_kind        TEXT,
  work_ref         TEXT,
  authority        TEXT NOT NULL CHECK (authority IN ('AUTHORIZED', 'NEEDS_PERSON')),
  boundary         TEXT,
  prepared         TEXT,
  step_key         TEXT NOT NULL,
  superseded_at    TEXT,
  superseded_reason TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (authority = 'NEEDS_PERSON' OR work_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_objective_steps_key
  ON russell_objective_steps (objective_id, step_key);

CREATE INDEX IF NOT EXISTS idx_russell_objective_steps_objective
  ON russell_objective_steps (objective_id);

CREATE TABLE IF NOT EXISTS russell_objective_decisions (
  seq           BIGSERIAL,
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES russell_objectives(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('RECOMMEND', 'NO_PATH_QUALIFIES', 'STOP')),
  path_ref      TEXT,
  fingerprint   TEXT NOT NULL,
  -- The decision this one follows, or '-' for the first. Unique per objective,
  -- so two ticks that both notice the same change append one row and post one
  -- message: the loser's insert matches the winner's key and does nothing.
  follows_id    TEXT NOT NULL,
  summary       TEXT NOT NULL,
  changed_because TEXT,
  message_id    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_russell_objective_decisions_objective
  ON russell_objective_decisions (objective_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_objective_decisions_follows
  ON russell_objective_decisions (objective_id, follows_id);
