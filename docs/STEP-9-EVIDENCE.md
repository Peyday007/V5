# Step 9 — First manual end-to-end research packet: what was proven

Step 9 asked one question that Steps 1 through 8 could not answer between them:

> **Can a real Claude Max worker, over the deployed gateway, carry one genuinely
> useful research packet from a human's intent to a canonical, audited, citable
> document in the Brain — with every claim gated on the way in?**

This file separates three things that are easy to blur: what a live run actually
demonstrated, what only passes its tests, and what nobody has watched happen.

The design is in [`RESEARCH-PACKETS.md`](RESEARCH-PACKETS.md); the decisions
behind it, including the one that was rejected, are in
[`STEP-9-PLAN.md`](STEP-9-PLAN.md).

---

## The finding that shaped the step

**The Brain had two research architectures and they did not meet.**

The push model implemented everything §12–§16 promises and had never been driven
by a subscription, because a subscription is not an API. The pull model could
hand a worker a job and take back a string. Fourteen tools, and **not one of
them wrote a claim, a source, a contradiction, a checkpoint or a document.**

Seven scopes — `research:read`, `research:write`, `research:propose`,
`claims:write`, `contradictions:write`, `checkpoints:write`, `blockers:report` —
had been declared in Step 4 and gated nothing at all. They were reserved for
the step that would make them real, and this is it.

So the honest description of where Step 8 left things is the one already given
to the operator when they asked where their worker's analysis had gone: **into a
chat log, and nowhere durable.**

## The design that was rejected, and why it matters

A `QueuedWorkerProvider` whose `run(prompt)` enqueues a prompt-carrying work
item and waits would have let `orchestrator.ts`, `pipeline.ts`, `gate.ts`,
`packet.ts`, `repair.ts` and `replan.ts` work **unchanged**. Every invariant
would have held for free.

It is exactly what `services/queue/workTypes.ts` forbids in its own header, and
the reasoning transfers without weakening: an enqueue permission plus a
prompt-carrying type adds up to *make this borrowed Claude account say anything
I want*. Reusing more code is not worth building the one thing §19 says must not
exist.

What was built instead names **what to research** and never what to say. The
cost is that the loop had to be turned inside out; the benefit is that a queue
item still cannot be a command.

## The property that had to hold

**A worker submits; the Brain decides.**

No tool writes an accepted claim. `brain_submit_claims` stores everything with
`accepted = 0` and `applyGate` decides — in `services/research/submission.ts`,
the same function `orchestrator.ts` calls, with no branch in it for "this came
from a worker."

That is why the extraction was worth doing rather than writing a parallel path:
the remote path cannot be looser than the local one because it is not a
different path. The same holds for filing (`filing.ts`) and for recording an
audit (`recordAuditPasses`, extracted from `runDynamicAudit`).

---

## What the tests prove

`tests/packet.test.ts` — 28 tests, both backends.

| | |
|---|---|
| An assignment hands over the fragment's declaration verbatim | the fields `applyGate` reads, not a summary of them |
| An assignment carries no prompt | an assignment is not a script |
| A claim is stored `accepted = 0` whatever the worker thinks | acceptance is the gate's decision, once |
| An unsourced claim is kept, marked `NO_URL` | dropping it would make the ledger look better than the research was |
| A claim its source does not support is never accepted | the worker calling the fragment sufficient does not make it so |
| A claim whose scope does not match is rejected, `SCOPE_MATCH` | condition 4, applied without exception |
| A rejected claim keeps its reason and is absent from `acceptedClaims` | it cannot return through a later attempt's synthesis |
| A verification leaving any claim unanswered is refused | choosing which of your own claims get examined is not a worker's choice |
| A verdict about a claim on another fragment is refused | not ignored |
| A report citing an unaccepted claim is refused **whole** | a packet whose citations are approximately right is worse than none |
| Filing is refused when no claim cleared the gate | the last place an empty packet could still get through |
| A redelivered item records **one** ledger | keyed from the work item, not the contents — a second attempt with better research still replays |
| The runner asks for a plan once, then waits | it checks the queue rather than remembering |
| A `PLANNED` fragment is never queued | §16, at the line where it would be most easily lost |
| Approval queues one job per fragment | and only then does anything cost anything |
| A fragment waits for the fragment it depends on | a boundary fragment settles definitions the others use |
| A restart resumes from rows | resuming and continuing are the same operation |
| No fragment cleared the gate → `NEEDS_HUMAN` | not a retry; repair is planned |
| A blocker records where the worker looked | §14 — a claimed absence needs a documented search |
| Every research write tool refuses a worker missing its scope | with the same body as a resource that is not there |
| A research work type refuses a payload | a caller who put the question there has misunderstood where the subject lives |
| Every research type declares `IDEMPOTENT` **and** names what provides it | a type cannot claim the protection without it |
| An audit item takes a role from a closed set and nothing else | including refusing an extra field |

`tests/workQueue.test.ts` adds six checkpoint tests: a note is written under a
live lease, refused under an expired one, readable by the next claimant with its
author, unforgeable by naming another worker, bounded per attempt, and truncated
rather than allowed to carry a source.

### Every one was verified against its own inversion

The Step 8 lesson — a test that passes with the guard removed is not a test.
Four guards were deliberately broken and the suite rerun:

| Guard removed | Tests that failed |
|---|---|
| `applyGate`'s decision (accept everything) | 3 |
| The approval gate (`PLANNED` fragments start themselves) | 1 |
| The citation check | 1 |
| The verification completeness check | 1 |
| The checkpoint ownership proof | 2 |

**The first inversion found a real weakness in the tests themselves.** With the
gate accepting everything, only one test failed — because the other two asserted
the *reported count* rather than the *stored flag*, and the reported count is
computed inside `applyGate` before the sabotaged line. The reported number and
the stored row are different facts, and the stored one is what the synthesis
reads. The tests now assert both, and three fail instead of one.

## What only passes its tests

- **Nothing here has run against a live Claude.** The suite drives the tool
  functions directly. That proves the gate, the fencing and the idempotency; it
  says nothing about whether a real worker can carry out an assignment well.
  That distinction is the same one Step 3 drew between the research engine
  passing its tests against a scripted provider and a real job having run, and
  the same one Step 7 drew against Step 8.
- **The audit path's three roles have never run in sequence live.** The
  recording half is the same code `runDynamicAudit` uses and is covered by the
  existing audit suite; the *sequencing* of three work items into it is not.
- **No packet has been repaired.** `repair.ts` and `replan.ts` are untouched by
  this step and remain wired only to the push path. A pulled packet that fails
  its gate stops at `NEEDS_HUMAN`, which is honest and is not the same as
  repaired.

## What nobody has watched happen

*(Filled in after the live run. Until then this section is the reason Step 9 is
not closed.)*

---

## Carry-forward register

| Item | Where it stands |
|---|---|
| CF-5 — a real archive migration was never exercised | operator task; not Step 9's |
| CF-6 — more than one instance | Step 11 |
| CF-7 — the real Claude worker is UNVERIFIED | closed in Step 8 |
| CF-8 — a one-hour access token versus long work | Step 10's to resolve. Step 9 decomposes a packet into items each far shorter than an hour, so a token expiring between them costs a refresh and one expiring mid-item costs one lease and one redelivery — which the queue already handles and checkpoints make cheap. **The fix is not a longer-lived token and is certainly not a permanent one.** |
| CF-9 — disabling a live worker reports zero tokens revoked | **open**, and not Step 9's. Reproduce against a Postgres-backed deployment by reading `oauth_tokens` directly |
| CF-10 — a dropped connector does not re-attach to a running session | known client limitation; use a fresh session |
| CF-11 — where a worker runs decides whether it can authorize | Step 11 |
