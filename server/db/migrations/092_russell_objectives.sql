-- ---------------------------------------------------------------------------
-- WHAT SOMEBODY IS TRYING TO DO, AND WHAT BRAIN DECIDED ABOUT IT
--
-- Brain held every part of an answer to "what can we actually do?" — openings,
-- their cards, every way of being paid for one, the capability readings, the
-- grants — and no row saying what the person was trying to do. So the answer
-- had to be assembled by hand, and research went wherever a column count
-- pointed rather than where a choice was undecided.
--
-- Three tables, and only the first holds anything a derivation could not
-- recover:
--
--  * `russell_objectives` — the intent. Either adopted from an objective Brain
--    already holds (a Cash sprint's own objective) or stated in a conversation.
--    Nothing about where it has got to is stored here; the decision brief is
--    derived from rows on every read (§43).
--  * `russell_objective_steps` — the work a decision turned into. A pointer to
--    an existing work item (an opening's deep dive, a Russell idea, a software
--    request) or a prepared action waiting at an authority boundary. Its state
--    is the state of the thing it points at, read on every request.
--  * `russell_objective_decisions` — append-only: every time the derived
--    recommendation changed, and what changed it. The one thing no derivation
--    recovers is that a recommendation *used to be* something else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS russell_objectives (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  -- Where the result is reported back. The thread the objective was last asked
  -- about in; a later asking in another thread moves it there.
  conversation_id     TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL
                      CHECK (source_kind IN ('CASH_MODE', 'CONVERSATION')),
  -- The row it was adopted from, or the message it was stated in.
  source_ref          TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  closed_at           TEXT,
  closed_reason       TEXT,
  closed_by_user_id   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (closed_at IS NULL OR closed_reason IS NOT NULL)
);

-- One live objective per source: asking again about the sprint's objective
-- returns the same row rather than a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_objectives_live_source
  ON russell_objectives (project_id, source_kind, source_ref)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_russell_objectives_project
  ON russell_objectives (project_id);

CREATE TABLE IF NOT EXISTS russell_objective_steps (
  id               TEXT PRIMARY KEY,
  objective_id     TEXT NOT NULL REFERENCES russell_objectives(id),
  kind             TEXT NOT NULL
                   CHECK (kind IN ('QUALIFY_OPENING', 'RESEARCH_QUESTION', 'SOFTWARE_REQUEST',
                                   'COMMERCIAL_ACTION', 'AWAIT_EXISTING')),
  path_ref         TEXT NOT NULL,
  serves           TEXT,
  description      TEXT NOT NULL,
  -- The existing work item this step became, or NULL for a prepared action
  -- waiting on a person.
  work_kind        TEXT,
  work_ref         TEXT,
  -- AUTHORIZED when it ran inside a grant somebody set; NEEDS_PERSON when it
  -- is a prepared action waiting at the boundary a person owns.
  authority        TEXT NOT NULL CHECK (authority IN ('AUTHORIZED', 'NEEDS_PERSON')),
  boundary         TEXT,
  prepared         TEXT,
  -- Deterministic from the objective, the path, the kind and the question, so
  -- two ticks taking the same step produce one row.
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
  -- What moved it: the previous decision, and what had changed since.
  changed_because TEXT,
  -- The message this change was reported in, where it was.
  message_id    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_russell_objective_decisions_objective
  ON russell_objective_decisions (objective_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_objective_decisions_follows
  ON russell_objective_decisions (objective_id, follows_id);
