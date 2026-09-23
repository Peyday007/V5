# Four real Claude accounts as one Factory fleet — engineering handoff

**What this is.** A durable record of one engineering lane, worked in parallel
with the Software Factory closeout lane, on the question *can Brain use four
separate real Claude accounts as one coherent Factory execution fleet, safely,
observably and recoverably.*

**What it is not.** It is not a claim that four accounts have been
commissioned. No four-account Factory pool exists. Where a thing has not
happened, this file says so rather than rounding it up.

**This file was a lane handoff and is now the integration record.** The lane
finished, the integration lane merged it into the production candidate, and
both halves are kept here rather than split across two documents that would
disagree. Predictions that have since been measured are replaced by the
measurement, and §7 is the integration's own record.

---

## 0. The integrated state, in SHAs

| | SHA | What it is |
| --- | --- | --- |
| Fleet lane | `e8a34b00` | `claude/fleet-four-accounts`, cut at `f727b143`, eight commits, preserved unchanged |
| Factory closeout | `e37cca06` | reached `production` before this integration and was deployed there by run 316; its lane branch `claude/factory-core-completion-ri3kqj` has since moved on — see §8.1 |
| Merge | `bb6d538d` | the fleet lane merged into `e37cca06`, no conflict |
| Fixture repair | `3a63fad4` | the `'READER'` correction §7 records |
| Integrated tip | `ba5c0b2f` | `integration/fleet-four-accounts`, after reconciling against production four times |
| **Production** | **`08d6a787`** | **contains `ba5c0b2f`**, live and serving; the release that proved the integration live end to end is deploy 327 on `67089909` — see §8.7 |

**`production` has been advanced to it, and the integration is deployed.**
`ba5c0b2f` is an ancestor of every tip production has had since — checked with
`git merge-base --is-ancestor` at each one, and confirmed file by file and
symbol by symbol at the tip rather than inferred from the ancestry. §8 is the
record of the release and the live reads rather than a plan for them.

**An earlier version of this row named `901a42db` and deploy 323.** That was
true when it was written and production has moved four times since, so it is
corrected here rather than edited away: deploy 323's own reading is §8.2, it
passed before its restart and failed after it, and the run that passed both
sides is 327. A SHA table that named a superseded tip would send a reader to
verify the integration against a tree production no longer serves.

**An earlier version of this paragraph said `origin/production` was
`f727b143`.** That was true when the lane measured it and was false by the
time the integration ran: production had advanced twenty-two commits of
Factory closeout work and been deployed. The correction is recorded rather
than edited away, because the lane's merge-readiness reading was taken
against the older snapshot and a reader needs to know which tree each number
describes. The integration re-measured everything against the current tip.

---

## 1. The audit, first — because most of this was already built

The lane began by verifying the current tree rather than working from the
brief's premises, and the largest single finding is that **the multi-account
fleet architecture exists, is documented and has been commissioned in
production for research**:

* `fleet_accounts` and `fleet_routines` are separate tables with separate
  targets, and `declared_plan_power` is a label the router never multiplies.
* A fire slot is claimed by compare-and-swap on `fleet_routines.fire_generation`.
* `routeBin` is pure over a recorded snapshot; `RoutingRefusal` is a closed
  union, each member classified for whether it ends a burst and whether it is a
  wait.
* Secrets are a *name* plus a digest taken once. `register-routine` refuses a
  second Routine on a secret — **or on a token** — another one already holds,
  which is precisely the four-account mistake.
* `bins.pinned_routine_id` lets a probe reach a *named* surface, so a pool can
  be proved member by member rather than sampled.
* `proveSurface` is a four-row chain — fired, arrived as the bound worker,
  assigned, completed — every row Brain wrote itself.
* `docs/workers/CONNECTING-THE-FACTORY-WORKER.md` is a 708-line runbook whose
  every step is marked *once per account*.
* `docs/FLEET-12-ACTIVATION-EVIDENCE.md` records three Claude accounts, twelve
  Routines, eight surfaces individually VERIFIED and fleet concurrency 8
  measured under saturation.
* `tests/factoryPool.test.ts` already proved routing across accounts, failover
  without charging the bin, per-account targets, one unroutable bin not stopping
  the ones behind it, and permanent research/factory identity isolation.

So this lane did **not** rebuild any of that. What it found instead were
defects of one class, and that is what it fixed.

---

## 2. The class of defect this lane found

**A derived verdict reporting configuration as verified capacity, or a health
signal that cannot express a pool.**

Every one of them was invisible to the tests that existed, because each was a
statement made *about* correct machinery rather than a fault in it. Every row
read healthy in all six cases.

### 2.1 A proof was treated as a permanent certificate

`judgeSurface` closed the four-row chain and then wrote `problems.length = 0`.
That is right about the proof's own complaints — *nothing has ever arrived here*
is genuinely answered by an arrival — and wrong about every standing fact
recorded beside them. Two reach that line: a bound worker that has been
**archived**, and a Factory identity whose routing row also serves research.
Both are faults about the surface *now*; both were discarded by a chain closed
at any point in the past; and `judgePool` reports problems only for a surface
whose verdict is not PROVEN. So **a pool containing an identity that cannot
authenticate at all answered `ok: true` with zero problems.**

And nothing bounded a chain's age: `proveSurface` walks every arrival ever
attributed to a Routine and takes the first closed one, so a surface proved once
and dead since certified itself for ever.

**Repair.** Standing facts are kept apart from the proof's complaints; only the
latter is answered by a chain. A fourth verdict, `STALE`, is derived from
Brain's *own later evidence* rather than from an invented expiry — Brain cannot
see a connector revoked inside somebody's Claude account, so a timer would be a
freshness policy nobody measured.

### 2.2 The staleness signal was almost derived from the wrong column

The first version of `STALE` compared `fleet_routines.last_fired_at` against the
newest arrival. **That is wrong**, and the regression that caught it is kept:
`claimRoutineFireSlot` advances `last_fired_at` when it takes the slot, *before*
the HTTP call, so a fire the provider rate-limited advances it exactly as a
delivered one does. It would have called a busy account's proof stale — §23's
*a refusal is not misconduct*, broken by the check written to catch a dead
surface.

### 2.3 The Build card could not be counted

`RepositoryOnboarding.surfaces` was a list of display names, rendered as
*"running on Factory Brain A, B and C"*. Three Routines on one subscription
produce exactly that sentence, so a reader counted three Claude accounts. It
also read the same for a Routine registered a minute ago as for one with a
completed chain behind it.

**Repair.** The card reports the account count, the surface count when they
differ, and which surfaces have actually completed work — read through
`capacityReading`, which is already the single reader of `proveSurface` for
`/people`, so the two screens cannot disagree.

### 2.4 `HEALTHY` was two facts in one word

`SurfaceHealth.HEALTHY` is *eligible **and** proven*. A surface that ran real
work and whose deployment secret was later removed reads `WAITING`, correctly —
and was indistinguishable from one that has never run. `SurfaceReading.proven`
is its own field now, at the top level, because it names no identifier and
whether a connection has actually run is what its owner is owed.

### 2.5 The no-show quarantine was a mechanism nothing called

`shouldQuarantine` has stated this fleet's rule since Step 11 and had exactly
one caller: `fleet scale-advice`, which prints a line. **No surface has ever
been quarantined for not answering.**

Wiring it up as it stood would not have helped, and that is the half only a pool
shows. Its input, `fleet_routines.consecutive_no_shows`, is cleared by
`recordWorkerArrival` for **every Routine bound to the same worker** — precisely
what a Factory pool is. So one dead account's counter is reset by its healthy
siblings and it is fired at for ever: an activation each time, out of a fixed
subscription allowance. The same column reads 1 on a *working* surface whose
worker is still booting, because it is advanced optimistically per fire.

**Repair.** `reopenNoShowDispatches` already establishes the exact per-surface
fact and wrote it to a ledger row naming no surface at all. It writes
`DISPATCH_NO_SHOW` with the Routine now — at the moment the fact is established,
on an append-only table, because a reopened intent's `routine_id` is rewritten
when it is re-routed and a count read back from the dispatch row would credit
one account's no-show to the next account that tried.
`unansweredFiresByRoutine` counts those rows since that surface's own last
arrival; the tick quarantines on it.

### 2.6 …and the quarantine it created could not be lifted

Found by writing the recovery test rather than by reading. The count reads an
append-only ledger since the last arrival; re-enabling produces no arrival; an
arrival needs a fire; Brain does not fire a quarantined surface. So `fleet
set-state --to ENABLED` returned `true` and the very next tick re-quarantined on
the identical rows, **for ever, with the connector genuinely repaired.**

**Repair.** `fleet_routines.no_shows_forgiven_at`, written in the statement that
makes the state change, only on the way *out* of QUARANTINED, and forgiving
nothing beyond itself — a condition somebody said was fixed and was not takes
the surface out again three unanswered fires later rather than immediately.

### 2.7 Six screens printed the counter that cannot express a pool

Fleet, People, `who`, `fleet show`, `verify-surface` and `scale-advice` — the
last of which also *advised* on it. All six read the derived count, and a
source-read guard keeps the column off every screen.

### 2.8 Nine component test suites were never compiled

`tsconfig.json` included `client/**/*.tsx` and `tests/**/*.ts` and nothing for
`tests/**/*.tsx`. Two of the fixtures in those files carry a paragraph
explaining that a fixture the compiler does not check is one that tests itself,
were annotated for that reason, and were never compiled. One had been missing a
required field since it was added.

---

## 3. What changed

| Commit | What |
| --- | --- |
| `3ccb623d` | Standing facts kept apart from the proof; `STALE`; the Build card counts accounts; `SurfaceReading.proven`; `tests/**/*.tsx` into the typecheck |
| `6ba3fa2c` | `DISPATCH_NO_SHOW` attribution; `unansweredFiresByRoutine`; the tick quarantines on it; six screens corrected; `verify-pool` reads the one definition |
| `d732882d` | `no_shows_forgiven_at` (088 / pg 079); accounts and surfaces as two numbers; the runbook and the evidence log updated |
| `57267ee0` | this handoff; `idx_worker_sessions_routine`, the index the new reading needs |
| `6fd3ef7d` | three findings from re-reading the diff: a guard keyed on prose, a quarantine the tick never announced, and the record in CLAUDE.md §23 |
| `76e54d4b` | accounts counted by identity rather than by display name — and the vacuous first test for it, replaced |
| `90397070` | the measured run numbers recorded in this handoff |
| `e8a34b00` | merge-readiness measured against the closeout lane, and the prediction in §6 replaced by the reading — **the lane's tip** |
| `bb6d538d` | *(integration)* the lane merged into `production` at `e37cca06` |
| `3a63fad4` | *(integration)* the `'READER'` fixture corrected, with the mutation that proves it was vacuous |

**Schema.** One additive column on `fleet_routines`, on both chains, numbered
`088` (SQLite) and `079` (Postgres). Nothing is dropped, rewritten or
backfilled. Deleting every `DISPATCH_NO_SHOW` row returns the fleet to exactly
what it did before.

**Not touched.** No workflow, no `fly.toml`, no `Dockerfile`, no deployment
branch policy, no identity or policy module, no approval envelope, no queue
primitive, no lease, no fencing generation, no Factory stage machinery. The
integration added one test-fixture correction and this document, and changed no
production code of its own.

---

## 4. Test discipline

Every repair here was reproduced first and its regression run against the defect
before the fix was written. Three cases are worth naming because the *test* was
wrong and the failure is what established it:

* The first `STALE` test set `consecutiveNoShows: 2` and expected staleness.
  Analysis of the writers showed that column is 1 on every healthy in-flight
  surface, so the premise was corrected rather than the implementation bent to
  meet it.
* The first `unansweredFiresByRoutine` fell back to `last_check_in_at` when a
  surface had no `worker_sessions` row. The sibling test failed, because that is
  the same worker-wide write one column along.
* The recovery test failed against the first version of the quarantine, which is
  how §2.6 was found at all.

Two guards were exercised against their own defect to confirm they are not
vacuous: the typecheck-coverage guard (with `tests/**/*.tsx` removed from
`tsconfig.json`), and the misleading-counter guard (with `Fleet.tsx` reverted to
printing it). Both fail naming exactly what is missing.

**Runs.** Full SQLite suite green twice: **4455 passed / 208 files / exit 0** at
`3ccb623d`, and **4459 passed / 208 files / 44 skipped / exit 0** at
`d732882d`. Fleet, pool and arrival suites green on **PostgreSQL 16.13** as well
as SQLite (120 tests, then 112 after the index). `npm run typecheck` clean at
every commit.

Those are the *lane's* runs, on the lane's own base. They are kept because the
test-discipline story is what they belong to, and they are **not** the
integrated commit's evidence — §7.2 is.

**A third guard was exercised against its own defect during the
integration**, and it is the one this section's own argument predicted: the
corrected release fixture was run against a live authorization regression, and
the version it replaced passed 6 of 6 while the corrected one failed. §7.1
carries the measurement.

---

## 5. Status, stated in the three categories the brief asks for

### ENGINEERING COMPLETE

* A surface's proof is evidence about a moment, not a certificate; standing
  faults survive it; a proof Brain's own later evidence contradicts reads
  `STALE` with `--probe` as its remedy.
* A dead account in a pool is visible per surface, stops being chosen at the
  threshold the architecture already declares, and can be restored by an
  operator without touching the database.
* Accounts and surfaces are reported as two numbers everywhere a person reads
  one — `verify-pool`, the Build card, the Fleet page, `fleet show`.
* `CONFIGURED` no longer reads as `VERIFIED` on any surface.
* Every durable record this lane created has a reader, and every state
  transition it introduced has a reachable operator control.
* No token value is printed by any command, put on any event, written to any
  evidence document or embedded in any source. `check-secret` answers presence
  and never a length, prefix, digest or shape.

### AWAITING HUMAN ACCOUNT / CREDENTIAL AUTHORIZATION

Nothing in this lane can do any of these, by design:

* Creating the Claude account and adding the Factory connector to it — the
  consent screen is where a person chooses which worker a connector authorizes.
* Creating the Cowork Routine and obtaining its trigger reference.
* Setting the per-account deployment secret, which is the one step Brain has no
  path to: `fire.ts` resolves a bearer with `process.env[secretName]`, and no
  route, tick or command in this repository can write one.

`docs/workers/CONNECTING-THE-FACTORY-WORKER.md` is the runbook for all three,
step by step, once per account. It is current with the command output as of this
lane, including the fourth verdict.

**One of the four is already commissioned and proven, and that narrows what is
owed.** The parallel lane of §9 establishes it from rows rather than from
memory: the account registered as *Brain Research A* holds the surface
`verify-pool` reports `PROVEN` on `bin_fb9239718e6440c79952`, fired
2026-09-22T13:25:44Z. **Whether that is the owner's own Claude account is a
fact only the owner can state** — if it is, three accounts remain; if it is
not, four do. The reading is attributed rather than re-derived, because two
documents deriving one fact is how they come to disagree about it.

### AWAITING FINAL INTEGRATION AND PRODUCTION DEPLOYMENT

* **Done, and deployed.** Two earlier versions of this bullet were wrong in
  turn and both corrections are kept rather than edited away: the first said
  the branch was unmerged and that `origin/production` was `f727b143`; the
  second said production had advanced to `e37cca06` and stopped there.
  Production is `901a42db`, it contains this integration, and deploy 323
  released it. §0 carries the SHAs, §7 the gate evidence and §8 the live reads.
* No four-account Factory pool has been commissioned in production. The three
  research accounts in `docs/FLEET-12-ACTIVATION-EVIDENCE.md` are a different
  worker identity and a different workload family.
* **A production reading now exists for the half of §2 that an uncommissioned
  pool can establish**, and §8.4 is it: accounts and surfaces as two numbers,
  `PROVEN` as the four-row chain, the pooling caveat printed on a passing run,
  `unanswered=0` on every surface, and each unhealthy surface printing its
  recorded reason.
* **It does not exist for the other half, and that is not rounded up.** The
  quarantine has never fired against a real dead surface; `STALE` has never
  been printed about a real revoked connector; no fire has been routed across
  four accounts. Those need the four accounts to exist, which is the category
  above. The engine passing its tests says nothing about whether the fleet
  behaves this way, which is the separation Step 3 drew and which this lane
  does not get to waive.

---

## 6. The overlaps, as the integration actually found them

Read against `production` at `e37cca06` — the current tip — rather than against
the `9262bbd0` snapshot the lane measured.

* **No migration collision.** Production's chains end at `087` / pg `078`; this
  adds `088` / pg `079`. Production added no migration at all in the
  twenty-two commits between `f727b143` and `e37cca06`.
* **`CLAUDE.md`** — both lanes edit it. Merged: **78 insertions, 0 deletions**
  against production, so the fleet lane's §23 additions land and nothing the
  closeout lane wrote is lost. Checked as a diff rather than trusted to the
  merge.
* **`client/src/russell/Build.tsx`** — both lanes edit it. Merged: **35
  insertions, 2 deletions**. The closeout lane's release-decision card is
  intact; the two deleted lines are exactly the old
  `repo.surfaces.join(', ')` sentence the fleet lane replaces, which is the one
  intended deletion and matches `onboard.ts` widening `surfaces` from names to
  surfaces.
* **`server/services/factory/onboard.ts`** is the fleet lane's alone.
* **Nothing else overlapped.** Forty-six files changed on production's side,
  twenty-seven on the lane's, and the intersection is the two above.

**One observation reported rather than acted on.** `docs/FACTORY.md` says of the
*factory worker registry* — `factoryFleet.ts`, the local-plane executor
registry, which is a different object from `fleet_routines` — that "genuine
failures and no-shows move a worker toward quarantine". That registry has a
failure streak and **no no-show concept at all**. It may be loose wording rather
than a defect, and correcting a sentence about another module's behaviour on a
guess would be worse than leaving it. It is recorded here so somebody can settle
it from the code.

---

## 7. The integration, and the defect it was owed

### 7.1 The vacuous guard, measured rather than characterized

The fleet lane brought `tests/**/*.tsx` into `tsconfig.json`. That is what made
the typecheck read `tests/factoryReleaseSurface.test.tsx` for the first time,
and it reported exactly one error:

```
tests/factoryReleaseSurface.test.tsx(389,5): error TS2322:
  Type '"READER"' is not assignable to type '"OWNER" | "ADMIN" | "MEMBER" | "VIEWER"'.
```

**It is not an authorization gap, and the integration says so as plainly as it
says the rest.** The route requires `WRITE`, `WRITE` requires `MEMBER`, and a
real `VIEWER` is refused. Production was never exposed.

**What it is, is a guard that passed for a role nothing can hold — and that is
a reading rather than a characterization.** `PROJECT_ROLES` is `OWNER`,
`ADMIN`, `MEMBER`, `VIEWER`, so `roleAtLeast` denied `'READER'` through
`PROJECT_ROLES.indexOf(role) === -1`, the unknown-role branch, rather than
through the rank comparison the test exists to exercise. The integration
measured what that cost by mutating `MINIMUM_ROLE.WRITE` from `MEMBER` to
`VIEWER` — a real authorization regression that would let any project viewer
approve a release:

| fixture | against that regression |
| --- | --- |
| `role = 'READER'` (as it stood) | **6 of 6 passed** — blind to it |
| `role = 'VIEWER'` (corrected) | **failed**, `expected 200 to be 404` |

The old form could not have caught the defect it was written to catch, because
the unknown-role branch denies whatever the ranks say.

**The repair does not merely satisfy the compiler.** `VIEWER` is named, and the
two properties that make it the right role are asserted rather than assumed: it
is in `PROJECT_ROLES`, and it still ranks below the `MEMBER` that `WRITE`
needs. Change either and the test fails there, naming the reason. The type
coverage that surfaced it is kept: `tests/**/*.tsx` stays in `tsconfig.json`,
and narrowing it to make the error go away was never on the table.

### 7.2 What the first tick after deploy can do, established before deploying

One thing in this lane *acts* on production rows rather than only reporting
them: the dispatch tick now quarantines a surface whose fires go unanswered.
So the question an integrator has to answer before pushing is whether the
first tick could quarantine a healthy fleet out of history.

**It cannot, and that is a reading rather than a reassurance.**
`unansweredFiresByRoutine` counts `bin_events` rows of type
`DISPATCH_NO_SHOW` with a non-null `routine_id`. Production has **none**:
`grep` over the released tree finds zero occurrences of that string in
`server/`, because production's `reopenNoShowDispatches` only ever set
`last_error_kind = 'NO_SHOW'` on the dispatch row and wrote no event at all.
The event, its attribution and its one writer all arrive with this lane.

So every surface's count starts at zero on the first tick, and a quarantine
needs `NO_SHOW_QUARANTINE_THRESHOLD` fires that Brain sends *after* this
deploy and that nobody answers. The migration is additive, the counter is
derived from an append-only ledger rather than backfilled, and deleting every
`DISPATCH_NO_SHOW` row would return the fleet to exactly what it does today.

§8.3 checks this against the live fleet rather than leaving it as an argument.

### 7.3 What the integrated SHA was gated on

Every figure below is from a run on the integrated tree itself. No green run
from either source branch is reused as evidence for the integrated commit.

**Running the Postgres half is worth one note, because getting it wrong looks
like a code failure.** `postgres-suite.yml` connects as the OS user over the
socket by peer authentication, and the `pg` driver infers that user from the
environment. In a shell where `USER` and `LOGNAME` are unset — a container
running as root is the ordinary case — it infers nothing and every test in the
run fails with `no PostgreSQL user name specified in startup packet`, which
reads exactly like a broken repository layer and is not one. Name the user in
the URL:

```
BRAIN_TEST_DATABASE_URL='postgresql://<user>@/brain_test?host=/var/run/postgresql&sslmode=disable' npm test
```

The cluster also needs `max_locks_per_transaction = 1024`, for the reason
`postgres-suite.yml` measures out in its own comments: the suite gives each
file its own schema and `DROP SCHEMA … CASCADE` takes one lock per object.

| Gate | Tree | Result |
| --- | --- | --- |
| `npm run typecheck` | `3a63fad4` local, `89b34a9d` in CI | clean, with `tests/**/*.tsx` compiled |
| `npm test` (SQLite) | `3d020b42`, the branch tip *at the time* | **4520 passed**, 44 skipped, 210 files passed / 1 skipped, **exit 0** |
| `npm test` (PostgreSQL 16.13) | `89b34a9d` in CI, run 342 | **4564 passed**, 211 files passed, **success** |
| `npm run build` | `3a63fad4` | clean, `index-T4sTcb6M.js` |
| Cross-lane suites | `3a63fad4` | **189 passed**, exit 0 — `factoryPool`, `factoryOnboarding`, `factoryReleaseSurface`, `buildRepositories`, `peopleAndCapacity`, `peopleSection`, `deploymentOwnership` |

**The two totals differ by exactly the 44 SQLite skips**, which is the right
answer rather than a discrepancy: 4520 + 44 = 4564, and the Postgres run has
no skips because the tests SQLite passes over are the ones that need the other
backend. The Postgres run also proves the new migration applies on the chain
production actually carries — `079_routine_no_show_boundary.sql` on top of
`078`, against a real PostgreSQL 16.13 cluster with the lock table the suite
needs (`1024 × (100 + 0)`).

**Which tree each gate ran on is stated rather than smoothed over.** The two
SHAs above differ by one file, `docs/FLEET-FOUR-ACCOUNTS-HANDOFF.md`, and by
no code at all — `git diff --name-only 3a63fad4..3d020b42` returns two
Markdown paths. Every code path in this integration was gated on both
backends.

**This table describes the branch before it landed, and the SHAs in it are
history rather than the current tip.** §7.4 is the gate on what production
actually serves, and it is the one to read for that question. Keeping this
one is the point: it says what was true of the tree each decision was taken
on, which a table rewritten to the latest SHA would destroy.

The cross-lane set is the one the lane measured at **188** in a scratch merge
against the older snapshot; it is 189 here because production's newer commits
added a test to `factoryReleaseSurface`. Both numbers are what they are rather
than reconciled.

**One condition this integration inherited rather than caused, and it will
affect every deploy from here.** The Factory closeout lane's own release, run
316 on `e37cca06`, finished **before** this integration existed:
`release: success`, `beforeRestart: true`, `afterRestart: false`. The
post-restart verification failed at

```
tools/call (brain_submit_audit): nothing answered within 900s.
The request was not refused; nothing answered it.
```

which is CLAUDE.md §27's long-running open reading — the judge pass growing
with the archive — now past the fifteen-minute bound §27 itself added. That
run measured both halves and adds two points to §27's table:

| half | archive | ADVERSARIAL → verdict |
| --- | --- | --- |
| pre-restart | 415 documents | **12m25s**, and it passed 229/229 |
| post-restart | 431 documents | **over 15m**, the bound |

**And it has since been diagnosed and fixed by the lane that hit it**, which
this integration then merged and carried into the same deploy. The cause was
`recomputeProject` asking the document store about each document three times
per recompute, with the judge path recomputing twice — roughly 2 600 serial
bucket round trips on a four-hundred-document project. `b4615e62` makes one
recompute ask once. So this integration's own deploy is the first chance to
see whether the post-restart half comes back; §8.2 says how that is read
either way. Nothing here raises the bound, which §27 forbids by name.

**The Postgres half was run in CI rather than locally, deliberately.**
`postgres-suite.yml` is the repository's own gate, it runs `npm ci` on a clean
checkout, and it can be pointed at an exact SHA — so it answers a stronger
question than a local run on a working tree. It was dispatched on this branch
and is run 342. Locally, the fleet, pool and arrival suites had already gone
green on PostgreSQL 16.13 (**120 tests**, 69 + 51) before that, which is the
part of the suite this lane's migration and derived counter actually touch.

<!-- CI-EVIDENCE -->

### 7.4 The gate on the SHA production actually serves

The table above is the integrated branch. **`production` is now `901a42db`,
and it contains this integration** — `ba5c0b2f` is an ancestor of it, checked
with `git merge-base --is-ancestor` rather than asserted, and every file and
symbol this lane added reads back at that tip: `088_routine_no_show_boundary.sql`
and `pg-migrations/079_…`, `unansweredFiresByRoutine`, `no_shows_forgiven_at`,
`PoolVerdict`, `accountsServing`, `role = 'VIEWER'` in
`tests/factoryReleaseSurface.test.tsx`, and `"tests/**/*.tsx"` in
`tsconfig.json`.

So the gate that matters is the one on **that** SHA, and it exists:

| Gate | SHA | Result |
| --- | --- | --- |
| `npm run typecheck` (CI) | **`901a42db`** | clean |
| `npm test` (PostgreSQL, `postgres-suite.yml` run 369) | **`901a42db`** | **215 files / 4632 tests, all passed**, 2414s, `success` |
| `npm run typecheck` + `npm test` + `npm run build` (`deploy.yml` `verify`) | **`901a42db`** | passed — the release job would not have run otherwise |
| `npm test` (SQLite, local) | `3d020b42`, this branch's tip | 4520 passed, 44 skipped, exit 0 |

Run 369 fired on `production`'s own push trigger, so it is the repository's
gate answering about the repository's canonical tip on a clean runner — which
is a stronger reading than a local run on a working tree, and it makes the
local Postgres attempt on the branch redundant rather than missing. Its last
step confirms the suite dropped everything it created.

**No green run from either source branch is reused as evidence for the
integrated commit**, and no gate was weakened, skipped or narrowed to obtain
any of these.

### 7.5 What is proven where

**Proven in code and tests** — schema on both chains, the router, project and
worker isolation, the capacity proofs, quarantine and its answering transition,
the identity and authentication checks, the Build and operator surfaces, the
migrations, the documentation. Gated on both backends on the SHA production
serves.

**Proven in production** — §8 is the reading rather than the plan now. The
integrated image is live and serving; the machinery this lane added answers
from the deployed rows; and it tells the truth about an uncommissioned pool
on a run that *passes* rather than only on one that fails.

**Not proven, and not claimed** — that four real Claude accounts run as one
Factory fleet. No such pool has been commissioned. The quarantine has never
fired against a real dead surface and `STALE` has never been printed about a
real revoked connector. The engine passing its tests says nothing about
whether the fleet behaves this way, which is the separation Step 3 drew and
which this integration does not get to waive. §5's
**AWAITING HUMAN ACCOUNT / CREDENTIAL AUTHORIZATION** list is unchanged and
unticked.

---

## 8. The release, and what it measured

This section was a set of instructions for the next session. It is a record
now. Where a prediction it made turned out wrong, the correction is here
rather than edited into the prediction.

### 8.1 `production` was advanced by the guarded fast-forward

Two attempts from this session were refused by its own permission layer — the
`git push` and the forge's `PATCH …/git/refs/heads/production` with
`force: false` — and no third route was tried, because a third route would
have been working around the refusal rather than around a tool. The operator
then authorized it explicitly, and it went the way §28 says:

```
git fetch origin production
git merge-base --is-ancestor origin/production integration/fleet-four-accounts   && git push origin integration/fleet-four-accounts:production
```

`production` was never checked out to advance it.

**Production moved ten times while this was being done** — `f727b143` →
`e37cca06` → `6f489918` → `41f4373f` → `533463f3` → `901a42db` → `e8e066ea` →
`662d3373` → `96b1bfcd` → `67089909` → `08d6a787` — each move requiring a fresh
merge and a fresh fast-forward check, and every one of them verified as a real
ancestor of the current tip rather than transcribed from notes. An earlier
version of this sentence said four, over a list that already showed five
arrows, and a later one said seven; both are corrected rather than edited away,
because a document about reconciling against a moving target should not be
wrong about how far it moved. The integration was
re-merged and re-verified each time rather than re-derived, and it survives at
the final tip, checked file by file and symbol by symbol rather than assumed.

### 8.2 The release: three facts, read as three

**Deploy run 323, `901a42db`.** `release: success`. `beforeRestart: true`.
`afterRestart: false`.

**The pre-restart half is a complete pass and is the strongest single reading
this release produced: `HOSTED-VERIFICATION: PASS 229/229`** on the released
image, including the judge pass, `434 claim(s) across 434 readable
document(s)`, and the work and campaign deliberately left behind for the pass
after the restart.

The post-restart failure is **not** the condition §7.3 predicted, and saying
so precisely matters more than the prediction being nearly right. It got a
long way — 08:57:49 to 09:13:17, the archive read at 434 documents, a worker
claiming the planning job over MCP, the assignment handed to it, fragments
proposed against the live archive and a coverage row recorded — and then:

```
(ECHECKOUTTIMEOUT) unable to check out connection from the pool after
15000ms in Session mode
  in: SELECT * FROM research_fragments WHERE orchestration_id = $1 …
```

which is a pooler condition and not the judge pass at all.

**An earlier version of this section named `BRAIN_DATABASE_POOL_SIZE` as the
remedy. That was wrong, and the correction is here rather than edited into
it.** Two things say so. The message carries **no pool statistics** —
CLAUDE.md §27 added `describePoolExhaustion` precisely so that Brain's own
pool prints `N/M in use, X idle, Y waiting, ceiling M`, and this prints none
of it, while `ECHECKOUTTIMEOUT` and *Session mode* are Supavisor's own
vocabulary. So the refusal is **upstream of Brain's client pool** rather than
Brain's pool running out. And §27 has already settled the knob on its own
terms: the secret is unset, so `readPoolSize()` answers its default of ten,
ten of the pooler's fifteen is the arithmetic that leaves room for the
operator script's two, and *"ten is both the intended default and the highest
defensible value"*. **Raising it would make this worse, not better.**

**My own console reads did not contribute, which I checked rather than
assumed.** `fleet` runs 282, 283 and 284 executed at 09:14:27, 09:16:21 and
09:18:48 — all *after* the 09:13:17 failure — and run 281 waited on
`await-release` and ran at 08:50:5x, before the pre-restart verification that
then passed 229/229. Run 282 failing to reach the database at 09:14:27 and
succeeding at 09:16:21 is the same pressure seen from a second place, and it
dates the condition as transient: present around 09:13 to 09:15, gone by
09:16.

**So there is no operator action named here for it**, which is the honest
answer rather than a convenient one. What remains is an open reading: the
condition is real, it is upstream of anything this repository sets, and
§27's own investigation is where it belongs.

**What this release did close is the silence around it, in two places, and
neither changes the condition.** §27 built `describePoolExhaustion` and
`describePoolerRefusal` so that *"the next occurrence turns into a number
instead of a seventh anecdote"*, and on this occurrence neither fired: Brain's
own pool had not timed out, and the marker was `ECHECKOUTTIMEOUT` rather than
`EMAXCONNSESSION`. **A mechanism that does not reach the condition it exists
for is not a mechanism**, so `describePoolerRefusal` now names that fourth
condition apart from the third — one is the pooler refusing a client outright,
the other is the pooler accepting one and failing upstream, which a database
that has merely gone slow also produces.

And the two console reads did **not** fail that way, which I first wrote that
they did. They failed on the boot path, before any statement, with
`Connection terminated due to connection timeout` wrapped in *"could not
reach"* — no pooler marker to match, and `hintFor` had no branch for a timeout
either, so the whole message pointed at the address and the network while the
host was answering `/healthz` in 0.38s. That branch exists now, it contradicts
the sentence it attaches to, and it names raising the ceiling as the wrong
remedy. Both are pure and diagnostic: `hintFor` has exactly one call site and
it is inside an error's detail string, and nothing anywhere branches on either
text.

**Because the judge pass came back, and the number is the point.** §27's table
records this deploy's predecessor at **12m25s over 415 documents**, and run
316's post-restart half exceeding the fifteen-minute bound at 431. On the
released image:

| half | archive | ADVERSARIAL → verdict |
| --- | --- | --- |
| run 316 pre-restart | 415 documents | 12m25s |
| **run 323, this image** | **434 documents** | **1m42s** — 08:52:40 → 08:54:22 |

A larger archive and a seventh of the time. That is the repair proved on the
deploy that carried it, which is exactly the reading §7.3 said this release
was the first chance to take.

**It is two repairs rather than one, and saying so matters.** `901a42db`
carries the existence memo *and* the statement-count fix that followed it —
`withExistenceMemo`, `documentIdsWithAudits` and `tests/auditRoundTrips.test.ts`
all read back at that SHA. CLAUDE.md §27 records the memo alone reaching 2m56s
pre-restart at deploy 318 and still dying after the restart, so crediting
1m42s to the memo would claim a repair had been proved that had not. An
earlier version of this paragraph did exactly that; the correction is here
rather than edited into it.

**The image was proved independently of the gate**, which is what §27 says to
do when the gate is the thing that is stuck. The served bundle is
`assets/index-T4sTcb6M.js`, byte-for-byte what `npm run build` on the
integrated tree produces, replacing the pre-deploy `assets/index-DYLLmYzP.js`;
`index-Dzwb3x6t.css` is unchanged on both, because this integration changes no
CSS.

### 8.3 An outage this integration did not cause, and the timeline that says so

Production answered 503 for roughly two hours during this window. It is
recorded here because a reader finding it later would otherwise attach it to
the deploy that happens to sit in the middle of it.

The Brain boots cleanly on the released image — migrations applied at
07:19:26, health passing at 07:19:38 — and cannot survive the restart 36
seconds afterwards while the previous process still holds its Supabase
connections. **And the database was already timing out statements at
06:07:32**, twenty minutes before this deploy's own run started at 06:27:39.
So the condition preceded the release and the release did not introduce it.

**What the remedy is, is not established, and the obvious one is refused.**
No workflow in this repository can set `BRAIN_DATABASE_POOL_SIZE` — every
`flyctl secrets` invocation was read: `logs.yml` refuses `set` and `unset` by
whole-command form, `step10-activation.yml` sets three hardcoded Routine
secrets and no others, and `deploy.yml` only unsets the bootstrap pair. But
per §8.2 raising it is the wrong move anyway, so that is a boundary rather
than a blocker, and naming it as an action for somebody would be handing over
a remedy that makes the condition worse.

**The restart window itself reproduced a reading §20 already records, which
is what makes it a property of the swap rather than of either run.** Measured
from outside the runner while deploy 324 replaced the machine, 2026-09-23
around 10:03Z: `GET /healthz` answered **503 after 35.1s**, again after
**35.6s**, again after **35.4s**. §20 records 503 after **35.7s** twice during
deploy 305 on 2026-09-21. Two days, two deploys, the same wall — so a worker
fired into that window sees exactly what that section describes, and asking
again is the answer.

Production returned at **08:50:33** and answered `/healthz` in about 0.4s on
every probe for the next ninety minutes — and then went down again at 10:03
for the reason §8.5 records, which is a different cause with the same
symptom. The two are kept apart deliberately: this one was a restart landing
on a database already timing out, and that one was Supabase's storage API
refusing to answer at all. `/api/auth/login` with a deliberately wrong credential
answers `HTTP 401` with the PIN sentence — the app serving and reading
Postgres — though it took 24.27s to do it, which is the same pooler pressure
seen from the front door.

**One correction of my own, recorded rather than quietly dropped.** I wrote
that §28's second canonical guard would refuse deploy 318. It did not and
could not: it had already passed at 05:29:44 and released at 05:33:18, before
`production` was advanced. I also reported run 320's pre-restart verification
as passing; its step 13 reads `failure`. Both are corrected here.

**The guard did fire in anger, on a different run.** Deploy 322 passed the
first canonical asking on `533463f3`, spent its test gate, and was refused at
the second because `901a42db` had landed in between. That is §28's run-283
defect being prevented rather than recorded.

### 8.4 The live reads, against the deployed image

**`fleet verify-pool --repository Peyday007/V5`**

```
FLEET: OK verify-pool peyday007/v5 VERIFIED surfaces=1
  accounts 1 · surfaces 1
  PROVEN  Factory surface 1 (Brain Research A)
          fired    2026-09-22T13:25:44.296Z
          arrived  oat_2ff2d3fb33b34072b16f at 13:26:17.177Z
          assigned and completed bin_fb9239718e6440c79952
  NOTE  Only one surface is registered for this repository, so nothing here
        is pooled.
```

Three things in that are the lane's own repairs, read back from production
rather than from a test. **`accounts` and `surfaces` are two numbers**, so
three Routines on one subscription can no longer read as three accounts.
**`PROVEN` is the four-row chain** — fired, arrived, assigned, completed —
rather than a configuration block. And **the caveat printed on a run that
passed**: before §29's repair it was pushed onto `problems`, which `ok` does
not count, so the one run where a reader could mistake `VERIFIED` for *pooled*
was the only run that never said otherwise.

**`fleet show`**

```
accounts 6 · routines 18 · target 12 · in flight 0
candidates 16 considered, 12 eligible now
```

with, per surface, **`unanswered=0` everywhere**. §7.2 established that from
rows before the deploy rather than hoping for it: production has never written
a `DISPATCH_NO_SHOW` event, `unansweredFiresByRoutine` filters
`routine_id IS NOT NULL`, so every counter starts empty and the new quarantine
cannot fire against history. It did not.

Beside it, the surfaces that are *not* healthy say why, which is §29's
`state_reason` repair: `V2 QUARANTINED` printing *"sessions complete without
checking in operator hold"*, two surfaces reading `MISSING SECRET`, and the
retired `V1-oak` pair carrying their retirement reasons. Six accounts —
`primary`, `friend-2`, `verify-hosted-account-a` and `-b`, and two friend
accounts holding four Routines each.

**No surface reads `PROVEN` or `HEALTHY` on configuration alone**, which is
the whole point of §2.1, §2.4 and §2.7 and is the one thing a production
reading of an *uncommissioned* pool can genuinely establish.

#### The counter then earned its keep, which the first reading could not show

The reading above was taken on the first tick, when §7.2 had already
established from rows that every counter would be zero. A second `fleet show`
at **12:13Z**, after a morning that included two outages and a great many
fires that nobody answered, reads differently — and the difference is the
whole repair:

```
accounts 6 · routines 18 · target 12 · in flight 7
candidates 16 considered, 12 eligible now

  Brain Research A     worker=wkr_1cdd82cf…   unanswered=1
  Brain Research 1-B   worker=wkr_1cdd82cf…   unanswered=1
  Brain Research 1-C   worker=wkr_1cdd82cf…   unanswered=0
  Brain Research 1-D   worker=wkr_1cdd82cf…   unanswered=0
  Airyn 2-A … 2-D      worker=wkr_1cdd82cf…   unanswered=2  (each)
  Factory surface 1    worker=wkr_f8e118e8…   unanswered=0
  … every other surface 0
```

**Nine of those Routines are bound to the same worker identity and they carry
four different counts.** That is exactly what the column this lane replaced
could not do: `recordWorkerArrival` cleared `consecutive_no_shows` for *every*
Routine bound to the same worker, so under the old reading these nine would
have agreed with each other by construction. They do not, because
`unansweredFiresByRoutine` counts `DISPATCH_NO_SHOW` rows that now carry the
Routine that was fired — §2.5 and §2.7, demonstrated by a real event rather
than by a test.

**And none of them has reached the threshold**, which is the other half
working. Three unanswered fires quarantine a surface; the highest here is two,
and the cause was an upstream store outage rather than a dead connector. A
counter that had walked these surfaces into quarantine for somebody else's
incident would have been the defect §23 warns about — *a refusal is not
misconduct* — arriving one table along.

#### And the parallel lane's D2 is latent here, which is a measurement rather than a hope

§9 records that the deployed `routeBin` cannot exclude a Routine bound to a
**disabled** worker, and left the `12 eligible now` figure qualified. The two
reads together settle it. `npm run admin -- workers list` on production
returns ten workers: one `ARCHIVED` holding no project, three `DISABLED` each
still holding one — `worker-01`, `worker-02`, `worker-06` — and six `ACTIVE`.
Every Routine in `fleet show` resolves to one of five workers, and **all five
are `ACTIVE`**; the three disabled ones are bound to no registered Routine at
all.

So the condition D2 describes has **no instance in this fleet today**, the
`12` is correct as it stands, and the qualification in §9 is discharged by
measurement rather than removed. The defect is still real and still worth
their fix — it is one `bind-worker` away from biting.

### 8.5 Deploy 324 did not release, and the reason was upstream

`release: failure`, `hosted verification: skipped`, `after the restart:
skipped`. The verdict step says it plainly — *"No new image was released"* —
and that is the first of these runs where the release itself did not happen,
so it is read differently from the four before it.

**`flyctl deploy` was refused by the health check, twice.** The machine
reached `started` both times — 09:59:11 and 10:05:51 — smoke checks ran, and
then five minutes of *Checking health* ended at 10:04:19 and 10:11:04 with
`Unrecoverable error: timeout reached waiting for health checks to pass`. In
between, the Depot builder never answered and the workflow fell back to Fly's
own remote builder, which is the tolerated failure `deploy.yml` already
handles and is **not** what failed the run.

**The Brain's own log says why, and it is not this commit.** At 09:59:18 and
again at 10:06:03:

```
Brain could not use the document storage it was configured for.
The document store could not be checked (HTTP 544).
{"statusCode":"544","error":"DatabaseTimeout",
 "message":"The connection to the database timed out","code":"DatabaseTimeout"}
[brain] Serving the migration error on http://localhost:8080 — nothing else will work.
```

That is **§18 working exactly as written**: cloud mode does not fall back, so
a store that cannot be checked stops the boot with the reason rather than
letting a server report itself as cloud-backed while the work goes somewhere
nobody else can see. The migration error is not a 200, so the health check
fails, so `flyctl deploy` refuses the release. Each link is the design.

It is also a condition CLAUDE.md §27 already records by name — *"the next
release could not boot because Supabase's own storage API answered `544
DatabaseTimeout`"* — so this is the second observation of it rather than a new
shape.

**What this release contained is worth saying, because it bounds the
suspicion.** `901a42db..662d3373` is four files: `CLAUDE.md`, this handoff,
`scripts/manufacturing.ts` (a header correction) and `tests/laborSurface.test.tsx`.
No server code, no client code, no migration. A tree that cannot cause a
storage-API timeout.

**The outage is real and is stated rather than softened.** The machine was
updated to the new image at 10:05:40 and that image cannot boot while the
store is unreachable, so `/healthz` answered `503 after ~35s` on every probe
from 10:03 to 10:15 — eleven consecutive readings, all within 35.1s–35.7s,
which is the same wall §20 records twice at 35.7s during deploy 305 two days
earlier. The verdict's sentence *"the app is still serving the previous
version"* is the one part of this run that is not accurate here: the machine
had already been updated, so there was no previous version left on it to
serve.

**The recovery is a retry, and the evidence for retrying is a credential-free
probe.** Unauthenticated `GET https://…supabase.co/storage/v1/bucket`
answered `400 InvalidRequest — headers must have required property
'authorization'` in **0.23s, 0.46s and 0.49s** at 10:16:2xZ. So Deploy was
re-dispatched on the **same commit** — recovery changes one thing at a time,
and the thing to change was the attempt rather than the tree.

**I claimed more for that probe than it can carry, and the correction
matters because the next person will reach for the same probe.** I wrote
that *"a storage API that replies correctly and immediately is one whose own
database connection is working"*. It is not. A `400` for a missing
`authorization` header is refused at request validation and need never touch
a database at all, so the probe establishes that the storage service is up
and reachable and says **nothing** about the condition `544 DatabaseTimeout`
actually names. It was the right action for a weaker reason: an upstream that
had been unreachable was answering again, which makes a retry worth one
attempt — not evidence that the retry would succeed.

And the weakness showed. The release went through and the Brain came back at
10:38:48, and then `deploy.yml`'s own restart — the step that exists so
persistence means something — took it down again at about 10:43 and it had
not returned fifteen minutes later, with the same unauthenticated probe still
answering `400` in 0.42s throughout. Whatever is slow is behind an
authenticated call that probe does not make.

**Nothing here is a reason to lower a bar.** The boot refusal is the control;
making it tolerate an unreachable store would trade a visible outage for a
Brain that looks healthy and writes where nobody can see. The remedy is to
retry once the upstream answers, which is what was done.

**The retry worked, and the release it was carrying went with it.** Deploy
325, same commit, no other change: the gate passed, both canonical askings
passed, `flyctl deploy` **succeeded**, and `Record what was released` ran.
Production answered `503` for the last time at 10:38:13 and `200 in 4.61s` at
**10:38:48** — the cold-start tail §20 describes — then 0.25s, 0.16s, 0.16s.

**The outage is dated from the machine rather than from when I first looked.**
It began at **09:58:55**, when the machine pulled the first new image and the
old process went away, and the Brain refused to boot twenty-three seconds
later; it ended at **10:38:48**. That is **thirty-nine and a half minutes**.
An earlier version of this paragraph said "about 10:03", which was the first
probe I happened to take — a reading of my own attention rather than of the
event, and four minutes short.

The served bundle is `assets/index-T4sTcb6M.js` with `index-Dzwb3x6t.css`,
**unchanged**, which was the prediction rather than a surprise:
`901a42db..662d3373` touches no client file, so the bundle hash cannot
distinguish this release and the proof of what is live has to come from
somewhere else — `BRAIN_REVISION`, which every `scripts/*-report.sh` prints
as `SERVING_REVISION`.

### 8.6 It is a standing upstream condition, not a one-off, and the record says so

The retry above worked and then the *same* run undid it. `deploy.yml`'s
restart — the step that exists so persistence means something — took the
Brain down at 10:42:30, and at **10:51:04** its log reads, word for word,
what it had read at 09:59:18 and 10:06:03:

```
Brain could not use the document storage it was configured for.
The document store could not be checked (HTTP 544).
{"statusCode":"544","error":"DatabaseTimeout", …}
[brain] Serving the migration error on http://localhost:8080 — nothing else will work.
```

`Wait for it to answer after the restart` then failed after thirty attempts,
and `/healthz` was still `503` half an hour later.

**So the condition is intermittent rather than cleared, and the 10:38:48
recovery was a window rather than a fix.** Three boots failed on it and one
succeeded, on one image, inside forty minutes. That also settles what the
image is: `Prove the live Brain is actually shut` **passed** against this
exact release at 10:39–10:42, so `662d3373` boots and serves and the
verification harness agrees. What follows a restart is not about the commit.

**And it is precisely the authenticated call my probe does not make.** The
unauthenticated storage `400` kept answering in 0.42s throughout, while the
Brain's own bucket check — which reaches storage's database — timed out. Two
facts about one service, and only the second is the one that decides whether
this Brain may boot.

**And the upstream says so itself, which takes this out of inference
entirely.** `status.supabase.com` reports **Partially Degraded Service** with
an open incident — *"Storage search failing for restored projects"*,
component **Storage: degraded_performance**, opened **09:31:49Z**, *"Users
may experience increased 500 errors"* — moved to `monitoring` at 10:20:36Z
with *"A fix has been implemented for the affected tenants and we are
monitoring the results."*

Against Brain's own timeline that is conclusive rather than suggestive:

| when | what |
| --- | --- |
| 09:31:49Z | Supabase opens the Storage incident |
| 09:58:55Z | the machine takes the new image; 09:59:18Z the Brain refuses to boot on `544` |
| 10:06:03Z | second refusal, same words |
| 10:20:36Z | Supabase: *a fix has been implemented … monitoring* |
| **10:38:48Z** | **the Brain boots and serves** — the window |
| 10:39–10:42Z | the pre-restart hosted verification **passes** against it |
| 10:42:30Z | `deploy.yml`'s restart |
| 10:51:04Z | refuses to boot again, same `544` |

So the successful boot sits inside the eighteen minutes after Supabase said
it had shipped a fix, and the next failure sits after it. The condition is
theirs, it is acknowledged, and it was not fully cleared for this project.

**Nothing here is a reason to weaken the check**, for the third time in this
section: a Brain that booted past an unreachable store would accept research
and write it where nobody can find it, which is the outcome §18 exists to
prevent and is strictly worse than being visibly down. What is owed to the
operator is the reading and the one thing only they can do about somebody
else's incident — watch it, and escalate it to Supabase if it does not clear.
§8.8 is the cost of each retry while it has not.

### 8.7 It came back, and what came back is the whole tree

Deploy 327, on **`67089909`** — the fleet integration, both diagnosis fixes,
the deploy classifier and the other lanes' work merged in. Production
answered `503` for the last time at 11:44:31 and **`200 in 12.31s` at
11:45:25**, then 0.15s steadily. The second outage ran 10:42:30 → 11:45:25:
**sixty-three minutes**, all of it the upstream condition and none of it
recoverable faster than a full `Deploy`, which is §8.8.

**Two retries were spent on it — deploys 325 and 327 — and the boot is a coin
toss while that incident is open.** Counted from the Brain's own log rather
than from impressions: refused at 09:59:18 and 10:06:03, booted at 10:38:48,
refused at 10:51:04 after the restart, booted at 11:45:25. **Three refusals
and two successes**, on images whose pre-restart verification passes every
time it gets to run.

### 8.8 The recovery floor is forty minutes, and that is a gap rather than a fact of life

Worth recording because this incident measured it. **There is no supported
way to restart the deployed Brain short of a full `Deploy`.** `deploy.yml` is
the only workflow that restarts anything — every other one is a read behind
`await-release` — and its restart sits on the far side of a nineteen-minute
test gate and a build.

So a condition whose actual remedy is a thirty-second process restart, which
is exactly what this was once Supabase answered again at 10:16, has a
recovery floor of roughly forty minutes. Twenty-two of those minutes were
spent re-proving a tree that had already passed the identical gate on the
identical commit an hour earlier.

**It is recorded rather than built, and the reason is the reason.** Adding a
remote-exec or a restart path to production, unreviewed, during an incident,
is precisely how a console accumulates — §26's whole argument, and *"each new
thing arrives because the page is already there"*. The decision about whether
this Brain should have a guarded restart operation belongs to the owner, made
when it is cheap rather than when something is down.

**A second change would have prevented today's outage outright, and it is
deliberately proposed rather than made.** The boot asks the document store
once. A bounded retry with backoff — three attempts, say, and then the same
refusal with the same reason — would turn a transient upstream blip into a
slower boot instead of a dead machine, and it would have absorbed both of
today's failures: the store answered normally at 10:38 and again whenever the
unauthenticated probe was taken.

It is **not** made here, and the argument against is stronger than the
convenience. §18 is one of this file's most emphatic controls and its whole
content is that the boot fails loudly rather than tolerates. A retry does not
contradict its text — *"a bucket that does not answer"* after three attempts
is still a bucket that does not answer — but it is a change to a deliberate
refusal's behaviour, and the moment to make that change is not while
somebody is under pressure to get production back. That is exactly when a
small tolerance looks like a good idea and exactly when it should not be
decided. It is the owner's call, and the evidence for it is this section.

#### The Factory reads, against the deployed image

`factory campaigns`, with no `--project`, which is the reading run 78's fix
exists for — every project rather than whichever one the list returned first:

```
prj_9d86dfaec863473cb498 Deal Dispatch
  fcp_189ea30c7ded4e7b9280 REMOTE COMPLETE   https://github.com/Peyday007/V5/pull/31
  fcp_bd1725a9b19b4688ac8e REMOTE CANCELLED  (no pull request)
  fcp_84a56713cb174607970d REMOTE COMPLETE   …/oakwood-junk-removal/pull/1
  fcp_05bc1b50de0f460680ec REMOTE CANCELLED  #1
prj_3a90638acbb544ecb74b Verification scope
  fcp_bb1fda90085a4d3fb97a LOCAL  COMPLETE   (no pull request)
FACTORY: OK
```

`factory status --campaign fcp_189ea30c7ded4e7b9280` — **COMPLETE, reviewed
and confirmed by the forge**, base `58c6deccf11f -> 6f92e7968fa5`, **4/4 units
integrated** with 0 ready, 0 leased and 0 failed, **13 sessions, max observed
concurrency 2 (MEASURED)**, two review rounds, two findings both `REPAIRED`,
and **`paid-API executions recorded: 0`**.

Several things in that output are this repository's own rules being obeyed
where it counts, and they are worth naming rather than skimming:

- **The two review rounds report different independence tiers** —
  round 1 `CHANGES_REQUIRED` at `WORKER_SEPARATED`, round 2 `PASS` at
  `SESSION_SEPARATED` — each against a named session. Neither is rounded up
  (§27).
- **Both findings resolve to a commit**, not to a worker's say-so: the BLOCKER
  *"repaired by `repair-late-link-never-attested` at `95b87eaa…` and verified
  on the merged tree"*, the MAJOR likewise at `6f92e796…`.
- **The refusal is on the record beside the successes.** `REFUSED
  INTEGRATION_REJECTED` on `bin_0b6cdc2502d54b75b8c1` — *"the merged unit is
  not one of the units this bin was given"* — which is the duplicate
  integration bin CLAUDE.md §27 documents, still readable months later.
- **Thirteen sessions carry worker, account, bin, generation and duration.**
  Three of them read `account UNKNOWN`, which is the honest half of §23's
  attribution repair rather than a gap being hidden. The durations are the
  ones §27's bin-lease floor was set from: 695s, 1803s, 1051s, **1356s**,
  1291s, 1622s, 1153s.

`factory throughput --campaign fcp_189ea30c7ded4e7b9280`, and **every figure
carries its evidence class**, which is the whole honesty requirement of §23
and §27 read back from production:

```
units per hour              0.16       DERIVED
session duration total ms   11513592   MEASURED   (13 samples)
session duration average ms 885661     DERIVED
queue time average ms       not measured  UNKNOWN
max observed concurrency    2          MEASURED
concurrency declared        3          UNKNOWN    a declared target, never
                                                  evidence of what overlapped
ceiling                     not measured  UNKNOWN
rate-limited sessions       0          PROVIDER_ENFORCED
```

**`concurrency declared 3` is labelled `UNKNOWN` beside a `MEASURED` 2.** That
is the sentence §27 wrote — *the sum of declared concurrency is a projection
and is never reported as throughput* — printed by the deployed code without
anybody having to remember it.

`factory events --campaign fcp_189ea30c7ded4e7b9280` returns **43 events**,
each stamped `MEASURED` and carrying its payload: the plan bin, each
`UNIT_PLANNED` with its owned paths, `UNIT_READY` with *"dependencies
integrated"*, `UNIT_IMPLEMENTED` with the branch and head commit, and each
`FACTORY_BIN_CREATED` with the contract and why it was made.

**What these reads do not establish** is anything about a four-account Factory
pool, and they are not offered as though they did. Every session above belongs
to one worker, `wkr_f8e118e87fd141689adc`, on one account.

<!-- FACTORY-READS -->

---

## 9. A parallel lane found four defects in this one's code, and one qualifies §8.4

`claude/fleet-four-account-acceptance-uey8cw` is a second session on the same
subject, taken against production `533463f3` — which already contained this
integration through `ba5c0b2f`. It tested the shape this lane did not: **four
people each holding their own connector, and therefore their own worker**,
where this lane proved one worker identity served by several accounts. It
found four defects, all of this lane's own class — correct machinery, a false
sentence about it — and `docs/FLEET-FOUR-ACCOUNT-ACCEPTANCE.md` on that branch
is its record. That document already reconciles with this one, and correctly:
it says this handoff still stands and that its §8 is overtaken.

**It is gated and unlanded.** Full SQLite suite 4597 passed on `602f9680`,
`postgres-suite.yml` run 367 at 215 files / 4641 passed with typecheck clean,
build clean. There is no open pull request for it, and the branch has moved
since that run, so **the session that owns it is still working.** Nothing here
merges it: taking a live lane's work onto `production` out from under it is
the cross-lane collision §28 is written from, and a gate somebody else has not
finished asking for is not mine to answer.

**One of its findings bears directly on a number in §8.4, and the number is
therefore qualified rather than left standing.** Its D2: a Routine bound to a
**DISABLED** worker is routable on the deployed code. Archiving a worker
revokes its memberships, so `servesProjects` already takes an archived one out
— but disabling is reversible and *keeps* them, so the deployed `routeBin`
checks the account's state, the Routine's state and the served project, and
has nothing that can see a disabled bound worker.

`fleet show`'s `candidates 16 considered, 12 eligible now` is computed by
running a real `routeBin` probe per candidate, which is a stronger reading
than the Fleet page's and is still that `routeBin`. So **12 is what the
deployed code computes, and the deployed code cannot subtract a surface whose
bound worker is disabled.** The error, if any, is in the direction of
overstating. This is recorded rather than re-measured here because the remedy
is that lane's `surfaceIneligibility` — one bin-independent answer asked by the
router, the capacity reading and the page alike — and re-deriving it in this
document would be the second reader of one rule that both lanes exist to stop.

Nothing else in §8.4 is affected. The unanswered counters are read from
`bin_events`, `verify-pool`'s `PROVEN` is the four-row chain, the
`state_reason` lines are the rows' own words, and `accounts 1 · surfaces 1`
counts two things that are not each other. None of those passes through the
eligibility predicate.

**And the qualification is now discharged by measurement rather than left
standing.** §8.4 records the cross-reference: ten workers on production, three
of them `DISABLED` and still holding a membership — so the defect is real —
and every one of the five workers any Routine is actually bound to is
`ACTIVE`. The condition has no instance in this fleet today, the `12` is
correct as it stands, and their fix is still worth landing, because it is one
`bind-worker` away from biting.

**What the two lanes agree on, and it is the thing that matters most:** no
four-account Factory pool has been commissioned, and neither document claims
one has.
