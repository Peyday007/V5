-- The Postgres half of migration 045. Same tables, same rules.
--
-- `seq BIGSERIAL` on both, because `dialect.ts` rewrites `rowid` to `seq` and a
-- table without it fails every cursor-ordered query on this backend while
-- passing the whole SQLite suite. That has now happened three times —
-- `012_checkpoint_seq.sql`, §25's three connect tables, and
-- `workerSessionForBin`'s tiebreak — so it is written into the table rather
-- than remembered.
CREATE TABLE IF NOT EXISTS russell_lens_inquiries (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lens              TEXT NOT NULL,
  question          TEXT NOT NULL,
  subject           TEXT,
  state             TEXT NOT NULL CHECK (state IN
                      ('REQUESTED','RUNNING','ANSWERED','REFUSED','FAILED','CANCELLED')),
  refusal_reason    TEXT,
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  findings          TEXT NOT NULL DEFAULT '[]',
  discarded         INTEGER NOT NULL DEFAULT 0,
  discard_reasons   TEXT NOT NULL DEFAULT '[]',
  opened_by         TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'SHARED',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  answered_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_lens_inquiries_project
  ON russell_lens_inquiries(project_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_lens_inquiries_bin
  ON russell_lens_inquiries(bin_id);

CREATE TABLE IF NOT EXISTS russell_lens_decisions (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  inquiry_id        TEXT NOT NULL REFERENCES russell_lens_inquiries(id) ON DELETE CASCADE,
  finding_index     INTEGER NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('ACCEPTED','DISMISSED')),
  reason            TEXT,
  frontier_item_id  TEXT REFERENCES russell_frontier(id) ON DELETE SET NULL,
  decided_by        TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  UNIQUE (inquiry_id, finding_index)
);
