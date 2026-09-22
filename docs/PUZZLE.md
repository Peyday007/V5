# The puzzle products and production kernel

A complete operating loop for turning demand for puzzle content into original
validated puzzles, those into multiple qualified products, and those into work
somebody can be paid for — and for learning from every attempt.

It is an **entrance** to machinery Steps 4 to 12C already built. Nothing here
schedules, audits or executes anything: a question is a Russell candidate, the
compiler writes the specification, the approval envelope decides whether it may
start, the evidence gate decides what may be claimed, all three audit roles
decide whether it stands, and a product that becomes sellable is pursued by Cash
Mode's own execution path. There is no second orchestration universe here and no
second lifecycle.

---

## 1. What makes this kernel different from every one before it

Every kernel before this holds facts Brain read somewhere. Who needs tankers,
what a Michigan statute requires, what a printer charges — none of them can be
established without a worker reading a published source and an audit standing
behind it.

A puzzle is different in kind. Brain can generate a sudoku and then demonstrate,
**from the printed grid alone**, that it has exactly one solution. That is an
unusually strong position for this repository to be in, and every decision here
is arranged so it is not thrown away by storing a claim where a proof would do.

---

## 2. The rule the whole thing rests on

> A generated grid is not a puzzle until a solver that did not generate it has
> proved it.

`validate` receives the rendered artifact **and nothing else**. Not the spec,
not the seed, not the generator's working — no placement list to check against,
no record of which cells were dug. A word search validator is handed a rectangle
of letters and a word list, exactly what the person buying the book gets, and it
has to find the words itself.

That duplication is the mechanism rather than an inefficiency. If the digger had
a bug that left two solutions, the validator would find two solutions and the
instance would be refused — which is exactly what could not happen if the
validator read a `unique: true` field the generator wrote.

It is the same sentence this repository has written three times before:

* §27 — *a worker's summary is never evidence; the branch is.*
* §42 — *a render is the interface, and code is a claim about it.*
* §9 — *a file on disk is not something Brain has read.*

---

## 3. What is stored

The **specification**, and nothing else.

`puzzle_instances` holds a master, a seed and a hash. There is no grid column,
no solution column and no answer-key column, because the brief requires that
those three cannot silently diverge and the only way they cannot is that there
is one of them: `render(master, seed)` produces all three together,
deterministically, every time.

Determinism is therefore load-bearing rather than a convenience, and it is
asserted as a property: the same spec must render byte-identically on a second
call, or the stored content hash describes something nobody can reproduce.

`canonical_hash` is format-specific *sameness* rather than literal sameness. Two
sudoku grids differing only by a relabelling of digits or a quarter turn are one
puzzle to anybody solving them, and a hash of the printed characters would let
one be sold four times as four.

---

## 4. The formats, and what each can and cannot establish

| format | generates | proves uniqueness | measures difficulty |
|---|---|---|---|
| sudoku | yes | **yes**, by counting solutions from the printed grid | naked and hidden singles, then what is left |
| word search | yes | yes — a word reading twice is refused, because the key names one place | filler density and how many words run backwards or diagonally |
| maze | yes | **yes**, by counting openings against squares: a tree has one route | junction density and route length |
| cryptogram | yes | **no, and it does not claim to** | distinct letters, length and starters given |
| crossword | **no** | n/a | **no** |

Two of those entries are the interesting ones.

**Cryptogram does not claim uniqueness.** Proving no other letter assignment
reads as English would mean searching 26! mappings against a definition of
English nobody has. What it does establish is every property that is actually
checkable — the cipher is a one-to-one substitution, no letter stands for
itself, and the printed key deciphers the printed text to the printed solution.
Claiming the checkable things and naming the one that is not is a better
contract than a flag nothing tested.

**Crossword has a validator and deliberately no generator.** Its fill and its
clues are editorial work with no correctness criterion, so a generator would
produce exactly the unvalidated filler the brief forbids, with the added insult
of being expensive to print. What Brain *can* do is check one: symmetry, minimum
entry length, every white square crossed both ways, connectivity, one clue per
entry, no answer used twice, and the answer list against what the grid actually
spells. An editor told their grid has an unchecked square before they write
sixty clues has been saved an afternoon.

---

## 5. Rights

A corpus is a **shipped constant** in `domain/puzzleCorpora.ts`, with its rights
position declared in code beside the bytes.

This is the one fact in the kernel that research may never establish. A claim
that a word list is free to use commercially is a legal position about a
specific artifact in *this* repository, and no amount of reading published
sources settles it. A model that could write a rights row would eventually write
a confident one, and the first anybody would hear of it is a takedown.

* `PUBLIC_DOMAIN`, `OWNED`, `LICENSED_COMMERCIAL` may be compiled from.
* `NON_COMMERCIAL` is a settled answer meaning *we checked and may not sell
  this*.
* `UNKNOWN` is *nobody has established it* — a different fact with a different
  remedy, and it compiles nothing either.

The crossword clue bank ships **empty and UNKNOWN on purpose**. Leaving it out
would make the gap invisible: the format would read as unbuilt when what is
actually true is that the machinery exists and the rights do not.

---

## 6. Leverage, and the thing that would fake it

*Ten systems producing fifty outputs* is a real and reachable shape. It is also
the easiest number here to fake, because fifty covers over one set of puzzles
satisfies the arithmetic and nothing else.

So `qualify` is a derivation over rows rather than a field a compiler fills in,
and it rests on two things that cannot be asserted:

1. **The content dimension is measured**, from the instances two products
   actually share. It is taken against the *smaller* product rather than as a
   Jaccard index — a fifty-puzzle sampler drawn from a two-hundred-puzzle book
   scores 0.25 by Jaccard and is, to anybody who owns the book, fifty puzzles
   they already have.
2. **Everything else comes from a column with a closed meaning**, in a table
   that has no cover column, no title variant and no page order. A reskin has
   nowhere to be declared as a difference.

Three multipliers are reported and they are not each other:

* **master to SKU** — measurable today from rows Brain owns.
* **setup to unit yield** — `UNKNOWN`. Nothing has been physically produced, and
  zero is a measurement of a run that never happened.
* **contribution per setup** — `UNKNOWN`. Needs a settled payment and a spent
  setup cost.

`valid puzzles per editorial hour` is `UNKNOWN` too, and the substitute is
refused by name: machine generation time is a real number that answers a
different question, and reporting it under this metric's name would be
undetectable.

---

## 7. The money

**A retail price is not receipts.** They are indistinguishable in a claim
sentence and they differ by most of the margin, so they are two components of a
closed vocabulary and `economics.ts` refuses to compute a contribution from the
first. A product class with a shelf price and no receipts figure reports its
contribution as **withheld**, naming exactly that.

Four other refusals:

* **A missing load-bearing line withholds the total and names it.** What a class
  cannot be costed without is per class: a downloadable PDF with no freight
  figure is completely costed, and a boxed game with no freight figure is one
  whose largest variable cost nobody has established.
* **Two currencies withhold the total.** Brain never converts, because a rate is
  a fact about a day nobody recorded.
* **Per unit and per run are separate accumulators.** A setup is spent once
  however many come off it; adding it to a unit cost produces a number wrong by
  the size of the run. The per-run total becomes a **breakeven** instead.
* **A published zero is a figure.** An absent line and a zero line have opposite
  meanings and only one of them withholds the total.

Where a total *is* reported it is computed from the worst published end — the
highest cost and the lowest receipt — with the range beside it.

### The hundred-puzzles-for-a-dollar question

`dollarBookReading` answers it from rows or not at all, naming the eight
published figures the chain turns on and which of them are held. What it will
**not** do is treat the dollar as revenue. That single move is how the question
gets answered wrongly, and it is the reason the reading exists.

---

## 8. The maturity ladder

Ten rungs, derived on the read path and stored nowhere. The ladder stops at the
first rung that is not met rather than reporting the highest anything satisfied.

```
DISCOVERED → RESEARCHED → GENERATABLE → VALIDATABLE → PRODUCTIZABLE
  → SELLABLE → REVENUE_PROVEN → REPEATABLE → SCALABLE → PRODUCTION_OWNED
```

Three are unreachable by construction rather than by policy:

* `GENERATABLE` reads the format registry — a directory of implementations
  somebody can open.
* `VALIDATABLE` needs an instance that actually passed.
* `REVENUE_PROVEN` needs a settled row in the money ledger, which only a real
  payment writes. An agreement, an acceptance and an invoice are not one.

`SELLABLE` needs a **person** to have read what the machine made. A machine
check establishes that a puzzle is solvable and cannot establish that it is any
good, fair or culturally right. What clears it is a recorded
`HUMAN_EDIT_PASSED` observation, and there is no flag anywhere that stands in
for it.

`PRODUCTION_OWNED` reads §39's manufacturing programme rather than duplicating
it. A printing, cutting or binding capability is a manufacturing capability and
is recorded where every other one is.

---

## 9. The monetization ledger

Twenty-four routes, in code, reviewed. **Nothing removes one.**

The brief asks for the best five surfaced prominently and the slow, blocked and
long-horizon ones never hidden, and those pull in opposite directions if the
ledger is a table: whatever prunes it for the top five is one bug away from
pruning it for good, and a route that vanished would be indistinguishable from
one nobody thought of.

So the routes are a constant, the state is derived per route on every read, and
a person rejecting one records an observation — which keeps the route visible
with its reason rather than making it disappear.

The order is **lexicographic over observable facts with no weighted score**:
state, then unmet requirements, then capital at risk, then how physical it is,
then the id. Two routes that differ are separated by exactly one factor and the
reading names it.

The physical production ladder is stages 0 to 5 on each route — nothing
physical, print-on-demand, proven outsourced batches, in-house finishing, owned
machinery, contract production on owned capacity. Nothing at stage 4 is
reachable before stage 2 has been shown to work, and the ordering is the point.

---

## 10. Authority

Nothing in this kernel authorizes an effect discovery did not already authorize.

Both envelopes — `RUSSELL_PUZZLE_MARKET_V1` and `RUSSELL_PUZZLE_TERMS_V1` —
take their source classes and their prohibitions **verbatim** from the cash
discovery envelope. In particular nothing here authorizes submitting a puzzle
anywhere, registering an account with a marketplace, requesting a quote from a
printer, or listing, uploading or publishing anything. Every one of those is a
`COMMERCIAL_ACTION` a person grants separately.

Two envelopes rather than one because the two halves have opposite completion
standards: establishing who buys puzzle content is a question whose deliverable
is a name, and establishing what it earns is one whose deliverable is a figure.
Judging either by the other's standard is §25's Westbrook defect at a compiler.

Four things are a person's and have no path around them:

1. **Naming a format.** A CHECK requires every `DISCOVERED` row to carry the
   claim that established it, so Brain cannot write a `SEED` row at all.
2. **Reading what the machine made**, which is the only thing that moves a
   format to `SELLABLE`.
3. **Recording what actually happened** when something was attempted — the one
   kind of fact here no source publishes and no validator computes.
4. **Turning a monetization route down.**

---

## 11. The tick

```
file → make → compile → promote → allocate
```

Each step is there because of the one after it. Filing first means a round that
settled on the previous pass has its formats and buyers on the map before
anything else looks. Making before compiling means puzzles that have just passed
can go into a product immediately. Compiling before promoting means a product
that has just become possible is promoted at its real state. Promoting before
allocating means a format finished with research is out of the allocator's way.

**Winding the sprint down stops making, compiling and asking, and stops nothing
else.** Filing what research already found is not new discovery — the spending
happened when it ran. Promoting a product that is already compiled and already
qualified is finishing work already paid for. §30's rule that an off switch must
not reach past the thing it owns, applied per step rather than to the pass.

### A systematic defect blocks the batch

The cheap response to failing output is to throw the bad ones away and keep
drawing seeds, which produces a book whose puzzles are the ones that happened to
pass, from a generator nobody fixed. A batch crossing `DEFECT_CEILING` (a third)
stops, with every failing check recorded against its seed.

There is deliberately **no route to edit an instance**. The seed is the puzzle,
so a patched one would be a row whose stored hash describes something the
specification no longer renders. A repair is a new generator version and a new
master.

---

## 12. Reading it

```
npm run report:puzzle -- --project prj_xxx
npm run report:puzzle -- --project prj_xxx --puzzle pzi_xxx
```

Read-only by construction: it opens the database, prints what is there, and
closes it. With `--puzzle` it re-renders one stored puzzle from its
specification and says whether it still hashes to what was recorded — which is
"the specification is the storage" made checkable from a terminal.

Inside the deployed container:

```
flyctl ssh console -C "sh /app/scripts/puzzle-report.sh --project prj_xxx"
```

Over HTTP, for any project member:

```
GET  /api/projects/:projectId/cash/puzzles
GET  /api/projects/:projectId/cash/puzzles/instances/:instanceId
POST /api/projects/:projectId/cash/puzzles/formats
POST /api/projects/:projectId/cash/puzzles/systems
POST /api/projects/:projectId/cash/puzzles/observations
```

---

## 13. What is true today

Five formats are implemented: sudoku, word search, maze and cryptogram generate
and validate; crossword validates. All four generators produce puzzles that pass
their own independent checks and reproduce byte-identically from the same seed.

`tests/puzzleIntegrationPass.test.ts` drives one sprint from a person seeding a
format through a system being set up, puzzles made and proved, a product
compiled, a worker answering a kernel question through the real MCP tools and
the real evidence gate, the findings filing, a person reading what the machine
made, and the product reaching the portfolio. Only the external edge is
simulated — the worker authenticates as a `WORKER` principal and claims a real
item off the durable queue — and the puzzles are not simulated at all.

**No fleet worker has answered a puzzle question in production.** That needs a
deploy and a fire, and until one has happened the engine passing its tests says
nothing about the research — the separation Step 3 drew between the research
engine and a real job having actually run.

### Two capabilities are absent rather than half-built

* **`TYPESET_FOR_PRINT`** — nothing here produces a PDF. A puzzle renders as
  text, which is enough to prove it and not enough to print it, so every
  physical route in the ledger is behind this. It is the cheapest capability on
  the list to build and the first thing between a validated catalog and a
  downloadable product.
* **`IMPORT_A_LICENSED_CORPUS`** — the single thing that would unlock
  crosswords, which are the largest syndication market in this trade and the one
  format here that cannot be generated. It needs a rights record somebody signs,
  provenance per entry, and an answering transition for when a licence lapses,
  and a table with nothing that could honestly fill it is a mechanism nothing
  calls.

Both are reported as `MISSING` with what they would take, rather than existing
as tables nothing could fill.
