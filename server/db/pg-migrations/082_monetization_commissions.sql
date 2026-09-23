-- The Postgres half of SQLite migration 091. See that file for why the unique
-- index is the whole concurrency design, why `round` is inside the key rather
-- than beside it, and why `answered` is NULL while a commission is open rather
-- than 0.
--
-- `seq BIGSERIAL` is the identity column `db/dialect.ts` rewrites `rowid` to,
-- without which every cursor-ordered query over this table passes on SQLite
-- and throws on the backend production runs. That has now happened four times
-- in this repository — `012_checkpoint_seq.sql`, §25's three connect tables,
-- §27's `worker_sessions` tiebreak — which is the argument for the second
-- backend in one line.
CREATE TABLE IF NOT EXISTS monetization_commissions (
  seq           BIGSERIAL,
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT NOT NULL,
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),
  attribute     TEXT NOT NULL,
  round         INTEGER NOT NULL CHECK (round >= 1),
  candidate_id  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  rule_rank     INTEGER NOT NULL,
  state         TEXT NOT NULL
                CHECK (state IN ('OPEN', 'ANSWERED', 'UNRESOLVED', 'ABANDONED')),
  opened_at     TEXT NOT NULL,
  settled_at    TEXT,
  answered      INTEGER,
  outcome       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (state = 'OPEN' OR (answered IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (state = 'OPEN' OR settled_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_commissions_ask
  ON monetization_commissions(project_id, path_id, attribute, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_commissions_candidate
  ON monetization_commissions(candidate_id);

CREATE INDEX IF NOT EXISTS idx_monetization_commissions_project
  ON monetization_commissions(project_id, state);

CREATE INDEX IF NOT EXISTS idx_monetization_commissions_path
  ON monetization_commissions(path_id, attribute);
