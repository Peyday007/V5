-- How a recovery was authenticated, recorded apart from whose authority it
-- carries. See server/db/migrations/048_recovery_authority_channel.sql for the
-- reasoning; the two chains are numbered independently and this is the same
-- change.
--
--   requested_by_id    whose authority this carries        (resolved from rows)
--   authority_channel  how the call was authenticated      (a closed set)
--
-- `--admin <email>` resolves an administrator from `users`. That is attribution.
-- What authenticated the call is reaching the shell, and Brain cannot identify
-- the party that reached it — so the channel defaults to the weaker claim and
-- `executed_by_ref` is stored as reported rather than as established.
ALTER TABLE audit_integrity_reopens
  ADD COLUMN IF NOT EXISTS authority_channel TEXT NOT NULL DEFAULT 'DELEGATED_TERMINAL';

ALTER TABLE audit_integrity_reopens
  ADD COLUMN IF NOT EXISTS executed_by_ref TEXT;
