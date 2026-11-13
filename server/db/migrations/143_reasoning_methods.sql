-- ---------------------------------------------------------------------------
-- MULTIDIRECTIONAL REASONING (§101)
--
-- A reasoning method is a way of looking at a goal: forward from what is held,
-- backward from the target, out from the middle of the best plan, through a
-- binding constraint, a resource, a relationship — or one Brain's own model
-- invented. Each is stored as an executable program of transforms over the
-- plan's openings, so the cheap engine can test it, and its record says how
-- often it produced a stronger plan. Discoveries survive the plan read that
-- found them; the next read starts from what worked.
--
-- reasoning_methods      one row per distinct method (signature-keyed)
-- reasoning_explorations one row per exploration a plan read ran (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE reasoning_methods (
  id            TEXT PRIMARY KEY,
  signature     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  stance        TEXT NOT NULL,
  origin        TEXT NOT NULL,
  thinking      TEXT NOT NULL DEFAULT '',
  program       TEXT NOT NULL,
  tries         INTEGER NOT NULL DEFAULT 0,
  improvements  INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  total_lift    REAL NOT NULL DEFAULT 0,
  best_lift     REAL NOT NULL DEFAULT 0,
  first_goal_id TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL
);
CREATE INDEX idx_reasoning_methods_stance ON reasoning_methods (stance);

CREATE TABLE reasoning_explorations (
  id               TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL,
  directions       INTEGER NOT NULL,
  model_directions INTEGER NOT NULL,
  stances          INTEGER NOT NULL,
  baseline_reach   REAL NOT NULL,
  greedy_reach     REAL NOT NULL,
  best_reach       REAL NOT NULL,
  best_method      TEXT,
  replaced         INTEGER NOT NULL DEFAULT 0,
  summary          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_reasoning_explorations_goal ON reasoning_explorations (goal_id, created_at);
