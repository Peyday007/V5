-- ---------------------------------------------------------------------------
-- Research Intelligence: the layer that decides what to learn, not how to run.
-- ---------------------------------------------------------------------------
--
-- Everything the research engine needed to *execute* has existed since Step 9:
-- packets, fragments, claims, the seven-condition gate, verification, three
-- audit roles, synthesis, a durable queue with leases and fencing. What was
-- missing is the judgement above it — which question actually needs answering,
-- what decision consumes the answer, which unknown could invalidate the whole
-- path, what a finding should change about the plan, and when to stop.
--
-- These five tables hold exactly that judgement and nothing else. They restate
-- no scope the boundary contract already carries, no evidence the claim rows
-- already carry and no ordering the fragment dependencies already carry, for
-- `shared_findings`' reason: a copy is a second place for the truth to live and
-- it is the one nobody reconciles.
--
-- Nothing here gates evidence. A row in any of these tables can open work, name
-- a consequence, retire a branch or record a lesson; none of them can accept a
-- claim, lower an independent-source minimum, or advance an audit verdict.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. What Brain believes it was asked, versioned so it can be wrong.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT a second boundary contract. `boundary_contracts` says what
-- the research is *bounded by* — geography, timeframe, population, definitions,
-- the excluded subjects — and it is referenced rather than duplicated here.
-- This says what the work is *for*, which is the thing that decides whether an
-- answer is any use: the decision downstream, the stakes, the horizon, and the
-- four categories the old model collapsed into one.
--
-- The four are the whole point. An EXAMPLE the user gave is not a boundary; a
-- PREFERENCE is not a hard constraint; an ASSUMPTION is not a fact; a NON_GOAL
-- is not a failure. Collapsing any of them is how research narrows to a literal
-- reading of a sentence somebody wrote quickly — the Westbrook defect (§25) one
-- altitude up, where the wrong answer is derived confidently from a correct
-- rule applied to a misread question.
--
-- Versioned and append-only. A later reading supersedes an earlier one and
-- destroys nothing, so `revised_from_version` and `revision_reason` are the
-- record of what changed and why. The current model is the highest version.
CREATE TABLE research_problem_models (
  id                    TEXT PRIMARY KEY,
  orchestration_id      TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The scope this interpretation belongs to. NULL when the packet has none
  -- yet, which is an honest state rather than a default scope.
  boundary_contract_id  TEXT REFERENCES boundary_contracts(id) ON DELETE SET NULL,

  version               INTEGER NOT NULL,

  -- What the research is for. `decision_supported` is the field everything
  -- downstream is judged against: a synthesis answers this or it has not
  -- answered anything.
  outcome_sought        TEXT NOT NULL,
  decision_supported    TEXT,
  why_it_matters        TEXT,

  -- CRITICAL | HIGH | MODERATE | LOW — how much rides on being right.
  -- REVERSIBLE | COSTLY | IRREVERSIBLE — what acting on a wrong answer costs.
  -- Both feed depth allocation, and neither is ever a reason to accept a claim.
  stakes                TEXT NOT NULL DEFAULT 'MODERATE',
  reversibility         TEXT NOT NULL DEFAULT 'REVERSIBLE',
  consequence_if_wrong  TEXT,
  time_horizon          TEXT,

  -- JSON arrays. `constraints` and `preferences` carry {statement, reason} so
  -- Brain can later ask whether the reason still applies — a constraint whose
  -- reason is gone is a constraint nobody is bound by. `examples` carry
  -- {statement, property}: the property is what the example was an example OF,
  -- and it is what search may generalise over. Storing the example without its
  -- property is how a list of three industries becomes a permanent whitelist.
  success_criteria      TEXT NOT NULL DEFAULT '[]',
  constraints           TEXT NOT NULL DEFAULT '[]',
  preferences           TEXT NOT NULL DEFAULT '[]',
  examples              TEXT NOT NULL DEFAULT '[]',
  assumptions           TEXT NOT NULL DEFAULT '[]',
  non_goals             TEXT NOT NULL DEFAULT '[]',
  useless_if            TEXT NOT NULL DEFAULT '[]',
  authority_granted     TEXT NOT NULL DEFAULT '[]',

  -- COMPILED | CONTRACT | ASSIGNMENT | PROPOSAL | PERSON. Where this reading
  -- came from, because a reading derived from a template and one a person wrote
  -- are different facts and must not read the same.
  derived_from          TEXT NOT NULL,
  rationale             TEXT,
  revised_from_version  INTEGER,
  revision_reason       TEXT,

  created_at            TEXT NOT NULL,

  CHECK (stakes IN ('CRITICAL','HIGH','MODERATE','LOW')),
  CHECK (reversibility IN ('REVERSIBLE','COSTLY','IRREVERSIBLE')),
  CHECK (derived_from IN ('COMPILED','CONTRACT','ASSIGNMENT','PROPOSAL','PERSON')),
  CHECK (version >= 1),
  -- A revision that does not say what it revises is not a revision.
  CHECK (revised_from_version IS NULL OR revision_reason IS NOT NULL)
);

-- One row per version per packet. This is what makes the derivation safe to run
-- on every advance, from two instances, after a restart: the second writer
-- collides and reads instead.
CREATE UNIQUE INDEX idx_problem_models_version
  ON research_problem_models (orchestration_id, version);
CREATE INDEX idx_problem_models_project
  ON research_problem_models (project_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. The decision-relevant uncertainty — the actual unit of research.
-- ---------------------------------------------------------------------------
--
-- A fragment is an execution container for a bounded question. An uncertainty
-- is the *reason* that question is worth asking, and the two are not the same
-- object: one uncertainty may be answered by several fragments over several
-- attempts, and a fragment that succeeds perfectly may leave its uncertainty
-- open because what it established was not the decisive part.
--
-- Keeping them separate is what makes adaptive planning possible at all. A
-- finding retires an *uncertainty* — "no reachable payer exists, so how to
-- fulfil the work no longer bears on the decision" — and the fragments behind
-- it are cancelled as a consequence. With only fragments there is nothing to
-- say that about.
CREATE TABLE research_uncertainties (
  id                    TEXT PRIMARY KEY,
  orchestration_id      TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  problem_model_id      TEXT REFERENCES research_problem_models(id) ON DELETE SET NULL,

  -- Stable within the packet. Everything that refers to an uncertainty refers
  -- to this, never to the id, so a link written before the row exists is still
  -- meaningful and a re-derivation cannot produce a duplicate.
  uncertainty_key       TEXT NOT NULL,
  question              TEXT NOT NULL,
  why_it_matters        TEXT NOT NULL,

  -- What consumes the answer. A question with no consumer is a topic, and this
  -- column is what stops a packet filling up with them.
  -- DECISION | CONCLUSION | CALCULATION | FRAGMENT | REQUIREMENT
  consumer_kind         TEXT NOT NULL,
  consumer_ref          TEXT,

  -- What Brain currently thinks, and on what footing. UNKNOWN is the honest
  -- default and is never read as a favourable assumption (invariant 39).
  current_belief        TEXT,
  belief_basis          TEXT NOT NULL DEFAULT 'UNKNOWN',

  consequence           TEXT NOT NULL DEFAULT 'MODERATE',
  reversibility         TEXT NOT NULL DEFAULT 'REVERSIBLE',
  change_rate           TEXT NOT NULL DEFAULT 'SLOW',
  -- 0..100. How unresolved this is *now*. Integer because a stored float that
  -- looks like a measurement invites arithmetic nobody justified.
  uncertainty_level     INTEGER NOT NULL DEFAULT 100,

  -- Could a bad answer here make the whole path pointless? This is what decides
  -- ordering more than anything else: a decisive prerequisite is investigated
  -- before the work that rests on it, however interesting that work is.
  invalidating          INTEGER NOT NULL DEFAULT 0,

  stopping_condition    TEXT NOT NULL,

  -- OPEN | INVESTIGATING | RESOLVED | REFUTED | UNRESOLVABLE | RETIRED
  -- | DEFERRED | PERSON_ONLY
  disposition           TEXT NOT NULL DEFAULT 'OPEN',
  disposition_reason    TEXT,
  resolved_by_fragment_id TEXT REFERENCES research_fragments(id) ON DELETE SET NULL,
  resolved_at           TEXT,

  -- How much looking this deserves, and on what basis. Derived from consequence,
  -- reversibility and observed source conflict — never a global default, and
  -- never a budget wearing an evidence bar's clothes.
  depth                 TEXT NOT NULL DEFAULT 'CORROBORATED',
  depth_basis           TEXT,

  -- PLAN | FINDING | CONTRADICTION | COVERAGE_GAP | ARCHIVE | PERSON
  origin                TEXT NOT NULL DEFAULT 'PLAN',
  origin_ref            TEXT,
  -- The plan revision that opened it, so "what changed the plan" is answerable.
  plan_version          INTEGER NOT NULL DEFAULT 1,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,

  CHECK (consumer_kind IN ('DECISION','CONCLUSION','CALCULATION','FRAGMENT','REQUIREMENT')),
  CHECK (belief_basis IN ('UNKNOWN','ASSUMED','ARCHIVE','EVIDENCE','PERSON')),
  CHECK (consequence IN ('CRITICAL','HIGH','MODERATE','LOW')),
  CHECK (reversibility IN ('REVERSIBLE','COSTLY','IRREVERSIBLE')),
  CHECK (change_rate IN ('STABLE','SLOW','VOLATILE')),
  CHECK (uncertainty_level BETWEEN 0 AND 100),
  CHECK (invalidating IN (0,1)),
  CHECK (disposition IN ('OPEN','INVESTIGATING','RESOLVED','REFUTED','UNRESOLVABLE',
                         'RETIRED','DEFERRED','PERSON_ONLY')),
  CHECK (depth IN ('SINGLE_PRIMARY','CORROBORATED','CONTESTED_DEEP')),
  CHECK (origin IN ('PLAN','FINDING','CONTRADICTION','COVERAGE_GAP','ARCHIVE','PERSON')),
  -- A disposition that ends the question says why it ended.
  CHECK (disposition IN ('OPEN','INVESTIGATING') OR disposition_reason IS NOT NULL)
);

CREATE UNIQUE INDEX idx_uncertainties_key
  ON research_uncertainties (orchestration_id, uncertainty_key);
CREATE INDEX idx_uncertainties_open
  ON research_uncertainties (orchestration_id, disposition);
CREATE INDEX idx_uncertainties_project
  ON research_uncertainties (project_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. Typed relationships between uncertainties.
-- ---------------------------------------------------------------------------
--
-- `research_fragments.depends_on` already carries HARD | CONDITIONAL |
-- SEQUENCING, and that is about *execution order*. This is about *reasoning*,
-- and the kinds are different because the questions are:
--
--   HARD_PREREQUISITE — the dependent cannot be phrased until this is settled.
--   CONDITIONAL       — the dependent applies only if this came out a certain
--                       way, and carries the condition into its claims.
--   EVIDENTIARY       — the dependent is strengthened by this and blocked by
--                       nothing. A failure here never cancels it.
--   COMPARATIVE       — the two are alternatives being weighed against each
--                       other, so one failing makes the other MORE decisive.
--   FOLLOW_UP         — this was opened *because* of what that one found.
--   CHALLENGES        — this exists to attack that one's answer.
--
-- The distinction is load-bearing: cancelling an EVIDENTIARY dependent when its
-- source failed is how a campaign throws away work that could still contribute,
-- and it is required scenario 5.
CREATE TABLE research_uncertainty_links (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  from_key          TEXT NOT NULL,
  to_key            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  reason            TEXT,
  created_at        TEXT NOT NULL,

  CHECK (kind IN ('HARD_PREREQUISITE','CONDITIONAL','EVIDENTIARY','COMPARATIVE',
                  'FOLLOW_UP','CHALLENGES')),
  CHECK (from_key <> to_key)
);

CREATE UNIQUE INDEX idx_uncertainty_links_edge
  ON research_uncertainty_links (orchestration_id, from_key, to_key, kind);
CREATE INDEX idx_uncertainty_links_to
  ON research_uncertainty_links (orchestration_id, to_key);

-- ---------------------------------------------------------------------------
-- 4. What changed the plan, and why.
-- ---------------------------------------------------------------------------
--
-- Adaptive planning is only defensible if it is auditable. A revision names the
-- evidence that prompted it, the decisions the director reached, and what was
-- actually applied — which is deliberately a different field, because a
-- decision the deterministic layer refused is worth keeping and must not be
-- read as something that happened.
CREATE TABLE research_plan_revisions (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,

  -- INITIAL_PLAN | EVIDENCE_ARRIVED | CONTRADICTION | BRANCH_RETIRED
  -- | COVERAGE_GAP | SUFFICIENCY | PERSON
  reason            TEXT NOT NULL,
  summary           TEXT NOT NULL,
  -- JSON. Everything the director proposed, refusals included.
  decisions         TEXT NOT NULL DEFAULT '[]',
  -- JSON. What the deterministic layer let through, with the rows it wrote.
  applied           TEXT NOT NULL DEFAULT '[]',
  -- BRAIN | PERSON | WORKER. Never a worker today; the column exists so a
  -- validated proposal can be attributed rather than laundered.
  actor_kind        TEXT NOT NULL DEFAULT 'BRAIN',
  actor_ref         TEXT,
  created_at        TEXT NOT NULL,

  CHECK (reason IN ('INITIAL_PLAN','EVIDENCE_ARRIVED','CONTRADICTION','BRANCH_RETIRED',
                    'COVERAGE_GAP','SUFFICIENCY','PERSON')),
  CHECK (actor_kind IN ('BRAIN','PERSON','WORKER')),
  CHECK (version >= 1)
);

CREATE UNIQUE INDEX idx_plan_revisions_version
  ON research_plan_revisions (orchestration_id, version);

-- ---------------------------------------------------------------------------
-- 5. What the campaign taught, at the abstraction it is actually true at.
-- ---------------------------------------------------------------------------
--
-- The failure mode this table exists to avoid is learning "always do what the
-- user said last time". A lesson is stored with its abstraction declared:
-- CAMPAIGN means it is about this packet and nothing else; DOMAIN means it
-- holds for this kind of question; GENERAL means it is about how Brain
-- researches. Only the last two are ever read as guidance, and even then they
-- are shown to a reader rather than applied to a gate.
CREATE TABLE research_retrospectives (
  id                TEXT PRIMARY KEY,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Stable per packet, so the derivation is idempotent by what it is about.
  lesson_key        TEXT NOT NULL,
  -- CAMPAIGN_CLOSED | OUTCOME_OBSERVED. The second is written later, when the
  -- world says whether the recommendation was any good, and is absent until it
  -- does rather than guessed.
  scope             TEXT NOT NULL,
  abstraction       TEXT NOT NULL,
  lesson            TEXT NOT NULL,
  -- JSON: the rows the lesson was read off. A lesson with no evidence is an
  -- opinion, and this is what stops one being stored as a finding.
  evidence          TEXT NOT NULL DEFAULT '[]',
  -- JSON: the campaign's measured numbers, so a later reader can compare.
  metrics           TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,

  CHECK (scope IN ('CAMPAIGN_CLOSED','OUTCOME_OBSERVED')),
  CHECK (abstraction IN ('CAMPAIGN','DOMAIN','GENERAL'))
);

CREATE UNIQUE INDEX idx_retrospectives_lesson
  ON research_retrospectives (orchestration_id, lesson_key);
CREATE INDEX idx_retrospectives_project
  ON research_retrospectives (project_id, created_at);
