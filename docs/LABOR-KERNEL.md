# The human comparative-advantage and labor allocation kernel

Brain knows what it wants to produce and has never held a row saying **who or
what produces it**.

The nearest thing was `cash_opportunities.fulfillment_owner`: one free-text line
per opening — *"Name the operator, contractor or tool that fulfils this"* —
answered by whoever filled the card in, with no vocabulary, no test, no blocker
and no way to ask the question across a portfolio. So *which of the things we do
still need a person, and why* had no answer, and neither did *which of them has
stopped needing one*.

§38's kernel added the axis that says **where** to look. This one adds the axis
that says **by whom the work is done**. It lives in `server/services/labor/`,
`server/repos/labor.ts` and `server/domain/labor.ts`, and everything it adds is
a new **entrance** to machinery Steps 4 to 12C already built.

---

## The four rules

### 1. The default is a burden of proof, not an assumption

The brief's prime directive is that Brain is the production layer and human
labor is an escalation layer. Read as a licence to assume, that sentence is a
disaster: a task moved to Brain on a hunch is an output nobody produces, or one
produced without the licence, signature or physical presence somebody is legally
owed. Read as a burden of proof, it is exactly right — nothing stays with a
person because it always has, and every human role has to name which of six
reasons justifies it.

So the asymmetry is in the schema rather than in a paragraph. A human layer
cannot be recorded without a reason:

```sql
CHECK ((production_layer IN ('BRAIN', 'SOFTWARE_TOOL', 'EXTERNAL_SERVICE'))
       = (necessity_reason IS NULL))
```

and Brain refuses to record `BRAIN` for itself unless the necessity test is
actually settled. On `NOT_ESTABLISHED` — which is most tasks, most of the time —
it writes nothing at all, and the task reads as undecided, because that is what
it is.

### 2. An unknown is never a favourable assumption, and the favourable direction here is *towards Brain*

§30 and §38 both record this rule at a money figure, where the cheap-looking
answer understates a cost. Here the cheap-looking answer is *Brain can do it*,
and the cost of being wrong is not symmetrical with the other direction.

`labor_necessity_answers.answer` has a literal `UNKNOWN`, which is a real
recorded answer — *we looked and nothing settles it* — and a different fact from
the absence of a row. Neither may stand in for the answer that would move a task
to Brain, and neither may be the reason a person is kept either. It is a task,
and `necessity.ts` says which one.

### 3. What can be derived is not stored

There is no automation percentage, no compression score, no "how close is Brain"
number and no current-layer column on the task. Every one of them is a fact about
rows that change underneath it — `tier.ts`'s argument and `placements`' before
it: a row is not a decision.

`labor_necessity_answers.basis` has **no `DERIVED` value**, and that is the rule
made structural. Two of the brief's twelve questions Brain answers from its own
rows — *can Brain produce this output* (`readCapability`) and *could another
session verify it* (`separationCapacity`, the same reading `auditAdmission`
uses) — and there is nowhere to write either down. A fleet that lost its last
healthy surface an hour ago must not still be reported as able to produce.

### 4. A role is compressed by history, so history is never overwritten

§7 of the brief is the reason this is a kernel rather than a column: *where Brain
improvements have reduced human workload* is unanswerable from current state,
because current state is exactly what forgot.

Both decision tables are append-only with a superseding pointer, so what was
believed when a decision was made is still there when the decision is questioned.
`roleCompression` reads the chain, and reports the direction — a task that went
*back* to a person is the single most useful row in that table, so it is
reported rather than filtered out.

---

## The twelve questions, and where each one lives

| # | Question | Where it lives |
|---|---|---|
| 1 | What exact output is this producing? | `labor_tasks.output`, `NOT NULL` |
| 2 | Can Brain currently produce it? | derived, `readCapability` |
| 3 | Faster? | `labor_necessity_answers` |
| 4 | Cheaper? | `labor_necessity_answers` |
| 5 | At equal or higher quality? | `labor_necessity_answers` |
| 6 | Can Brain verify its own output? | `labor_necessity_answers` |
| 7 | Can another agent verify it? | derived, `separationCapacity` |
| 8 | Physical presence required? | `labor_necessity_answers` |
| 9 | Licence, signature, accountable review? | `labor_necessity_answers` |
| 10 | Does the interaction itself add value? | `labor_necessity_answers` |
| 11 | Exceptions only, or normal production? | `labor_necessity_answers` |
| 12 | What prevents Brain absorbing this? | derived, `blockersFor` |

Question 1 is `NOT NULL` because every other question is about that output: a
task whose output nobody can state cannot be assessed at all, which is why the
brief asks it first.

Question 12 is derived rather than recorded, which is what makes it a
**diagnosis** instead of a second place to hold an opinion. A blocker clears
itself the moment the thing it names stops being true, and that is what makes
the automation frontier a live reading rather than a list somebody has to
remember to revisit.

### What settles the verdict, and what does not

`BRAIN_DEFENSIBLE` needs every *gating* question answered in the permitting
direction from a recorded answer: Brain can produce it, quality is at least
equal, and none of physical presence, licensing or human interaction is
established. Verification is a **disjunction** — Brain can check itself *or* a
second session can — because that is what the brief asks, and demanding both
would refuse work it permits.

Speed and cost are deliberately **not** gating. They decide what is *worth*
doing rather than what is *permitted*, and the brief is explicit that the
objective is not to maximize automation for its own sake. They are reported
beside the verdict as `advantage`.

`HUMAN_REQUIRED` needs one of three reasons *established*, never assumed. The
other three — `EXPERT_JUDGMENT`, `EXCEPTION_HANDLING`, `OVERSIGHT_VERIFICATION`
— are statements about this operation's confidence in its own Brain, and no
published source about an industry can settle one. A trade body can tell you a
notary must sign; it cannot tell you whether your Brain verifies its own output
well enough. A finding declaring one of them is recorded as evidence on its
claim and moves nothing, which is a refusal rather than a gap.

---

## Where a workflow comes from

Two origins, and there is deliberately no third.

**`SEED`** is a person naming one. §2 of the brief — *if this business were
invented today with Brain available from its first day, how would it operate?* —
is a design act, and no amount of reading rows answers it. A Brain that
decomposed a business out of a sentence somebody wrote would be §8's model prose
deciding what exists, at the table that decides who gets paid.

**`DERIVED`** reads exactly one thing: an opening's own `required_capabilities`.
That column already says what delivering it needs, `readCapability` already
answers whether Brain has each one, and `operate.ts` already raises a need from
it — so each entry is a unit of production that has been *declared* rather than
inferred. Nothing parses a delivery method, splits a sentence or invents a step.

That second entrance is what stops this being §29's *mechanism nothing calls*. A
labor kernel that waited for somebody to type in a workflow would have been
correct, tested, and reachable by nobody. Deriving from the portfolio that
already exists means it has something to say on the first tick after it is
deployed.

It never un-derives. A capability removed from an opening leaves its task exactly
where it is, with every decision recorded against it; retiring is a person's.

---

## What it asks

Three purposes, each its own kind of round in `labor_rounds`.

**`NECESSITY`** — what published rules say about who may produce this: a licence,
certification, registration, signature or accountable review required by a
statute, a regulator, a buyer's terms or a platform's terms; whether any part
must be performed in person; whether the interaction itself is part of what is
bought.

**`MARKET`** — §4. Once a person is established as necessary, where that
capability is actually obtained: which channels, in which jurisdictions, at which
published rates, on what basis each rate is quoted.

**`PRECEDENT`** — whether this work is published anywhere as being done by
software rather than by a person, and what those sources say about how the output
was checked.

All three run under one envelope, `RUSSELL_LABOR_ALLOCATION_V1`, with one
compiler profile. It takes its source classes and its forbidden actions
**verbatim** from the discovery envelope, so the four cannot drift into
authorizing different things — and worth saying plainly because the subject
sounds like hiring: nothing here approaches a contractor, answers a job posting,
requests a quote, opens a marketplace account or engages anybody.
`CASH_FORBIDDEN_ACTIONS` names `hire`, `engage a contractor` and `contact the`
explicitly, and the assignment template lists them as out of scope so a worker is
*told* rather than merely refused.

### An established absence is the most valuable finding here

The `permission` lane asks for a negative as well as a positive, and says so. A
claim that no licensing rule exists is established by a documented search of the
places it would be, or not at all — §14's own standard — and the *absence* of
such a rule is exactly the fact that lets a role be compressed. A completion
standard that only asked for requirements would have made a barren search look
like a failure.

---

## How it decides what to ask next

`services/labor/allocate.ts` is a **pure function over a recorded snapshot**,
kept apart from the reads for `services/dispatch/router.ts`' reason: *why did
Brain research that* has to be answerable afterwards from an input rather than
from a re-run. Being pure also makes it useless as a safety mechanism, which is
the same split the dispatcher draws — the exclusion is the unique index on
`labor_rounds`.

Five rules in a fixed order. **No weighted score anywhere.**

| Rank | Rule |
|---|---|
| 100 | A person is producing this and nothing has established that they must |
| 200 | A person is established as necessary and nobody has asked where one is sourced |
| 300 | Neither case is established and the question has never been asked |
| 400 | Brain is held back by something a published precedent could move |
| 500 | Re-ask what has gone quiet, past its cool-off |

Rule 1 leads, and that is the opposite of the obvious order. **The most valuable
question is about work a person is doing today**, not about work nobody is doing
at all: that is where a role can actually be compressed and where money is
already going out. Its `verdict !== 'HUMAN_REQUIRED'` clause is load-bearing and
the first version did not have it — a role whose reason is already established
has no open question, and asking again both spends a slot to learn what the rows
say and takes the slot ahead of rule 2, which is the question that actually
follows. The suite found it by asserting the *sequence* rather than the first
ask.

Rule 4 fires only where the blocker is one a precedent bears on. A task blocked
on a licence is not helped by somebody else having automated something.

### It stops

- A task with a live round of a purpose is not asked that question twice.
- A settled round waits out `ROUND_COOL_OFF_MS`.
- A purpose asked `BARREN_ROUNDS` times that has found nothing is not asked
  again — not because looking is forbidden, but because Brain has documented
  that there is nothing published there, and §13's rule about the archive
  applies to Brain's own history.

`MAX_OPEN_LABOR_ROUNDS` is **concurrency, not a quota**. §24 removed exactly that
kind of number from the standing authority and recorded why. It is deliberately
smaller than the industry kernel's: a labor question is the newest and least
proven of the three things that can spend a fleet slot, and the honest place for
something unproven is behind the things that are not.

### What bounds it, and what deliberately does not

The standing research authority bounds it, because that is what authorizes
spending anything, and it is asked **in the kernel** rather than left to
`launch`. That is the difference between parking and stranding: a candidate that
parks for want of authority launches no mission, its round never settles, and an
open round is precisely what stops that purpose being asked again — for ever.

A cash sprint winding down does **not** bound it. A labor question asks how work
Brain has already committed to is actually produced; it finds no opening and
creates no obligation. §30 records its own correction on this exact point — an
off switch that stopped work it did not own reached past the thing it owns.

---

## What it surfaces

§13's six readings, all derived, in the order the brief asks for them:

- **Human dependencies** — what people do here and why, with what actually
  backs each role in **three** values rather than two: `RESEARCH` is a gated
  claim, `PERSON` is somebody answering the necessity question themselves, and
  `ASSERTED` is neither — the allocation names a reason and nothing answers the
  question behind it. The weakest lead, because those are the roles §7 asks
  Brain to keep re-examining.

  It was a boolean read off the verdict, and the report printed it as
  *"established by a published source"* — false whenever a person answered the
  question themselves, which is most of them on a new map. The verdict says the
  *test* settled it, never that a source did. Driving the report is what showed
  it, on the very first row it printed.
- **Automation frontier** — ordered by how many blockers are left, so a task with
  none is ready to move now and leads.
- **Bottlenecks** — blockers grouped by kind, with the count each one holds. A
  group names a capability only when every task in it names the same one:
  naming one of two would send somebody to fix half a problem believing they had
  fixed it.
- **Human capacity needs** — a necessary person with no published sourcing
  option on record, and tasks nobody has decided at all.
- **Role compression** — read from the allocation chain, both directions.
- **Workflow economics** — per workflow, how many tasks are on a person, how many
  are not, and **how many nobody has decided**, counted apart from both. A
  workflow with two Brain tasks and eight nobody has looked at is not eighty per
  cent automated.

### Every figure is counted or it is UNKNOWN

§11 asks for cost per output, time per output, error rate and human hours. Brain
holds rows for none of them, so all four report `UNKNOWN` and name what would
measure them. That is invariant 33, and the temptation is worse here than usual:
an invented automation percentage is exactly the figure somebody would quote in a
decision about whether to keep employing a person.

The figures that *are* counted name their denominator, which is **tasks that have
an allocation at all** — not units of work, not hours, not revenue. §29 records
why: eight is not a quantity until you know eight of what.

---

## What it is not

It is not a second pipeline. A labor round creates a **Russell candidate**, and
from there `judgeCandidate` asks the archive first, the compiler writes the
specification, the approval envelope decides whether it may start, the evidence
gate decides what may be claimed, and all three audit roles decide whether it
stands.

It is not a hiring system, and nothing in it can become one. It records no
person's name, holds no contact detail, and its envelope forbids approaching
anybody by name. Recording that a person produces a task engages nobody: Brain
contacts, quotes for and hires exactly as many people as it did before, which is
none. Every one of those is a `COMMERCIAL_ACTION` a person grants separately.

It forms **no view about what a role is worth**. `advantage` reports whether
Brain is established to be both faster and cheaper, from recorded answers, and
there is no blended figure and no ranking of people.

**There is no client surface**, and that is a scope statement rather than an
omission. §38's kernel shipped the same way — a route and an operator report —
and §29's product surface has its own acceptance. The reading is
`GET /api/projects/:id/labor` for any project member, and:

```
npm run report:labor -- --project <id>
```

prints the six readings, the measurements with their evidence class, what Brain
would ask next and why, and every published sourcing option beside its rate.

---

## Two defects found by running it rather than by reading it

Both are recorded here rather than quietly fixed, and both are the same shape:
correct-looking code whose *sentence about the rows* was wrong.

**The report said "established by a published source" about an answer a person
had typed.** `established` was a boolean read off `verdict ===
'HUMAN_REQUIRED'`, which says the test settled it and says nothing about what
settled it. It is `backing` now, in three values. Found on the first row the
report ever printed.

**The allocation chain was ordered by `created_at`, and two decisions in one
millisecond sort arbitrarily.** `roleCompression` reads that order to decide
whether a role was compressed or escalated, so half the time it reported that a
person had been replaced by Brain when the opposite had happened. §33 records
the identical defect one module along — ISO-8601 to the millisecond, with the
tie falling through to a generated id.

It is followed along `supersedes_id` now, which the schema makes exact:
`supersedes_id` is UNIQUE where present, so every allocation has at most one
successor. The regression test was measured against the old implementation
before it was trusted — it failed **3 times in 8** while it equalized the
timestamps, which is a test that lets the defect back in half the time, so it
puts the clock *backwards* instead and now fails on every run.

## What is true of this kernel today, said plainly

The schema, the vocabulary, the validator, the necessity test, the allocator, the
absorption, the envelope, the profile, the routes and the tick are all built and
covered on both backends. `tests/laborKernel.test.ts` walks the refusals rather
than the successes, because the expensive mistake here is an acceptance.

**No fleet worker has answered a labor question**, because that needs a deploy
and a fire. Until one has, the engine passing its tests says nothing about the
research — the separation Step 3 drew between the research engine and a real job
having actually run, and §38 had to say the same thing about the industry kernel
on the day it landed.

**No production task has been allocated.** The derivation runs on qualified
openings that declare capabilities; what it produces on this Brain's portfolio
will be whatever those rows actually say, and the honest answer until the tick
has run against them is that nobody knows.
