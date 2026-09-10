-- A campaign remembers which checkout it operates on. See the SQLite twin
-- (038_factory_repository_root.sql) for why.
ALTER TABLE factory_change_requests ADD COLUMN repository_root text;
