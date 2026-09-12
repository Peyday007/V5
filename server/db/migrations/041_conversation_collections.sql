-- Step 12B — conversations organized by meaning, not by recency.
--
-- A flat "recent chats" list is what Step 12A left, and it fails in a specific
-- way: a person with thirty threads across four projects has no way to find the
-- one they were in the middle of. §7 asks for automatic organization into
-- project and category collections, ranked by meaning inside each.
--
-- Two decisions are worth recording here rather than in a service.
--
-- **A collection is a row, not a grouping the client invents.** §25 lists
-- "conversation collection" among the objects durable reasoning depends on. A
-- collection Russell composed on the read path could not be corrected by a
-- person, could not be reasoned about by the loop, and would be recomputed
-- differently by two callers.
--
-- **Rank is derived and is deliberately not stored.** "Major and unfinished"
-- is a fact about the thread's current missions and its last turn, both of
-- which move without anybody touching the conversation. A stored rank would be
-- stale the moment a worker answered something.

CREATE TABLE russell_collections (
  id             TEXT PRIMARY KEY,

  -- Collections belong to a person. Two people working on one project each get
  -- their own, because a collection holds private threads and merging them
  -- would be the widening §7 forbids.
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Set for a project collection; NULL for a category one ("Business ideas",
  -- "Personal"). Not a discriminator — `kind` is — because a project
  -- collection whose project was deleted is still a collection.
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,

  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,

  -- Whether Russell proposed this collection or a person made it. A person's
  -- collection is never renamed or re-kinded by the automatic pass.
  source         TEXT NOT NULL DEFAULT 'AUTOMATIC',

  -- Versioned like every other object durable reasoning depends on, so a
  -- later change of shape can be told apart from the original.
  version        INTEGER NOT NULL DEFAULT 1,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  CHECK (kind IN ('PROJECT','CATEGORY','PERSONAL')),
  CHECK (source IN ('AUTOMATIC','USER'))
);

-- One collection of a given name per person. The automatic pass reads this
-- before it creates anything, so re-running it is idempotent rather than
-- additive.
CREATE UNIQUE INDEX idx_russell_collections_name
  ON russell_collections (owner_user_id, name);

-- Which collection a thread sits in, and who decided.
--
-- `collection_source` is what makes a correction survive. The automatic pass
-- only ever writes over `AUTOMATIC`; a person's choice is `USER` and is left
-- exactly where they put it, which is the same rule `attachment_source`
-- already applies to project routing one column along.
ALTER TABLE russell_conversations
  ADD COLUMN collection_id TEXT REFERENCES russell_collections(id) ON DELETE SET NULL;

ALTER TABLE russell_conversations
  ADD COLUMN collection_source TEXT NOT NULL DEFAULT 'NONE';

-- When a person said this thread is done.
--
-- Derived "finished" would be wrong in both directions: a thread whose mission
-- completed may still be where the next question goes, and one nobody has
-- touched for a month may be abandoned rather than finished. So it is a fact
-- somebody states, and everything else is ranked from live state.
ALTER TABLE russell_conversations
  ADD COLUMN closed_at TEXT;

CREATE INDEX idx_russell_conversations_collection
  ON russell_conversations (collection_id, updated_at);
