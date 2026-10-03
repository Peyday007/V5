-- A signed-in member reconnecting their own connector (CLAUDE.md §51,
-- services/fleet/memberReconnect.ts).
--
-- connector_clients gains a fifth source, MEMBER_RECONNECT: a client a member
-- attached to a connector an administrator had already bound to them. SQLite
-- cannot alter a CHECK, so the table is rebuilt; nothing references it, so the
-- rename rewrites no other table's REFERENCES.
--
-- And invitation_id: the bound invitation whose consent produced a
-- BOUND_INVITATION attachment. It is the only evidence that a connector is a
-- member's — an administrator named both the member and the connector on that
-- row — so ownership is read from the attachment itself, never by matching a
-- consent to whatever a client id happens to be attached to now.
CREATE TABLE connector_clients_next (
  client_id     TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  source        TEXT NOT NULL
    CHECK (source IN ('OBSERVED_ARRIVAL', 'INVITATION_MEMBER', 'BOUND_INVITATION', 'MEMBER_RECONNECT', 'OPERATOR')),
  evidence      TEXT,
  attached_at   TEXT NOT NULL,
  invitation_id TEXT
);
INSERT INTO connector_clients_next (client_id, connector_id, source, evidence, attached_at)
  SELECT client_id, connector_id, source, evidence, attached_at FROM connector_clients;
DROP TABLE connector_clients;
ALTER TABLE connector_clients_next RENAME TO connector_clients;
CREATE INDEX idx_connector_clients_connector ON connector_clients (connector_id, attached_at);

-- The connector a member reconnect restores. The client is attached to it when
-- the code is redeemed with the verifier and the client's secret, never at
-- approval: a client_id is public.
ALTER TABLE oauth_authorization_codes ADD COLUMN attach_connector_id TEXT;
