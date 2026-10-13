-- brain:rebuild-without-foreign-keys
--
-- ---------------------------------------------------------------------------
-- A KERNEL ROUND WHOSE MISSION FAILED IS ABANDONED, NOT OPEN FOR EVER (RES-2)
-- ---------------------------------------------------------------------------
--
-- `industry_rounds`, `manufacturing_rounds`, `labor_rounds` and
-- `cash_discovery_rounds` already declare ABANDONED. `deal_rounds` and
-- `puzzle_rounds` were written with only OPEN and SETTLED, so a round whose
-- mission FAILED or was CANCELLED had nowhere to go: it held its slot for ever
-- (production: dealflow held 3 of 3 slots from 2026-09-21). This widens each
-- state CHECK by one value and nothing else — every column, every other
-- constraint and every index is restated exactly as 083 and 089 wrote them.
--
-- SQLite cannot alter a CHECK, so each table is rebuilt; nothing references
-- either table, and the runner checks foreign keys before committing.
-- ---------------------------------------------------------------------------

CREATE TABLE deal_rounds_rebuilt (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id     TEXT NOT NULL,

  purpose          TEXT NOT NULL CHECK (purpose IN (
                     'SEED_EQUIPMENT', 'DEMAND', 'SUPPLY', 'COMPLIANCE',
                     'LANDED_COST', 'STRUCTURE', 'DECISION_MAKER', 'ADJACENT')),

  equipment_key    TEXT,
  equipment_class  TEXT,
  destination      TEXT,
  party_id         TEXT REFERENCES deal_parties(id),
  deal_id          TEXT REFERENCES deals(id),

  round            INTEGER NOT NULL CHECK (round >= 1),

  candidate_id     TEXT NOT NULL,

  state            TEXT NOT NULL CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED')),

  opened_at        TEXT NOT NULL,
  harvested_at     TEXT,
  found            INTEGER,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK ((purpose = 'SEED_EQUIPMENT') = (equipment_key IS NULL)),
  CHECK ((equipment_key IS NULL) = (equipment_class IS NULL)),
  CHECK (purpose NOT IN ('COMPLIANCE', 'LANDED_COST') OR destination IS NOT NULL),
  CHECK (purpose NOT IN ('DECISION_MAKER', 'ADJACENT') OR party_id IS NOT NULL),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

INSERT INTO deal_rounds_rebuilt
  (rowid, id, project_id, cash_mode_id, purpose, equipment_key, equipment_class, destination,
   party_id, deal_id, round, candidate_id, state, opened_at, harvested_at, found,
   created_at, updated_at)
SELECT rowid, id, project_id, cash_mode_id, purpose, equipment_key, equipment_class, destination,
       party_id, deal_id, round, candidate_id, state, opened_at, harvested_at, found,
       created_at, updated_at
  FROM deal_rounds;

DROP TABLE deal_rounds;
ALTER TABLE deal_rounds_rebuilt RENAME TO deal_rounds;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_ask
  ON deal_rounds(project_id, purpose, COALESCE(equipment_key, '-'),
                 COALESCE(destination, '-'), COALESCE(party_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_candidate
  ON deal_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_deal_rounds_project
  ON deal_rounds(project_id, state);


CREATE TABLE puzzle_rounds_rebuilt (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL REFERENCES cash_modes(id),

  purpose        TEXT NOT NULL
                   CHECK (purpose IN ('SEED_FORMATS', 'DEMAND', 'CHANNEL',
                                      'PRODUCTION', 'ECONOMICS', 'RIGHTS')),

  format_key     TEXT,
  product_class  TEXT,

  candidate_id   TEXT NOT NULL,
  round          INTEGER NOT NULL CHECK (round >= 1),

  state          TEXT NOT NULL CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED')),
  found          INTEGER,

  created_at     TEXT NOT NULL,
  settled_at     TEXT,

  -- A closed round (SETTLED or ABANDONED) has a count and a time; an open one
  -- has neither.
  CHECK ((state <> 'OPEN') = (settled_at IS NOT NULL)),
  CHECK ((state <> 'OPEN') = (found IS NOT NULL)),

  CHECK (purpose = 'SEED_FORMATS' OR format_key IS NOT NULL),
  CHECK ((purpose = 'ECONOMICS') = (product_class IS NOT NULL))
);

INSERT INTO puzzle_rounds_rebuilt
  (rowid, id, project_id, cash_mode_id, purpose, format_key, product_class, candidate_id, round,
   state, found, created_at, settled_at)
SELECT rowid, id, project_id, cash_mode_id, purpose, format_key, product_class, candidate_id, round,
       state, found, created_at, settled_at
  FROM puzzle_rounds;

DROP TABLE puzzle_rounds;
ALTER TABLE puzzle_rounds_rebuilt RENAME TO puzzle_rounds;

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_unique
  ON puzzle_rounds (project_id, purpose, format_key, product_class, round);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_by_candidate
  ON puzzle_rounds (candidate_id);
