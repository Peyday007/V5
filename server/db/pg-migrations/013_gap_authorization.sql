-- See server/db/migrations/022_gap_authorization.sql for the reasoning.
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_policy TEXT;
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_authorized_by TEXT;
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_authorized_at TEXT;
