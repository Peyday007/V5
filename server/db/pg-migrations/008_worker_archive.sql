-- The Postgres half of 018_worker_archive.sql. See that file for the reasoning.
ALTER TABLE workers ADD COLUMN archived_at TEXT;
