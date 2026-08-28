-- ---------------------------------------------------------------------------
-- RESEARCH WORK
--
-- The Postgres counterpart of the local chain's 020_research_work.sql. The
-- reasoning for every column is there and is not repeated here; two copies of
-- an explanation are two things to keep in step.
--
-- Foreign keys are added by ALTER after the table exists and indexes are named
-- to match the local chain, as everywhere in this chain since 003_identity.sql.
-- ---------------------------------------------------------------------------

ALTER TABLE work_items ADD COLUMN orchestration_id text;
ALTER TABLE work_items ADD COLUMN fragment_id text;

ALTER TABLE work_items ADD CONSTRAINT work_items_orchestration_id_fkey
  FOREIGN KEY (orchestration_id) REFERENCES research_orchestrations(id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_items ADD CONSTRAINT work_items_fragment_id_fkey
  FOREIGN KEY (fragment_id) REFERENCES research_fragments(id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX idx_work_items_orchestration ON work_items (orchestration_id, state);
CREATE INDEX idx_work_items_fragment ON work_items (fragment_id, state);


CREATE TABLE work_item_checkpoints (
  id                text PRIMARY KEY,
  work_item_id      text NOT NULL,
  project_id        text NOT NULL,
  attempt_number    integer NOT NULL,
  lease_generation  integer NOT NULL,
  worker_id         text,
  note              text NOT NULL,
  created_at        text NOT NULL,

  CHECK (attempt_number >= 1),
  CHECK (lease_generation >= 1)
);

ALTER TABLE work_item_checkpoints ADD CONSTRAINT work_item_checkpoints_work_item_id_fkey
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_item_checkpoints ADD CONSTRAINT work_item_checkpoints_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_item_checkpoints ADD CONSTRAINT work_item_checkpoints_worker_id_fkey
  FOREIGN KEY (worker_id) REFERENCES workers(id)
  ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX idx_work_item_checkpoints_item
  ON work_item_checkpoints (work_item_id, created_at);
