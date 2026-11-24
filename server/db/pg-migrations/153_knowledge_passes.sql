-- ---------------------------------------------------------------------------
-- COMMERCIAL KNOWLEDGE PASSES (§122)
-- ---------------------------------------------------------------------------
--
-- One row per knowledge pass: when it started, when it ended and what it did
-- (the report as JSON — datasets discovered and read, figures written,
-- buyers linked, facts filed, errors). Before this the report lived only in
-- the server's memory, so a pass that never started and a pass whose every
-- request failed looked the same from outside: no rows. Append-only; a
-- RUNNING row whose process died stays RUNNING, which is itself the answer.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_passes (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
  report       TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_passes_started ON knowledge_passes (started_at);
