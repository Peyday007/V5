-- ---------------------------------------------------------------------------
-- THE PUZZLE PRODUCTS AND PRODUCTION KERNEL
--
-- Brain has an axis for *where* money is reachable (§38), one for *by whom*
-- work is produced (§41), one for *what machine* to build next (§39), one for
-- *what opening* to pursue (§30) and one for *what Brain itself can do* (§37).
-- It has never held a row for **a thing Brain produced and can prove is
-- correct**.
--
-- Every kernel before this one researches the world. This one *makes
-- something*, which is a different burden entirely: a claim about the world is
-- judged by the evidence gate against a published source, and a puzzle Brain
-- generated has no source to be judged against. It is judged by running a
-- deterministic check over it. That single difference decided every column
-- below.
--
-- 1. A GENERATOR IS CODE, AND A ROW CAN NEVER SAY OTHERWISE. There is no
--    `is_generatable` column and no maturity column anywhere in this schema.
--    What Brain can generate and what Brain can validate are read on every
--    pass from the registries in `services/puzzles/registry.ts`, which are
--    maps of format to *functions*. A format with no function cannot be
--    generated whatever any row claims, and the brief's own words are the
--    reason: "do not falsely claim support for puzzle formats lacking real
--    validators." §37 drew the identical line one altitude up — a definition
--    is not an implementation — and this is that rule at a product.
--
-- 2. UNSUPPORTED IS NOT PASS, AND THE SCHEMA KEEPS THEM APART.
--    `puzzle_validations.verdict` has three values, and the third is the
--    point: a check nothing implements records `UNSUPPORTED`, which is a
--    reading that says *nothing looked*. §9 settled this for documents — an
--    unreadable file is not an empty file — and §30 for capabilities, where
--    MISSING and UNKNOWN must never collapse. Here the favourable direction is
--    towards shipping, so the cost of collapsing them is a defective product
--    sold to somebody.
--
-- 3. AN INSTANCE IS IMMUTABLE, BECAUSE A VALIDATION IS ABOUT BYTES.
--    `puzzle_instances` has no `updated_at` and nothing updates one. A
--    validation records the content hash it ran against, so a verdict recorded
--    months ago still resolves to the puzzle it actually checked — §9's
--    extraction runs, at a generated artifact. Regenerating produces a new
--    instance with its own identity and its own verdicts; it never edits one.
--
-- 4. A COSMETIC RESKIN IS RECORDED, NEVER COUNTED. The brief is explicit that
--    a cover change or a reordering does not create a new qualified output,
--    and the tempting implementation is to refuse to store one. That is worse:
--    a reskin somebody made still exists, and a schema that cannot hold it
--    makes lying about the axis the only way to record it at all. So
--    `COSMETIC` is in the vocabulary and `qualification` — which is derived on
--    the read path and stored nowhere — never counts one. The failure mode is
--    a reskin that is visible and uncounted rather than one that is hidden.
--
-- 5. NOTHING DERIVABLE IS STORED. No maturity, no multiplier, no yield, no
--    qualification verdict, no difficulty ranking, no "how close is this to
--    sellable" number. §38's third rule and §33's tier, for their reason: a
--    row is not a decision, and a stored verdict is stale the moment the
--    evidence it waited on arrives. Three things are stored because no
--    derivation could recover them — that a person named a format, that a
--    person declared a rights basis, and that a person blocked a master.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- A FORMAT
--
-- One kind of puzzle. Two origins and deliberately no third.
--
--   SEED        a person named it. The brief seeds a universe and says not to
--               limit it; somebody deciding this operation makes cryptograms
--               is a design act, and §41 settled that no amount of reading
--               rows answers one.
--
--   DISCOVERED  a gated claim established that this format exists, with the
--               source that says so. That is how the universe expands from
--               evidence rather than from the list somebody typed on day one.
--
-- There is no list of puzzle formats in this repository and there must never
-- be one, for §39's reason about machine categories: the brief's own seed list
-- is an example, and encoding it would encode the one thing it says not to.
-- What *is* in code is the set of formats Brain can actually generate and
-- check, which is a different statement — it is about this Brain's hands
-- rather than about the world.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_formats (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- The stable handle code matches a generator against. Derived from the name
  -- by the repository rather than supplied, so two spellings of one format do
  -- not become two rows — §39's identity rule, which is honest about what it
  -- catches: it joins "Word Search" to "word search" and does not join
  -- "word search" to "wordseek", because that needs a reader.
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,

  -- What it is, in the words a person decides in. A name is an index and the
  -- sentence is the understanding — §11's rule, at a format.
  description     TEXT,

  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),

  -- The claim that established it. Required for DISCOVERED, because that row
  -- is the only thing that can say what it was discovered from. The CHECK is
  -- §38's: a node tracing to neither a passage nor a person cannot be written
  -- by any path.
  source_claim_id TEXT REFERENCES research_claims(id),
  declared_by_ref TEXT,

  -- A person deciding this operation does not make these. Never a delete: a
  -- retired format is evidence about what was considered, and deleting it
  -- would let the same one arrive again as a fresh discovery with that gone.
  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_formats_slug
  ON puzzle_formats(project_id, slug);


-- ---------------------------------------------------------------------------
-- A MASTER
--
-- The reusable system the whole leverage argument rests on: generation logic,
-- its parameters, the corpus or lexicon it draws on, and the rights basis for
-- that corpus. One master compiles into many editions, and that ratio is the
-- brief's first multiplier.
--
-- `generator_key` names a function in `services/puzzles/registry.ts`. A master
-- naming a key nothing implements is refused at declaration rather than
-- discovered at production — §27's rule about a worker kind nothing
-- implements, at a generator.
--
-- ---------------------------------------------------------------------------
-- The rights basis is a column because it gates a different thing than quality
-- ---------------------------------------------------------------------------
--
-- A master with no recorded rights basis may still generate and be validated,
-- because checking whether the code works is not publishing anything. What it
-- may not do is reach a qualified edition, which is the step where something
-- would be sold. Those are two different gates on two different facts, and
-- collapsing them would either stop Brain testing its own generators or let it
-- sell a puzzle built from a corpus nobody established the rights to.
--
-- `PUBLIC_DOMAIN`, `OWN_WORK` and `LICENSED` are bases somebody can stand
-- behind. `UNESTABLISHED` is the honest fourth value and is never a basis to
-- publish on — it is what a master carries while the question is open, which
-- is a different fact from nobody having asked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_masters (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  format_id       TEXT NOT NULL REFERENCES puzzle_formats(id),

  name            TEXT NOT NULL,

  -- The function that produces instances. Checked against the registry when
  -- the row is written; a key nothing implements is refused there.
  generator_key   TEXT NOT NULL,

  -- Its parameters, as JSON. The generator validates its own shape — a
  -- schema in a CHECK constraint would be a second reader of the same rule.
  spec            TEXT NOT NULL,

  -- The version of the generating code this master was last produced under.
  -- Recorded so a systematic defect can be attributed to a version rather
  -- than to a master, which is what makes "repair the generator" actionable.
  generator_version TEXT NOT NULL,

  rights_basis    TEXT NOT NULL CHECK (rights_basis IN (
                    'PUBLIC_DOMAIN', 'OWN_WORK', 'LICENSED', 'UNESTABLISHED')),
  -- What the basis actually is, in words. Required for anything but
  -- UNESTABLISHED: "licensed" with no statement of what licence is the same
  -- unfalsifiable assertion §30's `figures.ts` refuses at a bare number.
  rights_statement TEXT,
  rights_claim_id TEXT REFERENCES research_claims(id),

  -- A systematic defect stops the master, not the instance.
  --
  -- The brief is explicit: "if a systematic defect appears, block the batch
  -- and repair the generator or source. Do not manually patch dozens of broken
  -- outputs and leave the source defect alive." So this is the row that gets
  -- blocked, and `produce.ts` refuses to generate from a blocked master. It is
  -- derived-and-then-written rather than purely derived, because a block has
  -- to survive the failing instances being superseded — a purely derived block
  -- would clear itself the moment somebody generated a fresh batch, which is
  -- exactly the "patch the outputs" behaviour it exists to stop.
  blocked_at      TEXT,
  blocked_reason  TEXT,

  retired_at      TEXT,
  retired_reason  TEXT,

  declared_by_ref TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (rights_basis = 'UNESTABLISHED' OR rights_statement IS NOT NULL),
  CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_masters_name
  ON puzzle_masters(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_masters_format
  ON puzzle_masters(format_id);


-- ---------------------------------------------------------------------------
-- AN INSTANCE
--
-- One produced puzzle, immutable from the moment it is written.
--
-- The brief asks for an identity that preserves type, generator, seed,
-- version, rules, solution, difficulty, audience, expected solve time,
-- provenance, validation result and reuse history. Most of those resolve
-- through the master; what is here is what is true of *this* puzzle.
--
-- ---------------------------------------------------------------------------
-- One canonical source, so puzzle and solution cannot silently diverge
-- ---------------------------------------------------------------------------
--
-- The brief requires the puzzle, the solution, the answer key and the
-- production layout to be generated from the same canonical source. `payload`
-- is that source: it holds the puzzle and its solution together, produced by
-- one function call, and every compiler reads it rather than re-deriving
-- anything. `content_hash` is over the puzzle as posed and `solution_hash`
-- over the answer, both recorded so a validation names exactly what it ran
-- against.
--
-- `canonical_hash` is the duplicate-detection key and it is deliberately
-- *not* `content_hash`. It is the format's own canonical form — for a grid,
-- the minimum over the dihedral transforms after relabelling — so two puzzles
-- that are the same puzzle rotated collide. What it catches is documented
-- honestly in `validators.ts` and it is a subset of full equivalence, which is
-- said there rather than implied here.
--
-- `measured_difficulty` is measured by the solver rather than asserted by the
-- generator. A generator that declared its own difficulty would be grading its
-- own exam — §27's sentence, at a puzzle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_instances (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  master_id           TEXT NOT NULL REFERENCES puzzle_masters(id),
  format_id           TEXT NOT NULL REFERENCES puzzle_formats(id),

  -- What made it. Both recorded, so a defect found later resolves to the
  -- exact code path and the exact input that produced this one.
  generator_key       TEXT NOT NULL,
  generator_version   TEXT NOT NULL,
  seed                TEXT NOT NULL,

  -- The puzzle and its solution, from one call. JSON.
  payload             TEXT NOT NULL,

  content_hash        TEXT NOT NULL,
  solution_hash       TEXT NOT NULL,
  canonical_hash      TEXT NOT NULL,

  -- What the solver needed to do, not what the generator hoped. NULL where
  -- the format has no difficulty model — which is a real answer and never 0.
  measured_difficulty INTEGER,
  difficulty_basis    TEXT,

  created_at          TEXT NOT NULL
);

-- The duplicate rule, as the database rather than as a pass.
--
-- Scoped to the project and the format: the same grid arriving twice is one
-- puzzle, and two ticks generating concurrently produce one row with the loser
-- reading back the winner's. The sixth time this repository has needed a
-- compare-and-swap on a value the claimant does not choose — here the claimant
-- chooses a seed and the *puzzle* decides the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_instances_canonical
  ON puzzle_instances(project_id, format_id, canonical_hash);

CREATE INDEX IF NOT EXISTS idx_puzzle_instances_master
  ON puzzle_instances(master_id, created_at);


-- ---------------------------------------------------------------------------
-- WHAT WAS ACTUALLY CHECKED
--
-- Append-only, one row per check per instance per run. The brief requires
-- 100% of output to be validated with format-specific checks, and this is the
-- evidence that it was.
--
-- `verdict` has three values and the third is load-bearing. `UNSUPPORTED`
-- means this Brain has no implementation of this check for this format — it is
-- a reading that says nothing looked, and `services/puzzles/validate.ts` never
-- lets one stand in for a pass. Without it an unimplemented check is
-- indistinguishable from a satisfied one, which is precisely the false
-- confidence §9 exists to prevent, at the artifact somebody would sell.
--
-- `validator_key` and `validator_version` are recorded for the reason the
-- generator's are: a defect in a check is a defect in a version of that check,
-- and a verdict that could not name which one it was is not auditable. `ran_at`
-- plus the instance's immutability is what makes an old verdict still true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_validations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  instance_id       TEXT NOT NULL REFERENCES puzzle_instances(id),

  -- Which check. A closed set per format, declared in code beside the function
  -- that runs it, so a check named here with no implementation is impossible
  -- rather than merely untested.
  check_key         TEXT NOT NULL,

  verdict           TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'UNSUPPORTED')),

  -- What the check saw. Required on a failure: a refusal that names nothing is
  -- one nobody can act on, and this is the sentence a person reads when a
  -- batch is blocked.
  detail            TEXT,

  validator_key     TEXT NOT NULL,
  validator_version TEXT NOT NULL,

  -- The bytes this verdict is about. Recorded rather than joined, so a verdict
  -- can be shown to be about the puzzle as it actually was.
  content_hash      TEXT NOT NULL,

  ran_at            TEXT NOT NULL,

  CHECK (verdict <> 'FAIL' OR detail IS NOT NULL)
);

-- One live verdict per check per instance per validator version. A re-run
-- under the same version is the same reading and collides; a new version is a
-- new reading and gets its own row, which is what lets a fixed validator be
-- shown to have changed a verdict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_validations_run
  ON puzzle_validations(instance_id, check_key, validator_version);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_instance
  ON puzzle_validations(instance_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_project
  ON puzzle_validations(project_id, verdict);


-- ---------------------------------------------------------------------------
-- AN EDITION
--
-- A commercial output compiled from validated instances. The second half of
-- the leverage argument: one master, many of these.
--
-- ---------------------------------------------------------------------------
-- The distinctness axis is what stops the multiplier being a lie
-- ---------------------------------------------------------------------------
--
-- The brief's own sentence — "a cover-color change, title change, reordered
-- pages, or other cosmetic reskin does not create a new qualified output" — is
-- the whole reason this column exists. An edition declares the axis on which
-- it differs from its siblings, and the derivation then *checks* that it does:
-- two editions of one master claiming the same axis must carry different
-- values on it, and an edition claiming `DISTINCT_CONTENT` must carry puzzles
-- no sibling carries. That is a computable check rather than a promise,
-- because `puzzle_edition_instances` already holds exactly what is needed.
--
-- `COSMETIC` is in the set and never qualifies. See rule 4 at the top.
--
-- There is no `qualified` column. Qualification is derived on the read path
-- from the instances, their verdicts, the master's rights basis and the
-- sibling comparison, because every one of those can change after the edition
-- is written and a stored verdict would be stale the moment one did.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_editions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  master_id          TEXT NOT NULL REFERENCES puzzle_masters(id),

  name               TEXT NOT NULL,

  -- What a buyer receives. A print book and a daily web feed built from one
  -- master are genuinely different products with different economics, and the
  -- brief asks for compilations, reprints, alternate formats and private-label
  -- editions to be tracked separately rather than summed.
  product_class      TEXT NOT NULL CHECK (product_class IN (
                       'PRINTABLE_PDF', 'PRINT_BOOK', 'WEB_PLAY', 'APP',
                       'EMAIL_FEED', 'SYNDICATED_FEED', 'WHITE_LABEL',
                       'INSTITUTIONAL_PACK', 'PHYSICAL_PRODUCT', 'API_FEED')),

  distinctness_axis  TEXT NOT NULL CHECK (distinctness_axis IN (
                       'DISTINCT_CONTENT', 'DIFFICULTY', 'AUDIENCE', 'LANGUAGE',
                       'PRODUCT_FORM', 'USE_OCCASION', 'CHANNEL', 'MECHANIC',
                       'COSMETIC')),

  -- The value on that axis. Required for every axis but DISTINCT_CONTENT,
  -- whose value is the instance set itself and is therefore already stored.
  -- Two siblings claiming DIFFICULTY must name two different difficulties, and
  -- an axis with no value could not be compared at all.
  distinctness_value TEXT,

  -- Why this is a different product, in words. What a person reads when they
  -- ask whether the catalog is real.
  rationale          TEXT NOT NULL,

  -- Where the compiled artifact was stored, through the storage layer. NULL
  -- until it has been compiled: an edition is declared first and built second,
  -- and a path built by hand is correct in exactly one deployment mode (§1).
  artifact_key       TEXT,
  artifact_hash      TEXT,
  compiled_at        TEXT,

  declared_by_ref    TEXT,

  retired_at         TEXT,
  retired_reason     TEXT,

  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  CHECK (distinctness_axis = 'DISTINCT_CONTENT' OR distinctness_value IS NOT NULL),
  CHECK ((compiled_at IS NULL) = (artifact_key IS NULL)),
  CHECK ((artifact_key IS NULL) = (artifact_hash IS NULL)),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_editions_name
  ON puzzle_editions(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_editions_master
  ON puzzle_editions(master_id);


-- ---------------------------------------------------------------------------
-- WHICH PUZZLES ARE IN WHICH EDITION
--
-- The lineage that makes reuse countable. One instance may appear in several
-- editions — that is the leverage — and the brief asks for reuse history to be
-- preserved per puzzle, which is this table read the other way.
--
-- It is also what makes the anti-reskin check computable: two editions with
-- identical instance sets are the same content whatever their covers say.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_edition_instances (
  id          TEXT PRIMARY KEY,
  edition_id  TEXT NOT NULL REFERENCES puzzle_editions(id),
  instance_id TEXT NOT NULL REFERENCES puzzle_instances(id),

  -- Where it appears. Ordering is part of a book and a reordering is a
  -- cosmetic change, which is why position lives here and never contributes
  -- to distinctness.
  position    INTEGER NOT NULL CHECK (position >= 0),

  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_edition_instances_pair
  ON puzzle_edition_instances(edition_id, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_edition_instances_position
  ON puzzle_edition_instances(edition_id, position);

CREATE INDEX IF NOT EXISTS idx_puzzle_edition_instances_instance
  ON puzzle_edition_instances(instance_id);


-- ---------------------------------------------------------------------------
-- WHAT HAS BEEN ASKED
--
-- `labor_rounds`' and `industry_rounds`' shape, for their reason: a round is a
-- Russell candidate, and everything after that is the path Steps 4 to 12C
-- already built. Nothing here researches anything.
--
-- There is deliberately no `cash_mode_id`. §41 records the argument and it
-- holds one axis along: a question about what a puzzle format is published to
-- sell for finds no opening and creates no obligation, and §30's wind-down
-- guard exists to stop a sprint *discovering* more after somebody said stop.
-- What bounds a round is the project's standing research authority and the
-- concurrency ceiling.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),

  -- What the question is about. A format for every purpose but UNIVERSE,
  -- which is the question that asks what formats exist at all and therefore
  -- cannot name one.
  format_id    TEXT REFERENCES puzzle_formats(id),

  --  UNIVERSE      which puzzle formats, mechanics and audiences exist
  --  DEMAND        who buys this format, and what published prices it reaches
  --  CHANNEL       where it is published, sold, licensed or syndicated
  --  RIGHTS        what rights, licensing and trademark constraints apply
  --  PRODUCTION    what producing it physically costs, and by what method
  purpose      TEXT NOT NULL CHECK (purpose IN (
                 'UNIVERSE', 'DEMAND', 'CHANNEL', 'RIGHTS', 'PRODUCTION')),

  round        INTEGER NOT NULL CHECK (round >= 1),
  candidate_id TEXT NOT NULL,

  state        TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at    TEXT NOT NULL,
  harvested_at TEXT,

  -- NULL while OPEN rather than 0. §33 records what a default published as a
  -- measurement costs: every live round reported "0 found" about the work that
  -- had produced the whole portfolio.
  found        INTEGER,

  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,

  CHECK (state = 'OPEN' OR found IS NOT NULL),
  CHECK (purpose = 'UNIVERSE' OR format_id IS NOT NULL)
);

-- One live ask per format per purpose per round. The UNIVERSE question names
-- no format, so its uniqueness is over the project — which is what stops two
-- ticks both asking what puzzle formats exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_format_ask
  ON puzzle_rounds(project_id, format_id, purpose, round) WHERE format_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_universe_ask
  ON puzzle_rounds(project_id, purpose, round) WHERE format_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_candidate
  ON puzzle_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rounds_project
  ON puzzle_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `opportunity_signal`'s shape, `structural_finding`'s and `labor_finding`'s,
-- one axis along and for their exact reason. §33 records what the alternative
-- costs: `harvest` decided "is this an opening" by matching a lane id against
-- a literal, planners name their own lanes, and the bridge could never fire.
--
-- Its own columns rather than a reuse of the others, because a field with two
-- masters is invariant 31 and one vocabulary validating two unrelated closed
-- sets is how a refusal stops naming the right thing. Every row written before
-- this migration carries NULL and therefore establishes nothing about puzzles,
-- which is correct rather than a gap: nobody was asked.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN puzzle_finding TEXT;

-- What the finding is about. For a finding that adds a format to the universe
-- this is the format's name as the source gives it, because the universe must
-- expand from evidence and a closed list of formats is the one thing the brief
-- says not to encode. For every other finding it is a value from a closed set,
-- because those answer a question Brain asks across every format and an answer
-- in somebody's own words could not be compared across them.
ALTER TABLE research_claims ADD COLUMN puzzle_subject TEXT;

-- What a published price is quoted on. Null for every other finding, and
-- required alongside a figure: reading "per book" out of the claim sentence
-- would be the prose-parsing §25's Westbrook defect records, at the one place
-- where getting it wrong changes a comparison by an order of magnitude.
ALTER TABLE research_claims ADD COLUMN puzzle_qualifier TEXT;

-- What a published source says this sells for, in minor units. Nullable, and
-- the nullability is the feature: a channel with no published price is
-- reported as *at an unknown price* rather than left out or read as cheap.
ALTER TABLE research_claims ADD COLUMN puzzle_price_cents INTEGER
  CHECK (puzzle_price_cents IS NULL OR puzzle_price_cents >= 0);
