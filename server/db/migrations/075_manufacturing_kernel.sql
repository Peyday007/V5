-- ---------------------------------------------------------------------------
-- THE MANUFACTURING EMPIRE KERNEL
--
-- §38's industry kernel answers *where in the economy money is reachable*, and
-- its whole graph is containment: a node is inside its parent, and `kindRecurses`
-- decides how far down that goes. That is the right shape for an economy and the
-- wrong shape for a company, because the question this kernel exists to answer
-- is not where the money is. It is:
--
--     which machine should be built next, and what does building it make
--     possible that was not possible before?
--
-- Nothing in `industry_nodes` can hold that. A capability is not *inside* an
-- industry — it is a property of a firm — and "pressure washers teach small-engine
-- integration, which motorcycles need" is an edge between two categories through
-- a third thing, where `industry_nodes` has exactly one parent per row. So this
-- migration adds a second graph beside the first rather than widening it.
--
-- Five rules decided every column.
--
-- 1. A CAPABILITY A PRODUCT *TEACHES* IS NOT A CAPABILITY WE *HOLD*. This is the
--    rule the whole schema is arranged around. Research can establish that
--    producing motorcycles requires chassis engineering, and that producing ATVs
--    develops it; nothing research establishes may say this company has it. So
--    `capabilities.held_at` is written by a person's declaration or by a piece of
--    work this project actually delivered, and by nothing else — §37's sentence
--    at a new table, where "a definition is not an implementation" becomes "a
--    capability chain is not a factory".
--
-- 2. DEMAND PULLS MANUFACTURING; MANUFACTURING NEVER SEARCHES FOR DEMAND. The
--    brief's core principle, and it is enforced by what `readiness` can derive
--    rather than by a sentence anywhere: a category with no established demand
--    and no established route to a buyer cannot read ENTER, whatever else is
--    known about it. An unexamined category reads UNKNOWN and never READY —
--    invariant 39, at the number that would start a factory.
--
-- 3. THE LADDER IS DISCOVERED, NEVER DECLARED. There is no list of machine
--    categories in this file and no constant holding one above it. The brief's
--    own six levels are an *example sequence it explicitly refuses to mandate*,
--    so encoding them would be encoding the one thing it says not to encode. A
--    category exists because a gated claim named it or a person seeded it.
--
-- 4. A FINDING IS DECLARED BY WHOEVER READ THE SOURCE, FROM A CLOSED SET. §33's
--    repair, §38's repair, and now this one — the third axis to need it. One
--    nullable column on `research_claims`, one vocabulary, validated exactly on
--    submission at both doors, and anything outside it refuses the whole
--    submission rather than being stored and compared against nothing.
--
-- 5. WHAT CAN BE DERIVED IS NOT STORED. No readiness column, no entry verdict, no
--    capability count, no sequence position. Every one of them is a fact about
--    rows that move underneath it, and the brief is explicit that the sequence
--    must be recalculated continuously rather than followed. A stored ordering
--    would be the rigid roadmap it says not to build.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE PROGRAM
--
-- Deliberately not `cash_modes`. §30 says Cash Mode is a temporary section meant
-- to be wound down after a month or two, and §40 says a temporary section's off
-- switch must never stop work it does not own. This kernel's horizon is the
-- opposite of that: it is the long-lived question Cash Mode's sprints run
-- underneath. Hanging it off a sprint would mean winding one down silently ended
-- a decade-scale program, which is exactly the defect that invariant names.
--
-- The objective is the person's own sentence, carried into every question as
-- context. It decides which findings are worth reporting and it widens nothing:
-- the envelope, the evidence gate and the source classes are all the compiler's.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturing_programs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),

  objective          TEXT NOT NULL,

  -- ACTIVE researches. PAUSED stops new questions and keeps everything already
  -- running, absorbed and readable — the same split §30 draws between winding a
  -- sprint down and ending a customer's obligation. ARCHIVED additionally
  -- withdraws the research grant this program's activation wrote.
  state              TEXT NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),

  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),

  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- One program per project. A second would make "which objective is this
-- question for" ambiguous exactly where it has to be certain, and every round
-- below resolves its objective through this row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_programs_project
  ON manufacturing_programs(project_id);


-- ---------------------------------------------------------------------------
-- THE LADDER
--
-- One table, self-referencing, for `industry_nodes`' reason: every level the
-- brief names — a category of powered machine, a narrower category inside it, an
-- adjacent one reached sideways — is the same kind of thing, a named class of
-- machine that can be researched, can contain narrower classes, and can be
-- entered.
--
-- `parent_id` is containment and nothing else. The brief's capability chains are
-- **not** stored here and must not be: "pressure washers lead to motorcycles" is
-- not a statement that motorcycles are inside pressure washers, it is a statement
-- about what one teaches and the other needs. That is two edges through a
-- capability, and it lives in `capability_edges` where it can have more than one
-- predecessor. A tree cannot hold a chain, and a tree that pretended to would
-- make the sequence look decided when the brief's whole optimization rule is that
-- it is not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS machine_categories (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- NULL for a root: a category the bootstrap returned, or one a person seeded.
  parent_id       TEXT REFERENCES machine_categories(id),

  --   PRODUCT_CATEGORY  a class of machine, at any depth.
  --   ADJACENT_CATEGORY one the sources name as reached sideways from this one.
  --
  -- Two kinds rather than the brief's six levels, and that is the point: a level
  -- is a judgement about sequence, sequence is derived, and a `kind` column
  -- holding LEVEL_3 would be the rigid roadmap stored as a string.
  kind            TEXT NOT NULL CHECK (kind IN ('PRODUCT_CATEGORY', 'ADJACENT_CATEGORY')),

  name            TEXT NOT NULL,
  description     TEXT,

  --   SEED        a person named it. The one origin Brain may not write, for
  --               §22's reason: a machine that could name its own categories
  --               would be choosing what this company is.
  --   BOOTSTRAP   the opening question named it, through a gated claim.
  --   DISCOVERED  research about the parent named it, through a gated claim.
  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'BOOTSTRAP', 'DISCOVERED')),

  source_claim_id TEXT REFERENCES research_claims(id),

  -- A person deciding not to pursue a category. Never a delete: the same
  -- category would arrive again on the next expansion as a fresh discovery, and
  -- the allowance would be spent learning what somebody had already decided.
  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_categories_child
  ON machine_categories(program_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_categories_root
  ON machine_categories(program_id, name) WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_machine_categories_program
  ON machine_categories(program_id, kind);

CREATE INDEX IF NOT EXISTS idx_machine_categories_parent
  ON machine_categories(parent_id);


-- ---------------------------------------------------------------------------
-- WHAT THIS COMPANY CAN ACTUALLY DO
--
-- The one table in this kernel whose most important columns research may never
-- write, and the reason the whole design is safe.
--
-- A capability row exists as soon as a source establishes that some category
-- requires or develops it. That is a fact about machines and it is what the
-- brief's capability chains are made of. Whether *this company holds it* is a
-- completely different fact with a completely different source, and collapsing
-- the two would let a well-sourced research packet about what motorcycle
-- production teaches be read, three joins later, as evidence that this company
-- can build motorcycles.
--
-- So holding is `held_at` plus `held_evidence`, and `held_evidence` has exactly
-- one value:
--
--   DECLARED   a person with ADMIN on this project said so, and `held_note` is
--              their own sentence.
--
-- **One value rather than two, and the reason is worth recording.** The obvious
-- second was DELIVERED — derived from a piece of work this project actually got
-- paid for. It is not here because nothing in this Brain could ever write it:
-- Cash Mode delivers services and the Software Factory delivers code, and
-- neither of them is evidence that this company can build a machine. A second
-- value nothing could produce would be the *mechanism nothing calls* this
-- repository has had to correct six times, wearing an enum.
--
-- So today the honest answer is that only a person can establish this, and the
-- column says which kind of evidence it was so that when a second kind genuinely
-- exists the two are distinguishable rather than collapsed. Adding one is an
-- additive migration somebody reviews, which is where "could this be faked?"
-- gets asked.
--
-- What there is certainly no value for is RESEARCHED. §32's distinction at a new
-- table: CONFIGURED is not HEALTHY, and a perfect block of what a category
-- teaches over an empty block of what this company has done is a refusal rather
-- than a pass.
--
-- `slug` is the identity, and it is a deterministic reduction rather than a
-- judgement: lowercased, runs of non-alphanumerics collapsed to one dash. Two
-- sources writing "Chassis Engineering" and "chassis engineering" are one
-- capability. Two writing "chassis engineering" and "frame design" are two, and
-- that is a known and deliberate limit — merging those needs a reader, which is
-- §24's semantic-merge floor, and inventing one here would silently join two
-- capability chains that are not the same chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capabilities (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- As the source wrote it, for a reader.
  name            TEXT NOT NULL,
  -- The deterministic reduction of it, for the unique index.
  slug            TEXT NOT NULL,
  description     TEXT,

  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id TEXT REFERENCES research_claims(id),

  held_at         TEXT,
  held_evidence   TEXT CHECK (held_evidence IN ('DECLARED')),
  -- Who said so, or which piece of work established it. Never a model.
  held_by         TEXT,
  held_note       TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  -- Held is three facts or none of them. A `held_at` with no evidence would be
  -- a capability this company was recorded as having for no stated reason.
  CHECK ((held_at IS NULL) = (held_evidence IS NULL)),
  CHECK ((held_at IS NULL) = (held_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_slug
  ON capabilities(program_id, slug);

CREATE INDEX IF NOT EXISTS idx_capabilities_held
  ON capabilities(program_id, held_at);


-- ---------------------------------------------------------------------------
-- THE CAPABILITY CHAIN
--
-- The edge that makes this kernel something `industry_nodes` could not be. A
-- category REQUIRES a capability, or TEACHES one, and both are established by a
-- source that said so. The brief's chains fall straight out of the join:
-- everything that teaches what motorcycles require is a predecessor of
-- motorcycles, and there can be several, which is why this is a table and not a
-- parent pointer.
--
-- A category may both require and teach the same capability — producing
-- motorcycles needs chassis engineering and deepens it — so the unique key
-- carries the relation. What it deliberately does not carry is a *degree*: there
-- is no "how much" column, because a number for how much a product teaches
-- something would need a scale nobody has set, and it would then read like a
-- measurement. `portfolio.ts` settled the same question for opportunities and
-- `verdict.ts` for subjects.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capability_edges (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id     TEXT NOT NULL REFERENCES machine_categories(id),
  capability_id   TEXT NOT NULL REFERENCES capabilities(id),

  relation        TEXT NOT NULL CHECK (relation IN ('REQUIRES', 'TEACHES')),

  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_edges_unique
  ON capability_edges(category_id, capability_id, relation);

CREATE INDEX IF NOT EXISTS idx_capability_edges_capability
  ON capability_edges(capability_id, relation);

CREATE INDEX IF NOT EXISTS idx_capability_edges_program
  ON capability_edges(program_id, relation);


-- ---------------------------------------------------------------------------
-- WHAT IS KNOWN ABOUT ENTERING A CATEGORY
--
-- `opportunity_constraints`' shape, one axis along: one table with a `kind` from
-- a closed set, because the five things below share one question — *what do
-- published sources establish about entering this category* — and five tables
-- would make "what do we know about motorcycles" five queries, one of which
-- somebody eventually forgets.
--
-- Two of the five decide whether a category can be entered at all, and they are
-- the brief's core principle expressed as rows: DEMAND_EVIDENCE says somebody is
-- actually buying, DISTRIBUTION_CHANNEL says there is a route to them. A category
-- with neither is one where manufacturing would be searching for demand
-- afterwards, which is the thing the brief exists to forbid.
--
-- `observed_on` is required for a demand signal and refused for a barrier. §30
-- records why: an undated buying signal cannot be told apart from one somebody
-- remembers from March. A certification requirement is not that kind of fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_evidence (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id     TEXT NOT NULL REFERENCES machine_categories(id),

  kind            TEXT NOT NULL CHECK (kind IN (
                    'DEMAND_EVIDENCE', 'DISTRIBUTION_CHANNEL',
                    'INCUMBENT_WEAKNESS', 'ENTRY_BARRIER', 'BOUGHT_IN_COMPONENT')),

  -- What the finding is about. From that kind's own closed vocabulary for the
  -- four that have one, and the component's own name for the fifth — nobody can
  -- enumerate the world's bought-in parts in advance, which is the same premise
  -- that keeps the category list out of this file.
  subject         TEXT NOT NULL,

  statement       TEXT NOT NULL,
  -- When the source observed it, where it says. Required for a demand signal.
  observed_on     TEXT,

  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (kind <> 'DEMAND_EVIDENCE' OR observed_on IS NOT NULL)
);

-- One entry per claim per kind, so a tick that re-reads a finished packet writes
-- what it wrote before rather than a second copy of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_evidence_claim
  ON category_evidence(source_claim_id, kind);

CREATE INDEX IF NOT EXISTS idx_category_evidence_category
  ON category_evidence(category_id, kind);


-- ---------------------------------------------------------------------------
-- WHAT HAS BEEN ASKED ABOUT WHICH CATEGORY
--
-- `industry_rounds`' shape and its reasons: a display window is not an index,
-- and "have we asked this" must be answerable by key.
--
-- Four purposes past the bootstrap, and their order in `allocate.ts` is the
-- brief's core principle rather than a preference. DEMAND comes before
-- CAPABILITY because establishing what a machine takes to build, for a machine
-- nobody has shown anybody is buying, is exactly the wrong way round.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturing_rounds (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),

  -- NULL only for the bootstrap, whose whole purpose is to produce the first
  -- categories.
  category_id   TEXT REFERENCES machine_categories(id),

  purpose       TEXT NOT NULL CHECK (purpose IN (
                  'BOOTSTRAP', 'MAP', 'DEMAND', 'CAPABILITY', 'INTEGRATION')),

  round         INTEGER NOT NULL CHECK (round >= 1),

  -- The Russell idea this round asked. Unique, so that reading a candidate back
  -- to the round that asked it is never ambiguous — the compiler does exactly
  -- that to decide which envelope judges the plan.
  candidate_id  TEXT NOT NULL,

  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,

  -- NULL while OPEN rather than 0. §33 records what a default published as a
  -- measurement costs: every live round reported "0 found" about the work that
  -- had produced the whole portfolio.
  found         INTEGER,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK ((purpose = 'BOOTSTRAP') = (category_id IS NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_rounds_ask
  ON manufacturing_rounds(program_id, COALESCE(category_id, '-'), purpose, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_rounds_candidate
  ON manufacturing_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_manufacturing_rounds_program
  ON manufacturing_rounds(program_id, state);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `structural_finding`'s shape, one axis along, and for its exact reason.
--
-- A third column on `research_claims` rather than more values in the second, and
-- the distinction is the question each one answers. `opportunity_signal` answers
-- *what kind of opening is this*; `structural_finding` answers *what does this
-- establish about how an industry works*; this answers *what does this establish
-- about what building a machine takes and teaches*. §38's warning was against
-- splitting **one** question across several columns, which is a different thing:
-- one claim can legitimately carry all three, and most carry none.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN capability_finding TEXT;

-- What the finding is about: the capability's name, the category's name, or a
-- value from that kind's closed vocabulary. Reading it out of the claim sentence
-- would be the prose-parsing §25's Westbrook defect records.
ALTER TABLE research_claims ADD COLUMN capability_subject TEXT;

-- When the source observed it, for the one kind where an undated fact is not a
-- fact. ISO-8601, and refused on every other kind so it cannot become a column
-- nothing reads.
ALTER TABLE research_claims ADD COLUMN capability_observed_on TEXT;


-- ---------------------------------------------------------------------------
-- ONE CANONICAL RESEARCH GRANT PER MANUFACTURING PROGRAM
--
-- `063_cash_discovery_authority.sql`'s index, scoped to this kernel's own
-- canonical name so it constrains exactly this grant and says nothing about the
-- cash, commercial or bespoke grants beside it.
--
-- A partial unique index rather than an application check, for the reason every
-- other claim in this codebase is a compare-and-swap: two ticks can both read
-- "there is no authority here" and both insert. The index decides, the loser
-- reads back the winner's row, and neither has to coordinate with the other.
--
-- What it authorizes is reading published sources about how machines are built,
-- bought and sold, and nothing else. `createGoal` and `ensureGoal` union
-- `ALWAYS_PROHIBITED` into every grant and write `max_external_spend = 0` as a
-- literal, so a grant permitting a purchase, a contact or a commitment cannot be
-- written here by a module, a script, a screen or a migration.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_goals_one_live_manufacturing
  ON russell_goals (project_id)
  WHERE state = 'ACTIVE' AND name = 'Manufacturing programme research';
