-- ---------------------------------------------------------------------------
-- WHAT A BIN IS FOR, AND WHO MAY BE HANDED IT
--
-- Owner's order, 2026-11-03: paid Claude routines do only work that improves
-- Brain itself, until the owner says otherwise. `brain_check_in` handed a
-- routine whatever bin was next and nothing asked what kind of work it was, so
-- routines were spent on one play's landed-cost question and on bins that need
-- a person's legal call.
--
-- `bins.purpose` is written once, when the bin is created, from the rows that
-- created it (`domain/binPurpose.ts`). NULL means nobody classified it, and an
-- unclassified bin is treated as PLAY_RESEARCH: denied to Claude.
--
-- `brain_switches` holds the one switch, `brain_only_mode`, ON from this
-- migration. `claimableStateSql` reads it inside the same statement that
-- offers or fires a bin, so there is no cached copy to disagree with the row.
-- ---------------------------------------------------------------------------
ALTER TABLE bins ADD COLUMN purpose TEXT
  CHECK (purpose IS NULL OR purpose IN ('BRAIN_IMPROVEMENT', 'PLAY_RESEARCH', 'GRUNT', 'BLOCKED_LEGAL'));

-- Which rule decided it, for "why was this bin parked" without re-running anything.
ALTER TABLE bins ADD COLUMN purpose_basis TEXT;

CREATE INDEX idx_bins_purpose ON bins (purpose, state);

CREATE TABLE brain_switches (
  name        TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  reason      TEXT
);

INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason)
VALUES ('brain_only_mode', 1, '2026-11-03T00:00:00.000Z', 'migration',
        'Owner order 2026-11-03: Claude routines are reserved for Brain improvement until the owner says otherwise.');
