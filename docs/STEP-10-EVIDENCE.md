# Step 10 — Event-driven bin dispatch: what was proven

Step 10 asked one question:

> **Can Brain turn "there is ready work" into "a Claude session is running that
> work" with no person in the loop and no model idling anywhere?**

This file separates three things that are easy to blur: what a live run
demonstrated, what only passes its tests, and what nobody has watched happen.

The design is in [`STEP-10-PLAN.md`](STEP-10-PLAN.md). The frozen Step 9
baseline this step must not disturb is recorded there and re-read at the end of
this file.

> **Status: Brain's half is proven; the step is not closed.** Brain fires, an
> unattended worker acts, Brain validates the result, the ramp has run to a
> measured ceiling, and on a real research packet Brain planned, approved
> against a preauthorized envelope, queued research and refused evidence it
> could not ground — all with nobody involved. What is missing is a filed,
> audited document, and the reason is not Brain: the worker surface has no
> network egress to the primary sources. That is the operator's half of the
> same split, and Step 10 stays open until it is met.

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

## What the two defects cost, in the currency this step found is scarce

A bin's attempt budget is its assignment count, and that accounting is right —
a worker that died still cost the bin a go. It assumes the attempts were spent
*on the work*. Both real-packet defects spent them on Brain instead:

```
19:31 → 19:39   5 attempts   the confinement defect — assigned, nothing to claim, released
20:22 → 20:28   7 attempts   the approval-status defect — plan filed, told to wait for a person
                             12 / 12 — spent, and the bin stopped being dispatched at all
```

That last line is the folded predicate doing its job. `DISPATCHABLE_SQL` now
carries `attempt_count < max_attempts`, so a bin the assigner would refuse earns
no activation, and the fleet went quiet rather than spending fires on a bin
nobody could be given. It also produced an hour of a live packet sitting
perfectly still, which looked from outside exactly like a dispatcher that had
stopped — and working out which it was meant counting `BIN_ASSIGNED` events by
hand, because `trace` printed the lease, the renewals and the refusals and not
the one number that decides whether a bin will ever be handed out again. It
prints it now.

`regrantBinAttempts` is the operator's answer, and both uses of it are recorded
as bin events with their reason. It raises a ceiling and never resets a count,
so the twelve spent attempts stay in the history where they belong: the packet
did not fail twelve times, the platform did, and the row says so.

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

## The real research packet — filed, audited, and short by one question

This is the acceptance item Step 10 was told not to close without, and the
first version of this section said it did not pass. That was true when it was
written and is not true now, so the correction is recorded here rather than
quietly replacing what it corrects: **the block was the worker's network reach,
the operator changed it, and the same packet then ran through to a filed,
audited report.** No packet was recreated, no counter was reset, no evidence
requirement moved, and every blocked attempt is still in the table.

### First: prove the surface changed, and say *which of four things* it did

The old section had one word for the failure — "blocked" — and that word is four
different facts wearing one label:

| | what it means | what to do about it |
|---|---|---|
| `HOST_NOT_ALLOWED` | the worker's own environment refused the host outright | the surface is still closed; attempt nothing downstream |
| `ORIGIN_REJECTED` | the host answered and refused this client | the surface is open; use another authorized publisher |
| `ROBOTS_RESTRICTED` | the host's robots policy excludes automated retrieval | the surface is open; use another authorized publisher |
| `OTHER_FAILURE` | DNS, TLS, a timeout, a 5xx | the surface is open; this publisher is not serving |
| `RETRIEVED` | the document came back | research may proceed against that host |

So `SURFACE_PROBE_V1` exists: a bin whose units are hosts and whose contract
requires one reading per host from the closed vocabulary above. **Brain does not
judge whether the probe succeeded** — a Brain that decided from a worker's prose
whether a network was open would be reading model output as state. It requires
only that a reading exists for every declared host, and the readings are then
evidence a later guard can check.

Fired at the same routine, against the same environment the research runs in:

| host | why it is authorized | reading |
|---|---|---|
| `legislature.mi.gov` | Michigan Occupational Code (MCL) full text | `OTHER_FAILURE` — HTTP **503**, tunnel established |
| `ars.apps.lara.state.mi.us` | Michigan Administrative Code / R rules | `RETRIEVED` — 200 |
| `www.michigan.gov/lara` | published LARA guidance | `RETRIEVED` — 200 |

That is the whole answer, and it is two answers rather than one. The
environment is open — two Michigan government hosts answered from inside a
fired Routine session, which is exactly what `HOST_NOT_ALLOWED` would have
made impossible. And the one publisher that carries MCL full text returns 503
to automation, which is a fact about that publisher rather than about the
worker.

### Then: recover the same packet, through the narrowest thing that could work

Nothing in Brain could requeue a fragment blocked by an execution-surface
failure. `retryFragment` refuses at `attempt > maxRepairs`, correctly — §15 says
the honest outcome after a spent budget is "unresolved", not another attempt at
the same question. But that rule is about *research* running out of ideas, and
this fragment never got to have an idea: it was refused a network.

`services/research/surfaceRecovery.ts` is the whole of the new mechanism, and
what makes it safe is what it refuses:

- the packet must not be terminal, so a completed one can never be reopened;
- the fragment must be `BLOCKED`;
- its **recorded** reason must name a surface condition. Ordinary research
  insufficiency is refused *by name* — "did not support the claims", "no
  accepted evidence", "insufficient" — so this cannot become a way to re-run
  research until it passes;
- a `SURFACE_PROBE_V1` bin must be `COMPLETE` and carry a `RETRIEVED` reading
  recorded **after** the fragment was blocked. A probe from before the block
  proves nothing about the change;
- the attempt counter is never reset. The **ceiling** is raised, to
  `attempt + grant`, so the history reads `3/4` rather than `1/2` — the two
  failed attempts remain in the table with their `EGRESS_BLOCKED` reasons;
- the new attempt is delegated to `retryFragment`, so it inherits every
  declaration, requirement and evidence bar verbatim;
- only the affected fragment is requeued. Dependents are restored only when
  *every* dependency of theirs is live again — an early version restored a
  dependent while a `HARD` dependency was still blocked, and its own test
  caught it;
- and it records `RESEARCH_SURFACE_RECOVERY` on the append-only event log.

Fifteen tests, most of them attempts to get a recovery that should be refused,
on both backends.

The bin's attempt budget had been spent by the pre-fix failures — 13 of its 25
attempts were the egress condition — so the existing guarded regrant was used
and its reason recorded. The regrant's reason had been a hardcoded string
naming a Brain-side confinement defect, which was true of an earlier bin and
false of this one; it is now a closed set of reason codes, because a budget
restored "because of a defect" that was really "because the network was shut"
is a false row in the only record of why.

### What Brain then did, with nobody involved

```
licence-trigger   attempt 3/4   ACCEPTED   integrity PASS   sufficiency SUFFICIENT
real-property-condition  1/2    ACCEPTED   PASS   SUFFICIENT
exemption-inclusion      1/2    ACCEPTED   PASS   SUFFICIENT
consequences             1/2    ACCEPTED   PASS   SUFFICIENT

claims      10 stored, 8 accepted
work items  16 — 1 PLAN, 6 FRAGMENT (5 SUCCEEDED, 1 FAILED: the superseded
            attempt's stale item, third defect below), 5 VERIFY, 1 SYNTHESIZE,
            3 AUDIT; claimable 0
audit       aud_0edfb365289248aea8e1
  role ordinal 5 (PRIMARY)      COMPLETE  2026-09-01T23:59:05.930Z
  role ordinal 6 (ADVERSARIAL)  COMPLETE  2026-09-02T00:02:04.804Z
  role ordinal 7 (JUDGE)        COMPLETE  2026-09-02T00:03:45.541Z
document    Monetization Logic v1C — doc_397f2b87142743b4bb2e
            20,455 bytes in the bucket, read back; extraction READY, 20,171 chars
```

Every declared evidence lane is tagged, no claim is untagged, and the four
mandatory requirements each have an accepted fragment behind them. Two claims
of the ten were rejected at the gate and stay rejected with their reasons —
acceptance is decided once, at the gate, and nothing re-enters through a later
synthesis.

### Two defects the *end* of the packet found

Both were invisible until a packet got this far, which is the argument for
running a real one.

**The verdict's meaning was derived once and never again.** `outcomeFor` is a
pure function of the verdict, whether any fragment is still repairable, and
whether a person has authorized this packet to record unresolved gaps — and the
last of those is, by design, given *afterwards*, by a named administrator, to a
packet that stopped in order to ask for it. It was evaluated only inside
`brain_submit_audit`. So the packet sat at `NEEDS_HUMAN` saying it needed an
authorization, and granting the authorization would have done nothing at all:
nothing re-read it, and no other branch of the runner can move a packet whose
fragments are all accepted and whose three audit roles are all in. **A state
that says "waiting for a person" and cannot be resolved by that person is not
waiting; it is stuck** — the same failure the empty-queue guard exists to
prevent one level down. The advance now re-derives it from current rows.

**`RESEARCH_PACKET_V1` accepted only `COMPLETE`.** `COMPLETE_WITH_GAPS` is a
terminal state of the same runner, over a packet that filed a real report and
was audited by all three roles. Refusing it is precisely the failure this step's
own plan named in advance — *"a bin that drains but cannot terminalize because a
contract is stricter than the work path can satisfy"* — and an unattended fleet
would have bounced a worker off that bin on every activation, forever, for a
packet that was already over. Every other clause of the contract is unchanged
and still applies: the document must exist, have bytes, be judged by an audit,
and leave no work item open. `FAILED`, `CANCELLED` and `NEEDS_HUMAN` still
complete nothing.

A third, smaller one, and this packet paid for it directly: `retryFragment`
superseded the failed attempt's *row* correctly and left its *work item*
queued, so a worker was dispatched at an attempt that no longer existed and
failed — one activation out of a routine's hourly fire budget, which this step
measured as the scarce resource. The superseded item is now cancelled, which
also advances its lease generation, so a late completion from the old owner
matches nothing.

### Where it stopped, and why that is the honest end

The judge returned **`MORE_RESEARCH`** with seven gaps: one
`TARGETED_RESEARCH_GAP` (MCL 339.601's section title includes "Injunctive
Relief", and only its misdemeanour clauses were quoted and verified), two
`PATCH` findings about overstated certainty, and four `NO_GAP` observations.
With every fragment accepted there was nothing repairable, so the packet had
exactly two readings available to it, and which one applied turned on an
authorization no machine may grant itself. The operator granted it, and the
packet is **`COMPLETE_WITH_GAPS`**: filed, audited, terminal, and honestly
short of one question — with the question itself on the record rather than
rounded away.

It is not `COMPLETE`, and saying so is the point. `COMPLETE` means the judge
advanced it, and this judge did not.

### The source that would not be served

The judge's third gap is worth repeating in full, because it is the one finding
here that is about the world rather than about Brain: *all statutory text was
sourced to third-party mirrors after `legislature.mi.gov` failed (503) on every
attempt across the entire research trail.*

The probe explains it and does not excuse it. Of the Michigan government
endpoints the assignment authorizes, the two that answer — the Administrative
Rules service and LARA's publications — do not publish MCL full text, and the
one that does refuses automation. So the authorized source *class* was honoured
and the authoritative *publisher* was not reachable, and that gap is recorded
as unresolved rather than papered over. Broadening the class was available and
was not taken.

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

- ~~a **filed, audited document** from the real research bin~~ — **done.** The
  first attempt produced nothing because the worker surface had no egress to
  the primary sources and the gate correctly refused ungrounded claims. The
  operator opened the surface; a probe bin proved it from inside a fired
  session; a guarded recovery gave the one blocked fragment a further attempt
  without resetting its counter; and the same packet filed
  `doc_397f2b87142743b4bb2e` (20,455 bytes, extraction READY) with all three
  audit roles complete. It ended `COMPLETE_WITH_GAPS`, not `COMPLETE`, because
  its judge asked for one more thing and no fragment was repairable.
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

## CF-8, decided rather than deferred

Step 8 raised it and assigned it here: *a one-hour access token versus long
research jobs.* Its requirement, in Step 8's own words, was that refresh tokens
are issued for thirty days and the rotation grant is implemented and tested, so
a client that refreshes never sees a prompt — and that **nothing had exercised
that path live**, so it should be *decided before anything runs unattended*.
Step 9 then decomposed a packet into items each far shorter than an hour and
passed the question forward unchanged; Step 10's own plan lists it as the second
thing a long unattended run could finally observe.

Things have now run unattended, so the deferral is spent and the question is
Step 10's to answer. It is answered from rows, and it needed no new
instrumentation, because Step 8 already recorded the thing that settles it: an
ACCESS token carries `parent_token_id` when it was minted by a **refresh**
rather than by an authorization code. A chained access token that has been
*used* is therefore a client that refreshed and carried on, which is the whole
of the claim. `npm run step10 -- cf8` reads exactly that, and prints no digest,
no prefix, no scope and no secret — a report about credentials must not become a
way to read them.

CF8_READING_PLACEHOLDER

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

