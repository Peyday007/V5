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

### S19 — the signed matrix, enforced before the lease

**The contradiction, resolved in five lines.** The signed contract is two
dimensions, not one. L9 asks PRIMARY and ADVERSARIAL to run "through different
accounts" — ACCOUNT. L10 asks the JUDGE for independent lineage with
"same-session lineage refused" — SESSION. Applying one uniform level to all
three pairs demands three pairwise-distinct accounts (impossible on two) or
three worker identities (impossible on two Routines); neither was ever asked
for. **Two accounts and three sessions satisfy the signed matrix exactly**, so
the earlier report was right that two accounts give the roles somewhere to go
and wrong about the level it read them at.

| pair | dimension | why |
|---|---|---|
| `PRIMARY_ADVERSARIAL` | **ACCOUNT** | L9, verbatim |
| `JUDGE_PRIMARY` | **SESSION** | L10, verbatim |
| `JUDGE_ADVERSARIAL` | **SESSION** | L10, verbatim |

It is a constant in `services/research/auditEligibility.ts`, per pair, because a
caller that could choose the level is a caller that could lower it. **No count
appears in it**: adding or removing accounts widens or narrows the eligible set
and changes no rule.

### Brain owns the operation

| # | Requirement | Where |
|---|---|---|
| 1 | eligibility decided before lease *or* execution | `claimWork`'s `admit` hook, ahead of the compare-and-swap |
| 2 | PRIMARY/ADVERSARIAL on different accounts | `SIGNED_AUDIT_MATRIX.PRIMARY_ADVERSARIAL` |
| 3 | JUDGE on the exact required lineage | `JUDGE_PRIMARY` / `JUDGE_ADVERSARIAL` at SESSION |
| 4 | account, Routine, worker and session recorded | four `executor_*` columns, written by `recordPass` |
| 5 | one activation cannot drain conflicting roles | a second role in the same session is refused at claim |
| 6 | refusal consumes nothing | the hook runs *before* the swap that increments `attempt_count` |
| 7 | route the waiting role at an eligible surface | `accountsEligibleFor` |
| 8 | refuse the verdict before storage | `auditMatrixVerdict` at the judge, before `recordAuditPasses` |
| 9 | non-audit work unchanged | the rule returns ok for every other work type |
| 10 | elastic in account count | no count in the matrix or the checker |

Every input is server-derived: the worker from the authenticated principal, the
Routine and account from `fleet_routines.worker_id` (bound by the
arrival-crediting path from the dispatch row that produced the worker), and the
session from the credential the request authenticated with — per-activation, and
the thing CF-8 measured rotating 85 times. **Nothing asks a Routine to police
itself**, and no body field contributes.

All three claim entrances use the same rule — the MCP tool, the bin service and
the HTTP route — because a guard on one entrance is not a guard. A refused
worker is told `not_eligible` rather than "no work", which is true and useless.

### Why the check runs twice

`admit` arranges independence; `auditMatrixVerdict` proves it. Both are needed: a
lease can expire and be retaken, so the surface that was eligible when it claimed
is not necessarily the one that submitted. The second check reads the recorded
lineage of the passes that actually ran, never the role name the submitter
claimed — a submitter claiming a role is the thing being checked.

### The guards are load-bearing

Proven by inversion rather than asserted:

- relaxing `PRIMARY_ADVERSARIAL` from ACCOUNT to SESSION fails **8** tests
- deleting the pre-swap `admit` hook fails **4** tests

`tests/auditIndependence.test.ts` is 15 tests on both backends: same executor
refused before lease, each pair refused at its own dimension, refusal consuming
no attempt, the eligible surface claiming immediately afterwards, two claimants
racing without defeating the rule, missing lineage failing closed, a refused
surface still draining unrelated work, and the matrix itself pinned so a change
to it is a policy decision rather than a refactor.

**1295/1295 on Postgres, 1270 passing / 25 skipped on SQLite.**

---

### Two accounts, one worker identity

S19 is enforced and L9/L10 are still not passed, and the reason is no longer
S19. The matrix is wired into the claim path and into the judge, both guards are
proven load-bearing by inversion, and the software would refuse a dependent
audit today. What it refuses is the fleet as currently *provisioned*.

Two production traces show it. The Cowork sessions started by `V1` (account
`primary`) and by `V2` (account `friend-2`) both authenticated to Brain as the
same worker — `wkr_1cdd82cfb2a54faf8edd`. One Claude account was connected
through the connector once, and the second account was then pointed at the same
connection, so both surfaces present one Brain identity.

`lineageForWorker` resolves a Routine from `fleet_routines.worker_id` and the
account from that Routine. With one worker id arriving from both surfaces, every
audit role resolves to one account, and `PRIMARY_ADVERSARIAL` at `ACCOUNT` is
unsatisfiable. **That is the check working.** An audit whose independence cannot
be established did not establish it, and the refusal is the correct outcome for
this fleet rather than a defect in the rule.

The remedy is provisioning, and it is the operator's rather than Brain's:
**each external Claude account authenticates through its own Brain worker
identity**, created by the console and connected by its own single-use
invitation. Brain must not mint workers or choose their permissions to get
around it — §22's split again, at the identity boundary rather than the
dispatch one.

The alternative — inferring an account from which Routine Brain *attempted* to
fire — is rejected permanently. It would derive the executor's identity from
Brain's own intent rather than from what authenticated, which is the same defect
as a worker declaring its own Routine, and it would let one identity satisfy a
rule about two.

### Three gaps this found in the operator surface

None of them is a defect in the matrix, and all three were things an operator
needed and did not have. All three are now fixed in code, and **none of the
fixes is deployed** — this acceptance runs against the image already released,
so what follows describes both what was wrong and what the running Brain still
does.

**1. A Routine's worker binding could not be corrected.** `bindRoutineWorker`
refuses a re-point — `WHERE id = ? AND (worker_id IS NULL OR worker_id = ?)` —
which is right, because a silent overwrite from the arrival path would hide
exactly the mix-up above. But there was no unbind, no re-point and no delete
anywhere in the repository, the script or the console, and its own refusal
message says to "retire it and register the new surface" when `UNIQUE
(routine_ref)` makes re-registering that ref impossible.

So a Routine bound to the wrong identity stayed bound to it. That is §22's rule
about escalations, at a new altitude: **a state that says "an operator must fix
this" which the operator has no action to fix is not waiting, it is stuck.**

`repointRoutineWorker` is the answering transition, and it is guarded the way
every correction in this codebase is: a compare-and-swap on a value the caller
does not supply — the binding the operator says is currently there. Naming the
wrong one changes nothing and reports it, so a re-point can never overwrite a
binding that moved while somebody was reading it. It refuses a Routine with no
binding at all, because a first binding is observed rather than decided, and it
writes both ends of the move and the operator's reason to the append-only
`identity_events` as `REPOINT_ROUTINE_WORKER`. `fleet repoint-worker --ref …
--expect … --worker … --reason …` is the operator surface for it.

**2. `fleet show` did not print the binding.** It printed state, ref, secret
name, fires, refusals, no-shows and in-flight — and not `worker_id`, which is
now the input to every audit-independence decision. The one field that decides
whether an audit may run was the one field the operator surface would not show.
It now prints `worker=…` per Routine.

**3. `lineageForWorker` took the first match, silently.** `routines.find(r =>
r.workerId === workerId)` over `ORDER BY created_at, rowid`. With one worker
bound to two Routines the answer was deterministic and arbitrary: whichever was
registered first. Here that happens to be right — the shared identity's own
account is `primary`, and `V1` is the older row — but being right by
registration order is not the same as being right.

It now names the ambiguity instead of picking from it. Several Routines on one
account still resolve that account, because the allowance is not in doubt and
only the surface is; Routines spanning accounts resolve neither, and the matrix
refuses on unrecorded lineage. Note what that means for the deployed image: the
running Brain would resolve the shared identity to `primary` by row order, and
the fixed one refuses it outright — which is why the binding has to be corrected
rather than worked around.

---

### The finding this replaced

#### (superseded) S19 — audit independence is not enforced anywhere

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

**The lineage is now recorded.** `startPass` takes the four `executor_*` fields
and `recordPass` supplies them: the worker from the authenticated principal, and
the Routine and account resolved from `fleet_routines.worker_id` — which the
arrival-crediting path binds from the dispatch row that produced the worker, so
nothing the worker says about itself contributes. When a worker is bound to no
registered Routine, both are left null rather than invented, because
`checkIndependence` counts unknown lineage as a violation and a fabricated
account id would turn a refusal into an approval.

`executor_session_ref` stays null and that is deliberate: a research work item,
unlike a bin dispatch, records no provider session. Filling it with a lease or
credential id would look like a session and discriminate nothing.

**Enforcement was then attempted, and reverted.** With the check wired into the
judge path, the existing suite failed with:

```
The audit roles are not independent, so the judgement cannot be recorded:
  PRIMARY and ADVERSARIAL shared the same worker (wkr_716f8eba7456409d84f8).
  JUDGE and PRIMARY shared the same worker (wkr_716f8eba7456409d84f8).
  JUDGE and ADVERSARIAL shared the same worker (wkr_716f8eba7456409d84f8).
```

That is the check working, and it is the real finding of this section: **audit
independence has never held.** A worker identity is per-Routine rather than
per-session, and nothing in the claim path stops one worker taking every audit
item in a packet — so one identity performs all three roles, and turning the
check on refuses every packet. It would stop all research rather than make any
of it independent.

The check was therefore reverted rather than weakened, and rather than left in
as a verdict nobody acts on: §8's rule is that a control which does not bite is
not a control, so the code does not pretend to be one. `tests/packet.test.ts`
pins the finding — it asserts that every pass now carries a worker **and** that
`checkIndependence` refuses the result, so the test fails the day the fix lands,
which is what makes it a marker for it.

**The fix belongs in the assigner, not here:** refuse handing a `RESEARCH_AUDIT`
item to a worker that already holds another role in the same orchestration. With
two accounts now registered, the three roles have somewhere to go. That is one
bounded change plus a live packet to prove it, and it is the whole of what stands
between here and S19, L9 and L10.



**Cross-account *routing* is now proven live; cross-account *audit lineage* is
not.** This paragraph previously said no second subscription existed. One does —
`friend-2` — and L3 and L4 above are live rows: four bins split 2/2, and failover
sending both bins to the survivor. Dispatch across two allowances is established.

What is still only proven in tests is the `ACCOUNT` dimension of the audit
matrix, and for a reason that has nothing to do with the router. See *Two
accounts, one worker identity* above.

Two Routines under one account would not have closed the routing half either.
That proves routing across *surfaces* and says nothing about routing across
*allowances*, and conflating the two is the exact confusion the schema was
shaped to avoid.

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

L1 to L8 are done. What remains is L9 and L10, and every step below is an
operator action or a read — no deployment, no code change.

**Provision the second identity** (console, in this order; the invite refuses a
worker with no project, so the order is not cosmetic):

1. Create the project **`Step 11 acceptance`**. The console slugifies it to
   `step-11-acceptance`, which is the slug `STEP11_AUDIT_INDEPENDENCE_V1` is
   scoped to and the slug `step10 audit-packet` looks up.
2. Create the worker `friend-2-worker`.
3. Grant that project to `friend-2-worker` **and** to the existing
   `wkr_1cdd82cfb2a54faf8edd`. One runs PRIMARY, the other ADVERSARIAL.
4. Mint the invitation for `friend-2-worker`. The URL is shown once and lives
   seven days; the browser cookie it sets lives one hour, so the connector must
   be added in the same browser inside that hour.
5. From the **friend-2** Claude account: remove the existing Brain connector,
   open the invitation, then add a connector at `<issuer>/mcp` and connect. The
   invitee needs no Brain password — that is what the invitation is for.

**Bind it** (`fleet`):

6. `bind-worker --ref trig_01HR74TmLtm8L21sh2Xryqhq --worker <new wkr_…>`.
   This is also the read: if `V2` is already bound to the shared identity the
   command refuses and names what it is bound to, changing nothing.

   On a deployed Brain, `repoint-worker --ref … --expect <the wkr_… it names>
   --worker <new wkr_…> --reason …` is the answer to that refusal. It is **not
   in the running image**, so for this acceptance the fallback is to register
   the second friend-2 trigger as a Routine of its own. That needs its own
   bearer in the deployment first: a trigger token is scoped to one trigger, so
   registering it against another Routine's secret name would store a digest
   that cannot fire it — a row that looks routable and spends a fire finding
   out.

**Run the acceptance:**

7. `step10 audit-packet` — creates the layer and starts the authorized
   assignment under the one-use envelope.
8. Drive it: PRIMARY on one account, ADVERSARIAL on the other, JUDGE in a third
   session.
9. `step10 audit-lineage <orchestration>` — the four `executor_*` fields per
   pass, the pairs applied at their own dimension, and the verdict. (L9, L10)
10. Then a deliberate same-session submission, which must be refused.

Item 5 is the one that decides this step: until the friend-2 account presents
its own identity, item 9 cannot come out any way but refused. Everything after
it is already proven in tests and is being re-run live for the reason Step 8
gave — a passing suite is not evidence that a real client works.
