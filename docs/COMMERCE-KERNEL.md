# The social commerce kernel

The industry kernel gave Cash Mode's ten mechanism buckets an axis saying
*where* in the economy to look. It stops at the point where a subject has
produced an opening — and an opening is a published fact about somebody else's
transaction. Nothing in this Brain turned one into a thing **we** sell.

This kernel is that loop, for one shape of transaction: something is bought
from a supplier, discovered by a buyer on a social channel, and shipped without
ever being held. Demand signal → product candidate → supplier validation → unit
economics → offer and content → bounded sales test → fulfilment → realized
profit or loss → learning.

It lives in `server/services/commerce/`, `server/repos/commerce.ts` and
`server/domain/commerce.ts`, and everything it adds is a new **entrance** to
machinery Steps 4 to 12C already built.

---

## The five rules

### 1. The channels are discovered, never declared

**There is no list of platforms in this repository.** Not in the kernel, not in
a constant, not in a migration. `tests/commerceKernel.test.ts` reads the source
of all twelve modules and fails on any of the obvious names.

TikTok gets in because **a person seeded it**. `SEED` is the one origin Brain
may not write — `CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)` — so a
channel exists because a gated claim established it or because somebody said
so, and there is no third way.

That is the brief's *start with TikTok, while allowing evidence to identify
stronger channels* expressed as a row rather than as a constant. A constant
would answer the question the kernel exists to ask, and on this subject it
would be wrong within months: the platforms change their commission, their
eligibility and their fulfilment obligations faster than anything else this
Brain researches.

### 2. Attention is never demand, and the separation is structural

This is the distinction the whole kernel turns on, and it is enforced in four
places rather than asserted in one:

- **Two finding kinds.** `PURCHASE_EVIDENCE` and `ATTENTION_EVIDENCE` are
  separate values in a closed set. `ATTENTION_EVIDENCE` exists *so that* the
  honest reading — many people watched, nobody is shown to have bought — has
  somewhere to go that is not the place a purchase goes.
- **Two lanes.** The gate applies coverage per lane, so a fragment that came
  back with nothing but view counts cannot satisfy a demand lane however many
  it has.
- **The stage.** A proposition with nine attention readings and no purchase
  reading stays at `DEMAND_SIGNAL`.
- **The rank.** Rule 2 of the comparison is *somebody is shown to have bought*,
  and attention never satisfies it.

A view count filed as demand is the single error that would make everything
downstream confidently wrong, so it is refused by construction rather than by
a filter over prose.

### 3. What can be derived is not stored

There is no stage column, no margin column, no rank and no readiness flag.
Evidence arrives asynchronously from several missions, a settled test and
occasionally a person, so a stored stage is stale the moment any of them lands
and the two readers of it disagree. §38's rule 3, unchanged.

Two things *are* stored, because no derivation could recover them: that a
person seeded a channel or a product rather than Brain finding it, and that a
person decided a path was not worth following.

### 4. An unknown is never a favourable assumption

The contribution needs nine inputs. Eight of them plus one blank derives
**nothing**, naming which input is missing.

§30 records this correction at the opportunity card: a margin computed against
an unknown cost fails in the direction that makes a piece look worth doing,
which is the shape of error nobody notices because it looks like ambition. Here
it is worse, because the number decides whether somebody buys stock.

Contradictory rates are withheld too rather than clamped. Three published loss
rates summing past the whole selling price cannot all be true, and clamping
would produce the most pessimistic figure the arithmetic allows and report it
as derived — a made-up number wearing a citation.

### 5. Every figure carries its basis, and the weakest input wins

`ASSUMPTION` < `ESTIMATE` < `MEASURED`, derived from where the row came from
rather than stored beside it.

**A gated claim is an `ESTIMATE` and never a measurement**, however good its
source. A published platform fee is a fact about the platform and an estimate
about *our* economics, because nothing has yet charged us one. Only a settled
bounded test measures anything, and a person's figure is an assumption however
confident they are.

A margin built from eight published fees and one number somebody guessed is an
**assumption**, because the guess is load-bearing. Reporting the strongest
basis, or averaging them, would describe a figure as better evidenced than its
weakest part.

---

## What it asks

Five purposes, each its own kind of round in `commerce_rounds`.

**`CHANNELS`** — once, when the map is empty. Which surfaces publish their own
terms for selling physical goods discovered on them? A seeded channel satisfies
it, which is how "start with TikTok" skips the bootstrap entirely.

**`ELIGIBILITY`** — what one channel requires and forbids, from the channel's
own published terms. Asked *before* the products, because a channel that
forbids the category settles every proposition on it at once — the cheapest
question in the kernel.

**`PRODUCTS`** — what is actually being bought there, not merely watched.

**`SUPPLY`** — who would actually supply one product to a seller holding no
stock, and on what published terms.

**`ECONOMICS`** — what one product costs and sells for, line by line.

Each runs under a reviewed approval envelope with a matching compiler profile.
All four take their source classes and their forbidden actions **verbatim** from
the discovery envelope, so every one of them authorizes the same thing: reading
published sources.

### Why four envelopes and not two

The first version routed everything but `ECONOMICS` to one demand envelope, on
the reasoning that the other four are one question about one surface. **They
are not, and running the kernel is what showed it.** `profileFor` is keyed by
envelope and the profile carries the *required lane*, so an eligibility
question compiled with `purchase` required — a lane a platform's terms page can
never satisfy. A worker would have answered correctly and the fragment would
have been blocked for producing no purchase evidence: §25's *wrong answer
confidently derived* arriving through a lane instead of through a scope, and
invisible to every test of either half.

The four share their permissions and their assignment template **by reference**,
so none authorizes anything another does not. What differs is the completion
standard, which is the thing the gate actually judges.

---

## How it decides

`services/commerce/allocate.ts` is a **pure function over a recorded snapshot**,
kept apart from the reads for `services/dispatch/router.ts`' reason: *why did
Brain research that* has to be answerable afterwards from an input rather than
from a re-run against a database that has moved on. Being pure also makes it
useless as a safety mechanism, which is the same split the dispatcher draws —
the exclusion is the unique index on `commerce_rounds`.

Six rules in a fixed order. **No weighted score anywhere**, because a score
needs weights, weights are a judgement nobody made, and the number then reads
like something that was measured.

| Rank | Rule |
|---|---|
| 100 | A proposition with a buyer, a supplier, and a margin one figure short |
| 150 | The channels bootstrap, when there is nowhere to sell |
| 200 | A proposition with a buyer and no established supplier |
| 300 | A channel nobody has read the rules of |
| 400 | What is actually bought on a channel — the broad search |
| 500 | A proposition with attention and nothing showing a purchase |

Rule 100 outranks the bootstrap deliberately: the rounds that found the product
and established its supplier are both already paid for, and one more figure
turns a candidate into something a person can decide about. **Finishing what
has already been spent outranks starting the next search.**

Rule 500's placement is this kernel's whole opinion about attention. It is
worth one round to find out whether anybody actually bought; it is not worth a
round before every piece that already has a buyer.

### It stops

Four bounds, each a bound rather than a preference:

- A subject with a live round of a purpose is not asked that question twice.
- A settled round waits out `ROUND_COOL_OFF_MS`.
- A subject asked `BARREN_ROUNDS` times for nothing is not offered again —
  because Brain has now documented that there is nothing there, and §13's rule
  about the archive applies to Brain's own history.
- A proposition the channel forbids is asked nothing at all.

`MAX_OPEN_COMMERCE_ROUNDS` is **3**, lower than the industry kernel's 4 and
deliberately so: this kernel runs inside the same sprint, and a new axis taking
as many slots as the established one would halve the throughput of work already
under way on its first tick. It is a concurrency bound and **not** a lifetime
quota — §24 removed exactly that kind of number and recorded why.

---

## The economics

Nine inputs, one derivation, three withholdings.

```
contribution per unit =
    (1 − lossRate) × (price × (1 − feeRate))
  − landed unit cost
  − shipping
```

where `feeRate` is the platform fee plus the payment fee plus the creator
commission, and `lossRate` is the return rate plus the refund rate plus the
chargeback rate.

Three assumptions are stated on every reading rather than buried:

- A returned, refunded or charged-back unit produces no revenue and recovers no
  fee, while its product and shipping cost stay spent. That is the conservative
  reading; where a supplier restocks returns or a platform refunds its own fee,
  the real contribution is higher.
- Content and advertising are the cost of acquiring a **customer** rather than
  a unit, so they are absent from the contribution — which is what makes the
  break-even acquisition figure something to compare against rather than a
  number that has already absorbed the answer.
- Every rate applies to the published price, because no source established a
  discount.

**Break-even acquisition is the contribution under another name**, deliberately
not a second calculation: the most that may be spent acquiring one order *is*
what one order leaves behind, and computing it any other way would be two
derivations of one fact that could disagree.

**Upfront cash** is the minimum order times the landed cost, plus content.
The minimum order is in it because on this business model it decides whether an
opening is reachable at all: a supplier with a 500-unit minimum and a good
margin needs five hundred units of capital before it earns one.

---

## The bounded sales test

The one step that spends, and the one this Brain cannot currently perform.

Three gates, in the order deny-by-default asks them — **may this happen**
before **could this happen** before **how much**:

1. `RUN_PAID_TEST` against the standing commercial grant. Asking the capability
   first would mean discovering that Brain *could* list something it was never
   authorized to sell, which is a fact nobody should learn by nearly doing it.
2. `PUBLISH_A_LISTING` **and** `TAKE_A_PAYMENT`. Both, not either: listing
   without taking payment produces interest rather than a sale, and a test that
   measured interest would hand back an attention reading dressed as a
   measurement.
3. A ceiling a person set. Brain does not choose that figure, because choosing
   it would be Brain deciding what somebody's money is for.

The first thing missing becomes a **named blocker on a row** — `NOT_READY`,
`NO_COMMERCIAL_AUTHORITY`, `NO_CAPABILITY`, `NO_CEILING` — with the detail
beside it. §24's rule that a state saying *waiting for a person* which that
person cannot resolve is not waiting, it is stuck; and "no grant exists" and
"no capability can list" are two facts with two different remedies, so a single
"blocked" would send somebody to fix the wrong one.

A blocked test **does not advance the stage**. The proposition has not got
further than it was; what has happened is that Brain established precisely what
is missing, and reporting an obstacle as progress is the encouraging reading
§29 removed from the briefing.

---

## Self-expansion

`services/commerce/audit.ts` runs on every tick, from rows, without anything
having failed and without anybody asking.

A capability discovered at the moment a piece needs it is discovered too late:
the research is already paid for, the piece is already at the front of the
queue, and the answer is "wait weeks for an integration". So the need is raised
as soon as the loop *could* reach the step rather than when it does.

It **gates nothing**. Nothing here refuses a proposition, charges an attempt,
stops a round or blocks unrelated work — §30's rule that a missing capability
is a need with somewhere to go, never a wall. The one place a missing
capability actually stops something is the bounded test, and that is a blocker
on the test's own row with its own answering transition.

`UNKNOWN` raises nothing. A capability nobody has defined would produce a task
with no possible answer, which is the escalation-with-no-transition defect
manufactured by the very pass that exists to name remedies.

---

## What is true of this kernel today, said plainly

**The loop runs end to end against a real Brain.** A sprint activated, TikTok
Shop seeded as `SEED`, two rounds opened as ordinary Russell candidates, both
compiling under their own envelopes with their own required lanes, three
capabilities read and reported `MISSING`.

**No fleet worker has answered a commerce question**, because that needs a
deploy and a fire. Until one has, the kernel passing its tests says nothing
about the research — the separation Step 3 drew between the research engine and
a real job having actually run.

**Nothing has been measured, and every reading says so.** Every figure this
kernel can hold today is read from somebody else's published page, which makes
it an estimate about our economics rather than a result of ours. A bounded
sales test is the only thing that changes that, and none can settle: both
`PUBLISH_A_LISTING` and `TAKE_A_PAYMENT` read `MISSING` on this Brain, because
no integration of either kind is connected.

**So the honest description of the current state is: the loop is complete, and
its last two steps are blocked on connections a person has to make.** The
kernel names them, on a row, with the remedy — which is the outcome the brief
asks for where authority or access is missing.

---

## Reading it

```
npm run report:cash -- --project <id>
```

prints the channel map, each proposition's stage and derived economics, every
bounded test with its blocker, and what Brain would ask next and why.
`GET /api/projects/:id/cash/commerce` is the same projection for any project
member.

```
npm run commerce -- --project <id> --channel "TikTok Shop" --admin you@example.com
```

seeds a channel and takes one pass. It spends nothing: opening a round creates
a Russell candidate which the archive check, the compiler, the approval
envelope, the evidence gate and all three audit roles still decide about, and
preparing a test writes a row naming what is missing.

---

## What it is not

It is not a second pipeline. A commerce round is a **Russell candidate**, and
from there `judgeCandidate` asks the archive first, the compiler writes the
specification, the approval envelope decides whether it may start, the evidence
gate decides what may be claimed, and all three audit roles decide whether it
stands.

It is not a second portfolio. A proposition **points at** a `cash_opportunities`
row where there is one, the way `capital_structures` does; the opening keeps its
tier, its evidence card and its provenance.

It is not a second lifecycle. Opening a round is new discovery and is behind
`discoveryAllowed`. Absorbing is not, and neither is preparing a test: filing
what research already found is not new discovery, the spending happened when it
ran, and a wound-down sprint must still be able to say what is blocking a piece
somebody may want to finish by hand.

It forms **no view about what a product is worth**. There is no score, no
probability and no projection anywhere in it. The ranking is a lexicographic
comparison over observable facts, and every entry carries what would change it.
