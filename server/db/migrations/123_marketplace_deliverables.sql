-- ---------------------------------------------------------------------------
-- WHAT BRAIN DELIVERED ON A MARKETPLACE JOB, AND THE EVIDENCE IT WAS CHECKED
-- ---------------------------------------------------------------------------
--
-- A job now names the kinds of deliverable it asks for (`categories`), the
-- figures it was priced on (`economics`: Freelancer's own exchange rate, the
-- published fee, the net and the execution estimate), whether the client hands
-- over files, and the bin that is producing the work.
--
-- `marketplace_deliverables` holds one row per version Brain rendered. A
-- worker submits a specification; Brain renders the files itself and verifies
-- the bytes it produced. A version that failed verification keeps its row and
-- its problems (REFUSED); a delivered one records when. Rows are never
-- deleted: a revision is a new version, so what the client received on any
-- day is still answerable. The files themselves are in the document store,
-- under keys built from these ids.
ALTER TABLE marketplace_jobs ADD COLUMN categories TEXT NOT NULL DEFAULT '[]';
ALTER TABLE marketplace_jobs ADD COLUMN economics TEXT;
ALTER TABLE marketplace_jobs ADD COLUMN needs_client_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_jobs ADD COLUMN deliverable_bin_id TEXT;
ALTER TABLE marketplace_jobs ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_jobs ADD COLUMN client_files TEXT;

CREATE TABLE marketplace_deliverables (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id),
  job_id        TEXT NOT NULL REFERENCES marketplace_jobs (id),
  version       INTEGER NOT NULL,
  bin_id        TEXT NOT NULL,
  kinds         TEXT NOT NULL,
  spec          TEXT NOT NULL,
  message       TEXT,
  files         TEXT NOT NULL,
  verification  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('VERIFIED', 'REFUSED', 'DELIVERED')),
  created_at    TEXT NOT NULL,
  delivered_at  TEXT
);

CREATE UNIQUE INDEX idx_marketplace_deliverables_version ON marketplace_deliverables (job_id, version);
CREATE UNIQUE INDEX idx_marketplace_deliverables_bin ON marketplace_deliverables (bin_id);
