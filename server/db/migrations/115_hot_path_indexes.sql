-- Indexes for the statements production measured as most expensive.
--
-- 2026-10-12, read from pg_stat_statements and pg_stat_user_tables on the live
-- database while it was saturated (check-in p95 135s, Storage answering 544
-- and then 429 too_many_connections): `bins` had been read sequentially
-- 632,347 times, 1.48 billion rows, and the costliest statement in the
-- database — lineage recovery's `bins ⋈ bin_dispatch` by credential, 280,205
-- calls, 9,690 s — filtered on a column no index covered. The others below are
-- the next statements on the same list whose predicate had no index.
--
-- Additive only: nothing reads differently, and each is a plain index on a
-- table of thousands of rows, built inside the migration's transaction.
--
-- Deliberately NOT identity_events, though its connector-health probe was on
-- the same list: that table is large, and the first version of this migration
-- indexed it — on the saturated database the build hit the statement timeout,
-- the migration rolled back, and production could not boot until it was taken
-- out. An index on a large, write-hot table is not something a boot migration
-- may build inside a transaction.
CREATE INDEX IF NOT EXISTS idx_bins_lease_credential ON bins (lease_credential_id, worker_id);
CREATE INDEX IF NOT EXISTS idx_cash_events_opportunity ON cash_events (opportunity_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_bin_dispatch_sent ON bin_dispatch (state, sent_at);
