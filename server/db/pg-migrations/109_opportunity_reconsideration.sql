-- ---------------------------------------------------------------------------
-- OPPORTUNITY RECONSIDERATION: SHARED BLOCKER KEYS, REOPEN CONDITIONS, AND
-- THE LEDGER OF CHANGES ALREADY CONSUMED
-- ---------------------------------------------------------------------------
--
-- The Postgres half of SQLite migration 118. Same tables, same rules, plus
-- `seq BIGSERIAL` on every new table because `dialect.ts` rewrites `rowid`.
--
-- Assignment A of docs/OPPORTUNITY-INTELLIGENCE-PLAN.md (§3.1, §3.2(a)(b)).
-- Additive only: no existing column changes meaning and nothing reads these
-- until the reconsideration engine (B) and the staged dive (C) do.
--
-- `cash_needs.blocker_key` is one shared key per *fact* (`CAPABILITY:SEND_A_MESSAGE`),
-- never per opportunity, so a hundred needs blocked on one missing capability
-- share one key and one indexed lookup finds all of them. `request_key` stays
-- the idempotency key; NULL here means the need was raised from an untyped
-- cause, which is honest rather than a gap.
ALTER TABLE cash_needs ADD COLUMN blocker_key TEXT;
CREATE INDEX IF NOT EXISTS idx_cash_needs_blocker
  ON cash_needs (project_id, blocker_key, state);

-- A watch on a fact nobody is pursuing, held by a dormant opportunity.
--
-- Append-only. The only column ever written after insert is `triggered_at`
-- (with `trigger_change_ref`), once, by a guarded UPDATE. A person's ARCHIVE or
-- DECLINE is never reversed by a trigger: it raises a request, and the
-- reconsideration itself is a person's transition.
CREATE TABLE IF NOT EXISTS cash_reopen_conditions (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  opportunity_id     TEXT NOT NULL REFERENCES cash_opportunities(id),
  blocker_key        TEXT NOT NULL,
  recorded_from      TEXT NOT NULL CHECK (recorded_from IN
                       ('ARCHIVE', 'DECLINE', 'DISQUALIFY', 'ROUNDS_SPENT', 'EXPIRY', 'WEAK_ECONOMICS')),
  -- What the fact read when the condition was recorded (for example MISSING).
  observed_at_record TEXT,
  actor_ref          TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  triggered_at       TEXT,
  trigger_change_ref TEXT,
  CHECK ((triggered_at IS NULL) = (trigger_change_ref IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_cash_reopen_untriggered
  ON cash_reopen_conditions (project_id, blocker_key) WHERE triggered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cash_reopen_opportunity
  ON cash_reopen_conditions (opportunity_id, created_at);
-- One live watch per fact per opportunity: recording the same key twice is a
-- read-back, not a second watch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_reopen_one_live
  ON cash_reopen_conditions (opportunity_id, blocker_key) WHERE triggered_at IS NULL;

-- Every change that has reconsidered an opportunity, once.
--
-- The anti-flap rule is not a count. A reconsideration arises only from a
-- *distinct* change, and the primary key is what makes "the same change can
-- never trigger the same opportunity twice" a property of the schema rather
-- than of a caller remembering. Append-only; never updated, never deleted.
CREATE TABLE IF NOT EXISTS cash_reconsideration_triggers (
  seq            BIGSERIAL,
  opportunity_id TEXT NOT NULL REFERENCES cash_opportunities(id),
  change_ref     TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  blocker_key    TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('REOPEN_CONDITION', 'LIVE_REQUEST', 'PERSON')),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, change_ref)
);

-- How far each change source has been read, per project.
CREATE TABLE IF NOT EXISTS cash_change_watermarks (
  seq        BIGSERIAL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source     TEXT NOT NULL,
  through    TEXT NOT NULL,
  marker     TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source)
);

-- When a distinct change last asked for this piece to be re-evaluated.
ALTER TABLE cash_opportunities ADD COLUMN reconsider_requested_at TEXT;
-- When the current deep-dive epoch began. NULL: the epoch that began at creation.
ALTER TABLE cash_opportunities ADD COLUMN dive_epoch_started_at TEXT;
-- The change that most recently reconsidered it, for the reader who asks why.
ALTER TABLE cash_opportunities ADD COLUMN last_reconsider_change_ref TEXT;
