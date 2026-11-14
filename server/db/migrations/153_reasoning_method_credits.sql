-- ---------------------------------------------------------------------------
-- ONE CREDIT PER GOAL AND INPUTS (§101, lens S, S-9)
--
-- A method's `tries` in reasoning_methods counted every persisted plan read,
-- so one goal re-read on unchanged inputs looked like many independent trials
-- and the library's upper confidence bound measured one goal's repetition.
-- A method is now credited once per (goal, inputs it was explored on): the
-- first exploration of those inputs inserts a row here and updates the method;
-- a later read of the same inputs finds the row and leaves the method alone.
-- ---------------------------------------------------------------------------

CREATE TABLE reasoning_method_credits (
  signature  TEXT NOT NULL,
  goal_id    TEXT NOT NULL,
  inputs_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (signature, goal_id, inputs_key)
);
