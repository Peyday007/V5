# The manufacturing empire kernel

**What it is.** A second graph beside the industry map (§38), answering a
question containment cannot hold: *which machine should be built next, and what
does building it make possible that was not possible before?*

**What it is not.** It is not a plan to build anything. Every question it asks
is a question about published sources; every row it writes is either a gated
research claim's consequence or a decision a person recorded. There is no route
through this kernel to buying, tooling, certifying, contacting or producing
anything, and there must never be one.

---

## Why a second graph rather than a wider first one

`industry_nodes` has exactly one parent per row, and that parent means
*containment*. That is the right shape for an economy and the wrong shape for a
company, for two reasons.

**A capability is not inside an industry.** It is a property of a firm —
something an organisation can do. There is no node kind that could hold it
without making the industry graph a place to put everything, at which point
"what is underneath animation" stops having an answer.

**A capability chain is not a tree.** "Pressure washers lead to motorcycles" is
not a claim that motorcycles are inside pressure washers. It is two claims about
a third thing: producing pressure washers *develops* small-engine integration,
and producing motorcycles *requires* it. Several categories can teach one
capability and several can require it, so it is an edge table — and a tree that
pretended to hold it would make the sequence look decided, when the brief's
whole optimization rule is that it is not.

---

## The rule the whole kernel rests on

> **A capability a product teaches is never a capability this company holds.**

Research can establish that producing motorcycles requires chassis engineering,
and that producing ATVs develops it. Nothing research establishes may say this
company *has* either. If those two facts ever collapse into one, a well-sourced
packet about what motorcycle production teaches becomes, three joins later,
evidence that this company can build motorcycles — and the readings that decide
what to build next are all downstream of it.

It is enforced by the shape of the code rather than by a rule anybody follows:

- `capabilities.held_at` is written by exactly one function,
  `declareCapabilityHeld`, which demands an actor and an evidence kind.
- `services/manufacturing/expand.ts` — the module that files research — does not
  import it. There is no parameter, no branch and no value of
  `capability_finding` that reaches it. `tests/manufacturingKernel.test.ts` reads
  the source and asserts the absence, because what must not exist is not
  something a behavioural test can see.
- `held_evidence` has exactly one value, `DECLARED`, and in particular there is
  no `RESEARCHED`.

**One value and not two, recorded because it is a deliberate narrowing.** The
obvious second was a holding derived from work this project actually got paid
for. It is absent because nothing in this Brain could produce it: Cash Mode
delivers services and the Software Factory delivers code, and neither is
evidence that this company can build a machine. A value nothing could ever write
would be the *mechanism nothing calls* this repository keeps correcting, wearing
an enum. A second genuine source is an additive migration somebody reviews,
which is where "could this be faked?" gets asked.

---

## The brief's core principle, as rows rather than as a prompt

> DO NOT manufacture products merely because we want to manufacture them.
> Identify and understand existing demand. Capture or gain meaningful access to
> distribution flow. […] THEN manufacture.

That cannot be enforced by writing it into an assignment. It is enforced by what
`services/manufacturing/readiness.ts` is *able to derive*. A category reads
`ENTER` only when all four of these are `MET`:

| condition | met by |
|---|---|
| `DEMAND_ESTABLISHED` | at least one dated, published observation that somebody is buying |
| `ROUTE_TO_BUYER_ESTABLISHED` | at least one published route by which product reaches whoever pays |
| `REQUIREMENTS_KNOWN` | at least one capability established as needed to produce here |
| `CAPABILITIES_HELD` | every established requirement recorded as held |

Each answers `MET`, `NOT_MET` or `UNKNOWN`, and **`UNKNOWN` is never `MET`**
(invariant 39). *Nobody has looked* and *we looked and it is not there* are two
facts with two remedies, and collapsing them here would mean telling somebody a
category is enterable when nobody has established that anyone is buying.

### The one that could be got subtly wrong

`CAPABILITIES_HELD` is "every capability this category requires is held", and
the tempting implementation is `requires.every(held)` — which is **true of the
empty set**. A category nobody has asked what it takes to build would then
report that this company already has everything it needs. So holding reads
`UNKNOWN` until `REQUIREMENTS_KNOWN` is `MET`: you cannot have established that
you hold all of a set nobody has established.

### Verdicts

`RETIRED` · `UNEXAMINED` · `INVESTIGATING` · `NO_DEMAND_FOUND` ·
`NO_ROUTE_FOUND` · `BUILD_CAPABILITY_FIRST` · `ENTER`

`NO_ROUTE_FOUND` is its own verdict rather than folded into `NO_DEMAND_FOUND`,
because the brief names distribution as its own step and the two have different
remedies: *nobody is buying* is answered by looking elsewhere, *nobody has
established how it gets to them* by asking again. It used to fall through to
`INVESTIGATING`, which said the category was still being researched while its
demand round had settled — a status contradicting the rows underneath it.

All derived, none stored. The brief says *"continuously calculate the strongest
next expansion"*; a stored ordering is the rigid roadmap it refuses, and a
derived one moves the day an acquisition, a breakthrough or one piece of
evidence changes what is reachable.

`BUILD_CAPABILITY_FIRST` is the interesting one: buyers and a route are
established, and what it takes to build is not held. Its reading names the
missing capabilities and, for each, **which categories already on the ladder are
established to develop it**. That is the brief's capability chain, as a query
rather than a diagram.

---

## The tables

| table | holds | written by |
|---|---|---|
| `manufacturing_programs` | one programme per project: the objective, the state | a person |
| `machine_categories` | the ladder. `parent_id` is containment only | a gated claim, or a person seeding |
| `capabilities` | the ledger. `held_*` is the company's own | research creates; **only a person holds** |
| `capability_edges` | `REQUIRES` / `TEACHES` between a category and a capability | a gated claim |
| `category_evidence` | demand, route, incumbent weakness, entry barrier, bought-in component | a gated claim |
| `manufacturing_rounds` | what has been asked about which category | the allocator |

Plus three columns on `research_claims`: `capability_finding`,
`capability_subject`, `capability_observed_on`.

**A third column rather than more values in `structural_finding`.** §38 warned
against splitting *one* question across several columns; this is a different
question. `opportunity_signal` answers *what kind of opening is this*;
`structural_finding` answers *what does this establish about how an industry
works*; `capability_finding` answers *what does this establish about what
building a machine takes and teaches*. One claim can legitimately carry all
three, and most carry none.

### What is deliberately not stored

No readiness column, no entry verdict, no capability count, no sequence
position, no score. Every one is a fact about rows that move underneath it.
Three things *are* stored because no derivation could recover them: that a
person seeded a category, that a person retired one, and that this company holds
a capability. All three are decisions, and decisions are exactly what cannot be
re-derived from evidence.

---

## The nine findings

A finding's kind decides which table it lands in, by a **lookup rather than a
reading**. Nothing inspects a sentence.

| finding | subject | creates |
|---|---|---|
| `PRODUCT_CATEGORY` | the class's own name | a category |
| `ADJACENT_CATEGORY` | the class's own name | a category |
| `CAPABILITY_REQUIRED` | the capability's name | a capability + `REQUIRES` edge |
| `CAPABILITY_TAUGHT` | the capability's name | a capability + `TEACHES` edge |
| `DEMAND_EVIDENCE` | one of `DEMAND_SIGNAL_KINDS` | evidence — **and requires a date** |
| `DISTRIBUTION_CHANNEL` | one of `DISTRIBUTION_CHANNEL_KINDS` | evidence |
| `INCUMBENT_WEAKNESS` | one of `INCUMBENT_WEAKNESS_KINDS` | evidence |
| `ENTRY_BARRIER` | one of `ENTRY_BARRIER_KINDS` | evidence |
| `BOUGHT_IN_COMPONENT` | the component's own name | evidence |

Validated by **one function called at both doors** —
`services/research/schema.ts` for a provider pass and `mcp/researchTools.ts` for
a worker submission. A rule applied by one of two readers is worse than none,
and this repository has had to record that five times.

Every failure **refuses the submission** rather than dropping the field. §27:
truncation and silent dropping are the outcomes a worker cannot recover from,
because they are reported as success.

**A demand signal with no observation date is refused.** §30 settled this one
table along: an undated buying signal cannot be told apart from one somebody
remembers from years ago, and it is the column that decides whether a category
may be entered.

**`ENTRY_BARRIER` is kept apart from `CAPITAL_REQUIREMENT`.** The first answers
*what must exist at all*; the second answers *what needs owner money*. A
certification nobody can buy their way past is not a capital requirement, and
filing it as one would make an unreachable category look merely expensive.

### Capability identity

`capabilitySlug` lowercases and collapses runs of non-alphanumerics to a dash.
"Chassis Engineering" and "chassis engineering" are one capability. "chassis
engineering" and "frame design" are **two**, and that is a known, deliberate
limit rather than an oversight: joining them needs a reader deciding two phrases
mean one thing (§24's `SEMANTIC_MERGE_FLOOR`), and a guess would silently weld
together two capability chains that are not the same chain.

---

## What the allocator asks, and in what order

`services/manufacturing/allocate.ts` is a **pure function over a recorded
snapshot**, for `services/dispatch/router.ts`' reason: "why did Brain research
that" has to be answerable from an input rather than from a re-run against a
database that has moved. Being pure makes it useless as a safety mechanism,
which is the same split the dispatcher draws — the exclusion is the unique index
on `manufacturing_rounds`.

Lexicographic over rules, never a weighted score. A score needs weights, weights
are a judgement nobody made, and the number then reads like a measurement.

0. **`BOOTSTRAP`** — while the ladder is empty, ask what classes of machine the
   sources recognise.
1. **`CAPABILITY`, for a category with buyers and a route and no requirements
   established** — finish what has already been spent.
2. **`DEMAND`, for a category nobody has asked about** — the core principle as an
   ordering. Every other answer about a category is worth nothing until somebody
   is established to be buying.
3. **`CAPABILITY`, for a category with published buyers.**
4. **`INTEGRATION`** — what producers buy in rather than make.
5. **`MAP`** — widen the ladder where something was found.
6. **`DEMAND` again**, past the cool-off, because shipments and tenders are
   published continuously.

**What a round `found` is derived from its claims, never tallied from what a
pass wrote.** Tallying is correct only while every pass that absorbs a round
also closes it; a tick that dies in between leaves the claims filed and the
round `OPEN`, so the next pass writes nothing (every insert conflicts) and would
record a round that established five things as having established none. `found`
is what barrenness is decided against, so the category would then be declined as
one nobody should look at again.

**It stops.** One live round per purpose per category; a cool-off on a settled
round; and a category asked the demand question `BARREN_ROUNDS` times with
nothing coming back is not asked again — Brain has now documented that nothing is
there, and §13's rule about the archive applies to Brain's own history. What is
*not* a bound is a lifetime quota (§24): what bounds this is how many questions
may be open at once, which is real.

One question per category per pass, so a category qualifying under three rules
cannot take every slot.

---

## It is an entrance, not a pipeline

Nothing in this kernel researches anything. A round creates a **Russell
candidate**, and the path that already exists does all of it: `judgeCandidate`
asks the archive first (§13), the compiler writes the specification, the
approval envelope decides whether it may start, the evidence gate decides what
may be claimed, and all three audit roles decide whether it stands.

Three envelopes, three profiles, chosen by the round's purpose:

| purpose | envelope | profile |
|---|---|---|
| `BOOTSTRAP`, `MAP` | `RUSSELL_MACHINE_LADDER_V1` | `MACHINE_LADDER` |
| `DEMAND` | `RUSSELL_MACHINE_DEMAND_V1` | `MACHINE_DEMAND` |
| `CAPABILITY`, `INTEGRATION` | `RUSSELL_MACHINE_CAPABILITY_V1` | `MACHINE_CAPABILITY` |

**Three rather than one**, because `planFitsEnvelope` pins one assignment
template per envelope and the three questions have three completion standards.
Judging "who is buying" against "what does producing require" would be the
Westbrook defect (§25) at a compiler: a worker answers the question correctly and
Brain judges it by the wrong standard.

All three take their source classes and their forbidden actions **verbatim from
the cash discovery constants**, so a class or prohibition added there reaches
these without anybody remembering. They authorize reading published sources and
nothing else.

`MACHINE_DEMAND`'s failure conditions are the half that matters: *nothing
published establishes that anybody is buying* has to be a **returnable answer**
rather than an incomplete one, because it is the finding that stops a category
being pursued — and a profile that treated it as a gap would push a worker
towards producing an estimate instead.

---

## Why it is not a Cash Mode sprint

§30 says Cash Mode is a temporary section meant to be wound down after a month
or two, and invariant 40 says a temporary section's off switch must never stop
work it does not own. This kernel's horizon is the opposite: it is the question
sprints run underneath. Hanging it off `cash_modes` would mean winding one sprint
down silently ended a programme nobody had decided to end — and it would have
looked like it worked.

So `manufacturing_programs` is its own row with its own lifecycle. A project may
run either section, both or neither.

**Pressing Start *is* the authorization** (§33's repair, one section along). A
person deciding to run a programme has decided Brain may read published sources
about it; asking them to then fill in a research grant is asking twice for one
decision, and the second ask is the one that goes unanswered.
`ensureProgrammeAuthority` writes `Manufacturing programme research`:
`RESEARCH` only, `max_external_spend` a literal zero, `ALWAYS_PROHIBITED` unioned
in by the repository, one live grant per project enforced by a partial unique
index.

| state | new questions | absorbing results | the grant |
|---|---|---|---|
| `ACTIVE` | yes | yes | live |
| `PAUSED` | no | **yes** | live |
| `ARCHIVED` | no | no | revoked |

`PAUSED` keeps absorbing deliberately: filing what research already found is not
new discovery — the spending happened when it ran — and dropping results because
somebody paused would throw away work already paid for.

---

## Where the doors are

**Routes**, at `/api/projects/:id/manufacturing`, behind `requirePerson` and
`decideProjectAccess`. Reads take the default `READ`, so every project member can
see the ladder, what is missing and where Brain is looking. **Every write is
`ADMIN`** — a wider sweep than the two sections above, and deliberate: the four
writes are starting a programme, moving its lifecycle, naming a category, and
recording that this company holds a capability. That last one is why the line is
drawn there rather than at `WRITE`.

No entry names a worker scope, so a machine is refused by level at every write
and by principal *type* at every route including the reads. Two independent
guards, because a guard on one entrance is not a guard. **There is no
manufacturing policy module and there must never be one.**

**A terminal**, `npm run manufacturing -- <command>`, calling exactly what the
routes call — and `.github/workflows/manufacturing.yml` dispatches that same
script inside the deployed container, so the programme is operable in
production without a laptop. It adds convenience and not privilege: anyone who
can dispatch it can already dispatch `deploy.yml`, and the command is passed
through to the same closed surface, which cannot build, buy, tool or enter
anything and cannot mark a capability held without a person naming one and
saying how it came to be true. §26's rule: reaching the shell is the authentication, and
`--admin <email>` is *attribution* resolved against `users` — §23's distinction,
which establishes that such a person exists and nothing about who typed the
command.

**The Russell surface** is `/machines` — secondary in the rail for Cash's
reason read the other way round: Cash is secondary because it is temporary, this
is secondary because its horizon is decades and nobody steers it hourly.

It shows the programme's state, every category with its verdict and the exact
reason, all four conditions, demand and route evidence, required against held
capabilities side by side, the chain and what each capability unlocks, the
running round, the next question with the allocator's recorded reason, the
declarations Brain could not file, every round including barren ones, and the
decisions genuinely waiting on a person.

**Every string on it is the server's.** The screen re-derives no status, re-orders
no ladder and composes no explanation. And it adds no back door: there is no
control that marks a capability held from what research established, and the one
control that records a holding appears only against a decision the service
itself raised.

---

## What is true today

The kernel operates end to end against both backends: a programme started, the
opening question opened by the allocator, categories filed from gated claims,
demand and capability rounds, the chain derived across two categories, a person
recording a holding, and the verdict moving to `ENTER` and back when that
holding is withdrawn.

**No fleet worker has answered a manufacturing question in production**, because
that needs a deploy and a fire. Until one has, the engine passing its tests says
nothing about the research — which is the separation Step 3 drew between the
research engine passing its tests and a real job having actually run.

**Nothing has been built, bought, tooled or entered**, and nothing in this
kernel can do any of those. It reads published sources and records what a person
decides.
