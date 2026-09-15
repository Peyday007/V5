-- The money defects an external review found in the first Cash Mode pass, and
-- the columns their corrections need.
--
-- Every one of them was reproduced before it was fixed
-- (`tests/cashDefects.test.ts`), and they have one property in common: each
-- produced a **wrong number or a disclosure** while every surface read as
-- healthy. 2,812 passing tests established none of it, because every one of
-- them exercised a single caller on a single account taking a single unrepeated
-- action.
--
-- ---------------------------------------------------------------------------
-- An idempotency key belongs to one account
-- ---------------------------------------------------------------------------
--
-- `UNIQUE (idempotency_key)` was table-wide, so two accounts that picked the
-- same string collided: the second one's insert did nothing, the replay branch
-- read back **the first account's row**, and returned it as this caller's own
-- success. Two failures in one — account B learns the amount, purpose and
-- stopping condition of account A's spending, and reserves nothing while being
-- told it did.
--
-- §20 already says the scope is built from server-controlled facts only. The
-- project is the server-controlled fact here; the key is the caller's, and a
-- caller's string must never be the whole of an identity.
DROP INDEX IF EXISTS idx_cash_commitments_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_commitments_key
  ON cash_commitments(project_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- Settling a hold is spending the money, not freeing it
-- ---------------------------------------------------------------------------
--
-- `settleCommitment` moved the row out of `HELD` and wrote nothing else, so a
-- $400 hold against $1,000 of capital took deployable cash from $600 back to
-- $1,000: the account was told it had the money it had just spent.
--
-- A settlement now writes the matching `COST` entry in the same transaction,
-- and `spent_cents` records how much of the hold was actually used so a partial
-- spend returns its remainder rather than being rounded to the whole hold or to
-- nothing.
ALTER TABLE cash_commitments ADD COLUMN spent_cents INTEGER;

-- ---------------------------------------------------------------------------
-- A money entry is written once, however many times it is sent
-- ---------------------------------------------------------------------------
--
-- Every recording request minted a fresh id, so a retry after a lost response
-- recorded the same $750 settlement twice and the account reported $1,500. That
-- is §20's rule unapplied at the one table where the consequence is money.
--
-- `payload_fingerprint` is what stops a key being a way to *overwrite*: a key
-- that comes back with a different amount, kind, currency, reference or
-- opportunity is a different operation wearing the same name, and it is refused
-- rather than silently replayed as the first one. Inputs identify an operation;
-- a repeat has to be a repeat.
--
-- The key is nullable because an entry Brain derives — the cost a settlement
-- writes — carries its own derived key, while nothing that existed before this
-- migration has one. The index is partial for that reason: a null is not a
-- collision.
ALTER TABLE cash_money_entries ADD COLUMN idempotency_key TEXT;
ALTER TABLE cash_money_entries ADD COLUMN payload_fingerprint TEXT;

-- The commitment a derived cost belongs to, so "what did that settlement
-- actually spend" resolves to a row rather than to a timestamp.
ALTER TABLE cash_money_entries ADD COLUMN commitment_id TEXT;

-- Total rather than partial, and that is a mechanical requirement rather than a
-- preference: SQLite's upsert infers its target from an index, and for a
-- *partial* one the `ON CONFLICT` clause has to repeat the predicate or the
-- statement is refused outright. A total index needs no predicate and loses
-- nothing, because a NULL is distinct from every other NULL in a unique index
-- on both backends — so the rows that predate this column do not collide with
-- each other, and every row written after it carries a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_money_key
  ON cash_money_entries(project_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- Two currencies are not one number
-- ---------------------------------------------------------------------------
--
-- The aggregation summed every entry and labelled the result with a single
-- currency, so USD and EUR were added as if interchangeable. Deriving separate
-- positions per currency is the general answer and it is not the answer this
-- sprint needs: a sprint is one person's bounded run, and pinning it to one
-- currency is the small honest version. A second currency is a second sprint.
--
-- `DEFAULT 'USD'` exists only so the column can be added to rows that predate
-- it; `activate` writes it explicitly, and every reader takes it from the row.
ALTER TABLE cash_modes ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
