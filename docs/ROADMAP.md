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
| **8** | **A worker signs in.** OAuth 2.1 authorization so a Claude connector can authenticate at all, a consent screen where a human approves a named worker, tokens that resolve to the worker rather than the approver, the operator console — including the two things a worker must never do for itself, creating a project and queueing its own work — and the first real Claude Max worker | *in progress* |

Step 3's evidence is in [`STEP-3-EVIDENCE.md`](STEP-3-EVIDENCE.md); Step 4's is
in [`STEP-4-EVIDENCE.md`](STEP-4-EVIDENCE.md), and the model it built is
described in [`IDENTITY.md`](IDENTITY.md). Step 5's evidence is in
[`STEP-5-EVIDENCE.md`](STEP-5-EVIDENCE.md) and its design in
[`QUEUE.md`](QUEUE.md). Step 6's is in
[`STEP-6-EVIDENCE.md`](STEP-6-EVIDENCE.md) and its design in
[`EFFECTS.md`](EFFECTS.md). Step 7's is in
[`STEP-7-EVIDENCE.md`](STEP-7-EVIDENCE.md) and its design in
[`MCP.md`](MCP.md). Each evidence file says what was proven, what merely passes its tests, and what
nobody has run.

## Ahead

Each of these is a separate step on purpose. They are listed in order and the
order is a dependency order, not a preference.

| Step | What it contains |
|---|---|
| **9** | Manual end-to-end research packet |
| **10** | Scheduled firing and interruption recovery |
| **11** | Additional workers and fleet controls |

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

