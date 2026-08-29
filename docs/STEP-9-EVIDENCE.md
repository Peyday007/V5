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

| The runner never creates a second item for work that already has one | see below — this is the fault that mattered most |
| A plan job that produced no fragments stops rather than re-planning | not retried with a fresh key |

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

## Faults found before the packet ran

Seven, and they are recorded rather than quietly fixed because most of them are
the kind that would have been found by a live run going wrong instead.

**1. The runner could create a second work item for one fragment.** The guard
that asked "is there already work for this?" only looked at QUEUED and LEASED
items. So a worker that completed a `RESEARCH_FRAGMENT` without ever calling
`brain_submit_claims` left a fragment still QUEUED with no live item, and the
next advance enqueued another one.

The loop is the lesser problem. **A second work item has a different id, and
Step 6 keys a research effect from the work item.** Two items for one fragment
are two idempotency scopes, and the second could have recorded a second claim
ledger for the same fragment — the exact duplication the whole mechanism exists
to prevent, reintroduced in the layer above it. The rule is now one item per
(type, target) for the life of the packet, and an item that finished without
moving the state it should have moved is a fault a person sees rather than
something to retry with a fresh key.

**2. The tests asserted the reported count rather than the stored flag.** Found
by inverting the gate; described above.

**3. `RESEARCH_AUDIT` silently dropped unknown payload fields**, following the
registry's normal behaviour, which is right for an echo. An audit item is the
one place a prompt gets near a model, and a caller who put `instructions` in the
payload would have believed they had steered the auditor. It refuses now.

**4. The hosted harness failed on its own history.** One check enqueued at the
default priority instead of through the seed helper, which is the *same* bug
that helper's comment already describes and that cost a red deploy once before —
fixed in one place and missed in another. Both times it looked like flakiness,
because the first pass drains the queue and the second then reaches the item.
The workaround is priority 9; the repair is cancelling the scope's leftovers at
the start of a run, so no check in that file depends on the queue's history.

**5. A worker's proposal became research without anybody reading the archive.**
The in-process orchestrator has always reconciled a goal against what the
project already holds and created fragments only for the gaps. `brain_propose_fragments`
went straight to `createFragments`, so the *newer* path — the one a real worker
uses — could spend the allowance re-establishing a fact already in the project.
§13 held on one of two paths and nothing said so.

It is now the same decider on both, put behind `services/research/coverageGate.ts`
so there is no second implementation to disagree with the first. Two details
were only visible once it was wired up: without a boundary contract the
staleness and geography checks abstain, and SATISFIED is the one status that
*stops* research — so an old well-sourced claim could have suppressed a
fragment that should have run. The contract is now assembled from the scope the
proposed fragments themselves declare, and only from what they agree on. And a
packet whose fragments are *all* answered by the archive would have fallen
through to "no fragment cleared its evidence gate", which is the same terminal
state describing the opposite outcome; it now ends saying what actually
happened.

**6. `brain_submit_audit` could never have accepted an adversarial pass.** The
tool advertised `material: boolean` on an attack; `parseAdversarialPass` has
always required `assessment` as an exact enum. A worker following the published
schema was refused every time, and the refusal named a field the schema never
mentioned. The adversarial pass is the middle of three and the judge refuses to
run without it, so **no worker-driven packet could ever have reached a
verdict** — the exact thing the next live run was going to attempt.

It survived because nothing had ever driven that path: the tool tests stopped
at the filed report, and the in-process pipeline builds its own JSON rather
than going through the tool schema. The schema now declares what the validator
reads; the validator is untouched, because it is the authority. The gap
schema's two conditional requirements — OTHER_LAYER needs an owning layer,
TARGETED_RESEARCH_GAP needs a question — were invisible for the same reason and
are written down now.

**7. The test harness leaked a data root per file.** `process.on('exit')` does
not fire when vitest signals a worker, so every interrupted run left one
temporary root per test file behind: 4,762 of them, 26 GB. What that produces
is a hundred unrelated tests failing on "No space left on device", and it had
already killed one full Postgres run halfway through — which is exactly the
shape of failure that gets misread as flakiness and re-run rather than
diagnosed.

## Verified on both backends

The suite has now completed against Postgres as well as SQLite, which is the
only thing that makes "one repository layer over two databases" a fact rather
than something that compiles:

| Backend | Files | Result |
|---|---|---|
| SQLite | 40 | 911 passed, 25 skipped |
| Postgres 16 | 40 | **936 passed, 0 skipped, 0 failed** |

The twenty-five SQLite skips are the tests that only mean something against a
real Postgres, so the second column is the same suite with more of it running,
not a different one. Both boot paths were checked afterwards: 21 migrations
applied from an empty database, and `up to date (21 already applied)` on a
restart against it.

## What the test packet found in its first hour

The fixture was built so the pipeline could be judged before an allowance was
spent on it. It earned that immediately: three defects, all of which would
otherwise have surfaced during a run somebody was paying for, and two of which
had nothing to do with fixtures at all.

**1. Success and no-op read identically.** Approving a fixture reported
"Approved, but nothing was queued" — true, because a fixture queues nothing
*since the work is already done* — and a plan with nothing awaiting approval
reported the same sentence. An operator pressed the button, got that message,
and had no way to tell which had happened. It now says what it did: fragments
cleared, fragments blocked, claims accepted and refused, and what it filed as.

**2. Every packet the Brain has ever filed had broken markdown.** The ledger
builder stripped every empty string in the document to drop two optional
fields, and took the deliberate blank lines with them — so `## Evidence ledger`
sat against the rule above it and rendered as part of it rather than as a
heading. Invisible to the code and wrong to a reader, which is why it survived
until somebody read a filed document. Not a fixture bug; a bug in `filing.ts`
that fixtures made visible.

**3. A second packet on one layer could not file.** `FOUNDATION` targets the
layer's foundation version by definition, and every packet was created as a
FOUNDATION — so the second one targeted `v1` again and the importer correctly
declined it as a duplicate canonical name. Correct refusal, baffling message,
and the operator did nothing wrong. It would have hit real packets identically.
Found by running a second test packet, which is exactly what somebody does
after reading the first one.

The general point is worth keeping: **the first packet through a pipeline is
both the thing being tested and, if it is real, the thing being paid for.** A
fixture separates those.

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

## What has now been watched happen, live

A test packet ran against the deployed Brain — production Postgres, Supabase
storage — and did this:

```
Test packet — protocol notes — TEST PACKET
orc_569f8cc5ffec42668927 · NEEDS_HUMAN · 2 accepted, 1 blocked
Filed. The audit is the one part a fixture cannot stand in for …
```

Which is the whole Brain-side pipeline: a plan a person approved, claims stored
unaccepted, the gate applying all seven conditions and refusing one fragment
outright, a synthesis assembled only from what survived, citations resolved
against accepted claims, and a document filed under the Brain's own canonical
name. Nothing was spent.

The fragment that failed is the one worth noting. Its source is real, the quote
is accurate, and the claim it supports is true — about the **2025-11-25** MCP
revision, when the fragment asked about **2026-07-28**. A correct fact,
correctly cited, answering a different question, refused by the fourth gate
condition. That is the failure mode the scope fields exist for, and it is now
observed rather than asserted.

### And now on every deploy, over the protocol

The fixture above ran *inside* the Brain. `scripts/verify-hosted.ts` now runs a
packet through the deployed endpoint instead — ten tool calls over TLS, through
Fly's edge, against Supabase Postgres and the bucket, with a worker bearer:

```
A research packet, end to end, over the deployed endpoint
  PASS  starting a packet queues one planning job and researches nothing
  PASS  and reads the archive before creating anything — 5 claim(s) across 5 readable document(s)
  PASS  a worker claims the planning job over MCP
  PASS  and is handed the assignment, and no prompt
  PASS  proposes fragments, and the coverage check runs against the live archive
  PASS  and records a coverage decision for every fragment it proposed
  PASS  and leaves them PLANNED, so nothing researches an unapproved plan
  PASS  with no research queued behind them
  PASS  approval queues the research
  PASS  a submitted claim is stored unaccepted, whatever the worker said about it
  PASS  the gate accepts the sourced claim and refuses the unsupported one
  PASS  and keeps the refusal reason on the claim it rejected
  PASS  a report citing a refused claim is refused, over the wire
  PASS  and a report citing only accepted claims is filed as a document
  PASS  whose bytes come back out of the configured document store — 698 bytes
  PASS  the PRIMARY audit pass records findings and moves nothing
  PASS  the ADVERSARIAL audit pass records findings and moves nothing
  PASS  and only the judge records a verdict — MORE_RESEARCH
  PASS  all three audit roles ran, strictly in order — 3/3
  PASS  and the verdict is stored as a structured record, not as prose
  PASS  and a worker still cannot write into an item it does not hold
```

145/145, twice, either side of a real restart. It spends nothing: every claim
is supplied by the script, so what is under test is the gate rather than a
provider.

**It took four deploys, and three of the four failures were in the check rather
than in the Brain.** That is worth recording, because each one was a way a
verification script can be confidently wrong:

1. The check read `document.filesystemPath` to find the filed bytes. That
   column is the key in local mode and null in cloud mode, so it passed against
   a folder and failed against a bucket — §1 exactly, and the reason
   `storageKeyOf` exists.
2. With the key right, the read still failed: the harness had never called
   `initStorage`, and `getStorage()` falls back to a local provider when nothing
   has booted. So it asked the container's disk for a bucket key and reported
   the live Brain as having filed a document with no bytes behind it. A false
   alarm on the one invariant that says a row without bytes is not a document.
3. Then `EMAXCONNSESSION` on the last query of the second pass. The harness runs
   beside the server and shares its pooler, which allows fifteen clients; two
   default pools of ten is sixteen. The research phase does an order of
   magnitude more database work than anything before it, so it was the first
   thing ever to grow that pool to its limit.

The fourth was real, and is the one that mattered: `brain_submit_audit`
advertised an adversarial schema its own validator rejected. Recorded above.

## What nobody has watched happen

**A worker doing the research.** Everything above was driven by fixture content
through the same acceptance path; nothing has yet come in over `/mcp` from a
real Claude and been gated. Until that has happened, Step 9's own question —
*can a real Claude Max worker carry a packet from intent to an audited
document* — is answered only for the Brain's half.

**The audit, in any form.** Three roles, three work items, a judge whose
structured output reaches `recordAudit`. The recording half is the same code
`runDynamicAudit` uses and the existing audit suite covers it; the *sequencing*
of three work items into it has never run.

**A packet that needed repairing.** `repair.ts` and `replan.ts` remain wired
only to the push path.

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
