-- ---------------------------------------------------------------------------
-- THE FAST CONVERSATION LANE, AND WHAT IT MAY SPEND
--
-- Every Russell reply so far has been carried by a Cowork Routine: a bin, a
-- dispatch, an activation, three minutes. That proved the execution path and
-- it is not a conversation. This schema is the seam for a direct, streamed
-- reply — and, far more importantly, the boundary around what such a reply is
-- allowed to cost.
--
-- The spending design is the whole point of the migration, so the reasoning is
-- here rather than spread across the code that uses it.
--
-- **Nothing spends by default.** An authorization is a row a person creates,
-- naming the owner, the provider, the exact model ids, an amount, a period and
-- when it takes effect. Its ceiling defaults to zero and it is created
-- disabled. Having an API key present is not an authorization and never
-- becomes one: the key is a capability, the row is the permission, and
-- conflating them is how a system starts spending because somebody set an
-- environment variable.
--
-- **Over-spending is impossible rather than merely untested.** The ledger
-- carries a CHECK that held plus settled may not exceed the ceiling, so the
-- database refuses an over-commit even if every line of application code above
-- it is wrong. The application still guards the arithmetic in the WHERE clause,
-- because a clean refusal is a better outcome than a constraint violation —
-- but the constraint is what makes the guarantee true.
--
-- **A reservation is taken before the call and reconciled after it.** The
-- worst case is reserved: the maximum billable input and output at the
-- version of the pricing in force. Concurrent calls therefore cannot
-- collectively exceed the ceiling, which they could if each checked a total
-- and then spent.
--
-- **An unknown outcome keeps its hold.** Step 6 settled this: a timeout is not
-- evidence that nothing happened, and neither is a reset. A reservation whose
-- call did not return a usage report goes to UNKNOWN and stays held until
-- something authoritative settles it. Releasing it would be assuming the money
-- was not spent, which is the assumption most likely to be wrong.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- WHAT MAY BE CALLED, AND WHAT IT COSTS
--
-- Pricing is versioned and dated because it changes, and a reservation made
-- against a stale price is an under-reservation. `pricing_version` is part of
-- the unique key so a new price is a new row and the old one still explains
-- every reservation taken against it.
--
-- Nothing here is a default. A catalogue with no enabled row means no model
-- may be called, which is the correct state for a Brain nobody has authorized
-- to spend anything.
-- ---------------------------------------------------------------------------
CREATE TABLE llm_models (
  id                     TEXT PRIMARY KEY,

  provider               TEXT NOT NULL,
  -- The provider's own identifier, exactly. Never an alias: an alias is a
  -- moving target and a price is attached to a specific model.
  model_id               TEXT NOT NULL,
  label                  TEXT NOT NULL,

  -- Which lane this model is a candidate for. A model may be listed for both
  -- by having two rows; the router picks, and no lane has a hardcoded model.
  lane                   TEXT NOT NULL,

  -- Micro-dollars per million tokens, as integers. Floating point money is a
  -- rounding error waiting to become a billing dispute.
  input_micros_per_mtok  INTEGER NOT NULL,
  output_micros_per_mtok INTEGER NOT NULL,
  pricing_version        TEXT NOT NULL,
  pricing_as_of          TEXT NOT NULL,

  max_output_tokens      INTEGER NOT NULL,
  context_tokens         INTEGER NOT NULL,

  -- Disabled until somebody enables it, like everything else here.
  enabled                INTEGER NOT NULL DEFAULT 0,

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  UNIQUE (provider, model_id, pricing_version),
  CHECK (lane IN ('FAST','DEEP')),
  CHECK (input_micros_per_mtok >= 0 AND output_micros_per_mtok >= 0),
  CHECK (max_output_tokens > 0 AND context_tokens > 0),
  CHECK (enabled IN (0,1))
);
CREATE INDEX idx_llm_models_lane ON llm_models (lane, enabled);

-- ---------------------------------------------------------------------------
-- PERMISSION TO SPEND
--
-- One row per owner per provider. `enabled` and `ceiling_micros` both default
-- to the refusing value, and `allowed_model_ids` is an explicit list rather
-- than "everything enabled in the catalogue" — so enabling a new model does
-- not silently widen an existing authorization.
-- ---------------------------------------------------------------------------
CREATE TABLE spend_authorizations (
  id                TEXT PRIMARY KEY,

  -- Whose allowance this is. A human, never a worker: a machine that could
  -- authorize its own spending is a machine whose theft is unbounded.
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,

  -- JSON array of llm_models.id. Empty means nothing may be called.
  allowed_model_ids TEXT NOT NULL DEFAULT '[]',

  ceiling_micros    INTEGER NOT NULL DEFAULT 0,
  -- DAY, MONTH or TOTAL. The period decides the ledger's key.
  period            TEXT NOT NULL DEFAULT 'MONTH',

  effective_from    TEXT NOT NULL,
  effective_until   TEXT,

  enabled           INTEGER NOT NULL DEFAULT 0,

  -- Who granted it and why, for the audit. Never inferred.
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason            TEXT NOT NULL,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  CHECK (ceiling_micros >= 0),
  CHECK (period IN ('DAY','MONTH','TOTAL')),
  CHECK (enabled IN (0,1))
);
CREATE INDEX idx_spend_auth_owner ON spend_authorizations (owner_user_id, provider, enabled);

-- ---------------------------------------------------------------------------
-- THE LEDGER
--
-- One row per authorization per period. The CHECK is the guarantee: no
-- combination of concurrent callers, retries or application bugs can make
-- held + settled exceed the ceiling, because the database will not store it.
-- ---------------------------------------------------------------------------
CREATE TABLE spend_ledger (
  id                TEXT PRIMARY KEY,
  authorization_id  TEXT NOT NULL REFERENCES spend_authorizations(id) ON DELETE CASCADE,
  -- '2026-09-04', '2026-09' or 'TOTAL', from the authorization's period.
  period_key        TEXT NOT NULL,

  -- Copied when the row is created, so a later change to the authorization
  -- cannot retroactively make an already-committed period over budget.
  ceiling_micros    INTEGER NOT NULL,

  held_micros       INTEGER NOT NULL DEFAULT 0,
  settled_micros    INTEGER NOT NULL DEFAULT 0,

  -- The compare-and-swap value. A reservation is a guarded UPDATE on it, so
  -- two callers reading the same total cannot both commit.
  generation        INTEGER NOT NULL DEFAULT 0,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  UNIQUE (authorization_id, period_key),
  CHECK (held_micros >= 0),
  CHECK (settled_micros >= 0),
  CHECK (held_micros + settled_micros <= ceiling_micros)
);

-- ---------------------------------------------------------------------------
-- ONE RESERVATION
--
-- Created before the provider is called, settled from the provider's own usage
-- report afterwards. `idempotency_key` is unique, so a retried attempt reserves
-- once — the Step 6 rule at a smaller scale.
-- ---------------------------------------------------------------------------
CREATE TABLE spend_reservations (
  id                   TEXT PRIMARY KEY,
  authorization_id     TEXT NOT NULL REFERENCES spend_authorizations(id) ON DELETE CASCADE,
  ledger_id            TEXT NOT NULL REFERENCES spend_ledger(id) ON DELETE CASCADE,

  owner_user_id        TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id      TEXT REFERENCES russell_conversations(id) ON DELETE SET NULL,

  model_row_id         TEXT NOT NULL REFERENCES llm_models(id) ON DELETE RESTRICT,
  -- The price actually used, copied, so the arithmetic is reproducible after
  -- the catalogue moves on.
  input_micros_per_mtok  INTEGER NOT NULL,
  output_micros_per_mtok INTEGER NOT NULL,
  pricing_version        TEXT NOT NULL,

  max_input_tokens     INTEGER NOT NULL,
  max_output_tokens    INTEGER NOT NULL,
  reserved_micros      INTEGER NOT NULL,

  -- HELD      the money is committed and the call has not reported back
  -- SETTLED   the provider reported usage and the difference was released
  -- RELEASED  the call provably never happened, so nothing was spent
  -- UNKNOWN   the outcome is not known; the hold stays until a person settles it
  state                TEXT NOT NULL DEFAULT 'HELD',

  actual_input_tokens  INTEGER,
  actual_output_tokens INTEGER,
  actual_micros        INTEGER,
  outcome_reason       TEXT,

  idempotency_key      TEXT NOT NULL UNIQUE,

  created_at           TEXT NOT NULL,
  settled_at           TEXT,

  CHECK (reserved_micros >= 0),
  CHECK (state IN ('HELD','SETTLED','RELEASED','UNKNOWN')),
  -- A settled reservation has an answer; an unsettled one does not pretend to.
  CHECK ((state = 'SETTLED') = (actual_micros IS NOT NULL))
);
CREATE INDEX idx_spend_res_ledger ON spend_reservations (ledger_id, state);
CREATE INDEX idx_spend_res_owner ON spend_reservations (owner_user_id, created_at);

-- ---------------------------------------------------------------------------
-- THE TEACHER LOOP
--
-- A fast reply may be reviewed later by something stronger. Two rules shape
-- these tables.
--
-- A review reads a **manifest** — the specific turns, compiled for one purpose
-- — rather than a conversation. Handing a whole private transcript to whichever
-- worker has capacity is exactly the disclosure the conversation boundary
-- exists to prevent, and spare capacity is not a reason to widen it.
--
-- A lesson becomes a **pending rule**, never a rule. One reviewer proposing
-- something is a proposal; a permanent change to how Russell behaves goes
-- through the same authority path everything else does.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_reviews (
  id                TEXT PRIMARY KEY,

  conversation_id   TEXT NOT NULL REFERENCES russell_conversations(id) ON DELETE CASCADE,
  -- The conversation's own version at the moment the manifest was compiled.
  -- At most one pending review per version, so a busy conversation does not
  -- fire a Routine after every reply.
  conversation_version INTEGER NOT NULL,

  -- The message ids the reviewer may see, as JSON. Never "the conversation".
  manifest          TEXT NOT NULL DEFAULT '[]',
  -- Inherited from the conversation and never widened.
  visibility        TEXT NOT NULL,
  -- The scope a reviewing worker must be authorized for.
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,

  -- PENDING | RUNNING | DONE | REFUSED
  state             TEXT NOT NULL DEFAULT 'PENDING',
  -- PASS | CORRECT | RESEARCH | PLAN | CAPTURE | IGNORE
  classification    TEXT,
  findings          TEXT NOT NULL DEFAULT '[]',
  reviewer_note     TEXT,

  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  requested_by      TEXT NOT NULL DEFAULT 'AUTOMATIC',

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,

  UNIQUE (conversation_id, conversation_version),
  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (state IN ('PENDING','RUNNING','DONE','REFUSED')),
  CHECK (classification IS NULL
         OR classification IN ('PASS','CORRECT','RESEARCH','PLAN','CAPTURE','IGNORE')),
  CHECK (requested_by IN ('AUTOMATIC','USER'))
);
CREATE INDEX idx_conv_reviews_state ON conversation_reviews (state, created_at);

-- A lesson somebody may one day accept. Versioned, attributed, reversible.
CREATE TABLE russell_rules (
  id             TEXT PRIMARY KEY,

  scope          TEXT NOT NULL,
  scope_id       TEXT,

  statement      TEXT NOT NULL,
  rationale      TEXT NOT NULL,

  -- PROPOSED | ACCEPTED | REJECTED | SUPERSEDED
  state          TEXT NOT NULL DEFAULT 'PROPOSED',
  version        INTEGER NOT NULL DEFAULT 1,
  supersedes_id  TEXT REFERENCES russell_rules(id) ON DELETE SET NULL,

  -- Where it came from. A rule with no traceable origin is a rule nobody can
  -- argue with.
  review_id      TEXT REFERENCES conversation_reviews(id) ON DELETE SET NULL,
  proposed_by    TEXT NOT NULL,

  decided_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TEXT,
  decision_note  TEXT,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  CHECK (scope IN ('GLOBAL','PROJECT','CONVERSATION')),
  CHECK (state IN ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED')),
  -- A decided rule names who decided it. Nothing becomes permanent anonymously.
  CHECK ((state IN ('ACCEPTED','REJECTED')) = (decided_at IS NOT NULL))
);
CREATE INDEX idx_russell_rules_state ON russell_rules (state, scope, scope_id);
