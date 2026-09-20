-- The Postgres half of SQLite migration 071. See that file for why a packet is
-- a living state object rather than a generated report, and why a gap records
-- whether its classification was a reading or a judgement.

CREATE TABLE IF NOT EXISTS realization_packets (
  id              TEXT PRIMARY KEY,
  faculty_id      TEXT NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT,
  state           TEXT NOT NULL DEFAULT 'DRAFT',
  blocker         TEXT,
  scan_id         TEXT,
  campaign_id     TEXT,
  created_by_type TEXT NOT NULL,
  created_by_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (state IN ('DRAFT', 'RESEARCHING', 'READY', 'BUILDING',
                   'EVALUATING', 'REALIZED', 'BLOCKED', 'ABANDONED')),
  UNIQUE (faculty_id, state)
);
CREATE INDEX IF NOT EXISTS idx_realization_packets_state
  ON realization_packets (state, updated_at);

CREATE TABLE IF NOT EXISTS realization_sections (
  id          TEXT PRIMARY KEY,
  packet_id   TEXT NOT NULL REFERENCES realization_packets(id) ON DELETE CASCADE,
  section     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seq         BIGSERIAL,
  CHECK (section IN ('CAPABILITY_MAP', 'CURRENT_STATE', 'TARGET_TOPOLOGY',
                     'INFORMATION_SUPPLY', 'KNOWLEDGE_COMPILATION', 'COGNITIVE_CONTRACT',
                     'IMPLEMENTATION_GAPS', 'FACTORY_DEPENDENCIES', 'EVALUATION_GRAPH',
                     'CAPABILITY_REGISTRATION')),
  CHECK (author_kind IN ('DERIVED', 'PROPOSED', 'ACCEPTED')),
  UNIQUE (packet_id, section, version)
);
CREATE INDEX IF NOT EXISTS idx_realization_sections_current
  ON realization_sections (packet_id, section, version);

CREATE TABLE IF NOT EXISTS realization_gaps (
  id            TEXT PRIMARY KEY,
  packet_id     TEXT NOT NULL REFERENCES realization_packets(id) ON DELETE CASCADE,
  requirement   TEXT NOT NULL,
  aspect        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  derived_by    TEXT NOT NULL,
  component_key TEXT,
  evidence      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OPEN',
  state_reason  TEXT,
  carried_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (kind IN ('EXISTS_AND_LIVE', 'EXISTS_BUT_DISCONNECTED', 'EXISTS_BUT_INSUFFICIENT',
                  'MUST_BE_BUILT', 'MUST_BE_REPLACED', 'MUST_BE_RESEARCHED',
                  'REQUIRES_PERSON_AUTHORITY', 'NEEDS_A_READING')),
  CHECK (derived_by IN ('BRAIN', 'WORKER', 'PERSON')),
  CHECK (state IN ('OPEN', 'ASSIGNED', 'CLOSED', 'WAIVED')),
  UNIQUE (packet_id, aspect, requirement)
);
CREATE INDEX IF NOT EXISTS idx_realization_gaps_state
  ON realization_gaps (packet_id, state, kind);
