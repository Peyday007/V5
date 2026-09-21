# The Puzzle Products + Production Kernel

The axis nothing above it can express: **one validated production system
compiles into many qualified commercial outputs.**

Every other kernel in this Brain researches the world. This one researches the
world *and holds the artifact* — a master that generates, an instance it
generated, the validation run that proved that instance works, and the products
compiled from instances that passed. It is the first thing in this repository
whose subject is something Brain can **make**.

Everything it adds is a new *entrance* to machinery Steps 4 to 12C already
built. A round is a Russell candidate; the compiler writes the specification,
the approval envelope decides whether it may start, the evidence gate decides
what may be claimed, and all three audit roles decide whether it stands. There
is no second work queue, no second approval, no second identity, no second
money ledger and no second policy module.

---

## What it holds

| Table | What it is |
|---|---|
| `puzzle_formats` | The universe. A format exists because a gated claim named it or a person seeded it. |
| `puzzle_standards` | What the trade demands of a format, as a check something can actually run. |
| `puzzle_rights` | Published rules about what may lawfully be made and sold. |
| `puzzle_masters` | A reusable production system: engine, version, parameters, corpus, rights basis. |
| `puzzle_instances` | One generated puzzle. Immutable, seeded, hashed, with its solution and answer key. |
| `puzzle_validations` | Append-only validation runs. Exactly one is current per instance. |
| `puzzle_outputs` | A commercial output, with the axes on which it differs from its siblings. |
| `puzzle_output_members` | Which validated instances are in which output. |
| `puzzle_routes` | The monetization possibility ledger. Never pruned. |
| `puzzle_route_evidence` | Dated buying signals, and documented absences. |
| `puzzle_economics` | One published figure per row, with its currency and what it is per. |
| `puzzle_rounds` | The research questions, one live per subject per purpose. |
| `puzzle_observations` | What attempts taught, one observation at a time. |

Plus eight columns on `research_claims` — `puzzle_finding` and its seven
companions — which are the sixth declaration axis beside `opportunity_signal`,
`structural_finding`, `labor_finding`, `capability_finding` and `deal_finding`.

---

## The rules that decide every column

### 1. There is no list of puzzle formats in this repository

`tests/puzzleKernel.test.ts` reads the source to say so, the way
`operatorConsoleRemoved` does: what must not exist is not something a
behavioural test can see.

The directive names a long seed list and then says, in its own words, *seed —
but do not permanently limit*. `services/puzzle/directive.ts` returns that list
**and that instruction as one string**, so no caller can print a bounded
taxonomy. It reaches a worker as a spread to search across and never as rows.

### 2. A generator is an implementation; a format is not

§37's sentence at a new artifact. A `puzzle_formats` row says the format exists
in the world. An engine is code somebody wrote. They meet at `formatKey` and
nowhere else, and they are allowed to disagree in both directions.

A format with no engine reports `RESEARCHED`. The directive's own instruction
is *do not falsely claim support for puzzle formats lacking real validators*,
and this is that instruction expressed as a reading rather than a promise.

### 3. A puzzle is evidence only if a validation run passed

§9's rule, one artifact along. `puzzle_validations` is append-only with a
supersession pointer; exactly one run is current; an instance with no current
`PASSED` run is something this kernel **does not have**.

Every reader says so rather than treating silence as health, and
`compileOutput` refuses whole rather than filtering — a shorter book than the
one somebody asked for, with nothing saying so, is the failure the refusal
exists to prevent.

`UNCHECKED` is a third verdict on purpose: *the validator ran and could not
answer* has a different remedy from *the puzzle is wrong*, and folding it into
either is the collapse §30 keeps correcting.

### 4. Validation is a hundred per cent, structurally

Generation and validation happen in one pass in `produce.ts`, and there is no
code path that writes an instance without a run. A sampling rate would be a
number somebody could lower, and the first thing anybody lowers it for is a
batch that is running late.

A run of failures on one check **blocks the batch** and records a
`GENERATOR_DEFECT` observation naming that check. The failures keep their rows
and their validation runs: they are the evidence the defect existed and the
record a repair is judged against.

### 5. A reskin is not a product

`DIFFERENTIATOR_AXES` holds thirteen axes and `axisQualifies` is a `Record`
over all of them, so an axis added later is a compile error until somebody says
whether it counts. `TITLE`, `COVER` and `PAGE_ORDER` are named rather than
absent — recording that two books differ by their cover is honest, and counting
it is not.

An output whose qualifying set is empty, or identical to an **earlier**
sibling's on the same master, reads `REPRINT`. Reprints are counted in their
own figure rather than dropped.

> The first version of this marked *both* of two identical books as reprints,
> so the catalog had a reprint of nothing. Order decides it now: creation time,
> then id, in both dialects.

### 6. Three multipliers, kept apart

*Track three different forms of leverage separately.* Master-to-SKU is about
editorial reuse, setup-to-unit is about a machine, contribution-per-setup is
about money. A single number would be an average over three unrelated
denominators and would read like a measurement.

Two of the three, and *valid puzzles per editorial hour*, report `null` with
what would measure them: nothing in this Brain records a print run, a tooling
setup or an editorial hour. **Ten producing fifty is reported as the
directive's own search target**, beside its own caveat, and nothing in the
kernel creates an output to move it.

### 7. A total past an unknown is withheld, and the reason is named

Four reasons, each reported rather than silently producing a smaller number: a
missing load-bearing line for this production class, two currencies, two bases,
or no revenue line at all.

The direction is the point. A total that steps over a missing printing cost is
**smaller** than anything published says, which makes a product look cheaper to
make than it is — and too low at the number that decides whether to print reads
as a bargain rather than as a mistake.

Setup and per-unit are kept apart by `isSetupCost`, a lookup, so
`breakeven = setup ÷ contribution per unit` means something. A negative margin
reports no breakeven and says it is a reason to decline rather than to raise
the price.

### 8. The ledger is never pruned

There is no `DELETE FROM puzzle_*` anywhere in the kernel, and a test reads the
source to say so. `disposition` carries a person's decision with their name and
a reason on it; there is no `DELETED` value and there must never be one.

Rank is derived lexicographically over seven observable facts with **no
weighted score anywhere**, and two routes that differ are separated by exactly
one of them — which the reading names. Two routes with nothing between them say
so, which is itself a finding.

Views: Top 5 Now, Next Best, All Active, Watchlist, Blocked, Unproven,
Archived-or-Rejected, and the Physical Ladder — the routes whose proof needs
capital, kept visible rather than ranked away.

### 9. An unknown is never a favourable assumption

- A demand signal with **no observation date is refused**, because an undated
  signal cannot be told apart from one somebody remembers from years ago.
- *Nobody has looked* and *somebody looked and there is nothing* are different
  rows with different remedies. The absence of rows says only the first.
- A format with **no standards at all** cannot be `VALIDATABLE`. An empty
  requirement list is nobody having looked, never a format with no
  requirements — and treating the second as the first is the unknown read
  favourably at the one place it puts unsolvable puzzles in somebody's hands.

### 10. Nothing derivable is stored

No maturity column, no leverage multiplier, no contribution, no rank, no
qualification state, no production stage. What *is* stored is what no
derivation recovers: that a person seeded a format, reviewed a master, compiled
an output, released one or decided a route's disposition; what a generator
actually produced; what a validator actually found; and what happened when
something was attempted.

---

## What a person decides, and what Brain may never decide

| Person only | Why |
|---|---|
| Naming a format | A machine that could name its own formats would be deciding what the universe is. |
| Naming a route, and every disposition | A machine that could archive a route would be deleting the ledger one row at a time. |
| Creating a master | It states the rights basis its corpus may be sold on. |
| **Reviewing a master** | The directive requires it of every new generator. A review Brain could record itself would not be one. |
| Producing a batch | Generation is cheap and unbounded; a kernel producing on a timer fills a catalog nobody asked for. |
| Compiling an output | What goes in a product is an editorial decision. |
| **Releasing an output** | The moment something goes out under somebody's name. |
| Playtesting | Ambiguity, readability, enjoyment and cultural fit are not properties any program here can check. |

Every write is `ADMIN` plus `requirePerson` — two independent guards, because a
guard on one entrance is not a guard. Recording an observation is `WRITE`.
Reading is any project member's.

**Nothing in this kernel publishes, prices, lists, prints, buys or contacts
anybody.** Releasing an output records a decision; pursuing it is Cash Mode's
machinery behind the standing commercial authority a person granted separately.

---

## The engines

Three, each with a validator that judges a payload it did not necessarily
produce — the validator re-derives the answer and compares, so a generator that
recorded the wrong key is caught rather than believed.

| Engine | Checks it implements |
|---|---|
| `sudoku_classic_9x9` | GRID_LEGALITY, SOLVABILITY, SOLUTION_UNIQUENESS, ANSWER_KEY_AGREEMENT, DIFFICULTY_CALIBRATION |
| `wordsearch_grid` | GRID_LEGALITY, COORDINATE_AGREEMENT, SOLVABILITY, ANSWER_KEY_AGREEMENT, PROHIBITED_CONTENT |
| `maze_perfect_grid` | GRID_LEGALITY, REACHABILITY, SOLUTION_UNIQUENESS, ANSWER_KEY_AGREEMENT |

`DUPLICATE_DETECTION` is the kernel's, not any engine's: it is the unique index
on `(project_id, content_hash)`, a project-wide property no per-instance
validator could establish.

Uniqueness is **proved** in two of the three. Sudoku searches the grid from
scratch and stops at two solutions. A maze is a spanning tree by construction,
so uniqueness is a passage count against a cell count plus a connectivity walk.
Those two formats are where this kernel starts for exactly that reason.

Every generator is deterministic in `(engine, version, seed, params)`, because
the directive's repair rule — *block the batch and repair the generator, do not
patch the outputs* — is unenforceable against a defect you cannot reproduce.

`tests/puzzleEngines.test.ts` takes a good payload, breaks exactly one thing,
and asserts the validator names that one thing. Asserting that a freshly
generated puzzle passes its own validator proves almost nothing; the same code
made both.

---

## The research half

Seven round purposes, two envelopes.

| Purpose | Asks |
|---|---|
| `UNIVERSE` | Which formats are actually published and sold. Names **sources**, not formats, so it can reach outside the map. |
| `DEMAND` | Who has published that they buy this, and when. |
| `ROUTE` | How money is actually captured in this trade. |
| `ECONOMICS` | What it pays and what it costs, line by line, with each figure's basis. |
| `RIGHTS` | What published rules bind what may be made and sold. |
| `STANDARD` | What a publishable one must satisfy, as checks a validator could run. |
| `CHEAP_BOOK` | The directive's own reverse-engineering of the roughly one-dollar book. |

`RUSSELL_PUZZLE_MARKET_V1` and `RUSSELL_PUZZLE_CRAFT_V1`. Two rather than one
because `planFitsEnvelope` pins one assignment template per envelope and the
two halves have opposite completion standards: a **name and a date** on one
side, a **rule** on the other — and on the market side, a documented absence is
often the most valuable single answer.

Both take their source classes and forbidden actions **verbatim** from the cash
discovery envelope, so nothing here authorizes an effect the sprint's own grant
did not already authorize — which is nothing beyond reading.
`tests/puzzleKernel.test.ts` runs every rendered question through the real
forbidden-actions screen, because a brief that trips it is a round that can
never run.

### Ordering

Finishing outranks starting, the same correction §45 and §38 both record:

1. A format that produces with no standard to be judged by
2. A format that produces whose rights nobody has looked at
3. A route with a ready product and nobody known to buy
4. A route with demand and no published price
5. Active routes nobody has looked at
6. Widen the universe
7. Widen the ledger
8. The cheap-book investigation

Bounded by `MAX_OPEN_PUZZLE_ROUNDS` (concurrency, never a lifetime quota — §24
removed exactly that kind of number), a cool-off on a settled round, and
`BARREN_ROUNDS`: a subject asked twice for nothing is not asked again, because
Brain has documented that nothing is there.

---

## What is true today, said plainly

The kernel operates end to end against a local Brain and both test suites pass:
a directive parsed and its own words in an assignment, rounds opened by the
allocator, findings filed by lookup and refused otherwise, three engines
generating and validating, a batch blocked on a systematic defect, outputs
compiled and read at their real qualification, the ledger ranked and never
pruned, and every total withheld where it should be.

**No fleet worker has answered a puzzle question in production**, because that
needs a deploy and a fire — the separation Step 3 drew between the research
engine passing its tests and a real job having actually run, which §38 and §39
both had to say about their own kernels on the day they landed.

**Nothing has been sold, printed, published or listed**, and nothing here can
do any of those. No physical production run has been recorded, so every figure
above Stage 1 of the ladder reports as unmeasured with what would measure it.
No person has playtested anything, and the surface says so rather than implying
the sample was taken.
