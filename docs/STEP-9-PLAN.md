# Step 9 — First Manual End-to-End Research Packet: the execution map

Step 9 asks one question, and it is not a question about code:

> **Can a real Claude Max worker, over the deployed MCP gateway, carry one
> genuinely useful research packet from a human's intent to a canonical,
> audited, citable document in the Brain — with every claim gated on the way
> in and nothing invented anywhere?**

Step 8 proved a worker can authenticate, claim, heartbeat, complete and be
fenced. It proved the *transport*. What it did not prove — and what it could
not have, because the tools did not exist — is that anything a worker learns
can become part of the Brain.

This file is the map required before the packet is created. It records what
was found, what was decided, what was rejected and why, and exactly what gets
built. It is not the evidence; `STEP-9-EVIDENCE.md` is that, and it is written
after the packet has actually run.

---

## 1. The finding that shapes the step

**The Brain has two research architectures and they do not meet.**

### A. The push model — Steps 1 through 3

`services/research/orchestrator.ts` is a synchronous in-process loop. It
decomposes an assignment into fragments, and for every pass it calls
`provider.run(prompt)` on an `AIProvider` — mock, Antigravity, or an API-keyed
model. It validates each reply through `services/research/schema.ts`, applies
`gate.ts` per claim, repairs what failed, synthesizes from the accepted
ledgers only, and hands the packet to the primary/adversarial/judge audit.

Everything §12 through §16 of `CLAUDE.md` promises lives here, is implemented,
and is tested. It has never been driven by a Claude Max subscription, because
a subscription is not an API the Brain can call.

### B. The pull model — Steps 5 through 8

A worker authenticates over `/mcp`, asks the queue what is next, is handed a
`work_item` under a fenced lease, does something, and reports back. Fourteen
tools. Nine of them read; five operate the queue.

**Zero of them write anything a researcher produces.** Not a claim, not a
source, not a contradiction, not a checkpoint, not a document. The scopes
exist — `research:read`, `research:write`, `research:propose`, `claims:write`,
`sources:write`, `contradictions:write`, `checkpoints:write`,
`blockers:report` are all declared in `WORKER_SCOPES` — and **no tool reads a
single one of them.** They were reserved in Step 4 for the step that would
make them real. This is that step.

The two registered work types are `SYNTHETIC_ECHO` and `SUMMARIZE_PASSAGE`.
Both carry their entire subject in the payload and hand back a string. Neither
touches a document, a layer or a claim.

So the honest statement of where Step 8 left things is the one already given
to the operator in plain terms when they asked where a worker's analysis had
gone: **into a chat log, and nowhere durable.** Step 9's whole substance is
closing that.

---

## 2. The bridge, and the bridge that was rejected

### Rejected: make the worker an `AIProvider`

The tempting design is a `QueuedWorkerProvider` whose `run(prompt)` enqueues a
work item carrying the prompt, waits for a worker to complete it, and returns
the text. `orchestrator.ts`, `pipeline.ts`, `gate.ts`, `packet.ts`,
`repair.ts` and `replan.ts` would then work **unchanged**, and every invariant
in §12–§16 would hold for free.

It is rejected, and the reason is written into the work-type registry already:

> A queue item describes Brain-authorized work. It is never a command to
> execute, and there is deliberately no work type meaning "run this". […]
> Without that rule, an authenticated worker credential plus an enqueue
> permission would add up to remote shell access, which is not a queue, it is
> a backdoor.

A work type whose payload is an arbitrary prompt for a language model is
exactly "run this". The payload is not a shell command, but the reasoning
transfers without weakening: enqueue permission plus a prompt-carrying type
adds up to *make this borrowed Claude account say anything I want*, which is
the abuse the entire worker design exists to prevent. That the enqueuer is
currently a human and not a worker does not save it — Step 12 moves enqueueing
to the Brain, and the rule is about the type, not about who fills it in.

Reusing more code is not worth building the one thing §19 says must not exist.

### Chosen: typed research work, structured submission, server-side gating

A work item names **what to research**, never what to say. It carries an
orchestration id and a fragment id — a bounded question the Brain has already
declared, with its geography, timeframe, population, definitions, required
evidence lanes, acceptable and excluded source types, completion criteria and
independent-source minimum. The worker reads that declaration through a read
tool, does the research with its own capabilities, and submits **structured
claims** through a write tool.

Then the Brain does what it already does: `validateClaim` decides whether each
claim is structurally sourced, `insertClaims` stores it *unaccepted*,
`applyGate` applies all seven conditions, `decideClaim` records the verdict and
the rejection reason, and `updateFragment` records the fragment's integrity and
sufficiency. A fragment that cannot clear its own bar contributes nothing.

Three properties this preserves, each of which the rejected design would also
have preserved and which are worth stating because they are the point:

- **The worker never decides what is accepted.** It submits; the gate decides.
  §8's "model prose never mutates project state" holds at a new boundary.
- **Nothing new is trusted.** The submission is structured arguments rather
  than prose, so it skips `parseResearchPass` — which exists to dig JSON out of
  a model's reply — and lands on the same field validation and the same
  downstream path.
- **Every tool stays a thin wrapper over a service that already existed, with
  the scope it already required.** Step 7's first rule, unmodified.

What the chosen design costs is that the orchestration can no longer be one
in-process loop. It becomes a state machine advanced by completions. That is
the real work of Step 9 and it is named as such in §5.

---

## 3. The packet

### What "genuinely useful" has to mean here

The spec forbids a demo. A packet that researches something nobody wants to
know would prove the machinery and teach the project nothing, and it would
also be untestable in the one way that matters: nobody could tell whether the
answer was right.

So the selection criteria are:

1. **A real open question in a real project** — one whose answer changes what
   somebody does next, not a question chosen because it is easy to source.
2. **Bounded.** One packet, not a programme. It must finish inside the
   allowance of a single subscription without paid overage.
3. **Externally answerable.** §13's default is *not* to research — so it must
   be a genuine external-research gap, and the reconcile pass must agree it is
   one rather than something the archive already answers.
4. **Checkable by a human.** The operator has to be able to read the filed
   document and say whether the citations hold. A packet whose correctness
   only a specialist could judge cannot close this step honestly.
5. **Safe to be wrong about.** Nothing depending on it ships before a person
   has read it.

### The packet, as selected

**Project:** Deal Dispatch. **Layer:** Monetization Logic.

> **In California, Texas, Florida, New York and Illinois, does a person who
> arranges the sale of a privately held business for a success fee need a
> real-estate broker or business-broker licence when the transaction transfers
> no real property and no lease interest — and what is the exact statutory or
> regulatory provision that settles it in each state?**

**Why this layer.** Monetization Logic owns *what economic position Deal
Dispatch may occupy in a transaction*, and the word "may" is load-bearing: a
position you are legally barred from occupying without a licence is not one you
may occupy. The layer already audits for the agency-versus-principal distinction
and for marketplace-versus-representation, and licensure attaches precisely to
acting as a representative for compensation. The neighbouring layer,
Execution Playbooks, owns *how* to do it — which this is not. Recording the
reasoning here so the audit's G12, correct gap ownership, can be checked rather
than assumed.

**Why it meets the criteria.**

1. *Genuinely unresolved, and decision-changing.* The answer differs by state
   and is not one line. It decides whether a success fee is available at all in
   the largest five commercial markets, which is a compliance gate on a
   monetization structure rather than a detail of it.
2. *Bounded.* Six fragments — one per state, plus a boundary fragment
   establishing what "arranges", "success fee" and "no real property" mean, on
   which the other five depend. That dependency is not decoration: §13 says an
   ambiguity in the boundary contract becomes its own fragment before anything
   else runs, and it exercises the runner's ordering for real.
3. *Primary sources.* Each answer is a statute section or a regulator's own
   guidance — the source type §14 says settles a statutory fact with one
   directly inspected instance. Each fragment's `min_independent_sources` is
   therefore 1, not 2, and `standards.ts` is what decides that rather than a
   blanket rule.
4. *Independently verifiable.* The deliverable is five citations a reader can
   open. That is the strongest form of criterion 4 available: correctness is
   checkable by anybody, not only by a specialist.
5. *Safe to be wrong about.* It is a research packet, not legal advice, and
   nothing depends on it before a person has read it. The assignment says so.

**What would make it a failure rather than a bad answer:** a state answered
from a law-firm summary rather than the provision itself, a citation that does
not resolve, or a scope drift into transactions that do include real property —
each of which the fragment's declared `excluded_source_types`, its evidence
lane and its `definitions` are there to catch at the gate.

### What the packet must produce

- One `research_orchestration` row, `COMPLETE`, with its `document_id` and
  `audit_id` set.
- Between one and a handful of `research_fragments`, each with an integrity and
  a sufficiency verdict and the gate's full working in `verdict_detail`.
- A `research_claims` ledger where **every** row carries its acceptance or its
  rejection reason, and every accepted row carries a canonical URL, a locator
  and a recorded scope judgement.
- One registered `documents` row — canonical name from `buildNames`, never the
  model's title — whose text carries the ledger inside it, so every sentence
  resolves to a claim id, a URL and a passage.
- One `audits` row from the primary/adversarial/judge pipeline over that packet.
- A `project_events` trail, and `recomputeProject` having run.

If any of those is absent, the packet did not happen, whatever a chat transcript
says.

---

## 4. Acceptance contract, stored in the Brain

The packet's acceptance criteria are not kept in this file. They are stored on
the orchestration as its `assignment` and on each fragment as its declared
`completion_criteria`, `required_evidence` and `min_independent_sources`,
because those are the fields the gate actually reads. A criterion written in a
document and not in a column is a criterion nothing enforces.

---

## 5. What gets built

### 5.1 Schema — migration 020 (SQLite) and 010 (Postgres)

- `work_items` gains `orchestration_id` and `fragment_id`, both nullable and
  both `REFERENCES … ON DELETE CASCADE`. Null for `SYNTHETIC_ECHO` and
  `SUMMARIZE_PASSAGE`, which belong to no orchestration.
- `work_item_checkpoints` — append-only progress notes against a work item:
  `id`, `work_item_id`, `attempt`, `lease_generation`, `note`, `created_at`.
  Append-only because a checkpoint that can be edited is not a record of what
  the worker knew at the time.

Both chains, in the same change, per §3. The Postgres file is numbered
independently and its unique indexes carry the `uq_` prefix.

### 5.2 Work types

Five, each naming the scope it needs and each **not** carrying a prompt:

| Type | Payload | Scope | Safe to repeat |
|---|---|---|---|
| `RESEARCH_PLAN` | orchestration id | `research:propose` | yes — proposals replace proposals |
| `RESEARCH_FRAGMENT` | orchestration + fragment id | `claims:write` | yes — resubmission is keyed by content hash |
| `RESEARCH_VERIFY` | orchestration + fragment id | `research:write` | yes — a verdict per claim, replaced not appended |
| `RESEARCH_SYNTHESIZE` | orchestration id | `research:write` | yes — a rejected synthesis is kept as history |
| `RESEARCH_AUDIT` | orchestration id + role | `research:write` | yes — an audit pass records, it does not advance state |

Every one of them is safe to perform twice, which the registry's header
requires of everything in it, and every mutation behind them goes through
Step 6 keyed from the work item — never from the lease, the attempt, the
generation or the clock.

### 5.3 MCP tools — eight, taking the surface to twenty-two

| Tool | Scope | Over |
|---|---|---|
| `brain_get_assignment` | `research:read` | `repos/research.ts` — the orchestration, this fragment's full declaration, and the accepted claims of the fragments it depends on |
| `brain_propose_fragments` | `research:propose` | `reconcile/plan.ts` + `createFragments`; stored `PLANNED`, **never auto-executed** |
| `brain_submit_claims` | `claims:write` | `sources.ts:validateClaim` → `insertClaims`, always unaccepted |
| `brain_submit_verification` | `research:write` | the per-claim support and scope judgements the gate needs for conditions 2 and 4, then `applyGate` → `decideClaim` → `updateFragment` |
| `brain_report_contradiction` | `contradictions:write` | `contradictions.ts` + `markContradiction` |
| `brain_checkpoint_work` | `checkpoints:write` | `work_item_checkpoints` |
| `brain_report_blocker` | `blockers:report` | a fragment `BLOCKED` with a reason — distinct from a failure, because "I cannot answer this" and "I crashed" need different responses |
| `brain_submit_synthesis` | `research:write` | citation resolution against accepted claims, then `registerRunArtifact` and `packet.ts:assessPacket` |

The list stays permanent and identical for every caller. Nothing is filtered
per principal; `policy.ts` decides at execution time, exactly as it does for
every HTTP route, and there is no MCP policy module.

After this step **every scope in `WORKER_SCOPES` gates something that exists.**

### 5.4 The packet runner

`services/research/packetRunner.ts` — the state machine that replaces the
in-process loop. It is called when a research work item reaches a terminal
state and it decides the next thing to enqueue:

```
QUEUED     -> enqueue RESEARCH_PLAN
PLANNING   -> plan proposed; wait for a human to approve
(approved) -> enqueue one RESEARCH_FRAGMENT per fragment, in dependency order
RESEARCHING-> each fragment's claims in; enqueue its RESEARCH_VERIFY
(gated)    -> all fragments decided; assessPacket; repair what failed, or
SYNTHESIZING-> enqueue RESEARCH_SYNTHESIZE
AUDITING   -> enqueue the three RESEARCH_AUDIT roles
COMPLETE   -> file the artifact, recordAudit, recomputeProject
```

It reads persisted state only, so a restart mid-packet resumes from rows rather
than from memory — which is what `recoverInterruptedResearch` already promises
and what §5.6 tests for real.

### 5.5 The operator console

One card, `Start a research packet`: project, layer, the assignment, and the
goal's boundary terms. Then a second view showing the proposed plan with an
**Approve** button, because §16 is explicit that a browser-initiated run is
planned in full and then stops until a person approves. Nothing is spent before
that click.

### 5.6 Tests

The suites are written against both backends and must include, at minimum:

- A submitted claim with no URL is stored, is **not** accepted, and keeps
  `NO_URL` forever.
- A fragment whose lanes are uncovered is `INSUFFICIENT` and contributes
  nothing to the synthesis, and its rejected claims cannot re-enter through a
  later attempt.
- A synthesis citing a claim id that is not accepted is refused.
- A worker missing `claims:write` is refused `brain_submit_claims` and the
  refusal is indistinguishable from the resource not existing.
- Two submissions of the same claims record one effect (Step 6), and the
  second reports the replay.
- A checkpoint survives a lease expiry and is visible to the next claimant.
- The packet runner resumes a half-finished orchestration from rows after a
  process restart.

Every test is verified against its own inversion — the Step 8 lesson that a
test which passes with the guard removed is not a test.

### 5.7 Docs

`docs/RESEARCH-PACKETS.md` for the design, `docs/STEP-9-EVIDENCE.md` for what
was actually proven versus what only passes its tests, the worker contract
extended with the research obligations, and `ROADMAP.md` updated when the step
lands and nowhere else.

---

## 6. Token expiration — CF-8, exercised for the first time

Step 8 assigned CF-8 to Step 10 and recorded that refresh tokens are issued for
thirty days, the rotation grant is implemented and tested, and **nothing has
exercised it live.** A one-hour access token was harmless for a bounded echo.
A research packet is the first work that can outlive one.

Step 9's position: the packet is decomposed into work items that are each far
shorter than an hour, so a token expiring between items costs a refresh and
nothing else, and a token expiring mid-item costs one lease and one redelivery
— which the queue already handles and which the checkpoints make cheap. **The
fix is not a longer-lived token and it is certainly not a permanent one.** If
the live run shows the client does not refresh, that is a finding for the
evidence file and remains Step 10's to resolve.

## 7. Inherited register

| Item | Where it stands entering Step 9 |
|---|---|
| CF-5 — a real archive migration was never exercised | operator task; not Step 9's |
| CF-6 — more than one instance | Step 11 |
| CF-7 — the real Claude worker is UNVERIFIED | **closed in Step 8** |
| CF-8 — a one-hour token versus long work | Step 10's to resolve; **exercised live for the first time here** — see §6 |
| CF-9 — disabling a live worker reports zero tokens revoked | **open.** Reproduce against Postgres by reading `oauth_tokens` directly. Not Step 9's, and not to be quietly absorbed |
| CF-10 — a dropped connector does not re-attach to a running session | known client limitation; work around with a fresh session |
| CF-11 — where a worker runs decides whether it can authorize | Step 11 |

## 8. Exclusions — what Step 9 is not

- **No schedules.** Nothing fires on a timer. Every packet in Step 9 is started
  by a person clicking a button. That is Step 10.
- **No second worker.** One connected Claude Max account. A consequence worth
  naming rather than hiding: the primary, adversarial and judge audit roles are
  played by three separate passes on the **same** account, which is weaker than
  three independent readers and is Step 11's to fix. The evidence file will say
  so.
- **No fleet controls, no control centre.** Steps 11 and 12.
- **No Anthropic API key**, and no silent switch from subscription-backed Claude
  to metered API usage.
- **No path around the gateway.** Every worker action in the packet goes through
  `/mcp`.
- **No hand-written worker results.** Not one row in `research_claims` may be
  inserted by a person to make the packet look finished.
- **No Step 9-only privileged path.** Every tool added here is permanent, is a
  thin wrapper over a service that already existed, and is subject to the same
  execution-time authorization as everything else.
- **A chat response is not a completed packet.** The terminal state is rows in
  the Brain.
