-- Which surface a worker session actually came from.
--
-- `research_passes` has carried `executor_account_id` since Step 11 and it was
-- null on every row this Brain has ever written, so `A11_INDEPENDENT_AUDIT`
-- read NOT_RUN against three genuinely independent audit passes. The cause is
-- in `lineageForWorker`: it resolved the account from the *static*
-- worker -> Routine binding, and production has two Routines under two accounts
-- bound to one worker identity. Two candidates is ambiguous, ambiguous fails
-- closed, and closed is null.
--
-- The account was never ambiguous. Brain fired one Routine for one bin, and the
-- session that arrived and took that bin is that fire's session. This table is
-- that observation, written from the dispatch row Brain wrote itself — the same
-- source `creditDispatchArrival` already credits the arrival from, and for the
-- same reason: never from anything the worker says about itself.
--
-- One row per credential, first observation wins. A credential belongs to one
-- activation, and an activation was fired by one Routine; a later bin taken by
-- the same session cannot change which surface started it.
CREATE TABLE worker_sessions (
  -- The credential the request authenticated with. Server-derived, per
  -- activation, and the same value `research_passes.executor_session_ref`
  -- carries — which is what makes a pass joinable to its surface.
  session_ref       TEXT PRIMARY KEY,
  worker_id         TEXT NOT NULL,
  routine_id        TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  -- What the observation was made from, so an attribution can be traced back
  -- to the row that established it rather than believed.
  bin_id            TEXT NOT NULL,
  lease_generation  INTEGER NOT NULL,
  observed_at       TEXT NOT NULL
);

CREATE INDEX idx_worker_sessions_worker ON worker_sessions (worker_id, observed_at);
CREATE INDEX idx_worker_sessions_account ON worker_sessions (account_id, observed_at);
