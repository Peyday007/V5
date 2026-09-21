-- ---------------------------------------------------------------------------
-- THE PUZZLE PRODUCTS + PRODUCTION KERNEL
--
-- §38 gave Cash Mode the axis that says *where* in the economy to look. §45
-- gave it the axis a two-sided transaction needs. This one adds the axis that
-- nothing above it can express, and it is the only axis in this Brain about
-- something Brain **makes**:
--
--     ONE VALIDATED PRODUCTION SYSTEM COMPILES INTO MANY QUALIFIED OUTPUTS.
--
-- Every other kernel in this repository researches the world. This one
-- researches the world *and holds the artifact*: a master that generates, an
-- instance it generated, the validation run that proved that instance works,
-- and the commercial outputs compiled from instances that passed. A
-- `cash_opportunities` row cannot hold any of that — it is one payer, one
-- price, one offer, one exposure — and flattening a catalog into it is how a
-- kernel comes to report fifty products when it has one generator run fifty
-- times with different covers.
--
-- Six rules decided every column here.
--
-- 1. THIS IS AN ENTRANCE, NOT A SECOND PIPELINE. Nothing in this schema
--    researches, schedules, audits, publishes or sells anything. A round is a
--    Russell candidate; the compiler writes the specification, the approval
--    envelope decides whether it may start, the evidence gate decides what may
--    be claimed, and all three audit roles decide whether it stands. An output
--    that becomes real is promoted into a `cash_opportunities` row and pursued
--    by the machinery Cash Mode already has. There is no second work queue, no
--    second approval, no second identity and no second money ledger here.
--
-- 2. THERE IS NO LIST OF PUZZLE FORMATS IN THIS REPOSITORY. `puzzle_formats`
--    rows exist because a gated claim named one or a person seeded one, and
--    the CHECK below is what makes that structural rather than a convention.
--    §38 and §39 both argue it: a hardcoded taxonomy answers the question the
--    kernel exists to ask, and it is wrong about every format the trade has
--    invented since somebody typed it. The directive's seed list is named as a
--    *spread to search from* and reaches a worker as words in an assignment,
--    never as rows.
--
-- 3. A GENERATOR IS AN IMPLEMENTATION AND A FORMAT IS NOT. §37's sentence, at
--    a new artifact: *a definition is not an implementation*. A format row
--    says the format exists in the world. An engine is code somebody wrote.
--    The two are joined by `engine_id` on a master and by nothing else, so a
--    format with no engine reports RESEARCHED and a format whose validator
--    implements fewer checks than the evidence demands reports GENERATABLE —
--    never VALIDATABLE. Claiming otherwise is the one lie this kernel could
--    tell that ends with unsolvable puzzles in somebody's hands.
--
-- 4. A PUZZLE IS EVIDENCE ONLY IF A VALIDATION RUN PASSED. §9's rule about
--    extraction, one artifact along and for the same reason. `puzzle_validations`
--    is append-only with a supersession pointer, exactly one run is current,
--    and an instance with no PASSED current run is something this kernel does
--    **not** have — every reader must say so rather than treating an
--    unvalidated instance as a working one.
--
-- 5. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION. `puzzle_route_evidence`
--    carries a `posture`, so "nobody has looked for a buyer here" and
--    "somebody looked and nobody publishes one" are different rows with
--    different remedies, and the absence of rows says only the first. A demand
--    signal with no observation date is refused rather than stored, because an
--    undated signal cannot be told apart from one somebody remembers from
--    years ago.
--
-- 6. WHAT CAN BE DERIVED IS NOT STORED. There is no maturity column, no
--    leverage multiplier, no contribution, no rank, no qualification state and
--    no readiness in this schema. Every one of them is a fact about rows that
--    move underneath it — `tier.ts`'s own reasoning. What *is* stored is what
--    no derivation recovers: that a person seeded a format, that a person
--    released an output, that a person decided a route's disposition, what a
--    generator actually produced, what a validator actually found, and what
--    happened when something was attempted.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE UNIVERSE
--
-- `format_key` is what two rows are matched on and it is the weakest
-- normalization that could work: case and whitespace, nothing else. §37 and
-- §45 both settled why — a matcher that tried harder produces confident wrong
-- answers, and here an invented match files evidence about crosswords under
-- cryptograms. Two spellings converge instead because Brain names the format
-- verbatim in the question it asks, which is a mechanism somebody can read
-- rather than a similarity threshold nobody can audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_formats (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  -- What the source calls it, and what Brain matches on.
  name             TEXT NOT NULL,
  format_key       TEXT NOT NULL,

  -- Who it is for and what the source said about it. Evidence rather than a
  -- field anything computes on.
  audience         TEXT,
  note             TEXT,

  -- `SEED` is the one origin Brain may never write. A machine that could name
  -- its own formats would be deciding what the universe is, which is §22's
  -- split at the table every other reading in this kernel hangs from.
  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT,

  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_formats_identity
  ON puzzle_formats(project_id, format_key);


-- ---------------------------------------------------------------------------
-- WHAT A GOOD ONE OF THESE MUST SATISFY
--
-- The directive lists format-specific checks — solution uniqueness for Sudoku,
-- clue-answer agreement for crosswords, coordinate agreement for word
-- searches. Those are not Brain's opinion: they are what the trade publishes,
-- so each one arrives as a gated claim declaring **which check** from a closed
-- set the format demands.
--
-- That is what makes VALIDATABLE a question about rows rather than a promise.
-- An engine declares the checks its validator implements; this table holds the
-- checks the evidence says the format requires; and a format is VALIDATABLE
-- only when the second is a subset of the first. A format whose evidence
-- demands a check no validator implements is reported as exactly that, with
-- the check named.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_standards (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  format_key       TEXT NOT NULL,

  -- Which check, from the closed vocabulary a validator can actually
  -- implement. Declared by whoever read the source; never read out of prose.
  check_kind       TEXT NOT NULL CHECK (check_kind IN (
                     'SOLUTION_UNIQUENESS',
                     'SOLVABILITY',
                     'ANSWER_KEY_AGREEMENT',
                     'COORDINATE_AGREEMENT',
                     'GRID_LEGALITY',
                     'CONNECTIVITY',
                     'CLUE_AGREEMENT',
                     'REACHABILITY',
                     'DUPLICATE_DETECTION',
                     'DIFFICULTY_CALIBRATION',
                     'PROHIBITED_CONTENT')),

  -- What the source actually demands, in its own words.
  statement        TEXT NOT NULL,

  -- Who demands it, where the source names them. NULL is honest.
  authority        TEXT,

  source_claim_id  TEXT NOT NULL,

  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_standards_identity
  ON puzzle_standards(project_id, format_key, check_kind, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_standards_format
  ON puzzle_standards(project_id, format_key);


-- ---------------------------------------------------------------------------
-- WHAT WE MAY NOT DO
--
-- The directive's rights standard is a prohibition, and a prohibition nothing
-- records is a prohibition nothing can check. Every constraint here is a gated
-- claim: a published rule about copyright, trademark, licensing, a platform
-- policy or a content rule, attached to the format it binds.
--
-- It is deliberately **not** a clearance. A format with no rows here has not
-- been cleared; nobody has looked. The reader says so.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_rights (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  format_key       TEXT NOT NULL,

  rights_kind      TEXT NOT NULL CHECK (rights_kind IN (
                     'COPYRIGHT',
                     'TRADEMARK',
                     'LICENSE_REQUIRED',
                     'PUBLIC_DOMAIN',
                     'PLATFORM_POLICY',
                     'CONTENT_RULE')),

  statement        TEXT NOT NULL,
  authority        TEXT,

  source_claim_id  TEXT NOT NULL,

  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rights_identity
  ON puzzle_rights(project_id, format_key, rights_kind, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rights_format
  ON puzzle_rights(project_id, format_key);


-- ---------------------------------------------------------------------------
-- THE REUSABLE PRODUCTION SYSTEM
--
-- The thing the whole kernel is named after. A master is **not** a puzzle: it
-- is the generator, its parameters, the corpus it draws on and the version of
-- both, from which many instances are produced deterministically.
--
-- `rights_basis` is NOT NULL, and that is the rights standard made structural
-- rather than remembered. A master with no stated commercial-use basis for its
-- corpus cannot be written by any path, so there is nowhere in this schema to
-- put a generator whose source material nobody has accounted for. The
-- directive is explicit that scraped or lightly-rewritten material is the one
-- thing this business may not be built on, and a NOT NULL column is the only
-- form of that rule a future caller cannot forget.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_masters (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  format_key       TEXT NOT NULL,
  name             TEXT NOT NULL,

  -- The implementation this master runs. A registered engine id, checked by
  -- the service rather than by a CHECK, because the registry is code and a
  -- CHECK here would be a second copy of it that drifts.
  engine_id        TEXT NOT NULL,
  engine_version   TEXT NOT NULL,

  -- What the generator is given. JSON, opaque to the database, validated by
  -- the engine that reads it.
  params_json      TEXT NOT NULL,

  -- Where the content comes from, and on what basis it may be sold.
  corpus_ref       TEXT,
  rights_basis     TEXT NOT NULL,

  -- A person's decision that this master is fit to produce from, and the
  -- editorial review the directive requires of every new generator or
  -- template. Nothing automatic writes either.
  reviewed_at      TEXT,
  reviewed_by_id   TEXT REFERENCES users(id),
  reviewed_note    TEXT,

  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK ((reviewed_at IS NULL) = (reviewed_by_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_masters_identity
  ON puzzle_masters(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_masters_format
  ON puzzle_masters(project_id, format_key);


-- ---------------------------------------------------------------------------
-- ONE GENERATED PUZZLE
--
-- Immutable, and its identity is the directive's list: type, generator, seed,
-- version, rules, solution, difficulty, provenance.
--
-- `payload_json` holds the puzzle, the solution and the answer key **together**
-- because the directive demands they come from the same canonical source so
-- they cannot silently diverge. Storing the solution in a second table
-- reachable by a second write is exactly how they diverge, and the divergence
-- is invisible until somebody cannot solve a book they paid for.
--
-- `content_hash` is over the canonical payload, and the unique index on it is
-- the duplicate detection the directive asks for: two runs that produced the
-- same puzzle are one puzzle, whatever seed reached them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_instances (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  master_id        TEXT NOT NULL REFERENCES puzzle_masters(id),

  format_key       TEXT NOT NULL,

  -- Reproducibility. The same engine at the same version given the same seed
  -- and the same params produces this exact payload, which is what makes a
  -- defect repairable at the generator rather than patchable per artifact.
  seed             TEXT NOT NULL,
  engine_id        TEXT NOT NULL,
  engine_version   TEXT NOT NULL,

  -- The puzzle, its solution and its answer key, from one canonical source.
  payload_json     TEXT NOT NULL,
  content_hash     TEXT NOT NULL,

  -- What the engine says about it. A reading rather than a promise: the
  -- validator checks difficulty separately where a standard demands it.
  difficulty       TEXT,
  expected_solve_seconds INTEGER,
  locale           TEXT,

  created_at       TEXT NOT NULL
);

-- The duplicate gate. Two identical puzzles in one project are one puzzle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_instances_content
  ON puzzle_instances(project_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_puzzle_instances_master
  ON puzzle_instances(master_id);


-- ---------------------------------------------------------------------------
-- WHAT A VALIDATOR ACTUALLY FOUND
--
-- Append-only, with exactly one current run per instance — §9's extraction
-- shape, for §9's reason: an audit recorded months ago must still resolve to
-- the text it actually read, and a validation recorded months ago must still
-- resolve to the checks that actually ran. Re-validating creates a new run and
-- marks the old one superseded; nothing is ever edited.
--
-- `checks_json` is the per-check record, so a PASS is never a bare word: it
-- names which checks ran, which passed, and what each one found. A verdict
-- with no checks behind it is the false confidence this table exists to
-- prevent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_validations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  instance_id      TEXT NOT NULL REFERENCES puzzle_instances(id),

  validator_id     TEXT NOT NULL,
  validator_version TEXT NOT NULL,

  verdict          TEXT NOT NULL CHECK (verdict IN (
                     'PASSED',
                     'FAILED',
                     -- The validator ran and could not answer: a check it does
                     -- not implement, a payload it could not read. Never a
                     -- pass, and deliberately not a failure either, because
                     -- the remedies differ — one repairs the puzzle and the
                     -- other implements the check.
                     'UNCHECKED')),

  checks_json      TEXT NOT NULL,

  -- Which check failed first, so a batch-wide defect is countable without
  -- reading every run's JSON. NULL on a pass.
  failed_check     TEXT,

  superseded_at    TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_current
  ON puzzle_validations(instance_id, superseded_at);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_defect
  ON puzzle_validations(project_id, failed_check, superseded_at);


-- ---------------------------------------------------------------------------
-- THE MONETIZATION POSSIBILITY LEDGER
--
-- The directive is explicit twice over: surface the best few, and **never
-- delete or hide** the slower, blocked, experimental or long-term paths. So
-- there is no delete path to this table anywhere in the kernel, and
-- `disposition` carries a person's decision rather than a derived judgement.
--
-- Rank is **not** here. The directive asks for a Top 5 Now, which is a fact
-- about evidence that moves underneath a stored number — a rank written today
-- is wrong the moment a demand signal lands, and it would read like a
-- measurement. It is derived lexicographically over observable facts, with no
-- weighted score anywhere, because a score needs weights and nobody set any.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_routes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  -- What the route is, and which of the ways money is captured it belongs to.
  name             TEXT NOT NULL,
  route_key        TEXT NOT NULL,
  route_class      TEXT NOT NULL CHECK (route_class IN (
                     'DIGITAL_SALE',
                     'SUBSCRIPTION',
                     'ADVERTISING',
                     'SYNDICATION',
                     'CUSTOM_COMMISSION',
                     'INSTITUTIONAL',
                     'WHITE_LABEL',
                     'PRINT_PRODUCT',
                     'PHYSICAL_PRODUCT',
                     'SOFTWARE',
                     'ACQUISITION',
                     'CONTRACT_PRODUCTION')),

  note             TEXT,

  -- A person's disposition, and only a person's. ACTIVE is the default a seed
  -- arrives with; every other value is somebody's recorded decision. There is
  -- no DELETED, and there must never be one.
  disposition      TEXT NOT NULL CHECK (disposition IN (
                     'ACTIVE',
                     'WATCHLIST',
                     'BLOCKED',
                     'ARCHIVED',
                     'REJECTED')),
  disposition_reason TEXT,
  disposition_by_id  TEXT REFERENCES users(id),
  disposition_at     TEXT,

  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  -- A disposition that is not the default is a decision, and a decision with
  -- nobody's name and no reason on it answers nothing later.
  CHECK (disposition = 'ACTIVE' OR (disposition_by_id IS NOT NULL AND disposition_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_routes_identity
  ON puzzle_routes(project_id, route_key);


-- ---------------------------------------------------------------------------
-- WHETHER ANYBODY IS ACTUALLY BUYING
--
-- Dated, because the directive says paid demand outranks views, keyword volume
-- and competitor existence — and an undated signal cannot be told apart from
-- one somebody remembers from years ago. §30 already had to record that rule
-- at the same kind of column.
--
-- `posture` is what keeps "nobody has looked" apart from "somebody looked and
-- nobody publishes one". Both are real answers with opposite remedies, and the
-- absence of rows says only the first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_route_evidence (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  route_id         TEXT NOT NULL REFERENCES puzzle_routes(id),

  posture          TEXT NOT NULL CHECK (posture IN ('DEMAND_FOUND', 'NONE_FOUND')),

  -- Who is buying, as the source names them.
  buyer            TEXT NOT NULL,

  -- Which format they buy, where the source says. NULL means the signal is
  -- about the route rather than about one format.
  format_key       TEXT,

  statement        TEXT NOT NULL,

  -- When the source observed it. NOT NULL for a found signal, enforced by the
  -- CHECK below rather than by a caller remembering.
  observed_on      TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,

  CHECK (posture = 'NONE_FOUND' OR observed_on IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_route_evidence_route
  ON puzzle_route_evidence(route_id, posture);


-- ---------------------------------------------------------------------------
-- THE ECONOMICS
--
-- One table for both sides, with the component saying which — and `side` is
-- **derived from the component by a lookup in code**, never stored and never
-- declared by a caller. A caller that could say a retailer share is revenue
-- would be able to make a run look profitable.
--
-- Every row is one published figure with its basis: what the figure is *per*.
-- The directive's own arithmetic depends on it — a per-unit cost and a
-- per-run setup cost cannot be added, and a figure whose basis nobody stated
-- is a number that can be added to the wrong things.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_economics (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  -- What this figure is about. A route always; a format where the source is
  -- specific enough; an output where a person recorded a real quote for a real
  -- product. Nullable on purpose — a published printing rate is about a
  -- production class rather than about anybody's particular book.
  route_id         TEXT REFERENCES puzzle_routes(id),
  format_key       TEXT,
  output_id        TEXT,

  component        TEXT NOT NULL CHECK (component IN (
                     -- Revenue side
                     'RETAIL_PRICE',
                     'NET_RECEIPTS',
                     'LICENSE_FEE',
                     'SYNDICATION_FEE',
                     'SUBSCRIPTION_PRICE',
                     'CUSTOM_COMMISSION',
                     -- Cost side
                     'EDITORIAL_COST',
                     'PLATFORM_FEE',
                     'RETAILER_SHARE',
                     'PREPRESS_COST',
                     'TOOLING_SETUP',
                     'PRINTING_COST',
                     'MATERIALS_COST',
                     'PACKAGING_COST',
                     'FREIGHT_COST',
                     'FULFILLMENT_COST',
                     'STORAGE_COST',
                     'RETURNS_ALLOWANCE',
                     'LABOR_COST',
                     'ROYALTY')),

  -- What the figure is per, in the source's own words: one unit, one book, one
  -- print run of 10,000, one month, one commission.
  basis            TEXT NOT NULL,

  amount_minor     INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency         TEXT NOT NULL,

  statement        TEXT NOT NULL,
  observed_on      TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_puzzle_economics_route
  ON puzzle_economics(project_id, route_id, component);

CREATE INDEX IF NOT EXISTS idx_puzzle_economics_format
  ON puzzle_economics(project_id, format_key, component);


-- ---------------------------------------------------------------------------
-- A COMMERCIAL OUTPUT
--
-- The thing the multiplier counts, and the one table where the directive's
-- honesty rule about reskins is enforced.
--
-- `differentiators_json` is the declared set of axes on which this output
-- differs from its siblings, from a closed vocabulary. Qualification is
-- derived from it and is never stored: an output whose differentiators are all
-- cosmetic — a title, a cover, a page order — is a reprint, counted as a
-- reprint, and never as a qualified product. The directive says to track
-- compilations, reprints, alternate formats, private-label editions and new
-- playable content honestly and separately, and a stored `qualified` flag
-- would be exactly the place that stopped being true.
--
-- `released_at` is a person's decision and nothing automatic writes it.
-- Publishing under the operator's identity is outside everything this kernel
-- may do.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_outputs (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  master_id        TEXT NOT NULL REFERENCES puzzle_masters(id),

  title            TEXT NOT NULL,

  -- Which of the production classes this is, because the directive is explicit
  -- that a book, a card deck, a jigsaw and a boxed kit share intellectual
  -- property and share almost nothing else.
  production_class TEXT NOT NULL CHECK (production_class IN (
                     'DIGITAL_ONLY',
                     'PRINTABLE',
                     'BOOK',
                     'ACTIVITY_PAD',
                     'CARD',
                     'JIGSAW',
                     'BOXED_KIT',
                     'MECHANICAL',
                     'FEED')),

  -- The axes on which this differs from its siblings. A JSON array of values
  -- from the closed differentiator vocabulary.
  differentiators_json TEXT NOT NULL,

  -- Who it is for and how it would reach them. Both nullable, and both are
  -- read by the qualification ladder: an output with no buyer named is
  -- assembled rather than qualified.
  target_buyer     TEXT,
  route_id         TEXT REFERENCES puzzle_routes(id),

  -- A person's release decision, and the opportunity it became if it was
  -- promoted into Cash Mode's own machinery.
  released_at      TEXT,
  released_by_id   TEXT REFERENCES users(id),
  opportunity_id   TEXT REFERENCES cash_opportunities(id),

  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK ((released_at IS NULL) = (released_by_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_outputs_identity
  ON puzzle_outputs(project_id, title);

CREATE INDEX IF NOT EXISTS idx_puzzle_outputs_master
  ON puzzle_outputs(master_id);


-- ---------------------------------------------------------------------------
-- WHICH PUZZLES ARE IN IT
--
-- So that a product resolves to real validated instances rather than to a page
-- count somebody typed. The reader refuses to call an output assembled while
-- any member's current validation is not PASSED, which is what makes "100
-- puzzles" a statement about rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_output_members (
  id               TEXT PRIMARY KEY,
  output_id        TEXT NOT NULL REFERENCES puzzle_outputs(id),
  instance_id      TEXT NOT NULL REFERENCES puzzle_instances(id),
  position         INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_output_members_identity
  ON puzzle_output_members(output_id, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_output_members_position
  ON puzzle_output_members(output_id, position);


-- ---------------------------------------------------------------------------
-- THE ROUNDS
--
-- One live round per subject per purpose, enforced by the partial unique index
-- below rather than by a read — the tick runs on more than one instance and
-- both halves of a check-then-write can read "there is no round".
--
-- `found` is deliberately **nullable** and is NULL while a round is OPEN. §33
-- records what a `NOT NULL DEFAULT 0` cost one kernel along: every live round
-- published the default as a measurement, and the surface said "0 openings
-- found" about rounds that had produced the whole portfolio. Not counted yet
-- and counted as none are different facts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  purpose          TEXT NOT NULL CHECK (purpose IN (
                     'UNIVERSE',
                     'DEMAND',
                     'ROUTE',
                     'ECONOMICS',
                     'RIGHTS',
                     'STANDARD',
                     'CHEAP_BOOK')),

  -- What the round is about. A format key, a route key, or NULL for the
  -- opening question, which names sources rather than subjects precisely so
  -- that it can reach outside whatever is already on the map.
  subject_key      TEXT,
  subject_label    TEXT,

  round            INTEGER NOT NULL,

  -- The idea this round asked. Everything downstream — the archive check, the
  -- compiler, the envelope, the gate, the three audit roles — hangs off it.
  candidate_id     TEXT NOT NULL REFERENCES russell_candidates(id),

  -- The allocator's own sentence, written when the decision was made. It is
  -- pure over a snapshot that has since moved, so re-deriving it later would
  -- answer a different question.
  why              TEXT NOT NULL,

  state            TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  found            INTEGER,
  settled_at       TEXT,
  settled_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (state = 'OPEN' OR settled_at IS NOT NULL),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

-- One live question per subject per purpose. `subject_key` is NULL for the
-- opening question, and SQLite treats NULLs as distinct in a unique index, so
-- the second index below is what bounds that one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_live
  ON puzzle_rounds(project_id, purpose, subject_key)
  WHERE state = 'OPEN' AND subject_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_live_open
  ON puzzle_rounds(project_id, purpose)
  WHERE state = 'OPEN' AND subject_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_candidate
  ON puzzle_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rounds_project
  ON puzzle_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- WHAT ATTEMPTS TAUGHT
--
-- One observation per row, and whether several amount to a rule is computed on
-- the read path with the sample shown. §45 argues it: a stored rule is a
-- generalization nobody can see the sample behind, and one observation is
-- often the most valuable thing in the table.
--
-- A lesson informs and never gates. Nothing in this kernel reads this table to
-- decide whether something may proceed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_observations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  kind             TEXT NOT NULL CHECK (kind IN (
                     'GENERATOR_DEFECT',
                     'VALIDATION_FAILURE',
                     'PLAYTEST_RESULT',
                     'BUYER_RESPONSE',
                     'PRICING_RESULT',
                     'CHANNEL_ECONOMICS',
                     'VENDOR_PERFORMANCE',
                     'PRODUCTION_RESULT',
                     'CUSTOMER_COMPLAINT',
                     'RIGHTS_ISSUE')),

  -- What it is about, so observations group without anybody reading prose.
  subject_key      TEXT,

  statement        TEXT NOT NULL,

  -- Whether Brain derived it from its own rows, or a person attested to it.
  -- §45's rule: Brain's derivations are counted separately, because four
  -- derivations about one batch are one observation four times over.
  observer         TEXT NOT NULL CHECK (observer IN ('BRAIN', 'PERSON')),
  observer_id      TEXT REFERENCES users(id),

  -- The row this was read off, where there is one.
  master_id        TEXT REFERENCES puzzle_masters(id),
  output_id        TEXT REFERENCES puzzle_outputs(id),
  source_claim_id  TEXT,

  created_at       TEXT NOT NULL,

  CHECK (observer = 'BRAIN' OR observer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_observations_group
  ON puzzle_observations(project_id, kind, subject_key);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON A CLAIM
--
-- The sixth axis, beside `opportunity_signal`, `structural_finding`,
-- `labor_finding`, `capability_finding` and `deal_finding`. Its own column
-- rather than more values on one of theirs, for the reason §45 states: they
-- answer different questions about the same claim, and one claim may carry
-- several of them or none.
--
-- Eight columns that only mean anything together. §33's `applyValidationAnswers`
-- defect and §45's own mapper omission are both what happens when a subset of
-- them reaches one reader: the validator runs, the tool accepts the claim, the
-- insert has the columns, and the fields arrive NULL because the mapper
-- between them carried only what it had been told about. The walk that submits
-- over the wire is what catches it; a unit test that writes the columns
-- directly never will.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN puzzle_finding TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_subject TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_format TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_value TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_basis TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_amount_minor INTEGER;
ALTER TABLE research_claims ADD COLUMN puzzle_currency TEXT;
ALTER TABLE research_claims ADD COLUMN puzzle_observed_on TEXT;

CREATE INDEX IF NOT EXISTS idx_research_claims_puzzle
  ON research_claims(puzzle_finding);
