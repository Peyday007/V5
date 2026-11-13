-- ---------------------------------------------------------------------------
-- INTEGRATIONS (§103)
--
-- One append-only record of what the integration registry
-- (server/services/integrations/registry.ts) observed and did: each health
-- reading of a connected service, each automatic repair (a credential copied
-- from GitHub or a connector to the deployment, a key generated, a setting
-- derived), and each metered call to a paid service, which the ceiling counts.
-- Names and states only — never a credential value.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_events (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHECK', 'REPAIR', 'USAGE')),
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_integration_events_lookup ON integration_events (integration_id, kind, recorded_at);
