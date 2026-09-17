-- The Postgres half of SQLite migration 063. See that file for why pressing
-- Start Cash Mode is itself the authorization for zero-spend internal
-- discovery, and why the one-per-project rule is an index rather than a check
-- in the application.
CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_goals_one_live_cash_discovery
  ON russell_goals (project_id)
  WHERE state = 'ACTIVE' AND name = 'Cash Mode internal discovery';
