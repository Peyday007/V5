-- The Postgres half of SQLite migration 067. See that file for why a definition
-- is never an implementation, why nothing canonical arrives without passing
-- through a candidate, and why every canonical statement traces to the source.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 records what its absence costs: three
-- connect tables were created without it and every cursor-ordered query failed
-- on the cloud backend while passing on SQLite.

CREATE TABLE IF NOT EXISTS capability_sources (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  amends_id         TEXT REFERENCES capability_sources(id) ON DELETE RESTRICT,
  version           INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  origin            TEXT NOT NULL,
  privacy_scope     TEXT NOT NULL DEFAULT 'BRAIN_ARCHITECTURE',
  ingest_state      TEXT NOT NULL DEFAULT 'REGISTERED',
  ingest_detail     TEXT,
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  registered_by     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (kind IN ('BLUEPRINT', 'AMENDMENT')),
  CHECK (privacy_scope IN ('BRAIN_ARCHITECTURE', 'PROJECT')),
  CHECK (ingest_state IN ('REGISTERED', 'EXTRACTING', 'PROPOSED', 'AUDITING', 'PROMOTED', 'FAILED')),
  UNIQUE (content_hash, kind)
);
CREATE INDEX IF NOT EXISTS idx_capability_sources_state
  ON capability_sources (ingest_state, created_at);
CREATE INDEX IF NOT EXISTS idx_capability_sources_amends
  ON capability_sources (amends_id);

CREATE TABLE IF NOT EXISTS faculty_candidates (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE CASCADE,
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  slug              TEXT NOT NULL,
  ordinal           INTEGER,
  canonical_name    TEXT NOT NULL,
  definition        TEXT NOT NULL,
  evidence_quote    TEXT NOT NULL,
  evidence_block_id TEXT,
  evidence_page     INTEGER,
  state             TEXT NOT NULL DEFAULT 'PROPOSED',
  rejection_reason  TEXT,
  audit_id          TEXT,
  promoted_faculty_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (state IN ('PROPOSED', 'VALIDATED', 'REJECTED', 'PROMOTED', 'SUPERSEDED')),
  UNIQUE (source_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_faculty_candidates_state
  ON faculty_candidates (state, source_id);

CREATE TABLE IF NOT EXISTS faculties (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  ordinal              INTEGER,
  canonical_name       TEXT NOT NULL,
  definition           TEXT NOT NULL,
  definition_state     TEXT NOT NULL DEFAULT 'MISSING',
  contract_state       TEXT NOT NULL DEFAULT 'MISSING',
  implementation_state TEXT NOT NULL DEFAULT 'ABSENT',
  evaluation_state     TEXT NOT NULL DEFAULT 'UNTESTED',
  availability_state   TEXT NOT NULL DEFAULT 'DISABLED',
  freshness_state      TEXT NOT NULL DEFAULT 'CURRENT',
  source_id            TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE RESTRICT,
  candidate_id         TEXT NOT NULL REFERENCES faculty_candidates(id) ON DELETE RESTRICT,
  amended_by_source_id TEXT REFERENCES capability_sources(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  seq                  BIGSERIAL,
  CHECK (definition_state IN ('MISSING', 'DRAFT', 'CANONICAL')),
  CHECK (contract_state IN ('MISSING', 'DRAFT', 'COMPILED')),
  CHECK (implementation_state IN ('ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE')),
  CHECK (evaluation_state IN ('UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN')),
  CHECK (availability_state IN ('DISABLED', 'SHADOW', 'ACTIVE')),
  CHECK (freshness_state IN ('CURRENT', 'NEEDS_REVIEW', 'SUPERSEDED'))
);
CREATE INDEX IF NOT EXISTS idx_faculties_ordinal ON faculties (ordinal);
CREATE INDEX IF NOT EXISTS idx_faculties_implementation
  ON faculties (implementation_state, evaluation_state);

CREATE TABLE IF NOT EXISTS faculty_state_events (
  id           TEXT PRIMARY KEY,
  faculty_id   TEXT NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  dimension    TEXT NOT NULL,
  from_state   TEXT NOT NULL,
  to_state     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  evidence_ref TEXT,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  created_at   TEXT NOT NULL,
  seq          BIGSERIAL,
  CHECK (dimension IN ('DEFINITION', 'CONTRACT', 'IMPLEMENTATION', 'EVALUATION',
                       'AVAILABILITY', 'FRESHNESS'))
);
CREATE INDEX IF NOT EXISTS idx_faculty_state_events_faculty
  ON faculty_state_events (faculty_id, created_at);

CREATE TABLE IF NOT EXISTS faculty_relationships (
  id              TEXT PRIMARY KEY,
  from_faculty_id TEXT NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  to_faculty_id   TEXT REFERENCES faculties(id) ON DELETE CASCADE,
  to_component    TEXT,
  relationship    TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  source_id       TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE RESTRICT,
  created_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (relationship IN (
    'ACTIVATED_BY', 'READS', 'RETRIEVES', 'CONSUMES', 'PRODUCES',
    'PROPOSES_TO', 'VALIDATED_BY', 'PERSISTS_TO', 'DISPATCHES_THROUGH',
    'DELEGATES_TO', 'CONSTRAINED_BY', 'REACTIVATED_BY', 'EVALUATED_BY',
    'IMPLEMENTED_BY', 'LEARNS_FROM')),
  CHECK ((to_faculty_id IS NULL) <> (to_component IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_faculty_relationship_unique
  ON faculty_relationships (from_faculty_id, relationship,
                            COALESCE(to_faculty_id, ''), COALESCE(to_component, ''));
CREATE INDEX IF NOT EXISTS idx_faculty_relationships_to
  ON faculty_relationships (to_faculty_id);
