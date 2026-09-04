-- See server/db/migrations/028_project_purpose.sql for the reasoning. The two
-- chains are numbered independently and their versions do not mean the same
-- thing; what they must agree about is the shape of the table.
ALTER TABLE projects ADD COLUMN purpose TEXT NOT NULL DEFAULT 'PROJECT'
  CHECK (purpose IN ('PROJECT', 'TECHNICAL'));

UPDATE projects SET purpose = 'TECHNICAL'
 WHERE slug IN ('verification-scope', 'verification-holdout', 'fault-scope', 'queue-scope');

CREATE INDEX idx_projects_purpose ON projects (purpose, status);
