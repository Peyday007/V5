# Research Intelligence

The faculty that decides **what to learn**. The engine beneath it — packets,
fragments, claims, the seven-condition gate, verification, three audit roles,
synthesis, a durable queue with leases and fencing — decides **how to run it**,
and is unchanged.

This document is the canonical source for the faculty: its scope, its boundary
with the rest of Brain, its data contracts, its invariants, what was built, and
what was deliberately not.

---

## 1. What was there before, and the exact gap

The production path, traced rather than remembered:

```
Russell conversation -> capture -> judgeCandidate -> compiler.ts (one fragment per idea)
  -> launch() -> startPacket() -> placePlan() -> coverProposal()
  -> advancePacket -> approval (envelope or person) -> RESEARCH_FRAGMENT items
  -> worker -> brain_submit_claims -> RESEARCH_VERIFY -> applyGate -> ACCEPTED | BLOCKED
  -> mintRepairs (repair.ts ladder)
  -> assessPacket (mandatory coverage) -> RESEARCH_SYNTHESIZE -> filing
  -> RESEARCH_AUDIT x3 -> outcomeFor -> COMPLETE | COMPLETE_WITH_GAPS | NEEDS_HUMAN
```

`brain_propose_fragments` is the second planning entrance, for admin-started
packets, through the same `coverProposal` seam.

**`orchestrator.ts` is not on this path.** It is the in-process push loop and it
needs an `AIProvider`; the deployed Brain has no `ANTHROPIC_API_KEY` and no
`BRAIN_PROVIDER` (`CLAUDE.md` §24), so anything wired only to it is unreachable
in production. That fact is what turned three of the gaps below from "weak" into
"absent".

Eight gaps, each read off the code:

1. **No problem model.** `boundary_contracts` has `decision_supported`,
   `prohibited_assumptions`, `ambiguities` and `acceptable_uncertainty` — and
   `contractFromProposal` fills five of eighteen columns. Nothing anywhere
   distinguished an example from a boundary, a preference from a constraint, or
   recorded stakes, non-goals or what would make the work useless. Not versioned.
2. **No uncertainty representation.** The fragment was the unit. `why_it_matters`
   is prose, and on the compiled path it is a *constant string*.
3. **The plan was frozen at approval.** After approval the only new fragments
   were repairs of the same question. `replan.planContradictionFragments` and
   `packet.planCoverageFragments` existed, were tested, and had exactly one
   caller each: `orchestrator.ts`.
4. **A contradiction was recorded and nothing happened.**
   `brain_report_contradiction` classified it and marked the claim. No work. And
   `packetRunner` read only `MANDATORY_COVERAGE_CHECK` out of `assessPacket`, so
   the counterargument check was computed and discarded on every packet this
   Brain has ever run.
5. **Depth was a constant** — `envelope.minIndependentSourcesFloor`.
6. **No sufficiency judgement.** Stopping was "every fragment terminal" plus the
   judge's verdict, which is a statement about the queue rather than the answer.
7. **No retrospective and no campaign metrics.**
8. **Person-only escalation was a sentence on `failure_reason`**, not a question
   with a named remedy.

Four things were already right and were reused rather than rebuilt: accepted
claims outliving an incomplete fragment (`citableClaims`), retrieval failure not
being rejection (`retrieval_state`), conditional dependencies continuing
(`readyToResearch`), and shared-finding reuse with project privacy (§31).

---

## 2. Scope

**Research Intelligence owns:** research-objective interpretation inside a
campaign, problem framing, the decision-relevant uncertainty graph, research
strategy, fragment creation and revision *within an approved packet*, depth
allocation, contradiction handling, adaptive repair, sufficiency and stopping
judgements, retrospectives, and proposals to change the plan.

**It does not own:** Brain's global executive, universal intent understanding,
final authority over irreversible or external actions, simulation and modelling,
world monitoring, software-factory planning, or permission, budget, privacy and
external-action enforcement. Those are `services/identity/policy.ts`,
`approvalEnvelope.ts`, `services/russell/authority.ts`,
`services/cash/authority.ts` and `services/factory/` — untouched.

**Simulation and Modelling Intelligence is deliberately deferred.** The interface
it would use already exists and is not built against: an uncertainty may be
opened with `origin = 'PLAN' | 'FINDING' | …` and a `stopping_condition`, and an
experiment is a different kind of thing that settles one. Nothing in this faculty
assumes research is the only way to reduce an uncertainty.

---

## 3. Architecture

```
server/services/research/intelligence/
  model.ts         what Brain believes it was asked, versioned
  uncertainty.ts   the graph: seeding, typed links, ranking
  depth.ts         how hard to look, per question (pure)
  director.ts      what should change about the plan (pure)
  apply.ts         the deterministic enforcement, and the one wiring point
  sufficiency.ts   whether the answer is ready for its consumer (pure)
  proposals.ts     zero-trust validation of a worker's judgement
  retrospective.ts what the campaign taught, from rows
  view.ts          the read-only projection
server/repos/researchIntelligence.ts   five tables, every write guarded
```

**The director is pure and that is not the safety mechanism.** It is pure so a
decision can be explained from a recorded snapshot — `services/dispatch/router.ts`
makes the same argument — and being pure makes it *useless* as a control.
`apply.ts` is where a decision meets a row it does not own, and every one is
applied through a guard the decision cannot supply.

### The one wiring point

`packetRunner.advanceOnce` calls `directResearch` once, **after `mintRepairs`**
and before anything is queued. The ordering is load-bearing: `mintRepairs` is
§15's ladder — a *different search for the same question* — and it recurses when
it creates one, so by the time the director runs, every question that could be
tried again already has an attempt.

`mayCreateWork` is that pass's own quiescence test (nothing `QUEUED` or
`LEASED`), the same one `mintRepairs` uses. Bookkeeping runs on every advance;
opening a new question waits for an empty queue, because the result a worker is
holding may be what makes it unnecessary.

`packetRunner` also calls `assessSufficiency` immediately before enqueueing the
synthesis, and refuses on exactly two readings — see §6.

`services/russell/loop.ts` calls `reconcileRetrospectives` on the durable tick.

---

## 4. Data contracts

Migration `076_research_intelligence.sql` (SQLite) and
`067_research_intelligence.sql` (Postgres). Additive only; nothing existing is
altered, backfilled or rewritten.

| Table | What it holds | Idempotent by |
|---|---|---|
| `research_problem_models` | the versioned interpretation | `(orchestration_id, version)` |
| `research_uncertainties` | one decision-relevant unknown | `(orchestration_id, uncertainty_key)` |
| `research_uncertainty_links` | typed relationships | `(orchestration_id, from, to, kind)` |
| `research_plan_revisions` | what changed the plan, and why | `(orchestration_id, version)` |
| `research_retrospectives` | lessons at their true abstraction | `(orchestration_id, lesson_key)` |

None restates scope the boundary contract owns, evidence the claim rows own, or
ordering `research_fragments.depends_on` owns — `shared_findings`' rule about
copies, at a new boundary.

### The problem model

Not a second boundary contract. The contract says what the research is *bounded
by*; this says what it is *for*, and separates the four things a single
"constraints" list collapses:

- **CONSTRAINT** binds, and carries `reason` so Brain can later ask whether the
  reason still applies. A constraint with no reason can only be obeyed for ever.
- **PREFERENCE** is how somebody would like it, all else equal.
- **EXAMPLE** carries `property` — *what it was an example of*. `readExamples`
  returns the properties, which is what search may generalise over. An example
  with no stated property is returned verbatim and is never turned into one by
  guessing, because inferring intent from wording is the Westbrook defect (§25).
- **ASSUMPTION** is something nobody checked.

Versioned, append-only. A revision may never widen `authority_granted` — there
is no field on `reviseProblemModel` that could.

### The uncertainty

A fragment is an execution container; an uncertainty is the *reason* the question
is worth asking. They diverge the moment evidence arrives, because two things can
only be said about the second: a fragment can succeed and leave its uncertainty
open, and a finding can **retire** an uncertainty — still open, no longer bearing
on the decision — which cancels the fragments behind it as a consequence rather
than as a judgement about their evidence.

`invalidating` is read from `depends_on`: something the plan itself declared a
`HARD` dependency on is, by the plan's own statement, a question the rest cannot
be phrased without.

### The link kinds, and why they are not the dependency kinds

`research_fragments.depends_on` (`HARD | CONDITIONAL | SEQUENCING`) is about
*execution order*. These are about *reasoning*, and the difference decides what a
failure costs:

| Kind | A failure upstream |
|---|---|
| `HARD_PREREQUISITE` | strands the dependent — retired |
| `CONDITIONAL` | leaves the antecedent unknown — retired |
| `EVIDENTIARY` | costs nothing — untouched |
| `COMPARATIVE` | makes the sibling **more** decisive — depth raised |
| `FOLLOW_UP` | provenance: this exists because of that |
| `CHALLENGES` | this exists to attack that |

`SEQUENCING` maps to `EVIDENTIARY` rather than being dropped. Flattening these is
how a campaign cancels work it should have continued (required scenario 5).

---

## 5. The research loop

1. `ensureProblemModel` — the reading, from rows, marked as derived.
2. `seedUncertainties` — one question per planned fragment, the graph from
   declared dependencies, depth from consequence and reversibility.
3. `direct(snapshot)` — the decisions, in a fixed order:
   1. what the evidence settled (`RESOLVE_UNCERTAINTY`) and what it did not
      (`MARK_UNRESOLVABLE`), with `MARK_ACCESS_BLOCKED` kept separate;
   2. branches that stopped mattering (`RETIRE_BRANCH`), and comparatives that
      became more decisive (`RAISE_DEPTH`);
   3. disagreements nobody has attacked (`OPEN_CHALLENGE`);
   4. questions a proposal opened that nothing is researching
      (`OPEN_FOLLOW_UP_WORK`);
   5. the ordered agenda (`INVESTIGATE_NEXT`) — advice only.
4. `apply.ts` validates each against live rows and writes what survives.
5. `assessSufficiency` — the reading, recorded on the revision.
6. On a terminal packet, `recordRetrospective` on the tick.

### Ranking, without a score

`rank` is lexicographic over observable facts, in a fixed order — invalidating,
consequence, blocking dependents counted from the link table, how unresolved,
creation order. A weighted score needs weights nobody calibrated and produces a
number that reads like a measurement. `cashPortfolio`'s ordering makes the same
argument.

`uncertainty_level` starts at 100, so a question nobody has looked at outranks a
partly-answered one: an unknown never ranks something *lower* (invariant 39).

### Depth

`allocateDepth` is a cascade, not a score, so its `basis` names a real input.
Three rungs: `SINGLE_PRIMARY`, `CORROBORATED`, `CONTESTED_DEEP`.

**It can raise a bar and can never lower one.** `SINGLE_PRIMARY` is reachable
only for a claim type §14 already says one primary source settles, only when the
plan stated the expected claim types, and only when little rides on it;
`floorFor` is taken as a `Math.max` with the fragment's own declared minimum. A
depth allocator that could reduce an evidence requirement would be a budget
wearing an evidence bar's clothes, which §16 forbids.

---

## 6. Sufficiency and stopping

`assessSufficiency` answers the question between the gate and the audit: *is what
we have enough for the decision this packet exists to support?* Eight verdicts —
`ANSWERED`, `USABLE_WITH_GAPS`, `KEEP_RESEARCHING`, `INSUFFICIENT_EVIDENCE`,
`BLOCKED_BY_ACCESS`, `CONTRADICTION_OPEN`, `NEEDS_PERSON`,
`NOT_WORTH_CONTINUING` — kept as their own vocabulary because *is the answer
usable* and *is the workflow over* genuinely differ.

`readiness` is decisive-uncertainty coverage with a named denominator, and
`null` when there is nothing to measure. Never a fraction over fragments: §29's
whole lesson is that "0 of 8 settled" was accurate and read as failure.

**`mayProceedToSynthesis` only ever refuses**, on two readings —
`CONTRADICTION_OPEN` and `NEEDS_PERSON`. Both are conditions an audit cannot
repair after the fact, because by then the report has already chosen. Everything
else returns ok, so nothing here can advance a packet the mandatory-coverage
check would have refused.

**There is deliberately no pass that opens a question for a mandatory requirement
nothing planned for.** `assessPacket` asks that at the synthesis boundary and
answers it by stopping for a person, and `advanceOnce` gives the reason: on this
path spending the allowance is a person's decision. What this faculty adds is the
*reading* — covered mandatory requirements against the total — not an override.

---

## 7. The worker boundary

A worker submits evidence; Brain decides what it means. Two things are genuinely
semantic and no row can answer them — what a finding *means*, and which new
question it raises — so `brain_propose_plan_revision` (scope `research:propose`)
carries those, and `proposals.ts` is the wall:

- An **unknown field refuses the whole proposal**, not the field. A partially
  applied proposal is a plan with a hole in it.
- The action is **matched exactly** against a closed set. No substring, no
  closest match — `services/audit/schema.ts`'s rule.
- Every key is **re-resolved inside this packet**. Nothing can reach another
  orchestration or project.
- The approval envelope, the evidence bar, the independent-source minimum, the
  coverage decision and the audit verdict are **not reachable**, by absence of an
  import.
- A refusal is a **result**, not a transport error (§21).

A new question does not become research here. It becomes a question; the next
advance decides whether it becomes a fragment, which lands `PLANNED` and goes
through **the packet's own approval** — the envelope or the person. Letting one
submission be both the finding and the plan would make the worker the planner.

`MAX_DIRECTED_FRAGMENTS` (12) bounds how far one packet's plan may grow. Not a
budget: a bound on a loop, because adaptive planning that creates work from
findings can create work from the findings of the work it created. Reaching it is
reported, never silent.

### Person-only

`PERSON_ONLY_KINDS` is closed, and every member is something no research
produces: a preference only they hold, a consent, a judgement that is theirs, an
irreversible decision, a secret, a credential, or an authorization to spend,
contact or publish. Anything else is refused **by name**, saying the question is
Brain's to answer — a price, a contact channel, a legal requirement, an
integration and a competitor are all research. §30 had to correct exactly this
once.

An accepted escalation must state one explicit question, what the answer
authorizes, and exactly what is needed. "What did you do?" is refused: an
escalation with no answering transition is stuck rather than waiting (§24).

---

## 8. Invariants

1. Nothing in this faculty accepts or rejects a claim, moves a coverage status,
   lowers an independent-source minimum, advances an audit verdict or approves a
   plan.
2. Every disposition change is a compare-and-swap naming the state it came from.
   A late writer loses.
3. Every open is idempotent by a key the caller did not choose.
4. A directed fragment is created `PLANNED`, always.
5. Depth is only ever raised; the floor is a maximum with the plan's own.
6. An unreadable source never closes a question.
7. A retired question keeps its row and its reason. Nothing is deleted.
8. A campaign lesson is never offered back as guidance.
9. Reading any projection writes nothing.
10. An unknown is never a favourable assumption, and `readiness` is `null` rather
    than a flattering number when there is nothing to measure.

---

## 9. Privacy and knowledge promotion

Unchanged, and deliberately not extended. §31's `shared_findings` still decides
what crosses between projects, on the same six conditions, re-derived on every
read. Nothing in this faculty writes to it, reads it, or gives a reason to widen
it: an uncertainty, a problem model, a plan revision and a lesson are all
project-private, and the tables carry `project_id` so a query cannot reach past
one by accident.

`researchIntelligenceView` is served through `requireOrchestration`, the same
resolver every other research route uses, so a caller who may not have the packet
gets the same 404 a missing one gives.

---

## 10. Rollout

There is no shadow mode and no feature flag, and that is a decision rather than
an omission — §16's own sentence about a permanently shadow-only system. What
makes it safe to run live is that the faculty is **additive by construction**:

- A packet that existed before migration 067 has no uncertainties; the director
  seeds them on its next advance from its own fragments, and nothing about its
  state changes.
- `recordRetrospective` writes nothing for a packet with no uncertainties, so a
  campaign the faculty never saw gets no invented lesson.
- Deleting every row in the five tables returns Brain exactly to its previous
  behaviour, except for the two synthesis refusals — and with no uncertainties
  there is nothing for either to refuse on, so they are inert.
- `advancePacket` remains idempotent, so a restart mid-campaign resumes rather
  than reinterpreting.

**Active durable work was not disturbed.** No migration alters an existing table
and no code path cancels, resolves, reclassifies or re-enqueues an existing
packet.

**What the synthesis refusal actually does, stated precisely rather than
hopefully.** An earlier draft of this paragraph said it *"clears by itself when
the challenge work it is waiting for finishes"*. That is wrong about the only
state in which it fires. The branch is reached only when every fragment is
terminal — which means the director has already had its quiescent pass, so
either it opened the challenge, in which case that fragment is `PLANNED` and the
approval branch returns long before this line, or it refused to and recorded
why. Reaching the refusal therefore means nothing is going to create the work, so
it sets `NEEDS_HUMAN` with the reason: a person reissues, repairs or narrows.

Leaving it as a `RESEARCHING` packet with an empty queue was the first version
and is the absorbing state §27 is written against — a status nothing picks up and
nothing reports.

---

## 11. Evaluation fixtures

`tests/researchIntelligence.test.ts` — the decisions, run across three domains
(a commercial opportunity, an operational reliability question, a film-history
question) through `describe.each`, so a rule that needed the subject fails on two
of the three.

`tests/researchIntelligencePass.test.ts` — one campaign walked from `startPacket`
to the lesson, with only the outside world simulated: every submission goes
through the MCP tools under a lease, the runner is never called by hand to make a
step happen, and a restart happens mid-campaign.

It is **not** a live Cowork session — no Routine is fired, no provider is called,
no token is minted, nothing external is read — and it is the tool *layer* rather
than the MCP *transport*, the same two sentences `cashIntegrationPass` has to
say.

---

## 11a. One correction the measurements made to themselves

`fragmentsResearched` counted `research_fragments.started_at`, and the only
writer of that column is `orchestrator.ts` — the in-process push loop, which
cannot run in the deployed Brain (§24). So the metric was **structurally zero on
every real campaign**, and the first time it was measured it reported seven
fragments planned, six blocked, one accepted, and none researched.

It is read from the fragment's status now, which every path updates. Recorded
here rather than quietly fixed because it is this faculty's own opening lesson
arriving in its own metrics: reading the code said the number was implemented,
and reading the *writers* said it had never once been true.

## 12. What is not built

- **Simulation and modelling.** Interface deferred; see §2.
- **Outcome retrospectives.** `research_retrospectives.scope` has
  `OUTCOME_OBSERVED` and nothing writes it, because nothing in Brain yet observes
  whether a recommendation turned out to be right. The column exists so the later
  writer has somewhere honest to put it; an empty scope is not a guess.
- **Expected information value.** Nothing here forms a view about what settling a
  question is *worth*, for `judgment.ts`'s reason. Depth is decided from
  consequence, reversibility and observed conflict, which are facts.
- **A model-authored problem model at planning time.** The compiler is
  deterministic (§24) and the reading it produces is marked `CONTRACT` or
  `ASSIGNMENT`. A richer reading arrives as a validated `PROPOSAL`.
- **Cross-campaign learning applied automatically.** `reusableLessons` returns
  `DOMAIN` and `GENERAL` lessons for a reader. No code path lets one change a
  gate, a bar or a plan.
