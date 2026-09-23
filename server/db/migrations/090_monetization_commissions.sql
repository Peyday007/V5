-- ---------------------------------------------------------------------------
-- WHAT BRAIN ASKED, ABOUT WHICH POSSIBILITY, AND WHY IT ASKED IT THEN
--
-- §48 built a ledger that preserves every way a discovery could be paid for,
-- ranks them, and says for each one exactly which questions are still open.
-- It could not ask any of them. Every unanswered attribute sat on the surface
-- with the task that would answer it printed underneath, waiting for somebody
-- to notice — which is §24's *waiting nobody can resolve* arriving at a ledger
-- rather than at a state machine, and the eighth time this repository has had
-- to write that sentence.
--
-- This table is the record of the asking. It is **not** a queue, a scheduler,
-- an agent or a second evidence system: the work is a Russell candidate, the
-- compiler writes the specification, the approval envelope decides whether it
-- may start, the durable queue leases it, the evidence gate decides what may
-- be claimed and all three audit roles decide whether it stands. Every one of
-- those is untouched. What is new is a row saying *Brain asked this, about
-- this possibility, about this attribute, for this reason.*
--
-- It is `industry_rounds`' shape, deliberately, because that table already
-- solved the identical problem one axis along: a kernel that decides what to
-- research needs its asking to be answerable by key rather than by scanning a
-- window, or "have we already asked this" becomes a guess.
--
-- ---------------------------------------------------------------------------
-- WHY THE UNIQUE INDEX IS THE WHOLE CONCURRENCY DESIGN
--
-- Two durable ticks may run at once — two instances, a restart mid-pass, a
-- tick that died after allocating and before opening. Both read the same
-- ledger, both correctly compute that `requiredCapital` on `mzp_abc` is
-- unanswered and decisive, and both try to commission it. The allocator is a
-- pure function and is therefore useless as a safety mechanism, exactly as
-- `services/dispatch/router.ts` says of its own: the exclusion has to be a
-- write the loser cannot win.
--
-- `UNIQUE (project_id, path_id, attribute, round)` with
-- `INSERT ... ON CONFLICT DO NOTHING` is that write. Exactly one caller
-- inserts; the other reads back the row it collided with and reports it as
-- not-created. A losing allocation is an ordinary outcome and not an error —
-- the ninth time this codebase has needed a compare-and-swap on a value the
-- claimant does not supply.
--
-- `round` is in the key rather than outside it because a second asking of the
-- same question is a *different* commission with its own reason, its own
-- attempt and its own outcome, and collapsing the two would make a retry
-- indistinguishable from a duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monetization_commissions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT NOT NULL,

  -- The possibility this question is about. A commission cannot exist without
  -- one: an attribute is an attribute *of* something, and a question about a
  -- price with nothing it is the price of is the Westbrook defect (§25) with a
  -- money figure on the end of it.
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),

  -- The exact attribute being investigated, from `MONETIZATION_ATTRIBUTES`.
  -- Validated in `domain/monetization.ts` on the way in and matched exactly;
  -- it is also the evidence lane id a claim answering it must carry, so what
  -- lands where is a row rather than a reading of prose.
  attribute     TEXT NOT NULL,

  round         INTEGER NOT NULL CHECK (round >= 1),

  -- The Russell idea this asked. Unique for `industry_rounds`' reason: the
  -- wind-down guard classifies a candidate by the row that points at it, and
  -- two commissions sharing one would make that answer ambiguous exactly when
  -- it has to be certain.
  candidate_id  TEXT NOT NULL,

  -- Why resolving this mattered *at the moment it was decided*, in words, over
  -- a ledger that has since moved. `services/dispatch/router.ts` keeps its
  -- decision answerable from a recorded input rather than from a re-run, and
  -- this is that promise kept for research spending.
  reason        TEXT NOT NULL,
  -- Which selection rule admitted it. Lower is stronger, and the numbers are
  -- spaced so a rule can be inserted without renumbering the others.
  rule_rank     INTEGER NOT NULL,

  state         TEXT NOT NULL
                CHECK (state IN ('OPEN', 'ANSWERED', 'UNRESOLVED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  settled_at    TEXT,

  -- How many ledger attributes the finished research actually answered.
  --
  -- NULL while OPEN rather than 0. §33 records precisely what the other choice
  -- costs: `cash_discovery_rounds.found` was `NOT NULL DEFAULT 0`, only
  -- `closeRound` ever wrote it, and every live round reported "0 openings
  -- found" about the work that had produced the entire portfolio. A default
  -- published as a measurement is an understatement nobody checks, because it
  -- reads as modesty.
  answered      INTEGER,

  -- Why it ended as it did. Required of every settled commission, because
  -- "the sources do not publish it" and "the run failed" and "the possibility
  -- was archived while this was in flight" are three different facts with
  -- three different remedies, and a settled row that names none of them sends
  -- somebody to look in the wrong place.
  outcome       TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  -- A settled commission says what it produced and why it ended. An open one
  -- says neither, because neither is known yet.
  CHECK (state = 'OPEN' OR (answered IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (state = 'OPEN' OR settled_at IS NOT NULL)
);

-- The exclusion. See the header: this is the whole concurrency design.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_commissions_ask
  ON monetization_commissions(project_id, path_id, attribute, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_commissions_candidate
  ON monetization_commissions(candidate_id);

CREATE INDEX IF NOT EXISTS idx_monetization_commissions_project
  ON monetization_commissions(project_id, state);

CREATE INDEX IF NOT EXISTS idx_monetization_commissions_path
  ON monetization_commissions(path_id, attribute);
