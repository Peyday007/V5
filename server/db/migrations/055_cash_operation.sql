-- What a need is waiting for, and what actually happened on an opportunity.
-- ---------------------------------------------------------------------------
--
-- Two gaps a review found, and they are the same gap at two altitudes.
--
-- `closeNeed` set a status and wrote an event. Nothing resumed, because nothing
-- recorded what had been waiting: a need named a blocked *action* in prose and
-- carried no reference to the work that stopped, no condition that would settle
-- it, and no mark saying whether its continuation had already run. A person
-- could answer the same need repeatedly and never learn that their answer was
-- recorded and ignored — §24's "waiting nobody can resolve", at a table.
--
-- `beginExecution` moved an opportunity to EXECUTING and emitted an event. No
-- work was enqueued, no action was performed, and nothing anywhere had happened
-- — so the state said a transaction was being pursued on the strength of a
-- button press. `cash_actions` is what makes that sentence checkable: EXECUTING
-- means at least one row here, and a row here is an action somebody performed
-- or Brain actually started.

-- What settles this need, in a form somebody can check rather than a status.
--
-- Nullable only because a need raised before this column existed genuinely has
-- no recorded condition, and backfilling one from `next_step` would assert a
-- condition nobody wrote. The service refuses a blank on every new need.
ALTER TABLE cash_needs ADD COLUMN completion_condition TEXT;

-- Which opportunity transition is waiting on it, when one is.
--
-- The dependent work reference the review asked for, and it is a *state* rather
-- than a free reference because that is what can be retried: a continuation
-- that had to interpret prose to know what to resume would be model output
-- deciding a transition.
ALTER TABLE cash_needs ADD COLUMN blocks_state TEXT;

-- The Russell idea Brain started because of this need, when it could start one.
ALTER TABLE cash_needs ADD COLUMN candidate_id TEXT;

-- Raised once for one condition, however many times the tick reads it.
--
-- Scoped by project for the reason `053` scoped the commitment keys: a
-- uniqueness rule that spanned projects is one more namespace two accounts
-- share without having agreed to.
ALTER TABLE cash_needs ADD COLUMN request_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_needs_key
  ON cash_needs(project_id, request_key);

-- The continuation, stamped rather than scheduled.
--
-- `continued_at` is set by a guarded UPDATE that carries `continued_at IS NULL`,
-- so the effect on the far side of it happens exactly once whatever redelivers
-- the tick. `continuation_note` says what the resumption actually did, which is
-- the difference between a need that resumed work and one that merely says it
-- did.
ALTER TABLE cash_needs ADD COLUMN continued_at TEXT;
ALTER TABLE cash_needs ADD COLUMN continuation_note TEXT;

-- cash_actions — what was actually done, append-only
-- ---------------------------------------------------------------------------
--
-- An opportunity reaches EXECUTING because a row appears here, never because a
-- transition was requested. `performed_by` says which: BRAIN for something a
-- verified capability actually did, PERSON for something somebody did and
-- confirmed. There is no third value, because "we think it happened" is not a
-- record of an action.
--
-- `authority_id` is the commercial grant it ran under, read at the moment the
-- action was recorded rather than assumed from the project. A row with no
-- authority is refused by the service: an action outside a person's grant is
-- precisely what the grant exists to prevent.
--
-- Append-only. Nothing updates or deletes a row here, for §5's reason: what
-- happened is history, and history does not mutate.
CREATE TABLE IF NOT EXISTS cash_actions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  authority_id    TEXT NOT NULL REFERENCES cash_authorities(id),

  action          TEXT NOT NULL,
  performed_by    TEXT NOT NULL CHECK (performed_by IN ('BRAIN', 'PERSON')),

  -- Whatever identifies it outside Brain: a message id, an invoice number, a
  -- call log reference. Free text because Brain cannot verify any of them, and
  -- a column that looked structured would imply it had.
  reference       TEXT,
  detail          TEXT NOT NULL,

  -- Who confirmed it. A person's id for PERSON; the actor ref Brain recorded
  -- for BRAIN. Never a worker: no cash surface accepts a worker principal.
  confirmed_by    TEXT NOT NULL,

  -- One logical action, recorded once. Same shape as the commitment key and
  -- for the same reason: a retry after a lost response must not read as a
  -- second thing having happened.
  request_key     TEXT NOT NULL,

  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_actions_key
  ON cash_actions(project_id, request_key);

CREATE INDEX IF NOT EXISTS idx_cash_actions_opportunity
  ON cash_actions(opportunity_id, created_at);
