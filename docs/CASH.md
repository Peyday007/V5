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
| `cash_needs` | A blocked action, with a recommended way forward. |
| `cash_events` | Append-only history, no foreign keys. |

| Module | What it decides |
|---|---|
| `services/cash/lifecycle.ts` | Activating, winding down, and what that stops. |
| `services/cash/authority.ts` | The closed set of commercial actions, and the check. |
| `services/cash/money.ts` | The six figures, and the arithmetic keeping them apart. |
| `services/cash/card.ts` | Which facts are unknown, and the task that answers each. |
| `services/cash/portfolio.ts` | The disposition of each piece, and the assembled plan. |
| `services/cash/needs.ts` | A need that names a remedy, or no need at all. |
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

Grouping is by **shared remedy** — the same missing card field, the same
recommended path, the same blocker — so answering one group releases every
underlying item in it. The count each group stands for is reported, so the
compression is measured rather than claimed. An item with no group of its own is
its own group rather than being dropped off the end of a top-ten list.

**The decision nothing can proceed without is never folded.** A project with no
live commercial grant has exactly one thing outstanding and it is named first —
§29's rule that a status contradicting the control beside it teaches a person to
stop reading it.

---

## 11. What this deliberately does not do

- **It does not spend anything by existing.** Activating creates a sprint;
  granting is a separate decision; committing is a third.
- **It does not contact anybody, quote, invoice or pay.** Those are
  `COMMERCIAL_ACTIONS` a person authorizes, and this version records the
  authorization and the money rather than performing the effect. A missing
  integration is a `cash_needs` row with a recommended way forward, which is a
  valid execution state.
- **It does not narrow the search.** No mechanism is preferred, no business
  model is assumed, durability and repeatability are recorded and never
  required, and `OTHER` exists so an unlisted opening is grouped rather than
  refused.
- **It does not judge what settling a question is worth.** Nothing here forms
  that view, for the same reason `judgment.ts` does not.
- **It is not the definition of what Brain may pursue.** It is one section, in
  one project, for a month or two.

---

## 12. Checks

```
npm run typecheck
npm test
BRAIN_TEST_DATABASE_URL=postgresql://... npm test
```

The suites: `cashMode`, `cashMoney`, `cashAuthority`, `cashPortfolio`,
`cashHttp`, `cashSection`, `connectorIsolation`.

Both boot paths were verified: migration `052_cash_mode` applies from an empty
database, and a restart against the existing one is a no-op. The full suite
passes against SQLite **and** against Postgres — which is the only thing that
proves one repository layer over two backends is true rather than merely
compiling, and which has caught a missing `seq` column twice before.
