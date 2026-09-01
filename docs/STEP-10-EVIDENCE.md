# Step 10 — Event-driven bin dispatch: what was proven

Step 10 asked one question:

> **Can Brain turn "there is ready work" into "a Claude session is running that
> work" with no person in the loop and no model idling anywhere?**

This file separates three things that are easy to blur: what a live run
demonstrated, what only passes its tests, and what nobody has watched happen.

The design is in [`STEP-10-PLAN.md`](STEP-10-PLAN.md). The frozen Step 9
baseline this step must not disturb is recorded there and re-read at the end of
this file.

> **Status: incomplete.** The dispatcher half is proven live. The activation
> half is blocked on a provider-surface setting, recorded in full below, and the
> concurrency ramp has not run. Nothing here claims otherwise.

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

`tests/bins.test.ts` — **44 tests, all passing**, on SQLite and on Postgres —
across atomic assignment, the fence, dead-worker takeover, bin confinement,
Brain-decides-completion, dispatch intent, one-activation-drains, the governing
invariant, telemetry, and the permanent instructions.

Two of them exist because inverting the code did **not** break them at first:
the assignment CAS's generation guard and the ownership clause's generation
term were both being carried by neighbouring predicates — the state-and-expiry
check, and freshly minted lease ids. The tests were tightened until removing the
generation term alone fails. Recorded rather than quietly fixed, because a test
that passes for the wrong reason is worse than a missing one.

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

### Unattended activation — blocked at the provider surface

**Brain fires correctly. The fired session then stops and waits for a human.**

Session `cse_019ryoNbatf9g5stX4QczdNE`, fired by Brain at 2026-09-01T05:39:00Z:

```
session_status : SESSION_STATUS_REQUIRES_ACTION
status_bucket  : SESSION_STATUS_BUCKET_BLOCKED
pending_action : mcp__cloud-brain__brain_check_in
permission_mode: PERMISSION_MODE_AUTO
```

It is waiting for someone to approve its first tool call. Nobody is there.

The observable difference between a routine whose sessions work and this one:

| | Brain worker (`trig_017iVU…`) | a routine that works (`trig_01HCVV…`) |
|---|---|---|
| `created_via` | `meta_mcp` | `http_api` |
| `session_context.allowed_tools` | 20 entries — `preset:default`, `Task`, `Bash`, … — **no `mcp__*` entry** | absent entirely |
| `set_permission_mode` control event | absent | present, `mode: auto` |

The routine carries an explicit tool allowlist naming no connector tool. Auto
permission mode does not rescue a tool that is not on the list, which is why it
prompts while reporting `auto`. Attaching the connector was necessary and not
sufficient: the connection and the tool grant are separate settings.

This is **CF-11 made concrete** — *the surface decides whether a worker can
authorize at all* — and it is not fixable from inside Brain. `update_trigger`
exposes only name, cron, enabled, model and prompt; `create_trigger`'s
`connectors` parameter is refused for this organisation. The remedy is one
operator action in the provider's own UI.

Brain **could** provision its own routines through the routines API with the
token it already holds. That is deliberately not built: it would mean Brain
minting workers and choosing their permissions, which is an expansion of what a
machine here may do and not something to take without being asked. It is also
unnecessary — §22's shape already says the operator authorizes and the worker is
authorized. Step 10 requires *activation* to be unattended, not *provisioning*.

### The concurrency ramp — not run

1 → 2 → 5 → 10 → 20 → 30 → 50 has not been executed, because a rung measures
how many activations drain in parallel and no activation currently drains at
all. `scripts/step10.ts ramp` is written and deployed, seeds a rung, watches it
settle from inside the machine, and reports queue wait, drain time and
ready-to-done with medians. It never fires, assigns or nudges — the dispatcher
is what is under test, so the harness's only actions are create and read.

### Production proofs still outstanding

- one bounded **real research bin** through the full lifecycle
- worker death and takeover **in production** (proven in tests, not live)
- duplicate-trigger behaviour **in production**
- restart and redeploy persistence **in production** (`DISPATCH_BOOT_RECOVERY`
  rows exist, but no deliberate mid-flight restart has been performed)
- operating standards derived from measurement — Step 11's starting numbers
  cannot be invented, and there is nothing yet to derive them from

---

## Two findings about measurement itself

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

### The permanent prompt is duplicated in the routine

`WORKER_INSTRUCTIONS_VERSION` lives in Brain, but the routine holds a **copy**
made when it was created. Brain reports the version it believes in and cannot
see the routine's, so prompt drift is currently undetectable and unfixable from
Brain. Carried forward.

---

## The frozen baseline

Step 9's closure evidence must be byte-identical to
[`STEP-10-PLAN.md`](STEP-10-PLAN.md)'s record. Re-read at the end of this step
and reported there.

