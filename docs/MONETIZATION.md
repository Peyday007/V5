# The Monetization Possibility Ledger

**For every discovery, the complete known set of ways money could come out of
it — preserved, ranked continuously, and never collapsed into the one that
currently looks best.**

Everything here is a new **entrance** to machinery Steps 4 to 12C already built.
There is no second identity model, no second work queue, no second policy
module and no second orchestration universe. A possibility is a row about a
`cash_opportunities` record or an `industry_nodes` subject; its answers are
gated claims and Brain's own labelled proposals; its execution, where anything
executes, is the portfolio and the standing commercial grant exactly as they
were.

---

## 1. What was wrong

A discovery arrives and Brain records **one** way of making money from it:
`cash_opportunities.mechanism`, chosen at promotion by a mapping from the
claim's declared `opportunity_signal`, before anybody has established a payer, a
price or a route.

Production's thirty-one records are thirty-one single answers to a question that
has dozens. A published request for transcription is a direct sale *and* a
subcontracted fulfilment *and* a productized service *and* a lead worth
referring *and* a data point about what that buyer pays — and which of those is
best is a question about facts nobody has yet. Picking one at promotion and
writing nothing about the rest destroys the alternatives **before the evidence
that would have chosen between them exists**.

That is the collapse this ledger exists to stop.

---

## 2. What the parts are

| Table | What it holds |
|---|---|
| `monetization_paths` | One way of monetizing one discovery. Method, title, thesis, origin, lineage. |
| `monetization_path_facts` | What is known about one path, per attribute, with where it came from. |
| `monetization_path_judgments` | Append-only. The three things about a path nothing can derive, and the one that answers them. |
| `monetization_path_edges` | The edges a derivation could not have: a source's, or a person's. |
| `monetization_rank_snapshots` | Append-only. That a position *moved*, where from, and why. |

And what is deliberately **not** a column anywhere: a status, a rank, a score, a
margin, an expected value, a probability, a coverage figure. Every one of those
is derived on the read path, for `tier.ts`'s own reason — a stored verdict is
stale the moment the evidence it was waiting on arrives, and deriving it is what
reclassifies everything already written by deploying rather than by a backfill
that cannot reach what a later tick produced.

---

## 3. The space is enumerated, never invented

The obvious implementation of *map the complete monetization possibility space*
is to ask a model for forty ways to make money from a discovery. That is §8's
rule broken at the most expensive altitude in this codebase: forty plausible
sentences, indistinguishable from forty researched ones the moment they are
rendered, each then ranked and put in front of somebody as work.

So the space is produced by applying a **closed method table** to what the
subject's own rows already say. `domain/monetization.ts` declares, per method:

* what it **requires** of whoever runs it, and what it **produces** for
  something else to use — both from a closed vocabulary of endowments;
* which **role** it puts you in — principal, intermediary, information, capital
  or platform;
* which kinds of evidence it is **applicable to** at all, by
  `opportunity_signal`;
* whether it is **scale dependent** — a marketplace with two participants is not
  a marketplace.

The intersection of that table with a discovery's recorded signal is arithmetic.
It reads no prose, forms no view, and claims nothing beyond *this is a shape of
transaction that could apply here*.

**Less where less is known.** A subject whose signal nothing recorded gets only
the methods that need no particular kind of opening. The alternative — every
method, because nothing ruled anything out — would produce the largest
possibility space for the discovery Brain understands least.

Two other origins exist.

**`EVIDENCED`** is §20's question — *given everything I now know, are there
monetization paths I could not see before?* — answered as a declaration rather
than as prose. `research_claims.monetization_method` carries one value from the
closed set, declared by the worker that read the source, named in the submission
tool's **schema** as well as its description (§33 records what the other way
costs: a field named in prose and left out of a schema is a field a conforming
client drops, and the failure reads exactly like a worker honestly finding
nothing). It is validated exactly and refuses the whole submission when it is
outside the set.

**The subject is never guessed.** A method declaration is admitted only on a
claim that also carries an `opportunity_signal`, so what it is a way of
monetizing is the opening *that same claim* established — resolved through
`opportunityForClaim` rather than read out of a sentence, which is §25's
Westbrook defect at the field that decides what a possibility is about. A
declaration whose claim has produced no opening yet is left for a later pass; one
whose claim never produces one is never promoted.

Most declarations name a method the table would have produced anyway, and that is
the right outcome: `recordPath` finds the existing row rather than forking the
ledger, and the claim is recorded **on** it as the passage a reader can check.
The origin stays `ENUMERATED`, because that is how the row came to exist.

**`SEED`** is a person, and it is the **one origin Brain may never write** — a
machine that could name its own possibilities would be deciding what the space
is.

---

## 4. The one number this refuses

The brief asks every path to carry a *probability of success*. Brain does not
produce one.

`probabilityOfSuccess` is the only attribute in the table that
`RECOMMENDATION` may not answer: it is a published base rate with a source, or a
person's own recorded decision, or it is unknown. `mayAnswer` is asked by
`recordPathFact` before it writes, so there is no path through the ledger that
produces one — which is the difference between a rule and a claim about a rule.

A 40% close rate nobody measured reads exactly like one somebody did, and
everything downstream would then be arithmetic over it. §29 already records what
that costs.

The same refusal appears one layer up. **Confidence** on the operator surface is
three counts — how many answers resolve to a published source, how many are
Brain's own proposals, how many nobody has answered — and never a percentage.

---

## 5. Ranking is lexicographic, and that is what makes it answerable

The brief asks a ranking three questions it has to be able to answer:

* *why is #17 below #4?*
* *what would have to become true for #31 to enter the top five?*
* *why did this move?*

A weighted score cannot answer any of them. It produces a number and a list of
contributions, and the honest response to "why is it lower" is *because the
weights say so* — weights nobody set, over inputs of different kinds, producing
a figure that reads like a measurement.

A lexicographic order answers all three exactly. **The first criterion on which
two paths differ *is* the reason one is above the other**; there is nothing else
to it and nothing is being summarised. The criteria, in order:

1. where it stands (the derived status);
2. how much of it rests on a source;
3. how many of its questions are answered at all;
4. how soon the money would be usable;
5. what it would leave after its direct costs;
6. how much has to go out first;
7. how hard it is to do;
8. how contested it is;
9. whether it happens again;
10. whether the second one is cheaper;
11. how long it has been in the ledger (the deterministic tail).

**An unknown never helps.** A null sorts last on every criterion, whichever
direction that criterion runs — including the criteria where sorting last is
worse for the path. `conservativeContribution`'s own recorded defect, at a new
table: treating an unknown cost as zero made the contribution come out as the
whole price, so a piece nobody had costed ranked above an identically-priced one
somebody had.

**A low rank is not a verdict.** Ranking is a view of the space and never the
space. `rankLedger` returns every path it was given.

---

## 6. What is stored is what a derivation cannot recover

Three things, and no more.

**That a person named a possibility.** `origin = 'SEED'`.

**That a person judged one.** `WATCH`, `INVALIDATE`, `ARCHIVE` and `REVIVE`, as
append-only rows with a required reason. None of them sets a status: the derived
status reads the last judgement that still holds, and everything else about
where a path stands comes from rows — so there is no shape of this that marks a
possibility healthy over evidence that says otherwise. A revival is its own row,
because deleting the doubt would make the ledger claim nobody ever had any.

**That a position moved.** Where a path ranks today is derived on every request
and is therefore always current; where it ranked *yesterday* is gone the moment
the rows underneath it change. That is §29's argument for the frontier table, and
it is exactly the brief's *previous rank* and *reason for ranking movement*. A
snapshot is appended when the derived position differs from the last one
recorded, and **nothing is written at all when it does not** — which keeps the
table a history rather than a log of ticks.

The movement's reason comes from a closed set and is decided by comparing
timestamps: a judgement recorded since the last snapshot, a status that differs,
facts updated since, or none of those — in which case nothing about this path
changed and the field around it did. The `criterion` is the first ranking
comparison on which it now differs from whatever it passed.

---

## 7. Nothing is ever deleted

`repos/monetization.ts` contains no `DELETE FROM`, no `DROP TABLE` and no
`TRUNCATE`, and a test reads the file to keep it that way.

* **Invalidating** appends a row.
* **Archiving** appends a row.
* **Merging** sets one pointer; clearing it is the whole of the reversal. The
  absorbed path keeps its id, its answers, its judgements and its entire rank
  history.
* **Splitting** creates children that name the parent they came out of, and the
  parent is left exactly as it was — whether it is still worth pursuing
  alongside them is a question the derivation answers rather than something the
  split decided. A child the enumeration had already produced gains the lineage
  on its existing row rather than forking the ledger.

A possibility that ranks fortieth today is the one that ranks second the week a
supplier is found. That is the brief's central instruction, and it is enforced
by there being no other operation.

---

## 8. The graph is a consequence of the vocabulary

§21's chain — permit intelligence, then lead generation, then supplier referral,
then representation, then brokerage, then a managed offering, then a
marketplace, then an intelligence product, then a subscription — is not a picture
somebody drew. Every link in it falls out of `produces` against `requires`.

* **enables / produces-data-for / produces-relationships-for** — one method
  produces what another needs.
* **stepping-stone-to** — an enabler that requires strictly fewer endowments
  than the thing it enables. Counted rather than judged.
* **competes-with / coexists-with** — the same role, or a different one.
* **viable-only-at-scale-of** — a scale-dependent method, and something that
  produces the audience or the recurring base.
* **requires** — deliberately **not** decided pairwise. It is stronger than
  *enables* and is a fact about every path on a subject: this path requires that
  one only where nothing else on the subject produces what it needs.
  `graph.ts` resolves it with the whole subject in hand.

**Only a recorded edge blocks, and for a while nothing could record one.** The
table had no writer at all until a person's entrance was added
(`action: 'LINK'` on the lineage route) — which is this repository's recurring
sentence at a new table: a mechanism nothing calls is not a mechanism, and a
blocker only a person can record is unreachable while nobody can record one.

The chains are bounded rather than exhaustive: each subject's walk has a step
budget derived from how many subjects there are, and the collection stops at
twelve. On a ledger with more discoveries than that, the later ones contribute
no chains — deterministically, in the paths' own creation order, but it is a
bias toward the older discoveries and it is stated rather than implied.

**A derived `REQUIRES` is not a blocker**, and getting that wrong is a recorded
correction rather than a design note. The first version read every derived
requirement as a dependency, and running it showed the consequence: the
enumeration puts dozens of shapes of transaction on one discovery, a derived
requirement exists wherever exactly one of them produces something another
needs, and none of them is proven on day one — so **every possibility in a fresh
ledger read BLOCKED**, on a condition nobody had established and nobody could
act on. §24's *waiting nobody can resolve*, arriving through a status column.
Only a **recorded** edge — a source's or a person's — blocks. What a method
requires is a question, and it already has one: `requiredCapability`.

---

## 9. The operator surface

**Top 5 now**, answered the nine ways the brief asks for: what it is, why it
ranks highly, the expected economics, the time to cash, the required action, the
confidence as three counts, the risks, what changed recently, and why it
outranks the one below it.

Beneath it, **every group**, each a list of ids into one entry list that carries
the whole space: next best, all active, watchlist, blocked, weak, unproven,
invalidated or archived, newly discovered, recently promoted, recently demoted,
and *worth reconsidering* — which is derived rather than remembered, from a
standing judgement that is older than the evidence recorded since it.

The groups are ids rather than copies, and they overlap by construction: a path
can be in the top five, in the newly discovered list and in the recently
promoted list at once, and duplicating it three times would make the counts lie.

**The operator's own questions** are answered from the retained ledger rather
than by reconstructing a possibility space nobody kept:

```
GET /api/projects/:id/cash/monetization
    ?maxCapitalCents=500000      everything under five thousand
    &maxDaysToCash=7             everything that could pay inside a week
    &discoveredSince=…           everything found this week
    &movedSince=…                everything that moved today
    &status=ACTIVE&method=…      by status, by method
GET /api/projects/:id/cash/monetization/compare?a=…&b=…   why is this below that
GET /api/projects/:id/cash/monetization/compare?a=…       what would move it
```

The four decisions only a person makes:

```
POST /api/projects/:id/cash/monetization/paths          name one the table could not produce
POST /api/cash/monetization/paths/:pathId/judgment      watch / invalidate / archive / revive
POST /api/cash/monetization/paths/:pathId/lineage       merge, unmerge, split, or link two
```

Of those, the **judgement** is on the Cash page itself, under each of the five,
because it is the one a person meets while reading. The rest are the API: naming
a possibility the table missed, saying two are one, saying one is two, and
recording a relation only this situation has are all deliberate acts somebody
goes looking for rather than things to put a control under every row for.

**A bounded query never returns an unknown.** A path with no established capital
requirement is not in the answer to *under five thousand*, because it is not
known to be under five thousand.

**The five are computed over the whole ledger and the filter is reported beside
them.** "Show me everything under five thousand" is a question about the space;
it is not an instruction to re-rank the world as though the rest of it did not
exist, and a top five computed over a filtered ledger would quietly mean
something different on every request.

---

## 10. Where the boundary is

A discovery's possibility space is **discovery**, so it crosses to every member
of the Brain — §34's own line, one table along. A member reading a list of
openings with no way to see that one of them has nine live ways of being taken
and another has one is reading half the frontier.

`services/cash/shared.ts` builds a **third projection**, written field by field
rather than filtered out of the owner's. What crosses:

* which possibilities exist on a discovery, and what each method is;
* where each stands, with a sentence keyed on the status itself;
* where each ranks, where it ranked, and when it moved;
* which of its questions are still open, **by name**;
* how many of its answers rest on a source, are Brain's proposals, or are
  unanswered;
* which possibility enables, competes with or waits on which;
* the chains, as titles.

What does not cross: the **value** of a single answer. Not a revenue, not a
cost, not a capital requirement, not a time to cash, not the derived margin, not
a risk quoted out of an answer, and not a ranking sentence composed from any of
them — a member is told the deciding **criterion** instead, which is the whole
of why one path is above another and carries no figure at all.

The owner's `statusBecause` is deliberately not reused either: two of its
branches are relations between figures, and *the established revenue does not
cover the established direct costs* is a statement about two private numbers
even though it quotes neither.

---

## 11. What this version does not do

It records the possibility space, what is known about it, and what a person
decided. It does not research a path on its own: an unanswered attribute is an
unanswered attribute, and what fills one is the research machinery Cash Mode
already has — a gated claim reaching the ledger as an `EVIDENCE` answer, or
Brain's own proposal carrying its basis, its assumptions and what would change
it.

Nothing here forms a view about what settling a question is **worth**, for
`judgment.ts`'s reason. Nothing here spends, commits, contacts or publishes: the
standing commercial grant is still the only thing that authorizes an effect, and
it is untouched.

And the enumeration runs for **discoveries**. A possibility on an industry
subject exists in the schema and is reachable by seeding one, because a person
naming a way of monetizing a buyer type is a real thing to want — but the
automatic pass does not enumerate the whole method table against every node in
the map, which would be a possibility space nobody asked for and a great many
rows nothing would ever research.
