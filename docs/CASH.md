# Cash Mode

**A temporary operating section inside the broader Brain.** It searches
broadly, assembles a private portfolio of cash-producing opportunities for one
account, and keeps everything else Brain does exactly as it is. It is meant to
run for a month or two and then be wound down while the income, the customers,
the records and the reusable methods stay.

Everything here is a new **entrance** to machinery Steps 4 to 12C already built.
There is no second identity model, no second work queue, no second policy
module and no second orchestration universe — §21's rule about the MCP door, at
a new boundary: *it adds a way in without adding a way around*.

What Cash Mode genuinely adds is the one thing Brain has never held: **money,
and the authority to spend it**.

---

## 1. What the parts are

| Table | What it holds |
|---|---|
| `cash_modes` | One sprint per project: objective, horizon, envelope, lifecycle. |
| `cash_authorities` | The commercial grant. Ceilings, actions, prohibitions. |
| `cash_commitments` | The ceiling, spent by insert. One per logical decision. |
| `cash_opportunities` | The portfolio, and the evidence card on each piece. |
| `cash_money_entries` | Append-only. Every figure is derived from these rows. |
| `cash_needs` | A blocked action, its completion condition, and what waits on it. |
| `cash_actions` | Append-only. What was actually done, and under which grant. |
| `cash_events` | Append-only history, no foreign keys. |

| Module | What it decides |
|---|---|
| `services/cash/lifecycle.ts` | Activating, winding down, and what that stops. |
| `services/cash/authority.ts` | The closed set of commercial actions, and the check. |
| `services/cash/money.ts` | The six figures, and the arithmetic keeping them apart. |
| `services/cash/card.ts` | Which facts are unknown, and the task that answers each. |
| `services/cash/portfolio.ts` | The disposition of each piece, and the assembled plan. |
| `services/cash/needs.ts` | A need that names a remedy, or no need at all. |
| `services/cash/capabilities.ts` | What Brain can verifiably do, read rather than declared. |
| `services/cash/operate.ts` | Acting on a need: raise, settle, resume, start work. |
| `services/cash/discovery.ts` | Where the portfolio actually comes from. |
| `services/cash/review.ts` | Grouping by shared remedy; compression, measured. |
| `services/cash/view.ts` | One projection, read by every surface. |
| `routes/cash.ts` | The door. Thin; every decision is above. |

---

## 2. The privacy boundary is the one that already exists

Four people means **four projects**, not four columns. The boundary is
`project_memberships`, read through `decideProjectAccess` on every request,
which already covers conversations, search, notifications, exports and worker
context. A second scoping mechanism beside it would be the weaker of the two.

Absent and forbidden are the same 404 **with the same body**. A status code
that matched while the body differed would still be an oracle for enumerating
which projects run a sprint.

> **Deployment note.** A Brain administrator reaches every project by design
> (`decideProjectAccess`). The four daily accounts must therefore **not** be
> Brain administrators, or the privacy boundary between them is not one.
> Administration belongs to a separate identity.

---

## 3. Two decisions belong to a person, and there is no path around either

**Activating the section** and **granting the commercial authority** are both
`requirePerson` plus `decideProjectAccess` at `ADMIN` — the level a membership
change already carries. A worker principal is refused at both by level *and* by
principal type.

No cash route names a worker scope, so a machine credential is refused at every
write by `MISSING_SCOPE` and at every read by `requirePerson`. **A machine can
never spend anybody's money**, however its membership is configured.

---

## 4. The ceilings here are real, and 12A's were not

§24 removed the lifetime quotas from `russell_goals` because nothing they
rationed was scarce: the subscription behind a research mission is already paid
for, so a count of missions measured a starting point and then became a
permanent wall.

Cash is the opposite fact. A dollar committed to one opportunity cannot fund
another. So `cash_authorities` is genuinely capped, and the cap is spent the way
every claim in this repository is made:

    INSERT ... ON CONFLICT DO NOTHING on the idempotency key
    read back; if this call did not insert it, replay and stop
    sum what is HELD through this row's own rank
    if that is over the ceiling, release this row and refuse

The rank is `rowid` — `seq` on Postgres — which the claimant does not supply.
Two workers racing for the last hundred dollars get two ranks, so their running
sums differ and exactly one is over. **It can under-commit and it cannot
over-commit.**

**A commitment is never released by time.** There is no TTL and no sweeper.
§20's rule that a timeout is not evidence is at its sharpest here: a hold that
lapsed on a clock would hand back spending room for money that may already have
left the account. It is settled when the spend happened, or released by a person
who knows it did not.

**A replay is not a new commitment.** The shortfall gate blocks *new*
discretionary commitments; a retry of one that already exists skips it, because
the first attempt is usually what made the account short and refusing the retry
would leave a caller that lost its response with no way to find out what
happened to its money. The authority check still runs on the replay — that is
the half a revocation can change.

---

## 5. The six figures, and the mistake that would make all of them lie

Every figure is derived from `cash_money_entries` and stored nowhere. A balance
column would be a second master for the same fact, and the one nobody reads is
the one that drifts.

| Figure | What it is |
|---|---|
| Pipeline | Agreed work. No cash received. Added to nothing. |
| Customer payments | Verified, including what is still pending with the provider. |
| Available funds | Settled and usable through the verified route. |
| Unpaid commitments | Delivery costs and supplier bills owed, plus held commitments. |
| Reserves | Protected cash: delivery, tax, operating. |
| Deployable | Available funds minus the two above. |
| Completed contribution | Earned sales minus every incremental cost, before overhead and tax. |

**A cost is subtracted once.** It leaves the account in *available funds*;
*deployable* subtracts only what has not left yet. Subtracting it again there
understates deployable cash by everything the sprint ever spent, and gets worse
the better the sprint goes — which is the shape of error nobody notices, because
it looks like caution. `tests/cashMoney.test.ts` pins it.

**A payment is not funds.** `CUSTOMER_PAYMENT` and `SETTLEMENT` are two events
about the same money and only the second moves available funds. Stripe's own
documentation says a first live payout is typically scheduled to complete in
7–14 days.

**A payment with no verifiable reference is refused.** A payment nobody can
trace is pipeline, and recording it as cash is how a forecast gets into a bank
balance.

§5's worked illustration — a $750 job reaching $355 of contribution and $280 of
redeployable cash — is reproduced as a test.

---

## 6. An unknown is never a favourable assumption

The evidence card reports, per field, either the answer or **the task that would
produce it**. A missing phone number is an access task; a missing supplier price
is a quoting task. Nine fields are load-bearing — payer, access, buying
evidence, offer, acceptance, price, delivery, fulfilment, exposure — and
`readyToTest` refuses while any of them is blank.

A buying signal with **no observation date is not evidence**: an undated signal
cannot be told apart from one somebody remembers from March.

The ranking is **lexicographic over observable facts**, in the plan's own order,
rather than a weighted score — a score needs weights, weights are a judgement
nobody made, and the result reads like a measurement. No probability is
invented anywhere. An unknown exposure sorts last and an unknown contribution
counts as zero, so **a blank can never be the reason something rises**.

---

## 7. What winding down stops, and what it must never touch

`russell_cycle` is a **singleton**. Pausing it stops the entire Russell tick —
writeback, request resumption, every other project, every other person. Wiring a
sprint's off switch to it would stop the Brain in order to end one person's
sprint, and it would look like it had worked.

So **nothing in Cash Mode references it**, and that is asserted by a test that
reads the source rather than trusted to a comment — because a Brain whose whole
tick was paused would pass every behavioural test in the file, since nothing
else would be running either.

What winding down stops is **new discovery**, checked in two places because a
guard on one entrance is not a guard:

- `capture()`, the one producer that brings a piece into the portfolio;
- `nextLaunchable()` in the Russell loop, which **skips** a queued candidate
  belonging to a cash opportunity whose sprint is not `ACTIVE`. A skip, not a
  refusal: no state moves, no attempt is charged, and the idea launches by
  itself when the sprint is active again.

Delivery, collection, settlement, needs, money, the card and every existing
opportunity keep working in `ACTIVE`, `WINDING_DOWN` **and** `ARCHIVED`, because
a sprint ending is not a customer's obligation ending. Archiving destroys
nothing, which is why `ARCHIVED → ACTIVE` exists: resuming is a decision rather
than a recovery.

---

## 8. Which envelope discovery runs under

The *set* of envelopes a cash project may compile under is
`SELECTABLE_CASH_ENVELOPES`, in code, reviewed — one entry,
`RUSSELL_CASH_DISCOVERY_V1`. Which one a given project uses is a person's
recorded decision on `cash_modes.envelope_id`, because the four private
operations run in projects an operator creates and this repository cannot know
their slugs. §16's property is preserved exactly: a mode may only *choose* from
limits somebody else wrote, and an id that does not resolve compiles nothing.

`compileMission` reads the in-code slug map first, so activating a sprint on an
existing project cannot change that project's existing authorization.

**This envelope does not bound geography, and that is stated rather than
hidden.** `geography` accepts any declared market and `forbiddenScope` matches
nothing, because the authorized mandate is broad discovery across industries,
business models and markets — an envelope that refused an opening for being in
the wrong state would refuse precisely the work it exists to permit. What bounds
it is **what it may do**: `allowedSourceTypes`, `forbiddenActions`, and the fact
that research authority in this Brain has never been able to spend anything.
Every effect on the world — contacting a buyer, quoting, committing money,
accepting payment — is a `COMMERCIAL_ACTION` a person grants separately, with a
ceiling on each.

---

## 9. One identity per site *per project*

**This is a correction to `services/connect/sites.ts`, recorded rather than
quietly applied.**

`connectSite` derived its worker from a single global name, so connecting the
same site to a second project reused one identity for both. Three things
followed:

- `grantMembership` added the second project to that one worker, and a worker
  credential resolves the worker's memberships — so the credential the second
  site held authenticated against **both** projects;
- `revokeCredentialsForWorker` is worker-wide, so connecting the second site
  revoked the first site's live credential and silently broke it;
- and the refusal that would have caught a caller reaching across projects is
  invariant 23's 404, which by design tells nobody anything.

One Brain with one site and one project never sees any of it. Four private
operations each connected to their own site is exactly the arrangement that
does.

The identity is now `scopedWorkerName(site, projectId)`. Nothing else moved: the
scope set is still the constant, the credential is still shown once and stored as
a digest, connecting is still a repair and a rotation, and disconnecting still
destroys nothing.

**A connection made before the correction still reads as connected.** The shared
worker is resolved — but only where it holds a live membership on *that* project,
so it can never be found by a project it was never connected to — and
`sharedIdentity` says so. Reconnecting retires its reach into that project by
revoking the membership, and **deliberately does not revoke its credentials**,
because those are worker-wide and other projects may still be on them. Those
projects move onto their own identity when somebody reconnects them, which is
the same one action.

---

## 10. The compressed review

The plan's interaction goal is roughly a hundred underlying decisions becoming
about ten review items, and it is explicit that ten is an example rather than a
quota or permission to hide an urgent decision.

Grouping is by **shared remedy** — the same recommended path, the same blocker.
The count each group stands for is reported, so the compression is measured
rather than claimed. An item with no group of its own is its own group rather
than being dropped off the end of a top-ten list.

**The decision nothing can proceed without is never folded.** A project with no
live commercial grant has exactly one thing outstanding and it is named first —
§29's rule that a status contradicting the control beside it teaches a person to
stop reading it.

Three corrections came out of a review of the first pass, and each of them is
the same shape: a sentence on the screen that was not true of the rows.

**A group of the same kind of work is not one decision.** Five cards with no
price are five prices — the same sitting, not one answer — and the review said
answering the group released all five. `sharedRemedy` says which it is, and the
screen reads *"one answer covers"* or *"the same kind of work on"* accordingly.
A screen that promises five and delivers one teaches a person to stop believing
the counts.

**A shared remedy costs what the remedy costs, once.** Two needs blocked on the
same small tool were reported at twice its price, because the group summed the
expected costs of the things it unblocks. That is the direction that matters: an
over-stated cost makes a cheap unblock look expensive enough to defer. Where the
members name one figure it is that figure; where they differ Brain says the
largest and why, rather than inventing a total.

**A fact Brain could look up is not a person's decision.** `evidenceCard` marks
the payer, the access channel and the buying evidence `discoverable`: they are
facts about the world, so `reconcileDiscoverableGaps` raises a need and Brain
researches them, and they never appear on the review at all. What to offer, what
to charge, what counts as accepted and who does the work are the owner's own
calls — and a researched answer to "what should we charge" would be invented
judgment wearing a citation.

**Every item carries a typed answer**, and each one names an operation that
already exists: the grant, closing a need, releasing a commitment, filling a
card. There is no apply endpoint of the review's own, because a second way to do
each of those is one forgotten guard away from doing less. `NOTHING_TO_PRESS` is
a real value rather than an omission: an expiring opening is answered by taking
it, and a button that marked it read would be a control that pretends.

---

## 10a. Where the portfolio comes from, and what Brain does about a need

Activating a sprint used to write a mode row and an event and nothing else. No
goal, no candidate, no mission, no queued job — so a freshly activated sprint
could sit empty indefinitely beside a perfectly healthy research fleet while the
screen said discovery had started.

**Brain decomposes; it never invents a finding.** `SEARCH_BUCKETS` is the plan's
own search-bucket table in code: a closed set of declared places to look, each
one captured as an idea. Everything after that is the path Steps 4 to 12A
already built — the archive check first (§13), the judgment pass, the mission
compiler, the approval envelope, the seven evidence conditions, all three audit
roles. No grant is manufactured: a project with no standing research authority
compiles no specification and the idea parks.

**A lane is a row, so a signal is not a judgement.** `harvest` reads
`evidence_lane`, not prose. What it files is an opportunity with a **blank
card**, because a published request is evidence somebody asked and is not a
payer, a price, an acceptance condition or a delivery path.

**Executing means something happened.** `beginExecution` used to move an
opportunity to `EXECUTING` and emit an event with no work enqueued and no action
performed — "the transaction is being pursued", written on a button press. The
transition is now downstream of a `cash_actions` row, the action is one of
`COMMERCIAL_ACTIONS`, and the grant is asked about *that* action rather than
about `CONTACT_BUYER` regardless.

**A capability is read, never declared.** `required_capabilities` was stored and
consulted by nothing. `readCapability` answers from rows —
`RESEARCH_A_QUESTION` is `PRESENT` only when the fleet has a healthy execution
surface — and keeps two answers apart that must not be one: `MISSING` means
Brain understands it and does not have it, `UNKNOWN` means nobody has told Brain
what it is. "We could not tell" must never read the same as "we checked".

**A need has a completion condition and a continuation that runs once.**
`closeNeed` set a status and resumed nothing, so a person could answer the same
need repeatedly and never learn their answer was recorded and ignored.
`blocks_state` records the transition waiting on it, `continued_at` is a
compare-and-swap, and the resumption retries that transition **without a
`firstAction`** — so a resolved need can unblock work and can never manufacture
the evidence that work began.

**None of it gates anything.** No pass refuses an opportunity, charges an
attempt or stops unrelated work. An open need is a valid execution state and
Brain carries on around it.

---

## 11. What this deliberately does not do

- **It does not spend anything by existing.** Activating creates a sprint;
  granting is a separate decision; committing is a third.
- **It does not contact anybody, quote, invoice or pay.** Those are
  `COMMERCIAL_ACTIONS` a person authorizes, and this version records the
  authorization and the money rather than performing the effect. A missing
  integration is a `cash_needs` row with a recommended way forward, which is a
  valid execution state. `capabilities.ts` says so in the code rather than only
  here: every capability but `RESEARCH_A_QUESTION` reports `MISSING` with the
  integration it would need named, and none of them has a reader because there
  is nothing to read.
- **It does not narrow the search.** No mechanism is preferred, no business
  model is assumed, durability and repeatability are recorded and never
  required, and `OTHER` exists so an unlisted opening is grouped rather than
  refused.
- **It does not judge what settling a question is worth.** Nothing here forms
  that view, for the same reason `judgment.ts` does not.
- **It is not the definition of what Brain may pursue.** It is one section, in
  one project, for a month or two.

---

## 11a. The money defects an external review found, and what closed them

Every one was reproduced before it was fixed (`tests/cashDefects.test.ts`), and
they share one property: each produced a **wrong number or a disclosure** while
every surface read as healthy. 2,812 passing tests established none of it,
because every one of them exercised a single caller on a single account taking a
single unrepeated action.

| What it was | What closed it |
|---|---|
| `UNIQUE (idempotency_key)` was table-wide, so two accounts picking the same string collided and the second was handed **the first's commitment** — its amount, purpose and stop condition — as its own success, reserving nothing. | The key is scoped to the project. A caller's string is never the whole of an identity. |
| A `HELD` row was visible before its ceilings were checked, so a concurrent retry was told "an equivalent commitment already exists" about money released microseconds later. | The whole commit runs in one transaction and a refusal **rolls the row away**. No provisional row is ever visible, so a replay always observes a finished outcome. |
| The ceiling summed per **grant**, so withdrawing one with $400 outstanding and making a replacement with the same $500 ceiling permitted another $400. | The rank sums what the **project** holds. A hold outlives the grant that authorized it. |
| The gate asked whether deployable cash was *already* negative, so $100 of capital could take a $400 commitment and be told next time. | `deployableAfter` is evaluated inside the transaction after the insert, so a negative answer is precisely "this does not fit". A replay never reaches it. |
| Settling removed the hold and wrote no cost, so marking $400 spent took deployable cash from $600 back to $1,000. | `settleSpend` writes the matching `COST` in the same transaction, keyed from the commitment. `spentCents` makes a partial spend expressible; more than was held is refused. |
| Every money write minted a fresh id, so a retried $750 settlement reported $1,500. | `(project_id, idempotency_key)`, plus a payload fingerprint: a key reused for a different amount is **refused** rather than replayed as the first. |
| Aggregation summed every entry and labelled the result with one currency. | A sprint is pinned to one currency at activation. An entry in another is refused, and the aggregation filters as well as labels. |
| A missing id and one belonging to somebody else returned **different 404 bodies**, which is an oracle for existence. | One resolver, one body. The HTTP suite compares the whole response rather than the status. |

Two product corrections went with them. The authority card had no business
arriving prefilled — $1,000 committed, $250 per action, three opportunities,
every action ticked, with Approve visible and the terms folded away: nobody
chose those numbers and the person approving could not see what they were
approving. There are no defaults, the server states the terms, and only then is
there anything to approve. And the section took whichever project the shell had
selected, so somebody with a broad Brain project and a private cash project
could be shown the wrong one; the operation is chosen now, from the ones that
exist.

## 12. Checks

```
npm run typecheck
npm test
BRAIN_TEST_DATABASE_URL=postgresql://... npm test
```

The suites: `cashMode`, `cashMoney`, `cashAuthority`, `cashPortfolio`,
`cashDefects`, `cashDiscovery`, `cashOperate`, `cashHttp`, `cashSection`,
`connectorIsolation`, and `cashIntegrationPass` — which walks one sprint from
activation through discovery, a harvested opening, the needs Brain raises and
answers, the first recorded action, delivery, settlement and winding down, in
one pass through the entrances production uses. It exists because every defect
the review found was a transition that existed, was tested, and could be
reached by nothing; each of them was invisible to a test that arranges its own
starting state. Only the research worker is simulated, and its output is a
declared fixture rather than live research.

Both boot paths were verified: migrations `052_cash_mode` through
`055_cash_operation` apply from an empty database, and a restart against the
existing one is a no-op. The full suite
passes against SQLite **and** against Postgres — which is the only thing that
proves one repository layer over two backends is true rather than merely
compiling, and which has caught a missing `seq` column twice before.
