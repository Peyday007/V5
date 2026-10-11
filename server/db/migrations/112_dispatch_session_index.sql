-- A fired session is recognised at check-in by the provider session its fire
-- returned (services/fleet/arrivalIdentity.ts), so check-in looks a dispatch up
-- by session_ref. Without this the lookup scans every dispatch Brain ever sent,
-- on the path a session takes to prove it arrived.
CREATE INDEX IF NOT EXISTS idx_bin_dispatch_session ON bin_dispatch (session_ref);
