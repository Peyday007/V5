# What the self-expansion kernel can and cannot say, measured

A reading taken on 2026-09-18 against the reconciled tree, and against the
deployed Brain from outside it. Every figure here is a row, a hash, an exit code
or a count; anything that could not be measured says so rather than being
estimated.

---

## 1. What was reconciled, and why it needed reconciling

Three branches held parts of one workstream and none contained the others.

| Branch | Held |
|---|---|
| `origin/production` | the canonical tree, at `5db7866` |
| `claude/brain-self-expansion-kernel-yoxx30` | the kernel: blueprint ingestion, the self-model, realization packets |
| `claude/lucid-bardeen-r57iw7` | Research Intelligence (§35) |

Both feature branches took migration `067` on the SQLite chain and `058` on the
Postgres one. `loadMigrationFiles` refuses a duplicate version rather than
applying one and skipping the other, so the collision would have been a boot
failure with a sentence in it — §25's lesson, second occurrence. Research
Intelligence renumbered to `070`/`061`, which is a rename rather than an edit to
an applied migration: **neither chain had been applied anywhere**, and the
hosted tool list not carrying `brain_propose_plan_revision` is what establishes
that.

Both sections claimed `§35`. The kernel's is `§36` now; nothing was deleted.

## 2. The blueprint is the same bytes the kernel branch read

| Artifact | sha-256 | Bytes |
|---|---|---|
| `Brain_Intelligence_Map.md` | `da524c64808d85c101394e75903696e3b66aad550ae2163cbb7c42ecf7ca3ef0` | 63 586 |
| `AMENDMENT-001-faculty-14.md` | `78d42f34ccf8649894261f497f043ba21bfeb98d5f30715dd5ca6fa24faf5fe7` | 3 342 |

Registered on the reconciled tree, extraction `READY`, **15 sections declared**
from the document's own headings — identical to what `docs/CAPABILITY-KERNEL.md`
§5 recorded. The two documents are therefore the same artifacts rather than two
copies that happen to share a title.

## 3. The self-model census moved because the tree did

| Reading | Components |
|---|---|
| kernel branch, before the merge | 571 |
| reconciled tree | **589** |

Eighteen more, and no level moved on any existing component. The scan was taken
with no `BRAIN_REVISION`, which it reports as *unstamped* rather than attributing
the reading to a commit it cannot see — a local checkout legitimately has none.

## 4. Gates

The readings below are from the **reconciliation**, which is what the rest of
this section describes. The gates that decide whether the tree merges are
re-run on the final tree and reported after them, because a suite result is a
claim about the commit it ran on and nothing else.

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| SQLite suite | **159 files, 3 487 passed, 41 skipped** |
| Postgres suite, merged tree | **159 files, 3 497 passed, 12 skipped** |
| Postgres suite, with the three mechanisms | **160 files, 3 515 passed, 12 skipped** |
| Postgres suite, final tree | **159 of 160 files, 3 518 passed, 12 skipped, 1 failed** — see below |
| Migrate from empty | 71 migrations applied in order |
| Restart against existing | clean; no reapplication, checksums verified |
| `deploymentOwnership` | 18 passed — no chain gap, no collision, no port collision |

### On the tree that carries the tick step and the harness fix

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| SQLite suite | **169 files, 3 707 passed, 43 skipped**, exit 0 |
| Migrate from empty | **74 migrations applied in order**, schema version 74 |
| Restart against existing | `up to date (74 already applied)` — no reapplication |
| `npm run build` | clean; bundle `index-BQcjABQy.js`, **byte-identical to what production serves**, so this change alters no client byte |
| `deploymentOwnership` | 23 passed |
| `operatorConsoleRemoved` | 10 passed |

One failure came out of the merge and nothing else could have found it:
`operatorConsoleRemoved` read `services/capability/reader.ts` as a second writer
of the site connector scope set. It is not one — it *cites* the constant in a
comment explaining why its own scopes are a constant, and grants a different set
to a different worker. The rule was right and the matcher took co-occurrence
anywhere in a file as a write. Tightened to match the write itself, and asserted
against both the write it exists for and the comment that produced the false
positive.

### The one Postgres failure: the cause, measured

`connectContract.test.ts > the storage reading > takes at most one sample an
hour however often it is read` **timed out at 30 000 ms**. Not an assertion — a
timeout, in a suite this work does not touch.

It is pre-existing, and that was established rather than assumed: a detached
worktree at `origin/production` (`5db7866`), carrying none of these changes,
failed the same test the same way on the same database, in 108 s. The worktree
was removed immediately, because §28 records a stray one holding the canonical
branch as a third way that section's damage arrives.

An earlier version of this section said the cause was **not established**, and
that the identical suite had passed on the same machine earlier the same night
so something about the environment had moved. Both halves were true. The
correction is recorded here rather than edited there: the cause is now
established, and the thing that moved was the test database.

**The test harness leaked a Postgres schema per run, and the only test that
measures the database's size is the one that noticed.**

`tests/setup.ts` gives each run a fresh filesystem data root with
`fs.mkdtempSync`, which is a *random* directory name by construction.
`schemaForThisFile()` in `tests/helpers.ts` derives the Postgres schema from
`path.basename(DATA_ROOT)` — so every run got a schema nothing would ever name
again, and the `DROP SCHEMA IF EXISTS` at the top of the next run matched
nothing. `tests/setup.ts` already carries the two-mechanism design for the
filesystem side and says exactly why, in its own header:

> Left alone that accumulates silently until the disk is full, and the failure
> it produces then is a hundred unrelated tests failing on "No space left on
> device", which looks like anything except a leak here.

The Postgres side never got either mechanism. Measured on this machine:

| Reading | Value |
|---|---|
| `brain_t_%` schemas in `brain_test` | **648** |
| relations across them | **636 578** |
| `pg_database_size(current_database())` | **7.6 GB** |
| cluster data directory | 8.5 GB / 647 095 files |
| checkpoint interval in `/var/tmp/brainpg.log` | every ~27 s, syncing 53 000+ files |

`storageHealth.measure()` has a dialect branch, and this is the whole reason
SQLite never saw it:

```ts
if (db.dialect === 'postgres') {
  const rows = await db.all('SELECT pg_database_size(current_database()) AS bytes');
```

`pg_database_size` stats every file in the database. The test calls `measure()`
three times to prove the hourly cache holds, so it paid that cost three times
over 636 578 relations. **Nothing was slow about the code being tested; the
database it was asked to measure had grown by a factor of the number of times
the suite had ever been run.**

The decisive experiment was run rather than reasoned: the same test, at the
same commit, against the same cluster, on a **clean** database — **1 363 ms**.
Against the polluted one — 30 s timeout.

**The fix is the mechanism the filesystem side already had, at the schema.**

- A schema carries a marker table, `__brain_test_schema`, holding its creation
  time. Schema and marker are created in **one transaction**, because Postgres
  has transactional DDL and a schema that exists without its marker is one the
  sweeper cannot age.
- Each run **drops the schemas it created**, from a global `afterAll` in
  `tests/setup.ts` beside the filesystem root's own `process.on('exit')` — the
  cheap path, and the one that stops the leak going forward. **It was in
  `teardown()` first, and that was wrong: 47 of 169 test files call it.** The
  other 122 leaked exactly as before, and a sweep skips anything younger than
  the cutoff, so a run could not see its own leavings for an hour. Measured on a
  live cluster with two files that call no `teardown`: 33 schemas became 35
  without the hook, and stayed 33 with it.
- A sweeper retires what an interrupted run left behind, once per worker
  process, behind `pg_try_advisory_lock` so two workers cannot both drop the
  same schema. It skips anything newer than `STALE_AFTER_MS`, which is
  **imported from `tests/setup.ts`** rather than restated: one cutoff, two
  stores, and a rule applied by one of two readers is worse than none.
- `SWEEP_LIMIT` is **5**, and it is a measurement rather than a taste:
  `DROP SCHEMA … CASCADE` over 667 relations takes **0.94 s**, and a sweep of
  60 blew the 30 s `beforeEach` hook that was meant to be running a test.

**The behavioural assertion was not weakened and the timeout was not raised.**
The test still takes three readings and still asserts that exactly one sample
was taken. What changed is the database it takes them against.

Proved both ways round: against the still-polluted database (610 schemas) the
test now passes in **6.8 s** while the sweep retires five; against a database
the fix has kept clean it is back to about a second.

**Clearing the leak is not the same job as clearing what it left behind, and
the second one is a `VACUUM FULL`.** Dropping all 605 remaining schemas took the
database from 7.6 GB to 3.8 GB and left it *still* slow, because 636 578
relations having been created and dropped bloats the catalogs themselves:
`pg_attribute` measured **1 021 MB** and `pg_class` **358 MB**, and every
`CREATE TABLE` and `DROP SCHEMA` reads both. A full Postgres suite run on that
database did 42 files in 24 minutes against a recorded 160 files in 29 minutes
before the bloat accumulated.

| Relation | Before | After |
|---|---|---|
| `pg_attribute` | 1 021 MB | **41 MB** |
| `pg_class` | 358 MB | **8.6 MB** |
| the database | 3 366 MB | **662 MB** |

That is a local development machine's artifact and nothing about the code: a CI
Postgres starts empty and never had it. It is recorded because the *first*
reading of this problem was taken on a database in that state, and somebody
reproducing the measurement on a fresh one will get a different number for the
same correct fix.

An earlier reading in this document said `3 515 passed` with no failure. That
run predates the waived-gap fix, and the sentence is corrected here rather than
edited there.

## 5. The deployed Brain, read and not touched

Read through the MCP tools as a `WORKER` principal. **Nothing was claimed,
completed, failed, released, cancelled or enqueued.**

- Eight projects. Four Cash Modes; only `Cash Mode 1` holds work.
- `Cash Mode 1` carries **15 work items `LEASED` with expired leases** and 4
  `QUEUED`. Several are past `max_attempts` — `attemptCount` 4, 6 and 7 against
  a maximum of 2.
- The most recent lease is `2026-09-18T16:22:29Z`, so the fleet is alive and
  workers are still arriving.
- Seven items record the same worker-reported fault: `brain_submit_synthesis`
  answering *"That call could not be completed"* across several orchestrations,
  leases and payload sizes, between 2026-09-17 15:10 and 2026-09-18 06:02.

**That fault has a recorded cause and a shipped fix, and the fix is now in
`origin/production`** — §33's *a key is not a filename*, where the bucket
refused the key of every staged cash report whose title carried an em dash. The
failures predate the fix reaching production. §33 also records, deliberately,
that the parked packets are **left exactly as they are**: reading them is not
repairing them, the reissue is a person's, and replaying live Cash research was
outside what this work was authorized to do.

**What is not established:** whether every one of those fifteen leases is
explained by that fault. The worker summaries name it on seven; the other eight
carry no summary, and saying they are the same thing would be the comfortable
half-truth this repository refuses.

## 6. What is now callable that was not

Three mechanisms existed, were tested, and had no caller.

| Mechanism | Was called by | Is now reached from |
|---|---|---|
| `moveDimension`, for five of six dimensions | nothing | `services/realize/realized.ts`, `npm run capability -- packet realize` |
| `compile()`'s `ObjectiveSubmission` | a printer | `services/realize/handoff.ts`, `npm run capability -- packet handoff` |
| `directorPass`'s questions | nothing | `services/realize/askTheWorld.ts`, `npm run capability -- packet ask` |
| `judgeGap`, the only way out of `NEEDS_A_READING` | four test suites | `npm run capability -- packet judge` |

The fourth is the one that made the other three unreachable in practice.
Everything downstream of an unread gap refuses — `readiness`,
`decisionReadiness`, `compile`, `handOff`, the implementation reading — so a
production packet could enter that state and never leave while every part passed
its own tests.

All three commands were driven against a real database rather than only against
tests, and each refuses correctly on an unknown packet.

### And the join between them, which was a person's memory

All four of those are **commands**, and the fifth defect is what that means:
running the chain was six invocations in the right order, so a packet whose
authority gap somebody answered on Tuesday sat exactly where it was until
somebody remembered the next line. An operator's memory is not a caller.

`services/realize/advance.ts` is reached from the durable Russell tick, beside
`advanceSources`, and it is the ordering and nothing else.

| Property | How it is held |
|---|---|
| Every transition is the CLI's own function | a test reads both files and holds them to the same names |
| No second orchestrator, queue, policy module or state machine | `advance.ts` imports the transitions and nothing else |
| No approval of its own | asserted against its import statements by name |
| Approves nothing, spends nothing | asserted against `russell_missions`, `russell_goals`, `research_orchestrations` and approved `factory_change_requests` |
| A person-owned gap reaches the surface that already exists | a `russell_human_requests` row, the same card, the same route, the same resume |
| One card per gap, however many ticks | `ON CONFLICT (resume_key) DO NOTHING`, asserted twice |
| Answering it closes the **gap**, not only the card | walked from the tick through `answerHumanRequest` to `resumeAnsweredRequest` |
| A refusal is `WAIVED`, never `CLOSED` | asserted as two different states |
| It cannot take the tick down | the call is inside a guard, asserted by position |

**Five of those were proved by neutralising the guard, watching the test fail,
and restoring it** — in a copy of the tree, so a Postgres suite running beside
it could not read a half-neutered file:

| Neutralised | The failure it produced |
|---|---|
| the waived-gap guard in `realized.ts` | `expected 'LIVE' not to be 'LIVE'` |
| the branch ordering in `resumeAnsweredRequest` | `expected 'OPEN' to be 'CLOSED'` |
| the resume key's derivation from the gap | `expected +0 to be 1` |
| the tick's call | `expected … to contain 'await advanceCapabilityPackets('` |
| the guard around the call | `expected 'try {…}' not to contain 'catch'` |

The second of those is the one worth naming. `resumeAnsweredRequest` returns
`settled: true` for any request with no mission — *"the request was not about a
mission"* — so without the ordering a capability card a person answered would
have been marked RESUMED having carried out nothing: the gap still open, the
card gone from the surface, and an identical one raised on the next tick. **A
person could have answered the same question every day and never learned their
decision was recorded and ignored.** §24 writes that sentence at six altitudes;
this would have been the seventh, reached through the surface built to answer
it.

## 6c. The release gate, and two conditions at one step

Eight consecutive `Deploy` runs report `failure`, and every one of them
**released**. The API's job `conclusion` reads `success` for both hosted
verification steps because they are `continue-on-error`; the verdict step reads
`outcome`, which is the raw result, and that is what fails the run. Reading the
job summary rather than the verdict would say the opposite of what happened.

Run 265 (`b0b5fd7`) is the one traced here, and it held **one of each condition
§27 separates**:

| | Where | What |
|---|---|---|
| before the restart | judge audit step | `fetch failed` — Node's 300 s header timeout, measured in §27 at 300.8 s |
| after the restart | first packet check | `2/2 connection(s) in use, 0 idle, 380 caller(s) waiting, ceiling 2` |

The first is already bounded in this tree: `verify-hosted.ts`'s `call()` carries
an explicit `AbortSignal.timeout`, so the next occurrence either completes and
the timestamps say what the judge pass costs, or fails saying which request
waited and for how long. **That bound is not this work's and is not a fix for
the second condition.**

The second is the number §27 said the eighth occurrence would have to produce.
`BRAIN_DATABASE_POOL_SIZE` defaults to 10 and is not in `fly.toml`, so the
ceiling of 2 is a deployment secret somebody set, and nothing in this repository
can set one. What was missing was the *server's* own limit, without which
raising the ceiling could turn a failed verification into a failed boot.
`readServerConnectionLimit` reads it at boot and the banner prints it.

**Production at rest is healthy**, which is the reading that keeps this in
proportion: five `/healthz` in a row at 0.14–0.37 s, and an authenticated MCP
read of an eight-layer project answered promptly. A ceiling of 2 is not a broken
Brain; it is a ceiling the verification's own concurrent burst exhausts, on top
of whatever the Russell tick, the dispatcher and the factory loop are doing.

## 6d. What running it on the deployed Brain found

The kernel was already deployed at `b0b5fd7`, so the blueprint could be run
through production without waiting on this branch. It was, and it failed — for a
defect in Brain rather than in the document, the worker or the validator.

| | |
|---|---|
| project | `Brain Architecture` `prj_ac780d726f394a8ca81d`, created by `ensureArchitectureScope` |
| blueprint | `cps_66b6eb8302814c9f820d`, 63 586 bytes, sha-256 `da524c64…f7ca3ef0` |
| amendment | `cps_5b6f5eaea6434027b38c`, 3 342 bytes, sha-256 `78d42f34…faf5fe7` |
| sections declared | **15** — 1 `SHARED_EXECUTIVE` + 14 `FACULTY` (5.1–5.14) |
| numbered chapters excluded | §7.1–7.10, §9.1–9.10, §10.1–10.5 |
| bin | `bin_2720ea1bde3a45769ef1`, 15 units, **created by the durable tick** |
| routing | `ROUTED` — *"Selected Airyn 2-A on Airyn: 0/∞ on the Routine, 0/∞ on the account"* |

Both hashes are **byte-identical** to the local files and to what §2 recorded for
the kernel branch, so this is the same artifact rather than a copy sharing a
title. The one operator step was `access grant airynworker2 brain-architecture`;
without it `routeBin` has no surface for the project and the bin sits READY.

### The contract named three fields the validator has never had

A fired Cowork session read all fifteen sections, derived every slug correctly,
followed the instruction it was given exactly, and had **every** definition
refused:

```
A connection carried unknown field(s): kind, faculty, note.
```

| | |
|---|---|
| the manifest said | `connections` objects have `"kind"`, `"faculty"`, optional `"note"` |
| `CONNECTION_KEYS` says | `relationship`, `toFacultySlug`, `toComponent`, `rationale` |

Not one field in common. The source went `FAILED` with *"no candidate survived
validation, so there is nothing to audit"*.

**The rule is right and stays.** An unknown field refuses the *candidate* rather
than the field, because a worker that sent one has misunderstood what it was
asked for and dropping it silently leaves that belief in place. What was wrong is
the thing that asked. §27 records this at `brain_check_in`'s `session_ref` and
§33 at `brain_submit_claims`' `opportunity_signal`; this is the third, and all
three survived because each half was correct on its own and nothing held them
against each other.

**The test for it existed and stopped one level short.** It held the manifest
against `DEFINITION_KEYS` and `LIST_FIELDS` and described the *nested* set in
prose — and its own comment says why that is the risk: *"a copied list is the
thing that drifts."* No fixture could have caught it: every one builds a
candidate from the declared shape, so the validator and the instruction were each
proved correct against themselves.

### And the failure had no way back

`advanceSources` never looks at `FAILED`; `registerSource` is idempotent by
`(content_hash, kind)`, so re-registering the same bytes returns the failed row;
`recoverExtraction` only reaches an assignment whose bin has vanished. A source
that failed **because Brain was wrong** was therefore terminal.
`services/capability/reoffer.ts` is the answering transition, and it refuses by
name the failure it is not for — an unreadable document is the bytes rather than
the contract, and re-offering one would hand out a bin, spend a fire and fail
identically for ever.

## 7. What is still not true

- **No faculty is implemented.** `realized.ts` can now say one is, from rows.
  On this repository every packet still holds unread gaps, so it says nothing.
- **Nothing here has been deployed.** Every reading above is local.
- **No capability research has run.** A question becomes an idea; whether a
  mission follows is the standing authority's decision, and none has been
  granted on the architecture project.
- **The fifteen faculty readings were not re-run.** The kernel branch did that
  once and recorded it; the hashes above establish the artifacts are identical,
  so a second reading of the same bytes by the same session would produce the
  same thirteen promotions and no new information. What it would *not* produce
  is the independence the kernel branch already declined to claim: two handles
  are two workers and two sessions, and whether two model contexts were behind
  them is a fact no row can establish.
