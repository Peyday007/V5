-- ---------------------------------------------------------------------------
-- THE MONETIZATION POSSIBILITY LEDGER
--
-- A discovery arrives and Brain records one way of making money from it: the
-- `mechanism` column on `cash_opportunities`, chosen at promotion by a mapping
-- from the claim's declared signal, before anybody has established a payer, a
-- price or a route. Production's thirty-one records are thirty-one single
-- answers to a question that has dozens, and the other answers were never
-- written down — so the alternatives were destroyed before the evidence that
-- would have chosen between them existed.
--
-- This migration is the missing breadth. Five rules decided every column.
--
-- 1. NOTHING DERIVABLE IS STORED. There is no status column, no rank column,
--    no score, no margin and no expected value in this schema. All of them are
--    facts about rows that change underneath them — `tier.ts`'s reasoning and
--    `placements`' before it — and a stored verdict is stale the moment the
--    evidence it waited on arrives. Deriving them is also what reaches the
--    paths already written: a deploy reclassifies the whole ledger with
--    nothing rewritten, nothing duplicated and nothing deleted.
--
-- 2. WHAT IS STORED IS WHAT A DERIVATION CANNOT RECOVER. Three things: that a
--    person named a possibility, that a person judged one, and that a rank
--    *moved*. The first two are §38's own pair at a new table. The third is
--    §29's argument for the frontier table — everything about a position can
--    be re-derived except the fact that it used to be somewhere else, which is
--    exactly what the brief asks for as "previous rank" and "reason for
--    ranking movement".
--
-- 3. A POSSIBILITY IS ENUMERATED OR EVIDENCED, NEVER INVENTED. `origin` is the
--    whole of it. ENUMERATED means the closed method table in
--    `domain/monetization.ts` was applied to this subject's own recorded
--    facts, which is arithmetic over rows. EVIDENCED means a worker that read
--    a source declared one, and the CHECK below makes the claim mandatory —
--    `industry_nodes`' shape, for its reason. SEED is a person, and it is the
--    one origin Brain may never write.
--
-- 4. AN UNKNOWN IS NEVER A FAVOURABLE ASSUMPTION. Every figure is nullable and
--    a null withholds rather than lowers: a path with no established capital
--    requirement does not rank as cheap, it ranks last on cost. §30's rule at
--    the numbers that decide what a person looks at first.
--
-- 5. NOTHING IS DELETED, EVER. A possibility that ranks 40th today is the one
--    that ranks 2nd when a supplier is found, so a low rank is not a reason to
--    remove a row — which is the brief's own central instruction. Merging and
--    splitting are pointers between rows that both stay readable, and
--    invalidation is a judgement row rather than a delete.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- ONE WAY MONEY COULD COME OUT OF ONE DISCOVERY
--
-- The subject is an opportunity or an industry node, exactly one, in
-- `opportunity_constraints`' shape and for its reason: a possibility attached
-- to both would be counted twice by anything that reads either. An opportunity
-- is the discovery record this Brain already has for a published request, a
-- spread, an expiring opening or a procurement notice; a node is a buyer type,
-- a sub-industry or a bottleneck the industry kernel mapped.
--
-- `method` is the shape of the transaction, from the closed set. The unique
-- index below is what makes enumeration idempotent: one method per subject, so
-- a tick that runs the table again writes what it wrote before rather than a
-- second copy, and a worker that later *evidences* a method Brain had already
-- enumerated strengthens that row with facts instead of forking it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_paths (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),

  -- What this is a way of monetizing. Exactly one.
  opportunity_id    TEXT REFERENCES cash_opportunities(id),
  industry_node_id  TEXT REFERENCES industry_nodes(id),

  method            TEXT NOT NULL,

  -- What a person reads. Composed by Brain from the method declaration and the
  -- subject's own title, so it is derived text rather than a model's sentence;
  -- a seeded path carries what the person wrote.
  title             TEXT NOT NULL,

  -- The thesis in one line: who would pay, for what. Nullable, because an
  -- enumerated path legitimately has none until a payer is established —
  -- `captureMechanism`'s own rule, one axis along.
  thesis            TEXT,

  origin            TEXT NOT NULL CHECK (origin IN ('SEED', 'ENUMERATED', 'EVIDENCED')),

  -- The claim that established it, for a path a worker declared. A path with
  -- neither a claim nor a non-evidenced origin cannot be written, which is
  -- what makes "every evidenced possibility traces to a passage" a property
  -- rather than a convention.
  source_claim_id   TEXT REFERENCES research_claims(id),

  -- §20's lineage. Both are pointers and neither is a delete: a merged path
  -- keeps its id, its facts, its judgements and its rank history, and the
  -- merge is reversible by clearing one column. A split child names the parent
  -- it came out of, so "this used to be one possibility" stays answerable.
  merged_into_id    TEXT REFERENCES monetization_paths(id),
  split_from_id     TEXT REFERENCES monetization_paths(id),

  -- When the derivation last looked at this path. The brief asks for it by
  -- name, and it answers a question no other column can: whether a position is
  -- current or was computed before the last thing Brain learned.
  last_evaluated_at TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  CHECK ((opportunity_id IS NULL) <> (industry_node_id IS NULL)),
  CHECK (origin <> 'EVIDENCED' OR source_claim_id IS NOT NULL),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (split_from_id IS NULL OR split_from_id <> id)
);

-- One path per method per subject. The arbiter for two ticks enumerating one
-- subject at once, and for a worker evidencing what the table already produced
-- — the ninth time this repository has needed a compare-and-swap on a value
-- the claimant does not supply. COALESCE because a unique index over NULLs
-- does not constrain, and exactly one of the two subject columns is always
-- NULL by the CHECK above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_subject
  ON monetization_paths(project_id, COALESCE(opportunity_id, '-'),
                        COALESCE(industry_node_id, '-'), method);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_project
  ON monetization_paths(project_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_opportunity
  ON monetization_paths(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_node
  ON monetization_paths(industry_node_id);


-- ---------------------------------------------------------------------------
-- WHAT IS KNOWN ABOUT ONE PATH, AND WHERE IT CAME FROM
--
-- `cash_card_facts`' shape at a new subject, deliberately: one row per
-- attribute, replaced rather than accumulated, with `kind` carrying the
-- distinction that decides how it may be rendered. EVIDENCE resolves to a
-- gated claim and therefore to a source, a publisher and a date. RECOMMENDATION
-- is Brain's own proposal and carries its basis, its assumptions and what would
-- change it. PERSON is somebody's decision, and nothing automatic replaces one.
--
-- It is a second table rather than a second use of `cash_card_facts` because
-- that table's key is `(opportunity_id, field)` and a path is not an
-- opportunity — thirty paths on one opening would collide on every field. What
-- is *not* duplicated is the rule: `mayReplace` decides which answer stands,
-- for both tables, from one function.
--
-- The two figure columns exist so that a ledger can be sorted and filtered
-- without reading prose. §25's Westbrook defect is what happens when a number
-- is parsed out of a sentence, so these are supplied by whoever established the
-- fact, never extracted from `value`. A null is unknown and sorts last.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_path_facts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),

  attribute     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('EVIDENCE', 'RECOMMENDATION', 'PERSON')),

  value         TEXT NOT NULL,

  -- The structured reading of `value`, where the attribute declares a unit.
  -- Never derived from the text: a figure a parser produced would be a number
  -- nobody published wearing the authority of one that was.
  amount_cents  INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  days          INTEGER CHECK (days IS NULL OR days >= 0),

  -- EVIDENCE only, and the CHECK makes it mandatory there: a fact with no
  -- claim is a sentence, and this ledger's whole defence against forty
  -- plausible inventions is that an evidenced answer resolves to a passage.
  claim_id      TEXT REFERENCES research_claims(id),

  -- RECOMMENDATION only, and all three are mandatory: a proposal with no
  -- stated uncertainty cannot exist, which is §30's rule at a new table.
  basis         TEXT,
  assumptions   TEXT,
  uncertainty   TEXT,

  -- Who recorded it: BRAIN, or a user id for a person's decision.
  decided_by    TEXT NOT NULL,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK (kind <> 'EVIDENCE' OR claim_id IS NOT NULL),
  CHECK (kind <> 'RECOMMENDATION'
         OR (basis IS NOT NULL AND assumptions IS NOT NULL AND uncertainty IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_facts_attribute
  ON monetization_path_facts(path_id, attribute);

CREATE INDEX IF NOT EXISTS idx_monetization_facts_project
  ON monetization_path_facts(project_id, attribute);


-- ---------------------------------------------------------------------------
-- WHAT A PERSON DECIDED ABOUT A POSSIBILITY
--
-- Append-only, and the append-only-ness is the feature. A path that was
-- invalidated in March and revived in April has both rows, so "why was this
-- ever put away" is answerable after it comes back — and a revival is a new
-- row rather than a deleted one, because deleting the judgement would make the
-- ledger claim nobody ever doubted it.
--
-- Four judgements, and none of them sets a status. WATCH, INVALIDATE and
-- ARCHIVE are the three things no derivation could establish; REVIVE is the
-- answering transition for the last two, because an escalation with no way out
-- is stuck rather than waiting. Everything else about where a path stands is
-- read from rows, so there is no shape of this table that lets somebody mark a
-- path healthy over evidence that says otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_path_judgments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),

  judgment      TEXT NOT NULL CHECK (judgment IN ('WATCH', 'INVALIDATE', 'ARCHIVE', 'REVIVE')),

  -- Required. A possibility put away with no reason is one nobody can
  -- reconsider later, which is the state this whole ledger exists to prevent.
  reason        TEXT NOT NULL,

  -- Whose authority it carries, and how the call got in. §23's pair: the user
  -- id is resolved against `users` and the channel is what Brain cannot check,
  -- so it defaults to the weaker value rather than assuming the stronger one.
  decided_by_id TEXT REFERENCES users(id),
  channel       TEXT NOT NULL CHECK (channel IN ('BROWSER_SESSION', 'DELEGATED_TERMINAL')),

  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monetization_judgments_path
  ON monetization_path_judgments(path_id, created_at);

CREATE INDEX IF NOT EXISTS idx_monetization_judgments_project
  ON monetization_path_judgments(project_id, created_at);


-- ---------------------------------------------------------------------------
-- THE EDGES A DERIVATION CANNOT RECOVER
--
-- Most of §21's graph is derived from the method table — `produces` against
-- `requires` gives enables, produces-data-for and stepping-stone-to; `role`
-- gives competes-with and coexists-with; `scaleDependent` gives
-- viable-only-at-scale-of — so storing those would be a second graph to keep
-- in agreement with the first, and this repository has paid for two readers of
-- one fact enough times to know how that ends.
--
-- What cannot be derived is an edge that is true of *these two paths* rather
-- than of their two methods: a source establishing that this particular
-- supplier will not deal with a broker, or a person recording that one of
-- these has to happen first here. So this table holds only those, and every
-- row says which.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_path_edges (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),

  from_path_id    TEXT NOT NULL REFERENCES monetization_paths(id),
  to_path_id      TEXT NOT NULL REFERENCES monetization_paths(id),

  kind            TEXT NOT NULL CHECK (kind IN (
                    'ENABLES', 'REQUIRES', 'COMPETES_WITH', 'COEXISTS_WITH',
                    'PRODUCES_DATA_FOR', 'PRODUCES_RELATIONSHIPS_FOR',
                    'STEPPING_STONE_TO', 'VIABLE_ONLY_AT_SCALE_OF')),

  -- Why this edge exists between these two rather than between their methods.
  rationale       TEXT NOT NULL,

  source          TEXT NOT NULL CHECK (source IN ('PERSON', 'EVIDENCED')),
  source_claim_id TEXT REFERENCES research_claims(id),
  decided_by_id   TEXT REFERENCES users(id),

  created_at      TEXT NOT NULL,

  CHECK (from_path_id <> to_path_id),
  CHECK (source <> 'EVIDENCED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_edges_pair
  ON monetization_path_edges(from_path_id, to_path_id, kind);

CREATE INDEX IF NOT EXISTS idx_monetization_edges_project
  ON monetization_path_edges(project_id);

CREATE INDEX IF NOT EXISTS idx_monetization_edges_to
  ON monetization_path_edges(to_path_id);


-- ---------------------------------------------------------------------------
-- THAT A POSITION MOVED
--
-- The one thing about a rank that a derivation cannot recover. Where a path
-- ranks today is read from rows on every request and is therefore always
-- current; where it ranked *yesterday* is gone the moment those rows change,
-- and the brief asks for it by name — previous rank, and the reason for the
-- movement.
--
-- So this is an append-only observation rather than a cache: one row each time
-- the derived position differs from the last one recorded, carrying where it
-- was, where it is, and which of the closed reasons applies. A tick that
-- re-derives an unchanged ledger writes nothing at all, which is what keeps it
-- a history rather than a log.
--
-- `criterion` is what makes "why did it move" answerable exactly: the ranking
-- is lexicographic, so the first comparison that changed *is* the reason, and
-- naming it is a reading rather than a story. Null where nothing was compared
-- — a path entering the ledger has no previous position to differ from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_rank_snapshots (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  path_id        TEXT NOT NULL REFERENCES monetization_paths(id),

  rank           INTEGER NOT NULL CHECK (rank >= 1),
  previous_rank  INTEGER CHECK (previous_rank IS NULL OR previous_rank >= 1),

  reason         TEXT NOT NULL CHECK (reason IN (
                   'ENTERED_THE_LEDGER', 'ITS_OWN_EVIDENCE_CHANGED',
                   'ITS_STATUS_CHANGED', 'THE_FIELD_AROUND_IT_CHANGED',
                   'A_PERSON_DECIDED')),

  -- The derived status at the moment of the reading, so a later reader can see
  -- that a demotion followed a status change rather than inferring it.
  status         TEXT NOT NULL,

  -- The first ranking comparison that came out differently, named. Null for an
  -- entry, which had nothing to be compared against.
  criterion      TEXT,

  evaluated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monetization_snapshots_path
  ON monetization_rank_snapshots(path_id, evaluated_at);

CREATE INDEX IF NOT EXISTS idx_monetization_snapshots_project
  ON monetization_rank_snapshots(project_id, evaluated_at);


-- ---------------------------------------------------------------------------
-- THE DECLARATION ON THE CLAIM
--
-- `opportunity_signal`'s shape, one axis along, and for its exact reason. A
-- claim that establishes a way of being paid says so from the closed method
-- vocabulary; Brain's part is to insist the declaration exists and to match it
-- exactly, never to read a method out of a sentence.
--
-- Every row written before this column carries NULL and therefore declares no
-- method, which is correct rather than a gap: nobody was asked. It is one
-- column rather than two because the subject a monetization claim is about is
-- the fragment's own — a claim about how money could be made from *something
-- else* is a claim about something else.
-- ---------------------------------------------------------------------------
ALTER TABLE research_claims ADD COLUMN monetization_method TEXT;
