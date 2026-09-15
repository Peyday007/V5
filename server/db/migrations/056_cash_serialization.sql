-- Money decisions are serialized by the database, and a key names one request.
-- ---------------------------------------------------------------------------
--
-- Two findings, and the first one is only reachable on Postgres.
--
-- `commit()` inserts its provisional row, then sums the holds ranked ahead of
-- it and compares that to the ceiling. On SQLite that is correct because a
-- write transaction is globally exclusive. On Postgres each transaction runs on
-- its own pooled client at the default READ COMMITTED, so **each one sees its
-- own insert and not the other's** — two $80 commitments against a $100 ceiling
-- each sum to $80, both pass, and $160 ends up held. A ranked sum cannot count
-- a row it cannot see, so no amount of ordering fixes it.
--
-- `cash_locks` is the serialization point, and it is one row per project per
-- currency. A cash-affecting transaction's *first* statement is a guarded
-- UPDATE that bumps `ticket`; Postgres holds that row's lock until commit, so
-- the second transaction blocks there and does its sum after the first one's
-- insert is visible. SQLite serializes writers already and the same statement
-- costs it nothing.
--
-- It is the primitive this repository uses everywhere else — a write to a row
-- nobody else can write concurrently — rather than SERIALIZABLE plus a
-- whole-transaction retry, because the retry would have to be threaded through
-- every caller and a missed one fails silently under load rather than loudly.
-- `ticket` exists so the statement is always a real write: an UPDATE that sets
-- a column to the value it already holds still takes the lock, but a reader of
-- this table can tell a contended project from an idle one, which is the only
-- thing the number is for.
CREATE TABLE IF NOT EXISTS cash_locks (
  project_id  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  ticket      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, currency)
);

-- What the key was a key *for*.
--
-- `(project_id, idempotency_key)` already makes one logical commitment one row,
-- and a colliding caller was told "an equivalent commitment already exists"
-- without anything having checked that it was equivalent. So a second request
-- reusing a key with a different amount, opportunity or purpose was answered
-- with the *first* commitment and a success — which is the one shape a caller
-- cannot detect, because it looks exactly like their own retry.
--
-- The money ledger already refuses that (`053` added `payload_fingerprint` to
-- `cash_money_entries`), and the two contracts must not differ: a caller who
-- learns that reusing a key is refused for money and honoured for commitments
-- has learned something false about both.
ALTER TABLE cash_commitments ADD COLUMN payload_fingerprint TEXT;
