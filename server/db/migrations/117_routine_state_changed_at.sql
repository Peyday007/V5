-- ---------------------------------------------------------------------------
-- WHEN A ROUTINE'S STATE LAST CHANGED, RECORDED RATHER THAN INFERRED
-- ---------------------------------------------------------------------------
--
-- `recoverReauthorizedSurfaces` lifts a no-show quarantine once the connector
-- has a consent newer than the quarantine, and it read "newer than the
-- quarantine" as `updated_at`. Almost everything writes that column: a fire
-- claim, a recovery probe's fire, a delivery proof, the touch the code
-- exchange itself performs after minting the grant. So a member who
-- reconnected their own connector never had the quarantine lifted — the grant
-- was always older than the touch it caused — and Brain told them it would be.
--
-- `state_changed_at` is written only in the statement that moves `state`.
-- NULL for rows written before this column existed; readers fall back to
-- `updated_at` there, which is the old behaviour and never less safe.
-- ---------------------------------------------------------------------------

ALTER TABLE fleet_routines ADD COLUMN state_changed_at TEXT;
