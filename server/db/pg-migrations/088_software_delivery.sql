-- The Postgres half of SQLite migration 097. A software change asked for in a conversation, followed all the way back to
-- that conversation.
--
-- Three columns on the request and one append-only ledger beside it.
--
-- `acceptance_conditions` is what "done" means, shown on the card before a
-- person authorizes and passed to the contract when they do. It existed on the
-- factory's change request and nowhere on the request a conversation writes, so
-- an Authorize pressed in Russell submitted a contract with no conditions and
-- the factory — correctly — refused to approve it. The entrance could never
-- start a campaign.
--
-- `live_check` is the one behaviour Brain is asked to confirm in production
-- after a release: a path on this Brain's own origin and a piece of text it must
-- serve. A person sees it on the card before they authorize; Brain chooses the
-- host (its own) and never a caller.
--
-- `delivery_polled_at` bounds how often the forge is asked about one request.
--
-- `software_delivery_milestones` is what happened, once each: the campaign's
-- stages, a blocker, the pull request becoming ready for a release decision,
-- the person refusing it, the forge reporting a merge, the serving revision
-- containing it, and the live check. The unique key is the whole idempotency
-- design — a tick that runs twice, or two instances, write one row — and the
-- message each milestone puts into the originating conversation is written only
-- by the caller that inserted it.
ALTER TABLE russell_software_requests ADD COLUMN acceptance_conditions TEXT;
ALTER TABLE russell_software_requests ADD COLUMN live_check TEXT;
ALTER TABLE russell_software_requests ADD COLUMN delivery_polled_at TEXT;

CREATE TABLE IF NOT EXISTS software_delivery_milestones (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES russell_software_requests(id),
  conversation_id  TEXT NOT NULL,
  milestone_key    TEXT NOT NULL,
  kind             TEXT NOT NULL,
  detail           TEXT NOT NULL,
  message_id       TEXT,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('BRAIN', 'PERSON')),
  actor_id         TEXT,
  observed_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_software_delivery_milestones_key
  ON software_delivery_milestones(request_id, milestone_key);

CREATE INDEX IF NOT EXISTS idx_software_delivery_milestones_request
  ON software_delivery_milestones(request_id, observed_at);
