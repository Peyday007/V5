# Step 11 — evidence

What was built, what was measured, and what is still unproven. Written the way
Step 10's close-out was: a claim in this file is either a row you can go and
read or it is marked as not yet established.

---

## 1. What changed

Step 10's fleet was `fireConfig()` — two environment variables read at call
time. One Routine, named at deploy time, unchangeable without a deployment.

Step 11 replaces that function with rows, and keeps the distinction the whole
step turns on:

> **An account is not a Routine.** An account holds a subscription allowance. A
> Routine is a fire surface. A second Routine under one account doubles how fast
> Brain can *start* sessions and changes nothing about how much that account may
> *do*.

Step 10 measured the fire ceiling and was explicit that it had not measured the
allowance. Collapsing the two into one number here would have written that
confusion into the schema.

| Table | What it is |
|---|---|
| `fleet_accounts` | a subscription, its declared plan power as a **label**, and what the provider last said about its ceiling |
| `fleet_routines` | a fire surface: capabilities, health counters, the **name** of a deployment secret and a digest — never a credential |
| `fleet_policy` | append-only versioned targets, boosts and pauses, each with an actor and a reason |

`bin_events` gained `account_id`, `routine_id`, `evidence_class` and
`workload_class` rather than growing a second capacity ledger beside it. Two
tables that must agree about the same fires is a design where the one nobody
reads is the one that drifts.

`research_passes` gained `executor_worker_id`, `executor_routine_id`,
`executor_account_id` and `executor_session_ref`, which is what turns "an
independent audit" from a naming convention into a fact about execution.

---

## 2. The design change the tests forced

`routeBin` is a pure function over a snapshot read once per tick. That is the
right shape for a decision you want to replay and argue with, and it is **not a
safety mechanism**: two dispatchers — two Brain instances, or two iterations of
one burst — both compute correctly that a surface has headroom, and both fire.

So Routine selection acquires a slot:

```sql
UPDATE fleet_routines
   SET fire_generation = fire_generation + 1,
       total_fires = total_fires + 1,
       last_fired_at = ?, updated_at = ?
 WHERE id = ? AND fire_generation = ?
   AND state = 'ENABLED'
   AND (retry_at IS NULL OR retry_at <= ?)
```

Both racers name the generation they read; exactly one `UPDATE` matches. The
loser is refused rather than retried, so the mechanism can under-fire and cannot
over-fire — a fire missed this tick happens ten seconds later, and a fire made
twice is an activation nobody authorized.

This is the same primitive as `work_items.lease_generation` and
`bin_dispatch`'s `PENDING → SENDING` swap, for the third time and the same
reason: **a compare-and-swap has to be on a value the claimant does not
supply.** A swap on `total_fires` would look equivalent and would not be, and
SQLite would never have shown the difference.

`state` and `retry_at` are inside the guard so a surface quarantined or
rate-limited *between the snapshot and the claim* is refused by the database
rather than by a stale candidate list.

The burst additionally spends the headroom in its local snapshot. That is not
redundant. Without it the swap still caps the burst — but it caps it by making
the dispatcher lose a race with *itself*, and an operator looking at a
one-Routine fleet would be told it was contended. With it, the refusal names the
target. `tests/fleet.test.ts` asserts the count **and** the reason, and the
`SLOT_LOST` assertion is what fails if the accounting is removed.

---

## 3. Software verification

| Check | Result |
|---|---|
| Postgres, concurrent connections | **1278 / 1278** |
| SQLite | **1253 passed, 25 skipped** (OCR fixtures) |
| Fleet suite | **64 tests**, both backends |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| SQLite chain over a populated production-shape database | 026 applied, every existing row preserved |
| Postgres chain over a populated production-shape database | 017 applied, every existing row preserved |

The Postgres run is the one that means something for the concurrency claims.
SQLite serialises its writers, so a `Promise.all` pair there executes one after
another and proves only that the guard rejects a stale generation — which is the
property, but not under simultaneity. That distinction is exactly why
`bin_dispatch`'s original swap on `attempt_count` shipped.

### The inversions

Each of these fails when the control it names is removed:

- fire-slot CAS on the generation rather than on a counter the claimant read
- in-burst headroom accounting (fails with `SLOT_LOST` in place of the truth)
- refusals never advancing the quarantine streak (an account at its ceiling is
  busy, not broken)
- unrecorded audit lineage counting as a violation rather than as a pass
- `declared_plan_power` never becoming a number the router multiplies

---

## 4. Live fleet

### The registry replaced the environment, in production

`fleet show` against the deployed Brain, before anything was registered:

```
FLEET
  accounts    0
  routines    0
  target      not set
  candidates  0 routable now
```

and after registering the account and the Routine Step 10 used:

```
  primary  ENABLED  declared=unknown plan=Max target=—
      V1  ENABLED  ref=trig_01CBLu5oCZziEwznw5q9xU7g  secret=BRAIN_ROUTINE_TOKEN
```

`acct_70dda3fae2e1428e944b` / `rtn_c7bcec972bd44afa91d7`, digest `dfe19a3cfd02…`.
The bearer was adopted from the secret already deployed and was neither rotated
nor read anywhere it could be printed. The fleet target was set to 2 by a policy
INSERT at version 1 with an actor and a reason — **no deployment, no schema
change, no restart.**

### One bin, end to end, through the new path

Two bounded `DETERMINISTIC_UNITS_V1` bins were seeded. Brain routed, fired,
assigned and drained both with nobody involved. `bin_5c745087ba2f43b8b9a0`:

| At | Event | |
|---|---|---|
| 07:03:14.897 | `BIN_READY` | |
| 07:03:19.849 | `DISPATCH_INTENT` | +4.95s |
| 07:03:20.047 | `DISPATCH_ROUTED` | +5.15s — *Selected V1 on primary: 0/∞ on the Routine, 0/∞ on the account* |
| 07:03:26.501 | `DISPATCH_SENT` | +11.6s — `session_01VFTU9QtgGreXWYMmvuoPiL` |
| 07:03:40.381 | `BIN_ASSIGNED` | +25.5s — `wkr_1cdd82cfb2a54faf8edd` |
| 07:03:59.424 | `BIN_TERMINAL` | +44.5s — `DETERMINISTIC_UNITS_V1 v1 evaluated true` |

`fires=2 refusals=0` on the Routine. The `DISPATCH_ROUTED` event is new: it
carries the account and the Routine and the arithmetic the decision rested on,
which is what makes "why did this bin go there" answerable from a row.

### Three defects this run found

None of these was visible from reading the code. All three were visible within
minutes of running it against production, which is the point of doing it there.

**1. A counter that only went one way.** The same `fleet show` read
`no-shows=2` while the trace above plainly shows a worker arriving at 07:03:40.
Every successful fire advanced `consecutive_no_shows`, no production path ever
recorded an arrival, and `bindRoutineWorker` documented a check-in path that did
not exist — so a healthy Routine walked toward quarantine while its workers were
visibly turning up.

Fixed by crediting the arrival from the dispatch row that produced the worker,
never from anything the worker says about itself. A takeover of an expired lease
credits nothing, because that session genuinely did not finish.

Before and after, from the same live Routine:

```
fires=2  refusals=0  no-shows=2      <- before
fires=4  refusals=0  no-shows=0      <- after
```

**2 and 3. Two nulls with one cause.** `medianActivationMs` was null and
`activationTrace` returned nothing, against a Brain that had drained
**81 bins across 97 activations**. `BIN_TERMINAL` carried no duration, and the
trace grouped `BIN_COMPLETION_ACCEPTED` by `session_ref` — a column the worker's
own calls never carry, because the provider's session id is recorded on
`DISPATCH_SENT`. So the simulator reported "nothing can be simulated from an
empty trace" about a fleet with months of history, and it was structurally
incapable of ever reporting anything else.

`finishBin` now records the execution duration, read before the swap that clears
`leased_at` — a read-then-write that is deliberately outside every decision, so
a stale read cannot let anyone finish a bin they do not hold. The trace groups
`BIN_TERMINAL` by worker, and requires a real duration rather than defaulting a
missing one to a minute: an invented number inside a projection reported as
resting on observed samples is the exact failure this step's honesty rule
exists to prevent.

### What the reports read, before and after

`fleet profile` against production, over all recorded history:

| | before the duration fix | after |
|---|---|---|
| `binsCompleted` | 81 | 83 |
| `activations` | 97 | 99 |
| `routedDecisions` | 4 | 6 |
| `medianActivationMs` | **null** | **21487** |
| `unknowns` | *"No activation carried a duration, so timing is unknown rather than zero."* | *(empty)* |
| `bottleneck` / `evidence` | `PROVIDER_CEILING` / `MEASURED` | unchanged |

`accountId: null` on all 99 activations is correct rather than broken: they are
Step 10's, and they predate the attribution columns. The `routedDecisions` are
Step 11's, and those carry an account.

And `fleet simulate --queue 50`, which before the fix could only say "nothing
can be simulated from an empty trace":

```
trace      1 measured activation(s)
NOTE       every line below is SIMULATED, never observed throughput.
SIMULATED   5 workers  completed=50/50 activations=25 wall=163s trace=trace_00135272_1
SIMULATED  10 workers  completed=50/50 activations=25 wall=82s  trace=trace_00135272_1
SIMULATED  20 workers  completed=50/50 activations=25 wall=41s  trace=trace_00135272_1
SIMULATED  30 workers  completed=50/50 activations=25 wall=0s   trace=trace_00135272_1
SIMULATED  50 workers  completed=50/50 activations=25 wall=0s   trace=trace_00135272_1
SIMULATED  live fleet  completed=50/50 activations=25           trace=trace_00135272_1
  unknown: Only 1 measured activation(s) in the trace, so the cost distribution
           is that many points repeated rather than a distribution.
  unknown: Account "primary" has no measured concurrency, so its 1 Routine(s)
           are modelled as one activation each — a floor, not an estimate.
  unknown: Account "primary" has no observed fire ceiling. The simulation does
           not invent one, so its refusals are only those explicitly configured.
```

Every line is labelled `SIMULATED` and carries a content-addressed trace id, and
the three unknowns are named rather than defaulted — which is the difference
between a projection and a measurement, and the reason a projection can never be
read back as one. One sample rather than 83 is also correct: only executions
that finished *after* the duration fix have one, and the earlier eighty-one are
honestly unmeasurable rather than retro-fitted.

### One committed fix the running Brain does not have

`activationTrace` filtered on `total > 0`, which drops an execution that
finished inside the same millisecond it started. It surfaced as a
one-in-three flake in the very test written to prove durations are recorded —
a test lease is held for well under a millisecond, which is exactly the case the
filter discarded. Fixed to `>= 0`, ten consecutive clean runs, committed, and
**not deployed**: the budget is spent and real activations take tens of seconds,
so this is a duration production never produces.

The same is true of a `set-state` hardening: `--kind ACCOUNT` fell through to the
Routine branch and reported "no Routine registered as primary" — true, useless,
and about the wrong noun. Committed; the running operator script still wants
lowercase `--kind account`, which is the form this document's runbook names.

---

### The second account, and what it proved

`friend-2` / `V2` on `trig_01HR74Tm…`, secret `BRAIN_ROUTINE_TOKEN_2`, digest
`c5b7f5592cd6…` — **distinct from V1's `dfe19a3cfd02…`**, which is the check
that makes "two accounts" a fact rather than one credential registered twice.

Registration was refused twice before that, correctly, because the secret was
not yet in the deployment: a row pointing at an absent secret would be a Routine
that looks routable and spends a fire discovering it is not.

| | | |
|---|---|---|
| **L2** second account fires | `fires=6 refusals=0 no-shows=0` on V2 | PASS |
| **L3** distribution | four bins split **2/2** — V1 10→12, V2 4→6 — bounded by per-account targets of 2 | PASS |
| **L4** failover | `primary`→UNAVAILABLE, two bins **both** to V2 (4→6), V1 held at 12; restored to ENABLED | PASS |
| **L5** target raise, no deploy | FLEET — → 2 → 4, plus ACCOUNT targets, all policy INSERTs | PASS |
| **L6** boost and expiry | `target=8 until=22:11:59 version=3 base=4` | PASS |
| **L8** additional Routine | V2 registered into a *running* fleet and took work on the next tick | PASS |

The policy table is the audit trail it was meant to be:

```
v3  target=4  boost=8 until 2026-09-02T22:11:59.726Z  operator:fleet-cli: Boost to 8 …
v2  target=4  boost=—                                  operator:fleet-cli: L5 raise ceiling to four …
v1  target=2  boost=—                                  operator:fleet-cli: Step 11 baseline ceiling …
```

The base target stays 4 underneath the boost, and the boost lapses by being
compared to the clock — nothing runs to revert it.

### A fairness gap the two-account run exposed

Before the per-account targets were set, a burst of four across two idle
accounts went **four-nil**, and the next batch went four-nil the other way.
Alternating per tick rather than spreading within one.

`relativeHeadroom` returns the same number for two surfaces with no configured
target, so the whole decision falls to the least-recently-fired tiebreak — and
that was read once at the top of the tick and never advanced, so it named the
same surface for every iteration of the burst. The in-burst accounting was
updating `fireGeneration` and `routineInFlight` but not `lastFiredAt`.

Account targets bound the ceiling and are the right control for *that*. They are
not a fix for the fairness, because a fleet may legitimately run with no targets
at all. Fixed by advancing `lastFiredAt` in the local snapshot too, with a test
that a four-bin burst across two untargeted accounts lands 2/2.

### `fleet show` was overstating the fleet

It printed `candidates 2 routable now` while `primary` was UNAVAILABLE and could
take nothing. `fleetSnapshot` builds the candidate list from registration and
secret presence; *routability* is decided inside `routeBin` against account
state, Routine state and `retry_at`. The line now reports
`N considered, M eligible now`, with the eligible count obtained by asking the
router rather than by a second implementation of its rules.

---

## 5. What is not claimed

### S19 — audit independence is not enforced anywhere

`services/research/independence.ts` is correct, and it is proven on both
backends: self-audit refused, PRIMARY/ADVERSARIAL session sharing refused,
SESSION passing where ACCOUNT fails, unrecorded lineage counted as a violation.

**It has no caller.** `grep` across `server/` returns the module and nothing
else. `startPass` takes no lineage and never writes `executor_worker_id`,
`executor_routine_id`, `executor_account_id` or `executor_session_ref`, so those
four columns are empty in every row, and no completion path consults them.

This document previously marked S19 as passed on the strength of its test file.
That was wrong, and it is the failure mode this whole step is written against: a
control that exists, is tested, and is not connected is not a control. The
matrix now reads FAIL.

L9 and L10 are blocked by it rather than by provisioning — with no lineage
recorded, there is nothing for a judge to be independent *of*.

The remedy is bounded and the capture point already exists:
`server/mcp/researchTools.ts` `recordPass` is handed the `workerId` of the
submitting worker, and the worker resolves to a Routine and an account through
the same `bin_dispatch` row the arrival crediting already uses. What is missing
is passing that lineage into `startPass`, and calling `checkIndependence` before
a JUDGE pass is accepted.



**Cross-account routing on two subscription accounts is not proven.** One
account is registered. Everything the router does about accounts — failover,
per-account targets, spreading by relative headroom, audit lineage at `ACCOUNT`
level — is proven in tests against both backends and is **not** proven live,
because a second real subscription does not yet exist in the registry.

Two Routines under one account would not close it. That proves routing across
*surfaces* and says nothing about routing across *allowances*, and conflating
the two is the exact confusion the schema was shaped to avoid.

**No allowance was measured.** Step 10 measured a per-routine fire ceiling and
said so; Step 11 has not measured a subscription allowance either, and
`declared_plan_power` on the registered account is recorded as `unknown` rather
than as a number somebody guessed.

**Step 11 did not run a second Brain instance.** It made one Brain able to
direct many *workers*, which is a fleet of execution surfaces rather than a
fleet of Brains. The two things `ROADMAP.md` listed as Step 11's to resolve
before a second machine — the per-instance research and extraction queues, and
the per-process sign-in throttle — are untouched, still correct at one machine,
and inherited by whatever runs the second.

**Some live rows are Step 10's, and say so.** `perAccount` reports
`accountId: null` for 97 activations because they predate the attribution
columns. Backfilling them would be inventing an attribution for fires nobody
recorded one for.

---

## 6. What to run next, and in what order

Once a second account and Routine are registered:

1. `fleet show` — two accounts, two routable candidates.
2. Seed four bins. Both accounts should fire; `fires` moves on both rows. (L3)
3. `fleet set-state --kind account --ref <name> --to UNAVAILABLE`, seed two more,
   confirm every one goes to the survivor, then re-enable and confirm the split
   returns. (L4)
4. `fleet boost --target 4 --minutes 30 --reason …`, confirm the higher ceiling
   applies, then confirm it stops applying after expiry with nothing having run
   to revert it. (L6)
5. A research packet whose PRIMARY and ADVERSARIAL passes land on different
   accounts, then a JUDGE on a third lineage — and a deliberate same-session
   submission, which must be refused. (L9, L10)

Steps 3 and 4 are the ones that decide the step. The rest are already proven in
tests and are being re-run live for the same reason Step 8 insisted a passing
suite is not evidence that a real client works.
