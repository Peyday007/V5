-- ---------------------------------------------------------------------------
-- ONE QUESTION, NUMBERED ATTEMPTS, ARBITRATED BY THE DATABASE
--
-- A turn that ends FAILED can now be handed back to the fleet. The service
-- that does it first counted the attempts already made and then inserted the
-- next one — read, then write, with a window between them. Two people pressing
-- "Try again" at the same moment, or one person on two devices, both counted
-- one attempt and both created attempt 2: two pending turns, two bins, two
-- activations against a fixed subscription allowance for one question. And
-- because a later retry counts what exists, the same window let the
-- three-attempt ceiling be overshot.
--
-- That was not a hypothetical. `tests/turnRetry.test.ts` drove two concurrent
-- retries and got `{a: true, b: true, aAttempt: 2, bAttempt: 2}` with two
-- pending turns, against the code as first written.
--
-- This repository has needed the same sentence at three altitudes already —
-- the queue's `lease_generation`, the fleet's `fire_generation`, the effects
-- table's `UNIQUE (scope_hash, key_fingerprint)`: **a claim is a
-- compare-and-swap on a value the claimant does not supply.** This is the
-- fourth. The claimant supplies which question it is answering and which
-- attempt number it believes is next; the unique index decides whether it is
-- right, and exactly one INSERT survives.
--
--   answers_message_id  the person's message this turn is an attempt at
--   attempt             which attempt it is, counting the original as 1
--
-- Both NULL on every ordinary turn, which is what makes this migration free of
-- a backfill: NULLs are distinct under a unique index on both backends, so
-- existing rows cannot collide with each other, and a failed turn recorded
-- before this migration is simply attempt 1 with nothing to record. The
-- production turn this was built for is one of those, and it must keep reading
-- exactly as it does.
--
-- The link is a real column rather than a key inside `metadata` for a second
-- reason the owner asked for directly: a retry must never be mistakable for a
-- fresh question by anything that counts turns. `answers_message_id IS NULL`
-- is one predicate, available to every future gate, index and query. A JSON
-- key nobody knows to look for is how a count silently starts lying.
-- ---------------------------------------------------------------------------

ALTER TABLE russell_messages ADD COLUMN answers_message_id TEXT
  REFERENCES russell_messages(id) ON DELETE SET NULL;

ALTER TABLE russell_messages ADD COLUMN attempt INTEGER;

-- The arbiter. Two racers computing the same next attempt number for one
-- question produce one winner and one ordinary refusal.
CREATE UNIQUE INDEX idx_russell_messages_attempt
  ON russell_messages (answers_message_id, attempt);

-- Reading a question's attempt history is the other thing this table is now
-- asked, and it should not be a scan of the conversation.
CREATE INDEX idx_russell_messages_answers
  ON russell_messages (answers_message_id);
