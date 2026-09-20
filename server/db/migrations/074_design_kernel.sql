-- ---------------------------------------------------------------------------
-- THE DESIGN KERNEL
--
-- Brain builds interfaces and has no way to hold an opinion about them. The
-- loop that actually runs today is a person's: a feature lands, a screen
-- appears, the owner looks at it, says fix this, something useful is removed,
-- they say bring that back but change this, another part breaks. Every round of
-- that is a design judgement that was made once, applied to one screen, and
-- written down nowhere — so the next screen makes the same mistake and the
-- owner pays for it again.
--
-- This migration is the smallest state that lets Brain do one bounded design
-- job end to end and get better at it by doing it. Five rules decided every
-- column below, and four of them are rules this repository has already had to
-- learn somewhere else.
--
-- 1. A RENDER IS THE EVIDENCE, AND CODE IS NOT. §9 draws this line for
--    documents — *a file on disk is not something Brain has read* — and it is
--    the same line here one artifact along: a component's source is not the
--    interface, because what a person sees is the product of every stylesheet,
--    every container width and every font that did or did not load. §29 records
--    what reading the wrong one costs: a `mode === 'BAR'` branch that was
--    written, tested and reachable by nothing, because a CSS rule removed the
--    element it lived in. No test of either half could see the other. So a
--    finding here is about a `design_captures` row, and a capture is bytes with
--    a hash on them.
--
-- 2. A CAPTURE IS BOUND TO THE BYTES AND TO THE REVISION. `design_approvals`
--    already refuses to treat an approval as current unless the render-set
--    digest still matches, for the reason its own header gives: a directory is
--    mutable and the next run replaces every file in it. `design_captures`
--    carries the same binding one row down — the hash of this one image, the
--    revision the tree was at — so a finding, a correction and an approval all
--    resolve to the same picture or visibly stop resolving to it.
--
-- 3. A MEASUREMENT AND A JUDGEMENT ARE TWO KINDS OF ANSWER AND NEVER ONE
--    COLUMN. Whether a control is covered at its own centre is a reading; that
--    a screen has too many nested containers is an opinion. §8's rule is that
--    model prose never mutates project state, so the judged lane goes through a
--    bin, a validated submission and recorded lineage exactly as an audit role
--    does — and `design_findings.lane` says which kind of answer each finding
--    is, for ever, because a reader that could not tell them apart would treat
--    a taste as a defect.
--
-- 4. THE TAXONOMY IS SEEDED AND NOT DECLARED. §38's first rule, one subject
--    along: there is no table of UI patterns here and no constant holding one.
--    `design_patterns.primitive` names one of a small seed set of design
--    concerns, and `branch` is whatever the evidence turned out to be about —
--    editorial layout, dense chronology, destructive actions. A branch exists
--    because patterns accumulated under it, so the tree grows from operation
--    rather than from somebody having predicted it. A hardcoded taxonomy would
--    answer the question this kernel exists to ask.
--
-- 5. AN OWNER CORRECTION IS EVIDENCE WITH A SCOPE, NEVER A GLOBAL RULE.
--    "Make this smaller" is almost always about one thing. `design_corrections`
--    records the scope the correction was *given* at and keeps it separate from
--    whether it was ever promoted into a pattern, because the failure mode of
--    getting this wrong is the one the owner already described: a fix applied
--    everywhere removes something useful somewhere else.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- WHAT CAN BE LOOKED AT
--
-- A screen is a route plus a state, and the pair is the unit because the two
-- states of one address routinely fail differently: §29's Needs You said
-- "nothing needs your decision" directly above the one decision nothing could
-- proceed without, and only the populated state showed it.
--
-- Rows rather than a constant, so registering a surface is not a deployment —
-- `fleet_routines`' argument. A seed set is written from code on boot, but the
-- table is the authority and an operator may add to it.
--
-- `concepts` is what this surface is *about*, in the product's own vocabulary,
-- and it is the reason design work here can be product-aware without inventing
-- a domain: it names Brain's own nouns. It is declared rather than inferred,
-- because a kernel that guessed what a screen represents would be hallucinating
-- a product — §25's Westbrook defect at a screen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_surfaces (
  id            TEXT PRIMARY KEY,

  -- Stable key for one screen in one state, e.g. `needs-you/populated`. What
  -- every finding, capture and correction joins on, so it must not be derived
  -- from a title somebody may reword.
  surface_key   TEXT NOT NULL UNIQUE,

  screen        TEXT NOT NULL,
  state_key     TEXT NOT NULL,
  title         TEXT NOT NULL,

  -- The address that opens it, relative to the client root.
  route         TEXT NOT NULL,

  -- What has to be true before the render means anything: a signed-in person, a
  -- standing grant, a seeded decision. A declared list of named preconditions
  -- the harness knows how to satisfy — never a script, because a registry that
  -- carried executable setup would be a second way to run code.
  preconditions TEXT NOT NULL,

  -- The product concepts this surface represents. Brain's own nouns.
  concepts      TEXT NOT NULL,

  -- The actions a person can take here, with what each one costs. This is the
  -- input that lets a design problem be reasoned about rather than styled:
  -- frequency and reversibility are what decide emphasis.
  actions       TEXT NOT NULL,

  -- Which widths this surface is judged at. Declared per surface because the
  -- band that matters is a property of the layout: §29 measured the rejected
  -- build clipping between 822 and 953, which is neither desktop nor phone.
  viewports     TEXT NOT NULL,

  -- Which part of Brain this belongs to, so design priority can be held against
  -- what Brain is currently working on rather than against how bad a screen
  -- looks.
  faculty       TEXT,

  registered_by TEXT NOT NULL,
  -- A surface that stopped existing is retired, never deleted: a capture, a
  -- finding and a correction all point at it, and a delete would make old
  -- evidence unreadable.
  retired_at    TEXT,
  retired_reason TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_design_surfaces_screen ON design_surfaces (screen, state_key);


-- ---------------------------------------------------------------------------
-- ONE OPERATING PASS
--
-- The record of a design cycle: what triggered it, which surfaces it looked at,
-- how many repair rounds it spent, and why it stopped. It exists mainly to hold
-- the *stopping* condition, because an aesthetic loop with no bound is the one
-- failure mode a design system falls into by default — and §12's rule about
-- `MAX_FRAGMENT_ATTEMPTS` is that the honest outcome when the budget runs out
-- is "unresolved", recorded as such.
--
-- `stop_reason` is a closed set and `SETTLED` is only one of five. A cycle that
-- ran out of rounds with findings still open says so, and its findings stay
-- OPEN rather than being closed to make the cycle look finished.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_cycles (
  id            TEXT PRIMARY KEY,

  -- Why this pass exists. Never free text: the operating loop, the expansion
  -- loop and a person asking are three different things to a reader deciding
  -- whether a cycle was worth running.
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN (
                  'UI_IMPACT', 'SURFACE_REGISTERED', 'OWNER_REQUEST',
                  'PROACTIVE_EXPANSION', 'CORRECTION_FOLLOW_UP', 'SCHEDULED')),
  -- The campaign, correction or expansion that caused it, when one did.
  trigger_ref   TEXT,

  surface_keys  TEXT NOT NULL,
  revision      TEXT,

  -- How many render-evaluate-repair rounds have happened. The bound is policy
  -- in code; what is stored is what actually happened.
  passes        INTEGER NOT NULL DEFAULT 0 CHECK (passes >= 0),

  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),

  --   SETTLED            nothing open at the end of a pass
  --   REPAIR_EXHAUSTED   the round ceiling was reached with findings open
  --   NO_RENDER_RUNTIME  nothing could be rendered here, so nothing was judged
  --   NEEDS_PERSON       what is left is a judgement this kernel may not make
  --   ABANDONED          a person or a newer cycle superseded it
  stop_reason   TEXT CHECK (stop_reason IN (
                  'SETTLED', 'REPAIR_EXHAUSTED', 'NO_RENDER_RUNTIME',
                  'NEEDS_PERSON', 'ABANDONED')),
  stop_detail   TEXT,

  opened_at     TEXT NOT NULL,
  closed_at     TEXT,

  CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL)),
  CHECK (state = 'OPEN' OR stop_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_cycles_state ON design_cycles (state, opened_at);


-- ---------------------------------------------------------------------------
-- WHAT WAS ACTUALLY RENDERED
--
-- One row is one picture of one surface at one width, taken by a named engine
-- at a named version, with the readings that were taken *in the page* while it
-- was on the screen.
--
-- `readings` is the deterministic half of perception and it is stored beside
-- the bytes rather than derived later, because it cannot be derived later: a
-- bounding rectangle, `elementFromPoint` at a control's own centre and a
-- computed contrast ratio are facts about a live document, and the PNG has
-- thrown all of them away. §29 is explicit that a box of the right size in the
-- right place is still not a control if something else is painted over it, and
-- no image tells you that.
--
-- `engine` and `engine_version` are provenance in the shape §9 already
-- requires of a recognised page: the renderer, its version, the hash of the
-- exact bytes. A capture whose engine is unknown is not evidence about the
-- product, because two engines lay a page out differently.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_captures (
  id             TEXT PRIMARY KEY,
  cycle_id       TEXT REFERENCES design_cycles(id) ON DELETE SET NULL,
  -- Which repair round produced it, so before and after are orderable without
  -- trusting two timestamps taken seconds apart.
  pass           INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0),

  surface_key    TEXT NOT NULL,
  screen         TEXT NOT NULL,
  state_key      TEXT NOT NULL,

  viewport_name  TEXT NOT NULL,
  width          INTEGER NOT NULL CHECK (width > 0),
  height         INTEGER NOT NULL CHECK (height > 0),

  -- The tree this was a picture of. Null on an unstamped build rather than
  -- guessed — §27's rule about a deployment attesting its own commit.
  revision       TEXT,
  tree_dirty     INTEGER NOT NULL DEFAULT 0 CHECK (tree_dirty IN (0, 1)),

  -- sha-256 of the image bytes. This is what an approval binds to, what a
  -- correction's before and after resolve through, and what makes "the same
  -- render" a fact rather than a filename.
  content_hash   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size >= 0),
  -- Where the bytes were written, relative to the run directory. An address,
  -- never the evidence: the hash is the evidence.
  artifact_ref   TEXT NOT NULL,

  engine         TEXT NOT NULL,
  engine_version TEXT,

  readings       TEXT NOT NULL,

  captured_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_captures_surface
  ON design_captures (surface_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_design_captures_cycle
  ON design_captures (cycle_id, pass);
CREATE INDEX IF NOT EXISTS idx_design_captures_hash
  ON design_captures (content_hash);


-- ---------------------------------------------------------------------------
-- A JUDGEMENT PASS OVER A CAPTURE SET
--
-- The measured lane needs no row here: a reading is reproducible from the
-- capture and nobody's opinion is involved. The judged lane needs one, because
-- the thing that makes a judged finding worth anything is *who* judged it —
-- and §23's floor is that the reviewer is not the author.
--
-- The lineage columns are the same four `research_passes` carries and they come
-- from the same places: the worker from the authenticated principal, the
-- account and Routine from Brain's own dispatch row, the session from the
-- credential the request authenticated with. Nothing a worker says about itself
-- contributes. `independence_tier` is what was *achieved* and is never rounded
-- up — §23 again, at a new table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_reviews (
  id                TEXT PRIMARY KEY,
  cycle_id          TEXT NOT NULL REFERENCES design_cycles(id) ON DELETE CASCADE,
  pass              INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0),

  lane              TEXT NOT NULL CHECK (lane IN ('MEASURED', 'JUDGED')),

  -- The capture set this review was about, digested the way `design_approvals`
  -- digests one: a review of a set is stale the moment the set changes.
  capture_digest    TEXT NOT NULL,
  capture_count     INTEGER NOT NULL CHECK (capture_count >= 0),

  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  worker_id         TEXT,
  session_ref       TEXT,
  account_id        TEXT,
  routine_id        TEXT,

  independence_tier TEXT CHECK (independence_tier IN (
                      'NOT_APPLICABLE', 'SESSION_SEPARATED', 'ROUTINE_SEPARATED',
                      'WORKER_SEPARATED', 'ACCOUNT_SEPARATED')),

  verdict           TEXT NOT NULL CHECK (verdict IN ('CLEAN', 'CHANGES_REQUIRED', 'REFUSED')),
  -- Why a REFUSED review refused, in a worker's own words, kept because a
  -- verdict you cannot trace is not auditable (§8).
  detail            TEXT,
  findings_count    INTEGER NOT NULL DEFAULT 0 CHECK (findings_count >= 0),

  created_at        TEXT NOT NULL,

  -- A judged review without recorded lineage establishes no independence, so it
  -- may not exist: unknown lineage fails closed, for the fourth time.
  CHECK (lane = 'MEASURED' OR (worker_id IS NOT NULL AND session_ref IS NOT NULL)),
  CHECK (lane = 'JUDGED' OR independence_tier = 'NOT_APPLICABLE')
);
CREATE INDEX IF NOT EXISTS idx_design_reviews_cycle ON design_reviews (cycle_id, pass);


-- ---------------------------------------------------------------------------
-- ONE STRUCTURED FINDING
--
-- "The page could benefit from improved visual hierarchy" is the output this
-- table exists to make impossible to store. A finding names the surface, the
-- region, what is wrong, why that matters, how bad it is, what was measured,
-- and what would repair it — and four of those seven are NOT NULL, so a
-- submission that has only an opinion is refused at the write.
--
-- `lane` never changes after it is written. A measured finding is a reading and
-- a judged one is a view, and the difference decides whether disagreeing with
-- it is a bug report or a taste.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_findings (
  id             TEXT PRIMARY KEY,
  cycle_id       TEXT REFERENCES design_cycles(id) ON DELETE SET NULL,
  review_id      TEXT REFERENCES design_reviews(id) ON DELETE SET NULL,
  -- The picture it is about. A finding with no capture is a finding about
  -- nothing, which is the critique this whole table refuses.
  capture_id     TEXT NOT NULL REFERENCES design_captures(id) ON DELETE CASCADE,
  pass           INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0),

  surface_key    TEXT NOT NULL,
  -- Where on the screen, as the page's own selector or component name. Read
  -- from the document rather than described, so a repair can find it.
  region         TEXT NOT NULL,

  lane           TEXT NOT NULL CHECK (lane IN ('MEASURED', 'JUDGED', 'OWNER')),

  -- What kind of problem. Closed, and deliberately shorter than a design
  -- textbook: §27 records four widenings of a closed list that had to be
  -- complete over ordinary English, so this one's failure mode is fixed at
  -- *missing* a kind rather than at inventing one. A branch that turns out to
  -- matter arrives as a pattern first and a kind only if it keeps arriving.
  kind           TEXT NOT NULL CHECK (kind IN (
                   'CONTENT_CLIPPED', 'HORIZONTAL_OVERFLOW', 'CONTROL_UNREACHABLE',
                   'CONTROL_OVERLAPPED', 'CONTENT_MISSING', 'CONTRAST_BELOW_FLOOR',
                   'TOUCH_TARGET_TOO_SMALL', 'RESPONSIVE_REGRESSION', 'EMPTY_STATE_MALFORMED',
                   'HIERARCHY_UNCLEAR', 'EMPHASIS_MISPLACED', 'DENSITY_WRONG',
                   'GROUPING_INCOHERENT', 'CONTAINER_NESTING_EXCESSIVE',
                   'CONTROL_REDUNDANT', 'STATUS_CONTRADICTS_CONTROL',
                   'PURPOSE_MISMATCH')),

  -- The primitive this finding belongs under, so the kernel can see which
  -- design concern it keeps getting wrong. This is what makes the self-model a
  -- reading rather than a guess.
  primitive      TEXT NOT NULL,

  statement      TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,

  severity       TEXT NOT NULL CHECK (severity IN ('BLOCKER', 'MAJOR', 'MINOR', 'NIT')),

  -- What was measured, for a reading; what was pointed at, for a view. JSON, so
  -- a number stays a number and a reader can hold a repair against it.
  evidence       TEXT NOT NULL,

  -- What would fix it. Required: a finding that names no remedy is §24's
  -- escalation with no answering transition, at the level of one sentence on a
  -- screen.
  proposed_repair TEXT NOT NULL,

  state          TEXT NOT NULL CHECK (state IN (
                   'OPEN', 'REPAIRED', 'ACCEPTED', 'WONT_FIX', 'UNRESOLVED', 'SUPERSEDED')),
  -- How it was settled, and by what. A finding that closed because a later
  -- capture no longer showed it names that capture.
  resolved_by    TEXT,
  resolution     TEXT,

  -- The pattern that predicted it, when one did. Null is ordinary: most
  -- findings arrive before there is a pattern for them, and that is how the
  -- patterns get written.
  pattern_id     TEXT,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  CHECK (state = 'OPEN' OR resolution IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_findings_cycle ON design_findings (cycle_id, state);
CREATE INDEX IF NOT EXISTS idx_design_findings_surface ON design_findings (surface_key, created_at);
CREATE INDEX IF NOT EXISTS idx_design_findings_primitive ON design_findings (primitive, lane);

-- One finding per capture per kind per region per review. The arbiter for two
-- ticks reading one completed review, and for a re-evaluation of a capture that
-- has not changed: the same reading is the same finding rather than a second
-- copy of it. `COALESCE` because the measured lane has no review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_findings_once
  ON design_findings (capture_id, kind, region, COALESCE(review_id, '-'));


-- ---------------------------------------------------------------------------
-- WHAT THE OWNER SAID
--
-- The strongest evidence this kernel will ever get, and the easiest to ruin by
-- over-applying. "Make this smaller" is one instruction about one thing; turned
-- into a rule it removes something useful on four other screens, which is
-- exactly the cycle the owner described.
--
-- So `scope` is recorded at the moment the correction is taken and is never
-- widened silently. `promoted_pattern_id` is separate and is usually null: a
-- correction is evidence whether or not it ever becomes a rule, and most never
-- should.
--
-- `before_capture_id` and `after_capture_id` are what make a correction
-- checkable. "I preferred version 2" resolves to two hashes or it resolves to
-- nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_corrections (
  id                  TEXT PRIMARY KEY,

  surface_key         TEXT,
  before_capture_id   TEXT REFERENCES design_captures(id) ON DELETE SET NULL,
  after_capture_id    TEXT REFERENCES design_captures(id) ON DELETE SET NULL,

  -- Their words, verbatim. Never normalised, never filtered: §24's rule that
  -- removing injection-shaped text destroys the evidence somebody tried, and
  -- the ordinary reason too — a paraphrase of a correction is a correction
  -- somebody else made.
  correction          TEXT NOT NULL,

  -- Which parts of the interface it was about, as selectors or component names.
  components          TEXT NOT NULL,

  -- What Brain took from it, in one sentence. Derived by a reader and held
  -- apart from the words, because the two are different claims and only the
  -- first is theirs.
  lesson              TEXT,

  scope               TEXT NOT NULL CHECK (scope IN (
                        'ONE_OFF', 'COMPONENT', 'SCREEN', 'FACULTY', 'GLOBAL')),
  -- What the scope applies to: a component name, a surface key, a faculty.
  -- Null for ONE_OFF and GLOBAL, which need no referent.
  scope_ref           TEXT,

  -- How sure Brain is that the lesson generalises at all. Never a reason to
  -- apply it: `promoted_pattern_id` is the only thing that makes it a rule.
  confidence          TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),

  -- The authenticated person who said it. Never a field a caller sent.
  recorded_by_user_id TEXT NOT NULL,

  promoted_pattern_id TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (scope IN ('ONE_OFF', 'GLOBAL') OR scope_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_corrections_surface
  ON design_corrections (surface_key, created_at);
CREATE INDEX IF NOT EXISTS idx_design_corrections_scope
  ON design_corrections (scope, scope_ref);


-- ---------------------------------------------------------------------------
-- REUSABLE DESIGN KNOWLEDGE
--
-- A pattern is what a screenshot is not: the thing that transfers. "A
-- destructive action is infrequent and costly, so it is visually subordinate
-- until intentionally invoked, and its confirmation is proportional to the
-- consequence" is worth more than a memory of one dialog.
--
-- Every column here exists because a pattern with it missing does damage:
--
--   `applies_when`   a rule with no condition is applied everywhere, which is
--                    the over-generalisation failure this kernel is for.
--   `exceptions`     the case the evidence did not cover, said out loud.
--   `evidence`       claim ids, correction ids, finding ids. A pattern with no
--                    evidence is a style opinion wearing a citation — §12's
--                    rule at a smaller artifact.
--   `confidence`     what it rests on, never how good it sounds.
--   `scope`          how far it reaches, the same vocabulary a correction uses.
--
-- `branch` is how the taxonomy grows. It is free text on purpose: the kernel
-- cannot know in advance that *dense chronological information* is a thing
-- worth distinguishing, and the moment several patterns carry that branch, it
-- is one. A tree declared up front would be the encyclopedia this is not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_patterns (
  id            TEXT PRIMARY KEY,

  primitive     TEXT NOT NULL,
  branch        TEXT,

  statement     TEXT NOT NULL,
  applies_when  TEXT NOT NULL,
  exceptions    TEXT,

  scope         TEXT NOT NULL CHECK (scope IN (
                  'ONE_OFF', 'COMPONENT', 'SCREEN', 'FACULTY', 'GLOBAL')),
  scope_ref     TEXT,

  confidence    TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),

  -- Where it came from. RESEARCH is a gated claim, CORRECTION is the owner,
  -- OPERATION is a finding that kept recurring, SEED is the handful this kernel
  -- starts with so that it can work at all.
  origin        TEXT NOT NULL CHECK (origin IN ('SEED', 'RESEARCH', 'CORRECTION', 'OPERATION')),
  evidence      TEXT NOT NULL,

  state         TEXT NOT NULL CHECK (state IN ('PROPOSED', 'ACTIVE', 'RETIRED')),
  retired_reason TEXT,

  -- The stable identity of what this says, so the same lesson learned twice is
  -- one row. Derived from the statement rather than supplied, for the reason
  -- `system_components.component_key` is: a caller that could choose it could
  -- split one rule in two.
  fingerprint   TEXT NOT NULL UNIQUE,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK (scope IN ('ONE_OFF', 'GLOBAL') OR scope_ref IS NOT NULL),
  CHECK ((state = 'RETIRED') = (retired_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_design_patterns_primitive
  ON design_patterns (primitive, state);
CREATE INDEX IF NOT EXISTS idx_design_patterns_branch
  ON design_patterns (branch);


-- ---------------------------------------------------------------------------
-- WHAT THIS KERNEL CAN AND CANNOT DO
--
-- The design self-model. Two independent dimensions and deliberately no third
-- that aggregates them, for §37's reason at a new registry: one column walking
-- from "we wrote it down" to "it works" is wrong at every value in between and
-- nobody can say which part is wrong.
--
--   ability_state   is there a mechanism         moved by wiring and by proof
--   evidence_state  has it been shown to work    moved by an evaluation
--
-- `limitations` is the half that matters most and the half a capability
-- registry usually omits. A kernel that reports what it can do and not where
-- that stops is a kernel that will be trusted past its evidence.
--
-- `observations` and `failures` are counters rather than a rate, because a rate
-- over two observations reads like a measurement. The expansion loop computes
-- what it needs and stores none of it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_capabilities (
  id                TEXT PRIMARY KEY,
  capability_key    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,

  -- Which design concern this ability serves, so a gap in the self-model maps
  -- onto the same axis findings and patterns use.
  primitive         TEXT NOT NULL,

  ability_state     TEXT NOT NULL DEFAULT 'ABSENT'
                      CHECK (ability_state IN ('ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE')),
  evidence_state    TEXT NOT NULL DEFAULT 'UNTESTED'
                      CHECK (evidence_state IN ('UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN')),

  -- The module, tool or surface that performs it, when something does. Null is
  -- the honest answer for an ability nothing implements, and it is the column
  -- the expansion loop reads to tell "missing" from "untested".
  route             TEXT,
  -- How anybody would know whether it worked. An ability with no evaluation
  -- method can never leave UNTESTED, which is deliberate: that is what it means
  -- to have no way of checking.
  evaluation_method TEXT,

  limitations       TEXT NOT NULL,
  evidence          TEXT NOT NULL,

  observations      INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
  failures          INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  CHECK (evidence_state = 'UNTESTED' OR evaluation_method IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_capabilities_state
  ON design_capabilities (ability_state, evidence_state);


-- ---------------------------------------------------------------------------
-- WHY A DIMENSION MOVED
--
-- `faculty_state_events`' shape and its reason: a registry holding only current
-- values cannot answer *when did Brain start believing it could do this, and on
-- what*, which is the first question somebody asks when a dimension is wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_capability_events (
  id             TEXT PRIMARY KEY,
  capability_key TEXT NOT NULL,
  dimension      TEXT NOT NULL CHECK (dimension IN ('ABILITY', 'EVIDENCE')),
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  evidence_ref   TEXT,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_capability_events_key
  ON design_capability_events (capability_key, created_at);


-- ---------------------------------------------------------------------------
-- THE EXPANSION LOOP'S OWN RECORD
--
-- A gap the kernel found in itself, what it decided was worth doing about it,
-- where it sent that, and what came back. This is the row that makes the third
-- loop a mechanism rather than a claim: an expansion exists because the kernel
-- audited its own capability map, not because something failed.
--
-- `origin` says which, and `PROACTIVE` is the one that matters — §13's default
-- is that Brain does not research, so an expansion has to say why it is worth
-- spending anything on, and "nothing has gone wrong and this is still the
-- weakest thing I can do" is a legitimate answer that has to be distinguishable
-- from "this just broke".
--
-- `route` is where it went, and every value is machinery that already exists.
-- There is no route that means "the design kernel will go and build this
-- itself", because that would be the second capability-acquisition engine the
-- brief forbids and §22 already refuses on other grounds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_expansions (
  id             TEXT PRIMARY KEY,

  capability_key TEXT NOT NULL,

  origin         TEXT NOT NULL CHECK (origin IN ('PROACTIVE', 'FAILURE', 'CORRECTION', 'OWNER_REQUEST')),

  -- What is missing, and why closing it is worth more than the next thing. Both
  -- required, because a gap with no stated value is one nothing can rank.
  statement      TEXT NOT NULL,
  why            TEXT NOT NULL,

  -- The inputs the ranking was made from, recorded so "why did Brain work on
  -- that" is answerable from a snapshot rather than from a re-run against rows
  -- that have moved — `services/dispatch/router.ts`' promise, kept here.
  rank_inputs    TEXT NOT NULL,
  rank           INTEGER NOT NULL,

  --   RESEARCH   a bounded question, through the Russell candidate path
  --   SOFTWARE   a change to Brain, through the Software Factory a person
  --              authorizes on the Build surface
  --   READING    something Brain can answer from its own rows
  --   PERSON     a decision no amount of building closes
  route          TEXT NOT NULL CHECK (route IN ('RESEARCH', 'SOFTWARE', 'READING', 'PERSON')),
  -- The candidate, request or reading this became.
  route_ref      TEXT,

  state          TEXT NOT NULL CHECK (state IN (
                   'IDENTIFIED', 'ROUTED', 'EVALUATED', 'PROMOTED', 'REJECTED', 'PARKED')),
  -- Why it ended where it did. Required on every terminal state, because a
  -- rejection with no reason is the silently destroyed claim §33 records.
  outcome        TEXT,
  evidence       TEXT NOT NULL,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  CHECK (state IN ('IDENTIFIED', 'ROUTED') OR outcome IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_expansions_state
  ON design_expansions (state, rank);
CREATE INDEX IF NOT EXISTS idx_design_expansions_capability
  ON design_expansions (capability_key, created_at);

-- One live expansion per capability. Two ticks both deciding that mobile
-- interaction is the weakest thing Brain does must produce one piece of work,
-- and the arbiter is the index rather than a check-then-write — the ninth time
-- this repository has needed a compare-and-swap on a value the claimant does
-- not supply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_expansions_live
  ON design_expansions (capability_key) WHERE state IN ('IDENTIFIED', 'ROUTED');
