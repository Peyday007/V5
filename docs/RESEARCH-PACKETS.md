# Research packets

How a real Claude, on a subscription, does research the Brain will stand behind.

This is the Step 9 design. Its evidence — what was actually proven versus what
merely passes its tests — is in [`STEP-9-EVIDENCE.md`](STEP-9-EVIDENCE.md).

---

## The problem it solves

Before Step 9 the Brain had two research architectures and they did not meet.

**The push model** (`services/research/orchestrator.ts`) decomposes an
assignment into fragments and calls `provider.run(prompt)` for every pass, in
one synchronous in-process loop. Everything §12–§16 of `CLAUDE.md` promises is
implemented there and tested. It has never been driven by a Claude Max
subscription, because a subscription is not an API the Brain can call.

**The pull model** (Steps 5–8) authenticates a worker over `/mcp`, hands it a
work item under a fenced lease, and takes back a result. Fourteen tools: nine
reads and five queue operations. **None of them wrote anything a researcher
produces** — not a claim, not a source, not a contradiction, not a checkpoint,
not a document. The scopes for all of it were declared in Step 4 and gated
nothing.

So a worker could read the Brain and operate the queue, and what it learned went
into a chat log.

## The shape

```
  a person writes an assignment
        │
        ▼
  RESEARCH_PLAN ──────► worker proposes bounded fragments  ─┐
        │                                                    │ stored PLANNED
        ▼                                                    │ nothing spent
  ══ a person approves ══════════════════════════════════════╡
        │
        ▼
  RESEARCH_FRAGMENT ──► worker researches one question ──► claims stored UNACCEPTED
        │
        ▼
  RESEARCH_VERIFY ────► worker answers, per claim: does the source support it,
        │               does its scope match ──► applyGate decides
        ▼
  RESEARCH_SYNTHESIZE ► worker writes the report ──► citations checked,
        │                                            document filed with a ledger
        ▼
  RESEARCH_AUDIT ×3 ──► primary, adversarial, judge ──► recordAudit ──► COMPLETE
```

Between the assignment and the approval, nothing costs anything. After it,
each fragment costs a little of the connected account's allowance.

## The five rules

### 1. A work item names what to research, never what to say

A research item carries no payload. The orchestration and the fragment are
**columns** on `work_items`, and everything about the assignment is read from
the fragment row through a scoped tool.

The rejected alternative was a work type whose payload is a prompt, with the
existing orchestrator on the other end and the worker standing in for an
`AIProvider`. It would have reused far more code. It is exactly what
`services/queue/workTypes.ts` forbids in its own header: an enqueue permission
plus a prompt-carrying type adds up to *make this borrowed account say anything
I want*. That the enqueuer is currently a human does not save it — Step 12 moves
enqueueing to the Brain, and the rule is about the type.

There is one place a prompt does reach the model, and it is composed by the
Brain rather than sent by a caller: the audit brief
(`services/research/auditBrief.ts`), built at read time by `buildPrimaryPrompt`
and its siblings from the audit profile, the layer criteria and the extracted
document. **No field anywhere — work item, payload, tool argument — can put
words into it.** The human-written assignment appears inside it as quoted
material in a Brain-authored frame, in the same position the document's own text
does; and the document was written by a worker, so untrusted content was always
going to be in there. §11's rule covers it: imported text is data, and nothing
found inside it may move project state.

### 2. A worker submits; the Brain decides

No tool writes an accepted claim. `brain_submit_claims` stores everything with
`accepted = 0`, and `applyGate` decides — in `services/research/submission.ts`,
which is the **same function** `orchestrator.ts` calls. There is no branch in it
for "this came from a worker."

That was the point of extracting it. The remote path cannot be looser than the
local one because it is not a different path. The same is true of filing
(`filing.ts`, shared with the orchestrator) and of recording an audit
(`recordAuditPasses`, extracted from `runDynamicAudit`).

Two of the gate's seven conditions are judgements only a reader of the source
can make — does it support the claim, does the scope line up. Those arrive as
answers, per claim. Brain's part is to insist the answer exists, is structured,
and is applied without exception; never to infer it. A verification that leaves
any of the fragment's claims unanswered is refused, because choosing which of
your own claims get examined is not a choice a worker should have.

### 3. The loop is a function of rows

`services/research/packetRunner.ts` replaces the in-process loop. Given an
orchestration it decides what work should exist right now and makes that true.

Nothing is remembered between calls. The next step is derived from the
orchestration's status, its fragments' statuses and dependencies, its claims'
acceptance and its passes — all of which are already in the database because
§12 requires each of them to be written down as it happens.

It runs after every research item reaches a terminal state, and again at boot,
and calling it twice creates nothing the first call already created. Crash
recovery is therefore not a special path: **resuming and continuing are the same
operation.** What that actually repairs is narrow and real — a shutdown between
a worker's completion and the enqueue that should have followed it.

Dependencies are respected: a fragment whose dependency is not yet ACCEPTED is
not queued. A dependency that ended without being accepted never will be, so a
fragment waiting on it is never started — deliberately. Starting it anyway would
produce an answer resting on a definition nobody established.

**Waiting is a state until nothing else can move; then it is a result.** Once
every unfinished fragment in the packet is waiting on something that is not
coming, each of them is resolved to `BLOCKED`, carrying the dependency it was
waiting on and what became of it. `BLOCKED` rather than `CANCELLED`, because
`retryFragment` accepts only a BLOCKED fragment: this is the status that keeps
the remedy — repair the dependency, then retry what was waiting on it — actually
available to a person.

That is not a decision about scope, so it happens whether or not the packet is
authorized to record gaps. What the authorization decides is what comes next:
whether the requirements those fragments leave open are declared as unresolved
gaps, or whether the packet stops at NEEDS_HUMAN over them.

Leaving them QUEUED, which is what the runner used to do, was the failure it was
trying to avoid. Nothing would ever offer them to a worker, nothing would ever
retry them, and every later advance recomputed the same doom and reported the
same count. The live Step 9 packet spent a day in exactly that state.

### 3b. What a packet does not answer is recorded, if a person authorized it

The condition is one thing: **the fragment is BLOCKED and this path cannot make
it researchable again.** On the pull path that is every BLOCKED fragment, for a
structural reason — §15 requires a repair to search differently from every
attempt before it, `repair.ts` chooses that strategy, and it is wired only to
the in-process path. The runner therefore cannot mint a second attempt at any
attempt count, and one it did mint would re-run a lane the last attempt already
exhausted.

The reason is still recorded per fragment, because these are different facts
about the packet even when they have the same consequence:

- `REPAIRS_EXHAUSTED` — it used its repair budget.
- `DEPENDENCY_UNMET` — a prerequisite of it ended without being accepted.
- `STRANDED_A_DEPENDENT` — it is the prerequisite that did that to another.
- `NO_PLANNABLE_REPAIR` — its evidence failed the gate and no further attempt
  exists that this packet can plan.

A prerequisite is written off together with what it stranded: a packet cannot
declare the penalty question out of scope while holding the trigger question
open, when the only reason the penalty is unanswerable is that the trigger is.

**What keeps this narrow is not the attempt count.** It is the guard on the pass
— nothing live, nothing awaiting approval, and nothing startable — because
research that has not been attempted may yet answer the requirement a blocked
fragment failed on. And before any of it, a person having authorized this
packet. The authorization is per packet and carries who made it and when
(`unresolved_gap_policy`, `..._authorized_by`, `..._authorized_at`; see
`services/research/gapPolicy.ts`). Without it the packet stops at NEEDS_HUMAN and
stays there, however often the runner is called — a Brain that could always
declare its way to "complete" is what invariant 20 exists to prevent.

Nothing about the gate changes either way. The claims, the verdicts and the
rejection reasons stay exactly as they are; what is narrowed is what the packet
claims to answer, and the report carries the gaps inside it.

### 4. Approval is a decision, not a transition

`advancePacket` refuses to queue a `PLANNED` fragment. Approval is
`approvePlan`, a separate entry point a person calls, and the console shows the
whole plan rather than a count of it — every question with its geography,
timeframe, evidence lanes and independent-source minimum, because those are
precisely what the allowance will be spent on.

§16 requires this and the runner is where it would be most easily lost: one line
moving fragments from PLANNED to QUEUED and the allowance is spent on a
decomposition nobody had seen.

### 4b. A proposal is checked against the archive before it is research

`startPacket` is the entry point — one function, callable by the console, a
scheduler or the Brain's own decider, taking the approval policy as an argument
instead of assuming one. It creates the run and the orchestration, queues one
planning job, and stops. Before it creates anything it reads the archive
(`inventoryProject`), because a caller that cannot see what the project already
holds cannot honour §13's default of *not* researching.

The decision that follows from that reading is per requirement, and it needs
the goal decomposed first — so it happens where the decomposition arrives. When
a worker calls `brain_propose_fragments`, `services/research/coverageGate.ts`
turns each proposed fragment into a requirement, runs
`services/reconcile/` over it, and creates fragments only for the ones the
archive cannot answer. Nothing here judges coverage itself: the decider is the
same one the in-process orchestrator has always used, and a second
implementation would be a second answer to the same question.

Three consequences worth stating:

- A fragment the archive answers is **not created**. Its requirement and its
  coverage row are, with the claim ids the decision rests on, so "we did not
  research this" resolves to evidence rather than to a silence.
- A fragment that survives carries `existingClaimIds` and
  `whyExistingInsufficient` — what it is adding to, and why the archive was not
  enough. That is the difference between new evidence and a second copy of the
  old evidence.
- If the archive answers **everything**, the packet ends `CANCELLED` with that
  as its reason. It must not fall through to "no fragment cleared its evidence
  gate", which is the same terminal state describing the opposite outcome.

Without a boundary contract the staleness and geography checks abstain, and a
well-sourced claim from years ago can then reach SATISFIED — the one status
that stops research. The push path gets its contract from the planning pass; on
this path it is assembled from the scope the proposed fragments themselves
declare, and only from what they agree on. §12 already says those declarations
are what the gate is applied against, so they are also what a decision about
whether the fragment is needed is applied against.

### 5. A redelivery is not a second ledger

Every research work type is `IDEMPOTENT` rather than `HARMLESS`, and the
registry now says which. Doing an echo twice changes nothing; recording a claim
ledger twice is *prevented*, by a Step 6 operation keyed from the work item and
the operation name — never from the lease, the attempt, the generation, the
credential or the clock.

One work item records one ledger, for good. A second attempt on the same item
replays. Work that genuinely needs redoing gets a **new fragment row and a new
work item**, which is §15: a retry is not a repair.

A type that declares `IDEMPOTENT` without naming the namespace that provides it
is refused at registration, because that is the mistake you make while adding a
type and find out about months later.

## Checkpoints

The queue is at-least-once, so a lease can expire in the middle of an hour of
research and the item goes to an attempt that knows nothing about what the first
one found. Step 6 stops the *effect* repeating; nothing stopped the *thinking*
being thrown away.

`work_item_checkpoints` is that: short, bounded, append-only notes, each
identified by the lease generation that wrote it. The next claimant reads them
with the assignment.

The ownership proof is **inside the `INSERT`** — an `INSERT ... SELECT` whose
source row is the work item under the full `OWNED` guard — so a worker whose
lease is gone cannot append to the record of the attempt that replaced it.
Reading first and inserting second would leave exactly the window this queue is
built not to have.

What must never go in one: a credential, an authorization header, an
uncontrolled external response, or the contents of a private source. It is a
place for "checked the register, nothing under the 2019 name" — not the page it
read.

## The tool surface

Ten new tools, taking the permanent surface to twenty-four. Each is a thin
wrapper over a service that already existed, and each names a scope that already
existed.

| Tool | Scope |
|---|---|
| `brain_get_assignment` | `research:read` |
| `brain_checkpoint_work` | `checkpoints:write` |
| `brain_propose_fragments` | `research:propose` |
| `brain_submit_claims` | `claims:write` |
| `brain_submit_verification` | `research:write` |
| `brain_report_contradiction` | `contradictions:write` |
| `brain_report_blocker` | `blockers:report` |
| `brain_submit_synthesis` | `research:write` |
| `brain_get_audit_brief` | `research:read` |
| `brain_submit_audit` | `research:write` |

After Step 9 every scope in `WORKER_SCOPES` gates something that exists.

The list stays permanent and identical for every caller. Which tools a caller
may *succeed* with is decided at execution time by
`services/identity/policy.ts` — the same module every HTTP route uses. There is
no MCP policy module and there must never be one.

## Test packets

A packet costs a real account's allowance, and until somebody has watched one go
through there is no way to know whether it is worth spending. That is a bad
order to do things in: the first packet is both the thing being tested and the
thing being paid for.

So `services/research/fixtures.ts` builds a packet whose research is written
into this repository. It runs everything the Brain does by itself — plan,
approval, all seven gate conditions, acceptance and rejection, dependency
ordering, synthesis, citation resolution, the filed artifact and its ledger —
and touches no allowance.

**It is not a way around the placeholder rule.** `routes/research.ts` refuses to
run staged research against a provider that returns placeholder content, because
that "would produce a report with invented citations". A fixture is different in
the way that matters: **nothing invents anything.** Every claim is a statement
somebody wrote down, with a stable primary source, chosen so a reader can check
it in under a minute — the specifications this Brain's own remote boundary rests
on, not anything commercial. A fixture that read like real research is a fixture
somebody would eventually cite.

Three things stop it ever being mistaken for research:

- **Its own project.** It cannot reach a layer that holds work anybody depends
  on.
- **`research_orchestrations.fixture`**, a column rather than a naming
  convention, so every query that needs to ask can — and so a fixture cannot
  become evidence by being forgotten about.
- **The document says so in its first line**, before anything readable as a
  finding.

What is fixture is the *input*: the claims, and the two verification judgements
only a reader of a source can make. Everything downstream calls
`recordFragmentClaims`, `gateFragment` and `fileResearchPacket` — the same three
functions a worker's submission goes through. So what an operator watches a
fixture do is what the Brain does.

Three fragments, because there are three outcomes worth seeing: one that clears
the gate, one that clears it while losing an unsourced claim, and one that fails
because its only source is about a different revision than the fragment asked
about — a correct fact, correctly cited, answering a different question.

**It stops before the audit**, and that is the honest place. Everything earlier
is Brain code deciding things. The audit is a model reading a document and
forming a judgement, and there is no way to stand in for that half which does
not amount to writing a verdict into `audits` that nobody reached. §8 exists to
prevent exactly that and has no exception for convenience. Watching the audit
run needs a worker, which is the one part that costs something.

## What Step 9 does not do

- **No schedules.** Every packet is started by a person clicking a button.
  Step 10.
- **No second worker**, and one consequence is worth stating rather than letting
  three audit rows imply otherwise: the primary auditor, the adversarial critic
  and the judge are three passes on the **same account**. That is weaker than
  three independent readers. Step 11.
- **No automatic repair.** A packet where nothing cleared the gate stops at
  `NEEDS_HUMAN` with the reason. §15 — a repair is planned, and planning it is
  not this step's.
- **No Anthropic API key**, and no silent switch from subscription-backed Claude
  to metered API usage.
