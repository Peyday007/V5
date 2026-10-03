-- A signed-in member reconnecting their own connector (CLAUDE.md §51,
-- services/fleet/memberReconnect.ts). SQLite chain: 101_member_reconnect.sql.
--
-- Postgres names an inline column CHECK <table>_<column>_check. Written without
-- IF EXISTS on purpose: a wrong name must fail the migration, not leave the old
-- constraint standing beside the new one.
ALTER TABLE connector_clients DROP CONSTRAINT connector_clients_source_check;
ALTER TABLE connector_clients ADD CONSTRAINT connector_clients_source_check
  CHECK (source IN ('OBSERVED_ARRIVAL', 'INVITATION_MEMBER', 'BOUND_INVITATION', 'MEMBER_RECONNECT', 'OPERATOR'));

-- The bound invitation whose consent produced a BOUND_INVITATION attachment:
-- the only evidence a connector is a member's (an administrator named both).
ALTER TABLE connector_clients ADD COLUMN invitation_id TEXT;

-- The connector a member reconnect restores; attached when the code is redeemed.
ALTER TABLE oauth_authorization_codes ADD COLUMN attach_connector_id TEXT;
