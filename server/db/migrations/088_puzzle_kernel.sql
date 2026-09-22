-- ---------------------------------------------------------------------------
-- THE PUZZLE PRODUCTS AND PRODUCTION KERNEL
--
-- Every kernel before this one holds facts about the world that Brain read
-- somewhere. This one is the first that holds an **artifact Brain made**, and
-- every decision in this schema follows from that one difference.
--
-- A puzzle is the only thing in this repository that Brain can both produce
-- and prove. It cannot establish that a mine needs forty tankers, or what a
-- Michigan statute requires, without a worker reading a published source and
-- an audit standing behind it. It can generate a sudoku and then demonstrate,
-- from the printed grid alone, that it has exactly one solution. That is an
-- unusually strong position and this schema is arranged so it is not thrown
-- away by storing a claim where a proof would do.
--
-- Six rules decided every column here.
--
-- 1. THE SPECIFICATION IS STORED AND THE PUZZLE IS NOT. `puzzle_instances`
--    holds a master, a seed and a hash. There is no grid column, no solution
--    column and no answer-key column, because the brief requires that those
--    three cannot silently diverge and the only way they cannot is that there
--    is one of them: `render(master, seed)` produces all three together, every
--    time, deterministically. A stored grid is a copy, and a copy is a thing a
--    later edit can make disagree with its own answers.
--
-- 2. A GENERATOR'S BELIEF IS NOT EVIDENCE. `validation_state` is written by
--    the validator and by nothing else, and the validator is handed the
--    rendered artifact with no access to how it was made. §27's rule — a
--    worker's summary is never evidence, the branch is — arriving at a grid.
--    Nothing may be compiled from an instance that is not VALID, and there is
--    no warning tier to ship a known-broken puzzle through.
--
-- 3. A MASTER IS THE REUSABLE SYSTEM AND A PRODUCT IS ONE COMPILATION OF IT.
--    That relationship is the whole leverage question the brief asks about, so
--    it is two tables and a join rather than one table with a type column. The
--    multiplier is then a count over rows rather than a number somebody keeps.
--
-- 4. A RESKIN HAS NOWHERE TO BE DECLARED. `puzzle_products` carries the
--    dimensions on which two products may honestly differ — audience,
--    occasion, language, difficulty, class, channel, buyer — and carries no
--    cover, no title variant and no page order. The content dimension is not a
--    column at all: it is measured from `puzzle_product_instances`, because
--    that is the one claim a compiler could make falsely and the rows can
--    answer it themselves.
--
-- 5. EVERY RESEARCHED FACT TRACES TO A CLAIM THAT CLEARED THE GATE.
--    `source_claim_id` is NOT NULL on all four fact tables. The rows that may
--    exist without one are a format a **person** seeded and the things Brain
--    made itself, which carry their own proof instead.
--
-- 6. WHAT CAN BE DERIVED IS NOT STORED. There is no maturity column, no
--    leverage multiplier, no contribution, no ledger state and no rank. Every
--    one is a fact about rows that move underneath it — `tier.ts`'s reasoning,
--    at a second ladder. What IS stored is what no derivation recovers: that a
--    person seeded a format, that a product was promoted, what a validator
--    measured, and what actually happened when something was attempted.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE UNIVERSE
--
-- There is no list of puzzle formats in this repository. A format is here
-- because a gated claim named it or a person seeded it, which is §38's rule:
-- a hardcoded taxonomy answers the question the kernel exists to ask and is
-- wrong about everything the trade has taken up since somebody typed it.
--
-- `format_key` is the weakest normalization that could work — case and
-- whitespace — for `equipment_key`'s reason. Formats converge because the
-- question Brain asks names one verbatim from these rows and asks for it back
-- unchanged, which is a mechanism somebody can read rather than a similarity
-- threshold nobody can audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_formats (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  name             TEXT NOT NULL,
  format_key       TEXT NOT NULL,

  -- What the source said this format is, or why a person seeded it.
  note             TEXT,

  -- `SEED` is the one origin Brain may never write, and the CHECK is what
  -- makes that structural rather than a convention.
  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT,

  -- Retired, never deleted. A deleted format arrives again on the next round
  -- as a fresh discovery and the allowance is spent learning what somebody
  -- already decided.
  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_formats_unique
  ON puzzle_formats (project_id, format_key);


-- ---------------------------------------------------------------------------
-- THE REUSABLE SYSTEMS
--
-- One master is one way of making puzzles: a format, a corpus, a set of
-- parameters and a difficulty. It is the thing the brief's leverage question
-- is about — ten systems producing fifty outputs — and it is deliberately
-- small, because everything expensive about a puzzle system is in the code
-- and in the corpus rather than in a row.
--
-- `corpus_id` names a shipped constant in `domain/puzzleCorpora.ts` rather
-- than a table. Rights are the reason: a claim that a word list may be sold
-- from is a legal position about a specific artifact in this repository, and
-- no amount of reading published sources establishes it. A model that could
-- write a rights row would eventually write a confident one.
--
-- `generator_version` is on the row because a fix to a generator produces
-- different output from the same seed. Instances made before and after are not
-- interchangeable, and §5 forbids editing what the old one made: a repair is a
-- new version and a new master.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_masters (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),

  title             TEXT NOT NULL,
  format_key        TEXT NOT NULL,
  corpus_id         TEXT NOT NULL,

  -- The generator's own parameters, as JSON. Untyped here on purpose: each
  -- format reads the ones it implements and refuses the ones it does not, so
  -- a parameter nobody implements is a refusal rather than a field silently
  -- ignored.
  parameters        TEXT NOT NULL,

  difficulty        TEXT NOT NULL
                      CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT')),

  generator_version TEXT NOT NULL,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS puzzle_masters_by_project
  ON puzzle_masters (project_id, format_key);


-- ---------------------------------------------------------------------------
-- THE PUZZLES
--
-- A row per puzzle, holding the seed that makes it and the verdict on it.
--
-- `content_hash` is the hash of everything rendered — grid, prompts, solution
-- and key together — which is what makes "the specification is the storage" a
-- checkable claim rather than a hope: re-render the spec, hash it, and it is
-- this number or something is wrong.
--
-- `canonical_hash` is format-specific sameness rather than literal sameness.
-- Two sudoku grids differing only by a relabelling of digits are one puzzle to
-- anybody solving them, and a hash of the characters would let one be sold
-- four times as four. Null until validated, because the canonical form is the
-- validator's to compute.
--
-- `checks` holds what was actually checked, per instance, as JSON. Not a
-- summary and not a pass flag: an INVALID instance whose reason nobody kept is
-- one nobody can fix the generator from, and a VALID one whose checks nobody
-- kept is a claim rather than a reading.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_instances (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  master_id           TEXT NOT NULL REFERENCES puzzle_masters(id),

  seed                TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  canonical_hash      TEXT,

  validation_state    TEXT NOT NULL
                        CHECK (validation_state IN ('PENDING', 'VALID', 'INVALID')),

  -- What the validator measured by solving, never what the generator intended.
  measured_difficulty TEXT
                        CHECK (measured_difficulty IS NULL
                               OR measured_difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT')),

  checks              TEXT NOT NULL,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  -- A validated instance has a canonical form, and a pending one has not. The
  -- constraint is what stops a row claiming a duplicate-detection identity
  -- nothing computed.
  CHECK ((validation_state = 'PENDING') = (canonical_hash IS NULL))
);

-- One puzzle per (master, seed). The seed IS the puzzle, so the same seed
-- twice is the same puzzle twice, and the index is what makes generation
-- idempotent without a read.
CREATE UNIQUE INDEX IF NOT EXISTS puzzle_instances_unique
  ON puzzle_instances (master_id, seed);

CREATE INDEX IF NOT EXISTS puzzle_instances_by_canonical
  ON puzzle_instances (project_id, canonical_hash);


-- ---------------------------------------------------------------------------
-- THE PRODUCTS
--
-- One compilation of one master into something somebody could be sold.
--
-- The columns are the dimensions on which two products may honestly differ,
-- and what is absent from them is the load-bearing part: there is no cover, no
-- title variant, no trim size and no page order, so a reskin has nowhere to be
-- declared as a difference. `services/puzzle/products.ts` reads these plus the
-- instance overlap and says QUALIFIED or RESKIN; nothing is stored, because
-- the answer changes when a sibling is compiled.
--
-- `opportunity_id` is the pointer into Cash Mode, set once by a compare-and-
-- swap. There is no second lifecycle in this kernel: a product that is ready
-- to sell becomes a `cash_opportunities` row and is pursued by the standing
-- commercial authority, the recorded action and the money ledger that already
-- exist.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_products (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  master_id       TEXT NOT NULL REFERENCES puzzle_masters(id),

  title           TEXT NOT NULL,

  product_class   TEXT NOT NULL
                    CHECK (product_class IN ('DIGITAL_DOWNLOAD', 'INTERACTIVE',
                                             'RECURRING_FEED', 'LICENSE', 'PRINT_BOOK',
                                             'CARD_OR_BOXED', 'SERVICE')),

  audience        TEXT,
  use_occasion    TEXT,
  language        TEXT NOT NULL,
  difficulty      TEXT
                    CHECK (difficulty IS NULL
                           OR difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT')),
  channel         TEXT,
  buyer           TEXT,

  -- Denormalized deliberately: it is the join's own count, it never changes
  -- after compilation, and every reading of leverage would otherwise be a
  -- correlated subquery per product.
  instance_count  INTEGER NOT NULL CHECK (instance_count > 0),

  opportunity_id  TEXT,

  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS puzzle_products_by_master
  ON puzzle_products (master_id);

CREATE INDEX IF NOT EXISTS puzzle_products_by_project
  ON puzzle_products (project_id, product_class);


-- ---------------------------------------------------------------------------
-- WHICH PUZZLES ARE IN WHICH PRODUCT
--
-- The join that makes the content dimension measurable. Two products sharing
-- every instance are the same puzzles in two covers whatever their other
-- columns say, and this table is how that is answered from rows rather than
-- from a declaration somebody could make falsely.
--
-- `position` is the order they print in, which is genuinely part of the
-- product — and is deliberately NOT a dimension on which two products differ:
-- reordering a hundred puzzles produces a book with the same hundred puzzles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_product_instances (
  product_id   TEXT NOT NULL REFERENCES puzzle_products(id),
  instance_id  TEXT NOT NULL REFERENCES puzzle_instances(id),
  position     INTEGER NOT NULL,

  PRIMARY KEY (product_id, instance_id)
);

CREATE INDEX IF NOT EXISTS puzzle_product_instances_by_instance
  ON puzzle_product_instances (instance_id);


-- ---------------------------------------------------------------------------
-- WHO BUYS
--
-- A named organisation or publication that has published a need. Not a
-- plausible buyer, not a market segment, not a description of the kind of
-- publisher who might want this: a name, from a source, with the date the
-- source observed it.
--
-- `observed_on` is nullable and load-bearing in the reading rather than in the
-- schema. §30's rule is that an undated buying signal cannot be told apart
-- from one somebody remembers from years ago, so a row without one is reported
-- as undated rather than counted as current.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_demand (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  format_key       TEXT NOT NULL,
  buyer            TEXT NOT NULL,
  buyer_key        TEXT NOT NULL,

  statement        TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_demand_unique
  ON puzzle_demand (project_id, format_key, buyer_key);


-- ---------------------------------------------------------------------------
-- HOW IT REACHES THEM, AND WHO MAKES IT
--
-- One table, `kind` saying which, because both are the same row shape — a
-- named organisation with published terms — and two tables would mean writing
-- the same join twice.
--
-- They are genuinely different questions and are never read as one: a channel
-- with no production route is a product nobody can make, and a production
-- route with no channel is a product nobody can sell. `maturity.ts` asks for
-- both by kind, which is why the distinction is a column rather than a
-- convention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_routes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  kind             TEXT NOT NULL CHECK (kind IN ('CHANNEL', 'PRODUCTION')),

  format_key       TEXT NOT NULL,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,

  -- What the source said the terms are: the share, the minimum, the lead
  -- time, the rights it takes. Free text, because it is evidence rather than a
  -- field anything computes on — and a structured version of it would be a
  -- set of columns Brain filled in by reading prose.
  terms            TEXT NOT NULL,

  publisher        TEXT,
  observed_on      TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_routes_unique
  ON puzzle_routes (project_id, kind, format_key, name_key);


-- ---------------------------------------------------------------------------
-- THE MONEY, AS PUBLISHED
--
-- One row per published figure, with `component` saying which line of the
-- arithmetic it is. `domain/puzzle.ts` says which side each component lands on
-- and whether it is per unit or per run, both by lookup — so the "hundred
-- puzzles for a dollar" question is answered by accumulating rows rather than
-- by anybody reasoning about a sentence.
--
-- The distinction that matters most is inside the vocabulary rather than in
-- this table: `RETAIL_PRICE` and `NET_RECEIPT_PER_UNIT` are two components,
-- and `services/puzzle/economics.ts` refuses to compute a contribution from
-- the first. A shelf price is not receipts, they are indistinguishable in a
-- claim sentence, and the difference is most of the margin.
--
-- `currency` is the source's own and is never converted. A product class whose
-- figures arrive in two currencies has its contribution withheld and says so,
-- because a rate is a fact about a day nobody recorded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_economics (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  format_key       TEXT NOT NULL,
  product_class    TEXT NOT NULL
                     CHECK (product_class IN ('DIGITAL_DOWNLOAD', 'INTERACTIVE',
                                              'RECURRING_FEED', 'LICENSE', 'PRINT_BOOK',
                                              'CARD_OR_BOXED', 'SERVICE')),

  component        TEXT NOT NULL,

  -- A published zero is a figure and is stored as 0. §45 records what treating
  -- one as absent costs: a duty-free tariff line read as a line nobody had
  -- looked up, and a total withheld with every line established.
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency         TEXT NOT NULL,

  -- What the figure is per, in the source's own words. Required, because a
  -- figure whose basis nobody stated cannot be added to another one.
  basis_note       TEXT NOT NULL,

  publisher        TEXT,
  observed_on      TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

-- Several published figures for one line are kept, not collapsed. Two
-- printers quoting different unit costs is a range, and averaging them would
-- produce a number neither of them published.
CREATE UNIQUE INDEX IF NOT EXISTS puzzle_economics_unique
  ON puzzle_economics (project_id, format_key, product_class, component, source_claim_id);

CREATE INDEX IF NOT EXISTS puzzle_economics_by_class
  ON puzzle_economics (project_id, format_key, product_class);


-- ---------------------------------------------------------------------------
-- WHAT MAY NOT BE DONE
--
-- Copyright, trademark, platform rules, safety standards, accessibility
-- requirements, and rights terms a buyer imposes.
--
-- Deliberately not keyed to a format. A marketplace rule about what may be
-- listed, or a toy-safety standard for a boxed product aimed at children,
-- applies across formats, and filing it under one would hide it from every
-- other. `subject` is what it is about — the platform, the standard, the
-- mark — and the statement is the evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_constraints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  kind             TEXT NOT NULL
                     CHECK (kind IN ('COPYRIGHT', 'TRADEMARK', 'PLATFORM_RULE',
                                     'SAFETY_STANDARD', 'ACCESSIBILITY_RULE',
                                     'CONTRACT_TERM')),

  subject          TEXT NOT NULL,
  statement        TEXT NOT NULL,
  authority        TEXT,

  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_constraints_unique
  ON puzzle_constraints (project_id, kind, subject, source_claim_id);


-- ---------------------------------------------------------------------------
-- THE KERNEL'S QUESTIONS
--
-- A round is a Russell candidate with a purpose attached, exactly as
-- `deal_rounds` and `industry_rounds` are. Everything after it is machinery
-- Steps 4 to 12C already built: the archive check, the compiler, the approval
-- envelope, the evidence gate, the three audit roles. There is no second
-- research pipeline in this kernel and there must never be one.
--
-- `found` is NULL while OPEN rather than 0. §33 records what a default
-- published as a measurement costs: a projection said a working sprint had
-- found nothing, because it was reading a column's default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL REFERENCES cash_modes(id),

  purpose        TEXT NOT NULL
                   CHECK (purpose IN ('SEED_FORMATS', 'DEMAND', 'CHANNEL',
                                      'PRODUCTION', 'ECONOMICS', 'RIGHTS')),

  format_key     TEXT,
  product_class  TEXT,

  candidate_id   TEXT NOT NULL,
  round          INTEGER NOT NULL CHECK (round >= 1),

  state          TEXT NOT NULL CHECK (state IN ('OPEN', 'SETTLED')),
  found          INTEGER,

  created_at     TEXT NOT NULL,
  settled_at     TEXT,

  -- A settled round has a count and an open one has not. The constraint is
  -- what makes "null means nobody has counted" true rather than conventional.
  CHECK ((state = 'SETTLED') = (settled_at IS NOT NULL)),
  CHECK ((state = 'SETTLED') = (found IS NOT NULL)),

  -- Every purpose but the bootstrap is about a format. The bootstrap's whole
  -- job is to produce the first ones, so it is the one that may name none.
  CHECK (purpose = 'SEED_FORMATS' OR format_key IS NOT NULL),

  -- Only the economics question is about a product class, because only it
  -- produces figures that are judged against one.
  CHECK ((purpose = 'ECONOMICS') = (product_class IS NOT NULL))
);

-- The exclusion. Two ticks both deciding correctly that a question is next
-- produce one round, and the loser is an ordinary outcome rather than an
-- error — the same compare-and-swap-on-a-value-you-did-not-supply this
-- repository has now needed seven times.
CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_unique
  ON puzzle_rounds (project_id, purpose, format_key, product_class, round);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_by_candidate
  ON puzzle_rounds (candidate_id);


-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY HAPPENED
--
-- The one kind of fact in this kernel that no source publishes and no
-- validator computes: whether the editor accepted the submission, whether the
-- book sold, whether a reader complained, whether the playtest found the
-- puzzle dull.
--
-- `recorded_by` keeps a person's observation apart from Brain reading its own
-- rows, and `lessons.ts` counts them separately — because four of Brain's own
-- derivations about one product are one observation four times over, and
-- presenting them as a sample of four would be arithmetic on a fiction.
--
-- `monetization_route` is how a person's rejection of a route in the ledger is
-- recorded. The ledger itself is a reviewed constant rather than a table, so
-- this column is the only thing that can say a route was considered and turned
-- down — and a rejection kept with its reason is what stops the same route
-- being proposed every week.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS puzzle_observations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),

  kind                TEXT NOT NULL
                        CHECK (kind IN ('SUBMISSION_ACCEPTED', 'SUBMISSION_REJECTED',
                                        'SALE', 'NO_SALE', 'CUSTOMER_COMPLAINT',
                                        'DEFECT_FOUND', 'CHANNEL_TERMS_CHANGED',
                                        'PRODUCTION_RESULT', 'ROUTE_REJECTED',
                                        'HUMAN_EDIT_PASSED', 'HUMAN_EDIT_FAILED',
                                        'PLAYTEST_RESULT')),

  format_key          TEXT,
  product_id          TEXT,
  monetization_route  TEXT,

  statement           TEXT NOT NULL,
  recorded_by         TEXT NOT NULL,

  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS puzzle_observations_by_project
  ON puzzle_observations (project_id, created_at);


-- ---------------------------------------------------------------------------
-- THE FOURTH DECLARATION AXIS
--
-- A third column on `research_claims` was §45's decision and the argument is
-- the same one axis along: `opportunity_signal` says *is this a piece of
-- work*, `structural_finding` says *is this how the industry is put together*,
-- `deal_finding` says *what does this say about a transaction between two
-- parties*, and these say *what does this establish about who buys puzzle
-- content, how it reaches them, and what it costs to make*. Four questions,
-- four columns, because a column with two masters is invariant 31.
--
-- One claim may carry all four and most carry none.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN puzzle_finding TEXT;

-- What the finding names — the buyer, the channel, the supplier, the cost line
-- — as the source names it. Reading it out of the claim sentence would be the
-- prose-parsing §25's Westbrook defect records.
ALTER TABLE research_claims ADD COLUMN puzzle_subject TEXT;

-- Which kind of puzzle. Its own column so that two spellings of one format are
-- visibly two formats rather than silently one, and so the question Brain asks
-- can name a format verbatim and be declared back unchanged.
ALTER TABLE research_claims ADD COLUMN puzzle_format TEXT;

-- Which kind of product a figure is about. Required on both economic findings
-- and refused everywhere else, because it is what the figure is judged
-- against: a downloadable PDF with no freight line is completely costed, and a
-- boxed game with no freight line is one whose largest variable cost nobody
-- has established.
ALTER TABLE research_claims ADD COLUMN puzzle_product_class TEXT;

-- The closed-set value: which revenue line, which cost line, or which kind of
-- rights rule. The revenue and cost halves are disjoint, so a worker that
-- declared a print cost as a price point is refused rather than adding a cost
-- to the revenue side.
ALTER TABLE research_claims ADD COLUMN puzzle_value TEXT;

-- The figure, in minor units. A published zero is a figure and is stored as 0.
ALTER TABLE research_claims ADD COLUMN puzzle_amount_cents INTEGER
  CHECK (puzzle_amount_cents IS NULL OR puzzle_amount_cents >= 0);

-- The currency it was published in, declared beside it. Not taken from the
-- sprint: puzzle rates genuinely arrive in several currencies — a syndication
-- rate in one, a printer's quote in another — and stamping them all with the
-- sprint's would make the mixed-currency reading unreachable. Brain never
-- converts.
ALTER TABLE research_claims ADD COLUMN puzzle_currency TEXT;
