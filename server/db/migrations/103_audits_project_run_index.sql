-- The research-packet contract and the console read a project's audits, and the
-- contract one run's, on every reconcile tick. Neither column was indexed, so
-- every read scanned the table. Additive; changes no row.
CREATE INDEX IF NOT EXISTS idx_audits_project_run ON audits (project_id, run_id, created_at);
