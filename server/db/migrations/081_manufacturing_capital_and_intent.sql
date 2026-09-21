-- ---------------------------------------------------------------------------
-- WHAT ENTERING COSTS, WHAT COULD BE BOUGHT INSTEAD, AND WHAT IS STILL UNDECIDED
--
-- 075 built the manufacturing kernel around four questions — who buys, how it
-- reaches them, what producing requires, and what producing teaches. Three
-- things the directive asks for are missing from it, and each one is missing in
-- the same way: the reading that would answer it has nowhere to come from.
--
-- 1. REQUIRED CAPITAL. `ENTRY_BARRIER` holds twelve kinds and not one of them
--    is money; `readiness.ts` says so in as many words — *the barriers
--    established, which are never capital and never capabilities*. So a
--    category could read ENTER with nothing anywhere saying what entering
--    costs. The directive names required capital as the first thing under
--    ENTRY, and a verdict that cannot see it is a verdict about an easier
--    question. It is a table rather than a thirteenth barrier kind because a
--    barrier is a *thing to obtain* and capital is an *amount*: it has a
--    figure, a currency, a date, a scenario and a source, and a barrier row
--    could carry none of those.
--
-- 2. ACQUISITION CANDIDATES. The directive asks Brain to identify them. Doing
--    so is research — who exists, what they would contribute, what published
--    sources say they are worth — and every effect that follows from one is
--    separately authorized and stays that way. The table holds candidates and
--    reasons; it holds no offer, no approach and no commitment, and there is no
--    column any of those could be written into.
--
-- 3. THE DECISIONS NOBODY HAS MADE. The directive asks for one master brand and
--    then says not to lock the division names prematurely. Both halves matter:
--    inventing a name would be deciding something reserved to a person, and
--    dropping the concern would lose it. So the decision is a row that is
--    *open*, and its criteria, dependencies and reconsideration trigger are
--    derived from the ladder rather than stored — a stored criterion would be
--    stale the moment the thing it depends on changed.
--
-- The rule 075 rests on is untouched: a capability a product teaches is never
-- one this company holds. Nothing below writes `capabilities.held_at`, and the
-- capital and acquisition tables are research output exactly as
-- `category_evidence` is.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- THE DIRECTIVE THIS PROGRAMME IS RUNNING
--
-- A path and the sha-256 of the bytes at that path, both written by the server
-- from the file it actually read. A hash a request supplied would be a claim
-- about a file nobody opened, and afterwards indistinguishable from one Brain
-- computed — §20's rule that a scope is built from server-controlled facts,
-- arriving at a provenance column.
--
-- It is nullable because a programme may name no directive, which is honest
-- rather than a gap: nobody said. What it must never be is *decorative*, and
-- that is the half a column cannot enforce — `services/manufacturing/directive.ts`
-- is what carries the contents into the questions, and a test fails if the
-- contents stop arriving while the hash keeps being written.
-- ---------------------------------------------------------------------------
ALTER TABLE manufacturing_programs ADD COLUMN blueprint_path TEXT;
ALTER TABLE manufacturing_programs ADD COLUMN blueprint_sha256 TEXT;


-- ---------------------------------------------------------------------------
-- WHAT ENTERING A CATEGORY COSTS
--
-- One row per established requirement. A requirement with no published figure
-- is a row with no amount, and that is the point rather than an omission: the
-- reading above it withholds the total when any requirement is unpriced, which
-- is §38's rule at the number that decides whether something is reachable. An
-- amount inferred to complete a sum would make a category look cheaper than
-- anything published says it is, and that is the direction nobody checks.
--
-- Low and high rather than one figure, because sources publish ranges and
-- collapsing one to its midpoint invents precision nobody wrote down. A point
-- figure is the two being equal, so every reader has one shape to handle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_capital (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id     TEXT NOT NULL REFERENCES machine_categories(id),

  -- What the capital is *for*. Closed, so "what does entering cost" is
  -- answerable by group across the ladder rather than by reading prose.
  --
  -- Deliberately **not** 072's `CAPITAL_REQUIREMENTS`, and the reason is the
  -- subject rather than the words. That list answers what opening a service
  -- business in an industry needs — labour, customer acquisition, insurance,
  -- a minimum order — and it hangs off `cash_opportunities`. This answers what
  -- producing a machine needs, and it hangs off `machine_categories`. The two
  -- can never be about one observation, so they cannot drift into disagreeing
  -- about one; what forcing a factory's tooling, type approval and test rig
  -- into EQUIPMENT, COMPLIANCE and COMPLIANCE *would* do is make the grouped
  -- reading answer an easier question than the one asked. Reusing was
  -- considered and is recorded here as considered.
  requirement     TEXT NOT NULL CHECK (requirement IN (
                    'TOOLING_AND_EQUIPMENT', 'FACILITY', 'CERTIFICATION_AND_APPROVAL',
                    'ENGINEERING_AND_DEVELOPMENT', 'WORKING_CAPITAL', 'INVENTORY_AND_PARTS',
                    'SUPPLIER_ONBOARDING', 'DISTRIBUTION_AND_SERVICE_NETWORK',
                    'INTELLECTUAL_PROPERTY_OR_LICENCE', 'TEST_AND_VALIDATION')),

  -- Which shape of the business the figure is about. A number for the smallest
  -- credible entry and a number for volume production are two different facts,
  -- and a reader that mixed them would report a total nobody could act on.
  scenario        TEXT NOT NULL CHECK (scenario IN (
                    'SMALLEST_CREDIBLE_ENTRY', 'TYPICAL_ENTRY', 'AT_PRODUCTION_SCALE')),

  -- The published range, in minor units. Both null when the requirement is
  -- established and nothing publishes a figure — which is a *fact* the reading
  -- above uses, never a blank to be filled with a guess.
  amount_low_minor   INTEGER CHECK (amount_low_minor IS NULL OR amount_low_minor >= 0),
  amount_high_minor  INTEGER CHECK (amount_high_minor IS NULL OR amount_high_minor >= 0),

  -- ISO 4217, and required exactly when there is an amount. A bare number is
  -- the unknown taken as a favourable assumption — §30's `figures.ts` refuses
  -- one for the identical reason one section along.
  currency        TEXT,

  -- What the figure is a figure *from*, so a reader can weigh a regulator's
  -- published schedule against somebody's estimate without the two looking
  -- alike.
  basis           TEXT NOT NULL CHECK (basis IN (
                    'PUBLISHED_PRICE_OR_SCHEDULE', 'REGULATORY_FEE_SCHEDULE',
                    'COMPARABLE_FIRM_DISCLOSURE', 'TRADE_PUBLICATION_ESTIMATE',
                    'ANALYST_OR_MARKET_ESTIMATE')),

  -- When the figure was true, where the source says. Required, for §30's
  -- reason about an undated signal: money ages, and an undated cost cannot be
  -- told apart from one somebody remembers from before a tariff changed.
  as_of           TEXT NOT NULL,

  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  -- A range is both ends or neither, ordered, and priced in something.
  CHECK ((amount_low_minor IS NULL) = (amount_high_minor IS NULL)),
  CHECK (amount_low_minor IS NULL OR amount_high_minor >= amount_low_minor),
  CHECK ((amount_low_minor IS NULL) = (currency IS NULL)),
  CHECK (currency IS NULL OR length(currency) = 3)
);

-- One entry per claim, so a tick re-reading a finished packet writes what it
-- wrote before rather than a second copy of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_capital_claim
  ON category_capital(source_claim_id);

CREATE INDEX IF NOT EXISTS idx_category_capital_category
  ON category_capital(category_id, scenario);

CREATE INDEX IF NOT EXISTS idx_category_capital_program
  ON category_capital(program_id, requirement);


-- ---------------------------------------------------------------------------
-- WHO COULD BE BOUGHT, AND WHAT THAT WOULD CONTRIBUTE
--
-- Identifying an acquisition is research; making one is not. The directive asks
-- for the first and this table is the whole of it: a name a source published, a
-- contribution somebody can argue with, and the claim it came from.
--
-- **There is no column here that an approach, an offer, a valuation this Brain
-- produced, a term or a commitment could be written into**, and that is the
-- mechanism rather than a promise. Every effect on the world remains a
-- `COMMERCIAL_ACTION` under the separate grant a person makes (§30), and no
-- manufacturing route reads or writes one.
--
-- `set_aside_at` is the one verdict no derivation reaches: a person read it and
-- said no. It destroys nothing — the row keeps its evidence — because deleting
-- it would let the same candidate arrive again on the next round as a fresh
-- discovery, spending the allowance to learn something somebody had decided.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acquisition_candidates (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),

  -- What it would help with. A candidate is about a category, a capability, or
  -- both; one that is about neither is a company somebody named for no stated
  -- reason, which is not a finding.
  category_id     TEXT REFERENCES machine_categories(id),
  capability_id   TEXT REFERENCES capabilities(id),

  -- The target as the source names it. Free text for the reason a category is:
  -- nobody can enumerate the world's firms in advance.
  name            TEXT NOT NULL,

  contribution    TEXT NOT NULL CHECK (contribution IN (
                    'CAPABILITY', 'PRODUCTION_CAPACITY', 'DISTRIBUTION_OR_DEALER_NETWORK',
                    'SUPPLY_OR_COMPONENT_SOURCE', 'CERTIFICATION_OR_APPROVAL',
                    'INTELLECTUAL_PROPERTY', 'ENGINEERING_TEAM', 'BRAND_OR_MARKET_POSITION')),

  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  set_aside_at     TEXT,
  set_aside_reason TEXT,
  set_aside_by     TEXT REFERENCES users(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (category_id IS NOT NULL OR capability_id IS NOT NULL),
  CHECK ((set_aside_at IS NULL) = (set_aside_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_claim
  ON acquisition_candidates(source_claim_id);

CREATE INDEX IF NOT EXISTS idx_acquisition_program
  ON acquisition_candidates(program_id, contribution);

CREATE INDEX IF NOT EXISTS idx_acquisition_category
  ON acquisition_candidates(category_id);


-- ---------------------------------------------------------------------------
-- THE DECISIONS THIS KERNEL CANNOT MAKE AND MUST NOT FORGET
--
-- The directive asks for one master brand that could sit on a pressure washer
-- and on a cargo aircraft, and then says not to lock the division names
-- prematurely. Inventing one would be Brain deciding something reserved to a
-- person; removing the concern because it cannot be decided would lose the
-- requirement entirely. **Open is a state, and it is the honest one.**
--
-- `topic` is closed and there is deliberately no free-text topic: a decision
-- somebody could invent by posting is a decision nobody reviewed the criteria
-- for. What each topic's criteria, dependencies and reconsideration trigger
-- *are* is derived from the ladder in `services/manufacturing/decisions.ts`
-- rather than stored, because a stored criterion is stale the moment the thing
-- it depends on changes — the rule 075 already follows for every verdict.
--
-- `resolution` is free text and is a person's words. Nothing derives it,
-- nothing validates it against a vocabulary, and no research round can write
-- it: the whole point of the row is that this is not a researchable question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS programme_decisions (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),

  topic           TEXT NOT NULL CHECK (topic IN ('MASTER_BRAND_ARCHITECTURE')),
  state           TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED')),

  resolution      TEXT,
  resolved_at     TEXT,
  resolved_by     TEXT REFERENCES users(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK ((state = 'RESOLVED') = (resolution IS NOT NULL)),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);

-- One decision per topic per programme. A second would make "what did we decide
-- about the brand" ambiguous exactly where it has to be certain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_programme_decisions_topic
  ON programme_decisions(program_id, topic);


-- ---------------------------------------------------------------------------
-- WHAT A CLAIM CARRIES WHEN THE FINDING IS A FIGURE OR NAMES A SECOND THING
--
-- 075 gave a claim a finding, a subject and an observation date. A capital
-- requirement needs three more — a range, a currency and which shape of the
-- business it is about — and an acquisition candidate needs one: what it would
-- contribute. One qualifier column serves both, which is `structural_qualifier`'s
-- shape one kernel along and for its reason: the judgement is made once, by the
-- party who read the source, and matched exactly afterwards.
--
-- The *as-of* date is `capability_observed_on`, which 075 already added and
-- already means "the date the source observed this". A second date column
-- would be a second place for one fact, and the one nobody reads is the one
-- that drifts — so `findingTakesObservedOn` becomes true for a capital
-- requirement instead, and the same refusal a dateless demand signal gets
-- applies to a dateless figure. Money ages for the same reason demand does.
--
-- Every row written before this carries NULL in all five, which establishes
-- nothing and is correct rather than a gap: nobody was asked.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN capability_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN capability_amount_low_minor INTEGER
  CHECK (capability_amount_low_minor IS NULL OR capability_amount_low_minor >= 0);
ALTER TABLE research_claims ADD COLUMN capability_amount_high_minor INTEGER
  CHECK (capability_amount_high_minor IS NULL OR capability_amount_high_minor >= 0);
ALTER TABLE research_claims ADD COLUMN capability_currency TEXT;

-- What kind of figure it is. A regulator's published fee and somebody's market
-- estimate are both useful and are not the same fact, and a reading that could
-- not tell them apart would present the second with the first's authority.
ALTER TABLE research_claims ADD COLUMN capability_basis TEXT;
