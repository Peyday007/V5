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

## The third defect production found — and it was found by the real packet

**A `RESEARCH_PACKET` bin confined its worker to the empty set.**

This is the one the synthetic ramp could never have caught, and it is worth
being precise about why: every ramp bin was a `DETERMINISTIC_UNITS_V1` bin whose
work is the `units` array in its own manifest. That work never touches the
queue. A research bin's work *is* queue rows, so the real packet was the first
thing to exercise the path at all — 71 bin tests and six clean ramp rungs said
nothing about it.

The trace of `bin_204f246c43b641afa5a5`, three activations in six minutes:

```
19:31:24  BIN_READY
19:31:28  DISPATCH_SENT           session_01PHT6p2nrasDt1kTh1AEhxp
19:31:47  BIN_ASSIGNED            wkr_1cdd82cfb2a54faf8edd
19:32:10  BIN_QUALITY_SIGNAL      NO_RECORDED_WORK
19:32:10  BIN_COMPLETION_REFUSED  The packet is PLANNING, not COMPLETE.
19:34:02  BIN_RELEASED            "Packet stuck in PLANNING: the one open
                                   RESEARCH_PLAN work item is QUEUED and
                                   eligible…"
19:34:08  DISPATCH_SENT           session_01GhrLF2VzoypGuumHLDbPuj   → same
19:37:18  DISPATCH_SENT           session_011DwjCy52x8jhFENEBCdaGD   → same
```

And the packet, after all three:

```
WORK ITEMS (1)
  RESEARCH_PLAN QUEUED               1
      RESEARCH_PLAN wki_5e9cce901e714a80a548 QUEUED attempt 0/3
```

`attempt 0/3`. Three workers were started, each held the bin, each was told the
bin had no items and no open work, and the one thing they were dispatched to do
was never claimed once.

**The cause.** `brain_claim_work` and `brain_bin_next_item` both confine a
worker holding a bin, and both wrote the confinement as `bin_id = <the bin>`.
Nothing sets `bin_id` on a research work item, and nothing should:
`startPacket` enqueues the planning job *before* the bin exists, and
`advancePacket` — Step 9's runner, correctly ignorant of Step 10 — creates every
later fragment, verification, synthesis and audit item with no bin at all. So
the filter matched nothing, twice, and the "is this bin drained" read agreed
with the claim because it was the same wrong predicate written out a second
time.

**The correction is to say what the bin actually scopes.** `binScopeSql` is one
exported predicate used by both the claim and the read:

```sql
-- a bin naming an orchestration
(bin_id = ? OR (bin_id IS NULL AND orchestration_id = ?))
-- a bin naming none
bin_id = ?
```

A bin naming a packet is a lease on that packet, so its worker may take the
packet's work. Nothing widens: an item tagged with another bin is another
worker's, an untagged item outside this packet is out of bounds, and the
project's wider queue stays unreachable — which is the property the confinement
exists for. It is the same lesson as `DISPATCHABLE_SQL` one section up, and the
same shape of mistake: **a predicate written out twice will eventually disagree
with itself, and here both copies disagreed with reality at once.**

Five tests cover it. Two fail when the fix is inverted — the item is not handed
over, and `binHasOpenWork` reads `false` on a packet with queued work, which is
the half that made three workers conclude the bin was finished. The other three
are the inversion in the opposite direction, and they pass either way on
purpose: a worker in a bin still cannot reach another packet, loose project
work, or anything a bin that names no packet was not tagged with. The
confinement was never too wide. It was too narrow to be usable.

**Two smaller things the same bin exposed:**

- `brain_bin_next_item` handed over a work item without the work type's own
  description, while `brain_claim_work` had always included it. That was
  harmless while a bin's items were deterministic units and is not harmless for
  `RESEARCH_PLAN` / `RESEARCH_FRAGMENT` / `RESEARCH_VERIFY` /
  `RESEARCH_SYNTHESIZE` / `RESEARCH_AUDIT`, where a worker that has to guess
  which tool a type calls for learns by being refused — at the cost of an
  allowance, to find out something the registry already knew. `describeClaimed`
  moved to `mcp/toolkit.ts` so both tools use one answer.
- The bin's assignment budget recorded three failures of Brain as three failures
  of the packet. `regrantBinAttempts` raises a live bin's ceiling with a reason
  and an audit row; it never resets the count, never lowers a ceiling, and
  cannot touch a terminal bin.

## The fourth defect the real packet found — a true sentence in the wrong packet

**Every worker was told a person had to approve the plan, so the packet that
did not need one never submitted its plan for checking.**

With the confinement fixed, the next activation did exactly what it should. At
20:28:21 `BIN_ITEM_CLAIMED` — the first time a research bin ever handed its
worker a queue item — and by 20:30 all four fragments were written, scoped,
lane-tagged and stored. Then:

```
20:30:33  BIN_CHECKPOINT
20:30:37  BIN_RELEASED   "Proposed and submitted the 4 research fragments for
                          orc_9b2965e776bb4de7ab9f …"
```

and the packet report, sixteen minutes later:

```
status      PLANNING   pass PLAN
approval    STEP10_MICHIGAN_LICENSING_V1 — authorized by operator:step-10-acceptance
FRAGMENTS (4)   licence-trigger / real-property-condition /
                exemption-inclusion / consequences — all PLANNED
WORK ITEMS (1)  RESEARCH_PLAN wki_5e9cce901e714a80a548 LEASED attempt 2/3
```

The plan existed and was never evaluated, because the worker **released the bin
without completing the work item** — and completing the item is what calls
`advancePacket`, which is the only place the envelope is applied.

**It was doing what it was told.** `brain_propose_fragments` returned
`status: 'AWAITING_APPROVAL'` regardless of the packet's approval mode, and its
own description read *"Proposals only — nothing is researched until a person
approves."* Both are true of most packets and false of this one. An earlier
release reason, from the activation before, says it in the worker's own words:
*"Still blocked on human plan approval for orc_9b2965e776bb4de7ab9f."*

**The correction is to make the sentence true rather than to remove it.** Brain
knows which mode a packet is in — it is a column Brain owns — so the tool
reports it: `AWAITING_SYSTEM_APPROVAL` when an envelope is named,
`AWAITING_HUMAN_APPROVAL` otherwise, each with the next step. In **both** modes
that step is *complete this work item*, which was always right: a
human-approved packet also needs its plan item finished before the bin can park
at `NEEDS_HUMAN`. Leaving it leased was never correct in either mode, which is
the sign the fix is at the right level.

Nothing about the gate moved. The envelope is still the only thing that may
approve without a person, still a pure function over rows, still applied after
the item completes, and the packet still stops at `NEEDS_HUMAN` on any
deviation.

Two tests cover it and one fails when it is inverted — with the envelope forced
out of the answer, the tool says `AWAITING_HUMAN_APPROVAL` to a packet nobody
needs to approve. The second test is the inversion in the other direction: an
ordinary packet must still be told a person decides.

**This is the general shape of both real-packet defects, and it is worth naming
once.** Six clean ramp rungs and 71 bin tests said nothing about either, because
every synthetic bin carries its work inside its own manifest and needs no
approval at all. A research bin is the only thing that exercises the queue
confinement or the approval mode, so the first real packet was the first test of
either. The ramp measured dispatch, correctly, and proved nothing about the
thing dispatch exists to start.

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
| 30 | 2405.7s | **0/30** | — | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 30 `READY` | **RATE_LIMIT×30** |
| 50 | *not run* — see below | | | | | | | | | | | | | |

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

### The ceiling, and what Brain did when it arrived

Rung 30 is the answer to "how many workers". Not one of its thirty activations
was sent: every dispatch attempt returned `RATE_LIMIT`. The rung ran its full
40-minute deadline and completed nothing.

**The ceiling is not what I first said it was.** I reported the account's
five-hour subscription allowance as exhausted. The provider's own message,
stored on the dispatch row and read back afterwards, says otherwise:

```
RATE_LIMIT 429 {"error":{"message":"This routine's fire rate limit has been
reached. Try again in 52m35s.","type":"rate_limit_error"}}
```

**It is a per-routine fire rate limit, on the order of an hour**, not a
subscription ceiling. That changes the remedy completely. More capacity does not
mean a larger plan or paid overages — it means **more routines**, each with its
own fire budget, which is a configuration the operator makes on the provider and
Brain then dispatches across. It also explains the recovery below, which happened
about ninety minutes later rather than at any subscription boundary.

Recorded as a correction rather than quietly amended, because the wrong version
would have sent somebody to buy capacity they already had.

**What matters is the shape of the failure.** All thirty bins were still
`READY`, each holding its intent, none failed, none stranded, none corrupted,
and no paid overage was enabled. `reconcileBins` then examined all thirty-one
open bins and called **thirty of them healthy** — waiting for an allowance is
not a fault — escalating exactly one, the bin the correction defect had killed
earlier, to `NEEDS_HUMAN`. That is §16 working: *the run pauses, keeps every
queued item, and resumes when the allowance comes back. It is never a reason to
lower the evidence bar.*

Rung 50 was not run. With zero activations available it could only have produced
`RATE_LIMIT×50` after another forty minutes — the same finding at a higher
number, bought with more of the user's allowance. The ceiling was located at 20
and confirmed at 30; a third measurement of the same wall is not evidence.

### Unattended recovery from the ceiling — PROVEN

The thirty bins rung 30 could not start were left `READY`, each holding its
dispatch intent. Nobody touched them. When the routine's fire budget refilled,
Brain re-fired on its own and **drained all thirty**, and the operator returned
to a project with no `READY` bins at all — 76 bins, 75 `COMPLETE`, and the one
deliberately broken bin still correctly escalated.

The evidence is in the totals: `DISPATCH_RETRY 35` and `PROVIDER_ALLOWANCE 34`
alongside `BIN_COMPLETION_ACCEPTED 75`. The backoff recorded every refusal,
waited, and then spent the budget it was owed.

This is §16's promise met without anyone present: *the run pauses, keeps every
queued item, and resumes when the allowance comes back.* It was not staged — the
ramp ran out of budget for real, and the recovery is what happened next.

The operator's cancel command, aimed at those thirty bins afterwards, refused:

```
STEP10 CANCEL REFUSED: expected 30 READY bins, found 0. Nothing was changed.
```

which is the interlock doing exactly the job it was built for — a rung that
drained while the operator was deciding stops the command rather than being
swept into it.


### The operating standards this produced

There are **two different ceilings** and conflating them would give bad advice.

**Recommended ceiling — 10 activations per routine per hour.** Rungs 1 through
10 sent every activation with nothing refused. Rung 20 sent 13 of 20 before the
provider stopped it. Ten is the highest figure observed entirely clean and 13 is
the observed edge, so **10 is the recommendation** — close enough to the wall to
be useful, far enough from it that an ordinary burst does not spend the hour.

**Fire-rate ceiling — about 13 fires per routine per hour.** This is the real
constraint and it belongs to the *routine*, not the account: the provider
refused with "This routine's fire rate limit has been reached. Try again in
52m35s." Rungs 1–10 fit inside it; rung 20 spent the rest of it; rung 30 arrived
with none left.

The consequence for capacity planning is the opposite of what a subscription
ceiling would imply. **A second worker routine doubles the fire budget**, and
costs nothing but configuration. A fleet that needs to sustain more than roughly
13 activations an hour needs more routines to fire at, and Brain already treats
the routine as a configured target rather than a hard-coded one.

**`DISPATCH_BURST = 5` per ten-second tick is too aggressive for this provider.**
It offers 30 activations a minute against a wall around 13 in flight. It was a
deliberate starting point — the code says so — and the ramp is what it was
waiting for. Lowering it is Step 11's capacity-aware routing, not a Step 10
patch, but the number it should start from is now measured rather than guessed.

**Ordinary bin size — considerably larger than three trivial units.** The
acceptance bins drained in 21–32 s median while queue wait ran 22–41 s, so more
than half of each bin's wall-clock was activation overhead. That is fine for a
dispatch test and wrong as a standard. A bin should carry enough work that
starting a worker is a rounding error: **aim for five to ten minutes of drain**,
which for research means roughly one fragment or a small dependent group, not a
single claim.

**Activations are not bins, and this is the most useful thing the ramp found.**
Rung 20 completed twenty bins from thirteen activations — 1.54 bins each —
because a worker that finishes one bin asks for another. A throttled fleet
therefore loses *throughput*, not *work*. Sizing a fleet one-worker-per-bin
over-provisions it.


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

