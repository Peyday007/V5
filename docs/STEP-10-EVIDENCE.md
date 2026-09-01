# Step 10 — Event-driven bin dispatch: what was proven

Step 10 asked one question:

> **Can Brain turn "there is ready work" into "a Claude session is running that
> work" with no person in the loop and no model idling anywhere?**

This file separates three things that are easy to blur: what a live run
demonstrated, what only passes its tests, and what nobody has watched happen.

The design is in [`STEP-10-PLAN.md`](STEP-10-PLAN.md). The frozen Step 9
baseline this step must not disturb is recorded there and re-read at the end of
this file.

> **Status: the core claim is proven; the capacity work is not.** Brain fires,
> an unattended worker acts, and Brain validates the result — measured end to
> end in production. The concurrency ramp has not run, no real research bin has
> gone through, and the operating standards below are contaminated by the
> outage that preceded the fix. Nothing here claims otherwise.

---

## The separation this step turns on

Two things could each be true or false independently, and conflating them is
how a step gets called done early:

| | What it means | How it is proven |
|---|---|---|
| **The bin protocol** | a worker can be handed a fully specified package, drain it, and have Brain validate the result | a worker completes a bin end to end |
| **Dispatch** | *Brain* caused that worker to exist | a bin drains with nobody having started anything |

A bin drained by a session a human started proves the first and says **nothing**
about the second. That distinction is why `scripts/step10.ts trace` exists: it
prints each bin's dispatches, events and units with the worker and session that
caused them, so attribution is read rather than assumed.

---

## What is proven

### Unattended activation — PROVEN, and my diagnosis of the block was wrong

At 07:41:42Z a bin became `READY`. Brain fired three seconds later. The
activation ran 07:41:45 → 07:43:32 — **107 seconds** — and in that time one
worker drained **every bin in the backlog**, with nobody watching:

```
BIN_ASSIGNED            7        BIN_TAKEOVER             2
BIN_COMPLETION_ACCEPTED 7        BIN_UNIT_SUBMITTED      23
BIN_TERMINAL            7        DISPATCH_SENT            7
```

All seven bins `COMPLETE`, `DETERMINISTIC_UNITS_V1 v1 evaluated true` on each,
**zero completion refusals**. That is the whole loop: Brain decides there is
work, Brain starts a worker, the worker executes the manifest, and Brain — not
the worker — decides the work is done.

**What actually fixed it was the project-scope permission rule, and I argued
against it.** Two routines, both fired by Brain, both carrying the connector:

| | blocked (`trig_017iVU…`) | works (`trig_01CBLu…`) |
|---|---|---|
| `created_via` | `meta_mcp` | `http_api` |
| `allowed_tools` | 20 entries, **no `mcp__*`** | 8 entries, **no `mcp__*`** |
| `sources` | absent | `Peyday007/V5` |

**Neither routine has an `mcp__*` entry in `allowed_tools`, so the allowlist
cannot be the discriminator.** An earlier version of this file named it as the
cause, twice, and that was wrong. The change that mattered is the repository:
with it attached the worker checks out the default branch — which is this branch
— reads `.claude/settings.json`, and finds `permissions.allow` pre-approving the
connector. `created_via` also differs and cannot be formally excluded, but no
mechanism connects it to a permission prompt, and the settings-file path
explains the result exactly.

The clone check was still the thing that made this legible: the earlier routine
had no `sources` key, so the documented rule had nowhere to be read from. The
error was concluding the rule was therefore beside the point, when it was the
answer waiting on a precondition.

### Worker death and takeover — PROVEN in production

Two `BIN_TAKEOVER` events in that run, unforced. `bin_a25fbc6da09445a0ad2c` —
the bin whose stranding exposed the dispatch defect — finished `COMPLETE` at
`attempt 3/3 gen 4 intents 3 sent 3`: three separate activations, a generation
advanced on each takeover, the fence holding throughout, and the work finished
by a worker that was not the one that started it.

That is the second half of the recovery story the dispatch fix opened, and it
happened without anybody asking for it.

### One activation drains a whole bin, then asks for another — PROVEN

Five bins went `COMPLETE` inside a single 107-second activation. The permanent
instructions tell a worker to return to step 1 after finishing, and it did.

### The dispatcher fires without a person

`services/dispatch/loop.ts` is a `setInterval` that reads two tables and
sometimes makes one HTTP request. No model, nothing waiting on a socket,
nothing that has to stay alive for correctness. In production it took a bin
from `READY` to a fired activation with no human involvement, and the fire is
recorded as a `DISPATCH_SENT` row carrying the provider's own session id from
the fire response — Brain's knowledge of which sessions it started, obtained
without trusting anything a worker says about itself.

### Dispatch intent survives a crash

The obvious design POSTs to `/fire` at the moment a bin becomes `READY`. It is
wrong because the transition happens inside a request, and the request can
commit and the process die before the call is made — leaving a bin `READY`
forever with nothing coming for it and nothing aware it was missed.

So the transition writes a durable **intent** and a separate pass turns intents
into calls, keyed:

```sql
CREATE UNIQUE INDEX idx_bin_dispatch_intent ON bin_dispatch (bin_id, lease_generation);
```

`ON CONFLICT DO NOTHING` makes the ensure pass idempotent, so running it every
tick forever creates exactly one row per bin per generation. Production shows
`DISPATCH_BOOT_RECOVERY` rows: the first tick after each restart redrove what
was outstanding.

The same key is why a bin already fired at its current generation does **not**
fire again — observed directly, when a re-seed left a previously dispatched
`READY` bin alone because its intent was already `SENT` at that generation.

### Assignment is atomic, and the generation is the fence

Unchanged in shape from Step 5's queue, because the lesson transfers exactly:
**a claim is a compare-and-swap on a value the claimant does not supply.**
Heartbeat, checkpoint, complete, fail and release each carry the whole proof —
bin, lease id, generation, the worker id *from the authenticated principal*, the
`LEASED` state, and an unexpired lease — in a single guarded `UPDATE`. There is
no read-then-write, so there is no window for a race to live in.

A `CHECK` constraint makes "a lease exists iff the bin is `LEASED`" impossible
to violate rather than merely untested.

### Brain decides completion, not the worker

`services/bins/contracts.ts` recomputes what it can. The acceptance bins are
deliberately not echoes: each unit names an input and a transform, and Brain
applies the transform itself and compares. A worker that returns the input
fails. That is the property that makes the bins worth running at all.

`DETERMINISTIC_UNITS_V1` evaluated true for the bins recorded as `COMPLETE`,
and `evaluateContract` refuses an unknown contract rather than passing it.

### A worker inside a bin cannot reach the wider queue

`brain_claim_work` is confined by `activeBinForWorker(workerId)` — derived from
the server's own rows, not from a worker remembering to stay put.

### The permanent instructions carry no assignment

`workerInstructions.ts` holds one prompt for every worker, and
`instructionProblems()` refuses an id-shaped string, a project name, a step
number, a fixed topic or any phrase inviting a worker to choose its own work.
The check is a regex over id shapes rather than a substring scan — an earlier
version matched its own tool-name prefix `bin_` and had to be corrected.

### The tests

`tests/bins.test.ts` — **49 tests, all passing**, on SQLite and on Postgres —
across atomic assignment, the fence, dead-worker takeover, dead-worker
*dispatch*, bin confinement, Brain-decides-completion, dispatch intent,
one-activation-drains, the governing invariant, telemetry, and the permanent
instructions.

The whole suite: **1120/1120 on Postgres**, 1095 passing and 25 skipped on
SQLite.

Two of them exist because inverting the code did **not** break them at first:
the assignment CAS's generation guard and the ownership clause's generation
term were both being carried by neighbouring predicates — the state-and-expiry
check, and freshly minted lease ids. The tests were tightened until removing the
generation term alone fails. Recorded rather than quietly fixed, because a test
that passes for the wrong reason is worse than a missing one.

---

## The defect production found

**The dispatcher and the assigner disagreed about what "there is work" means,
and only one of them could start a worker.**

A live trace of `bin_a25fbc6da09445a0ad2c` read:

```
05:19:14.849  BIN_READY
05:19:18.168  DISPATCH_INTENT   PENDING
05:19:19.611  DISPATCH_SENT     session_01PwUw2v5iK5sUtDvyPMJXDL
05:37:14.363  BIN_ASSIGNED      wkr_1cdd82cfb2a54faf8edd
              no units, no further heartbeat
  lease expires 05:52:14 — still LEASED when read at 06:03:55
```

Eleven minutes past its own expiry, still held by a worker that had stopped.
`assignNextBin` would have handed it to the next worker who asked — it has
always selected `READY OR (LEASED AND lease_expires_at <= now)`, which is §19's
property that recovery must not depend on one process staying alive. But three
other places wrote the predicate out again and all three said only `READY`:

| where | predicate |
|---|---|
| `assignNextBin` | `READY OR (LEASED AND expired)` |
| `dispatchTick` ensure pass | `states: ['READY']` |
| `dispatchTick` pre-fire re-read | `bin.state !== 'READY'` |
| `supersedeStaleIntents` | `state <> 'READY'` |

So a worker that dies leaves a bin that is claimable and **never activated**.
If something else happens to be ready, another worker eventually stumbles on it;
if nothing is, nobody ever calls and the bin waits forever. That is precisely
the promise Step 10 exists to keep, failing in the one case it was built for.

The fix is one exported predicate — `DISPATCHABLE_SQL`, `isDispatchable`,
`listDispatchableBins` — used by all four. Deliberately **not** fixed by calling
`sweepExpiredBinLeases` on a timer: a sweeper that must run for stranded work to
be recovered is exactly the dependency on a living process that §19 forbids,
wearing a different hat. The sweeper stays what Step 5 said it was — metrics.

Five tests cover it, and two of them fail when the fix is inverted: the ensure
pass narrowed back to `READY` strands the bin, and the supersede pass widened
back to `<> 'READY'` retires the new intent a moment after it is created — which
would have made the fix invisible rather than merely absent.

### Verified live, on the bin that exposed it

The same bin, after the fix shipped:

```
DISPATCH
  gen 0  SENT  sent 05:19:19.581Z  session_01PwUw2v5iK5sUtDvyPMJXDL
  gen 1  SENT  sent 06:20:42.962Z  session_01BqPG6pBHW4ms6vjjt8yjYx

06:20:31.283  DISPATCH_INTENT  PENDING
06:20:42.996  DISPATCH_SENT    session_01BqPG6pBHW4ms6vjjt8yjYx
```

An intent at generation 1, for a bin whose recorded state is `LEASED` with a
lease that ran out an hour earlier, followed by an activation. Before the fix
that bin had no intent and would never have had one. Exactly one intent was
created, because the unique key held.

That is half of worker-death recovery proven in production: **Brain now
re-dispatches for a dead worker's bin.** The other half — another worker
actually taking it over from the checkpoint — still needs an activation that can
act, so it remains proven only in tests.

This is the same failure mode as the evidence-lane defect earlier in this
project and the `attempt_count` claim bug below: **a rule written out in several
places drifts, and the copy that drifts is the one nobody is looking at.**

---

## The bug that only Postgres could find

`claimDispatchIntent` originally swapped on `attempt_count`:

```sql
UPDATE bin_dispatch SET attempt_count = attempt_count + 1, ...
 WHERE id = ? AND attempt_count = ?
```

A counter both claimers advance is not a compare-and-swap on a value the
claimant does not supply — it is a value **every** claimant supplies the same
way. Two dispatcher ticks could claim one intent and both fire it, spending two
activations on one bin.

SQLite's serialised writers hid it completely. Postgres, running the same 44
tests, produced two winners. The fix is a state transition — `PENDING` →
`SENDING` — which only one `UPDATE` can make:

```sql
UPDATE bin_dispatch SET state = 'SENDING', ...
 WHERE id = ?
   AND ((state = 'PENDING' AND next_attempt_at <= ?)
     OR (state = 'SENDING' AND next_attempt_at <= ?))
```

This is the fourth time in this repository that running the suite against the
second backend has been the only thing that made a concurrency defect visible.

---

## What is NOT proven

### The concurrency ramp

Seven rungs, each seeding N bins of 3 units at once and watching them settle
from inside the machine. The harness never fires, assigns or nudges — the
dispatcher is what is under test, so its only actions are create and read.

| rung | wall | complete | ready→fired | queue wait | drain | ready→done | assign | take | dup | refuse | expiry | stale | stranded | provider |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 (first) | 902.9s | **0/1** | — | — | — | — | 3 | 0 | 0 | 3 | 0 | 0 | 1 `READY` | none |
| 1 (rerun) | 60.3s | 1/1 | 7.1s | 22.2s | 32.2s | 54.4s | 1 | 0 | 0 | 0 | 0 | 0 | 0 | none |
| 2 | 50.3s | 2/2 | 9.9s | 24.0s | 21.2s | 45.2s | 2 | 0 | 0 | 0 | 0 | 0 | 0 | none |
| 5 | 70.6s | 5/5 | 14.8s | 29.2s | 26.0s | 56.0s | 5 | 0 | 0 | 0 | 0 | 0 | 0 | none |
| 10 | 91.1s | 10/10 | 14.1s | 27.3s | 28.1s | 61.1s | 10 | 0 | 0 | **3** | 0 | 0 | 0 | none |
| 20 | 111.8s | 20/20 | 19.1s | 41.0s | 24.7s | 62.9s | 20 | 0 | 0 | 1 | 0 | 0 | 0 | **RATE_LIMIT×4** |
| 30 | *running* | | | | | | | | | | | | | |
| 50 | *not yet run* | | | | | | | | | | | | | |

All medians. `ready→fired` at rung 20 is n=13 rather than n=20, because seven
activations were never sent — see below. **Across every rung: zero duplicate
activations, zero fenced stale writes, zero takeovers, zero stranded bins.** The
fence held without ever being tested by a real collision, which is worth saying
precisely rather than claiming it was stressed.

Ready→fired grows with rung size — 7.1s, 9.9s, 14.8s, 14.1s, 19.1s — and that is
`DISPATCH_BURST = 5` per ten-second tick becoming visible, not the provider
slowing down. A rung of 20 needs four ticks before the last intent is even
attempted.

**Rung 1 failed the first time and found a defect** — a unit result could not be
corrected, so one truncated hash killed a bin permanently. Fixed, deployed, and
the rung rerun clean. Written up under *The second defect production found*.

**Rung 10 is the most valuable row in the table**: three completion refusals
*and* ten of ten complete. Brain caught three wrong values under load and the
workers corrected them. Before the fix those were three dead bins; the same
numbers now describe a fleet recovering from its own mistakes.

**Rung 20 is where the provider ceiling appears.** Four dispatch attempts came
back `RATE_LIMIT`, so only 13 of 20 activations were ever sent — and all 20 bins
still completed. That is the single most useful operating fact the ramp
produced, because it means **activations are not bins**: a worker that finishes
one bin asks for another, so a rate-limited fleet degrades in throughput rather
than in completeness. Brain's own behaviour on the limit was what §16 requires —
back off, stop the burst, keep the accepted work, spend nothing more.

### Production proofs still outstanding

- one bounded **real research bin** through the full lifecycle
- ~~worker death and takeover in production~~ — **done**, see above: two
  unforced takeovers, and the bin that exposed the dispatch defect finished at
  `attempt 3/3 gen 4`.
- duplicate-trigger behaviour **in production**
- restart and redeploy persistence **in production** (`DISPATCH_BOOT_RECOVERY`
  rows exist, but no deliberate mid-flight restart has been performed)
- operating standards derived from *clean* measurement. There are numbers now
  and they are useless as standards: median queue wait 1,653,165 ms and median
  ready→done 1,685,311 ms across seven bins. Those measure how long the
  permission outage lasted, not how a working fleet behaves — five of the seven
  bins sat `READY` for half an hour because nothing could pick them up. The only
  honest figures so far are ready→fired (**3.1 s**, **4.7 s**, **8.6 s** on
  three separate bins) and one activation draining five bins in **107 s**. A
  standard needs a rung of the ramp measured on an unblocked fleet.

---

## Findings about measurement itself

### A competing schedule was draining the acceptance bins

An hourly routine from Step 9 (`trig_01HCVV7m2TfcteXKSRJXF3G3`) was enabled,
pointed at `orc_be4ddfe7388b40be9e01`, and its sessions have **no** tool
allowlist — so they check in successfully and take bins. Bins were therefore
completing without a corresponding `DISPATCH_SENT`, which reads at a glance
like dispatch working and is the opposite.

It was disabled. Two reasons, both sufficient: it was aimed at a packet frozen
as closure evidence, and any bin it drains is a bin Brain did not activate.

With it disabled there is **no other activation source**, which is what makes
the acceptance argument clean: nobody presses anything, and a bin still goes
from `READY` to `COMPLETE`.

### A fired activation that never arrives is not retried

Found while reasoning about the fix above, not yet fixed, and recorded rather
than built speculatively.

An intent goes `PENDING → SENDING → SENT`. Once `SENT`, nothing revisits it. If
the activation Brain fired never produces a worker — exactly what is happening
right now, because fired sessions stall at a permission prompt — the bin keeps
its `SENT` intent at that generation, and `ensureDispatchIntent` cannot make
another one because the unique key `(bin_id, lease_generation)` already holds
it. Brain fires once and then waits forever.

It is not a permanent strand, and the reason is worth stating because it is what
makes leaving it defensible for now: the bin stays dispatchable, so **any**
worker that checks in takes it, and the permanent instructions tell every worker
to ask for another bin after finishing one. The fleet self-heals as long as
something succeeds. What it cannot do is recover from being *entirely* idle with
one stranded bin.

The fix has a shape — treat an activation that has not checked in within some
deadline as a failed attempt, advancing the generation so the ordinary ensure
path issues a fresh intent — but the deadline is a capacity judgement, and the
only honest source for it is the measurement the ramp has not yet produced.
Choosing a number now would be inventing the operating standard this step is
supposed to derive. Carried forward with the ramp.

### The permanent prompt is duplicated in the routine

`WORKER_INSTRUCTIONS_VERSION` lives in Brain, but the routine holds a **copy**
made when it was created. Brain reports the version it believes in and cannot
see the routine's, so prompt drift is currently undetectable and unfixable from
Brain. Carried forward.

---

## The frozen baseline, re-read

`orc_be4ddfe7388b40be9e01` read from authoritative rows at 2026-09-01T06:26Z,
after every change in this step, against the record in
[`STEP-10-PLAN.md`](STEP-10-PLAN.md):

| Field | Baseline | Re-read | |
|---|---|---|---|
| Orchestration | `COMPLETE` | `COMPLETE` | ✓ |
| Work items | 15 SUCCEEDED — 1 PLAN, 5 FRAGMENT, 5 VERIFY, 1 SYNTHESIZE, 3 AUDIT | 15 — 1/5/5/1/3, all SUCCEEDED | ✓ |
| Claimable | 0 | 0 | ✓ |
| Claims | 26 stored, 16 accepted | 26 stored, 16 accepted | ✓ |
| Passes | 15 | 15 | ✓ |
| Audit | `aud_e4fdb58b2ae34c0bbac7` READY_FOR_SYNTHESIS, 2 gaps | identical | ✓ |
| Document | `doc_57277dfc5f1242b4b7ab` v1B, 26,900 bytes, present, extraction READY | 26,900 bytes read from the bucket, extraction READY, 26,528 chars | ✓ |

Not reopened, rerun, superseded, recovered or modified. Step 10 ran in its own
project throughout and no subcommand of its harness can reach Deal Dispatch.

