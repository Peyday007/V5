-- The typed bridge from research evidence to a piece of the portfolio.
--
-- ---------------------------------------------------------------------------
-- The contract that could not be satisfied
-- ---------------------------------------------------------------------------
--
-- `harvest()` decided whether an accepted claim was an *opening* by comparing
-- its `evidence_lane` against one literal, `demand_signal`. Fragment planners
-- name their own lanes — that is the whole point of a lane, and the gate counts
-- coverage per declared id — so the two halves were never speaking about the
-- same vocabulary. Production wrote seventeen distinct lane ids across 82
-- claims (`payer_identity`, `task_listing`, `closing_date`, `payment_terms`, …)
-- and `demand_signal` appears exactly zero times. Not one claim this pipeline
-- can produce could ever have become an opportunity.
--
-- A wider string match would have been the wrong repair: it would make whether
-- something is a piece of work depend on how a planner happened to word a lane
-- id, which is model output deciding state.
--
-- ---------------------------------------------------------------------------
-- What replaces it
-- ---------------------------------------------------------------------------
--
-- A claim may carry an `opportunity_signal` from a closed set, validated
-- exactly on submission against `domain/opportunitySignals.ts`. It says what
-- *kind of opening* the claim establishes — active buyer demand, a paid task,
-- a pricing or information asymmetry, an expiring opening, a supply-demand
-- mismatch, a resalable asset, recurring outsourced work — and null says the
-- claim is descriptive evidence rather than an opening. Descriptive lanes are
-- untouched and still carry coverage; the two answer different questions and
-- both are kept.
--
-- Nothing about the evidence bar moves. A claim with a signal still passes the
-- seven gate conditions like any other, and a signal on a rejected claim
-- promotes nothing.
ALTER TABLE research_claims ADD COLUMN opportunity_signal TEXT;

-- Where a piece of the portfolio came from, in full.
--
-- `source_claim_id` has existed since 054 and was the only link. It is not
-- provenance: it resolves to a claim, and a reader asking "what research
-- established this, under what question, in which round" had to walk backwards
-- through a mission row that the operator-started packets do not have. Those
-- four production packets hold 69 accepted claims that `harvest` could not see
-- at all for exactly that reason.
--
-- These are the rest of the chain, written at promotion and never inferred
-- afterwards.
ALTER TABLE cash_opportunities ADD COLUMN orchestration_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN fragment_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN discovery_round_id TEXT;

-- What bounded validation this piece is waiting on, and what came back.
--
-- Discovery answers "somebody published a request". It does not answer who
-- pays, what to offer, what it costs or when the cash arrives, and forcing a
-- broad discovery fragment to answer all of that before it may report an
-- opening is what made discovery fragments impossible to satisfy. So the deep
-- dive is a *second*, bounded assignment against the piece itself, and this is
-- the column that says which one.
ALTER TABLE cash_opportunities ADD COLUMN validation_orchestration_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN validation_state TEXT;
ALTER TABLE cash_opportunities ADD COLUMN validation_started_at TEXT;
ALTER TABLE cash_opportunities ADD COLUMN validation_settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_validation
  ON cash_opportunities(project_id, validation_state);

-- One opportunity per supported opening, decided by the database.
--
-- `opportunityForClaim` was a SELECT followed by an INSERT, which is a window
-- two ticks can both pass through. The unique index is the arbiter, so a
-- duplicate promotion is an ordinary lost race rather than a second piece of
-- work in somebody's portfolio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_opportunities_one_per_claim
  ON cash_opportunities(project_id, source_claim_id)
  WHERE source_claim_id IS NOT NULL;
