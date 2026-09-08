-- The Postgres half of migration 032. See that file for why.
ALTER TABLE russell_goals
  ADD COLUMN work_policy TEXT NOT NULL DEFAULT 'UNCAPPED'
  CHECK (work_policy IN ('UNCAPPED','CAPPED'));

UPDATE russell_goals SET work_policy = 'CAPPED' WHERE state <> 'ACTIVE';
