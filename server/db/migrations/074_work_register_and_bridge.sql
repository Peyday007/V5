-- The work register, and the conversation entrance that feeds it.
--
-- ---------------------------------------------------------------------------
-- Why a register exists at all
-- ---------------------------------------------------------------------------
--
-- Brain already holds every *part* of what it is doing: candidates, missions,
-- packets, campaigns, change requests, faculties, industry rounds, cash
-- opportunities, documents, audits. What it has never held is the thing a
-- person actually asks about — "what is this work, where did it come from, and
-- where has it got to" — because that spans all of them and belongs to none.
--
-- So a workstream is a **join plus an intent**, in the shape §25 already chose
-- for a connected site's record: there is no new orchestration object, no
-- second queue, and no duplicate of anything. A workstream row holds only the
-- two things no derivation could recover — what somebody meant by it, and what
-- it is for — and everything else is a pointer at a row that already exists.
--
-- The state is deliberately **not** a column. §29 and §38 both record what a
-- stored verdict costs: it is stale the moment the thing it waited on arrives,
-- and the page then contradicts the control beside it. So `services/register/`
-- derives the state on the read path from the linked rows, and this schema
-- holds no `state` anywhere.
--
-- What it does hold is `purpose`, because "does this pursue money" is a
-- judgment about intent rather than a fact about a row, and no amount of
-- reading the graph recovers it.
--
-- ---------------------------------------------------------------------------
-- Why the bridge is in the same migration
-- ---------------------------------------------------------------------------
--
-- Because a register whose sources cannot reach it is a register of whatever
-- somebody remembered to type. The bridge is the entrance: a conversation held
-- somewhere else arrives here exactly as it was said, keeps its order, and
-- becomes a source a workstream can point at.

-- ---------------------------------------------------------------------------
-- THE REGISTER
-- ---------------------------------------------------------------------------

CREATE TABLE workstreams (
  id                 TEXT PRIMARY KEY,

  -- Nullable on purpose, exactly as `russell_conversations.project_id` is.
  -- Some work is Brain-wide — the factory itself, the fleet, this register —
  -- and forcing it under one project would file it under the wrong heading,
  -- which is §11's rule about a project-wide source one altitude up.
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,

  title              TEXT NOT NULL,

  -- What this is *for*, in the words of whoever asked. Not a summary Brain
  -- composed: an intended outcome is the one thing a later reader cannot
  -- re-derive from the rows, and a paraphrase of it would eventually be a
  -- paraphrase of something else.
  intent             TEXT NOT NULL,

  -- The owner's question is "what is pursuing money?", so this is a stored
  -- answer rather than a derived one. Four values and no fifth: a workstream
  -- that is none of these is one nobody can say why they are doing.
  purpose            TEXT NOT NULL,

  -- A person's decision to stop caring about this. Not a delete: §5 applies to
  -- a register as much as to a run, and an archived workstream keeps its links
  -- so the conversations that fed it still resolve.
  archived_at        TEXT,
  archived_reason    TEXT,

  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  CHECK (purpose IN ('REVENUE_DIRECT','REVENUE_ENABLING','CAPABILITY','LONG_TERM')),
  CHECK ((archived_at IS NULL) = (archived_reason IS NULL))
);

CREATE INDEX idx_workstreams_project ON workstreams (project_id, updated_at);
CREATE INDEX idx_workstreams_purpose ON workstreams (purpose, updated_at);

-- What a workstream is made of.
--
-- Many-to-many in both directions, which is the requirement rather than a
-- convenience: one conversation can contribute to several workstreams and
-- several conversations can describe one. So this is its own table and neither
-- side carries a foreign key to the other.
--
-- `ref` is deliberately untyped as far as the database is concerned. A link to
-- a `russell_candidates` row and a link to a pull request URL are the same
-- shape to a reader, and a column per kind would be a schema change every time
-- the graph grew a node. What keeps it honest is that `kind` is a closed set
-- and `services/register/resolve.ts` is the only thing that turns one into a
-- reading.
CREATE TABLE workstream_links (
  id             TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,

  kind           TEXT NOT NULL,
  ref            TEXT NOT NULL,

  -- What it is, in words, captured when the link was made. A label is a
  -- convenience for a reader and is never what a resolution is built from —
  -- the row behind `ref` is.
  label          TEXT,

  -- How this piece relates. A source is where the work came from; a pursuit is
  -- what is being done about it; evidence is what says it happened.
  relation       TEXT NOT NULL,

  detail         TEXT NOT NULL DEFAULT '{}',

  -- Who said so. A link Brain derived and a link a person asserted are
  -- different facts with different weight, and collapsing them would make the
  -- register unable to say which of its own statements were checked.
  recorded_by    TEXT NOT NULL,
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- A correction keeps the row it corrects. §17 again: no new evidence
  -- silently overwriting old evidence.
  superseded_at  TEXT,
  superseded_reason TEXT,

  created_at     TEXT NOT NULL,

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

-- One live link per (workstream, kind, ref, relation). A superseded row keeps
-- its place in history and stops competing, which is why the index is partial
-- rather than a plain UNIQUE.
CREATE UNIQUE INDEX idx_workstream_links_live
  ON workstream_links (workstream_id, kind, ref, relation)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_workstream_links_ref ON workstream_links (kind, ref);
CREATE INDEX idx_workstream_links_workstream ON workstream_links (workstream_id, created_at);

-- Append-only. What happened to this workstream, in order, with who did it.
CREATE TABLE workstream_events (
  id             TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '{}',
  -- Whose authority, and how it got in. §23's column pair: attribution is not
  -- authentication, and a register that could not tell a browser approval from
  -- a terminal command would be unable to say so afterwards.
  actor_ref      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_workstream_events_stream ON workstream_events (workstream_id, created_at);

-- ---------------------------------------------------------------------------
-- THE CONVERSATION ENTRANCE
-- ---------------------------------------------------------------------------

-- A credential a person's conversation client presents.
--
-- It is not a worker credential and must never become one. §22's whole split
-- rests on a token resolving to the *worker*; this resolves to the **person**,
-- and the two are kept apart by having separate tables, separate markers
-- (`brnc_` against `brnw_`/`brnt_`) and separate authentication branches. A
-- row here can no more name a worker than a row in `worker_credentials` can
-- name a user — there is no column for it.
--
-- Why a bearer at all, when a person already authenticates with a cookie: a
-- conversation client is not a browser. It has no cookie jar, it posts JSON
-- cross-origin, and a cookie on that surface is the CSRF hole §21 refuses at
-- `/mcp` for the same reason.
CREATE TABLE bridge_credentials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- What this credential is for, shown to the person. A label, never a scope.
  label          TEXT NOT NULL,

  -- Indexed so authentication is one lookup rather than a scan that verifies
  -- every credential in the table.
  prefix         TEXT NOT NULL UNIQUE,
  verifier       TEXT NOT NULL,

  issued_at      TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT,
  last_used_at   TEXT,

  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX idx_bridge_credentials_user ON bridge_credentials (user_id, issued_at);

-- One conversation held somewhere else.
--
-- `external_id` is the only thing here the caller supplies, and it is scoped by
-- the owner and the source — so it identifies *their own* conversation and can
-- never resolve somebody else's. That is §20's rule read precisely: the scope
-- is server-controlled, and what the caller names is the operation inside it.
CREATE TABLE bridge_conversations (
  id                      TEXT PRIMARY KEY,
  owner_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  source                  TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  title                   TEXT NOT NULL,

  -- The durable Brain conversation this is. One per external conversation, so
  -- a person following a link from their chat client lands on the thread
  -- Russell has been reasoning about rather than a copy of it.
  russell_conversation_id TEXT NOT NULL REFERENCES russell_conversations(id) ON DELETE CASCADE,

  -- The last ordinal this Brain has actually seen. A client that starts at 40
  -- is telling Brain the first 39 are missing, and the receipt says so rather
  -- than pretending the transcript is complete.
  highest_ordinal         INTEGER NOT NULL DEFAULT -1,
  message_count           INTEGER NOT NULL DEFAULT 0,

  last_sync_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,

  CHECK (source IN ('CHATGPT','CLAUDE','OTHER','IMPORT')),
  UNIQUE (owner_user_id, source, external_id),
  UNIQUE (russell_conversation_id)
);
CREATE INDEX idx_bridge_conversations_owner ON bridge_conversations (owner_user_id, updated_at);

-- Exactly what arrived, in the order it was said.
--
-- Three properties this table exists for, none of which `russell_messages`
-- could provide:
--
--   * **Exactness.** The content is stored verbatim, with the hash of it beside
--     it. Nothing here normalizes, trims or reformats — a transcript that was
--     tidied on the way in is not the transcript.
--   * **Order.** `ordinal` is the client's own position in the conversation, so
--     out-of-order delivery is reordered rather than appended, and a hole is
--     visible as a hole.
--   * **Edits.** A message whose content changed under the same external id
--     becomes a new `revision` and the previous one is marked superseded, kept.
--     §17 once more: no new evidence silently overwriting old evidence.
--
-- The role vocabulary is the transcript's, not Russell's. `russell_messages`
-- may only say USER, RUSSELL or SYSTEM, and writing another model's turn as
-- RUSSELL would be attributing words to Russell that Russell did not say.
CREATE TABLE bridge_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,

  ordinal         INTEGER NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,

  -- The client's own id for this turn, when it has one. Null is ordinary: a
  -- pasted export often has positions and no ids, and the ordinal is then the
  -- whole of the identity.
  external_id     TEXT,

  role            TEXT NOT NULL,
  author_label    TEXT,

  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,

  -- When the client says it was said, and when this Brain received it. Two
  -- different facts, and a register that reported the second as the first
  -- would date an imported conversation to the moment of the import.
  said_at         TEXT,
  received_at     TEXT NOT NULL,

  superseded_at   TEXT,

  -- Set when two revisions of one position disagree and neither supersedes the
  -- other by id — a branched conversation, which is a real shape and must be
  -- reported rather than resolved by picking one.
  branch_note     TEXT,

  CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL','UNKNOWN'))
);

CREATE UNIQUE INDEX idx_bridge_messages_position
  ON bridge_messages (conversation_id, ordinal, revision);
CREATE INDEX idx_bridge_messages_live
  ON bridge_messages (conversation_id, ordinal)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_bridge_messages_hash ON bridge_messages (conversation_id, content_hash);

-- What one synchronization did, kept so a client that lost the reply can ask
-- again and be told the same thing.
--
-- `request_key` is the idempotency scope, built the way §20 requires: the
-- credential's owner, the conversation Brain resolved, and a fingerprint of
-- the batch — never anything that changes between two attempts at the same
-- delivery.
CREATE TABLE bridge_sync_receipts (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,
  request_key     TEXT NOT NULL UNIQUE,

  accepted        INTEGER NOT NULL DEFAULT 0,
  duplicates      INTEGER NOT NULL DEFAULT 0,
  revisions       INTEGER NOT NULL DEFAULT 0,
  branches        INTEGER NOT NULL DEFAULT 0,

  first_ordinal   INTEGER,
  last_ordinal    INTEGER,

  -- The positions this Brain has never been given, as JSON. A receipt that
  -- reported only what arrived would let a client believe a partial transcript
  -- was the whole of it.
  missing         TEXT NOT NULL DEFAULT '[]',

  -- What Brain did about the transcript afterwards: the turn it opened, the
  -- request it captured, or the reason it did neither.
  routing         TEXT NOT NULL DEFAULT '{}',

  created_at      TEXT NOT NULL
);
CREATE INDEX idx_bridge_receipts_conversation ON bridge_sync_receipts (conversation_id, created_at);
