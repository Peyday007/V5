-- The Postgres half of SQLite migration 075. See that file for why a review is
-- bound to the capture set it was briefed on, why an outstanding request is
-- what distinguishes "nothing has looked yet" from "a reader has not answered",
-- and why one table carries both kinds.
--
-- `seq BIGSERIAL` is the identity column `dialect.ts` rewrites `rowid` to. §25,
-- §27 and §34 each record what its absence costs: a tiebreak on a column only
-- one dialect has passes the whole SQLite suite and throws in production.

CREATE TABLE IF NOT EXISTS design_bin_requests (
  seq            BIGSERIAL,
  bin_id         TEXT PRIMARY KEY REFERENCES bins(id) ON DELETE CASCADE,
  cycle_id       TEXT NOT NULL REFERENCES design_cycles(id) ON DELETE CASCADE,
  pass           INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL,
  surface_keys   TEXT NOT NULL,
  revision       TEXT,
  capture_digest TEXT,
  capture_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,

  CONSTRAINT design_bin_requests_pass_check CHECK (pass >= 0),
  CONSTRAINT design_bin_requests_kind_check CHECK (kind IN ('RENDER', 'REVIEW')),
  CONSTRAINT design_bin_requests_capture_count_check CHECK (capture_count >= 0),
  CONSTRAINT design_bin_requests_review_digest_check
    CHECK (kind = 'RENDER' OR capture_digest IS NOT NULL),
  CONSTRAINT design_bin_requests_render_digest_check
    CHECK (kind = 'REVIEW' OR capture_digest IS NULL),
  CONSTRAINT design_bin_requests_round_key UNIQUE (cycle_id, pass, kind)
);

CREATE INDEX IF NOT EXISTS idx_design_bin_requests_cycle
  ON design_bin_requests (cycle_id, pass);
CREATE INDEX IF NOT EXISTS idx_design_bin_requests_kind
  ON design_bin_requests (kind, created_at);
