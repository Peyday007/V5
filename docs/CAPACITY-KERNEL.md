# The Routine Capacity Kernel

A bounded loop that measures how much of this fleet can run at once, records what
it has established with the evidence behind it, runs the smallest experiment that
would reduce the biggest remaining uncertainty, and rolls back anything that makes
things worse.

It is a **new entrance to machinery Steps 4 to 12C already built**. There is no
second scheduler, queue, Routine registry, account registry, evidence store,
optimizer or telemetry authority here. It reads `bin_events`, `bin_dispatch`,
`worker_sessions`, `bins`, `work_items` and `fleet_*`; it writes two tables of its
own conclusions; and the only way it changes what Brain does is one
`fleet_policy` row.

---

## 1. The enforcement map: every "four" this fleet contains

The prior observation was *"four Routines are presently configured per account"*.
Traced to the surface that enforces each number:

| Where | Symbol / column | Value | Classification |
|---|---|---|---|
| `services/dispatch/loop.ts:129` | `DISPATCH_BURST` | 5 | **Local configured guardrail.** Activations one tick may start. Not a fleet size; its own comment says the ramp measures the right number. |
| `services/dispatch/loop.ts` | `DISPATCH_TICK_MS` | 10 000 | Local configured guardrail. How often the loop wakes. |
| `services/dispatch/candidates.ts:34` | `IN_FLIGHT_WINDOW_MS` | 30 min | **Architectural bottleneck.** How long a sent fire counts as occupying a slot. Too long under-fires after a quiet failure; it bounds *concurrent target accounting*, not a count of Routines. |
| `fleet_policy.target` (026:161) | rows, per FLEET/ACCOUNT/ROUTINE | **not set in production** | **Local configured guardrail, as rows.** `explain-route` in production printed `0/∞ on the Routine, 0/∞ on the account` — no target exists to be the limit. |
| `fleet_policy.explore_ceiling` / `explore_until` (026) | rows | never written | **Dead hook until now.** Read by `effectiveTarget` and `routeBin` since Step 11 and written by nothing. This kernel is its first writer. |
| `services/dispatch/scaler.ts:146` | `NO_SHOW_QUARANTINE_THRESHOLD` | 3 | Health guardrail. Quarantines a surface that cannot authorize. Never a capacity ceiling — §23: a refusal is not misconduct. |
| `services/dispatch/scaler.ts:147` | `FAILURE_QUARANTINE_THRESHOLD` | 5 | Health guardrail, same. |
| `services/industry/allocate.ts:97` | `MAX_OPEN_KERNEL_ROUNDS` | **4** | **A four, and not about Routines at all.** Concurrent open *industry-kernel research rounds*. |
| `services/research/bundling.ts:21` | `MAX_FRAGMENTS_PER_JOB` | **4** | **A four.** Fragments that may share one execution container. |
| `services/factory/loop.ts:134` | `DEFAULT_MAX_REVIEW_ROUNDS` | **4** | **A four.** Factory review rounds per campaign. |
| `services/cash/roadmap.ts:367` | `ROUNDS_READ_AT_ONCE` | **4** | **A four.** A display limit on a page. |
| `scripts/step12b-acceptance.ts:6190` | `operatorTarget` | **4** | **A four.** A value inside an acceptance fixture. |
| `russell_goals.max_concurrent` (027:370) | rows | **6** in production | **Local configured guardrail.** Concurrent *missions* per standing grant. This is the "fleet concurrency around 6". |
| `services/factory/remoteLoop.ts:722` | `MAX_BINS_PER_STAGE` | 3 | Local guardrail on factory stage retries. |
| `factory_workers.max_concurrency` (037:324) | rows | default 1 | Declared per factory worker; §27 says the *sum* is a projection and never throughput. |
| `bins.max_attempts` (024:181) | rows | default 5 | Attempt budget. §38 records it deadlocking a bin; the answering transition is `regrantBinAttempts`. |
| `bin_dispatch.max_attempts` | rows | default 5 | Fire attempts per bin generation. |
| `config.ts:75` | `BRAIN_DATABASE_POOL_SIZE` | default 10 | **Infrastructure limit.** §27 records six deploys where a starved pool was the plausible cause and deliberately did not raise it. |
| `services/fleet/capacity.ts:25` | `REQUIRED_CAPACITY_ACCOUNTS` | **removed** | **Was a four.** A constant denominator that made a working two-member Brain read `1 / 4`. §34 removed it; only the comment recording the correction survives. |
| Claude Routines API | `429` + `Retry-After` | not observed | **The only PROVIDER_ENFORCED surface that exists.** `recordAllowanceObservation` writes it as `PROVIDER_ALLOWANCE` / `PROVIDER_ENFORCED`. |
| `create_trigger` (Routines) | cron minimum | hourly | **Provider-enforced, and about cron only.** All six enabled production Routines carry `cron_expression: ""` — on-demand fires have no such floor, and Step 10 measured ready→fired at 4.7 s. |

**Nothing in that table is a provider limit of four on Routines.** The number four
appears five times in this repository and not once is it about how many Routines an
account may hold, enable or run.

### What the provider's own listing says

Read directly from the Routines API for the account that owns this fleet
(`bc3959e8-…`), 2026-09-20:

- **9 Routine definitions exist** on that one account.
- **6 of them are enabled simultaneously** (`Factory_surface_1`, `Brain Research
  1-B`, `Brain Research 1/C`, `Brain Research 1-D`, `Brain Worker (dispatch)`,
  `Brain worker`); three are disabled and retired.
- **No refusal was issued** for any of them.

The prior "four per account" described the four *research* surfaces
`Brain Research A`–`D`, which is a registration count an operator chose.

Brain's own registry, read through `fleet explain-route` in production the same
day, holds **9 registered Routines** across more than one account (one
quarantined, two retired, and `Airyn 2-A` on an account named `Airyn` selected for
a live bin).

### The definition-capacity staircase, run

One step, taken 2026-09-20T12:12:30Z: a tenth Routine created on the same account
under a neutral name, **no cron at all** so it can never fire by itself, no
connectors, and no session-creating configuration.

- **Created without refusal.** `CREATE_TRIGGER_OUTCOME_CREATED`. No new
  credential, no new account, no plan change, nothing spent.
- Verified against the **authoritative provider listing**, not the create
  response: **10 definitions on one account, 7 of them enabled simultaneously.**
- Then **disabled** and left in place, per the experiment's bounds — a
  test-created surface is drained, not deleted.

So:

| | Before | After | Bound |
|---|---|---|---|
| Definition capacity, one account | ≥ 9 | **≥ 10** | AT_LEAST, MEASURED |
| Enablement capacity, one account | ≥ 6 | **≥ 7** | AT_LEAST, MEASURED |

**Neither number is a maximum.** Nothing refused, so nothing bounds either from
above. A tenth definition establishes that ten fit; it says nothing whatever about
eleven, and nothing at all about how many can *execute* at once.

### Provider-admitted concurrency, measured from the provider's own run records

The same listing carries each Routine's most recent run. Four independent facts,
one per surface, on one account:

| Routine | Fired | Finished |
|---|---|---|
| `Brain Research 1/B` | 11:43:48Z | still `PENDING` at 12:12Z |
| `Brain Worker (dispatch)` | 11:45:02Z | 11:45:26Z |
| `Brain Research 1-D` | 11:45:34Z | 11:46:56Z |
| `Brain Research 1/C` | 11:46:42Z | 11:48:21Z |

Between **11:46:42Z and 11:46:56Z**, three of those sessions were simultaneously
live: `1/B` (still running), `1-D` and `1/C`. So
**PROVIDER_ADMITTED_CONCURRENCY is MEASURED ≥ 3 on a single account, with zero
refusals** — which on its own falsifies any reading of "four Routines per account"
as a concurrency limit of one.

Two honest caveats. This is **admitted** concurrency, not **productive**: whether
each of those three produced distinct validated work is a question about Brain's
own `worker_sessions` and bin rows, which needs production database access this
session does not hold. And `last_run` carries only the most recent run per
Routine, so three overlapping is a *floor* derived from four separate
most-recent-runs that happen to overlap — the real peak over the day is very
likely higher and has not been read.

---

## 2. The fifteen dimensions

`server/domain/capacity.ts`. There is **no aggregate** — no percentage, no rollup,
no `isComplete`. §29 records what happens the moment one exists: every reader uses
it and the parts it was made of become decoration.

Every reading carries a `bound`, and that is the honesty requirement of the whole
design. Creating a fifth Routine establishes definition capacity **AT_LEAST** five
and nothing about a maximum; a repeated refusal establishes an **AT_MOST**; the
number of surfaces currently eligible is an **EXACT** reading of a present fact
rather than a limit at all. One integer cannot carry that difference, and without
it *"we created a fifth"* becomes *"the limit is five"* by the time it reaches a
report.

Evidence vocabulary is the four values the ledger and `fleet/view.ts` already use:
`MEASURED`, `INFERRED`, `UNKNOWN`, `PROVIDER_ENFORCED`. An internal constant, a UI
default, a schema restriction, a scheduler bug, a timeout, an absence of work or an
unexplained failure is **never** the last one.

`UNKNOWN` carries no value at all. Migration 074 enforces the pairing with
`CHECK ((evidence_class = 'UNKNOWN') = (value IS NULL))`, so a zero dressed as an
unknown — or the reverse — cannot be written by any path.

---

## 3. What is measured, and how

`server/services/capacity/observe.ts` is the impure half; everything that reasons
about it is pure, so a conclusion can be replayed against the input that produced
it.

**Overlap is computed, never counted.** A count of activations in a window is a
count of *starts*: Step 10's rung 20 finished twenty bins from thirteen
activations, because a worker that finishes one asks for another. So a session
becomes an interval — start from `worker_sessions.observed_at`, which is written at
arrival *from the dispatch row Brain sent*, never from anything the worker says
about itself — and the maximum overlap is found by a sweep. An end is processed
before a start at the same instant, so a handover is not counted as two running at
once. **A session with no observed end is dropped rather than extended to now**:
the favourable assumption there inflates the headline number.

**A duplicate callback cannot inflate throughput**, because throughput counts
`DISTINCT bin_id` and productivity reads the bin's own terminal state. A
redelivered acceptance appends an event and moves nothing.

**Latency arithmetic happens in JavaScript, not SQL.** The natural SQLite
expression is `julianday`, which Postgres does not have — a statement that would
pass the whole local suite and throw on the database production runs. That has
already happened three times in this repository.

---

## 4. The loop

```
OBSERVE → MODEL → DIAGNOSE → SELECT → AUTHORITY CHECK → CANARY → EVALUATE
        → ADOPT or ROLL BACK → UPDATE CLAIMS → REPORT → OBSERVE
```

Every transition is a compare-and-swap naming the state it moves from. **The sixth
time this codebase has needed that sentence**, and for the same reason: the guard
must be on a value the claimant does not supply. Two ticks reading one `PROPOSED`
row produce one transition; a restart mid-experiment resumes rather than starting a
second canary, because every artefact an experiment creates is recorded in the same
statement that moves the state. There is no in-memory state to lose — §27's rule
that a flag can be set by a tick that then dies and rows cannot.

### Authority may not self-expand

There are exactly two effects this kernel can have on the world:

1. **One `fleet_policy` row** through `setPolicy` — append-only, with an actor and
   a reason, leaving the previous version in place to revert to. The field it
   writes is `explore_ceiling`, which carries its own expiry, so *a kernel that
   never gets another tick leaves a ceiling that stops applying by itself.*
2. **Isolated canary bins** through `createProbeBin` — `DETERMINISTIC_CHECK` bins
   whose manifest forbids every repository operation and every external effect,
   and whose whole task is to hash a value that travelled inside them.

It cannot create an account, a Routine, a credential, a membership or a scope; it
cannot enable a paid API; it cannot raise a spending ceiling; and it **cannot fire
anything** — the dispatcher picks its bins up through the same routing every other
bin goes through. §22's split holds: *Brain owns dispatch, the surface owns whether
a worker may act.*

`EXPERIMENT_AUTHORITY` is a constant in `domain/capacity.ts`, so nothing supplies
the limits its own work is judged against — §16's approval-envelope property at a
smaller scale.

### The one experiment Brain cannot run

`DEFINITION_STAIRCASE` is always `PERSON`. The deployed Brain holds a per-Routine
bearer that fires one named trigger and nothing that can create one, and §22
forbids it minting its own execution surfaces. So it parks at `NEEDS_USER` with the
exact command, and **`user_action` is NOT NULL for that state, enforced by a
CHECK** — §24's rule that an escalation with no answering transition is stuck
rather than waiting, made unsayable rather than merely discouraged. Its answering
transition is derived from rows: the moment `fleet_routines` holds more than the
baseline it was proposed against, the claim is recorded and the experiment settles,
so it reaches an action taken days ago by somebody who never came back to say so.

Meanwhile every other authorized part of the loop carries on.

---

## 5. What running it found

Three defects, none of which reading alone found.

**An observation was proposed on a fleet with nothing to observe.** With work
outstanding and no eligible Routine, both observational experiments were offered
and would have been authorized, started, and left sitting in `CANARY_RUNNING`
until their window closed — measuring nothing, settling `INCONCLUSIVE`, and being
proposed again. §24's sentence at the selector, and worse than the usual case:
stuck *while looking busy*, crowding out `DEFINITION_STAIRCASE`, which is the one
experiment that names the condition and which loses every ranking it is offered
beside a free observation.

**An inference was overriding a measurement downwards.** `recommendedTarget` took
the plain minimum of {demonstrated safe bound, failure − 1, knee}. Driving the
kernel produced a knee of 1 over a fleet whose productive overlap had just been
measured at 2, and the recommendation came out at **1** — advising Brain down from
a level it had demonstrably run. A knee is an inference; a demonstrated safe lower
bound is a measurement. The measurement wins and the disagreement is recorded as a
contradiction rather than silently resolved. The expensive direction is the one
that understates: a fleet talked down from a level it can run loses throughput
nobody measures back.

**The knee itself was a line through two single events.** One completion at level 1
and one at level 2 satisfied "throughput stopped rising".
`KNEE_MIN_SAMPLES_PER_LEVEL = 3` is a judgement, written down as one.

**And an off-by-one in the failure point**, found by the test written for the
second fix. Counting sessions open at a refusal gives the level that was *working*
when a further start was refused, so calling that the failure point labels a level
Brain had just run as the point at which things break — and `failure − 1` then
lands one below the demonstrated bound. Three open and a fourth refused means three
worked and four did not exist.

**The `NEEDS_USER` answering transition was unreachable, in the one place this
document writes about avoiding that.** `settleExperiment` allowed `ADOPTED` only
from `EVALUATING`, on the correct reasoning that adopting out of a running canary
would be adopting before the window closed. A definition staircase has no canary:
its evidence is rows, so it settles straight from `NEEDS_USER` — and that matched
nothing, so it would have parked for ever with its action re-reported on every
tick. §24's escalation with no answering transition, written by the code that
argues against it. A test found it; nothing in reading would have, because the
guard looked deliberate and was.

**And the same list of actions was read a tick too early.** The live experiments
were collected *before* the transitions ran, so an experiment settled by the very
tick that noticed its condition still had its action reported — asking somebody to
do a thing already done. It is read from the post-advance state now.

---

## 6. What the loop actually did, end to end

Driven against a real local Brain through the real migration chain, a real
registered fleet and the real tick:

```
PASS 1  no session history
        bottleneck NO_ELIGIBLE_WORK · 15 claims CREATED · PASSIVE_BASELINE proposed
PASS 2  two overlapping productive sessions on the record
        ACTIVE_CONCURRENCY, PRODUCTIVE_CONCURRENCY, BURST_CAPACITY,
        OBSERVED_SAFE_LOWER_BOUND, RECOMMENDED_OPERATING_TARGET all SUPERSEDED
        (the rest REVERIFIED — first_observed_at unchanged)
PASS 4  a bin leased with a live lease
        bottleneck NONE · CONCURRENCY_STAIRCASE proposed 2 → 3
        rollback point recorded: policy v1 target 2
        explore ceiling 3 written as policy v2 until 12:26:23Z, actor capacity-kernel
        3 isolated canary bins, READY, unpinned
PASS 5  a provider refusal arrives mid-canary
        CANARY_RUNNING → ROLLED_BACK (PROVIDER_REFUSAL)
        policy v3 target 2, explore cleared
        history v1:t2/e-/operator  v2:t2/e3/capacity-kernel  v3:t2/e-/capacity-kernel
PASS 3  idempotency
        0 transitions · all 15 claims REVERIFIED
```

The base `target` is never touched by an experiment — only `explore_ceiling` —
so the row records a temporary departure rather than replacing what the operator
set, and every version stays.

---

## 7. What is not proven

- **No live *concurrency* canary has run against the deployed fleet.** The
  definition staircase did run, on the real provider, and the provider-admitted
  concurrency floor is a real production reading. What has not happened is the
  kernel itself raising a ceiling on the deployed Brain and watching the result:
  that needs this commit deployed, and until it has been, the engine passing its
  tests says nothing about the fleet — the separation Step 3 drew between the
  research engine and a real job having actually run.
- **Productive concurrency in production is UNKNOWN.** Three provider sessions
  were admitted simultaneously; whether three produced distinct validated work is
  a question about `worker_sessions` and bin states, and reading those needs
  production database access. The kernel computes it the moment it is deployed.
- **`SUSTAINABLE_CAPACITY` is UNKNOWN** and will stay UNKNOWN until overlapping
  activity has spanned a representative period. That is evidence not yet
  collected, not a failure.
- **`PROVIDER_ENFORCED_CEILING` is UNKNOWN.** Nothing has refused. An account's
  simultaneity limit and its per-window allowance are different ceilings and
  neither has been observed.
- **`START_RATE` is UNKNOWN** on any Brain that has not accepted a fire in the
  window.

---

## 8. Reading it

The fleet surface has no npm alias by design — it is `scripts/fleet.sh` inside the
deployed container, reached through the Fleet workflow, and locally through `tsx`:

```
npx tsx scripts/fleet.ts capacity                   # the concise report
npx tsx scripts/fleet.ts capacity --verbose          # every dimension, with evidence and freshness
npx tsx scripts/fleet.ts capacity-kernel --dry-run   # what one pass would do, changing nothing
npx tsx scripts/fleet.ts capacity-kernel             # one real pass
npx tsx scripts/fleet.ts capacity-history --name PRODUCTIVE_CONCURRENCY
```

Through the Fleet workflow — `command: capacity`, `capacity-kernel`,
`capacity-history` — the same commands run against production without a deploy.
`capacity` and `capacity-history` are pure reads; `capacity-kernel` is the one that
acts, and they are separate commands rather than one flag so that reading cannot
become acting by a typo. `GET /api/projects/:id/fleet` carries the concise report; `GET
/api/projects/:id/fleet/capacity` carries the structured snapshot. Both are
`requirePerson` plus `requireProject`, so a worker principal is refused by type and
a caller who may not read the project gets the same 404 a missing project gives.

Reading performs no effect: no fire, no enqueue, no claim, no registration, no
policy write. `tests/capacityKernel.test.ts` asserts that against the queue, the
bins and the fire counters rather than stating it in a comment.
