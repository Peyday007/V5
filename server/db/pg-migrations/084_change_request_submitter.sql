-- Who asked for a change, beside who approved it. See the SQLite chain's
-- 093_change_request_submitter.sql for the reasoning; the two are the same
-- column, numbered independently.
ALTER TABLE factory_change_requests ADD COLUMN submitted_by_user_id TEXT REFERENCES users(id);
