# The puzzle products and production kernel

Brain has an axis for *where* money is reachable (§38), one for *by whom* work
is produced (§41), one for *what machine* to build next (§39), one for *what
opening* to pursue (§30) and one for *what Brain itself can do* (§37). It has
never held a row for **a thing Brain produced and can prove is correct**.

That is the gap this kernel fills, and it is why it is shaped differently from
every kernel before it. The others research the world, and the evidence gate
judges what they claim against a published source. This one *makes something*,
and there is no source to judge a generated Sudoku against — it is judged by
running a deterministic check over it. Every design decision below follows from
that one difference.

---

## The spine

```
FORMAT          a kind of puzzle. Rows, from a person or from a gated claim.
  └─ MASTER     a reusable system: a generator, its parameters, and what its
                content stands on.
       ├─ INSTANCE     one produced puzzle. Immutable, seeded, hashed.
       │    └─ VALIDATION   what each check said, append-only, per version.
       └─ EDITION      a commercial output, distinct on a declared axis.
            └─ carries instances, which is what makes reuse countable.
```

`ROUND` sits beside all of it: what has been asked about a format, as a Russell
candidate going through the machinery Steps 4 to 12C already built.

---

## The six rules

### 1. A generator is code, and a row can never say otherwise

There is no `is_generatable` column and no maturity column anywhere in the
schema. What Brain can generate and what Brain can check are read on every pass
from `services/puzzles/registry.ts`, which is a map of format to **functions**.

A format with no entry cannot be generated whatever any row claims. Delete an
entry and the format falls back down the ladder immediately, with nothing to
update. The brief's own words are the reason — *"do not falsely claim support
for puzzle formats lacking real validators"* — and §37 drew the identical line
one altitude up: a definition is not an implementation.

**This is why the universe and the registry are separate things.** The universe
is what exists in the world and lives in `puzzle_formats`; the registry is what
this Brain's hands can do and lives in code. A map that held only what Brain can
already make could not record the gaps that decide what to build next.

Exactly one function writes a `SEED` format — `declareFormat`, reachable only
from a route behind `requirePerson` and `ADMIN` and from the operator script.
The tick, the allocator and the absorption path can write only `DISCOVERED`,
from a gated claim that named it. That is §41's rule that `SEED` is the one
origin Brain may never write. The brief's starting list of twenty formats lives
in `scripts/puzzles.ts` rather than in the schema, because a person running a
command is the design act and a constant in a migration would be the limit the
brief says not to impose.

What is implemented today:

| format | generator | validator | required checks |
|---|---|---|---|
| `SUDOKU` | `SUDOKU_DIG_V1` | `SUDOKU_CHECKS_V1` | legal construction, solution consistent, unique solution, difficulty measured |
| `WORD_SEARCH` | `WORD_SEARCH_PLACE_V1` | `WORD_SEARCH_CHECKS_V1` | grid well formed, every word present, answer key unambiguous, no screened string |
| `MAZE` | `MAZE_DFS_V1` | `MAZE_CHECKS_V1` | grid well formed, passages reciprocal, fully connected, solution unique, solution matches |
| `CRYPTOGRAM` | `CRYPTOGRAM_SUBSTITUTION_V1` | `CRYPTOGRAM_CHECKS_V1` | key is bijection, no fixed point, decodes to source |

**Crossword is deliberately absent**, and `UNIMPLEMENTED_REASONS` says why in
words: a crossword generator is not hard because of the grid, it is hard because
a legal fill needs a lexicon and a clue bank whose commercial-use rights
somebody has established. That is a `RIGHTS` question, which is exactly what
rule 4 of the allocator exists to ask.

### 2. `UNSUPPORTED` is not `PASS`

`puzzle_validations.verdict` has three values. A check nothing implements records
`UNSUPPORTED`, which is a reading that says *nothing looked* — and
`readValidation` never lets one stand in for a pass.

`runChecks` compares what a validator actually answered against what its format
*declares* is required, and writes `UNSUPPORTED` for every one missing. That
comparison is the safety property: without it, a validator that quietly stopped
answering a check would make every puzzle look more validated than before.

§9 settled this for documents — a `BLOCKED` extraction is something the auditor
does **not** have — and the stake here is higher in one direction, because the
favourable reading is *ship it*.

`readValidation` answers five states rather than a boolean, because the four
that are not `VALIDATED` have four different remedies:

| state | what it means | remedy |
|---|---|---|
| `UNCHECKABLE` | no validator exists for this format | write one |
| `UNCHECKED` | a validator exists and has not run on these bytes | run it |
| `INCOMPLETE` | something required was `UNSUPPORTED` | implement the check |
| `FAILED` | something required failed | repair the generator |
| `VALIDATED` | every required check passed, at the current version | — |

### 3. An instance is immutable, because a verdict is about bytes

`puzzle_instances` has no `updated_at` and nothing updates one. A validation
records the content hash it ran against, so a verdict recorded months ago still
resolves to the puzzle it actually checked. Regenerating produces a new instance
with its own identity and its own verdicts; it never edits one.

The **seed** is what makes this worth having. Every generator is a deterministic
function of a recorded seed, so a defect found later resolves to the exact input
that produced the puzzle — and nothing in `services/puzzles/` may call
`Math.random()`. A test reads the source to assert it, because a generator that
reached for the global once in a rare branch would pass every behavioural check
until that branch was taken.

### 4. A systematic defect stops the master, never the output

The brief: *"if a systematic defect appears, block the batch and repair the
generator or source. Do not manually patch dozens of broken outputs and leave
the source defect alive."*

`produceBatch` is the only code path that can write a `puzzle_instances` row, so
there is nowhere for a hand-patched puzzle to come from. A required check
failing blocks the **master**, which then produces nothing until a person says
the generator is repaired — and `unblockMaster` refuses unless the generator's
*version* has actually changed, because clearing a block at the same version
would be the same code claiming to be different.

**The threshold is one failure**, and that is deliberate rather than strict for
its own sake. These are deterministic functions of a recorded seed and every
check is a deterministic function of the bytes, so a single invalid puzzle is
not bad luck — it is a bug that will produce more. A tolerance here would let a
generator ship 4% wrong answers indefinitely.

An `UNSUPPORTED` check never blocks. That is a gap in *Brain's checking* rather
than a defect in the master's output, and blocking for it would send somebody to
repair a generator that may well be perfect.

### 5. A cosmetic reskin is recorded, never counted

The brief: *"a cover-color change, title change, reordered pages, or other
cosmetic reskin does not create a new qualified output."*

The tempting implementation is a rule in a document that somebody remembers.
Here it is arithmetic over rows. An edition declares the axis it differs on, and
the derivation then **checks** that it does:

- `DISTINCT_CONTENT` must carry at least one puzzle no *earlier* edition of its
  master carries.
- Any other axis must name a value no earlier edition on that axis already named.
- `position` is deliberately not an axis, so reordering can never qualify
  anything.
- `COSMETIC` is in the vocabulary and **never qualifies**.

Refusing to *store* a reskin would be worse: it exists either way, and a schema
that cannot hold it makes misdeclaring the axis the only way to record it. The
failure mode is a reskin that is visible and uncounted rather than one that is
hidden.

**The comparison is against what came before, and that asymmetry was found by
running it.** The first version compared against every live sibling in both
directions — so declaring a cosmetic reskin of *Volume One* and filling it with
Volume One's own puzzles made **Volume One** stop qualifying, and the catalog's
qualified count went from one to nought on a change that added nothing. A copy
must never retroactively unmake the thing it copied.

Qualification is four conditions and there is no `qualified` column, because
every one of them can stop being true:

| condition | `UNKNOWN` when |
|---|---|
| `HAS_CONTENT` | — |
| `ALL_VALIDATED` | its puzzles are in a format nothing can check |
| `RIGHTS_CLEAR` | its master cannot be read |
| `DISTINCT` | — |

`UNKNOWN` is never `MET`. §39's readiness at an edition, and invariant 39 at the
gate that decides whether something may be sold.

### 6. Nothing derivable is stored

No maturity, no multiplier, no yield, no qualification verdict, no ranking. §38's
third rule and §33's tier: a row is not a decision, and a stored verdict is stale
the moment the evidence it waited on arrives.

Three things **are** stored because no derivation could recover them: that a
person named a format, that a person declared what a master's content stands on,
and that a person blocked or unblocked a master.

---

## Rights

A master's `rights_basis` gates a different thing from quality, and the two are
kept apart deliberately.

A master with `UNESTABLISHED` rights **may generate and be validated** — checking
whether the code works publishes nothing. What it may not do is reach a qualified
edition, which is the step where something would be sold. Collapsing the two
would either stop Brain testing its own generators or let it sell a puzzle built
from a corpus nobody established the rights to.

`UNESTABLISHED` is a real value and means *the question is open*, which is a
different fact from nobody having asked. `PUBLIC_DOMAIN`, `OWN_WORK` and
`LICENSED` each require a statement of what the basis actually is: "licensed"
with no statement of which licence is an assertion nobody could check later.

---

## The three multipliers

The brief asks for three, and two of them cannot be measured here:

| multiplier | answer |
|---|---|
| master to SKU | counted from rows, with its denominator named |
| setup to unit yield | `null` — nothing here holds a print run or a machine setup |
| contribution per setup | `null` — nothing here holds money |

The two `null`s name what would measure them rather than being merely empty.
Inventing a figure for something a person would use to decide whether to buy a
machine is the single most expensive thing this kernel could do.

**"A setup of 10 producing 50" is a search target, not a quota.** Nothing here
counts up towards a number, and the denominator is always named — a multiplier
reported without one is §29's *"0 of 8 settled"* in the other direction:
accurate, and read as an achievement.

Both `editionsDeclared` and `qualifiedEditions` are reported, because the gap
between them is the most interesting thing on the reading: it is exactly how much
of the catalog is real.

---

## What lives elsewhere, and why nothing duplicates it

| what | where |
|---|---|
| the monetization ledger — every route, ranked, nothing deleted | Cash Mode's portfolio (§30) |
| the physical production ladder and owned equipment | the manufacturing programme (§39) |
| who produces each step of the work | the labor kernel (§41) |
| building a generator for a format Brain cannot make | the Software Factory (§27) |

The order was explicit: *do not create duplicate research engines, queues,
graphs, factories, approval systems, or dashboards.* A second monetization ledger
would be the one that drifts.

**What this kernel contributes to that ledger is claims.** A worker answering a
`DEMAND` or `CHANNEL` question sets `opportunity_signal` beside its
`puzzle_finding` — the axes are independent and `brain_submit_claims` says so —
and Cash Mode's own bridge turns a signalled claim into a ranked opening. The
route from *"a publisher publishes what it pays"* to *"this is a ranked opening"*
already exists.

---

## The research half

A round is a Russell candidate. `judgeCandidate` asks the archive first (§13),
the compiler writes the specification, the approval envelope decides whether it
may start, the evidence gate decides what may be claimed, and all three audit
roles decide whether it stands. Nothing here researches anything itself.

Five purposes, mapped onto three envelopes because `planFitsEnvelope` pins one
assignment template per envelope and three completion standards cover them:

| purpose | envelope | asks |
|---|---|---|
| `UNIVERSE` | `RUSSELL_PUZZLE_MARKET_V1` | which formats, mechanics and products exist |
| `DEMAND` | `RUSSELL_PUZZLE_MARKET_V1` | who buys this, and what it is published to pay |
| `CHANNEL` | `RUSSELL_PUZZLE_MARKET_V1` | where it reaches a buyer, and on what terms |
| `RIGHTS` | `RUSSELL_PUZZLE_RIGHTS_V1` | what constrains the rights to produce and sell it |
| `PRODUCTION` | `RUSSELL_PUZZLE_PRODUCTION_V1` | what producing it physically costs, and how |

The rights envelope is separated because its completion standard genuinely
differs: **an established absence is the result it usually exists to produce**,
and a packet judged by the market template would read "no constraint found" as
having found nothing. §14 is the standard — a claim that something does not exist
is established by a documented search of the places it would be, or not at all —
and an undocumented silence recorded as an established absence is the most
expensive mistake available here, because something would be built on it.

None of the three authorizes an effect discovery did not already authorize. They
take their source classes and prohibitions from the same constants the cash
envelopes use, rather than restating them.

### The allocator's order

Six rules in a fixed order, lexicographic, never a weighted score. The order is
**cash now ahead of position later**, and rule 1 is the sharpest form of it:

1. `RIGHTS` on a master that has produced validated puzzles and cannot sell them
   — the shortest distance between spent effort and money.
2. `DEMAND` on a format Brain can make and has no buyer for.
3. `CHANNEL` where demand is established and no route is.
4. `RIGHTS` on a format Brain cannot build *because of* a rights question —
   where the crossword sits.
5. `UNIVERSE` — what else is out there.
6. `PRODUCTION` — only once something qualifies, because asking what a print run
   costs before anything is established about who buys it is costing a run for a
   book nobody wants.

It is pure over a recorded snapshot, so "why did Brain research that" is
answerable afterwards from an input rather than from a re-run against a database
that has moved. Being pure makes it useless as a safety mechanism, which is the
same split `services/dispatch/router.ts` draws: the exclusion is the unique index
on `puzzle_rounds`.

---

## What bounds the tick, and what deliberately does not

Producing and checking spend nothing — no provider, no allowance, no external
read — so they run **whatever the standing authority says**. A project with no
research grant still builds its catalog and still learns whether its generators
work.

Opening a round fires a worker, so that half is behind the grant. §41 records why
the check belongs in the kernel rather than being left to `launch`: a candidate
that parks for want of authority launches no mission, so its round would stay
`OPEN` for ever, and an open round is exactly what stops that question being
asked again.

The tick declares no format, master or edition; compiles nothing; unblocks
nothing; and sells, contacts and spends nothing.

---

## What this does not do, stated rather than implied

- **No press-ready artifact.** An edition compiles to a **proof sheet** — every
  puzzle and its answer key, rendered as text — with no typography, page
  architecture, trim, bleed or imposition. Its first page says so. A layout
  compiler is a Software Factory change somebody approves.
- **No difficulty calibration.** Every difficulty is a structural measurement of
  the puzzle and `difficulty_basis` names exactly what was counted. Mapping that
  onto how long a person takes needs playtest data this Brain does not hold.
- **No human edit and no playtest.** Enjoyment, readability, cultural fit and
  actual difficulty are what the brief asks a person to check, and nothing here
  checks them.
- **No revenue.** Nothing links an edition to a money entry, so the three rungs
  above `SELLABLE` read `UNKNOWN` with the missing link named — not `NOT_MET`,
  which would assert that nothing has ever sold.
- **Duplicate detection is a documented subset.** `canonicalGrid` folds
  rotations, reflections and symbol relabellings. For Sudoku it does *not* fold
  band and stack permutations — 3,359,232 further forms per grid. It **misses
  duplicates and never invents one**, which is the safe direction: a missed
  duplicate is a puzzle printed twice, and a false positive would silently refuse
  to store a genuinely new puzzle.
- **The screening check looks only for the strings a master supplies.** With an
  empty list it establishes that nothing on an empty list appears, which is true
  and is not the same fact as a grid having been screened.

---

## Driving it

```
npm run puzzles -- generators                     what this repository implements
npm run puzzles -- seed <project> --admin <email> the brief's starting universe
npm run puzzles -- master <project> --format <id> --name "…" --generator <key>
                   --spec '{"givens":34}' --rights OWN_WORK --statement "…" --admin <email>
npm run puzzles -- produce <project> --master <id> --count 12
npm run puzzles -- edition <project> --master <id> --name "…" --class PRINTABLE_PDF
                   --axis DISTINCT_CONTENT --rationale "…" --admin <email>
npm run puzzles -- fill <project> --edition <id> --count 10
npm run puzzles -- compile <project> --edition <id>
npm run puzzles -- report <project>
```

Every one of those exists as a route at `/api/projects/:id/puzzles`, behind
`requirePerson` and `decideProjectAccess` at `ADMIN`. There is no client surface
for this kernel yet, so the script is the door that works today — and it calls
exactly what the routes call rather than being a second, weaker path.

---

## What has and has not happened

The kernel operates end to end against a local Brain and against Postgres. A
seeded universe of twenty formats, four of which this Brain can generate; a
declared master; twelve puzzles produced with every required check passing; a
qualified edition of ten compiled to a proof sheet with a recorded sha-256; a
cosmetic reskin of it recorded, refused qualification by name, and refused
compilation.

**No fleet worker has answered a puzzle question in production**, because that
needs a deploy and a fire — and until one has, the engine passing its tests says
nothing about the research. That is the separation Step 3 drew between the
research engine passing its tests and a real job having actually run, which §38
and §39 both had to say about themselves on the day they landed.

**Nothing has been published, listed, submitted or sold**, and nothing here can
do any of those.
