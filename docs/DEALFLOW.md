# The cross-border industrial dealflow kernel

A complete operating loop for discovering, qualifying and structuring
cross-border industrial equipment transactions — and for learning from every
attempt at one.

It is an **entrance** to machinery Steps 4 to 12C already built. Nothing here
researches, schedules, audits or executes anything: a question is a Russell
candidate, the compiler writes the specification, the approval envelope decides
whether it may start, the evidence gate decides what may be claimed, all three
audit roles decide whether it stands, and a deal that becomes real is pursued by
Cash Mode's own execution path. There is no second orchestration universe here
and no second lifecycle.

---

## 1. Why a cash opportunity could not express this

`cash_opportunities` is one-sided by construction, and correctly so: it holds a
payer, a price, an offer and an exposure, which is the right shape for work
somebody commissions.

It cannot say that a mine in Zambia has published a fleet expansion, that a
manufacturer in Shandong builds the trailers, that the trailer is unregistrable
there without an approval neither party has mentioned, that the duty is nineteen
per cent, or that the money in it is a commission rather than the
quarter-million-dollar asset.

Those are five different tables of fact about one transaction, and a single card
with a `price` field flattens them into a number that is wrong.

**A deal has two sides, and everything hard about it lives between them.** That
is the axis this kernel adds.

---

## 2. The seed is an example, not the taxonomy

The operator's brief starts from Chinese manufacturers selling tankers and
trailers into African, European, Middle Eastern and Latin American industrial
buyers. It is explicit that this is *the first example from which the kernel
should learn the broader structure*, not the business.

So there is **no list of equipment classes anywhere in this kernel**, and
`tests/dealflowKernel.test.ts` reads the repository to prove it — the same thing
`operatorConsoleRemoved` does, for the same reason: what must not exist is not
something a behavioural test can see. The check strips comments first, because
the rule is that no *code* names a class; prose examples are how this repository
documents, and the seed question names tankers deliberately.

A class exists because a claim that cleared the evidence gate named it. The set
of classes is the distinct set of keys across the party, requirement and cost
rows.

### How classes converge

`equipmentKey` is deliberately the weakest matcher that could work — case and
whitespace, nothing else. It does not stem, strip plurals or drop adjectives.
§37 settled why: *a matcher that tried harder produces confident wrong answers,
and missing a match costs a reading while inventing one tells somebody a thing
exists.* Here an invented match pairs a buyer with a supplier that cannot build
what they need, and every row around it reads healthy.

What makes the classes converge instead is that **Brain supplies the
vocabulary**: a supply question carries the class verbatim from Brain's own rows
and asks for it back unchanged. That is a convergence mechanism somebody can
read, rather than a similarity threshold nobody can audit.

---

## 3. The declaration on the claim

A third axis on `research_claims`, beside `opportunity_signal` (what kind of
opening this is) and `structural_finding` (how an industry is put together).
They are three columns rather than one because they answer three different
questions about one claim, and a column with two masters is invariant 31.

Seven findings:

| Finding | Lands in | Requires |
| --- | --- | --- |
| `BUYER_NEED` | `deal_parties` (BUYER) | subject, equipment |
| `SUPPLIER_CAPABILITY` | `deal_parties` (SUPPLIER) | subject, equipment |
| `DECISION_MAKER` | a column on the round's own party | subject, no equipment |
| `COMPLIANCE_REQUIREMENT` | `deal_requirements` (REQUIRED) | layer, market, equipment |
| `REQUIREMENT_ABSENCE` | `deal_requirements` (NONE_FOUND) | layer, market, equipment, **a documented search** |
| `COST_COMPONENT` | `deal_costs` | component, figure, currency, basis, equipment |
| `COMMERCIAL_PRECEDENT` | `deal_structure_evidence` | structure, equipment |

`validateDealFinding` in `server/domain/dealflow.ts` is the one validator, and
**both submission doors call it** — the MCP tool and the provider-path parser. A
second copy of the rule is how the two doors come to disagree, which this
repository has had to record five times.

Every field is **declared in the tool schema**, not merely described in its
prose. §33 records what the alternative cost: `opportunity_signal` was named in
a tool's description and left out of its schema, `additionalProperties: false`
meant a client honouring the schema dropped it, and the one column that decided
whether any opportunity was ever created could never be filled — a failure that
reads exactly like a worker honestly finding nothing.

### A jurisdiction is a column, never a sentence

§25's Westbrook defect is a compiler reading a state out of prose and producing
*"official Michigan public records … in Westbrook, OH"* with every row around it
healthy. Cross-border trade is (product × jurisdiction) keyed from end to end —
the same trailer is legal in one market and unregistrable in the next — so the
market travels as its own declared field.

---

## 4. The compliance envelope

Five layers, and they do not collapse:

- `FACTORY_CERTIFICATION` — what the plant must hold
- `PRODUCT_CERTIFICATION` — what this product must hold
- `MARKET_APPROVAL` — what the state demands before registration or use
- `BUYER_ACCEPTANCE` — what this buyer demands beyond the law
- `IMPORT_BARRIER` — what stands in the way of importing at all

ISO 9001 at a factory does not prove a tanker may be registered in the
destination market; a market approval does not prove the buyer will accept it.
A query that wants "can this be sold there" must ask all five, and
`envelopeFor` refuses to compose them into a single yes.

### NOT_ESTABLISHED is not NONE_REQUIRED

§30's rule — an unknown is never a favourable assumption — is at its sharpest
here, because **the absence of requirement rows looks exactly like the absence
of requirements**. A layer nobody researched has no rows; a layer somebody
researched and found empty also has no rows, unless the schema gives that second
fact somewhere to live.

It does. `REQUIREMENT_ABSENCE` writes a row with posture `NONE_FOUND`, and the
validator refuses one that does not name where the worker looked — §14's rule
that a claim of non-existence is established by a documented search or not at
all. So a layer with no rows is `NOT_ESTABLISHED`, which is a **task**, and a
layer with a NONE_FOUND row is `NONE_REQUIRED`, which is an **answer**.

Requirements are keyed by (destination, class, layer) and never by deal, because
that is what a requirement is actually about: the same approval applies to every
unit of that class entering that market, so binding it to one deal would make
Brain research it again for the next — §13's waste at the most expensive
question in the trade.

---

## 5. The landed cost, and what is withheld

One row per published figure, never a total. The total is derived, and it is
**withheld** when a load-bearing component has no row. A landed cost that
silently skips the duty line is wrong by nineteen per cent in the direction that
makes the deal look worth doing, and nobody checks a number that flatters them.

Load-bearing: factory price, ocean freight, import duty, customs clearance,
inland destination. Inspection, certification and financing are deliberately not
— they are real and small relative to the asset, so their absence degrades the
estimate without inverting it, and requiring them would withhold every total
this kernel could produce.

Three reasons a total is withheld, all named rather than silent:

- `MISSING_LOAD_BEARING` — and it says which lines
- `MIXED_CURRENCY` — converting would put a rate nobody published inside a
  number presented as published arithmetic
- `MIXED_BASIS` — reconciling a per-container rate with a per-unit price needs
  a load plan Brain does not have, and assuming one would be inventing it

### Which end of the lane a figure belongs to

A worker declares one market per claim, and for a cost line the market that
field names depends entirely on which line it is: an ex-works price is about
the country the factory is in, a duty rate is about the country the goods are
entering, a freight rate is about the lane between them. `costEndFor` is a
`Record` over the whole component union, so a component added later is a
compile error until somebody says which end it belongs to.

An `ORIGIN` figure is stored with a null destination, which is what makes a
factory price apply to every lane out of that class. Freight, insurance and
financing are filed against the **destination** deliberately: a rate to one
market says nothing about a rate to another, so treating them as origin-side
would carry one market's freight into another market's landed cost.

The first version read the *round's purpose* instead — a proxy that is wrong
exactly where it matters, because a supply question routinely turns up a
published factory price. The integration walk found it.

`BUYER_ALTERNATIVE` lives in the same table with its own component name and is
never summed with the rest. It is what the buyer pays today, which is the only
figure that says whether the saving is real — and the saving is withheld unless
both halves are comparable figures.

---

## 6. Transaction value is not our capital

The brief's §13, and the distinction this kernel most needs to keep.

A tanker costing a quarter of a million dollars is a quarter-million-dollar
transaction. It is a quarter-million dollars *of ours* only under one of the
thirteen commercial structures, and most of them require nothing of our balance
sheet. A kernel that rejected large transactions because the equipment is
expensive would decline every deal in this trade worth doing.

`CAPITAL_CLASS` answers it once per structure, from the structure's own
mechanics rather than from a figure — because the figure depends on the deal and
the mechanics do not:

- `NONE` — the money moves between buyer and supplier
- `WORKING_ONLY` — our own time and small expenses
- `PARTIAL_GOODS` — part of the goods, against a deposit or an instrument
- `FULL_GOODS` — the whole landed cost until the buyer pays

**Nothing ranks the structures.** A weighted score would need weights nobody
set, and the number would read like a measurement. All thirteen are returned;
what separates them is whether a source has been seen saying this trade actually
uses one, which is a fact rather than a judgement.

**A rate is never parsed.** A source saying "agents typically take three to five
per cent" is not a rate Brain may multiply by a transaction value: that converts
somebody else's range into our revenue and presents it as arithmetic. The
operator surface reports **no revenue figure at all**, and says why.

### Expected time to cash, in words

The brief asks for it, and the honest form is the attested structure's own
payment schedule — *on inspection, so it is cash before the goods ship*, or
*when the buyer pays us, after we have already paid the supplier*. A lookup
over `STRUCTURE_PROFILE`, never a number of days: Brain holds no lead time, no
sailing schedule and no payment term for a given deal, so a figure would be
composed from nothing and would be the most quoted number on the screen. Null
until something is attested, because a payment schedule for a way of being paid
nobody has evidence of is a guess about a guess.

---

## 7. The stage is derived

Everything through `OUTREACH_READY` is computed from rows on the read path and
stored nowhere — `tier.ts`' reason: a row is not a decision, and a stored stage
is stale the moment the evidence it was waiting on arrives. Deriving it also
means every deal already in the table is reclassified by deploying a change,
with nothing rewritten.

```
SIGNAL → HYPOTHESIS → DISCOVERED → RESEARCHED → QUALIFIED
       → COMMERCIAL_PATH → OUTREACH_READY
```

Each rung asks one question and the deal stops at the first unanswered one.
There is no partial credit and no score: a deal with a supplier, a price and no
idea whether the goods may enter the country is not "most of the way there" — it
is one fact away from being worth nothing, and a percentage would say the
opposite.

Everything after `OUTREACH_READY` is read from the Cash opportunity the deal was
promoted into, because those stages record things that happened in the world.
`QUOTING` is reported **only** from a recorded `QUOTE_AND_INVOICE` action; with
no action recorded, an executing deal reads `ENGAGED` and stays there. §29's
rule: a status that reads more precise than the evidence teaches a person to
stop believing it.

### One stage Brain cannot observe

`NEGOTIATING` is a real stage of this trade, the brief names it, and **Brain
holds no row that establishes it** — `COMMERCIAL_ACTIONS` has no action for
negotiating, so there is nothing to read, and inferring it from a quote having
gone out would be exactly the status-too-precise defect above.

So it stays in `DEAL_STAGES`, is never derived, and both the type and
`maturity.ts` say so, with a test pinning it. A reader should be able to see
that it is a gap in what Brain can observe rather than a stage somebody forgot.

The first version of that map keyed on `SEND_QUOTE`, `NEGOTIATE_TERMS` and
`SIGN_AGREEMENT` — plausible names, none of them an action any grant can
authorize, so the whole branch could never fire. The test now asserts the keys
**are** the commercial-action vocabulary rather than asserting the two that
happen to be there.

---

## 8. What the kernel asks next

`allocate.ts` is a pure function over a recorded snapshot, so *why did Brain
research that* is answerable afterwards from an input rather than from a re-run
against a database that has moved. Being pure makes it useless as a safety
mechanism, which is correct — the exclusion is the unique index on
`deal_rounds`.

Rules in a fixed order, no weighted score:

1. **Nothing on the map** → the seed question, the only one with no class.
2. **Finish a deal before starting another.** In descending order of how far
   along it is. §38 records making this the other way round and correcting it:
   the research that found the opening has already been paid for.
3. **One-sided classes, both directions.** Demand-first and supply-first run
   together rather than as a mode somebody selects.
4. **Account expansion, and only after a real transaction.** The brief is
   explicit: identify *verified* adjacent needs. So it fires off a recorded
   outcome rather than off optimism.
5. **Widen the thinner side** of a class that has both, oldest-touched first so
   every class gets a turn.

Bounds: `MAX_OPEN_DEAL_ROUNDS` (concurrency, **not** a lifetime quota — §24
removed exactly that kind of number and recorded why), one live question per
class, a cool-off before the same question is asked again, and
`BARREN_ROUNDS` empty answers retires a question because Brain has now
documented that there is nothing there.

---

## 9. The learning loop

`deal_observations` holds one observed outcome per row, with its own
jurisdiction, equipment class and provenance. **Whether several of them amount
to a rule is derived on the read path**, with the sample size reported beside
it, because the brief's own instruction is not to generalize prematurely — and a
stored rule is a generalization nobody can see the sample behind.

- One observation is reported as an anecdote and **never hidden**: a single
  certification surprise is often the most valuable thing in the table.
- `recorded_by` keeps a person's observation apart from Brain reading its own
  rows, and they are counted separately. Four of Brain's own derivations about
  one deal are one observation four times over.
- Grouping is by (kind, jurisdiction, class) **exactly**. A lesson about fuel
  tankers into Zambia is not evidence about dump trailers into Kenya.
- **A lesson informs; it never gates.** Nothing reads these to refuse a deal,
  lower a bar or skip a question.

---

## 10. Authority

Nothing in this kernel authorizes an effect the sprint's own grant did not
already authorize — which is nothing at all beyond reading.

- **Two approval envelopes**, `RUSSELL_DEALFLOW_PARTIES_V1` and
  `RUSSELL_DEALFLOW_TERMS_V1`. Both take their source classes and their
  forbidden actions **verbatim** from `RUSSELL_CASH_DISCOVERY_V1`, so they
  cannot drift into authorizing different things. Two rather than one because
  the two halves have opposite completion standards: establishing who is on each
  side is a question whose deliverable is a *name*, and establishing what the
  transaction involves is one whose most valuable deliverable is often a
  documented *absence*.
- **Which envelope is decided by the round**, a row Brain wrote, never by the
  idea's prose. The default is the stricter of the two, so a purpose added later
  and forgotten is judged by the deliverable that demands a name.
- **Opening a round is new discovery**, so it is behind `discoveryAllowed` — the
  same gate the buckets and the industry kernel are behind, and a dealflow
  candidate is classified as discovery work by the wind-down guard. Filing,
  pairing and promoting are **not** gated: filing what research already found is
  not new discovery, the spending happened when it ran, and dropping results
  because the sprint wound down would throw away work already paid for.
- **Seeding a party is a person's**, and `deal_parties.origin` makes that
  structural rather than conventional: a CHECK requires every `DISCOVERED` row
  to carry its claim, so there is no code path by which Brain could write a
  `SEED` party. §22's split at the table that decides who the market is.
- **ADMIN comes from `services/identity/policy.ts`**, not from a check in a
  route handler — §17. A worker principal is refused at the writes by level, at
  the reads by `requirePerson`, and at all of them by principal type.
- **Pursuit is Cash Mode's.** A deal that reaches `OUTREACH_READY` is promoted
  into a `cash_opportunities` row; the standing commercial authority decides
  what may be spent, and a recorded `cash_actions` row is the only evidence an
  action happened. Nothing in this kernel contacts anybody.

---

## 11. What it connects to, and the one link it refuses

Everything downstream of a question is machinery that already existed, which is
what makes the multi-hop chain the brief describes work without a single
pairwise integration:

a demand question establishes a buyer → a supply question establishes a
manufacturer → the pairing makes a deal → compliance establishes whether the
goods may enter → landed cost establishes what it costs → structure
establishes how we would be paid → promotion hands it to Cash Mode's
commercial authority, recorded actions and money ledger → the fleet executes
every one of those questions as an ordinary bin.

**The one link deliberately absent is to the industry map.** An equipment class
is not an industry node — the node kinds are sectors, sub-industries,
value-chain layers, buyer types, fulfilment sources, transaction types,
bottlenecks and adjacent industries — so joining them would need a guess about
which node a class sits under. That is §25's Westbrook defect wearing a foreign
key, and `industry_nodes` already refuses to be a place to put everything. The
two kernels share what they should: the sprint, the discovery gate, the
allowance and the fleet.

---

## 12. Where things are

```
server/domain/dealflow.ts              the vocabularies, and the one validator
server/repos/dealflow.ts               parties, requirements, costs, structures,
                                       deals, rounds, observations
server/services/dealflow/
  compliance.ts   the five layers, and why no rows is not a clearance
  economics.ts    the landed cost, and every reason it is withheld
  structures.ts   thirteen ways to be paid, and what each costs us
  maturity.ts     the derived ladder, and what it declines to guess
  graph.ts        everything the kernel knows, read once per pass
  questions.ts    what each round actually asks
  allocate.ts     a pure decision, in the order the trade fails in
  expand.ts       opening the questions, and filing what comes back
  lessons.ts      observations into rules, with the sample shown
  promote.ts      where a deal becomes work Cash Mode already pursues
  seed.ts         the two things a person does directly
  view.ts         the operator surface
  kernel.ts       the tick: file, pair, promote, allocate
server/db/migrations/080_dealflow_kernel.sql
server/db/pg-migrations/071_dealflow_kernel.sql
tests/dealflowKernel.test.ts
```

---

## 13. How it is tested

Two suites, and the split between them is the point.

`tests/dealflowKernel.test.ts` pins the properties: no list of equipment in the
code, every refusal the validator makes, the five layers not collapsing, every
reason a total is withheld, the capital classes, the lesson floor, the
allocator's ordering and its bounds, the envelopes' permissions, and the
operator surface reporting no revenue figure.

`tests/dealflowIntegrationPass.test.ts` walks one deal from a person activating
a sprint to a promotion into the portfolio, with **every declaration going
through `brain_submit_claims`** as an authenticated `WORKER` principal against
a real item off the durable queue. That is not redundancy: it is the only thing
that can catch a declaration validated at the door and dropped before the row,
which is §33's defect and which is exactly what it found — the mapper in
`services/research/submission.ts` carried the structural fields and not these,
so every claim landed with `deal_finding` NULL while the unit suite passed.

`tests/cashHttp.test.ts` drives the door against a booted server, because a
route added after a catch-all and a policy override whose pattern does not fire
are invisible from a unit test of either half. It asserts what this document
claims: a member reads both sides of the map, a member who does not administer
the project is refused when they name a counterparty, an administrator may, a
side outside the two is refused rather than stored, and a machine credential is
refused at every one of these routes by principal type.

All three are simulated at one edge and one edge only: the sentences a worker
found, and the two judgements only a reader of a source can make. **Not a live Cowork
session** — no Routine fires, no provider is called, nothing external is read —
and the tool *layer* rather than the MCP *transport*, which `tests/mcp.test.ts`
and `tests/oauth.test.ts` cover.

---

## 14. What is true today, said plainly

The kernel operates end to end against a local Brain and the full suite passes
on both backends. Driving it produces: a seed question opened from an activated
sprint, both sides filed from gated claims, a pairing, a derived stage that
stops at the first unanswered question, the next question chosen with its reason
recorded, and a promotion into the portfolio when a deal has nothing left to
research.

**No fleet worker has answered a dealflow question in production**, because that
needs a deploy and a fire. Until one has, the engine passing its tests says
nothing about the research — the separation Step 3 drew between the research
engine and a real job having actually run, and §38 had to say the same thing
about the industry kernel.

**No deal has been attempted**, so `deal_observations` is empty and every lesson
the learning loop can produce is a shape rather than a reading. The loop is
built and it has nothing to learn from yet, which is the honest report.
