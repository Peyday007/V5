# The self-expanding industry kernel

Cash Mode's discovery has ten search buckets. They are ten **mechanisms** — who
published a paid request, where the same deliverable has two prices, who has
sold more work than they can deliver — and not one of them says *where* to ask.

So production discovery searched an undifferentiated economy. Thirty-one
openings came back across transcription rates, stock-photo subscriptions,
ticket resale, sneakers, trading cards, domain appraisals and bug bounties, and
nothing anywhere in the Brain said which industries had been looked at, which
had never been opened, or what lived underneath any of them. There was no way
to answer *which economically important areas have we barely examined*, because
nothing held the question.

This kernel is the missing axis. It lives in `server/services/industry/`,
`server/repos/industry.ts` and `server/domain/industry.ts`, and everything it
adds is a new **entrance** to machinery Steps 4 to 12C already built.

---

## The four rules

### 1. The map is discovered, never declared

**There is no list of industries in this repository.** Not in the kernel, not
in a constant, not in a migration. `tests/industryKernel.test.ts` reads the
source of all eight kernel modules and fails if one appears.

A node exists for exactly two reasons: a claim that cleared the evidence gate
established it, or a person seeded it. The schema enforces the first —
`CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)` — so a node with
neither cannot be written by any code path, a script, a screen or a migration.

The bootstrap is therefore a **question**, not an answer:

> Which top-level sectors and major industries do the authoritative industry
> classification systems declare — NAICS, ISIC, SIC, GICS and the national
> statistical agencies that publish their own — naming each one as the system
> itself names it, saying which system declares it, and reporting where two
> systems divide the same activity differently rather than reconciling them?

Naming those systems is naming **sources**, which is the same thing
`proposedSources` has always done. The sectors arrive as gated claims. A
hardcoded list would answer the question the kernel exists to ask, and would be
wrong about every economy a classification system has revised since somebody
typed it.

### 2. A structural finding is declared by whoever read the source

§33 records what the alternative costs. `harvest` decided "is this an opening"
by matching `evidence_lane` against a literal; planners name their own lanes;
production wrote seventeen distinct lane ids across 82 claims and the literal
appeared zero times. The bridge could never fire, and no amount of correct
research was going to make it.

`opportunity_signal` was that repair. `structural_finding` is the same repair
one axis along: one nullable column on `research_claims`, one closed
vocabulary, validated exactly on submission, and anything outside it refuses
the **whole submission** rather than being stored and compared against nothing.

Ten kinds. Seven add a subject to the map:

| Finding | What it establishes |
|---|---|
| `SUB_INDUSTRY` | a narrower industry inside the subject |
| `VALUE_CHAIN_LAYER` | a stage of producing or delivering here |
| `BUYER_TYPE` | a kind of organisation that pays for work here |
| `FULFILMENT_SOURCE` | who or what actually performs the work |
| `TRANSACTION_TYPE` | how money changes hands, on what terms |
| `BOTTLENECK` | a documented constraint on supply |
| `ADJACENT_INDUSTRY` | a different industry the source names as connected |

Three do not, because they are facts *about* a subject rather than subjects of
their own — and each carries a value from its own closed set:

| Finding | Subject comes from |
|---|---|
| `HIDDEN_CONSTRAINT` | the fourteen constraint kinds |
| `CAPITAL_REQUIREMENT` | the sixteen requirement kinds |
| `CAPITAL_RESTRUCTURING` | the twenty-five financing mechanisms |

One validator decides, in `domain/industry.ts`, and **both** doors call it —
the wire door in `mcp/researchTools.ts` and the provider door in
`services/research/schema.ts`. This repository has had to record *a rule
applied by one of two readers is worse than none* four times; a second copy
here would be the fifth.

Every refusal refuses the submission rather than dropping the field. §27
records why: truncation and silent dropping are the outcomes a worker cannot
recover from, because they are reported as success.

### 3. What can be derived is not stored

There is no coverage score, no priority, no capital tier and no path verdict in
the schema. All four are facts about rows that change underneath them —
`tier.ts`'s own argument, and `placements`' before it: a row is not a decision,
and a stored verdict is stale the moment the evidence it was waiting on
arrives.

Two things *are* stored, because no derivation could recover them: that a
person seeded a subject rather than Brain finding it, and that a person decided
a path was not worth following.

### 4. An unknown is never a favourable assumption

A capital requirement with no published amount is `NULL`, and a set holding one
**withholds the minimum owner capital entirely** rather than summing the rest.

§30 records this correction at the margin. Here it is worse: an understated
minimum makes something look executable today, and *executable today* is what
starts spending. A restructuring with no published residual is reported as
available and reduces nothing, however plausible the mechanism sounds.

---

## What it asks

Four purposes, each its own kind of round in `industry_rounds`.

**`BOOTSTRAP`** — once, when the map is empty. What does the economy contain?

**`MAP`** — what sits underneath one subject: its narrower industries, its
value-chain stages, who pays, who fulfils, how money moves, where supply is
constrained. This is what grows the graph.

**`SCAN`** — the existing ten mechanism buckets, **with a scope at last**. The
bucket's own sentence is unchanged and the subject goes in front of it, because
a question that buried the scope at the end would be answered about the economy
at large — which is what the buckets did before this axis existed.

**`CAPITAL`** — for one qualified opening: which requirements are real, and
which published practices in its industry remove, defer or shift each one.

Each runs under a reviewed approval envelope with a matching compiler profile.
`RUSSELL_INDUSTRY_MAP_V1` and `RUSSELL_CAPITAL_STRUCTURE_V1` take their source
classes and their forbidden actions **verbatim** from the discovery envelope, so
all three authorize the same thing: reading published sources. Adding an
envelope is a code change somebody reviews, which is where *does this authorize
an effect?* gets asked. The answer for both is no.

---

## How it decides

`services/industry/allocate.ts` is a **pure function over a recorded
snapshot**, kept apart from the reads for `services/dispatch/router.ts`' reason:
*why did Brain research that* has to be answerable afterwards from an input
rather than from a re-run against a database that has moved on. Being pure also
makes it useless as a safety mechanism, which is the same split the dispatcher
draws — the exclusion is the unique index on `industry_rounds`, so two ticks
both deciding correctly produce one round.

Seven rules in a fixed order. **No weighted score anywhere**, because a score
needs weights, weights are a judgement nobody made, and the number then reads
like something that was measured.

| Rank | Rule |
|---|---|
| 100 | A qualified opening whose capital nobody has decomposed |
| 150 | The bootstrap, when the map is empty |
| 200 | Scan a subject that has already produced openings, under a mechanism never asked of it |
| 300 | Decompose a subject that produced openings and has nothing underneath it |
| 400 | Scan a subject nobody has ever searched — the blind spots, shallowest first |
| 500 | Decompose a subject nobody has ever decomposed |
| 600 | Re-scan a subject that has gone quiet, past its cool-off, most productive first |

Rule 100 outranks the bootstrap deliberately, and the first version of this file
had it the other way round. Writing the map is the longest-horizon question the
kernel asks; a qualified opening whose capital is unknown is the most immediate
thing there is, and the research that found it and the deep dive that qualified
it are both already paid for. On a pass with free slots both are asked; the
order decides only what waits when they are scarce, and **the thing that waits
should be the map rather than the money**.

Equal-ranked asks tie-break on when Brain came to know about the subject, so
every subject gets a turn. The first version broke that tie on the generated
node id, which is deterministic, meaningless, and leaves the same subjects at
the back of the queue for ever.

### It stops

Three bounds, each a bound rather than a preference:

- A subject with a live question of a purpose is not asked that question twice.
- A settled round waits out `ROUND_COOL_OFF_MS`.
- A subject searched `BARREN_ROUNDS` times for nothing **and** decomposed into
  nothing is not offered again. Not because looking is forbidden — because Brain
  has now documented that there is nothing there, and §13's rule about the
  archive applies to Brain's own history exactly as it applies to a project's.

`kindRecurses` is the other half: a bottleneck, a buyer type, a fulfilment
source and a transaction type are leaves of understanding rather than places
with more inside them. Decomposing them would produce a graph of adjectives.
They are still **scanned**, because a bottleneck is exactly where an opening
lives.

`MAX_OPEN_KERNEL_ROUNDS` bounds how many questions may be open at once. It is
**not** a lifetime quota: §24 removed exactly that kind of number from the
standing authority and recorded why — nothing it rationed was scarce, so it
measured a starting point and then became a permanent ceiling. Concurrency is
real provider capacity, and the kernel competes for the same slots the deep
dives do.

---

## Capital structure

A headline startup cost is a published figure about a **shape** of the business
— usually the shape where the owner buys the equipment, leases the property,
hires the staff and carries the receivables. It is not the answer.

One row per requirement; a restructuring is a second row naming the requirement
it answers. Two rows rather than two columns, because a requirement can have
several published answers and the honest output is all of them with their
sources, never the cheapest one silently chosen.

`readCapital` composes the minimum owner capital and refuses in three ways:

- A requirement with no published amount → the whole minimum is withheld, with
  `AMOUNT_UNKNOWN` naming why.
- Nothing decomposed at all → `NOT_DECOMPOSED`, which is a **different** fact
  from *it is out of reach* and has the opposite remedy.
- A restructuring with no published residual → available, and it reduces
  nothing.

Where several structures answer one requirement the lowest published residual
wins. That is the one place this function chooses at all, and it chooses rather
than averages because the residuals are alternatives: you use one structure,
not the mean of three.

### Capital tiers

`CAPITAL_TIERS` are **presentation**. Nothing is refused or admitted because of
a band: `executableNow` compares the derived minimum against `deployableCents`
from `cash_money_entries`, which is a measured figure. The bands exist so a
person can ask *what is waiting one tier up* and get a grouped answer, and so
that an opening rejected today is filed rather than lost.

`reactivated` is derived rather than hooked to the moment money arrives — the
fourth time this repository has needed that distinction. An opening whose
minimum was established months ago becomes executable the instant the balance
crosses it, with nothing having to notice.

---

## Hidden constraints, and the platitudes that have nowhere to go

The brief asks for the opposite of a risk register. *Employees should be paid*,
*customers may not buy*, *quality matters* are baseline business competence, and
reporting them spends the one thing a reader is short of.

`CONSTRAINT_KINDS` holds fourteen entries and **not one of them is an obligation
every business has**. So a baseline observation cannot be filed at all — a
structural separation rather than a filter over prose, whose failure mode is
*missing* a real constraint rather than admitting a platitude. §27 says to fix a
closed list in that direction.

What is worth a row is the constraint that changes the economics and is not
visible from outside: acceptance adds days to a three-day job, the client
forbids offshore sub-subcontracting, one supervisor caps throughput whatever is
hired, the 35% margin is 9% after realistic retakes, nothing is paid until final
acceptance, the labour spread disappears once management is counted.

---

## Seeding

`SEED` is the one node origin **Brain cannot write**. A machine that could seed
its own subjects would be deciding what the economy is — §22's rule that a
worker cannot create its own work, at the table that decides where everything
else looks.

It lives on the Cash surface (`POST /api/projects/:id/cash/industries`) behind
`requirePerson` and `decideProjectAccess` at `ADMIN`, the level every other
membership-shaped decision already carries, and a worker principal is refused
there by type.

**Seeding spends nothing and starts nothing.** It creates a row. The allocator
decides when the subject is asked about, the discovery grant decides whether
that may run, and the evidence gate decides what may be claimed. A seed on a
project with no sprint sits there until somebody starts one.

Retiring is `PATCH` on the same path, and it destroys nothing: the node keeps
its id, its evidence, its children and every round ever run against it. Deleting
would be worse than useless — the same subject would arrive again on the next
expansion as a fresh discovery, and the allowance would be spent learning
something somebody had already decided.

---

## What it is not

It is not a second pipeline. A kernel round creates a **Russell candidate**, and
from there `judgeCandidate` asks the archive first, the compiler writes the
specification, the approval envelope decides whether it may start, the evidence
gate decides what may be claimed, and all three audit roles decide whether it
stands. Nothing here bypasses any of it.

It is not a second lifecycle. Opening a round is new discovery and is behind
`discoveryAllowed`. Absorbing is not: filing what research already found is not
new discovery, the spending happened when it ran, and dropping results because
the sprint wound down would throw away work already paid for.

It forms **no view about what settling a question is worth**. `verdict.ts`
reports cash-now and position-later as two lists of established facts and named
unknowns, never one blended figure — that figure would need a rate of exchange
between *money this week* and *a relationship with a producer*, and nobody has
set one.

---

## Reading it

```
npm run report:cash -- --project <id>
```

prints the map, each subject's verdict with the rows behind it, what Brain would
ask next and why, and every decomposed opening's minimum owner capital against
the money that actually exists. `GET /api/projects/:id/cash/industries` is the
same projection for any project member.
