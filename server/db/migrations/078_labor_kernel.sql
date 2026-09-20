-- ---------------------------------------------------------------------------
-- THE HUMAN COMPARATIVE-ADVANTAGE AND LABOR ALLOCATION KERNEL
--
-- Brain knows what it wants to produce and it has never held a row saying
-- *who or what produces it*. The nearest thing is `cash_opportunities`'
-- `fulfillment_owner` — one free-text line per opening, answered by whoever
-- filled the card in, with no vocabulary, no test, no blocker and no way to
-- ask the question across a portfolio. So "which of the things we do still
-- need a person, and why" has no answer, and neither does "which of them has
-- stopped needing one".
--
-- §38 added the axis that says *where* to look. This one adds the axis that
-- says *by whom the work is produced*, and four rules decided every column.
--
-- 1. THE DEFAULT IS A BURDEN OF PROOF, NOT AN ASSUMPTION. The brief's prime
--    directive is that Brain is the production layer and human labor is an
--    escalation layer. That is a statement about who has to justify
--    themselves, and it would be a disaster read as a licence to assume: a
--    task moved to Brain on a hunch is work that silently stops being done, or
--    is done without the licence, signature or presence somebody is legally
--    owed. So a human layer cannot be recorded without naming which of the six
--    reasons justifies it — the CHECK on `labor_allocations` — and a BRAIN
--    allocation Brain writes for itself is refused unless the necessity test
--    is actually settled. The burden is asymmetric in the schema, not in a
--    comment.
--
-- 2. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION, AND THE FAVOURABLE
--    DIRECTION HERE IS *TOWARDS BRAIN*. §30 and §38 both record this rule at a
--    money figure, where an understated cost makes a piece look executable.
--    Here the cheap-looking answer is "Brain can do it", and the cost of being
--    wrong is an output nobody produces. `labor_necessity_answers.answer` has
--    a literal `UNKNOWN`, and `necessity.ts` will not let one stand in for the
--    answer that would move a task to Brain. Invariant 39 at the column that
--    decides whether a person is needed.
--
-- 3. WHAT CAN BE DERIVED IS NOT STORED. There is no automation percentage, no
--    compression score, no "how close is Brain" number and no current-layer
--    column on the task. `basis` has no `DERIVED` value **on purpose**: an
--    answer Brain can read from its own rows — can it produce this output, can
--    a second session independently verify it — is re-read on every pass and
--    can never be written down, so a capability that came back cannot leave a
--    stale YES behind it. §38's third rule, where staleness reads as capacity
--    Brain does not have.
--
-- 4. A ROLE IS COMPRESSED BY HISTORY, SO HISTORY IS NEVER OVERWRITTEN. §7 of
--    the brief is the whole reason this kernel exists rather than a column:
--    "where Brain improvements have reduced human workload" is unanswerable
--    from current state, because current state is exactly what forgot. Both
--    `labor_allocations` and `labor_necessity_answers` are append-only with a
--    superseding pointer, so what was believed when a decision was made is
--    still there when the decision is questioned. §5, at a decision rather
--    than at a run.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- A WORKFLOW
--
-- One named thing this operation produces, end to end. Two ways in and no
-- third, because both are honest and nothing else would be.
--
--   SEED     a person named it. §2 of the brief is a design act — "if this
--            business were invented today with Brain available from its first
--            day, how would it operate" — and no amount of reading rows
--            answers it. A Brain that decomposed a business out of a sentence
--            somebody wrote would be §8's model prose deciding what exists.
--
--   DERIVED  a qualified opening declares the capabilities delivering it
--            requires, and each of those is a unit of production. That is a
--            derivation over rows rather than a reading of prose: the column
--            is already there, `readCapability` already answers it, and
--            `operate.ts` already raises a need from it. So the kernel is live
--            on the portfolio that exists rather than waiting for somebody to
--            type it in.
--
-- There is no third origin and in particular no origin meaning "Brain thought
-- there should be one".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_workflows (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  name            TEXT NOT NULL,
  -- What the workflow is for, in the words a person decides in. A name is an
  -- index and the sentence is the understanding — §11's rule, at a workflow.
  description     TEXT,

  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'DERIVED')),

  -- The opening this workflow delivers. Required for a DERIVED workflow,
  -- because that row is the only thing that can say what it was derived from;
  -- permitted on a seeded one, because a person may well be describing how an
  -- opening already found would actually be delivered.
  opportunity_id  TEXT REFERENCES cash_opportunities(id),

  -- Who named it. Attribution, never authentication — §23's column pair, and
  -- the authority was decided by the route before this row existed.
  declared_by_ref TEXT,

  -- A person deciding this is no longer how the work is done. Not a delete,
  -- for `industry_nodes`' reason: a retired workflow is evidence about what
  -- was tried, and deleting it would let the same one arrive again as a fresh
  -- derivation on the next tick.
  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR opportunity_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

-- One workflow per name per project, and one per opening. Both are the arbiter
-- for two ticks deriving the same thing — the ninth time this repository has
-- needed a compare-and-swap on a value the claimant does not supply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_workflows_name
  ON labor_workflows(project_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_workflows_opportunity
  ON labor_workflows(opportunity_id) WHERE opportunity_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- A TASK
--
-- One unit of production inside a workflow, and the thing the whole Human
-- Necessity Test is asked about.
--
-- `output` is NOT NULL and it is question 1 of that test: *what exact output
-- is this producing?* A task whose output nobody can state cannot be tested at
-- all — every one of the remaining eleven questions is about that output — so
-- there is no way to write one without it. The brief asks the question first
-- for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  workflow_id     TEXT NOT NULL REFERENCES labor_workflows(id),

  name            TEXT NOT NULL,
  output          TEXT NOT NULL,

  origin          TEXT NOT NULL CHECK (origin IN ('SEED', 'DERIVED')),

  -- The capability a derived task is the production of. Required for DERIVED,
  -- because it is what `readCapability` is asked about — and asking it is how
  -- question 2 gets a derived answer instead of a guess.
  capability_id   TEXT,

  declared_by_ref TEXT,

  retired_at      TEXT,
  retired_reason  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (origin = 'SEED' OR capability_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_tasks_name
  ON labor_tasks(workflow_id, name);

CREATE INDEX IF NOT EXISTS idx_labor_tasks_project
  ON labor_tasks(project_id);


-- ---------------------------------------------------------------------------
-- WHO PRODUCES IT, AND WHY THAT IS NOT BRAIN
--
-- Append-only, with one live row per task. The superseding pointer is what
-- makes §7's *role compression* answerable: "this task was OFFSHORE_HUMAN for
-- EXCEPTION_HANDLING until March and is BRAIN now" is a fact about two rows,
-- and a table that overwrote would have destroyed the only evidence that
-- anything improved.
--
-- The CHECK is the brief's prime directive as a constraint rather than as a
-- paragraph: **a human layer cannot be recorded without naming which of the
-- six reasons justifies it.** There is deliberately no reason meaning "this is
-- how it has always been done", so the historical answer has nowhere to go —
-- §38's closed-vocabulary rule, whose failure mode is missing a real reason
-- rather than admitting a habit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_allocations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  task_id          TEXT NOT NULL REFERENCES labor_tasks(id),

  -- What kind of producer. Not *how they are engaged* — that is the sourcing
  -- channel on `labor_market_options`, and conflating the two is how "we use
  -- an agency" comes to stand in for "a person is necessary here".
  production_layer TEXT NOT NULL CHECK (production_layer IN (
                     'BRAIN', 'SOFTWARE_TOOL', 'EXTERNAL_SERVICE',
                     'OFFSHORE_HUMAN', 'DOMESTIC_HUMAN',
                     'SPECIALIST_PROFESSIONAL', 'PHYSICAL_OPERATOR')),

  -- §3's six classes, and required exactly when the layer is a person.
  necessity_reason TEXT CHECK (necessity_reason IN (
                     'HUMAN_INTERFACE', 'EXPERT_JUDGMENT',
                     'ACCOUNTABILITY_LICENSING', 'PHYSICAL_EXECUTION',
                     'EXCEPTION_HANDLING', 'OVERSIGHT_VERIFICATION')),

  -- BRAIN or PERSON, and there is no third value because *we think it is
  -- probably Brain's* is not a decision. §30 drew the same line on
  -- `cash_actions.performed_by`.
  decided_by       TEXT NOT NULL CHECK (decided_by IN ('BRAIN', 'PERSON')),
  decided_by_ref   TEXT,

  -- Why, in words, at the moment it was decided. The allocator is derived from
  -- rows that move, so this is `services/dispatch/router.ts`' promise kept one
  -- table along: the reason resolves to a sentence written when the decision
  -- was made rather than to a re-run against a database that has changed.
  rationale        TEXT NOT NULL,

  supersedes_id    TEXT REFERENCES labor_allocations(id),
  superseded_at    TEXT,

  created_at       TEXT NOT NULL,

  CHECK ((production_layer IN ('BRAIN', 'SOFTWARE_TOOL', 'EXTERNAL_SERVICE'))
         = (necessity_reason IS NULL))
);

-- Exactly one live allocation per task. This is the arbiter, so two ticks both
-- deciding correctly produce one row and the loser is an ordinary outcome.
CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_allocations_live
  ON labor_allocations(task_id) WHERE superseded_at IS NULL;

-- One successor per allocation, so a history is a chain rather than a tree.
CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_allocations_supersedes
  ON labor_allocations(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_labor_allocations_task
  ON labor_allocations(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_labor_allocations_project
  ON labor_allocations(project_id);


-- ---------------------------------------------------------------------------
-- THE HUMAN NECESSITY TEST, AND ONLY THE HALF NOBODY CAN DERIVE
--
-- Twelve questions, and this table holds answers to at most ten of them. Two
-- are read from Brain's own rows on every pass and are never written here:
-- whether Brain can currently produce the output (`readCapability`), and
-- whether another session could independently verify it (`separationCapacity`,
-- the same reading `auditAdmission` uses). Storing either would be a memory of
-- a reading rather than a reading — and a fleet that lost its last healthy
-- surface an hour ago would still be reported as able to produce.
--
-- That is why `basis` has no `DERIVED` value. The rule is structural: there is
-- nowhere to put a derived answer, so nothing can accidentally put one there.
--
-- Append-only, for `labor_allocations`' reason. An allocation's rationale
-- cites what was believed when it was made, and an answer that overwrote would
-- make every past rationale unverifiable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_necessity_answers (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  task_id         TEXT NOT NULL REFERENCES labor_tasks(id),

  question        TEXT NOT NULL CHECK (question IN (
                    'BRAIN_IS_FASTER', 'BRAIN_IS_CHEAPER',
                    'BRAIN_QUALITY_AT_LEAST_EQUAL', 'BRAIN_CAN_SELF_VERIFY',
                    'REQUIRES_PHYSICAL_PRESENCE', 'REQUIRES_LICENSED_HUMAN',
                    'HUMAN_INTERACTION_ADDS_VALUE', 'HANDLES_ONLY_EXCEPTIONS')),

  -- `UNKNOWN` is a real answer and is written deliberately: *we looked and
  -- nothing settles it* is a different fact from *nobody has looked*, which is
  -- the absence of a row. §30's distinction, at the test that decides whether
  -- a person is needed.
  answer          TEXT NOT NULL CHECK (answer IN ('YES', 'NO', 'UNKNOWN')),

  basis           TEXT NOT NULL CHECK (basis IN ('RESEARCHED', 'PERSON')),
  statement       TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  answered_by_ref TEXT,

  superseded_at   TEXT,
  created_at      TEXT NOT NULL,

  CHECK ((basis = 'RESEARCHED') = (source_claim_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_necessity_live
  ON labor_necessity_answers(task_id, question) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_labor_necessity_task
  ON labor_necessity_answers(task_id, created_at);


-- ---------------------------------------------------------------------------
-- WHERE THE CAPABILITY COULD BE SOURCED, IF A PERSON IS NEEDED
--
-- §4 of the brief: once a human is established as necessary, do not assume
-- that human is domestic or full-time. One row per published option, from a
-- gated claim, exactly as `capital_structures` holds one row per published
-- financing practice — and for the same reason: a task can have several real
-- answers and the honest output is all of them with their sources, never the
-- cheapest one silently chosen.
--
-- A rate with no basis is refused by the CHECK. "$40" is not comparable to
-- anything; "$40 per hour" is. §30's `figures.ts` refuses a bare number for
-- the same reason one layer up, and the failure mode here is deliberately
-- *missing a rate* rather than holding one nobody can use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_market_options (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  task_id         TEXT NOT NULL REFERENCES labor_tasks(id),

  channel         TEXT NOT NULL CHECK (channel IN (
                    'OFFSHORE_CONTRACTOR', 'OFFSHORE_EMPLOYEE',
                    'SPECIALIST_FREELANCER', 'DOMESTIC_CONTRACTOR',
                    'DOMESTIC_EMPLOYEE', 'LICENSED_PROFESSIONAL',
                    'FRACTIONAL_SPECIALIST', 'ON_DEMAND_OPERATOR',
                    'AGENCY_OR_VENDOR', 'MANAGED_SERVICE', 'SOFTWARE_TOOL')),

  -- Where, as the source names it. Free text and nullable, because §4's own
  -- list of things to weigh includes regulatory and data-access restrictions,
  -- and a source that names no jurisdiction has not established one.
  jurisdiction    TEXT,

  -- What a published source says it costs, in minor units. NULL is unknown and
  -- never zero, for rule 2 above: a blank rate that read as free would make the
  -- cheapest-looking option the one nobody had costed.
  rate_cents      INTEGER CHECK (rate_cents IS NULL OR rate_cents >= 0),
  rate_basis      TEXT CHECK (rate_basis IN (
                    'PER_HOUR', 'PER_UNIT', 'PER_MONTH', 'PER_ENGAGEMENT')),

  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (rate_cents IS NULL OR rate_basis IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_options_claim
  ON labor_market_options(task_id, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_labor_options_task
  ON labor_market_options(task_id, channel);


-- ---------------------------------------------------------------------------
-- WHAT HAS BEEN ASKED ABOUT WHICH TASK
--
-- `industry_rounds`' shape, with one column deliberately absent: there is no
-- `cash_mode_id` here, and that is a decision rather than an omission.
--
-- A labor question is about how work Brain has already committed to is
-- actually produced. It finds no opening and creates no obligation, so §30's
-- wind-down guard — which exists to stop a sprint *discovering* more after
-- somebody said stop — does not own it. §30 records its own correction on
-- exactly this point: an off switch that stopped work it did not own reached
-- past the thing it owns. What does bound a round is the project's standing
-- research authority, which is what authorizes spending anything at all, and
-- the concurrency ceiling.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labor_rounds (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT NOT NULL REFERENCES labor_tasks(id),

  --  NECESSITY  what published rule requires a person for work of this kind
  --  MARKET     who supplies this capability, where, and at what published rate
  --  PRECEDENT  whether this work is published as being done without a person
  purpose       TEXT NOT NULL CHECK (purpose IN ('NECESSITY', 'MARKET', 'PRECEDENT')),

  round         INTEGER NOT NULL CHECK (round >= 1),
  candidate_id  TEXT NOT NULL,

  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,

  -- NULL while OPEN rather than 0. §33 records what a default published as a
  -- measurement costs: every live round reported "0 found" about work that had
  -- produced the whole portfolio.
  found         INTEGER,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_rounds_ask
  ON labor_rounds(project_id, task_id, purpose, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_rounds_candidate
  ON labor_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_labor_rounds_project
  ON labor_rounds(project_id, state);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `opportunity_signal`'s shape and `structural_finding`'s, one axis along, for
-- their exact reason. §33 records what the alternative costs: `harvest`
-- decided "is this an opening" by matching a lane id against a literal,
-- planners name their own lanes, and the bridge could never fire.
--
-- Four columns rather than a reuse of the structural ones, because a field
-- with two masters is invariant 31 and one vocabulary validating two
-- unrelated closed sets is how a refusal stops naming the right thing. Every
-- row written before this migration carries NULL and therefore establishes
-- nothing about labor, which is correct rather than a gap: nobody was asked.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN labor_finding TEXT;

-- What the finding is about, always from a closed set: a human requirement
-- names which of the six reasons, a sourcing channel names which of the
-- eleven. What the source actually said — which regulator, which agency,
-- which tool — is in the claim itself, which is where a sentence belongs.
ALTER TABLE research_claims ADD COLUMN labor_subject TEXT;

-- The rate basis a SOURCING_CHANNEL's figure is quoted on. Null for every
-- other kind, and required alongside a rate: reading "per hour" out of the
-- claim sentence would be the prose-parsing §25's Westbrook defect records, at
-- the one place where getting it wrong changes a comparison by an order of
-- magnitude.
ALTER TABLE research_claims ADD COLUMN labor_qualifier TEXT;

-- What a published source says this channel charges, in minor units.
-- Nullable, and the nullability is the feature: `describeMarket` reports a
-- channel with no published rate as *available at an unknown rate* rather than
-- leaving it out or treating the blank as cheap.
ALTER TABLE research_claims ADD COLUMN labor_rate_cents INTEGER
  CHECK (labor_rate_cents IS NULL OR labor_rate_cents >= 0);
