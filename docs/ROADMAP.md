# Roadmap

The phases, and where the boundaries between them fall. This file exists
because those boundaries are load-bearing: several of them are the difference
between "one machine safely" and "several machines corrupting each other", and
a comment that attributes a guarantee to the wrong step will send somebody
looking for it in code that was never supposed to contain it.

Keep this register accurate. When a step lands, say so here and nowhere else —
the tag in git is the record of *when*, this file is the record of *what*.

## Done

| Step | What it established | Tag |
|---|---|---|
| 1–2 | The Brain itself: state engine and planner, the primary/adversarial/judge audit pipeline, document understanding and OCR, the staged research engine, archive ingestion | — |
| **3** | **Off one computer.** Postgres and Supabase Storage behind one repository layer, `migrate:cloud`, the access gate, the container, the deployment | `step-3-cloud-brain-foundation` |
| **4** | **Who is asking, and may they.** Human sessions, worker identities and credentials, roles, scopes, project membership, execution-time authorization, the identity audit | `step-4-identities-access-control` |
| **5** | **Who owns this work, right now.** Durable queued work, atomic claiming by compare-and-swap, time-bounded leases, fencing generations, heartbeats, expiry and reclaim, bounded retry, cancellation, attempt history | `step-5-distributed-queue-leases` |
| **6** | **A retry is not a second effect.** Idempotency keys, canonical fingerprints, reservation and replay, concurrent duplicate suppression, fenced effect commits, the external adapter contract, uncertain-outcome handling and administrative reconciliation | `step-6-idempotency-safe-effects` |
| **7** | **A door, not a second set of rules.** One authoritative remote MCP endpoint serving both protocol eras statelessly, worker authentication at the boundary, execution-time authorization, a permanent tool surface over existing services, Step 6 idempotency on every mutation, bounded results, safe error categories and an MCP audit | `step-7-authoritative-remote-mcp` |
| **8** | **A worker signs in.** OAuth 2.1 authorization so a Claude connector can authenticate at all, a consent screen where a human approves a named worker, tokens that resolve to the worker rather than the approver, the operator console — including the two things a worker must never do for itself, creating a project and queueing its own work — and the first real Claude Max worker | `step-8-first-claude-max-worker` |

Step 3's evidence is in [`STEP-3-EVIDENCE.md`](STEP-3-EVIDENCE.md); Step 4's is
in [`STEP-4-EVIDENCE.md`](STEP-4-EVIDENCE.md), and the model it built is
described in [`IDENTITY.md`](IDENTITY.md). Step 5's evidence is in
[`STEP-5-EVIDENCE.md`](STEP-5-EVIDENCE.md) and its design in
[`QUEUE.md`](QUEUE.md). Step 6's is in
[`STEP-6-EVIDENCE.md`](STEP-6-EVIDENCE.md) and its design in
[`EFFECTS.md`](EFFECTS.md). Step 7's is in
[`STEP-7-EVIDENCE.md`](STEP-7-EVIDENCE.md) and its design in
[`MCP.md`](MCP.md). Step 8's is in [`STEP-8-EVIDENCE.md`](STEP-8-EVIDENCE.md),
with the runbook and the worker's own contract in [`workers/`](workers/).
Step 9's is in [`STEP-9-EVIDENCE.md`](STEP-9-EVIDENCE.md), its design in
[`RESEARCH-PACKETS.md`](RESEARCH-PACKETS.md), and the faults it cost in
[`STEP-9-LOG.md`](STEP-9-LOG.md). Each evidence file says what was proven, what
merely passes its tests, and what nobody has run.

> **Step 9 is open.** Its mechanical half is proven and is not being re-run: a
> real worker carried a packet from a human's intent to a filed, audited,
> citable document with every claim gated on the way in. Its substantive half
> is not. The requirement is *"one **genuinely useful** research packet"*, and
> the packet that ran answered one of five states and was labelled interim by
> its own judge.
>
> The causes were mechanisms that discarded work the research had already
> done — accepted claims thrown away with the fragment that produced them, a
> flat source floor applied before anyone knew what kind of claim would answer
> the question, no planned repair on the worker path, and dependencies that
> blocked absolutely. They are corrected; what closes the step is a fresh
> packet through the corrected engine, not a re-reading of the old one.
>
> An earlier version of the evidence file said Step 9 "did not ask for the
> research to be good". It did ask, in the sentence that opens its own plan.
> That correction is recorded in `STEP-9-EVIDENCE.md` rather than quietly
> edited away.

## Ahead

Each of these is a separate step on purpose. They are listed in order and the
order is a dependency order, not a preference.

| Step | What it contains |
|---|---|
| **9** | Manual end-to-end research packet — **complete**; one packet terminal, filed and audited ([evidence](STEP-9-EVIDENCE.md)) |
| **10** | Event-driven bin dispatch and unattended activation — see *Where Step 10 actually is* below |
| **11** | Additional workers and fleet controls |
| **12** | The control centre — the Brain drives the fleet, not a person |

### Where Step 10 actually is

**The mechanism exists and it fires.** This section previously said it had not
been designed, prototyped or chosen. That is no longer true and the correction
belongs here rather than in a commit message nobody reads.

`services/dispatch/loop.ts` is a ten-second tick that reads two tables and
sometimes makes one HTTP request. A bin becoming `READY` writes a durable intent
keyed `(bin_id, lease_generation)`; a separate pass turns intents into calls, so
a crash between the two loses nothing. In production it took a bin from ready to
a fired activation in **4.7 seconds** with nobody involved, and it redrives what
a restart interrupted.

**A fired worker acts, and the last blocker was not what I said it was.** On
2026-09-01 an activation Brain started ran 107 seconds and drained seven bins
end to end — including two takeovers from a dead worker's expired lease — with
nobody watching and zero completion refusals.

The block before that was real: fired sessions stopped at a permission prompt on
their first connector tool call. This file, and `CLAUDE.md`, named the routine's
`allowed_tools` as the cause. That was wrong — the working routine's allowlist
has no `mcp__*` entry either. What separates them is the repository: the working
routine checks the branch out, so its worker reads `.claude/settings.json` and
finds `permissions.allow` pre-approving the connector. The documented
project-scope rule was the answer, waiting on a precondition.

So the split still holds, with its terms now known:

- **Brain's half is built and proven live.** Dispatch, the outbox, fencing, bin
  confinement, takeover, and Brain-decided completion.
- **The surface's half is a configuration Brain cannot make** — a checked-out
  repository and a settings file, both the operator's to set.

**CF-8 is answered — see the disposition below.** Its requirement, as Step 8
wrote it, was to *decide it before anything runs unattended*, and Step 10 owns
that decision. It is now decided from rows rather than from confidence:
`npm run step10 -- cf8` reads whether any ACCESS token carries a
`parent_token_id` — meaning it was minted by a refresh rather than by an
authorization code — and whether such a token was then *used*. That pair is the
whole claim, and it needs no new instrumentation because Step 8 already recorded
it.

**The concurrency ramp has run**, and this paragraph used to say it had not.
Six rungs — 1, 2, 5, 10, 20, 30 — measured on an unblocked fleet, with the
harness only creating and reading so that the dispatcher is what is under test.
Rungs 1 through 20 completed every bin: 1/1, 2/2, 5/5, 10/10, 20/20. Across all
of them, **zero duplicate activations, zero fenced stale writes, zero stranded
bins**, and ten of ten at rung 10 despite three completion refusals, because
Brain caught the wrong values and the workers corrected them.

**The ceiling is a per-routine fire limit, not the subscription.** Rung 20 had
four dispatches refused `RATE_LIMIT` and still finished all twenty bins from
thirteen activations — 1.54 bins each, because a worker that finishes one asks
for another. Rung 30 had all thirty refused, and Brain paused, kept every bin,
and resumed by itself when the window reopened. So a throttled fleet loses
throughput rather than work, and the remedy for more capacity is more routines
rather than more allowance. **The recommended ceiling is 10 concurrent bins on
one routine**, with the full measurements in [STEP-10-EVIDENCE.md](STEP-10-EVIDENCE.md).

**The real research packet is filed and audited.** This section, and the
evidence file, previously said the acceptance item did not pass because the
worker's execution surface had no egress to the primary sources. The operator
opened it; a `SURFACE_PROBE_V1` bin proved from inside a fired Routine session
which of four different things "blocked" had meant; a guarded recovery gave the
one fragment a further attempt without resetting its counter or erasing its
failure history; and the same packet — `orc_9b2965e776bb4de7ab9f`, no
replacement — ran through research, verification, synthesis, all three audit
roles and filing.

It ended `COMPLETE_WITH_GAPS` rather than `COMPLETE`, which is the honest word:
its judge returned `MORE_RESEARCH` over one targeted question, no fragment was
repairable, and a named administrator authorized the packet to record what it
was short of. `COMPLETE` means the judge advanced it, and this judge did not.

An unattended worker has completed bins end to end and a fleet of ten has been
measured, so "Brain runs a worker" and "Brain runs a fleet of ten on one
routine" may both be said. What a second routine does is Step 11's, and nothing
here is evidence for it.

**The real research packet is where Step 10 stops, and not because of Brain.**
On `orc_9b2965e776bb4de7ab9f` Brain dispatched a worker, the worker planned,
Brain validated the plan against a preauthorized envelope and approved it with
no person involved, and Brain queued the research. The worker then could not
reach `legislature.mi.gov` or any other Michigan primary source — its execution
environment has no egress — so its two claims were refused by the evidence gate,
the fragment used its full repair budget and was `BLOCKED` with the reason
recorded, and the three fragments depending on it stayed `QUEUED`. That is §12
and §15 working: faced with research it could not ground, the engine produced
nothing rather than something.

So the split holds at a new boundary. **Brain owns dispatch; the surface owns
whether a worker may act** — first its permission to call the connector, now its
network reach. **Step 10 is not closed**: it needs a filed, audited document from
a worker surface that can reach published primary sources, and that needs no
change to this repository.

### What Step 12 is actually for

Step 8 built `/operator` because worker administration existed only over HTTP
and a credential has to be shown once inside a browser. Two things ended up on
that screen that do not belong there, and they are Step 12's to move:

- **Creating a project** and **queueing a work item** are scaffolding. They
  exist because neither had a UI anywhere and the alternative was `curl`. In
  the finished product the planner decides what work exists; nobody hand-queues
  an item.
- **Setting a worker's projects and scopes** is a real and permanent decision,
  but it belongs in the Brain proper rather than a separate console.

The distinction Step 12 must preserve while moving them: **the Brain dispatches;
a worker never widens its own reach.** Assignment is already automatic — a
worker asks the queue what is next and the Brain answers by priority, so no
person matches workers to projects and none should. What stays a deliberate act
is the trust boundary itself: which research a borrowed account may touch, set
once when the account is connected. That is the platform being the authority,
not a human being a bottleneck, and the difference is worth keeping when the
screen is rebuilt.

`/operator` should end up small: the consent screen, and issuing a credential
for a client that cannot do OAuth. Both have to keep working when the front-end
does not, which is why they are plain server-rendered HTML.

### Research budgets — where the ceiling gets built

`startPacket` takes an approval policy rather than assuming one, and today it
serves exactly one of the two modes.

- **`PER_PACKET`** is what the console does and what has always happened: the
  packet is planned in full, a person reads the plan, and only then is any
  allowance spent. The approval is about *this packet*, and what it controls is
  **scope** — nobody researches a decomposition a person has not seen.
- **`GOAL_BUDGET`** is what the Brain needs to run without a person in the
  loop: approval given once for a goal, its boundary contract, its source
  requirements and how much research effort it may consume, after which the
  Brain creates and dispatches whatever packets that goal needs. The approval
  is about *the goal*, and what it controls is **spend**.

The type is in `services/research/startPacket.ts` now; the second mode is
refused there by name, and the reason is worth keeping when it is implemented.
Setting `autoApprove` is easy and would work today. Nothing in the Brain counts
packets, counts fragments or watches a deadline — `services/research/quota.ts`
only reacts to an allowance that has *already* run out — so the approval half
of the authorization would take effect while the budget half stayed decorative.
A ceiling nothing enforces is worse than no ceiling, because the person who set
it believes they have one.

**What the step has to build:**

- A goal record the budget hangs off, and a packet's link back to it. Packets
  per goal and fragments across those packets are counts over that link, so
  they cannot be derived from a single orchestration.
- The counters, checked **before** work is created rather than after it is
  spent — the same placement as the coverage check, and for the same reason.
- An optional deadline, evaluated on Brain's clock (`queueNow()`), never a
  worker's.
- External paid spending pinned at zero, and metered overages off unless the
  user turns them on themselves. Invariant 18: neither a policy, a default nor
  a caller may set either.
- **Reaching a limit is not a failure.** Every accepted fragment and every
  queued one is kept, exactly as an exhausted allowance is handled today, and
  the answer is a question to the user about raising the goal's budget — never
  a lowered evidence bar.
- Unused authorization is a **ceiling, not a target**. With budget left and the
  archive already answering the goal, the correct number of new packets is
  zero. §13 decides that, not the budget.

**What it must not change.** The gate and the audit decide what the Brain
knows: research that clears its evidence gate and its audit is absorbed without
a person reading the report first. Human review belongs where a conclusion
turns into a consequence — an implementation somebody has to live with,
external spending, a destructive action, or another governed decision — not in
front of every packet.

### The separations that matter most

- **Step 4 is not Step 5.** Knowing *who* a worker is does not make it safe for
  two of them to take the same job. Identity is authorization; claiming is
  concurrency. Step 4 replaced the shared-token gate with real accounts and
  added nothing about leases, on purpose.
- **Step 5 is not Step 6.** A lease stops two workers starting the same job. It
  does not make the *effects* of a job safe to apply twice, which is what
  happens when a lease expires mid-flight and the work is retried. Idempotency
  is its own step because assuming it comes free with leases is how duplicated
  effects get shipped.
- **Step 8 is not Step 9.** A worker that can authenticate, claim, heartbeat
  and complete has proved the *transport*. It has not proved that anything it
  learns can become part of the Brain, and until Step 9 nothing could: the
  fourteen tools were nine reads and five queue operations, and seven research
  scopes declared in Step 4 gated nothing at all.
- **Step 7 is not Step 8.** Exposing the protocol and connecting a real worker
  to it are different claims, and only the second one is evidence that the
  first works — the same distinction Step 3 drew between the research engine
  passing its tests against a scripted provider and a real job having actually
  run. Step 7 landed with two real external MCP clients driving the deployed
  endpoint; CF-7 is untouched by that and remains Step 8's.
- **Step 11 is the only one that runs more than one worker.** Until it lands,
  Brain runs a single instance deliberately: the extraction and research queues
  are per-instance and nothing coordinates them.

## Why one instance, until Step 11

`fly.toml` pins one machine and `--ha=false` is passed on every deploy.

Until Step 5 that was a correctness requirement: the research and extraction
queues were arrays inside one process, so a second machine would have kept its
own and both would have started the same work.

Step 5 built the substrate that makes a second machine safe for *queued work* —
durable rows, atomic claiming, leases and fencing — and proved it against real
Postgres with concurrent connections. It did **not** turn a second machine on,
and two things still hold it back:

- The research and extraction pipelines were deliberately **not** migrated onto
  the queue, because the queue is at-least-once and moving quota-spending work
  onto it before Step 6 would mean a redelivered job spending the allowance
  twice. Those two queues are still per-instance.
- The sign-in throttle is still an in-memory map per process. With several
  instances each brakes separately, so the effective limit multiplies by the
  instance count. Harmless at one machine; wrong at two.

Both are Step 11's to resolve, at the point a second machine is actually run.

