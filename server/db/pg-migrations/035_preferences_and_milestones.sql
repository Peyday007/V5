-- Step 12B — the per-account preference seam.
--
-- The SQLite chain's 044, said in this dialect. The reasoning lives there.

CREATE TABLE user_preferences (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- The identity column `dialect.ts` rewrites `rowid` to.
  seq        BIGSERIAL,

  PRIMARY KEY (user_id, key)
);
