-- ---------------------------------------------------------------------------
-- RESEARCH WORK: LINKING A QUEUE ITEM TO THE THING IT IS RESEARCHING
--
-- Until now every work item carried its whole subject in its payload — a note
-- to echo, a passage to summarise. That was deliberate and it was also the
-- ceiling: a payload cannot carry a research assignment, because a research
-- assignment is a row that already exists, with boundaries the gate reads and
-- a claim ledger hanging off it.
--
-- So a research work item names its orchestration and its fragment instead of
-- describing them. Two consequences follow, and both are the point:
--
--   The payload stops being where the work is defined. A worker cannot learn
--   what to research by reading the queue; it has to ask the Brain, through a
--   tool, under the scope that permits it. The item is a pointer, and pointers
--   cannot be smuggled through.
--
--   The declaration cannot drift from what is judged. The fragment row the
--   worker is told to research is the same row `applyGate` reads its lanes,
--   its independent-source minimum and its completion criteria from. A copy in
--   a payload would be a second version of the truth, and the copy is always
--   the one that goes stale.
--
-- Both columns are nullable, because SYNTHETIC_ECHO and SUMMARIZE_PASSAGE
-- belong to no orchestration and never will.
-- ---------------------------------------------------------------------------
ALTER TABLE work_items ADD COLUMN orchestration_id TEXT
  REFERENCES research_orchestrations(id) ON DELETE CASCADE;
ALTER TABLE work_items ADD COLUMN fragment_id TEXT
  REFERENCES research_fragments(id) ON DELETE CASCADE;

CREATE INDEX idx_work_items_orchestration ON work_items (orchestration_id, state);
CREATE INDEX idx_work_items_fragment ON work_items (fragment_id, state);


-- ---------------------------------------------------------------------------
-- CHECKPOINTS
--
-- The queue is at-least-once. A lease can expire while a worker is halfway
-- through an hour of research, and the item is then redelivered to somebody who
-- knows nothing about what the first attempt had already found. Step 6 stops
-- the *effect* repeating. Nothing yet stops the *thinking* being thrown away.
--
-- A checkpoint is that: a short, durable note written by the worker while it
-- still holds the lease, saying where it has got to. The next claimant reads
-- the checkpoints with the assignment and starts from them rather than from
-- nothing.
--
-- Append-only, and the reason is the same one that makes project_events
-- append-only. A checkpoint is a record of what a worker knew at a moment. If
-- a later attempt could edit it, it would stop being that and become a summary
-- written by whoever spoke last — which is exactly the thing you cannot rely on
-- when you are trying to work out why an attempt went wrong.
--
-- The lease generation is stored on every row so a checkpoint resolves to the
-- attempt that wrote it. A note from generation 3 read by generation 4 is
-- useful; a note whose author cannot be identified is not.
--
-- What must never be here: a credential, an authorization header, an
-- uncontrolled external response, or the full contents of a private source.
-- The note is bounded and the tool enforces the bound. This is a place for
-- "checked the register, found nothing under the 2019 name" — not for the page
-- it read.
-- ---------------------------------------------------------------------------
CREATE TABLE work_item_checkpoints (
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Which attempt wrote it, and under which fencing generation. Both, because
  -- attempt_count is a counter on the item and the generation is the proof of
  -- ownership; the pair identifies the lease that produced the note.
  attempt_number    INTEGER NOT NULL,
  lease_generation  INTEGER NOT NULL,
  worker_id         TEXT REFERENCES workers(id) ON DELETE SET NULL,

  note              TEXT NOT NULL,
  created_at        TEXT NOT NULL,

  CHECK (attempt_number >= 1),
  CHECK (lease_generation >= 1)
);

CREATE INDEX idx_work_item_checkpoints_item
  ON work_item_checkpoints (work_item_id, created_at);
