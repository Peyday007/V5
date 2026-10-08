-- A person's standing decision that eligible Factory changes to one repository
-- may be released without them (CLAUDE.md §58, services/factory/release.ts).
-- Postgres chain: 102_factory_release_authorizations.sql.
--
-- This is the Brain half of a two-key arrangement. The other half is a GitHub
-- setting only a repository administrator can change (the FACTORY_AUTO_RELEASE
-- variable and the `factory-release` environment), so neither a row nor a
-- setting alone releases anything.
--
-- It authorizes nothing outside services/factory/releaseEligibility.ts: a change
-- touching credentials, security, financial authority, deployment controls,
-- schema or dependencies is manual whatever this table says.
--
-- Append-only in spirit: revoking writes revoked_at and keeps the row, so what
-- governed every past release stays readable. One live grant per (project,
-- repository), decided by the partial unique index below.
CREATE TABLE factory_release_authorizations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_grant TEXT NOT NULL,
  granted_by_id    TEXT NOT NULL,
  authority_channel TEXT NOT NULL CHECK (authority_channel IN ('BROWSER_SESSION', 'SHELL')),
  reason           TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT,
  revoked_by_id    TEXT,
  revoke_reason    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_auth_live
  ON factory_release_authorizations (project_id, repository_grant)
  WHERE revoked_at IS NULL;
