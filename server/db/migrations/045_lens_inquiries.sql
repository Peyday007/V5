-- The four-and-fifth asked lenses, given somewhere to be answered.
--
-- `services/russell/frontier.ts` answers five lenses from rows and *puts* five
-- more, on the rule that a Brain filling them in from a template would be
-- manufacturing insight. That rule is right and it left the asked half with no
-- execution path at all: a question on a screen with nothing that could ever
-- answer it.
--
-- This is the path, and it is governed rather than free. An inquiry is opened
-- by a person, carried by the same bin fleet a Russell turn uses, answered by a
-- worker into a closed structure, and every finding it proposes must name rows
-- this project already holds. Nothing it returns is knowledge until a person
-- accepts it — §11's "created as PROPOSED, becomes evidence only when a person
-- accepts it", at a new door.
CREATE TABLE IF NOT EXISTS russell_lens_inquiries (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Which lens. Only an ASKED one may be stored; the service refuses a DERIVED
  -- lens by name, because those are answered from rows and asking a model for
  -- one would replace a fact with an opinion.
  lens              TEXT NOT NULL,
  -- The question, and what it is about, both resolved server-side at open time
  -- so the record says what was actually asked rather than what a later read
  -- would recompute.
  question          TEXT NOT NULL,
  subject           TEXT,
  state             TEXT NOT NULL CHECK (state IN
                      ('REQUESTED','RUNNING','ANSWERED','REFUSED','FAILED','CANCELLED')),
  -- Why it was refused, in words. Kept forever: a refusal is evidence of what
  -- was asked and why it was not allowed.
  refusal_reason    TEXT,
  -- The bin carrying it, once one exists. Null while it is waiting.
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  -- The validated findings, as stored JSON. Never the raw reply: the raw reply
  -- is on the bin's unit result, which is where an unvalidated answer belongs.
  findings          TEXT NOT NULL DEFAULT '[]',
  -- How many the validator threw away, and why, so "it found nothing" and "it
  -- proposed six things that resolved to nothing" are different readings.
  discarded         INTEGER NOT NULL DEFAULT 0,
  discard_reasons   TEXT NOT NULL DEFAULT '[]',
  opened_by         TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'SHARED',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  answered_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_lens_inquiries_project
  ON russell_lens_inquiries(project_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_lens_inquiries_bin
  ON russell_lens_inquiries(bin_id);

-- One finding a person acted on. Append-only: accepting creates a frontier item
-- and this records that it happened, dismissing records the reason, and neither
-- deletes what the worker proposed.
CREATE TABLE IF NOT EXISTS russell_lens_decisions (
  id                TEXT PRIMARY KEY,
  inquiry_id        TEXT NOT NULL REFERENCES russell_lens_inquiries(id) ON DELETE CASCADE,
  finding_index     INTEGER NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('ACCEPTED','DISMISSED')),
  reason            TEXT,
  -- The frontier item an acceptance created, so the proposal resolves to the
  -- row it became.
  frontier_item_id  TEXT REFERENCES russell_frontier(id) ON DELETE SET NULL,
  decided_by        TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  UNIQUE (inquiry_id, finding_index)
);
