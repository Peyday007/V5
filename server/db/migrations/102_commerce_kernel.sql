-- ---------------------------------------------------------------------------
-- THE SOCIAL COMMERCE KERNEL
--
-- The industry kernel gave Cash Mode's ten mechanism buckets an axis saying
-- *where* in the economy to look. It stops at the point where a subject has
-- produced an opening: an opening is a published fact about somebody else's
-- transaction, and nothing in this Brain turns one into a thing we sell.
--
-- This kernel is that loop, for one shape of transaction: something is bought
-- from a supplier, discovered by a buyer on a social channel, and shipped
-- without ever being held. Demand signal, product candidate, supplier
-- validation, unit economics, offer and content, a bounded sales test,
-- fulfilment, realized profit or loss, learning.
--
-- Four rules decided every column, and three of them are the industry
-- kernel's unchanged.
--
-- 1. THE CHANNELS ARE DISCOVERED, NEVER DECLARED. There is no list of
--    platforms in this file and no constant holding one in the code above it.
--    TikTok enters as a SEED — the one origin Brain may not write — because
--    the brief says to start there *while allowing evidence to identify
--    stronger channels*, and a constant would answer the question the kernel
--    exists to ask. It would also be wrong about every platform that has
--    changed its commerce terms since somebody typed it, which on this subject
--    is measured in months.
--
-- 2. A COMMERCE FINDING IS DECLARED BY WHOEVER READ THE SOURCE, FROM A CLOSED
--    SET. `opportunity_signal` and `structural_finding` are the same repair on
--    two other axes, and §33 records what the alternative cost: `harvest`
--    matched a lane id against a literal, planners name their own lanes, and
--    the bridge could never fire.
--
-- 3. WHAT CAN BE DERIVED IS NOT STORED. There is no stage column, no margin
--    column, no rank and no readiness flag. All four are facts about rows that
--    arrive asynchronously from several missions, so a stored one is stale the
--    moment a claim is accepted.
--
-- 4. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION. Every figure is nullable and
--    the nullability is the feature: a margin derived past an unknown input is
--    withheld entirely, naming which input is missing. §30 records this
--    correction at the margin; here it decides whether somebody buys stock.
--
-- And one that is this kernel's own.
--
-- 5. ATTENTION HAS ITS OWN KIND, SO IT CANNOT BE FILED AS DEMAND. A view count
--    is evidence, and it is evidence *against* a proposition whose only
--    support is views. `ATTENTION_EVIDENCE` exists precisely so that the
--    honest reading — many people watched, nobody is shown to have bought —
--    has somewhere to go that is not the place a purchase goes.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- WHERE THINGS ARE DISCOVERED AND SOLD
--
-- `industry_nodes`' origin rule exactly, and for its exact reason. A channel
-- exists because a claim that cleared the evidence gate established it, or
-- because a person seeded it; the CHECK is what makes "every channel traces to
-- a passage or to a person" a property rather than a convention.
--
-- Flat rather than a graph: a channel has no channels inside it. The industry
-- kernel needed a tree because an industry contains narrower industries, and
-- copying that shape here would be a hierarchy with nothing to put in it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_channels (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  name            TEXT NOT NULL,
  -- What the source said this is, in its own words. §11's rule at a row: a
  -- name is an index and the sentence is the understanding.
  description     TEXT,

  --   SEED        a person named it. TikTok is one of these, and that is the
  --               whole of how this kernel starts anywhere in particular.
  --   DISCOVERED  research named it, through a gated claim.
  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id TEXT REFERENCES research_claims(id),

  -- A person's decision to stop. Never a delete: a retired channel is evidence
  -- about where Brain has already been, and deleting it would let the same
  -- channel arrive again as a fresh discovery on the next expansion.
  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- One channel per name per project. The arbiter for two ticks reading one
-- finished mission and both trying to file the same channel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_channels_name
  ON commerce_channels(project_id, name);


-- ---------------------------------------------------------------------------
-- WHAT WE WOULD ACTUALLY SELL
--
-- Product, audience and channel — the combination the brief asks to start
-- from and to keep comparing. It is one row rather than three tables because
-- the three are only meaningful together: the same product on two channels has
-- two fee structures, two audiences and two sets of eligibility rules, and
-- merging them would average away the only thing worth comparing.
--
-- `opportunity_id` is the opening this came out of, where there is one. A
-- proposition is not a second kind of opportunity and this kernel is not a
-- second portfolio: the opening stays `cash_opportunities`' row with its tier,
-- its evidence card and its provenance, and this points at it the way
-- `capital_structures` does. §27's rule that there is no second orchestration
-- universe beside Brain, at a smaller scale.
--
-- `industry_node_id` is where in the economy it sits, where the industry
-- kernel has established one. NULL is honest rather than a gap: nobody asked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_propositions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id     TEXT NOT NULL,

  channel_id       TEXT NOT NULL REFERENCES commerce_channels(id),
  product          TEXT NOT NULL,

  -- Who buys it, and who supplies it. Both nullable, and both are questions
  -- the loop answers rather than preconditions for existing: a proposition
  -- whose audience nobody has established is exactly the thing a PRODUCTS
  -- round is for, and refusing to hold it would mean Brain could not record
  -- what it was about to ask about.
  audience         TEXT,
  supplier         TEXT,

  opportunity_id   TEXT REFERENCES cash_opportunities(id),
  industry_node_id TEXT REFERENCES industry_nodes(id),

  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT REFERENCES research_claims(id),

  retired_at       TEXT,
  retired_reason   TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- One proposition per product per channel per project. Two workers reading two
-- sources about one product write the same pair, and a second row would split
-- its evidence between two records that nothing joins.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_propositions_pair
  ON commerce_propositions(project_id, channel_id, product);

CREATE INDEX IF NOT EXISTS idx_commerce_propositions_project
  ON commerce_propositions(project_id);

CREATE INDEX IF NOT EXISTS idx_commerce_propositions_opportunity
  ON commerce_propositions(opportunity_id);


-- ---------------------------------------------------------------------------
-- EVERY READING, AND WHERE IT CAME FROM
--
-- Append-only, one row per reading, because the brief's sharpest instruction
-- is to keep assumptions, estimates and measured results apart — and the only
-- way two readings of one number can disagree honestly is if both are still
-- there. A column that was overwritten when a test measured it would destroy
-- the estimate that decided to run the test.
--
-- `origin` is the one thing a derivation cannot recover, so it is the one
-- thing stored. The *basis* — assumption, estimate, measured — is derived from
-- it and stored nowhere: two fields that must agree about one row is the shape
-- this repository has recorded four separate times, and the one nobody reads
-- is always the one that drifts.
--
-- FOUR FIGURE COLUMNS, NOT ONE. A platform fee of 8, a selling price of 8, a
-- delivery time of 8 and a minimum order of 8 are four different 8s. A single
-- nullable number would eventually be summed with another and nothing
-- downstream could tell, because the result would still be a number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- A reading is about one proposition, or about a whole channel when it is
  -- true of everything sold there — a platform's commission is the channel's,
  -- not any one product's. Exactly one, because a row attached to both would
  -- be counted twice by anything that reads both.
  proposition_id  TEXT REFERENCES commerce_propositions(id),
  channel_id      TEXT REFERENCES commerce_channels(id),

  kind            TEXT NOT NULL,
  statement       TEXT NOT NULL,

  --   CLAIM   a gated research claim. An estimate about our economics however
  --           good its source: a published platform fee is a fact about the
  --           platform and nothing has yet charged us one.
  --   TEST    a settled bounded test. The only thing that measures anything.
  --   PERSON  somebody said so. An assumption however confident they are.
  origin          TEXT NOT NULL CHECK (origin IN ('CLAIM', 'TEST', 'PERSON')),
  source_claim_id TEXT REFERENCES research_claims(id),
  test_id         TEXT,
  actor_ref       TEXT,

  amount_minor    INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  rate_ppm        INTEGER CHECK (rate_ppm IS NULL OR (rate_ppm >= 0 AND rate_ppm <= 1000000)),
  days            INTEGER CHECK (days IS NULL OR days >= 0),
  count_units     INTEGER CHECK (count_units IS NULL OR count_units >= 0),

  -- When the thing was true, as the source dated it. §30's rule that an
  -- undated buying signal is not evidence: trend durability and saturation are
  -- read against this rather than against `created_at`, which only says when
  -- Brain filed it.
  observed_at     TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK ((proposition_id IS NULL) <> (channel_id IS NULL)),
  -- Each origin carries its own provenance, and carries no other origin's. A
  -- claim row with a test id would be a measurement wearing a citation.
  CHECK ((origin = 'CLAIM') = (source_claim_id IS NOT NULL)),
  CHECK ((origin = 'TEST') = (test_id IS NOT NULL)),
  CHECK ((origin = 'PERSON') = (actor_ref IS NOT NULL))
);

-- One reading per claim per kind, so a tick that re-reads a finished mission
-- writes what it wrote before rather than a second copy of it. A test's and a
-- person's readings are deliberately not covered: those are events, and two of
-- them about one number at two times is the history this table exists to keep.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_evidence_claim
  ON commerce_evidence(source_claim_id, kind) WHERE source_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_evidence_proposition
  ON commerce_evidence(proposition_id, kind);

CREATE INDEX IF NOT EXISTS idx_commerce_evidence_channel
  ON commerce_evidence(channel_id, kind);


-- ---------------------------------------------------------------------------
-- WHAT HAS BEEN ASKED ABOUT WHAT
--
-- `industry_rounds`' shape, for its reason: a display window is not an index,
-- and "have we asked this" must be answerable by key rather than by scanning
-- prose.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL,

  purpose        TEXT NOT NULL CHECK (purpose IN (
                   'CHANNELS', 'PRODUCTS', 'SUPPLY', 'ECONOMICS', 'ELIGIBILITY')),

  -- CHANNELS asks about no channel, because its whole purpose is to produce
  -- the first ones. PRODUCTS and ELIGIBILITY ask about a channel. SUPPLY and
  -- ECONOMICS ask about one proposition.
  channel_id     TEXT REFERENCES commerce_channels(id),
  proposition_id TEXT REFERENCES commerce_propositions(id),

  round          INTEGER NOT NULL CHECK (round >= 1),

  -- The Russell idea this round asked. Unique for `industry_rounds`' reason:
  -- the wind-down guard reads this column to classify a candidate as kernel
  -- work, and two rounds sharing one would make that answer ambiguous exactly
  -- when it has to be certain.
  candidate_id   TEXT NOT NULL,

  state          TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at      TEXT NOT NULL,
  harvested_at   TEXT,

  -- NULL while OPEN rather than 0. §33 records what a default published as a
  -- measurement costs: every live round reported "0 found" about the work that
  -- had produced the whole portfolio.
  found          INTEGER,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  CHECK ((purpose = 'CHANNELS') = (channel_id IS NULL AND proposition_id IS NULL)),
  CHECK ((purpose IN ('PRODUCTS', 'ELIGIBILITY')) = (channel_id IS NOT NULL)),
  CHECK ((purpose IN ('SUPPLY', 'ECONOMICS')) = (proposition_id IS NOT NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

-- One live asking per (subject, purpose, round). COALESCE rather than the raw
-- columns because a unique index over NULLs does not constrain, and "one
-- channels round at a time" is precisely a constraint over NULL subjects.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_rounds_ask
  ON commerce_rounds(project_id, purpose, COALESCE(channel_id, '-'),
                     COALESCE(proposition_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_rounds_candidate
  ON commerce_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_commerce_rounds_project
  ON commerce_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- THE BOUNDED SALES TEST
--
-- The one place in this kernel where money leaves the account, and therefore
-- the one place with a ceiling a person set. §30's rule: a dollar committed to
-- one opportunity cannot fund another, so the ceiling is real in a way the
-- research allowances are not.
--
-- It is also the place where this Brain runs out of capability, and the row is
-- shaped so that saying so is a state rather than a silence. `BLOCKED` carries
-- a named blocker and its detail, because "no commercial grant exists" and "no
-- capability can publish a listing" are two facts with two different remedies,
-- and a single "blocked" sends somebody to fix the wrong one. §24's rule that
-- every escalation needs an answering transition, at the step that actually
-- spends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_tests (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  proposition_id  TEXT NOT NULL REFERENCES commerce_propositions(id),

  state           TEXT NOT NULL CHECK (state IN (
                    'BLOCKED', 'AUTHORIZED', 'RUNNING', 'SETTLED', 'ABANDONED')),

  -- What a person said may be spent. Never a figure Brain chose, and never
  -- released by a clock — §30's rule that a commitment is settled when the
  -- spend happened or released by a person who knows it did not.
  ceiling_minor   INTEGER NOT NULL CHECK (ceiling_minor >= 0),
  authority_id    TEXT,
  commitment_id   TEXT,

  blocker_kind    TEXT,
  blocker_detail  TEXT,

  -- What ends it, stated before it starts. A test with no stopping rule is
  -- spending with a story attached.
  stop_rule       TEXT NOT NULL,

  authorized_by   TEXT,

  opened_at       TEXT NOT NULL,
  settled_at      TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  -- A blocked test names what blocked it, and an unblocked one names nothing.
  CHECK ((state = 'BLOCKED') = (blocker_kind IS NOT NULL)),
  -- Nothing may be authorized to spend without a grant and a person behind it.
  CHECK (state = 'BLOCKED' OR (authority_id IS NOT NULL AND authorized_by IS NOT NULL)),
  CHECK ((state = 'SETTLED') = (settled_at IS NOT NULL))
);

-- At most one live test per proposition. Two bounded tests of one thing at
-- once are two ceilings against one question, and neither result could be
-- attributed. A settled or abandoned one keeps its row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_tests_live
  ON commerce_tests(proposition_id)
  WHERE state IN ('BLOCKED', 'AUTHORIZED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_commerce_tests_project
  ON commerce_tests(project_id, state);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `opportunity_signal`'s shape and `structural_finding`'s, a third time. A
-- commercial fact about a product, a channel or a supplier is established by
-- whoever read the source; Brain's part is to insist the declaration exists
-- and to match it exactly.
--
-- A separate column family rather than more values in `structural_finding`,
-- deliberately. The two vocabularies answer different questions — how an
-- industry is put together, against what it costs to sell one thing on one
-- channel — and a claim can carry both. One column would have made the
-- industry kernel's `absorb` skip the commerce kinds and this one skip the
-- structural kinds, which is two readers of one column disagreeing about what
-- it means.
--
-- Every row written before this migration carries NULL and therefore
-- establishes nothing commercial, which is correct rather than a gap: nobody
-- was asked.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN commerce_finding TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_subject TEXT;

-- The channel a PRODUCT_CANDIDATE is sold on, and null for every other kind.
ALTER TABLE research_claims ADD COLUMN commerce_qualifier TEXT;

-- The four shapes, in four columns. See the evidence table above for why.
ALTER TABLE research_claims ADD COLUMN commerce_amount_minor INTEGER
  CHECK (commerce_amount_minor IS NULL OR commerce_amount_minor >= 0);
ALTER TABLE research_claims ADD COLUMN commerce_rate_ppm INTEGER
  CHECK (commerce_rate_ppm IS NULL OR (commerce_rate_ppm >= 0 AND commerce_rate_ppm <= 1000000));
ALTER TABLE research_claims ADD COLUMN commerce_days INTEGER
  CHECK (commerce_days IS NULL OR commerce_days >= 0);
ALTER TABLE research_claims ADD COLUMN commerce_count INTEGER
  CHECK (commerce_count IS NULL OR commerce_count >= 0);
