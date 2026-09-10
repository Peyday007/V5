-- Connecting a site to the Brain: the link, the refusals, and the storage reading.
--
-- Numbered 036 rather than 035, which this file briefly was. Step 12A's closure
-- landed `035_worker_sessions.sql` on the same number while this was being
-- written, and `loadMigrationFiles` refuses a duplicate version outright rather
-- than applying one and skipping the other — which is why the collision was a
-- boot failure with a sentence in it rather than a schema that silently missed
-- half of itself. Renumbering was safe because this had not been applied to any
-- deployment; 035 had.
--
-- ---------------------------------------------------------------------------
-- Why a link table and not a new kind of record
-- ---------------------------------------------------------------------------
--
-- Deal Dispatch already holds opportunities: their stage, their money, their
-- calls, their contacts. Brain does not want a second copy of any of that and
-- must never become a second master for it. What Brain wants is the small part
-- it can reason about — what this thing is, what state the site says it is in,
-- and enough context to decide whether it is worth researching — attached to
-- the Brain object that already expresses "a thing worth doing that Brain forms
-- an opinion about": a `russell_candidates` row.
--
-- So there is no Opportunity table here, no WorkItem type, no command queue and
-- no second identity. There is one row that says *this Brain object is that
-- site's record*, and everything else is machinery Steps 4 to 12A already built.
--
-- ---------------------------------------------------------------------------
-- The two columns that make a re-run safe
-- ---------------------------------------------------------------------------
--
-- `source_version` is the site's own version of the record — for Deal Dispatch,
-- `updatedAt` as an ISO-8601 string. It is the *only* thing that decides whether
-- an arriving copy is newer, so a redelivered, reordered or replayed update
-- cannot regress a newer one: the write is guarded on it.
--
-- `content_hash` is a sha-256 over the fields Brain actually imported. Two
-- deliveries of the same content are one import whatever their versions say,
-- which is what turns a bounded poll into something that can run every minute
-- without writing anything.
--
-- `UNIQUE (source_system, source_record_id)` is the requirement stated in the
-- assignment and the reason a backfill is idempotent: a second run collides
-- with the first rather than creating a second Brain object.
--
-- There is deliberately no CHECK constraint listing the source systems. The
-- closed set lives in `domain/types.ts` and is matched exactly in code (§8's
-- rule applied to an integration), because connecting a second site should be
-- a code change somebody reviews rather than a schema migration — and a CHECK
-- here would make it both.
CREATE TABLE external_records (
  id                   TEXT PRIMARY KEY,

  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Identity, on the far side.
  source_system        TEXT NOT NULL,
  source_record_type   TEXT NOT NULL,
  source_record_id     TEXT NOT NULL,
  source_version       TEXT NOT NULL,
  source_created_at    TEXT,
  -- A path on the source site, relative and validated. Never a host, a scheme
  -- or anything a caller could turn into a redirect: Brain renders it nowhere
  -- and the site itself is the only thing that resolves it.
  source_ref           TEXT,

  -- What Brain imported. Bounded, whitelisted, and never the whole record.
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  attributes           TEXT NOT NULL DEFAULT '{}',
  provenance           TEXT NOT NULL DEFAULT '{}',
  content_hash         TEXT NOT NULL,

  -- The stable logical key for the import effect. Derived from the record, so
  -- it is the same on every attempt (§20).
  idempotency_key      TEXT NOT NULL,

  -- The Brain object this record is expressed as. Null until a person asks for
  -- one: registering a record is not the same act as deciding to work on it.
  candidate_id         TEXT REFERENCES russell_candidates(id) ON DELETE SET NULL,

  -- Attribution for the command, never authorization. The person who pressed
  -- the button is recorded as the site named them; nothing here contributes to
  -- any decision Brain takes.
  commanded_at         TEXT,
  commanded_command    TEXT,
  commanded_by_label   TEXT,

  last_synced_version  TEXT NOT NULL,
  first_seen_at        TEXT NOT NULL,
  updated_at           TEXT NOT NULL,

  UNIQUE (source_system, source_record_id),
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_external_records_project
  ON external_records (project_id, source_system, updated_at);
CREATE INDEX idx_external_records_candidate
  ON external_records (candidate_id);

-- What could not be imported, and why.
--
-- A record Brain cannot map is not dropped and is not guessed at. It is
-- recorded here with a reason from a closed vocabulary and Brain's own sentence
-- about it, so "the backfill imported 41 of 43" is answerable rather than a
-- number nobody can take apart.
--
-- `source_record_id` is `''` rather than NULL for a record that arrived without
-- one, so that repeated deliveries of the same nameless rubbish collide on the
-- unique key instead of accumulating. `occurrences` counts rather than
-- duplicates, for the same reason `bin_session_refusals` does.
--
-- The payload is never stored. A rejection reason is a fact about the delivery;
-- the delivery itself belongs to the site.
CREATE TABLE external_record_rejections (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_system        TEXT NOT NULL,
  source_record_type   TEXT NOT NULL,
  source_record_id     TEXT NOT NULL DEFAULT '',
  reason               TEXT NOT NULL,
  detail               TEXT NOT NULL,
  first_at             TEXT NOT NULL,
  last_at              TEXT NOT NULL,
  occurrences          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_system, source_record_id, reason)
);
CREATE INDEX idx_external_rejections_project
  ON external_record_rejections (project_id, last_at);

-- How much room is left, sampled rather than guessed.
--
-- Growth is a difference between two observations, so there has to be more than
-- one. This table is that history: one bounded sample, taken no more often than
-- the reader asks for and never more than once an hour, so a status page that
-- is refreshed constantly does not become the thing filling the disk.
--
-- Every number here is measured. A figure Brain cannot measure on this
-- deployment is absent rather than estimated, and the reading says which.
CREATE TABLE storage_readings (
  id                TEXT PRIMARY KEY,
  observed_at       TEXT NOT NULL,
  provider          TEXT NOT NULL,
  database_bytes    INTEGER,
  -- Bytes of stored evidence, counted once per distinct content hash. Two
  -- documents that are the same file are one file's worth of storage, and
  -- reporting them as two would make the projection wrong in the direction
  -- that costs money.
  object_bytes      INTEGER,
  object_count      INTEGER,
  -- The same objects counted naively, kept beside the deduplicated figure so
  -- the saving is visible rather than merely claimed.
  object_bytes_raw  INTEGER,
  categories        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_storage_readings_at ON storage_readings (observed_at);
