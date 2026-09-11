-- The factory's execution plane. See the SQLite twin (039) for the reasoning.
ALTER TABLE bins ADD COLUMN factory_campaign_id text;
CREATE INDEX idx_bins_factory_campaign ON bins (factory_campaign_id, state);

ALTER TABLE factory_campaigns ADD COLUMN execution_mode text NOT NULL DEFAULT 'LOCAL';
