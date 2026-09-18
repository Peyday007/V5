-- ---------------------------------------------------------------------------
-- REALIZING A CAPABILITY: THE PACKET, ITS SECTIONS, AND THE GAPS
--
-- A faculty registry says what Brain should be able to do. A self-model says
-- what it currently is. This is the thing that holds one against the other and
-- survives long enough to be acted on.
--
-- ---------------------------------------------------------------------------
-- A living state object, not a generated report
-- ---------------------------------------------------------------------------
--
-- The tempting shape is one document per faculty, regenerated whenever anything
-- changes. It is wrong for a reason this codebase has met before: a regenerated
-- artifact has no history, so "when did Brain decide this had to be built" and
-- "what did it think before the research came back" are both unanswerable — and
-- those are the two questions somebody asks when a realization goes wrong.
--
-- So a packet is a row, its ten sections are versioned rows beside it, and the
-- current packet is the newest version of each section. Nothing is overwritten.
--
-- ---------------------------------------------------------------------------
-- A gap says who derived it
-- ---------------------------------------------------------------------------
--
-- Some gap classifications are readings: a component the definition names that
-- the self-model says exists and is not connected is `EXISTS_BUT_DISCONNECTED`,
-- and no judgement is involved. Others — whether an existing component is
-- *sufficient*, whether something should be replaced rather than extended — are
-- judgements a reader has to make, and Brain deriving them would be model
-- output deciding what gets built.
--
-- `derived_by` is that distinction as a column, and `NEEDS_A_READING` is a real
-- gap kind rather than an absence. §29's rule: five lenses are answered and
-- five are asked, and the ones that are asked are put in front of a reader with
-- the subject attached rather than filled in from a template.
-- ---------------------------------------------------------------------------

CREATE TABLE realization_packets (
  id              TEXT PRIMARY KEY,

  -- What is being realized. A faculty today; the column is deliberately not
  -- `faculty_id NOT NULL` for ever, but making it nullable now would be a
  -- generality nothing uses and every reader would have to handle.
  faculty_id      TEXT NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT,

  -- DRAFT       sections are being written
  -- RESEARCHING one or more gaps are out with the research director
  -- READY       the stopping condition holds; it may be handed to the Factory
  -- BUILDING    a factory campaign is carrying it
  -- EVALUATING  the build is done and the evidence is being gathered
  -- REALIZED    every claimed power resolves to proof
  -- BLOCKED     something operational stops it; `blocker` says what and names a remedy
  -- ABANDONED   a person stopped it; the reason stays on the row
  state           TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (state IN ('DRAFT', 'RESEARCHING', 'READY', 'BUILDING',
                                     'EVALUATING', 'REALIZED', 'BLOCKED', 'ABANDONED')),
  -- Always set when the state needs a person, and always with a remedy in it.
  -- §24: an escalation with no answering transition is stuck rather than waiting.
  blocker         TEXT,

  -- The self-model reading the current-state map was derived against, so a gap
  -- can be re-read against the same reading it was decided on rather than
  -- against a database that has moved. §23's reason for keeping the router's
  -- input: "why did this come out that way" must be answerable afterwards.
  scan_id         TEXT,

  -- The factory campaign carrying it, once one exists.
  campaign_id     TEXT,

  created_by_type TEXT NOT NULL,
  created_by_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  -- One live packet per faculty. A second would make "what is Brain doing about
  -- Research Intelligence" ambiguous and every reader's choice an accident of
  -- ordering — the same reasoning §24 gives for one live standing authority.
  -- Terminal packets are excluded, so a faculty can be realized again later.
  UNIQUE (faculty_id, state)
);
CREATE INDEX idx_realization_packets_state ON realization_packets (state, updated_at);

-- ---------------------------------------------------------------------------
-- THE TEN SECTIONS, VERSIONED
--
-- `author_kind` is what keeps a compiled section and a proposed one apart. A
-- section Brain derived from rows and a section a worker wrote are different
-- kinds of claim, and a reader that could not tell them apart would treat a
-- proposal as a reading — which is §30's fact/estimate/decision distinction, at
-- a different artifact.
-- ---------------------------------------------------------------------------
CREATE TABLE realization_sections (
  id          TEXT PRIMARY KEY,
  packet_id   TEXT NOT NULL REFERENCES realization_packets(id) ON DELETE CASCADE,
  section     TEXT NOT NULL CHECK (section IN (
                'CAPABILITY_MAP', 'CURRENT_STATE', 'TARGET_TOPOLOGY',
                'INFORMATION_SUPPLY', 'KNOWLEDGE_COMPILATION', 'COGNITIVE_CONTRACT',
                'IMPLEMENTATION_GAPS', 'FACTORY_DEPENDENCIES', 'EVALUATION_GRAPH',
                'CAPABILITY_REGISTRATION')),
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,

  -- DERIVED   Brain computed it from rows; re-running produces the same thing
  -- PROPOSED  a worker wrote it and it has not been accepted
  -- ACCEPTED  a person accepted a proposal
  author_kind TEXT NOT NULL CHECK (author_kind IN ('DERIVED', 'PROPOSED', 'ACCEPTED')),
  -- What it was computed or proposed from: a scan id, a bin id, a claim list.
  evidence    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (packet_id, section, version)
);
CREATE INDEX idx_realization_sections_current
  ON realization_sections (packet_id, section, version);

-- ---------------------------------------------------------------------------
-- ONE GAP
--
-- The unit the whole realization is planned in. A gap names what is required,
-- what kind of gap it is, and — when the classification was a reading rather
-- than a judgement — the component in the self-model that answered it.
-- ---------------------------------------------------------------------------
CREATE TABLE realization_gaps (
  id            TEXT PRIMARY KEY,
  packet_id     TEXT NOT NULL REFERENCES realization_packets(id) ON DELETE CASCADE,

  -- What the definition requires, in the definition's own words. Quoted rather
  -- than paraphrased: a requirement Brain reworded is one nobody can check
  -- against the source it came from.
  requirement   TEXT NOT NULL,
  -- Which part of the definition it came from, e.g. `infrastructure`.
  aspect        TEXT NOT NULL,

  kind          TEXT NOT NULL CHECK (kind IN (
                  'EXISTS_AND_LIVE', 'EXISTS_BUT_DISCONNECTED', 'EXISTS_BUT_INSUFFICIENT',
                  'MUST_BE_BUILT', 'MUST_BE_REPLACED', 'MUST_BE_RESEARCHED',
                  'REQUIRES_PERSON_AUTHORITY', 'NEEDS_A_READING')),

  -- BRAIN  a reading over rows; re-running produces the same classification
  -- WORKER a judgement a reader made, which Brain validated and stored
  -- PERSON somebody decided
  derived_by    TEXT NOT NULL CHECK (derived_by IN ('BRAIN', 'WORKER', 'PERSON')),

  -- The self-model component that answered it, when one did.
  component_key TEXT,
  -- What was read to reach this classification. Required: a gap with no stated
  -- basis cannot be re-checked when the system moves under it.
  evidence      TEXT NOT NULL,

  -- OPEN      nothing has happened to it
  -- ASSIGNED  research or a factory unit is carrying it
  -- CLOSED    the condition no longer holds
  -- WAIVED    a person decided it is not required; the reason stays
  state         TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (state IN ('OPEN', 'ASSIGNED', 'CLOSED', 'WAIVED')),
  state_reason  TEXT,
  -- What is carrying it: an orchestration, a factory unit, a research mission.
  carried_by    TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- One gap per requirement per packet. Re-deriving replaces rather than
  -- duplicates, so a second pass over a moved self-model corrects the
  -- classification instead of adding a second opinion beside it.
  UNIQUE (packet_id, aspect, requirement)
);
CREATE INDEX idx_realization_gaps_state ON realization_gaps (packet_id, state, kind);
