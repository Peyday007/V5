-- The Postgres half of SQLite migration 144 (§102): the variable sweep's counts and summary on each exploration row.
ALTER TABLE reasoning_explorations ADD COLUMN variations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reasoning_explorations ADD COLUMN variables INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reasoning_explorations ADD COLUMN sweep TEXT;
