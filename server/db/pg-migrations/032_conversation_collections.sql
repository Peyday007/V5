-- Step 12B — conversations organized by meaning, not by recency.
--
-- The SQLite chain's 041, said in this dialect. The reasoning lives there; the
-- two files must describe the same thing or the repository layer is true on one
-- backend and merely compiling on the other.

CREATE TABLE russell_collections (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'AUTOMATIC',
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  -- The identity column `dialect.ts` rewrites `rowid` to. Its absence is why
  -- §25's three connect tables passed every SQLite test and threw on the
  -- database production runs; it is not being learned a fourth time.
  seq            BIGSERIAL,

  CHECK (kind IN ('PROJECT','CATEGORY','PERSONAL')),
  CHECK (source IN ('AUTOMATIC','USER'))
);

CREATE UNIQUE INDEX idx_russell_collections_name
  ON russell_collections (owner_user_id, name);

ALTER TABLE russell_conversations
  ADD COLUMN collection_id TEXT REFERENCES russell_collections(id) ON DELETE SET NULL;

ALTER TABLE russell_conversations
  ADD COLUMN collection_source TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE russell_conversations
  ADD COLUMN closed_at TEXT;

CREATE INDEX idx_russell_conversations_collection
  ON russell_conversations (collection_id, updated_at);
