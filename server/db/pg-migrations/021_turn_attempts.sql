-- The Postgres half of server/db/migrations/030_turn_attempts.sql. The two
-- chains are numbered independently; what they must agree about is the shape.
--
-- No deliberate difference here: the columns, the foreign key and both indexes
-- are the same, and `NULLS DISTINCT` is the default for a unique index on both
-- backends — which is the property the whole design rests on, since every
-- ordinary turn leaves both columns NULL.
--
-- See the SQLite file for why this exists. In one line: a retry used to count
-- the attempts already made and then insert the next one, and two concurrent
-- callers both counted one and both created attempt 2.

ALTER TABLE russell_messages ADD COLUMN answers_message_id TEXT
  REFERENCES russell_messages(id) ON DELETE SET NULL;

ALTER TABLE russell_messages ADD COLUMN attempt INTEGER;

CREATE UNIQUE INDEX idx_russell_messages_attempt
  ON russell_messages (answers_message_id, attempt);

CREATE INDEX idx_russell_messages_answers
  ON russell_messages (answers_message_id);
