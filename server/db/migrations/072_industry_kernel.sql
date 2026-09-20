-- ---------------------------------------------------------------------------
-- THE SELF-EXPANDING INDUSTRY KERNEL
--
-- Cash Mode's discovery has ten search buckets and they are ten *mechanisms* —
-- who published a paid request, where the same deliverable has two prices, who
-- has sold more than they can deliver. Every one of them is a question about
-- how money is reachable, and not one of them is a question about *where*. So
-- production discovery searched an undifferentiated economy: thirty-one
-- openings across transcription, stock photography, ticket resale, sneakers,
-- domains and bug bounties, with nothing anywhere saying which industries Brain
-- had looked at, which it had never opened, or what lives underneath any of
-- them.
--
-- This migration adds the missing axis. Four rules decided every column.
--
-- 1. THE MAP IS DISCOVERED, NEVER DECLARED. There is no table of industries in
--    this file and no constant holding one in the code above it. A node exists
--    because a claim that cleared the evidence gate said it exists, or because
--    a person seeded it. The bootstrap is a *question* — which sectors do the
--    authoritative classification systems declare — so the classification
--    systems are named as places to look, exactly as `proposedSources` already
--    names source classes, and the sectors themselves arrive as evidence.
--    A hardcoded list would answer the question this kernel exists to ask.
--
-- 2. A STRUCTURAL FINDING IS DECLARED BY WHOEVER READ THE SOURCE, FROM A CLOSED
--    SET. §33 records what the alternative costs: `harvest` decided "is this an
--    opening" by matching `evidence_lane` against a literal, planners name
--    their own lanes, and the bridge could never fire. `opportunity_signal` was
--    the repair and `structural_finding` is the same repair one axis along —
--    one nullable column on `research_claims`, one vocabulary, validated
--    exactly on submission, and anything outside it refuses the whole
--    submission rather than being stored and compared against nothing.
--
-- 3. WHAT CAN BE DERIVED IS NOT STORED. There is no coverage score, no
--    priority, no capital tier and no path verdict in this schema. All four are
--    facts about rows that change under them — `tier.ts`'s own reasoning, and
--    `placements`' before it: a row is not a decision, and a stored verdict is
--    stale the moment the evidence it was waiting on arrives. What *is* stored
--    is the two things a derivation cannot recover: that a node was seeded by a
--    person rather than found, and that a path was deliberately killed.
--
-- 4. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION. A capital requirement with no
--    established amount is NULL, and the minimum owner capital derived from a
--    set holding one is withheld rather than computed from the rest — §30's
--    rule about the margin, at the number that decides whether something is
--    executable today. A blank that made a piece look cheaper is the shape of
--    error nobody notices, because it looks like opportunity.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE GRAPH
--
-- One table, self-referencing, because every level the brief names — sector,
-- industry, sub-industry, value-chain layer, buyer, fulfilment source,
-- transaction type, bottleneck — is the same kind of thing: a named economic
-- subject that can be researched, can contain narrower subjects, and can
-- produce openings. Eight tables with one row shape between them would make
-- "what is underneath this" eight queries and one of them would be forgotten.
--
-- `kind` is what a level *is*, and it comes from the structural finding that
-- created the node rather than from the depth it sits at. A bottleneck three
-- levels down is a bottleneck; a sub-industry five levels down is still a
-- sub-industry. Depth is arithmetic and says nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS industry_nodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- NULL for a root: a sector the classification bootstrap returned, or a
  -- subject a person seeded. Everything else hangs off its parent, so the
  -- path back to a root is what says which economy a finding is about.
  parent_id       TEXT REFERENCES industry_nodes(id),

  -- What this node is. Taken from the structural finding that created it, so
  -- the vocabularies are one vocabulary and cannot drift apart.
  kind            TEXT NOT NULL CHECK (kind IN (
                    'SECTOR', 'SUB_INDUSTRY', 'VALUE_CHAIN_LAYER', 'BUYER_TYPE',
                    'FULFILMENT_SOURCE', 'TRANSACTION_TYPE', 'BOTTLENECK',
                    'ADJACENT_INDUSTRY')),

  name            TEXT NOT NULL,
  -- What the source actually said this is, in its own words. Kept beside the
  -- name because a name is an index and the sentence is the understanding —
  -- §11's rule at a node.
  description     TEXT,

  -- How this node came to exist, and it is never inferred.
  --
  --   SEED        a person named it. The one origin Brain may not write, for
  --               §22's reason: a machine that could seed its own subjects
  --               would be choosing what the economy is.
  --   BOOTSTRAP   a classification system named it, through a gated claim.
  --   DISCOVERED  research about the parent named it, through a gated claim.
  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'BOOTSTRAP', 'DISCOVERED')),

  -- The claim that established it, for everything but a seed. A node with no
  -- claim and no seed origin cannot be written: the CHECK below is what makes
  -- "every node traces to a passage or to a person" a property rather than a
  -- convention.
  source_claim_id TEXT REFERENCES research_claims(id),

  -- A person's decision to stop. Derivation decides RESEARCH_MORE against
  -- WATCH against PILOT; it cannot decide that somebody looked at this and
  -- said no, which is why this is the one verdict with a column. It is never
  -- a delete: a killed path is evidence about where Brain has already been,
  -- and deleting it would make the same node arrive again as a discovery.
  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- One node per name per parent per project. The arbiter for two ticks reading
-- one finished mission and both trying to add the same discovered child — the
-- eighth time this repository has needed a compare-and-swap on a value the
-- claimant does not supply. `parent_id` is nullable and SQLite treats NULLs as
-- distinct in a unique index, so roots are covered by the second index below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_nodes_child
  ON industry_nodes(project_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_nodes_root
  ON industry_nodes(project_id, name) WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_industry_nodes_project
  ON industry_nodes(project_id, kind);

CREATE INDEX IF NOT EXISTS idx_industry_nodes_parent
  ON industry_nodes(parent_id);


-- ---------------------------------------------------------------------------
-- WHAT HAS BEEN ASKED ABOUT WHICH NODE
--
-- `cash_discovery_rounds`' shape, for the same reason it exists: a display
-- window is not an index, and "have we asked this" must be answerable by key.
--
-- `purpose` is the difference between the two questions this kernel asks. MAP
-- decomposes a node into what is underneath it and is how the graph grows.
-- SCAN looks for openings *inside* a node and is the existing ten mechanisms
-- with a scope at last. They are separate rounds because they have separate
-- cool-offs, separate profiles and separate answers: a node can be fully
-- mapped and barren of openings, or full of openings and never decomposed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS industry_rounds (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT NOT NULL,

  -- NULL only for the bootstrap round, which has no node because its whole
  -- purpose is to produce the first ones. Every other round is about a node.
  node_id       TEXT REFERENCES industry_nodes(id),

  purpose       TEXT NOT NULL CHECK (purpose IN ('BOOTSTRAP', 'MAP', 'SCAN', 'CAPITAL')),

  -- Which mechanism a SCAN round is asking about, so one node can be scanned
  -- by several buckets without the rounds colliding. NULL for the others,
  -- which ask one question each.
  bucket_id     TEXT,

  -- The opportunity a CAPITAL round is decomposing. NULL for the others.
  opportunity_id TEXT REFERENCES cash_opportunities(id),

  round         INTEGER NOT NULL CHECK (round >= 1),

  -- The Russell idea this round asked. Unique for the same reason
  -- `cash_discovery_rounds` makes it unique: the wind-down guard reads this
  -- column to classify a candidate as kernel work, and two rounds sharing one
  -- would make that answer ambiguous exactly when it has to be certain.
  candidate_id  TEXT NOT NULL,

  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,

  -- What it produced. Nodes for a MAP, openings for a SCAN, capital rows for a
  -- CAPITAL. NULL while OPEN rather than 0, because §33 records what a default
  -- published as a measurement costs: `cash_discovery_rounds.found` was
  -- `NOT NULL DEFAULT 0`, only `closeRound` ever wrote it, and every live round
  -- reported "0 found" about work that had produced the whole portfolio.
  found         INTEGER,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK ((purpose = 'BOOTSTRAP') = (node_id IS NULL)),
  CHECK ((purpose = 'SCAN') = (bucket_id IS NOT NULL)),
  CHECK ((purpose = 'CAPITAL') = (opportunity_id IS NOT NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

-- One live asking per (node, purpose, bucket, round). `COALESCE` rather than
-- the raw columns because a unique index over NULLs does not constrain, and
-- "one bootstrap round at a time" is precisely a constraint over NULL node.
CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_ask
  ON industry_rounds(project_id, COALESCE(node_id, '-'), purpose,
                     COALESCE(bucket_id, '-'), COALESCE(opportunity_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_candidate
  ON industry_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_industry_rounds_project
  ON industry_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY REQUIRES THE CAPITAL
--
-- The brief's sharpest instruction: a capital requirement is not a fact until
-- it has been decomposed. A headline "you need $250k to start" is a number
-- somebody published about a *shape* of the business, and the question worth
-- asking is which specific requirement inside it is real, and which of those
-- can be removed, rented, financed, subcontracted, brokered, deferred or made
-- variable by a practice the industry already uses.
--
-- So one row is one requirement, and a restructuring is a *second* row that
-- names the requirement it answers. Two rows rather than two columns, because
-- a requirement can have several published answers and the honest output is
-- all of them with their sources, never the cheapest one silently chosen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_structures (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL REFERENCES cash_opportunities(id),

  entry_kind      TEXT NOT NULL CHECK (entry_kind IN ('REQUIREMENT', 'RESTRUCTURING')),

  -- What the capital is for. A closed set, so "what does this cost" is
  -- answerable by group across the portfolio rather than by reading prose.
  requirement     TEXT CHECK (requirement IN (
                    'LABOR', 'EQUIPMENT', 'PROPERTY', 'INVENTORY', 'LICENSING',
                    'CUSTOMER_ACQUISITION', 'WORKING_CAPITAL', 'DEPOSIT',
                    'INSURANCE', 'COMPLIANCE', 'FULFILMENT', 'TRANSPORT',
                    'STORAGE', 'TECHNOLOGY', 'MINIMUM_ORDER', 'GUARANTEE')),

  -- How industry practice removes, defers or shifts it. Also closed, and
  -- deliberately long: the brief names these mechanisms because knowing that
  -- they exist is what stops a capital requirement being accepted as fixed.
  mechanism       TEXT CHECK (mechanism IN (
                    'SUBCONTRACT', 'BROKERAGE', 'AGENCY', 'CUSTOMER_DEPOSIT',
                    'MILESTONE_BILLING', 'PRESALE', 'PURCHASE_ORDER_FINANCE',
                    'RECEIVABLES_FINANCE', 'SUPPLIER_CREDIT', 'CONSIGNMENT',
                    'LEASE', 'RENTAL', 'LICENSE_IN', 'REVENUE_SHARE',
                    'JOINT_VENTURE', 'PROJECT_FINANCE', 'OFFTAKE',
                    'DISTRIBUTION_ADVANCE', 'GOVERNMENT_INCENTIVE',
                    'CAPACITY_RESERVATION', 'MANAGEMENT_CONTRACT',
                    'CONTRACT_MANUFACTURE', 'THIRD_PARTY_LOGISTICS',
                    'WHITE_LABEL', 'MARKETPLACE')),

  -- The requirement a restructuring answers. Self-referencing rather than
  -- repeating the enum, so a restructuring cannot name a requirement this
  -- opportunity does not have.
  answers_id      TEXT REFERENCES capital_structures(id),

  -- What the source said it costs, in the sprint's currency. NULL means
  -- nothing published settled it, and a NULL here withholds the derived
  -- minimum rather than being treated as nothing to pay.
  amount_cents    INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),

  -- What the owner still has to fund after this restructuring, where the
  -- source says. Same rule: NULL is unknown, never zero.
  residual_cents  INTEGER CHECK (residual_cents IS NULL OR residual_cents >= 0),

  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK ((entry_kind = 'REQUIREMENT') = (requirement IS NOT NULL)),
  CHECK ((entry_kind = 'RESTRUCTURING') = (mechanism IS NOT NULL)),
  CHECK (entry_kind = 'REQUIREMENT' OR answers_id IS NOT NULL),
  CHECK (entry_kind = 'RESTRUCTURING' OR residual_cents IS NULL)
);

-- One entry per claim per opportunity, so a tick that re-reads a finished
-- packet writes what it wrote before rather than a second copy of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_capital_claim
  ON capital_structures(opportunity_id, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_capital_opportunity
  ON capital_structures(opportunity_id, entry_kind);


-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY STOPS US
--
-- The brief calls for the opposite of a risk register. "Employees should be
-- paid", "customers may not buy", "quality matters" are baseline business
-- competence and reporting them wastes the one thing a reader is short of.
-- What is worth a row is the constraint that *changes the economics* and is
-- not visible from outside: acceptance adds eight days to a three-day job, the
-- client forbids offshore sub-subcontracting, one supervisor caps throughput,
-- the 35% margin is 9% after realistic retakes.
--
-- The separation is structural rather than a filter over prose. There is no
-- `GENERIC_RISK` kind to declare, so the baseline observation has nowhere to
-- go — a closed vocabulary whose failure mode is *missing* a constraint rather
-- than admitting a platitude, which is the direction §27 says to fix a closed
-- list in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunity_constraints (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- A constraint belongs to a piece of work, or to a whole subject when it is
  -- true of everything underneath it. Exactly one, because a constraint
  -- attached to both would be counted twice by anything that reads both.
  opportunity_id  TEXT REFERENCES cash_opportunities(id),
  node_id         TEXT REFERENCES industry_nodes(id),

  kind            TEXT NOT NULL CHECK (kind IN (
                    'CYCLE_LONGER_THAN_STATED', 'SUBCONTRACTING_PROHIBITED',
                    'CREDENTIAL_REQUIRED', 'PRIOR_WORK_REQUIRED',
                    'SUPERVISION_CEILING', 'SECURITY_RESTRICTION',
                    'BUYER_CONCENTRATION', 'MARGIN_ERODED_BY_REWORK',
                    'PAYMENT_ON_FINAL_ACCEPTANCE', 'BONDING_OR_INSURANCE',
                    'REGULATORY_CAPITAL', 'ARBITRAGE_LOST_TO_OVERHEAD',
                    'PLATFORM_TERMS', 'SUPPLY_UNAVAILABLE')),

  statement       TEXT NOT NULL,
  -- What it does to the economics, where the source says. Kept apart from the
  -- statement because "this is true" and "this is what it costs you" are two
  -- claims, and the second is the one that decides anything.
  effect          TEXT,

  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK ((opportunity_id IS NULL) <> (node_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_constraint_claim
  ON opportunity_constraints(source_claim_id, kind);

CREATE INDEX IF NOT EXISTS idx_constraint_opportunity
  ON opportunity_constraints(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_constraint_node
  ON opportunity_constraints(node_id);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `opportunity_signal`'s shape, one axis along, and for its exact reason. A
-- structural fact about an industry is established by whoever read the source;
-- Brain's part is to insist the declaration exists and to match it exactly.
-- Every row written before this column carries NULL and therefore establishes
-- nothing structural, which is correct rather than a gap: nobody was asked.
--
-- Deliberately one column rather than four. The kinds share one question —
-- *what does this source establish about how this industry works* — and a
-- second column would mean two places for a finding to be classified and one
-- of them eventually disagreeing with the other.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN structural_finding TEXT;

-- What the finding is *about*, where the claim names something narrower than
-- the fragment's own subject. A sub-industry claim has to carry the name of
-- the sub-industry or there is nothing to create, and reading it out of the
-- claim sentence would be the prose-parsing §25's Westbrook defect records.
ALTER TABLE research_claims ADD COLUMN structural_subject TEXT;

-- Which requirement a CAPITAL_RESTRUCTURING answers. Null for every other
-- kind, because only a restructuring is *about* something else — and deriving
-- it from the claim sentence would be the prose-parsing this column exists to
-- avoid, at the one place where getting it wrong silently lowers a number.
ALTER TABLE research_claims ADD COLUMN structural_qualifier TEXT;

-- What a capital finding says the amount is, in the sprint's currency: the
-- gross for a requirement, the residual for a restructuring.
--
-- Nullable, and the nullability is the feature. A requirement with no
-- published amount is NULL, and `readCapital` then withholds the minimum owner
-- capital entirely rather than summing what it does have. §30's rule at the
-- number that decides whether something is executable today: a figure computed
-- past an unknown makes a piece look cheaper than it is, and that is the shape
-- of error nobody notices because it looks like opportunity.
ALTER TABLE research_claims ADD COLUMN structural_amount_cents INTEGER
  CHECK (structural_amount_cents IS NULL OR structural_amount_cents >= 0);

-- Where a node's own scan opened it, so an opening knows which industry it is
-- in without anybody re-deriving it from the title. NULL for the thirty-one
-- production pieces that predate the axis, which is honest: nothing said.
ALTER TABLE cash_opportunities ADD COLUMN industry_node_id TEXT REFERENCES industry_nodes(id);

CREATE INDEX IF NOT EXISTS idx_opportunities_node
  ON cash_opportunities(industry_node_id);
