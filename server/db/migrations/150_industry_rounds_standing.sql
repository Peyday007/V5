-- brain:rebuild-without-foreign-keys
--
-- ---------------------------------------------------------------------------
-- A KERNEL ROUND MAY BE FILED UNDER THE STANDING AUTHORITY RATHER THAN A SPRINT
-- ---------------------------------------------------------------------------
--
-- The industry kernel grows Brain's map of the economy, and that is a standing
-- capability rather than a cash sprint's (W-1 of
-- docs/INTELLIGENCE-RECOVERY-2026-11-14.md; §65, §105). `cash_mode_id` was NOT NULL, so no round could be
-- opened where no sprint existed. NULL now means "asked under a standing
-- research grant, not under the sprint": the wind-down guard
-- (`launchableUnderCashMode`) stops a sprint's own rounds and never these,
-- and revoking the grant is what stops them.
--
-- SQLite cannot drop a NOT NULL, so the table is rebuilt. Every other column,
-- constraint and index is restated exactly as 072 wrote it; nothing references
-- the table, and the runner checks foreign keys before committing.
-- ---------------------------------------------------------------------------

CREATE TABLE industry_rounds_rebuilt (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT,
  node_id       TEXT REFERENCES industry_nodes(id),
  purpose       TEXT NOT NULL CHECK (purpose IN ('BOOTSTRAP', 'MAP', 'SCAN', 'CAPITAL')),
  bucket_id     TEXT,
  opportunity_id TEXT REFERENCES cash_opportunities(id),
  round         INTEGER NOT NULL CHECK (round >= 1),
  candidate_id  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,
  found         INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK ((purpose = 'BOOTSTRAP') = (node_id IS NULL)),
  CHECK ((purpose = 'SCAN') = (bucket_id IS NOT NULL)),
  CHECK ((purpose = 'CAPITAL') = (opportunity_id IS NOT NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

INSERT INTO industry_rounds_rebuilt
  (rowid, id, project_id, cash_mode_id, node_id, purpose, bucket_id, opportunity_id, round,
   candidate_id, state, opened_at, harvested_at, found, created_at, updated_at)
SELECT rowid, id, project_id, cash_mode_id, node_id, purpose, bucket_id, opportunity_id, round,
       candidate_id, state, opened_at, harvested_at, found, created_at, updated_at
  FROM industry_rounds;

DROP TABLE industry_rounds;
ALTER TABLE industry_rounds_rebuilt RENAME TO industry_rounds;

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_ask
  ON industry_rounds(project_id, COALESCE(node_id, '-'), purpose,
                     COALESCE(bucket_id, '-'), COALESCE(opportunity_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_candidate
  ON industry_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_industry_rounds_project
  ON industry_rounds(project_id, state);
