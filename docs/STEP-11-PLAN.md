# Step 11 — Multi-account subscription fleet: the plan and the completion matrix

Step 10 proved one Routine. It ended with a measured number and a warning about
how to read it: **ten clean concurrent bins on one Routine is a starting
observation, not a fleet-wide maximum**, and the ceiling it found was a
per-routine fire limit rather than the subscription allowance.

Step 11 turns that single working activation path into a fleet Brain can
measure, route across, and be told to push harder. The governing principle,
which decides most of the design below:

> **Never infer fleet capacity from account count alone.** Measure completed
> work per account, Routine, workload class and reset period; keep unknowns
> explicit; and let Brain or the operator deliberately raise the target.

---

## What Step 10 leaves to build on

Read before designing, and reused rather than replaced:

| Piece | Where | What Step 11 does to it |
|---|---|---|---|
| Bins, leases, fencing | `repos/bins.ts` | untouched |
| Completion contracts | `services/bins/contracts.ts` | one new independence check |
| Dispatch outbox | `bin_dispatch`, unique on `(bin_id, lease_generation)` | gains a routine attribution column |
| Dispatcher | `services/dispatch/loop.ts` | its send pass asks a router which Routine, instead of firing the one in the environment |
| Fire | `services/dispatch/fire.ts` | takes a resolved target instead of reading two environment variables |
| Telemetry | `bin_events`, append-only | gains account/routine/evidence-class attribution |
| Packet runner, research, audit roles | `services/research/` | untouched except audit lineage |

The single most important existing fact: **`fireConfig()` reads
`BRAIN_ROUTINE_ID` and `BRAIN_ROUTINE_TOKEN` from the environment.** That is the
whole of Step 10's fleet model — one Routine, named at deploy time. Everything
in 11.1 and 11.4 exists to replace that one function with rows, without
changing what a fire *is*.

---

## The design in one page

**Accounts and Routines are separate tables because they are separate
resources.** An account has a subscription allowance. A Routine has a fire
surface. Two Routines under one account double the dispatch surface and do not
double the allowance — Step 10 measured the fire ceiling and could not measure
the allowance, and the schema has to be able to express that difference or the
fleet will be sized on a number that means something else.

**Secrets stay where they are.** A Routine row stores the *name* of the
deployment secret holding its token and a sha-256 digest of the value, never the
value. `fireRoutine` resolves the name to a value at call time, exactly as
Step 10 read the environment — so nothing about credential handling changes,
and a row, a log line, a report or a chat message still cannot leak one.

**The router is a pure function over rows plus one guarded claim.** It ranks
eligible Routines and hands the dispatcher one target; the atomic part is
unchanged — `claimDispatchIntent` still compare-and-swaps on `state = 'PENDING'`,
so two ticks cannot both send the same intent whatever the router decided.

**Policy is versioned rows, not configuration.** Targets, boost, auto-scale
ceiling, reserves and drain are rows with an actor, a reason and a version, so
raising the target is a database write rather than a deploy, and every change is
in the audit trail and reversible.

**Evidence is classified.** Every capacity fact is `UNKNOWN`, `MEASURED`,
`INFERRED`, `PROVIDER_ENFORCED` or `OPERATOR_POLICY`. An unknown five-hour
allowance stays unknown; it never becomes a percentage because a percentage
would be easier to render.

**Audit independence is lineage, not naming.** A research pass records the
worker, Routine, account and session that produced it. The independence policy
is a versioned row; completion refuses a packet whose audit lineage violates it.

---

## Completion matrix

The close-out checklist. Every row is a condition from the build contract.

### Software

Every row below passes on both backends as of the Step 11 software commit:
1273 tests on Postgres, 1248 with 25 skipped on SQLite (the skips are the
OCR-runtime cases SQLite's fixture set does not build). The fleet suite is 59 of
them.

| # | | Condition | Where proven |
|---|---|---|---|
| S1 | PASS | Account and Routine registered as durable rows | `fleet_accounts`, `fleet_routines` |
| S2 | PASS | Routine belongs to exactly one account; many Routines per account | FK + test |
| S3 | PASS | Account capacity and Routine fire surface separately modelled | separate targets, separate headroom |
| S4 | PASS | Add/remove/drain an account or Routine with no code, schema, prompt or deploy change | registry commands + test |
| S5 | PASS | Secrets by reference and digest only | schema has no value column; leak test |
| S6 | PASS | Capacity ledger attributes every dispatch event to account and Routine | `bin_events` attribution |
| S7 | PASS | Evidence classified; unknown stays unknown | `evidence_class` + inversion |
| S8 | PASS | Refusal and reset history append-only | no update path; test |
| S9 | PASS | Targets raised and lowered without deployment | `fleet_policy` rows |
| S10 | PASS | Boost with actor, reason, target and expiry | policy + expiry test |
| S11 | PASS | Auto-scale raises and lowers within its ceiling | scaler + test |
| S12 | PASS | Router selects on fleet state, no hard-coded ids | router + test |
| S13 | PASS | Rate-limited Routine skipped until `retry_at`, then resumed | router + test |
| S14 | PASS | Work routes around an unavailable surface | failover test |
| S15 | PASS | No duplicate dispatch per generation, and no duplicate Routine selection, under Postgres concurrency | two CASes: `bin_dispatch` PENDING→SENDING, and `fleet_routines.fire_generation` |
| S16 | PASS | Health responses proportional; quarantine and guarded recovery | health + test |
| S17 | PASS | No breaker deletes history or resets attempts downward | inversion |
| S18 | PASS | Independent work runs in parallel; dependent work waits on prerequisites | packet runner + test |
| S19 | **FAIL** | Audit independence enforced by lineage; completion refuses a violation | Lineage is now recorded on every pass. Enforcement was wired, and refused every packet: one worker identity performs all three roles, because a worker is per-Routine rather than per-session. Reverted rather than weakened; the fix is in the assigner. Marked PASS earlier on the strength of the test file, which was wrong. |
| S20 | PASS | Workload profiles attribute cost to idea, class and policy version | profile report; live `medianActivationMs=21487`, `unknowns=[]` |
| S21 | PASS | Simulation covers 5/10/20/30/50, the live fleet, and larger parameters | deterministic replay; run live, `trace_00135272_1` |
| S22 | PASS | Simulated output structurally distinct and never production evidence | label + test |
| S23 | PASS | Operator commands refuse false success and name the actor | dry-run + changed-row reporting |
| S24 | PASS | SQLite and Postgres suites pass, including inversions | both chains |
| S25 | PASS | Migrations from empty and upgrade from production shape | both chains |
| S26 | PASS | Typecheck, build, clean boot, real restart, hosted verification | deploy pipeline |
| S27 | PASS | Step 9 and Step 10 protected baselines intact | baseline re-read |

### Live fleet

| # | Condition | Needs |
|---|---|---|---|
| L1 | PASS | Historically working Routine still fires | `fires=4 refusals=0` through the registry; full trace in STEP-11-EVIDENCE.md |
| L2 | PASS | A second subscription account with at least one Routine checks in | `friend-2` / `V2` on `trig_01HR74Tm…`, digest `c5b7f5592cd6…` distinct from V1's `dfe19a3cfd02…`; fires=6 refusals=0 no-shows=0 |
| L3 | PASS | Two bins route without fixed pairing across accounts | four bins split 2/2 across `primary` and `friend-2` (V1 10→12, V2 2→4) under per-account targets of 2 |
| L4 | PASS | Disabling one surface routes new work to the other; re-enabling restores it | `primary`→UNAVAILABLE, two bins both to V2 (4→6) with V1 held at 12; then restored to ENABLED |
| L5 | PASS | Raising the target through policy increases dispatch with no deploy | FLEET — → 2 → 4 (versions 1, 2) and ACCOUNT targets of 2 each, all policy INSERTs, no deploy; the raise to 4 is what let a burst of four fire at once |
| L6 | PASS | Boost raises then reverts | `boost target=8 until=22:11:59 version=3 base=4` — the base target is untouched at 4 and the boost lapses by clock comparison, with nothing running to revert it |
| L7 | PASS (Step 10) | One activation drains a bin and asks for another | Step 10 rung 20: 20 bins from 13 activations. Step 11's four bins each took one activation, so this run does not re-prove it |
| L8 | PASS | Registering an additional Routine makes it eligible with no code change | V2 registered into a running fleet and took work on the next tick; no deploy, no restart, no code change |
| L9 | **BLOCKED** | PRIMARY and ADVERSARIAL run concurrently through different accounts | blocked by S19, not by provisioning: there is no lineage recorded to be independent *of* |
| L10 | **BLOCKED** | JUDGE runs after both, on independent lineage; same-session lineage refused | blocked by S19 |

### The one design change the tests forced

`routeBin` is a pure function over a snapshot read once per tick. That is the
right shape for a decision you want to replay and argue with, and it is not a
safety mechanism: two dispatchers, or two iterations of one burst, both compute
correctly that a surface has headroom and both fire it.

So Routine selection acquires a slot with a compare-and-swap on
`fleet_routines.fire_generation` — a value the claimant does not supply, which
is the same lesson `work_items.lease_generation` and `bin_dispatch`'s
`PENDING → SENDING` swap each record. A losing claim is refused rather than
retried, so the mechanism can under-fire and cannot over-fire.

The burst *additionally* spends the headroom in its local snapshot. That is not
redundant: without it the swap still caps the burst, but it caps it by making
the dispatcher lose a race with itself, and an operator watching a one-Routine
fleet would be told it was contended. With it, the refusal names the target.
`tests/fleet.test.ts` asserts both the count and the reason for exactly this
reason.

**L2 is the gate.** Two Routines on one account prove routing across Routines
and do not prove cross-account subscription routing. Until a second real account
exists, the honest report is *software complete, cross-account proof open*.

---

## Execution boundary

3–4 hours of implementation, five-hour hard stop, at most three deployments
(vertical slice, integrated build, final correction), no wait longer than ten
minutes, and one consolidated provisioning request rather than repeated
breadcrumbs. If the stop is reached, the matrix above is returned with each row
marked passed, failed or unattempted.

## Out of scope, and named so it stays out

Step 12's UI and Fleet Lab, the recommendation engine, unknown-idea discovery,
provider-diverse audits, a new bin substrate, fifty real Routines, and any
purchase or paid overage.
