-- The Postgres half of 019_worker_invitations.sql. See that file for the
-- reasoning. The unique index is named explicitly, as everywhere in this chain.
CREATE TABLE worker_invitations (
  id                   TEXT PRIMARY KEY,
  worker_id            TEXT NOT NULL,
  token_prefix         TEXT NOT NULL,
  token_digest         TEXT NOT NULL,
  created_by_user_id   TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  redeemed_at          TEXT,
  revoked_at           TEXT,
  note                 TEXT
);

CREATE UNIQUE INDEX uq_worker_invitations_token_prefix ON worker_invitations (token_prefix);
CREATE INDEX idx_worker_invitations_worker ON worker_invitations (worker_id);
