-- Step 12B — the Discovery Frontier.
--
-- The SQLite chain's 042, said in this dialect. The reasoning lives there; the
-- two files must describe the same thing or the repository layer is true on one
-- backend and merely compiling on the other.

CREATE TABLE russell_frontier (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  region               TEXT NOT NULL,
  subject              TEXT NOT NULL,
  detail               TEXT,
  source_kind          TEXT NOT NULL,
  source_id            TEXT,
  lens                 TEXT,
  fingerprint          TEXT NOT NULL,
  visibility           TEXT NOT NULL DEFAULT 'SHARED',
  dismissed_at         TEXT,
  dismissed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  dismissed_reason     TEXT,
  resolved_at          TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,

  -- The identity column `dialect.ts` rewrites `rowid` to.
  seq                  BIGSERIAL,

  CHECK (region IN ('SOLID_GROUND','WEAK_GROUND','OPEN_QUESTION','UNEXAMINED','NEW_PATH')),
  CHECK (source_kind IN ('KNOWLEDGE','LAYER','AUDIT_GAP','CANDIDATE','CONTRADICTION','ABSENCE')),
  CHECK (visibility IN ('PRIVATE','SHARED'))
);

CREATE UNIQUE INDEX idx_russell_frontier_identity
  ON russell_frontier (project_id, fingerprint);

CREATE INDEX idx_russell_frontier_region
  ON russell_frontier (project_id, region, resolved_at);
