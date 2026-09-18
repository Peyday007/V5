-- ---------------------------------------------------------------------------
-- The Postgres half of SQLite migration 071. See that file for why the column
-- exists and why `campaign_id` is not it.
-- ---------------------------------------------------------------------------

ALTER TABLE realization_packets ADD COLUMN change_request_id TEXT;

CREATE UNIQUE INDEX idx_realization_packets_change_request
  ON realization_packets (change_request_id)
  WHERE change_request_id IS NOT NULL;
