# Step 10 — event-driven generic bin dispatch

Brain stops waiting for a person to start a worker.

Step 9 proved a worker can carry a packet from intent to an audited, citable
document. Every one of those activations was a human deciding to start a
session. The largest single block of elapsed time in the whole step was a
packet sitting in a queue waiting for somebody to say go.

This step removes the person from that loop and nothing else. It does not
decide *what* to research (Step 12), and it does not learn how many workers to
run (Step 11). It builds the layer that turns *"Brain holds ready work"* into
*"a Claude session is running that work"* without a model idling anywhere.

---

## The immutable baseline

Step 9's closure evidence, read from authoritative rows at
2026-09-01T02:32Z before any Step 10 code existed. Nothing in this step may
change any of it, and the final report re-reads it.

| Field | Value |
|---|---|
| Orchestration | `orc_be4ddfe7388b40be9e01` — `COMPLETE` |
| Work items | 15, all `SUCCEEDED` — 1 PLAN, 5 FRAGMENT, 5 VERIFY, 1 SYNTHESIZE, 3 AUDIT |
| Claimable | 0 |
| Claims | 26 stored, 16 accepted |
| Passes | 15 |
| Audit | `aud_e4fdb58b2ae34c0bbac7` — `READY_FOR_SYNTHESIS`, 2 gaps |
| Document | `doc_57277dfc5f1242b4b7ab` — Monetization Logic v1B, 26,900 bytes, present, extraction `READY` |

Step 10 runs in its own project. It does not touch Deal Dispatch.

---

## 1. What a bin is, and why it is a new row

A **bin is one complete idea**: an objective, the reason it exists, everything
needed to execute it, and the predicate that decides whether it was done.

The temptation is to call a `research_orchestration` a bin and move on. That is
wrong for one reason that matters later: an orchestration *is* research. It has
an assignment, fragments, claims, verification passes and an audit, and every
one of those is a research noun. Step 12 will create bins that are not research
at all, and a dispatcher that reaches into `research_orchestrations` to decide
what to hand out is a dispatcher that has to be rewritten the first time a
mission is not a packet.

So a bin is a new, deliberately thin row. What it is **not** is a second queue.

```
bins                    the mission: manifest, contract, lease, checkpoint
  │
  ├── orchestration_id  ─────► research_orchestrations   (research missions)
  │
  └── work_items.bin_id ─────► the existing Step 5 queue (every mission)
```

The internal units of every bin are `work_items` — the same rows, the same
compare-and-swap claim, the same fencing generation, the same checkpoints. The
bin adds a column to them and nothing else. There is exactly one durable source
of truth for "what work exists", and it is the one Step 5 built.

### The bin manifest

Brain authors this in full **before** assignment. The worker executes it and
never widens it.

| Field | Holds |
|---|---|
| `objective` | the one idea this bin exists to complete |
| `why` | why the work exists at all |
| `lineage` | project, layer, goal, and the orchestration when there is one |
| `units` | how many internal units, and what each must establish |
| `ordering` | dependencies between units |
| `sources` | acceptable and excluded source types |
| `evidence` | what counts as established |
| `outputs` | required artifacts and durable records |
| `completion` | the contract name and version that decides terminal |
| `authorized` | actions this bin may perform |
| `prohibited` | actions and scope it may not |
| `budget` | the allowance boundary |
| `priority` | baseline ordering |
| `retry` | attempts, backoff, recovery policy |
| `stopping` | conditions that end the bin short of complete |

A bin whose manifest does not declare its completion contract cannot be
dispatched. That is the same refusal `brain_propose_fragments` already makes for
a fragment with no lanes: a thing with no standard is accepted vacuously, which
is worse than being refused.

---

## 2. The permanent operating model

```
  bin becomes READY
        │
        ▼
  bin_dispatch intent          durable, keyed (bin_id, lease_generation)
        │                      created by the state transition, not by a poller
        ▼
  dispatcher tick              plain interval loop. No model. No LLM idles.
        │                      POST /v1/claude_code/routines/{trig}/fire
        ▼
  Claude Routine session       identical every time; no identifiers in its prompt
        │
        ▼
  brain_check_in               the worker names nothing
        │
        ▼
  atomic assignment            CAS on bins.lease_generation → exactly one owner
        │
        ▼
  manifest                     the worker reads what Brain decided
        │
        ▼
  drain: brain_bin_next_item ──┐  every internal stage the bin makes ready
        ▲                      │  fragments, claims, verification, repair,
        └──────────────────────┘  synthesis, audits, filing
        │
        ▼
  brain_bin_complete           the worker *requests* terminal.
        │                      Brain evaluates the contract and decides.
        ▼
  brain_check_in again         another bin, until none / allowance / one decision
```

Ten properties this shape has to keep, and where each is enforced:

| Property | Enforced by |
|---|---|
| No model polls | the dispatcher is a `setInterval` in the Brain process |
| Dispatch survives restart | `bin_dispatch` is a table, redriven at boot |
| Triggers idempotently recorded | `UNIQUE (bin_id, lease_generation)` on the intent |
| Duplicate fire ⇒ wasted session, never duplicate work | assignment is a CAS |
| Exactly one lease per bin | `CHECK` — lease columns set iff `LEASED` |
| Stale writes rejected | every guarded `UPDATE` carries the generation |
| No worker acts outside its bin | the bin is read from the **lease**, never the request |
| Dead worker recovered | expired lease is assignable work |
| Completion is Brain's | `brain_bin_complete` evaluates a server-side contract |
| Nothing self-certifies | contracts read durable records, never worker prose |

### Why the fire payload carries nothing

`/fire` accepts an optional `text`, and Anthropic wraps it in a
`<routine-fire-payload>` block labelled untrusted. Anyone holding the bearer
token can send it. So Brain sends **no** `text` at all: the worker's entire
instruction set is its saved prompt, and its entire work assignment comes from
an authenticated `brain_check_in`. A leaked trigger token can therefore start a
session and nothing more — the session still has to authenticate to Brain, and
Brain still decides what it gets.

This is also why the permanent prompt must not reference the payload. A prompt
that says "do what the payload says" converts a leaked token into an
instruction channel.

### At-least-once, on purpose

`/fire` documents that it has no idempotency key: *"If a webhook caller retries,
the endpoint creates multiple sessions."* That is accepted. Two sessions both
check in, both attempt the CAS, one wins the bin and the other is told there is
nothing for it and exits. The cost of a duplicate trigger is one wasted
activation, never duplicated work — which is precisely the Step 5 guarantee
being reused rather than a new one being invented.

---

## 3. Completion contracts, and detecting a worker that lies

**A worker's word is never evidence.** `brain_bin_complete` does not mark a bin
complete; it asks Brain to evaluate the bin's contract and returns the verdict.
Every contract is versioned, deterministic and replayable — running it twice on
unchanged rows gives the same answer, and it reads only durable records.

Two contracts ship in Step 10. The mechanism is what is permanent; the list is
meant to grow without touching the dispatcher.

**`RESEARCH_PACKET_V1`** — the Step 9 controls, unchanged and reused whole:
structured claims, canonical sources, retrieval state, evidence-lane coverage,
scope matching, independence grouping, verification, citation resolution,
contradiction preservation, synthesis gates, ordered audit roles, canonical
filing, terminal reconciliation. Satisfied only when the linked orchestration is
terminal `COMPLETE`, its document exists with bytes, its audits ran in order,
and nothing remains claimable.

**`DETERMINISTIC_UNITS_V1`** — for tiny bins. The manifest declares units, each
with an input and a named pure transform. The worker must store a result per
unit; Brain **recomputes** each one and compares. A wrong or absent value fails
the contract. This is deliberately not an echo: the worker cannot pass by
returning what it was given.

On top of the contract, four cheap signals, all recorded rather than acted on
silently:

- **completion refused with a reason**, retained forever on the bin;
- **suspiciously fast** — terminal requested with no tool calls and no writes
  recorded for the lease;
- **content-free or repeated** submissions, by content hash;
- **stale fence** — a write after lease loss, rejected and counted.

### The governing invariant

> Every nonterminal bin must have claimable work, live work, a bounded
> automatic retry, or **one precise human decision that can actually resolve
> it**.

An unexplained nonterminal bin with an empty queue is a defect, and there is a
reconciliation pass that says which of the four a bin is in. This is the same
rule the packet runner already applies to orchestrations, lifted one level.

---

## 4. Telemetry for Step 11

Step 11 is not being built. Its raw facts are being recorded, because they
cannot be reconstructed later from application logs.

`bin_events` is append-only, one row per observation, carrying: routine identity
and version, fire event and session identity, provider, bin/project/goal/work
lineage, every timestamp in the lifecycle (queued, dispatched, claimed, started,
checkpointed, released, resumed, completed), queue wait and execution duration,
lease renewals and expirations, attempts, retries, interruptions, takeovers,
units completed, tool-call counts by tool, sources retrieved, accepted/rejected/
unresolved claims, artifacts produced, completion outcome and reason, connector
and authentication failures, quota warnings, allowance exhaustion, observed
cooldown and recovery, and exact usage when the provider exposes it.

Where the subscription does not expose consumption, **observable proxies** are
recorded instead and labelled as proxies. A number nobody can source is worse
than an absent one.

---

## 5. What is permanent, what is scaffolding

**Permanent code.**
`server/db/migrations/024_bins.sql` + `pg-migrations/015_bins.sql`;
`server/repos/bins.ts`; `server/services/bins/` (contracts, reconcile,
telemetry); `server/services/dispatch/` (outbox, the fire client, the loop);
the bin MCP tools; `server/services/bins/workerInstructions.ts` — the permanent
Routine prompt, served from code so the document and the Routine cannot drift.

**Temporary acceptance harness.**
`scripts/step10-acceptance.ts` — creates the acceptance scope, mints tiny
deterministic bins, drives the concurrency ramp and prints measurements. It is a
script, not a console button, per the instruction to prefer permanent services
and scripts over new operator UI.

**Deferred to Step 11.** Capacity-aware routing, forecasting, learned bin
sizing, more than one Brain instance, the sign-in throttle becoming shared.

**Deferred to Step 12.** Idea discovery, unknown-unknown generation,
cross-project prioritization, approval-per-goal, and the UI rework. The current
console is frozen: Step 10 adds no operator buttons.

### What Step 10 must not contain

No permanent dispatcher or Routine instruction may contain an `orc_` id, a
project id, "Deal Dispatch", "Monetization Logic", "Step 9", a research topic, a
bin number, or any instruction to select its own work. A test asserts this
against the shipped strings rather than trusting review.

---

## 6. The expected failure chain

Named before deploying, so that finding one is recognition rather than
discovery.

1. **The Routine cannot reach Brain.** Connectors route through Anthropic's
   servers, so the environment allowlist should not matter — but the routine
   must actually *have* the Brain connector attached.
2. **OAuth token expiry mid-run** — CF-8, still unverified. A long unattended
   run is the first thing that could observe it.
3. **`/fire` 429** on the daily routine cap. Expected during the ramp; it is
   the measurement, not a failure.
4. **A duplicate session with nothing to do** must exit fast and cheap, or the
   ramp burns allowance on no-ops.
5. **A bin that drains but cannot terminalize** because a contract is stricter
   than the work path can satisfy — the Step 9 lane failure one level up.
6. **Lease too short for a real research bin**, causing a takeover mid-flight
   and a second worker redoing accepted work. Mitigated by heartbeats; the
   cadence is a measurement.
7. **The dispatcher firing for a bin already being drained**, if the intent key
   is wrong.
8. **Clock**: lease decisions must use Brain's clock, never a worker's.

---

## 7. Acceptance

Two classes of bin, in a dedicated Step 10 project.

**A — tiny deterministic bins.** Cheap, fast, verifiable. They exercise
dispatch, concurrency, leases, duplicate triggers, recovery and capacity, and
they still produce structured output Brain recomputes.

**B — one bounded real bin.** A genuinely useful, fully scoped research
assignment through the complete lifecycle, so the test proves information
quality and not merely queue mechanics. Brain-authored before assignment; it may
not expand into the remaining Deal Dispatch layers.

**Ramp.** 1, 2, 5, 10, 20, 30, 50 identical workers, stopping at the first
observed provider or subscription boundary. No paid overage, no credits, no API
charges. The objective is to measure the real ceiling, not to reach 50.

Standards — worker count, burst size, bin-size ceiling, fragments per
activation, lease duration, heartbeat cadence, backoff, checkpoint frequency,
retry limit, when to split an oversized idea — are **derived from what is
observed** and recorded as observations. None of them is guessed.
