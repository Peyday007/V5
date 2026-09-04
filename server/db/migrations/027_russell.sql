-- Step 12A — Russell's canonical state.
--
-- Russell is the user-facing name of this Brain. Everything below is additive:
-- no existing table is rebuilt, no existing column is dropped, and no existing
-- row is rewritten. That is not politeness — the pre-12A `conversations` and
-- `messages` rows are the project's own history, and a migration that rewrote
-- them to fit a new shape would be destroying provenance to save a join.
--
-- Ten tables, and each one exists because removing it breaks the loop this step
-- turns on: conversation -> judgment -> ranked mission -> the existing packet,
-- bin and fleet pipeline -> grounded result -> knowledge writeback -> the next
-- mission. Anything that only makes that loop nicer is in STEP-12B-BACKLOG.md.
--
-- Three rules run through all of it:
--
--   1. **Scope attaches at creation.** Every row below carries the project and
--      visibility it was created under. Privacy is not a filter applied on the
--      way out; a derived record inherits the most restrictive scope that
--      contributed to it, and there is nowhere for an unscoped row to exist.
--
--   2. **A park has an answering transition.** Every state a row can rest in
--      while waiting for something has a guarded edge back into work or an
--      honest terminal. Step 10 paid for that lesson twice; a state that says
--      it is waiting for a person and cannot accept that person's answer is
--      stuck, not waiting.
--
--   3. **History is appended, never overwritten.** A correction inserts. An
--      override inserts. A supersession inserts and points backwards. Current
--      belief may move; the record of what was believed does not.

-- ---------------------------------------------------------------------------
-- CONVERSATION
-- ---------------------------------------------------------------------------

-- A Russell thread.
--
-- `project_id` is nullable, and that single fact is why this is a new table
-- rather than columns bolted onto `conversations`. A person must be able to
-- start talking before choosing a project — "recognise Deal Dispatch from what
-- I said" is the capability — and `conversations.project_id` is NOT NULL.
-- Rebuilding that table to relax it would rewrite every historical row to gain
-- a nullable column, which is a bad trade.
--
-- `legacy_conversation_id` is how the old transcripts arrive instead. A backfill
-- creates one Russell thread per existing conversation and **moves no
-- messages**: the legacy rows keep their ids, authors, timestamps and scope
-- exactly where they are, and the read projection unions them with
-- `russell_messages` by `created_at`. One message, one home, no copy, and an
-- old conversation is readable and usable as authorized provenance on day one.
CREATE TABLE russell_conversations (
  id                     TEXT PRIMARY KEY,

  -- Who owns the thread. Not "who spoke last" — ownership decides who may read
  -- a PRIVATE thread and who may promote its content into shared knowledge.
  owner_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Nullable on purpose. NULL means Russell has not attached it yet, which is
  -- a real state and not an error.
  project_id             TEXT REFERENCES projects(id) ON DELETE SET NULL,

  title                  TEXT NOT NULL,

  -- PRIVATE is the default and the safe direction. A thread becomes SHARED
  -- only by an explicit, attributed act — never because its content turned out
  -- to be useful to a project.
  visibility             TEXT NOT NULL DEFAULT 'PRIVATE',

  -- How sure Russell is of the current attachment, 0..100, and the plain reason
  -- it gives when asked. The reason is shown to the person, so it names
  -- evidence rather than a score.
  attachment_confidence  INTEGER,
  attachment_source      TEXT NOT NULL DEFAULT 'NONE',

  -- The last grounded state needed to resume coherently after a restart, as
  -- JSON. Derived, replaceable, and never the only copy of anything.
  grounding              TEXT NOT NULL DEFAULT '{}',

  -- A pre-12A `conversations` row this thread continues. Unique so two Russell
  -- threads cannot claim the same transcript.
  legacy_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  UNIQUE (legacy_conversation_id),
  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (attachment_source IN ('NONE','AUTOMATIC','USER','MIGRATED')),
  CHECK (attachment_confidence IS NULL
         OR (attachment_confidence >= 0 AND attachment_confidence <= 100))
);
CREATE INDEX idx_russell_conversations_owner ON russell_conversations (owner_user_id, updated_at);
CREATE INDEX idx_russell_conversations_project ON russell_conversations (project_id, updated_at);

-- Every attachment this thread has ever had, in order.
--
-- Append-only, and that is what makes correction learning possible without
-- rewriting history. A correction inserts a `USER` row; the previous
-- `AUTOMATIC` row stays, still saying what Russell thought and why. A later
-- equivalent conversation can then be routed against evidence that a person
-- disagreed here before — which is the difference between learning from a
-- correction and merely obeying the last one.
CREATE TABLE russell_conversation_context (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES russell_conversations(id) ON DELETE CASCADE,

  -- NULL is meaningful here too: "Russell detached this" is a decision worth
  -- recording, not an absence.
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,

  source          TEXT NOT NULL,
  confidence      INTEGER,

  -- Why. Shown to the person, so it names the evidence — never a bare number.
  reason          TEXT NOT NULL,

  -- Who decided, for a USER correction. NULL when Russell decided.
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,

  created_at      TEXT NOT NULL,

  CHECK (source IN ('AUTOMATIC','USER','MIGRATED')),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);
CREATE INDEX idx_russell_context_conversation
  ON russell_conversation_context (conversation_id, created_at);

-- Russell-era turns.
--
-- `pending_reason` is the honest half of a model-backed conversation. The
-- deployed Brain has no paid inference path and may not buy one, so a Russell
-- answer is carried by the fixed-subscription fleet and does not arrive in the
-- same request. An unanswered turn is therefore a real, persisted state with a
-- retryable reason — never a canned sentence that looks grounded, and never a
-- silent hang. It resolves exactly once.
CREATE TABLE russell_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES russell_conversations(id) ON DELETE CASCADE,

  role            TEXT NOT NULL,

  -- The person who wrote it. NULL for Russell's own turns.
  author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,

  content         TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'COMPLETE',
  pending_reason  TEXT,

  -- What this turn produced, as ids rather than prose: candidates, probes,
  -- missions, human requests. JSON, and every id in it is validated before it
  -- is written.
  produced        TEXT NOT NULL DEFAULT '{}',

  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (role IN ('USER','RUSSELL','SYSTEM')),
  CHECK (status IN ('COMPLETE','PENDING','FAILED')),
  -- A pending turn must say why it is pending. "Waiting" with no reason is the
  -- state a person cannot act on.
  CHECK (status <> 'PENDING' OR pending_reason IS NOT NULL)
);
CREATE INDEX idx_russell_messages_conversation ON russell_messages (conversation_id, created_at);
CREATE INDEX idx_russell_messages_pending ON russell_messages (status, created_at);

-- ---------------------------------------------------------------------------
-- CANDIDATES — Russell's own judgment, as state rather than prose
-- ---------------------------------------------------------------------------

-- A meaningful possible piece of work.
--
-- The priority and the reason live here, not in the generated wording of a
-- reply, because a decision that exists only in chat text cannot be ranked,
-- overridden, re-derived after a restart, or disagreed with later. Russell must
-- be able to say "this should not be built yet, and here is why" and have that
-- survive the conversation it was said in.
--
-- `canonical_candidate_id` is the merge link. A merge is a pointer, never a
-- delete: a model's confidence score may not permanently erase a valid idea, so
-- the merged row keeps its identity and a guarded split restores it with the
-- merge and the correction both still on the record.
CREATE TABLE russell_candidates (
  id                     TEXT PRIMARY KEY,

  project_id             TEXT REFERENCES projects(id) ON DELETE CASCADE,
  visibility             TEXT NOT NULL DEFAULT 'PRIVATE',

  conversation_id        TEXT REFERENCES russell_conversations(id) ON DELETE SET NULL,
  source_message_id      TEXT REFERENCES russell_messages(id) ON DELETE SET NULL,

  title                  TEXT NOT NULL,
  statement              TEXT NOT NULL,

  -- The cheap deterministic key, tried before any semantic comparison. Two
  -- identical asks collide here for free.
  fingerprint            TEXT NOT NULL,

  state                  TEXT NOT NULL DEFAULT 'CAPTURED',
  canonical_candidate_id TEXT REFERENCES russell_candidates(id) ON DELETE SET NULL,

  -- Russell's view. `priority` is the label a person sees translated
  -- ("Must do", "Big move", …); `ordinal` ranks within it; `reason` is the
  -- plain sentence; `judgment` holds the structured inputs — expected value,
  -- urgency, dependency, cost of reducing uncertainty, capacity class — so the
  -- ranking can be re-derived rather than merely re-asserted.
  priority               TEXT,
  ordinal                INTEGER,
  confidence             INTEGER,
  reason                 TEXT,
  judgment               TEXT NOT NULL DEFAULT '{}',

  -- Knowledge that supports or contradicts it, as ids into russell_knowledge.
  supporting             TEXT NOT NULL DEFAULT '[]',
  contradicting          TEXT NOT NULL DEFAULT '[]',

  -- An override does not erase Russell's view; it supersedes it, and both are
  -- readable afterwards.
  override_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  override_reason        TEXT,
  override_at            TEXT,
  superseded_decision    TEXT,

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (state IN ('CAPTURED','PROBING','PROMOTED','QUEUED','PARKED','REJECTED','MERGED','DONE')),
  CHECK (priority IS NULL
         OR priority IN ('MUST_DO','BIG_MOVE','WORTH_DOING','EXPLORE','PARKED')),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  -- A merged candidate points somewhere, and nothing else does. Without this a
  -- row could claim MERGED with no canonical, which reads as "handled" and is
  -- an idea silently dropped.
  CHECK ((state = 'MERGED') = (canonical_candidate_id IS NOT NULL)),
  CHECK (canonical_candidate_id IS NULL OR canonical_candidate_id <> id)
);
CREATE INDEX idx_russell_candidates_project ON russell_candidates (project_id, state, updated_at);
CREATE INDEX idx_russell_candidates_fingerprint ON russell_candidates (project_id, fingerprint);
CREATE INDEX idx_russell_candidates_rank ON russell_candidates (project_id, priority, ordinal);

-- Merges and splits, kept so a mistaken merge is correctable rather than final.
CREATE TABLE russell_candidate_merges (
  id                TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL REFERENCES russell_candidates(id) ON DELETE CASCADE,
  canonical_id      TEXT NOT NULL REFERENCES russell_candidates(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  method            TEXT NOT NULL,
  confidence        INTEGER,
  reason            TEXT NOT NULL,
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,

  CHECK (action IN ('MERGE','SPLIT')),
  CHECK (method IN ('FINGERPRINT','SEMANTIC','USER'))
);
CREATE INDEX idx_russell_merges_candidate ON russell_candidate_merges (candidate_id, created_at);

-- ---------------------------------------------------------------------------
-- LIGHT PROBES — bounded, and bounded by the server
-- ---------------------------------------------------------------------------

-- A cheap look, to decide whether a candidate deserves a mission.
--
-- This is deliberately not a small research packet. It has no synthesis, no
-- formal audit, no filing and no external effect, and the envelope is enforced
-- in server code rather than described to a model: `max_lookups` is counted
-- against `russell_probe_observations`, `deadline_at` is compared to the
-- Brain's clock, and `allowed_sources` is a fixed allowlist checked before a
-- request is made rather than after.
--
-- A probe that reaches a bound stops honestly with UNKNOWN or REFUSED. It never
-- grows into a packet, because a mechanism that can quietly upgrade its own
-- limits does not have limits.
CREATE TABLE russell_probes (
  id               TEXT PRIMARY KEY,

  candidate_id     TEXT NOT NULL REFERENCES russell_candidates(id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
  visibility       TEXT NOT NULL DEFAULT 'PRIVATE',

  question         TEXT NOT NULL,

  -- JSON array of exact hosts or URL prefixes. Empty means the probe may reach
  -- nothing, which is a valid and safe configuration.
  allowed_sources  TEXT NOT NULL DEFAULT '[]',
  max_lookups      INTEGER NOT NULL,
  deadline_at      TEXT NOT NULL,

  -- What it reserved from the goal budget, released or settled on terminal.
  reservation_id   TEXT,

  state            TEXT NOT NULL DEFAULT 'PENDING',
  outcome          TEXT,
  explanation      TEXT,

  lookups_used     INTEGER NOT NULL DEFAULT 0,

  -- Derived from the candidate and the question, so a retry is the same probe.
  idempotency_key  TEXT NOT NULL,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT,

  UNIQUE (idempotency_key),
  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (state IN ('PENDING','RUNNING','COMPLETE','FAILED')),
  CHECK (outcome IS NULL
         OR outcome IN ('SUPPORTED','WEAKENED','DUPLICATE','UNKNOWN','REFUSED')),
  CHECK (max_lookups > 0),
  -- A finished probe has said something. "Complete" with no outcome would be a
  -- probe whose result nobody can act on.
  CHECK (state <> 'COMPLETE' OR outcome IS NOT NULL)
);
CREATE INDEX idx_russell_probes_candidate ON russell_probes (candidate_id, created_at);
CREATE INDEX idx_russell_probes_state ON russell_probes (state, deadline_at);

-- What the probe actually read. One row per lookup, which is also how the
-- lookup budget is counted — a counter a caller increments is a counter a
-- caller can forget to increment.
CREATE TABLE russell_probe_observations (
  id           TEXT PRIMARY KEY,
  probe_id     TEXT NOT NULL REFERENCES russell_probes(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  source_url   TEXT NOT NULL,
  retrieval    TEXT NOT NULL,
  note         TEXT,
  observed_at  TEXT NOT NULL,

  UNIQUE (probe_id, ordinal),
  CHECK (retrieval IN ('RETRIEVED','REFUSED','BLOCKED','UNREACHABLE','NOT_FOUND'))
);

-- ---------------------------------------------------------------------------
-- STANDING AUTHORITY AND BUDGET
-- ---------------------------------------------------------------------------

-- What Russell may do without asking again.
--
-- There is deliberately no "auto" boolean anywhere in this schema. An
-- all-powerful flag is not authority; it is the absence of it. A grant names
-- the project, the work classes, the window, the ceilings and the explicit
-- prohibitions, and server code revalidates the exact grant and version
-- immediately before every launch, provider call, writeback and resume.
--
-- **This migration creates no grant.** A migration that installed a default
-- standing authority would be the system granting itself permission, which is
-- the one thing standing authority exists to prevent. Only an authenticated
-- human permitted by the role matrix may create, widen or revoke one; Russell
-- and workers consume and may never mint or expand.
CREATE TABLE russell_goals (
  id                  TEXT PRIMARY KEY,

  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name                TEXT NOT NULL,
  policy_version      INTEGER NOT NULL DEFAULT 1,

  -- JSON arrays. A work class absent from `allowed_work` is not authorized,
  -- and an action named in `prohibitions` is refused however it is reached.
  allowed_work        TEXT NOT NULL DEFAULT '[]',
  prohibitions        TEXT NOT NULL DEFAULT '[]',

  -- Ceilings, enforced at reservation time. A ceiling is not a target: unused
  -- authority is headroom, never work Russell is encouraged to invent.
  max_missions        INTEGER NOT NULL,
  max_fragments       INTEGER NOT NULL,
  max_concurrent      INTEGER NOT NULL,
  max_probes          INTEGER NOT NULL,

  -- Zero, and it stays zero unless a separately stored human authorization says
  -- otherwise. No code path may raise it on its own.
  max_external_spend  INTEGER NOT NULL DEFAULT 0,

  starts_at           TEXT NOT NULL,
  expires_at          TEXT,

  state               TEXT NOT NULL DEFAULT 'ACTIVE',
  revoked_at          TEXT,
  revoked_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,

  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN ('ACTIVE','PAUSED','REVOKED','EXPIRED')),
  CHECK (max_missions >= 0 AND max_fragments >= 0 AND max_concurrent >= 0 AND max_probes >= 0),
  CHECK (max_external_spend >= 0)
);
CREATE INDEX idx_russell_goals_project ON russell_goals (project_id, state);

-- One atomic slice of a goal's budget.
--
-- Reservation is an INSERT with a unique idempotency key, which is the same
-- primitive Step 6 uses for effects and for the same reason: exactly one caller
-- inserts, and every equivalent caller collides and reads the row it lost to.
-- A replay therefore cannot consume budget twice, and two concurrent launches
-- cannot both believe they got the last slot.
CREATE TABLE russell_budget_reservations (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL REFERENCES russell_goals(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL,
  amount          INTEGER NOT NULL DEFAULT 1,

  -- Derived from what is being done, never from the attempt doing it. A key
  -- that changes on retry is not an idempotency key.
  idempotency_key TEXT NOT NULL,

  state           TEXT NOT NULL DEFAULT 'HELD',
  expires_at      TEXT NOT NULL,

  settled_at      TEXT,
  released_at     TEXT,
  release_reason  TEXT,

  created_at      TEXT NOT NULL,

  UNIQUE (idempotency_key),
  CHECK (kind IN ('MISSION','FRAGMENT','PROBE')),
  CHECK (state IN ('HELD','SETTLED','RELEASED','EXPIRED')),
  CHECK (amount > 0)
);
CREATE INDEX idx_russell_reservations_goal ON russell_budget_reservations (goal_id, state);

-- ---------------------------------------------------------------------------
-- MISSIONS
-- ---------------------------------------------------------------------------

-- Russell's user-facing work object, and the spine that links everything.
--
-- Every link below is a foreign key or an id column, never a title match. Step 9
-- learned that: an identity reconstructed by matching titles is an identity that
-- breaks the first time two things are called the same thing.
--
-- The five user-facing groups — Working now, Up next, Exploring, Waiting,
-- Finished — are a projection of `state`. The packet, fragment, pass, bin,
-- dispatch and audit detail stays exactly where it is, reachable under "How it
-- is being done", and is not promoted into the main object.
CREATE TABLE russell_missions (
  id                  TEXT PRIMARY KEY,

  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id            TEXT REFERENCES layers(id) ON DELETE SET NULL,
  visibility          TEXT NOT NULL DEFAULT 'PRIVATE',

  candidate_id        TEXT REFERENCES russell_candidates(id) ON DELETE SET NULL,
  conversation_id     TEXT REFERENCES russell_conversations(id) ON DELETE SET NULL,
  probe_id            TEXT REFERENCES russell_probes(id) ON DELETE SET NULL,

  goal_id             TEXT REFERENCES russell_goals(id) ON DELETE SET NULL,
  reservation_id      TEXT REFERENCES russell_budget_reservations(id) ON DELETE SET NULL,

  objective           TEXT NOT NULL,
  why_now             TEXT NOT NULL,

  state               TEXT NOT NULL DEFAULT 'PLANNED',
  waiting_on          TEXT,

  -- The existing pipeline, linked rather than reimplemented.
  orchestration_id    TEXT,
  bin_id              TEXT,
  document_id         TEXT,
  audit_id            TEXT,

  -- Set exactly once, by the completion observer, inside the same transaction
  -- that performs the writeback. Its presence is what makes a second writeback
  -- a no-op rather than a duplicate.
  writeback_at        TEXT,

  next_mission_id     TEXT REFERENCES russell_missions(id) ON DELETE SET NULL,
  terminal_reason     TEXT,

  -- Derived from the candidate and the goal, so a retried launch is the same
  -- mission rather than a second one.
  idempotency_key     TEXT NOT NULL,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,

  UNIQUE (idempotency_key),
  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN','DONE','FAILED','CANCELLED')),
  -- Waiting says what for. A mission parked on nothing nameable is the state
  -- nobody can clear.
  CHECK (state NOT IN ('WAITING','NEEDS_HUMAN') OR waiting_on IS NOT NULL)
);
CREATE INDEX idx_russell_missions_project ON russell_missions (project_id, state, updated_at);
CREATE INDEX idx_russell_missions_candidate ON russell_missions (candidate_id);
CREATE INDEX idx_russell_missions_orchestration ON russell_missions (orchestration_id);

-- ---------------------------------------------------------------------------
-- KNOWLEDGE
-- ---------------------------------------------------------------------------

-- What Russell knows, in a form a person can read.
--
-- This references accepted evidence; it never copies it. `existing_claims` and
-- `research_claims` remain the ledgers, `documents` remain the artifacts, and a
-- knowledge row carries provenance pointers into them. Duplicating the evidence
-- warehouse here would create a second copy that drifts, and the drifted copy
-- is always the one somebody reads.
--
-- Gaps and contradictions are stored as first-class kinds rather than left
-- inside generated prose, because candidate judgment queries them. That is the
-- soil the later Discovery Frontier needs; it is not the Frontier.
CREATE TABLE russell_knowledge (
  id                  TEXT PRIMARY KEY,

  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id            TEXT REFERENCES layers(id) ON DELETE SET NULL,
  visibility          TEXT NOT NULL DEFAULT 'SHARED',

  kind                TEXT NOT NULL,

  -- The plain sentence first. Technical evidence is expandable, never the
  -- default reading.
  statement           TEXT NOT NULL,
  detail              TEXT,

  -- Where it came from, as ids: accepted claim, document, audit, conversation,
  -- mission, or a human decision. JSON, validated before write.
  provenance          TEXT NOT NULL DEFAULT '{}',
  author_type         TEXT NOT NULL,

  -- Confidence follows evidence, not tone.
  confidence          TEXT NOT NULL DEFAULT 'UNCERTAIN',

  -- Currentness is a fact about the world, so it is stored rather than inferred
  -- from row age.
  as_of               TEXT,
  last_confirmed_at   TEXT,

  -- Supersession points backwards and deletes nothing.
  supersedes_id       TEXT REFERENCES russell_knowledge(id) ON DELETE SET NULL,
  superseded_by_id    TEXT REFERENCES russell_knowledge(id) ON DELETE SET NULL,

  mission_id          TEXT REFERENCES russell_missions(id) ON DELETE SET NULL,
  conversation_id     TEXT REFERENCES russell_conversations(id) ON DELETE SET NULL,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (kind IN ('CONCLUSION','ASSUMPTION','UNKNOWN','DECISION','GAP','CONTRADICTION')),
  CHECK (author_type IN ('RUSSELL','HUMAN','PIPELINE')),
  CHECK (confidence IN ('ESTABLISHED','SUPPORTED','UNCERTAIN','DISPUTED')),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);
CREATE INDEX idx_russell_knowledge_project ON russell_knowledge (project_id, kind, updated_at);
CREATE INDEX idx_russell_knowledge_current ON russell_knowledge (project_id, superseded_by_id);

-- ---------------------------------------------------------------------------
-- NEEDS YOU
-- ---------------------------------------------------------------------------

-- A decision only a person may take.
--
-- Derived from an authority boundary, never from arbitrary failure text: a
-- request exists because a named action falls outside stored authority, and it
-- carries the exact transition that resumes the work once answered. `resume_key`
-- is that transition's idempotency key, so a double-submitted answer resumes
-- once and a reload after answering is safe.
--
-- Russell must not use this for anything standing authority already covers.
-- Ordinary research-plan approval, retries, fragment layout, worker assignment,
-- synthesis and audit are Russell's to decide; spending, external effects,
-- irreversible actions, ambiguous access and scope expansion are not.
CREATE TABLE russell_human_requests (
  id                 TEXT PRIMARY KEY,

  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  visibility         TEXT NOT NULL DEFAULT 'SHARED',

  mission_id         TEXT REFERENCES russell_missions(id) ON DELETE CASCADE,
  candidate_id       TEXT REFERENCES russell_candidates(id) ON DELETE SET NULL,
  conversation_id    TEXT REFERENCES russell_conversations(id) ON DELETE SET NULL,

  -- What is needed, why Russell cannot decide it, and what it recommends.
  authority_needed   TEXT NOT NULL,
  why_not_russell    TEXT NOT NULL,
  recommendation     TEXT,

  -- JSON: the allowed choices and what each one causes. An action with no
  -- guarded server transition must not appear here, because an option a person
  -- can press and nothing happens is worse than no option.
  choices            TEXT NOT NULL DEFAULT '[]',

  urgency            TEXT NOT NULL DEFAULT 'WHENEVER',
  state              TEXT NOT NULL DEFAULT 'OPEN',

  answered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  answered_choice    TEXT,
  answered_reason    TEXT,
  answered_at        TEXT,

  resume_key         TEXT NOT NULL,

  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  UNIQUE (resume_key),
  CHECK (visibility IN ('PRIVATE','SHARED')),
  CHECK (urgency IN ('URGENT','BLOCKING','WHENEVER')),
  CHECK (state IN ('OPEN','ANSWERED','RESUMED','WITHDRAWN')),
  -- An answered request records who answered and with what. Anything less is a
  -- state change nobody can attribute.
  CHECK (state NOT IN ('ANSWERED','RESUMED')
         OR (answered_by_user_id IS NOT NULL AND answered_choice IS NOT NULL))
);
CREATE INDEX idx_russell_requests_open ON russell_human_requests (project_id, state, urgency);
CREATE INDEX idx_russell_requests_mission ON russell_human_requests (mission_id);

-- ---------------------------------------------------------------------------
-- THE LOOP
-- ---------------------------------------------------------------------------

-- Russell's cycle, as a row rather than an in-memory timer.
--
-- One row, id 'singleton'. It exists so the loop can be resumed after a restart
-- without replaying what it already did, paused by an operator without a
-- deployment, and prevented from amplifying itself: `max_launches_per_cycle`
-- and `max_followons_per_cycle` bound how much one cycle may start, and hitting
-- a bound preserves the remaining candidates for the next cycle rather than
-- dropping them or spending the whole goal budget in a self-generated chain.
--
-- `lease_owner` and `lease_expires_at` make the loop a singleton across
-- instances the same way the queue does it — by a guarded update, not by hoping
-- only one process runs.
CREATE TABLE russell_cycle (
  id                      TEXT PRIMARY KEY,

  generation              INTEGER NOT NULL DEFAULT 0,
  cursor_at               TEXT,

  lease_owner             TEXT,
  lease_expires_at        TEXT,

  state                   TEXT NOT NULL DEFAULT 'RUNNING',
  pause_reason            TEXT,
  paused_by_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Amplification bounds. Configurable and auditable rather than compiled in.
  max_launches_per_cycle  INTEGER NOT NULL DEFAULT 1,
  max_followons_per_cycle INTEGER NOT NULL DEFAULT 1,
  max_events_per_cycle    INTEGER NOT NULL DEFAULT 50,
  max_retry_age_minutes   INTEGER NOT NULL DEFAULT 60,

  last_ran_at             TEXT,
  last_error              TEXT,

  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,

  CHECK (state IN ('RUNNING','PAUSED','STOPPED')),
  CHECK (max_launches_per_cycle >= 0 AND max_followons_per_cycle >= 0),
  CHECK (max_events_per_cycle > 0)
);

-- The singleton, RUNNING but with nothing to do. It grants no authority: the
-- loop can only act inside a `russell_goals` grant, and this migration creates
-- none.
INSERT INTO russell_cycle (id, created_at, updated_at)
VALUES ('singleton', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
