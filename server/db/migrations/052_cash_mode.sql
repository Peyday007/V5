-- Cash Mode: a temporary operating section inside the broader Brain.
--
-- Seven tables, and the shape of every one of them is decided by a distinction
-- this codebase has already had to draw somewhere else.
--
-- ---------------------------------------------------------------------------
-- Why this is not a second Brain
-- ---------------------------------------------------------------------------
--
-- Nothing here holds an identity, a membership, a credential, a work item, a
-- lease, a research fragment or an audit. A person is a `users` row, privacy is
-- a `project_memberships` row read through `decideProjectAccess`, discovery is
-- the Russell candidate -> judgment -> mission path that already exists, and
-- execution is the fleet. What these tables add is the one thing Brain has
-- never held: **money, and the authority to spend it**.
--
-- ---------------------------------------------------------------------------
-- Why the ceilings here are real, when 12A's were removed
-- ---------------------------------------------------------------------------
--
-- §24 removed the lifetime quotas from `russell_goals` because nothing they
-- rationed was scarce: the subscription behind a research mission is already
-- paid for, so a count of missions measured a starting point and then became a
-- permanent ceiling. Cash is the opposite fact. A dollar committed to one
-- opportunity is a dollar that cannot fund another, and a ceiling on it is the
-- difference between a bounded sprint and an unbounded one. So
-- `cash_authorities` is genuinely capped, and `cash_commitments` is how the cap
-- is spent — by insert rather than by count, for the reason every claim in this
-- repository is: two workers may both read the same remaining balance, and only
-- one row can win a unique key.
CREATE TABLE IF NOT EXISTS cash_modes (
  id                    TEXT PRIMARY KEY,

  -- One per project, and the project is the privacy boundary. Four people means
  -- four projects, not four columns: membership is already read on every
  -- request, already refuses with the same 404 a missing project gives, and
  -- already covers conversations, search, exports and worker context. A
  -- second scoping mechanism beside it would be the weaker of the two.
  project_id            TEXT NOT NULL UNIQUE REFERENCES projects(id),

  -- Whose sprint this is. Attribution, never authorization: what a caller may
  -- do here is decided by `decideProjectAccess` against the principal, and this
  -- column is read by nothing that grants anything.
  owner_user_id         TEXT NOT NULL,

  -- The precise objective (§1 of the plan), in the owner's words.
  objective             TEXT NOT NULL,

  -- The rolling planning outlook, in days. A view over the portfolio and never
  -- an eligibility gate: an opening that expires sooner is surfaced earlier,
  -- and one that pays later is still worth assembling.
  horizon_days          INTEGER NOT NULL,

  -- Which in-code approval envelope this project's compiled discovery missions
  -- run under. The *set* of envelopes is code that somebody reviewed; which one
  -- a project uses is a person's recorded decision. Nobody supplies the limits
  -- their own plan is judged against, which is §16's whole argument, and a name
  -- that does not resolve in this build compiles nothing.
  envelope_id           TEXT NOT NULL,

  -- ACTIVE, WINDING_DOWN, ARCHIVED.
  --
  -- The only thing the last two stop is **new discovery**. Delivery,
  -- collection, settlement, needs, money and every existing opportunity keep
  -- working in all three, because a sprint ending is not a customer's
  -- obligation ending. Nothing here touches `russell_cycle`: pausing that
  -- singleton stops the entire Russell tick — writeback, request resumption,
  -- every other project — and connecting a mode's off switch to it would stop
  -- the Brain to end a sprint.
  state                 TEXT NOT NULL
                        CHECK (state IN ('ACTIVE', 'WINDING_DOWN', 'ARCHIVED')),

  activated_at          TEXT NOT NULL,
  wound_down_at         TEXT,
  archived_at           TEXT,
  state_reason          TEXT,

  created_by_user_id    TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- cash_authorities — the commercial contract, which `russell_goals` cannot be
-- ---------------------------------------------------------------------------
--
-- A 12A standing authority carries `ALWAYS_PROHIBITED`, which includes
-- `NEW_SPENDING`, `PURCHASE` and `CONTACT_PERSON`, and `max_external_spend` of
-- zero. That is not an oversight to be relaxed: those grants authorize reading
-- published sources, and widening one would silently widen every research
-- mission already running under it.
--
-- So a commercial authority is a *separate* grant, with its own actor, its own
-- ceilings and its own closed set of permitted actions, and it authorizes
-- nothing about research. A project may hold both; neither reads the other.
CREATE TABLE IF NOT EXISTS cash_authorities (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  owner_user_id            TEXT NOT NULL,
  name                     TEXT NOT NULL,

  policy_version           INTEGER NOT NULL,

  -- JSON array from `COMMERCIAL_ACTIONS` in services/cash/authority.ts. An
  -- action outside that closed set refuses the whole grant at creation, the
  -- same way an unknown field refuses a whole proposal.
  allowed_actions          TEXT NOT NULL,

  -- JSON array. Always a superset of `ALWAYS_PROHIBITED_COMMERCIAL`, unioned in
  -- at creation rather than checked separately, so a grant written by a script
  -- or a future screen cannot omit one by forgetting.
  prohibitions             TEXT NOT NULL,

  -- Cash the owner may have committed but not yet settled, at any one moment.
  -- This is the number that is actually scarce.
  max_committed_cents      INTEGER NOT NULL CHECK (max_committed_cents >= 0),

  -- The largest single commitment, so one action cannot take the whole ceiling.
  max_per_action_cents     INTEGER NOT NULL CHECK (max_per_action_cents >= 0),

  -- How many opportunities may be executing at once. Real fulfilment capacity,
  -- not a quota on how many may be *assembled*: the plan is explicit that
  -- stacking is the point and that the screen's focus is not a limit of one.
  max_concurrent           INTEGER NOT NULL CHECK (max_concurrent >= 0),

  currency                 TEXT NOT NULL,

  starts_at                TEXT NOT NULL,
  expires_at               TEXT,
  state                    TEXT NOT NULL
                           CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  revoked_at               TEXT,
  revoked_by_user_id       TEXT,
  revoked_reason           TEXT,

  created_by_user_id       TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_authorities_live
  ON cash_authorities(project_id, state, created_at);

-- ---------------------------------------------------------------------------
-- cash_opportunities — the portfolio
-- ---------------------------------------------------------------------------
--
-- The common transaction record §7 of the plan asks for, linked to the Brain
-- records that already exist rather than duplicating them: `candidate_id` is
-- the Russell idea this opportunity's discovery ran as, and
-- `external_record_id` is the connected site's own row when one is involved.
--
-- Every money column is integer cents. A floating-point dollar is a rounding
-- error that eventually reaches a customer.
--
-- `state` says where in the transaction this is. The **disposition** a person
-- reads — execute now, run in parallel, wait for a named dependency, test a
-- decisive unknown, archived — is derived on the read path from this row and
-- its dependencies, and is deliberately not stored: a row is not a decision,
-- and a stored label is stale the moment a dependency settles.
CREATE TABLE IF NOT EXISTS cash_opportunities (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id           TEXT NOT NULL REFERENCES cash_modes(id),
  owner_user_id          TEXT NOT NULL,

  title                  TEXT NOT NULL,

  -- Which of the plan's search buckets this came from, and where it was found.
  -- `mechanism` is from a closed set; `industry` and `source` are free text,
  -- because narrowing either would be inventing a preference the mandate
  -- explicitly refuses.
  mechanism              TEXT NOT NULL,
  industry               TEXT,
  source                 TEXT,

  -- The Russell idea whose discovery mission produced or advanced this, when
  -- one did. Null for an opportunity a person entered directly.
  candidate_id           TEXT,
  -- The connected site's record, when this came from one (§25).
  external_record_id     TEXT,

  -- The evidence card (§3). Nullable on purpose: an unanswered field is
  -- **unknown**, and `readyToTest` refuses an opportunity with an unknown in a
  -- load-bearing position rather than reading the blank as a favourable
  -- assumption.
  payer                  TEXT,
  reachable_channel      TEXT,
  buying_signal          TEXT,
  signal_observed_at     TEXT,
  offer_scope            TEXT,
  acceptance_condition   TEXT,
  price_cents            INTEGER,
  currency               TEXT NOT NULL,
  payment_terms          TEXT,
  fulfillment_owner      TEXT,
  delivery_method        TEXT,
  required_inputs        TEXT,
  deadline               TEXT,
  economics_note         TEXT,

  -- Maximum cash out before money is usable, and the human hours it costs.
  -- Tracked beside contribution because a profitable deal can still tie up the
  -- capital three faster ones needed.
  peak_funding_cents     INTEGER,
  human_hours            REAL,

  -- When the opening is expected to close. A temporary exploit records why it
  -- will disappear; that reason is what makes it schedulable rather than a
  -- guess.
  expires_at             TEXT,
  expiry_reason          TEXT,

  -- What this waits for, and what it duplicates. Both are opportunities, and
  -- both are how the portfolio sequences itself without a scheduler.
  depends_on_id          TEXT,
  duplicate_of_id        TEXT,

  -- JSON array of capability names this needs to execute. A name with no
  -- capability behind it becomes a `cash_needs` row rather than a silent block.
  required_capabilities  TEXT NOT NULL,

  execution_asset        TEXT,
  asset_revision         TEXT,

  state                  TEXT NOT NULL
                         CHECK (state IN (
                           'DISCOVERED',      -- found, card incomplete
                           'EVIDENCE_CARD',   -- card complete, not yet credible
                           'READY',           -- payer, offer, delivery and exposure all credible
                           'EXECUTING',       -- the transaction is being pursued
                           'DELIVERING',      -- paid or agreed; the obligation is being met
                           'COLLECTED',       -- money received, delivery done
                           'DECLINED',        -- this owner passed
                           'ARCHIVED'         -- stopped, with the reason on the row
                         )),

  -- A completed profitable one-off is a success and its opening being finished
  -- is a *separate* fact. Two columns rather than a state, so banking the cash
  -- and marking the mechanism exhausted never have to be the same event.
  exhausted_at           TEXT,
  exhausted_reason       TEXT,

  next_action            TEXT,
  next_action_due        TEXT,
  outcome                TEXT,
  stop_rule              TEXT,

  -- A declined opportunity may be offered privately to another person. Both
  -- ends are recorded: nothing moves between private operations without a row
  -- saying who moved it and why.
  declined_by_user_id    TEXT,
  declined_reason        TEXT,
  reoffered_from_id      TEXT,

  archived_reason        TEXT,

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_project
  ON cash_opportunities(project_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_candidate
  ON cash_opportunities(candidate_id);

-- ---------------------------------------------------------------------------
-- cash_commitments — the ceiling, spent by insert
-- ---------------------------------------------------------------------------
--
-- §6's rule that every expenditure answers "spend $X to remove this named
-- obstacle; expect this observable result; stop at this limit" is three NOT
-- NULL columns rather than a convention, because a convention is what the
-- fifth commitment stops following.
--
-- `UNIQUE (idempotency_key)` is what makes a retried request, a redelivered
-- queue item and a restart mid-request one commitment rather than three.
CREATE TABLE IF NOT EXISTS cash_commitments (
  id                 TEXT PRIMARY KEY,
  authority_id       TEXT NOT NULL REFERENCES cash_authorities(id),
  project_id         TEXT NOT NULL REFERENCES projects(id),
  opportunity_id     TEXT,

  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency           TEXT NOT NULL,

  purpose            TEXT NOT NULL,
  expected_result    TEXT NOT NULL,
  stop_condition     TEXT NOT NULL,

  idempotency_key    TEXT NOT NULL,

  state              TEXT NOT NULL CHECK (state IN ('HELD', 'SETTLED', 'RELEASED')),
  settled_at         TEXT,
  released_at        TEXT,
  release_reason     TEXT,

  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_commitments_key
  ON cash_commitments(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_cash_commitments_held
  ON cash_commitments(authority_id, state);

-- ---------------------------------------------------------------------------
-- cash_money_entries — append-only, and the only source of every figure
-- ---------------------------------------------------------------------------
--
-- §5's six numbers are *derived* from these rows and stored nowhere. A balance
-- column would be a second master for the same fact, and the one nobody reads
-- is the one that drifts — which is the argument `bin_events` already settled
-- for capacity.
--
-- Append-only means a correction is a new row. There is no UPDATE path to an
-- amount in this table and no DELETE: §5 says money events are append-only and
-- reconciled against the provider's own evidence, so a mistake stays visible
-- beside the entry that fixes it.
CREATE TABLE IF NOT EXISTS cash_money_entries (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  opportunity_id      TEXT,

  kind                TEXT NOT NULL CHECK (kind IN (
                        'CAPITAL_IN',          -- the account's own capital
                        'CAPITAL_OUT',
                        'PIPELINE_AGREED',     -- agreed work, no cash received
                        'CUSTOMER_PAYMENT',    -- verified payment, possibly still pending
                        'SETTLEMENT',          -- funds settled and usable
                        'REFUND',
                        'COST',                -- an incremental cost actually paid
                        'UNPAID_COMMITMENT',   -- a cost incurred and not yet paid
                        'COMMITMENT_PAID',
                        'RESERVE',             -- protected cash: delivery, tax, operating
                        'RESERVE_RELEASE'
                      )),

  -- Always positive. The kind decides the direction, so no entry can be made to
  -- mean its own opposite by sign.
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL,

  -- The provider or bank evidence. Required by `services/cash/money.ts` for a
  -- CUSTOMER_PAYMENT and a SETTLEMENT, because "verified payments" is the
  -- column's whole meaning and a payment nobody can trace is pipeline.
  verified_reference  TEXT,

  -- When the customer's money is expected to be usable. Recorded on the payment
  -- rather than assumed, because a first Stripe payout is typically scheduled
  -- to complete in 7-14 days and later ones follow the account's own schedule.
  funds_available_at  TEXT,

  occurred_at         TEXT NOT NULL,
  note                TEXT,
  recorded_by         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_money_project
  ON cash_money_entries(project_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_cash_money_opportunity
  ON cash_money_entries(opportunity_id, occurred_at);

-- ---------------------------------------------------------------------------
-- cash_needs — a missing capability, with somewhere to go
-- ---------------------------------------------------------------------------
--
-- The plan is exact about this and it is worth enforcing in the schema: an
-- explicit missing need is a valid execution state, and it must carry a
-- recommended way forward rather than a generic blocked label. So
-- `recommended_path` and `next_step` are NOT NULL, and the service refuses an
-- empty one — a need that names no remedy is §24's "waiting nobody can
-- resolve", at a new altitude.
--
-- A need never stops unrelated work. Nothing reads this table to decide whether
-- an opportunity may proceed; it is read by the review and by the opportunity
-- it names, and by nothing else.
CREATE TABLE IF NOT EXISTS cash_needs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  opportunity_id       TEXT,

  blocked_action       TEXT NOT NULL,
  why_it_matters       TEXT NOT NULL,
  recommended_path     TEXT NOT NULL,
  expected_cost_cents  INTEGER,
  setup_effort         TEXT NOT NULL,
  next_step            TEXT NOT NULL,

  state                TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED', 'WITHDRAWN')),
  resolution           TEXT,
  resolved_by_user_id  TEXT,
  resolved_at          TEXT,

  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_needs_open
  ON cash_needs(project_id, state, created_at);

-- ---------------------------------------------------------------------------
-- cash_events — append-only, and deliberately without foreign keys
-- ---------------------------------------------------------------------------
--
-- `identity_events`' reasoning, at a new subject: an audit row a cascade can
-- delete is not an audit row. Every meaningful change above writes one, so
-- "what did Brain do here, and on whose authority" is answerable from rows
-- after the opportunity it happened to has been archived.
CREATE TABLE IF NOT EXISTS cash_events (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  opportunity_id TEXT,
  kind           TEXT NOT NULL,
  -- Who this carries the authority of. A user id, or the literal 'BRAIN' for
  -- something Brain settled inside a standing authority. Never a credential.
  actor_ref      TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_events_project
  ON cash_events(project_id, created_at);
