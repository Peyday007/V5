-- ---------------------------------------------------------------------------
-- THE CROSS-BORDER INDUSTRIAL DEALFLOW KERNEL
--
-- §38 gave Cash Mode the axis it was missing — *where* in the economy to look.
-- This one adds the axis a cross-border equipment transaction needs and that
-- nothing above it can express: a deal has **two sides**, and everything hard
-- about it lives between them.
--
-- A `cash_opportunities` row is one-sided by construction. It holds a payer, a
-- price, an offer and an exposure, which is the right shape for work somebody
-- commissions. It cannot say that a mine in Zambia needs forty fuel tankers,
-- that a manufacturer in Shandong builds them, that the trailer is
-- unregistrable there without an approval neither party has mentioned, that
-- the duty is nineteen per cent, or that the money in it is a commission
-- rather than the quarter-million-dollar asset. Those are five different
-- tables of fact about one transaction, and a single card with a `price` field
-- flattens them into a number that is wrong.
--
-- Five rules decided every column here.
--
-- 1. THIS IS AN ENTRANCE, NOT A SECOND PIPELINE. Nothing in this schema
--    researches, schedules, audits or executes anything. A round is a Russell
--    candidate; the compiler writes the specification, the approval envelope
--    decides whether it may start, the evidence gate decides what may be
--    claimed, and all three audit roles decide whether it stands. A deal that
--    becomes real is promoted into a `cash_opportunities` row and pursued by
--    the machinery Cash Mode already has — which is why there is no state
--    column here for engaged, quoting or paid, and no second work queue.
--
-- 2. EVERY ROW TRACES TO A CLAIM THAT CLEARED THE GATE. `source_claim_id` is
--    NOT NULL on all four fact tables. The only rows in this migration that
--    may exist without one are a party a **person** seeded and a deal, which
--    is a pairing of two rows that each carry their own. There is nowhere here
--    to put a fact somebody believes.
--
-- 3. THE FOUR COMPLIANCE LAYERS DO NOT COLLAPSE. `layer` is on the row rather
--    than derived, and a query that wants "can this be sold there" must ask
--    all four. ISO 9001 at a factory does not prove a tanker may be registered
--    in the destination market; a market approval does not prove the buyer
--    will accept it. Collapsing them would let Brain report a deal as clear
--    when it is not, and in this trade the equipment is built before anybody
--    finds out.
--
-- 4. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION — and here that needed a
--    whole finding of its own. "Nobody has looked at market approval" and
--    "somebody looked and there is no market approval" are opposite facts with
--    opposite consequences, and the absence of rows says only the first. So a
--    documented search writes a row with posture `NONE_FOUND`, and the derived
--    envelope reads a layer with no rows at all as NOT_ESTABLISHED — never as
--    clear.
--
-- 5. WHAT CAN BE DERIVED IS NOT STORED. There is no stage column, no margin,
--    no landed total, no confidence and no rank in this schema. Every one of
--    them is a fact about rows that change underneath it — `tier.ts`'s own
--    reasoning. What *is* stored is what no derivation recovers: that a person
--    seeded a party, that a deal was promoted into an opportunity, that an
--    operational condition blocked it, and what actually happened when it was
--    attempted.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE PARTIES
--
-- One table for both sides, with `kind` saying which. Two tables would be two
-- row shapes for one idea — a named organisation, in a country, connected to a
-- class of equipment — and the join that pairs them would have to be written
-- twice.
--
-- `equipment_class` is what the source calls it and `equipment_key` is what
-- two rows are matched on. The key is deliberately the weakest normalization
-- that could work (case and whitespace, nothing else): §37 settled that a
-- matcher which tried harder produces confident wrong answers, and here an
-- invented match pairs a buyer with a supplier that cannot build what they
-- need. The classes converge instead by Brain naming the class verbatim in the
-- question it asks, which is a mechanism somebody can read rather than a
-- similarity threshold nobody can audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_parties (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  kind             TEXT NOT NULL CHECK (kind IN ('BUYER', 'SUPPLIER')),

  -- The organisation, as the source names it.
  name             TEXT NOT NULL,

  -- Where they are. From the claim's own declared column, never from its
  -- prose: §25's Westbrook defect is a jurisdiction read out of a sentence,
  -- and in this trade the jurisdiction decides whether the goods are legal.
  country          TEXT,

  equipment_class  TEXT NOT NULL,
  equipment_key    TEXT NOT NULL,

  -- What the source actually said: the purchasing trigger for a buyer, the
  -- capability for a supplier. Free text, because it is evidence rather than
  -- a field anything computes on.
  note             TEXT,

  -- Who decides a purchase here, once a DECISION_MAKER finding has said so.
  -- Its own claim id beside it, because the party's own claim established that
  -- the organisation buys this equipment and says nothing about who signs.
  decision_maker            TEXT,
  decision_maker_claim_id   TEXT,

  -- `SEED` is the one origin Brain may never write, and the CHECK below is
  -- what makes that structural rather than a convention. A machine that could
  -- name its own counterparties would be deciding who the market is.
  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT,

  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((decision_maker IS NULL) = (decision_maker_claim_id IS NULL))
);

-- One organisation, one side, one equipment class. Two workers reading two
-- sources about the same mine write the same row; a second would split that
-- party's evidence between rows that nothing joins.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_parties_identity
  ON deal_parties(project_id, kind, name, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deal_parties_class
  ON deal_parties(project_id, equipment_key, kind);


-- ---------------------------------------------------------------------------
-- THE COMPLIANCE ENVELOPE
--
-- Keyed by (destination, equipment class, layer), because that is what a
-- requirement is actually about — never by deal, and never by party. The same
-- ADR approval applies to every fuel tanker entering that market, so binding
-- it to one deal would make Brain research it again for the next one, which is
-- §13's waste at the most expensive question in the trade.
--
-- `posture` carries the honesty. NOT_ESTABLISHED is not a value here: it is
-- the absence of rows, and the reader derives it. A row saying NONE_FOUND
-- exists only because somebody documented a search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_requirements (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  destination      TEXT NOT NULL,
  equipment_class  TEXT NOT NULL,
  equipment_key    TEXT NOT NULL,

  layer            TEXT NOT NULL CHECK (layer IN (
                     'FACTORY_CERTIFICATION',
                     'PRODUCT_CERTIFICATION',
                     'MARKET_APPROVAL',
                     'BUYER_ACCEPTANCE',
                     'IMPORT_BARRIER')),

  posture          TEXT NOT NULL CHECK (posture IN ('REQUIRED', 'NONE_FOUND', 'PROHIBITED')),

  -- What the requirement is, in the source's own terms.
  statement        TEXT NOT NULL,

  -- Who imposes it, where the source names them. NULL is honest: plenty of
  -- sources state a requirement without naming the instrument behind it.
  authority        TEXT,

  -- When it took effect, so a reader can see how old the answer is. §14's
  -- freshness, on the row rather than in a reader's head.
  effective_date   TEXT,

  source_claim_id  TEXT NOT NULL,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- One claim establishes one requirement. A claim absorbed twice by two ticks
-- collides here rather than writing the requirement twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_requirements_claim
  ON deal_requirements(source_claim_id, layer);

CREATE INDEX IF NOT EXISTS idx_deal_requirements_envelope
  ON deal_requirements(project_id, equipment_key, destination, layer);


-- ---------------------------------------------------------------------------
-- THE LANDED COST
--
-- One row per published figure, never a total. The total is derived, and it is
-- **withheld** when a load-bearing component has no row — §30's margin rule at
-- the number that decides whether a deal is worth doing. A landed cost missing
-- its duty line is exactly the error that makes a transaction look profitable,
-- and it is invisible if the arithmetic simply skips what it does not have.
--
-- `BUYER_ALTERNATIVE` lives in this table with its own component name and is
-- never summed with the rest. It is what the buyer pays today, which is the
-- only figure that says whether the saving is real.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_costs (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  equipment_class  TEXT NOT NULL,
  equipment_key    TEXT NOT NULL,

  -- A freight figure is about a lane rather than a market, so both ends are
  -- here and both are nullable: a factory price has no destination, and a
  -- destination duty has no origin.
  origin_country   TEXT,
  destination      TEXT,

  component        TEXT NOT NULL CHECK (component IN (
                     'FACTORY_PRICE', 'INLAND_ORIGIN', 'EXPORT_HANDLING',
                     'OCEAN_FREIGHT', 'INSURANCE', 'IMPORT_DUTY', 'IMPORT_TAX',
                     'CUSTOMS_CLEARANCE', 'INLAND_DESTINATION', 'INSPECTION',
                     'CERTIFICATION_COST', 'FINANCING_COST', 'BUYER_ALTERNATIVE')),

  -- NOT NULL, unlike `structural_amount_cents`, and the difference is the
  -- point. A capital requirement with no published figure is a real finding,
  -- because the reader withholds the total and says so. A cost *component*
  -- with no figure names a line in an arithmetic and supplies no number: it
  -- could only ever make the landed cost look complete while contributing
  -- nothing to it.
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency         TEXT NOT NULL,

  -- What the figure is per: one unit, one 40ft container, one shipment. Free
  -- text and reported verbatim, because a figure whose basis Brain guessed at
  -- is a figure nobody can check.
  basis            TEXT NOT NULL,

  source_claim_id  TEXT NOT NULL,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_costs_claim
  ON deal_costs(source_claim_id, component);

CREATE INDEX IF NOT EXISTS idx_deal_costs_lane
  ON deal_costs(project_id, equipment_key, destination);


-- ---------------------------------------------------------------------------
-- HOW THIS TRADE ACTUALLY PAYS
--
-- Evidence that a named commercial structure is used, rather than an opinion
-- that it could be. The request is explicit that no structure is universally
-- best, so this table holds what was observed and the reader offers the ones
-- the evidence supports — it never ranks them by a weight nobody set.
--
-- `rate_note` is free text and stays free text. A source saying "agents
-- typically take three to five per cent" is not a rate Brain may parse into a
-- number and multiply by a transaction value; doing that would turn somebody
-- else's range into our margin, which is §30's invented figure wearing a
-- citation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_structure_evidence (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  equipment_class  TEXT NOT NULL,
  equipment_key    TEXT NOT NULL,

  structure        TEXT NOT NULL CHECK (structure IN (
                     'REFERRAL_COMMISSION', 'SALES_REPRESENTATION', 'SOURCING_FEE',
                     'PROCUREMENT_FEE', 'BROKER_COMMISSION', 'BUYER_SIDE_REPRESENTATION',
                     'SUPPLIER_SIDE_REPRESENTATION', 'TRADING_COMPANY_MARKUP',
                     'LOGISTICS_COORDINATION_FEE', 'INSPECTION_COORDINATION',
                     'SPARE_PARTS_SUPPLY', 'AFTER_SALES_COORDINATION',
                     'RECURRING_PROCUREMENT')),

  statement        TEXT NOT NULL,
  rate_note        TEXT,

  source_claim_id  TEXT NOT NULL,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_structure_claim
  ON deal_structure_evidence(source_claim_id, structure);

CREATE INDEX IF NOT EXISTS idx_deal_structure_class
  ON deal_structure_evidence(project_id, equipment_key);


-- ---------------------------------------------------------------------------
-- THE DEAL
--
-- A pairing, and almost nothing else. Buyer, supplier, class — and every
-- question about how far it has got is answered by reading the four tables
-- above it, so there is no stage, no readiness, no margin and no rank here.
--
-- The four columns that *are* here are the four facts no derivation recovers:
-- which Cash opportunity it was promoted into, an operational condition that
-- stopped it, and what actually happened when it was attempted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),

  buyer_party_id     TEXT NOT NULL REFERENCES deal_parties(id),
  supplier_party_id  TEXT NOT NULL REFERENCES deal_parties(id),

  equipment_class    TEXT NOT NULL,
  equipment_key      TEXT NOT NULL,

  -- Where pursuit happens. Cash Mode already owns execution: its commercial
  -- authority, its recorded actions, its money ledger and its jobs. A second
  -- lifecycle here would be the redundant engine the brief forbids, and the
  -- weaker of the two would eventually be the one somebody read.
  opportunity_id     TEXT REFERENCES cash_opportunities(id),

  -- An operational fact from a condition somebody can fix, never a verdict on
  -- the deal. Every escalation needs an answering transition, so whatever
  -- writes this must also name the remedy.
  blocked_reason     TEXT,

  outcome            TEXT,
  outcome_note       TEXT,
  outcome_at         TEXT,

  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  CHECK (buyer_party_id <> supplier_party_id),
  CHECK ((outcome IS NULL) = (outcome_at IS NULL))
);

-- One deal per triple. The pairing runs on every tick and on more than one
-- instance, so the arbiter is the index rather than a read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_pair
  ON deals(buyer_party_id, supplier_party_id, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deals_project
  ON deals(project_id, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deals_opportunity
  ON deals(opportunity_id);


-- ---------------------------------------------------------------------------
-- WHAT THE KERNEL ASKED
--
-- `industry_rounds`' shape, and for its reasons. A round is one question, it
-- names the Russell candidate that asked it, and the candidate id is unique so
-- the wind-down guard can classify a candidate as kernel work without
-- ambiguity.
--
-- `found` is NULL while OPEN rather than 0. §33 records what the alternative
-- costs: `cash_discovery_rounds.found` was `NOT NULL DEFAULT 0`, only the
-- close ever wrote it, and every live round reported "0 found" about work that
-- had produced the entire portfolio.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_rounds (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id     TEXT NOT NULL,

  purpose          TEXT NOT NULL CHECK (purpose IN (
                     'SEED_EQUIPMENT', 'DEMAND', 'SUPPLY', 'COMPLIANCE',
                     'LANDED_COST', 'STRUCTURE', 'DECISION_MAKER', 'ADJACENT')),

  -- What the question is about. Which of these are set depends on the purpose,
  -- and the CHECKs below are what stop a round existing that names nothing it
  -- could be answered about.
  equipment_key    TEXT,
  equipment_class  TEXT,
  destination      TEXT,
  party_id         TEXT REFERENCES deal_parties(id),
  deal_id          TEXT REFERENCES deals(id),

  round            INTEGER NOT NULL CHECK (round >= 1),

  candidate_id     TEXT NOT NULL,

  state            TEXT NOT NULL CHECK (state IN ('OPEN', 'SETTLED')),

  opened_at        TEXT NOT NULL,
  harvested_at     TEXT,
  found            INTEGER,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  -- The bootstrap is the only question with no class, because its whole
  -- purpose is to produce the first ones.
  CHECK ((purpose = 'SEED_EQUIPMENT') = (equipment_key IS NULL)),
  CHECK ((equipment_key IS NULL) = (equipment_class IS NULL)),
  -- A compliance or landed-cost question that named no market would be
  -- answered about the world, which is the one answer neither is ever about.
  CHECK (purpose NOT IN ('COMPLIANCE', 'LANDED_COST') OR destination IS NOT NULL),
  CHECK (purpose NOT IN ('DECISION_MAKER', 'ADJACENT') OR party_id IS NOT NULL),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

-- One live asking per question. `COALESCE` rather than the raw columns,
-- because a unique index over NULLs does not constrain — and "one bootstrap
-- round at a time" is precisely a constraint over a NULL class.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_ask
  ON deal_rounds(project_id, purpose, COALESCE(equipment_key, '-'),
                 COALESCE(destination, '-'), COALESCE(party_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_candidate
  ON deal_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_deal_rounds_project
  ON deal_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- WHAT THE ATTEMPTS TAUGHT
--
-- One observation per row, never a rule. Whether several observations amount
-- to a rule is derived on the read path with the sample size printed beside
-- it, because the brief's own instruction is not to generalize prematurely —
-- and a stored rule is a generalization nobody can see the sample behind.
--
-- `jurisdiction` and `equipment_key` are what a lesson would be *about*, so
-- they are columns rather than words in the statement. A lesson whose scope
-- had to be recovered from its own sentence is the Westbrook defect again, one
-- table along.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_observations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),

  deal_id          TEXT REFERENCES deals(id),

  kind             TEXT NOT NULL CHECK (kind IN (
                     'BUYER_RESPONDED', 'BUYER_IGNORED', 'SUPPLIER_ENGAGED',
                     'SUPPLIER_REFUSED', 'PRICE_DISCREPANCY', 'CERTIFICATION_SURPRISE',
                     'LOGISTICS_SURPRISE', 'PAYMENT_PREFERENCE', 'COMMISSION_ACCEPTED',
                     'COMMISSION_REFUSED', 'FALSE_SIGNAL', 'CYCLE_LENGTH')),

  jurisdiction     TEXT,
  equipment_key    TEXT,

  statement        TEXT NOT NULL,

  -- Whose observation it is. A person recording what happened, or Brain
  -- reading its own rows — and the two are never merged, because a pattern
  -- across four of Brain's own derivations is not four independent
  -- observations.
  recorded_by      TEXT NOT NULL,

  source_claim_id  TEXT,

  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deal_observations_scope
  ON deal_observations(project_id, kind, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deal_observations_deal
  ON deal_observations(deal_id);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- The third axis, beside `opportunity_signal` (what kind of opening this is)
-- and `structural_finding` (how the industry is put together). It is separate
-- from both because the three answer different questions about one claim, and
-- a column with two masters is invariant 31. A claim may carry all three, any
-- one, or — as most claims do — none.
--
-- Every row written before this column carries NULL and therefore establishes
-- nothing about any transaction, which is correct rather than a gap: nobody
-- was asked.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN deal_finding TEXT;

-- What the finding is about: the organisation, the requirement, the cost line,
-- the structure — as the source names it. Reading it out of the claim sentence
-- would be the prose-parsing §25's Westbrook defect records.
ALTER TABLE research_claims ADD COLUMN deal_subject TEXT;

-- Which class of equipment. Its own column so that two spellings of one class
-- are visibly two classes rather than silently one, and so the question Brain
-- asks can name the class verbatim and be declared back unchanged.
ALTER TABLE research_claims ADD COLUMN deal_equipment TEXT;

-- The market it applies in. The whole reason this is a column and not a
-- sentence: the same trailer is legal in one market and unregistrable in the
-- next, and a requirement whose destination had to be recovered from prose is
-- the one confidently-wrong answer that every row around it agrees with.
ALTER TABLE research_claims ADD COLUMN deal_jurisdiction TEXT;

-- The closed-set value for the three findings that take one: the compliance
-- layer, the cost component, or the commercial structure.
ALTER TABLE research_claims ADD COLUMN deal_value TEXT;

-- The figure on a COST_COMPONENT, in minor units. Required for that finding
-- and refused for every other, which is the opposite of
-- `structural_amount_cents` and deliberately so — see `deal_costs` above.
ALTER TABLE research_claims ADD COLUMN deal_amount_cents INTEGER
  CHECK (deal_amount_cents IS NULL OR deal_amount_cents >= 0);

-- Which currency that figure is in, declared beside it.
--
-- Not taken from the sprint. Cross-border prices genuinely arrive in several
-- currencies — an ex-works price in one, a freight rate in another, a duty in
-- the destination's — and stamping them all with the sprint's currency would
-- make `landedEconomics`' mixed-currency reading unreachable, which is the
-- "mechanism nothing calls" defect at the number that decides a deal. Brain
-- does not convert: a lane whose figures are in two currencies has its total
-- withheld and says so.
ALTER TABLE research_claims ADD COLUMN deal_currency TEXT;
