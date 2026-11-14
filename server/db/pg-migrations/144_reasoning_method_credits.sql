-- The Postgres half of SQLite migration 153 (§101, lens S, S-9): one credit per method per (goal, inputs).
CREATE TABLE reasoning_method_credits (
  signature  TEXT NOT NULL,
  goal_id    TEXT NOT NULL,
  inputs_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (signature, goal_id, inputs_key)
);
