-- ---------------------------------------------------------------------------
-- THE SELF-EXPANSION KERNEL: SOURCES, FACULTIES, AND THE SELF-MODEL
--
-- Brain is told what it should be able to do by a blueprint somebody wrote, and
-- until now it had nowhere to put that. This migration is the minimum state
-- that lets Brain hold a capability definition, say honestly how far it has got
-- with it, and tell the difference between a sentence in a document and a
-- mechanism that runs.
--
-- Three rules decided every column below.
--
-- 1. A DEFINITION IS NEVER AN IMPLEMENTATION. The single most tempting mistake
--    here is one `status` column that walks from "we wrote it down" to "it
--    works". It would be wrong at every intermediate value and nobody could say
--    which part was wrong. So there are six independent dimensions and no
--    aggregate: ingesting a blueprint may move `definition_state` and may not
--    move any of the other five.
--
-- 2. NOTHING CANONICAL ARRIVES WITHOUT PASSING THROUGH A CANDIDATE. A worker
--    reads the source and proposes; `faculty_candidates` is where a proposal
--    waits; deterministic validation and an independent audit are what move one
--    across. There is no path that writes `faculties` from model output, which
--    is CLAUDE.md §8 at a new table.
--
-- 3. EVERY CANONICAL STATEMENT TRACES TO THE SOURCE. A faculty carries the
--    source it came from and the extraction block its evidence was anchored in,
--    so "the blueprint says so" is a fact about the document rather than a
--    claim about it. A candidate whose quote cannot be located in the extracted
--    text is refused, the same way `findings.ts` already refuses one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- THE SOURCE ARTIFACT
--
-- The bytes are a `documents` row and its stored object, because §4 says a file
-- is not a document until it has one and this table must not become a second
-- place the truth lives. What is here is what a document row cannot carry: that
-- this document is a capability blueprint, which blueprint it amends, and how
-- far its ingestion has got.
--
-- `amends_id` is how the clarification to Faculty 14 is preserved without
-- rewriting the original. The blueprint keeps its bytes and its hash; the
-- amendment is its own registered source pointing at it. Nothing edits a source
-- in place, and a promotion records which of the two it read.
-- ---------------------------------------------------------------------------
CREATE TABLE capability_sources (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('BLUEPRINT', 'AMENDMENT')),
  title             TEXT NOT NULL,
  -- The registered document holding the bytes. RESTRICT rather than CASCADE: a
  -- source whose document vanished is INCONSISTENT STATE to be reported, never
  -- a row that quietly disappears with it.
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  -- NULL for a blueprint; the blueprint it clarifies for an amendment.
  amends_id         TEXT REFERENCES capability_sources(id) ON DELETE RESTRICT,
  -- Monotonic per lineage, so two registrations of the same file are ordered.
  version           INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  -- Where this came from, in the words of whoever supplied it. Provenance, not
  -- an address Brain resolves.
  origin            TEXT NOT NULL,
  -- BRAIN_ARCHITECTURE is knowledge about Brain itself and is readable by any
  -- authenticated person, the same boundary §31 draws for a shared finding.
  privacy_scope     TEXT NOT NULL DEFAULT 'BRAIN_ARCHITECTURE'
                      CHECK (privacy_scope IN ('BRAIN_ARCHITECTURE', 'PROJECT')),
  ingest_state      TEXT NOT NULL DEFAULT 'REGISTERED'
                      CHECK (ingest_state IN (
                        'REGISTERED', 'EXTRACTING', 'PROPOSED', 'AUDITING',
                        'PROMOTED', 'FAILED')),
  ingest_detail     TEXT,
  -- The bin carrying the extraction assignment, once one exists.
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  registered_by     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- One registration per (lineage, hash): re-registering identical bytes is the
  -- same source rather than a second one, and changed bytes are a new version.
  UNIQUE (content_hash, kind)
);
CREATE INDEX idx_capability_sources_state ON capability_sources (ingest_state, created_at);
CREATE INDEX idx_capability_sources_amends ON capability_sources (amends_id);

-- ---------------------------------------------------------------------------
-- A PROPOSED DEFINITION
--
-- What a worker that read the source came back with, before anything believes
-- it. Isolated by construction: no reader of `faculties` sees this table, and
-- the only way across is `promoteCandidate`, which requires a completed
-- independent audit.
--
-- `evidence_quote` and `evidence_block_id` are what make the promotion
-- checkable. The quote must be locatable in the document's own extracted text;
-- the block id is where Brain found it, never where the model said it was.
-- ---------------------------------------------------------------------------
CREATE TABLE faculty_candidates (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE CASCADE,
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  -- The slug the blueprint's own numbering implies, e.g. RESEARCH_INTELLIGENCE.
  slug              TEXT NOT NULL,
  ordinal           INTEGER,
  canonical_name    TEXT NOT NULL,
  -- The whole proposed definition, as one validated JSON object. One column
  -- rather than twenty, because a candidate is refused or promoted whole and a
  -- half-stored proposal is worse than none.
  definition        TEXT NOT NULL,
  evidence_quote    TEXT NOT NULL,
  evidence_block_id TEXT,
  evidence_page     INTEGER,
  state             TEXT NOT NULL DEFAULT 'PROPOSED'
                      CHECK (state IN ('PROPOSED', 'VALIDATED', 'REJECTED', 'PROMOTED', 'SUPERSEDED')),
  -- Kept forever on a rejection. A candidate that vanished would make a
  -- coverage gap look like something nobody proposed.
  rejection_reason  TEXT,
  audit_id          TEXT,
  promoted_faculty_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source_id, slug)
);
CREATE INDEX idx_faculty_candidates_state ON faculty_candidates (state, source_id);

-- ---------------------------------------------------------------------------
-- THE CANONICAL FACULTY
--
-- Six state dimensions and deliberately no seventh that aggregates them. Each
-- one is moved by a different kind of evidence, and each one has a different
-- remedy when it is behind:
--
--   definition_state    what the blueprint says        moved by ingestion
--   contract_state      the cognitive contract         moved by compilation
--   implementation_state whether code exists and runs  moved by the Factory
--   evaluation_state    whether it was proved          moved by evaluation
--   availability_state  whether it is switched on      moved by a person
--   freshness_state     whether the source moved       moved by a new version
--
-- Ingesting a blueprint may only ever move the first. That is asserted by a
-- test rather than only stated here, because it is the property the whole
-- registry exists to keep: a Brain that read a document about Research
-- Intelligence and then reported Research Intelligence as implemented would be
-- lying in the most expensive available direction.
-- ---------------------------------------------------------------------------
CREATE TABLE faculties (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  ordinal              INTEGER,
  canonical_name       TEXT NOT NULL,
  -- The definition as promoted. Same shape as a candidate's.
  definition           TEXT NOT NULL,

  definition_state     TEXT NOT NULL DEFAULT 'MISSING'
                         CHECK (definition_state IN ('MISSING', 'DRAFT', 'CANONICAL')),
  contract_state       TEXT NOT NULL DEFAULT 'MISSING'
                         CHECK (contract_state IN ('MISSING', 'DRAFT', 'COMPILED')),
  implementation_state TEXT NOT NULL DEFAULT 'ABSENT'
                         CHECK (implementation_state IN ('ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE')),
  evaluation_state     TEXT NOT NULL DEFAULT 'UNTESTED'
                         CHECK (evaluation_state IN ('UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN')),
  availability_state   TEXT NOT NULL DEFAULT 'DISABLED'
                         CHECK (availability_state IN ('DISABLED', 'SHADOW', 'ACTIVE')),
  freshness_state      TEXT NOT NULL DEFAULT 'CURRENT'
                         CHECK (freshness_state IN ('CURRENT', 'NEEDS_REVIEW', 'SUPERSEDED')),

  -- Which registered source this definition came from, and which candidate
  -- carried it. Both, because the second is how the evidence quote is reached.
  source_id            TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE RESTRICT,
  candidate_id         TEXT NOT NULL REFERENCES faculty_candidates(id) ON DELETE RESTRICT,
  -- The amendment that last changed this definition, when one did.
  amended_by_source_id TEXT REFERENCES capability_sources(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_faculties_ordinal ON faculties (ordinal);
CREATE INDEX idx_faculties_implementation ON faculties (implementation_state, evaluation_state);

-- ---------------------------------------------------------------------------
-- WHY A DIMENSION MOVED
--
-- Append-only. A registry that only holds current values cannot answer "when
-- did Brain start believing this was implemented, and on what", which is the
-- question somebody asks the first time a dimension is wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE faculty_state_events (
  id           TEXT PRIMARY KEY,
  faculty_id   TEXT NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  dimension    TEXT NOT NULL CHECK (dimension IN (
                 'DEFINITION', 'CONTRACT', 'IMPLEMENTATION', 'EVALUATION',
                 'AVAILABILITY', 'FRESHNESS')),
  from_state   TEXT NOT NULL,
  to_state     TEXT NOT NULL,
  -- What moved it, in words, plus the row that is the evidence.
  reason       TEXT NOT NULL,
  evidence_ref TEXT,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_faculty_state_events_faculty ON faculty_state_events (faculty_id, created_at);

-- ---------------------------------------------------------------------------
-- TYPED RELATIONSHIPS BETWEEN FACULTIES AND THE INFRASTRUCTURE
--
-- The blueprint's connection matrix, as edges rather than prose. The endpoints
-- are deliberately loose — a faculty, or a named component of the self-model —
-- because half the useful edges point at machinery rather than at another
-- faculty (a faculty DISPATCHES_THROUGH the runtime, PERSISTS_TO a repository).
--
-- The relationship vocabulary is a CHECK rather than free text, so a worker
-- proposing an edge type nobody implemented is refused at the write rather than
-- discovered by a reader who cannot interpret it.
-- ---------------------------------------------------------------------------
CREATE TABLE faculty_relationships (
  id            TEXT PRIMARY KEY,
  from_faculty_id TEXT NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  -- Exactly one of these is set, enforced below.
  to_faculty_id TEXT REFERENCES faculties(id) ON DELETE CASCADE,
  to_component  TEXT,
  relationship  TEXT NOT NULL CHECK (relationship IN (
                  'ACTIVATED_BY', 'READS', 'RETRIEVES', 'CONSUMES', 'PRODUCES',
                  'PROPOSES_TO', 'VALIDATED_BY', 'PERSISTS_TO', 'DISPATCHES_THROUGH',
                  'DELEGATES_TO', 'CONSTRAINED_BY', 'REACTIVATED_BY', 'EVALUATED_BY',
                  'IMPLEMENTED_BY', 'LEARNS_FROM')),
  rationale     TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES capability_sources(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL,
  CHECK ((to_faculty_id IS NULL) <> (to_component IS NULL))
);
CREATE UNIQUE INDEX idx_faculty_relationship_unique
  ON faculty_relationships (from_faculty_id, relationship,
                            COALESCE(to_faculty_id, ''), COALESCE(to_component, ''));
CREATE INDEX idx_faculty_relationships_to ON faculty_relationships (to_faculty_id);
