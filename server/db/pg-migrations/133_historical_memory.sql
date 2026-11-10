-- The Postgres half of SQLite migration 142. Same tables; REAL is DOUBLE PRECISION here.
-- ---------------------------------------------------------------------------
-- HISTORICAL MEMORY: RECOVERY, ORGANIZATION AND REDISCOVERY
--
-- A person's whole conversation history — a ChatGPT export, a ChatGPTExporter
-- archive, and every conversation the bridge has synced since — kept as an
-- immutable original record, indexed into passages, organized into topics the
-- material itself suggests, excavated into a registry of ideas and goals, and
-- brought back to the person when something makes an old idea worth a look.
-- docs/HISTORICAL-MEMORY.md is the design.
--
-- Three layers, never mixed:
--
--   * ORIGINAL   memory_archives, memory_archive_entries, memory_conversations,
--                memory_conversation_versions, memory_messages,
--                memory_attachments. What arrived, exactly; a changed
--                conversation is a new version and the old one is kept.
--   * DERIVED    memory_passages, memory_topics, memory_topic_members. Rebuilt
--                deterministically from the original layer; never a source.
--   * DECIDED    memory_ideas (+ versions, evidence, links), memory_discoveries,
--                memory_decisions, memory_hubs, memory_circumstances,
--                memory_practice. Interpretations and the person's decisions,
--                each resolving to passages of the original.
--
-- Everything is scoped to one owner. Nothing here belongs to a project, because
-- a person's history is theirs before it is any project's; a decision that
-- promotes an idea writes into the project it creates or names.
-- ---------------------------------------------------------------------------

CREATE TABLE memory_archives (
  id                     TEXT PRIMARY KEY,
  owner_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                  TEXT NOT NULL,
  source_format          TEXT NOT NULL,
  manifest_hash          TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'RECEIVING',
  declared_conversations INTEGER NOT NULL DEFAULT 0,
  declared_messages      INTEGER NOT NULL DEFAULT 0,
  declared_nodes         INTEGER NOT NULL DEFAULT 0,
  declared_attachments   INTEGER NOT NULL DEFAULT 0,
  declared_files         INTEGER NOT NULL DEFAULT 0,
  notes                  TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  completed_at           TEXT,
  CHECK (source_format IN ('CHATGPT_OFFICIAL','CHATGPT_EXPORTER','CHATGPT_MARKDOWN','BRIDGE','MIXED')),
  CHECK (state IN ('RECEIVING','COMPLETE','ABANDONED')),
  UNIQUE (owner_user_id, manifest_hash)
);
CREATE INDEX idx_memory_archives_owner ON memory_archives (owner_user_id, created_at);

-- One row per conversation the archive declared: the denominator, and the
-- resumable checkpoint. A conversation that arrived is IMPORTED or UNCHANGED;
-- one that failed keeps its error and its attempts; one never sent stays
-- DECLARED, which is exactly "discovered but not recovered".
CREATE TABLE memory_archive_entries (
  archive_id         TEXT NOT NULL REFERENCES memory_archives(id) ON DELETE CASCADE,
  external_id        TEXT NOT NULL,
  title              TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  declared_nodes     INTEGER NOT NULL DEFAULT 0,
  declared_messages  INTEGER NOT NULL DEFAULT 0,
  declared_attachments INTEGER NOT NULL DEFAULT 0,
  source_updated_at  TEXT,
  state              TEXT NOT NULL DEFAULT 'DECLARED',
  conversation_id    TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (archive_id, external_id),
  CHECK (state IN ('DECLARED','IMPORTED','UNCHANGED','FAILED'))
);
CREATE INDEX idx_memory_archive_entries_state ON memory_archive_entries (archive_id, state);

CREATE TABLE memory_conversations (
  id                  TEXT PRIMARY KEY,
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source              TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  title               TEXT NOT NULL,
  source_created_at   TEXT,
  source_updated_at   TEXT,
  project_ref         TEXT,
  project_name        TEXT,
  current_node_id     TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  content_hash        TEXT NOT NULL,
  node_count          INTEGER NOT NULL DEFAULT 0,
  message_count       INTEGER NOT NULL DEFAULT 0,
  branch_point_count  INTEGER NOT NULL DEFAULT 0,
  alternate_message_count INTEGER NOT NULL DEFAULT 0,
  attachment_count    INTEGER NOT NULL DEFAULT 0,
  first_said_at       TEXT,
  last_said_at        TEXT,
  -- Pipeline checkpoints: the version each derived stage last reached. A stage
  -- behind the conversation's version is work; one level with it is done.
  indexed_version     INTEGER NOT NULL DEFAULT 0,
  excavated_version   INTEGER NOT NULL DEFAULT 0,
  -- The conversation's salient terms, JSON, written by indexing and read by
  -- organization so a whole-archive regrouping reads one row per conversation.
  terms               TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (source IN ('CHATGPT','BRIDGE')),
  UNIQUE (owner_user_id, source, external_id)
);
CREATE INDEX idx_memory_conversations_owner ON memory_conversations (owner_user_id, first_said_at);
CREATE INDEX idx_memory_conversations_work ON memory_conversations (owner_user_id, indexed_version, version);

-- Every version of a conversation that ever arrived. The raw object is kept in
-- the document store under raw_key; its hash is here so the bytes can be proved.
CREATE TABLE memory_conversation_versions (
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  archive_id      TEXT,
  raw_key         TEXT,
  raw_bytes       INTEGER NOT NULL DEFAULT 0,
  imported_at     TEXT NOT NULL,
  PRIMARY KEY (conversation_id, version)
);

-- Every node of the conversation tree, including the branches a person did not
-- end on: an edited prompt and a regenerated answer are siblings, and both are
-- the record. on_current_path marks the branch the person last read.
CREATE TABLE memory_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  owner_user_id     TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  parent_node_id    TEXT,
  depth             INTEGER NOT NULL,
  sibling_index     INTEGER NOT NULL DEFAULT 0,
  sibling_count     INTEGER NOT NULL DEFAULT 1,
  on_current_path   INTEGER NOT NULL DEFAULT 0,
  role              TEXT NOT NULL,
  author_name       TEXT,
  recipient         TEXT,
  content_type      TEXT NOT NULL,
  text              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  said_at           TEXT,
  source_updated_at TEXT,
  model_slug        TEXT,
  hidden            INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT NOT NULL DEFAULT '{}',
  first_version     INTEGER NOT NULL,
  superseded_in_version INTEGER,
  created_at        TEXT NOT NULL,
  CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL','UNKNOWN')),
  UNIQUE (conversation_id, node_id, content_hash)
);
CREATE INDEX idx_memory_messages_conversation ON memory_messages (conversation_id, depth, sibling_index);
CREATE INDEX idx_memory_messages_owner_time ON memory_messages (owner_user_id, said_at);

CREATE TABLE memory_attachments (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES memory_messages(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  name            TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  width           INTEGER,
  height          INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'REFERENCED_ONLY',
  storage_key     TEXT,
  byte_hash       TEXT,
  failure         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (kind IN ('IMAGE','FILE','AUDIO','VIDEO','OTHER')),
  CHECK (state IN ('REFERENCED_ONLY','RECOVERED','FAILED')),
  UNIQUE (message_id, source_ref)
);
CREATE INDEX idx_memory_attachments_owner ON memory_attachments (owner_user_id, state);
CREATE INDEX idx_memory_attachments_ref ON memory_attachments (owner_user_id, source_ref);

-- DERIVED: one passage is one paragraph-sized piece of one message, classified
-- deterministically. kinds and facets are space-delimited vocabularies so they
-- can be matched with LIKE '% WORD %' on both backends.
CREATE TABLE memory_passages (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES memory_messages(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  on_current_path INTEGER NOT NULL DEFAULT 1,
  text            TEXT NOT NULL,
  said_at         TEXT,
  kinds           TEXT NOT NULL DEFAULT ' ',
  facets          TEXT NOT NULL DEFAULT ' ',
  terms           TEXT NOT NULL DEFAULT ' ',
  created_at      TEXT NOT NULL,
  UNIQUE (message_id, seq)
);
CREATE INDEX idx_memory_passages_conversation ON memory_passages (conversation_id, said_at);
CREATE INDEX idx_memory_passages_owner_time ON memory_passages (owner_user_id, said_at);

CREATE TABLE memory_topics (
  id                 TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL,
  topic_key          TEXT NOT NULL,
  label              TEXT NOT NULL,
  terms              TEXT NOT NULL DEFAULT '[]',
  parent_topic_id    TEXT,
  state              TEXT NOT NULL DEFAULT 'ACTIVE',
  merged_into_id     TEXT,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  passage_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at      TEXT,
  last_seen_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (state IN ('ACTIVE','MERGED','RETIRED')),
  UNIQUE (owner_user_id, topic_key)
);
CREATE INDEX idx_memory_topics_owner ON memory_topics (owner_user_id, state, conversation_count);

-- Membership is many-to-many: a conversation is in every topic it bears on,
-- and passage_id names the passage that put it there.
CREATE TABLE memory_topic_members (
  topic_id        TEXT NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  passage_id      TEXT,
  score           DOUBLE PRECISION NOT NULL DEFAULT 0,
  said_at         TEXT,
  PRIMARY KEY (topic_id, conversation_id)
);
CREATE INDEX idx_memory_topic_members_conversation ON memory_topic_members (conversation_id);

-- DECIDED: the registry. One row per idea, its identity stable across every
-- re-reading; each interpretation that changed it is a version.
CREATE TABLE memory_ideas (
  id                 TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  statement          TEXT NOT NULL,
  signature          TEXT NOT NULL,
  domain             TEXT,
  state              TEXT NOT NULL DEFAULT 'UNRESOLVED',
  state_basis        TEXT NOT NULL,
  state_passage_id   TEXT,
  owner_state        TEXT,
  first_seen_at      TEXT,
  last_seen_at       TEXT,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  mention_count      INTEGER NOT NULL DEFAULT 0,
  user_words         INTEGER NOT NULL DEFAULT 0,
  cue_strength       DOUBLE PRECISION NOT NULL DEFAULT 0,
  obstacles          TEXT NOT NULL DEFAULT '[]',
  open_questions     TEXT NOT NULL DEFAULT '[]',
  reconsider_when    TEXT NOT NULL DEFAULT '[]',
  next_actions       TEXT NOT NULL DEFAULT '[]',
  owner_intent       TEXT,
  owner_feedback     TEXT,
  parent_idea_id     TEXT,
  superseded_by_id   TEXT,
  hub_id             TEXT,
  project_id         TEXT,
  candidate_id       TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  -- When the history was last reconstructed; NULL or older than the newest
  -- evidence means the idea is due.
  reconstructed_at   TEXT,
  evidence_changed_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (kind IN ('GOAL','BUSINESS','FINANCIAL','CREATIVE','PROJECT','QUESTION','DECISION','AMBITION','PLAN','COMMITMENT','INTEREST')),
  CHECK (state IN ('ACTIVE','COMPLETED','PAUSED','REJECTED','SUPERSEDED','UNRESOLVED')),
  UNIQUE (owner_user_id, signature)
);
CREATE INDEX idx_memory_ideas_owner ON memory_ideas (owner_user_id, state, last_seen_at);

CREATE TABLE memory_idea_versions (
  idea_id    TEXT NOT NULL REFERENCES memory_ideas(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idea_id, version)
);

CREATE TABLE memory_idea_evidence (
  idea_id         TEXT NOT NULL REFERENCES memory_ideas(id) ON DELETE CASCADE,
  passage_id      TEXT NOT NULL REFERENCES memory_passages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  stage           TEXT NOT NULL,
  said_at         TEXT,
  excerpt         TEXT NOT NULL,
  direct          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (idea_id, passage_id),
  CHECK (stage IN ('ORIGIN','DEVELOPMENT','ALTERNATIVE','OBSTACLE','PURSUIT','DIRECTION_CHANGE','PAUSE','REJECTION','COMPLETION','MENTION'))
);
CREATE INDEX idx_memory_idea_evidence_time ON memory_idea_evidence (idea_id, said_at);

CREATE TABLE memory_idea_links (
  idea_id    TEXT NOT NULL REFERENCES memory_ideas(id) ON DELETE CASCADE,
  to_kind    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL,
  basis      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idea_id, to_kind, to_id, relation),
  CHECK (to_kind IN ('IDEA','TOPIC','PROJECT','CANDIDATE','HUB')),
  CHECK (relation IN ('RELATED','CONNECTS','BRANCHED_INTO','PART_OF','SUPERSEDES','IN_TOPIC','PROMOTED_TO'))
);

-- What Brain put in front of the person, and why. At most one OPEN per idea.
-- QUEUED is a triggered finding waiting for room on a full list: kept rather
-- than dropped, surfaced first when a place frees.
CREATE TABLE memory_discoveries (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  idea_id       TEXT NOT NULL REFERENCES memory_ideas(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'OPEN',
  score         DOUBLE PRECISION NOT NULL,
  why_matters   TEXT NOT NULL,
  why_now       TEXT NOT NULL,
  trigger_kind  TEXT NOT NULL,
  trigger_ref   TEXT,
  surfaced_at   TEXT NOT NULL,
  decided_at    TEXT,
  decision      TEXT,
  CHECK (state IN ('OPEN','QUEUED','DECIDED','RETIRED'))
);
CREATE UNIQUE INDEX idx_memory_discoveries_open ON memory_discoveries (idea_id) WHERE state = 'OPEN';
CREATE UNIQUE INDEX idx_memory_discoveries_queued ON memory_discoveries (idea_id) WHERE state = 'QUEUED';
CREATE INDEX idx_memory_discoveries_owner ON memory_discoveries (owner_user_id, state, score);

-- The person's decisions. Append-only.
CREATE TABLE memory_decisions (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL,
  idea_id        TEXT NOT NULL REFERENCES memory_ideas(id) ON DELETE CASCADE,
  discovery_id   TEXT,
  decision       TEXT NOT NULL,
  feedback       TEXT,
  outcome_kind   TEXT,
  outcome_ref    TEXT,
  idea_kind      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  CHECK (decision IN ('EXPLORE','PLAN','CREATE_SECTION','LATER','NOT_INTERESTED','UPDATE_WANT','FEEDBACK'))
);
CREATE INDEX idx_memory_decisions_owner ON memory_decisions (owner_user_id, created_at);

-- Permanent organizational systems proposed from sustained commitment.
CREATE TABLE memory_hubs (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  kind          TEXT NOT NULL,
  topic_key     TEXT NOT NULL,
  title         TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'PROPOSED',
  evidence      TEXT NOT NULL DEFAULT '{}',
  draft_plan    TEXT NOT NULL DEFAULT '',
  project_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (kind IN ('MOVIE_SCHOOL','CREATIVE','ENGINEERING','VENTURE','FINANCE','LEARNING','PERSONAL')),
  CHECK (state IN ('PROPOSED','PREPARED','ACCEPTED','DECLINED')),
  UNIQUE (owner_user_id, topic_key)
);

-- Changes in circumstance that can make an old idea newly worth a look.
CREATE TABLE memory_circumstances (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  kind          TEXT NOT NULL,
  statement     TEXT NOT NULL,
  terms         TEXT NOT NULL DEFAULT ' ',
  source        TEXT NOT NULL,
  source_ref    TEXT,
  observed_at   TEXT NOT NULL,
  applied_at    TEXT,
  CHECK (kind IN ('CAPABILITY','CAPITAL','PRIORITY','OBSTACLE_REMOVED','OPPORTUNITY','FEASIBILITY')),
  CHECK (source IN ('PERSON','BRAIN')),
  UNIQUE (owner_user_id, source, source_ref)
);

-- Movie School's future: learning, practice and assessment, kept apart from
-- the historical archive so nothing historical is read as mastery.
CREATE TABLE memory_practice (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  hub_id        TEXT NOT NULL REFERENCES memory_hubs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'OPEN',
  basis_idea_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (kind IN ('OBJECTIVE','EXERCISE','ASSESSMENT')),
  CHECK (state IN ('OPEN','DONE','DROPPED'))
);

-- Append-only history of everything above that moved.
CREATE TABLE memory_events (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_memory_events_owner ON memory_events (owner_user_id, created_at);

-- Watermarks for whole-archive stages (organization, reevaluation).
CREATE TABLE memory_cursors (
  owner_user_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, name)
);
