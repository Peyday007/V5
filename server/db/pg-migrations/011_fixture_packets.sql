-- The Postgres counterpart of the local chain's 021_fixture_packets.sql. The
-- reasoning is there and is not repeated.
ALTER TABLE research_orchestrations ADD COLUMN fixture integer NOT NULL DEFAULT 0;

CREATE INDEX idx_orchestrations_fixture ON research_orchestrations (fixture, project_id);
