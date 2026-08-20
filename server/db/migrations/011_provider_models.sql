-- ---------------------------------------------------------------------------
-- MODEL DEFAULTS PER PROVIDER
--
-- Broad discovery and extraction are well served by a lighter model; a
-- contradiction that has already survived one attempt is not. Which model is
-- which is a property of the user's own account and plan, so it is theirs to
-- set — and it belongs beside the rest of the connection rather than in an
-- environment variable they would have to restart the server to change.
--
-- The evidence bar never follows the model. A cheap job that comes back weak is
-- repaired on the stronger one; it is never accepted because it was cheap.
-- ---------------------------------------------------------------------------
ALTER TABLE provider_connections ADD COLUMN light_model TEXT;

-- Whether this connection has ever actually run a job here, as opposed to
-- having answered a probe. It is the question a user is really asking when they
-- look at a connection page, and it is not the same question as "is it
-- installed".
ALTER TABLE provider_connections ADD COLUMN verified_run_at TEXT;
ALTER TABLE provider_connections ADD COLUMN verified_run_detail TEXT;
