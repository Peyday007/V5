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
| Postgres, concurrent connections | **1273 / 1273** |
| SQLite | **1248 passed, 25 skipped** (OCR fixtures) |
| Fleet suite | **59 tests**, both backends |
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

## 4. Live fleet — status

*(filled in from production rows; see the matrix in `STEP-11-PLAN.md`)*

---

## 5. What is not claimed

