-- ---------------------------------------------------------------------------
-- HOW MANY FREE-LANE JOBS RUN AT ONCE, PER MODEL (§86)
--
-- The free research lane began fixed at two slots per model. Its concurrency
-- is now decided by a controller from measurements — queue depth, provider
-- errors, answer quality, and Brain's own database and event-loop pressure —
-- and this row is where the decision persists, so a restart resumes from what
-- was learned rather than from a number somebody typed.
--
-- `target` is the slots to run now. `stable_high` is the highest target that
-- held a full window without provider overload, which is what the readout
-- reports as measured sustainable concurrency.
-- ---------------------------------------------------------------------------
CREATE TABLE free_lane_capacity (
  model        TEXT PRIMARY KEY,
  target       INTEGER NOT NULL CHECK (target >= 1),
  stable_high  INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL,
  reason       TEXT NOT NULL
);
