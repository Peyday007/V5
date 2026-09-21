-- The Postgres half of SQLite migration 082. See that file for why a workstream
-- is a join plus an intent, why no state is stored, why the bridge keeps its
-- own message table rather than writing another model's turns as Russell's,
-- and why a bridge credential can never name a worker.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS workstreams (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  intent             TEXT NOT NULL,
  purpose            TEXT NOT NULL,
  archived_at        TEXT,
  archived_reason    TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (purpose IN ('REVENUE_DIRECT','REVENUE_ENABLING','CAPABILITY','LONG_TERM')),
  CHECK ((archived_at IS NULL) = (archived_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_workstreams_project ON workstreams (project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_workstreams_purpose ON workstreams (purpose, updated_at);

CREATE TABLE IF NOT EXISTS workstream_links (
  id                  TEXT PRIMARY KEY,
  workstream_id       TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  ref                 TEXT NOT NULL,
  label               TEXT,
  relation            TEXT NOT NULL,
  detail              TEXT NOT NULL DEFAULT '{}',
  recorded_by         TEXT NOT NULL,
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  superseded_at       TEXT,
  superseded_reason   TEXT,
  created_at          TEXT NOT NULL,
  seq                 BIGSERIAL,
  CHECK (kind IN (
    'CONVERSATION','BRIDGE_CONVERSATION','PASSAGE',
    'CANDIDATE','MISSION','PACKET','DOCUMENT','AUDIT',
    'CHANGE_REQUEST','CAMPAIGN','BRANCH','PULL_REQUEST','DEPLOY',
    'FACULTY','INDUSTRY_NODE','OPPORTUNITY','HUMAN_REQUEST','WORKSTREAM'
  )),
  CHECK (relation IN ('SOURCE','PURSUES','EVIDENCE','DEPENDS_ON','SUPERSEDES')),
  CHECK (recorded_by IN ('BRAIN','PERSON')),
  CHECK ((superseded_at IS NULL) = (superseded_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workstream_links_live
  ON workstream_links (workstream_id, kind, ref, relation)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workstream_links_ref ON workstream_links (kind, ref);
CREATE INDEX IF NOT EXISTS idx_workstream_links_workstream
  ON workstream_links (workstream_id, created_at);

CREATE TABLE IF NOT EXISTS workstream_events (
  id            TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  actor_ref     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  seq           BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_workstream_events_stream
  ON workstream_events (workstream_id, created_at);

CREATE TABLE IF NOT EXISTS bridge_credentials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  prefix         TEXT NOT NULL UNIQUE,
  verifier       TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT,
  last_used_at   TEXT,
  seq            BIGSERIAL,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_bridge_credentials_user ON bridge_credentials (user_id, issued_at);

CREATE TABLE IF NOT EXISTS bridge_conversations (
  id                      TEXT PRIMARY KEY,
  owner_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source                  TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  title                   TEXT NOT NULL,
  russell_conversation_id TEXT NOT NULL REFERENCES russell_conversations(id) ON DELETE CASCADE,
  highest_ordinal         INTEGER NOT NULL DEFAULT -1,
  message_count           INTEGER NOT NULL DEFAULT 0,
  last_sync_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  seq                     BIGSERIAL,
  CHECK (source IN ('CHATGPT','CLAUDE','OTHER','IMPORT')),
  UNIQUE (owner_user_id, source, external_id),
  UNIQUE (russell_conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_bridge_conversations_owner
  ON bridge_conversations (owner_user_id, updated_at);

CREATE TABLE IF NOT EXISTS bridge_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  external_id     TEXT,
  role            TEXT NOT NULL,
  author_label    TEXT,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  said_at         TEXT,
  received_at     TEXT NOT NULL,
  superseded_at   TEXT,
  branch_note     TEXT,
  seq             BIGSERIAL,
  CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL','UNKNOWN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_messages_position
  ON bridge_messages (conversation_id, ordinal, revision);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_live
  ON bridge_messages (conversation_id, ordinal)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bridge_messages_hash
  ON bridge_messages (conversation_id, content_hash);

CREATE TABLE IF NOT EXISTS bridge_sync_receipts (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,
  request_key     TEXT NOT NULL UNIQUE,
  accepted        INTEGER NOT NULL DEFAULT 0,
  duplicates      INTEGER NOT NULL DEFAULT 0,
  revisions       INTEGER NOT NULL DEFAULT 0,
  branches        INTEGER NOT NULL DEFAULT 0,
  first_ordinal   INTEGER,
  last_ordinal    INTEGER,
  missing         TEXT NOT NULL DEFAULT '[]',
  routing         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  -- NULL means the delivery this receipt reserved never finished. See the
  -- SQLite file for why the reservation is taken before the writes and why a
  -- retry carries on rather than replaying.
  completed_at    TEXT,
  seq             BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_bridge_receipts_conversation
  ON bridge_sync_receipts (conversation_id, created_at);
