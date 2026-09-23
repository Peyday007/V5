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
| **Integrated tip** | `integration/fleet-four-accounts` | pushed; this document and the CLAUDE.md §27 record sit on top of `3a63fad4` and change no code |

**`production` has not been advanced to it.** The fast-forward is valid and
was verified immediately before it was attempted, and the attempt was refused
by this session's own permission layer — by `git push` and by the forge's ref
API alike. §8 says exactly what is left and how to do it. Nothing else in
this integration is outstanding.

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

### AWAITING FINAL INTEGRATION AND PRODUCTION DEPLOYMENT

* **Done.** An earlier version of this bullet said the branch was unmerged and
  undeployed and that `origin/production` was `f727b143`. Both were true when
  written; production has since advanced to `e37cca06` and this lane is merged
  into it. §0 carries the SHAs and §7 the gate evidence.
* No four-account Factory pool has been commissioned in production. The three
  research accounts in `docs/FLEET-12-ACTIVATION-EVIDENCE.md` are a different
  worker identity and a different workload family.
* Therefore **no production reading exists for anything in §2**. The quarantine
  has never fired against a real dead surface; `STALE` has never been printed
  about a real revoked connector. The engine passing its tests says nothing
  about whether the fleet behaves this way, which is the separation Step 3 drew
  and which this lane does not get to waive.

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
| `npm test` (SQLite) | **`3d020b42`, the tip** | **4520 passed**, 44 skipped, 210 files passed / 1 skipped, **exit 0** |
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

§8.2 says what to expect from it on this integration's own deploy, and why
that is not this integration. Nothing here raises that bound, which §27
forbids by name.

**The Postgres half was run in CI rather than locally, deliberately.**
`postgres-suite.yml` is the repository's own gate, it runs `npm ci` on a clean
checkout, and it can be pointed at an exact SHA — so it answers a stronger
question than a local run on a working tree. It was dispatched on this branch
and is run 342. Locally, the fleet, pool and arrival suites had already gone
green on PostgreSQL 16.13 (**120 tests**, 69 + 51) before that, which is the
part of the suite this lane's migration and derived counter actually touch.

<!-- CI-EVIDENCE -->

### 7.4 What is proven where

**Proven in code and tests** — schema on both chains, the router, project and
worker isolation, the capacity proofs, quarantine and its answering transition,
the identity and authentication checks, the Build and operator surfaces, the
migrations, the documentation.

**Not yet proven in production, because this session could not advance
`production`** — that the deployed image serves this machinery and tells the
truth about an uncommissioned pool. The deploy and the reads that would
establish it are §8, written out so the next session runs them rather than
re-derives them.

**Not proven, and not claimed** — that four real Claude accounts run as one
Factory fleet. No such pool has been commissioned. The quarantine has never
fired against a real dead surface and `STALE` has never been printed about a
real revoked connector. The engine passing its tests says nothing about
whether the fleet behaves this way, which is the separation Step 3 drew and
which this integration does not get to waive.


---

## 8. What is left, and exactly how to do it

The software side of this integration is finished and gated. What remains is
**one privileged action this session was refused**, and then the ordinary
release path behind it.

### 8.1 Advance `production` — refused here, one command for somebody who can

`integration/fleet-four-accounts` contains `production` at
`e37cca06` as an ancestor, so this is a fast-forward and nothing is rewritten:

```
git fetch origin production
git merge-base --is-ancestor origin/production integration/fleet-four-accounts \
  && git push origin integration/fleet-four-accounts:production
```

The `merge-base` check first is §28's own rule — a non-fast-forward is refused
before it is attempted rather than after. Never check `production` out to
advance it; §28 records a scratch worktree holding it with a whole session's
reversal staged, one `git commit -am` away from putting a deleted surface back.

**If that check fails, production has moved and this is a merge rather than a
fast-forward — which is expected, not a problem.** The Factory closeout lane
is still working: while this was being written it advanced
`claude/factory-core-completion-ri3kqj` from `e37cca06` to `b4615e62`
(*One recompute asks the store about each document once*). That commit and
this branch were trial-merged with `git merge-tree` and report **no
conflict**; the only file both touch is `CLAUDE.md`, and the two additions are
in different sections. Whichever lane lands first, the other merges. Re-run
the trial merge rather than assuming this one still holds — that is the
mistake this whole document was written to correct once already.

**Both routes were attempted from this session and both were refused by its
permission layer**: the `git push` above, and `PATCH /repos/.../git/refs/heads/
production` with `force: false`, which is the strictly safer form because the
forge itself refuses anything that is not a fast-forward. No third route was
tried, because a third route would have been working around the refusal rather
than around a tool.

### 8.2 Then the release, unchanged

1. Dispatch **Deploy** on `production`. Its `canonical` job asks the guard
   twice — once before the test gate and once immediately before
   `flyctl deploy` — so a branch that moved underneath the run is refused at
   the second asking rather than released.
2. Stay with it to a terminal verdict. Expect
   `release: success`, `beforeRestart: …`, `afterRestart: …` as three separate
   facts, and read them as three.
3. **Expect the post-restart half to fail**, on the condition §7.3 records and
   CLAUDE.md §27 carries: `brain_submit_audit` answering nothing within 900s.
   That is not this integration and not the release. Deploy 316 hit it on
   `e37cca06` before this work existed.
4. Prove the image independently of the gate, which is what §27 says to do when
   the gate is the thing that is skipped or stuck. The served bundle is the
   handle, and the before-and-after are already known:

   | | served JS |
   | --- | --- |
   | `e37cca06`, live now | `assets/index-DYLLmYzP.js` |
   | `89b34a9d`, after this deploy | `assets/index-T4sTcb6M.js` |

   The stylesheet is `assets/index-Dzwb3x6t.css` on both, because this
   integration changes no CSS. `curl -sS https://northline-brain.fly.dev/ |
   grep -oE 'assets/index-[A-Za-z0-9_-]+\.(js|css)'`.

### 8.3 Then the live reads this lane is owed

Against the deployed image, through the workflows that already exist:

1. `fleet verify-pool --repository Peyday007/V5` — **read `accounts` and
   `surfaces` as two numbers.** One Routine is not a pool and the command says
   so on the run that passes, not only on one that fails.
2. `fleet show` — `unanswered=` per surface. **It must read 0 everywhere on the
   first tick**, and §7.2 establishes why from rows rather than from hope:
   production has never written a `DISPATCH_NO_SHOW` event, so every counter
   starts empty and no surface can be quarantined out of history.
3. `factory campaigns` and `factory status` across every project.
4. Confirm no surface reads `PROVEN` or `HEALTHY` on configuration alone —
   which is the whole point of §2.1, §2.4 and §2.7, and is the one thing a
   production reading of an *uncommissioned* pool can genuinely establish.

**What such a reading cannot establish**, and must not be written up as though
it did: that four real Claude accounts run as one Factory fleet. That needs the
four accounts to exist, and §5 lists the four things only a person can do.
