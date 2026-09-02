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

### What the profile does read

`fleet profile` against production, over all recorded history:

```
binsCompleted 81   activations 97   routedDecisions 4
providerRefusals 34   takeovers 2   unrouted 0
bottleneck PROVIDER_CEILING   evidence MEASURED
perAccount: [{ accountId: null, activations: 97, refusals: 34 }]
```

`accountId: null` on 97 activations is correct rather than broken: they are
Step 10's, and they predate the attribution columns. The four `routedDecisions`
are Step 11's, and those carry an account.

---

## 5. What is not claimed

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
