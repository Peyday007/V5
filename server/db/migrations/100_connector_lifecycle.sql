-- The connector lifecycle: a refresh is a state, a connector is an identity.
--
-- oauth_tokens gains three facts the rotation could not record before:
--
--   grant_id        the authorization every token descends from, so a lineage
--                   question ("was anything newer than this used?") is one read
--                   rather than a walk of parent pointers.
--   revoked_reason  ROTATED (the refresh token was presented and replaced),
--                   SUPERSEDED (a recovery replaced it), EXPLICIT (a person, a
--                   disabled worker, a withdrawn grant). "Revoked" alone could not
--                   tell a lost reply from a withdrawn consent.
--   first_used_at   when a token was first presented as a bearer. last_used_at
--                   moves; whether a successor has been *in use* for longer than a
--                   race takes is a question about the first use.
--
-- connectors is the logical identity of one Claude connector: one Claude account
-- (fleet_accounts) at one Brain endpoint. Claude refuses a second custom connector
-- at a URL one already holds, so (account, endpoint) names exactly one connector,
-- however many OAuth clients a reconnect leaves behind it. connector_clients keeps
-- every client that was ever that connector, with the evidence that made it so.
CREATE TABLE connectors (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  resource    TEXT NOT NULL,
  worker_id   TEXT,
  label       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (account_id, resource)
);

CREATE TABLE connector_clients (
  client_id     TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  source        TEXT NOT NULL
    CHECK (source IN ('OBSERVED_ARRIVAL', 'INVITATION_MEMBER', 'BOUND_INVITATION', 'OPERATOR')),
  evidence      TEXT,
  attached_at   TEXT NOT NULL
);

CREATE INDEX idx_connector_clients_connector ON connector_clients (connector_id, attached_at);

-- One server-held key for deriving a refresh token's successor. It is not a
-- credential and recovers none: a successor can be derived only by somebody who
-- presents the token it replaces, whose secret Brain never stored.
CREATE TABLE oauth_rotation_keys (
  id          TEXT PRIMARY KEY,
  key_hex     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

ALTER TABLE oauth_tokens ADD COLUMN grant_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN revoked_reason TEXT;
ALTER TABLE oauth_tokens ADD COLUMN first_used_at TEXT;
ALTER TABLE fleet_routines ADD COLUMN connector_id TEXT;
ALTER TABLE worker_invitations ADD COLUMN connector_id TEXT;

-- Indexes first: the backfill below looks tokens up by parent and by grant,
-- and without them each correlated lookup is a scan of the whole table.
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens (grant_id, created_at);
CREATE INDEX idx_oauth_tokens_parent ON oauth_tokens (parent_token_id);
CREATE INDEX idx_oauth_tokens_client ON oauth_tokens (client_id, kind, created_at);

-- The grant of every refresh token is the root of its parent chain.
WITH RECURSIVE chain(id, root) AS (
  SELECT id, id FROM oauth_tokens WHERE kind = 'REFRESH' AND parent_token_id IS NULL
  UNION ALL
  SELECT t.id, chain.root FROM oauth_tokens t JOIN chain ON t.parent_token_id = chain.id
   WHERE t.kind = 'REFRESH'
)
UPDATE oauth_tokens
   SET grant_id = chain.root
  FROM chain
 WHERE chain.id = oauth_tokens.id AND oauth_tokens.kind = 'REFRESH';

UPDATE oauth_tokens
   SET grant_id = (SELECT p.grant_id FROM oauth_tokens p WHERE p.id = oauth_tokens.parent_token_id)
 WHERE kind = 'ACCESS';

-- A revoked refresh token that has a successor was rotated; one that was retired
-- by the old lost-reply recovery has none and was superseded rather than withdrawn
-- when a sibling with the same parent exists. Anything else was explicit.
UPDATE oauth_tokens
   SET revoked_reason = CASE
     WHEN EXISTS (SELECT 1 FROM oauth_tokens c WHERE c.parent_token_id = oauth_tokens.id AND c.kind = 'REFRESH')
       THEN 'ROTATED'
     WHEN oauth_tokens.parent_token_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM oauth_tokens s
             WHERE s.parent_token_id = oauth_tokens.parent_token_id AND s.kind = 'REFRESH'
               AND s.id <> oauth_tokens.id AND s.created_at > oauth_tokens.created_at)
       THEN 'SUPERSEDED'
     ELSE 'EXPLICIT' END
 WHERE kind = 'REFRESH' AND revoked_at IS NOT NULL;

-- An access token revoked in the same instant as its refresh token's rotation
-- went with that rotation.
UPDATE oauth_tokens
   SET revoked_reason = CASE
     WHEN EXISTS (SELECT 1 FROM oauth_tokens p
                   WHERE p.id = oauth_tokens.parent_token_id
                     AND p.revoked_at = oauth_tokens.revoked_at
                     AND p.revoked_reason IN ('ROTATED', 'SUPERSEDED'))
       THEN 'ROTATED'
     ELSE 'EXPLICIT' END
 WHERE kind = 'ACCESS' AND revoked_at IS NOT NULL;

-- The best record of a first use is the last one; it is later than the truth,
-- which only ever makes an in-flight chain more forgiving, never less.
-- The earliest a used token can have been first used is its creation, which is
-- the strict direction: backfilling last_used_at would reopen the race leeway
-- for every long-used successor for five minutes after the migration.
UPDATE oauth_tokens SET first_used_at = created_at WHERE last_used_at IS NOT NULL;

