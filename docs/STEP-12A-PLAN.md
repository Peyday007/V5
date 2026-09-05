# Step 12A — Brain Ignition: the frozen build

Russell is the user-facing name of this Brain. `Brain` stays the internal
architectural term, and stays in repository, database, service, protocol and
Legacy/Admin names where renaming would add risk without user value.

This document is the freeze. It records what was inspected, what is being
built, the state machines and their return edges, the acceptance matrix, the
authority matrix, and the one real Deal Dispatch idea acceptance will run —
frozen **before** its answer is known. `docs/STEP-12A-EVIDENCE.md` records what
was then proved, and distinguishes code proof from test proof from hosted proof
from production-row proof.

---

## 1. The loop this step turns on

> Natural conversation → grounded context → meaningful candidate → Russell's
> independent judgment → accepted-knowledge coverage check → bounded
> investigation or rejection → ranked mission → the existing packet/bin/fleet
> and quality pipeline → verified result → project and knowledge writeback →
> plain briefing → next authorized action.

Everything below exists to make one pass of that sentence real, and nothing
below exists for any other reason. The A/B test is the memory prompt's: if
removing it breaks the loop it is in A; if the loop still runs but is less
powerful, clear or pleasant, it is in `docs/STEP-12B-BACKLOG.md`.

**Thin does not mean fake.** The records, the authority, the state changes and
the loop are real even where the interface is minimal.

---

## 2. Pinned starting state — read, not assumed

Observed 2026-09-03, on branch `claude/zealous-hypatia-78a2yp`.

| Fact | Observed |
|---|---|
| Branch HEAD before this step | `7a6453d`, worktree clean, nothing unpushed |
| Parallel/unpushed work | none — no "label Routines" implementation exists locally or on the remote |
| Next migration numbers | SQLite **027**, Postgres **018** (026 / 017 are `_fleet`) |
| Client | React 18 + Vite 6. **No router, no query library, no UI kit, no frontend test harness** |
| `App.tsx` | 592 lines, one implicitly selected project, three panes; `styles.css` is 1850 lines |
| Live fleet | 4 accounts / 4 routines; `primary`/V1 fires=12, `friend-2`/V2 fires=6, both ENABLED, 0 refusals, 0 no-shows; two `verify-hosted-*` accounts structurally unroutable by design |
| Live Deal Dispatch | `prj_9d86dfaec863473cb498`, 8 layers; World Model AUDIT_READY v1; **Monetization Logic MORE_RESEARCH_REQUIRED v1C**; six layers NOT_STARTED |
| Live next best action | *Redo Monetization Logic v1D* |
| Step 11 status | L1–L8 PASS; L9/L10 blocked by provisioning (both accounts present one Brain worker identity), not by S19 |

Three production facts still to be read (`step12a-inspect.yml`, gated on the
`production` environment): the deployed commit, the configured provider secrets
by name, and the schema version and per-table baselines. They are recorded in
the evidence document when the run completes, and no mutation happens before
they are.

### Three defects confirmed in the seams, not assumed

1. **Capability routing is not wired end to end.** `bins.required_capabilities`
   and `bins.workload_class` exist in both migration chains (026 / 017).
   `requiredCapabilities` appears nowhere in `server/domain/types.ts`, the
   `createBin` path takes `workloadClass` but not `requiredCapabilities`, and
   `router.ts:102` reads it through
   `(bin as unknown as { requiredCapabilities?: string[] | null })`. A cast is
   not a mapping. Fixed in Phase 1 because A10 routes on it.
2. **`conversations.project_id` is `NOT NULL`.** Russell must be able to open a
   conversation before a project is chosen, so the existing table cannot be the
   Russell thread as it stands. Resolved in §4 without rewriting a single
   existing row.
3. **The intent layer is a regex.** `agent/chat.ts:121` `detectIntent` matches
   `/^(what|which|why|how|…)\b/`. It is a deterministic rule layer, useful, and
   not cognition. Russell's turn is model-backed and server-validated; the
   regex router stays behind Legacy.

---

## 3. The seams Russell reuses, and does not rebuild

| Seam | File | How Russell uses it |
|---|---|---|
| Authorization | `services/identity/policy.ts` `decideProjectAccess(principal, projectId, level, scope)` | Every Russell record is authorized through it. No second policy module. |
| Principal | `domain/types.ts` `Principal` | `credentialId` is the session dimension; `memberships` are read per request. |
| Packet creation | `services/research/startPacket.ts` | The only way Russell creates research. |
| Quality state machine | `services/research/packetRunner.ts` | Untouched. Russell schedules; this executes. |
| Coverage | `services/research/coverageGate.ts`, `services/reconcile/*` | `coverProposal` stays where it is; Russell adds a **pre-mission** coverage pass over the same classifier. |
| Bins / contracts | `repos/bins.ts`, `services/bins/service.ts` | The mission launcher creates the bin; workers drain it exactly as today. |
| Dispatch | `services/dispatch/loop.ts` (`DISPATCH_TICK_MS = 10_000`) | Unchanged. Russell's loop is a sibling, not a replacement. |
| Fleet | `repos/fleet.ts` | Read for health projection. Targets and policy stay operator-owned. |
| Audit independence | `services/research/auditEligibility.ts` | The signed matrix is untouched and stays immutable. |
| History | `repos/events.ts` `project_events` | Append-only; Russell's briefing facts are rows here. |
| Boot | `server/index.ts` (recovery → `startDispatcher()` → listen) | Russell's loop starts beside the dispatcher, after recovery. |

`bin_events` writes intentionally swallow failures, so **bin-event projection is
never** Russell's authoritative knowledge, decision, briefing or completion
ledger. Committed state plus `project_events` is.

---

## 4. Canonical state (SQLite 027 / Postgres 018)

Additive only. No existing row is rewritten, no existing column is dropped, and
every table below carries its project and visibility scope from creation.

**`russell_conversations`** — the thread identity, not inferred from a title.
`project_id` is **nullable** (a person may begin without choosing one),
`owner_user_id`, `visibility` (`PRIVATE` | `SHARED`), attachment `confidence`
and `attachment_reason`, and `legacy_conversation_id` — a unique nullable link
to a pre-12A `conversations` row. A backfill creates one Russell thread per
existing conversation and **moves no messages**: legacy messages keep their ids,
authors, timestamps and scope where they are, and the read projection unions
them with `russell_messages` by `created_at`. One message, one home, no copy.

**`russell_conversation_context`** — append-only attachment history. A
correction inserts; it never updates the previous row. This is what makes a
later equivalent route able to learn (A03) without rewriting history.

**`russell_candidates`** — `CAPTURED → PROBING → PROMOTED → QUEUED → PARKED →
REJECTED → MERGED → DONE`. Carries scope, normalized fingerprint, source
message, `canonical_candidate_id` for a merge, Russell's `priority`
(`MUST_DO` | `BIG_MOVE` | `WORTH_DOING` | `EXPLORE` | `PARKED`), ordinal,
confidence, plain reason, structured judgment inputs, and override actor/reason/
superseded decision. Every `PARKED` has a resume edge; `MERGED` has a guarded
split that restores both identities and keeps the merge and its correction.

**`russell_probes`** — the bounded light probe. Candidate and project scope, one
narrow question, an allowlist of read-only destinations, `max_lookups`, a
server-clock `deadline_at`, a capacity reservation, an idempotency key, and an
outcome in `SUPPORTED | WEAKENED | DUPLICATE | UNKNOWN | REFUSED`. It cannot
create a packet, file a document, spend, contact anyone or mutate anything
external. **Server code enforces the envelope**; the model only chooses within it.

**`russell_goals`** — standing authority. Owner, project, allowed work classes,
scope, time window, capacity limits, explicit prohibitions, policy version.
Migrations create **no grant by default**. Only an authenticated human permitted
by §6 may create, widen or revoke one; Russell and workers may consume and may
never mint or expand.

**`russell_budget_reservations`** — atomic `GOAL_BUDGET` consumption, keyed
idempotently, settled or released, expiring on server time.

**`russell_missions`** — the user-facing work object, linked to candidate,
conversation, project, goal, reservation, priority decision, probe,
orchestration, bin, document, audit, knowledge writeback, next mission or
terminal reason, and human request. Projects into **Working now / Up next /
Exploring / Waiting / Finished**; packet, fragment, pass, bin, dispatch and
audit detail stay under *How it is being done*.

**`russell_knowledge`** — `CONCLUSION | ASSUMPTION | UNKNOWN | DECISION`, plus
durable gap and contradiction relations. Scope, provenance links to the accepted
claim/document/audit/conversation/decision, author type, created and
last-confirmed time, currentness, supersession history, and evidence-based
confidence. It **references** accepted rows; it does not copy the evidence
warehouse.

**`russell_human_requests`** — canonical Needs You. Exact authority needed, why
Russell cannot decide, allowed choices and consequences, affected records, who
may answer, status, answer actor/time/reason, and a **guarded resume transition
with an idempotency key**.

**`russell_cycle`** — the loop's durable generation/cursor, singleton lease,
retry classification, provider-pause state and emergency stop.

### Park and resume edges — every one of them

| Parked state | Answering transition | Guard |
|---|---|---|
| candidate `PARKED` | `PARKED → QUEUED` on override or new evidence | authorized human or replan; records superseded decision |
| candidate `MERGED` | guarded split restores both | keeps merge + correction + downstream links |
| probe bound reached | terminal `UNKNOWN`/`REFUSED`, informs priority | never silently becomes a packet |
| mission `WAITING` on budget | auto-resume when the stored condition clears | revalidated grant + version |
| mission `WAITING` on provider | auto-resume on window reset | dispatch cooldown, not a new mission |
| mission `NEEDS_HUMAN` | `russell_human_requests` answer → same mission resumes | CAS on request status + idempotency key |
| cycle paused | operator resume | audited policy row, previous value retained |

A state that says it is waiting for a person and cannot accept that person's
answer is a defect. Each row above is tested for its return edge (A14).

---

## 5. Acceptance matrix

Gate ids are stable. `step12a acceptance` reports each as `PASS` / `FAIL` /
`BLOCKED` / `NOT_RUN` from authoritative rows, scoped to the frozen identities,
and exits 0 only when every required gate is `PASS` against the current deployed
commit after the required restart.

| Gate | Condition | Code | Automated proof | Production proof |
|---|---|---|---|---|
| `A01_SHELL_IDENTITY` | default route is Russell; primary copy says Russell; Legacy and Admin reachable | client router + shell | frontend behaviour test | deployed default route |
| `A02_CONVERSATION_ROUTE` | high-confidence attachment to the correct authorized project | routing service | test | frozen conversation 6 |
| `A03_ROUTE_CORRECTION` | correction changes attachment, records history, informs a later equivalent route | context history | test | frozen conversation 3 |
| `A04_IRRELEVANT` | casual text creates no candidate or mission | judgment | test | frozen conversation 1 |
| `A05_DEDUPE` | deterministic and semantic duplicates converge on one canonical candidate; concurrent captures too; a mistaken merge splits | dedupe + split | test incl. concurrency | frozen conversation 5 |
| `A06_JUDGMENT_OVERRIDE` | Russell stores an explainable rejection; override creates a new decision without erasing the original | judgment | test | frozen conversation 4 |
| `A07_PROBE_BOUNDS` | probe cannot exceed lookups, steps, time or capacity, and cannot cause an external effect | probe service | inversion test | the real probe |
| `A08_COVERAGE` | accepted current evidence suppresses redundant research; `UNVERIFIED`/stale/contradicted does not | coverage pass | inversion test | frozen conversation 2 |
| `A09_AUTH_BUDGET` | budget is atomic, idempotent, server-timed, zero external spend | goal + reservation | concurrency test | the real mission |
| `A10_MISSION_PIPELINE` | one promotion → one mission, one orchestration, one correct bin, capabilities routed | launcher | crash-injection test | the real mission |
| `A11_INDEPENDENT_AUDIT` | PRIMARY, ADVERSARIAL and JUDGE in three distinct authenticated sessions; no session takes two roles on one packet; the judge runs last; the achieved tier reported truthfully and never rounded up; fake or predicted lineage refused | Step 11 + the adaptive separation correction | `tests/auditIndependence.test.ts`, `tests/adaptiveSeparation.test.ts`, `tests/independenceEvidence.test.ts` | the real mission |
| `A12_WRITEBACK` | knowledge, project, conversation, candidate, priority, briefing update exactly once | observer | replay + concurrent test | the real mission |
| `A13_AUTO_NEXT` | the frozen follow-on launches once without another prompt | cycle | test | frozen conversation 7 |
| `A14_HUMAN_RESUME` | a true boundary parks, appears in Needs You, resumes the same mission | human requests | idempotent-answer test | frozen conversation 8 |
| `A15_RECOVERY` | restart, provider refusal, worker death and takeover lose and duplicate nothing | cycle + existing fencing | crash injection | fault-scope run |
| `A16_DD_FRESHNESS` | Deal Dispatch state is `CURRENT`/`STALE`/`UNAVAILABLE` and never presents memory as live | adapter | test | deployed adapter |
| `A17_PRIVACY_AUTH` | private stays private through candidate/probe/mission/knowledge; IDOR reveals neither content nor existence; injection changes nothing | policy reuse | negative tests | fault-scope run |
| `A18_BASELINES` | Step 9/10/11 authoritative baselines unchanged but for authorized 12A rows | — | — | before/after read |
| `A19_DELIVERY` | typecheck, build, both suites, migrations from empty, hosted verify before **and after** a real restart | — | CI | deployment ledger |

**`A11` depends on no particular friend, account count or Routine count** — the
row above supersedes the earlier "different accounts" wording, and the change is
recorded as an explicit product-owner correction in `docs/STEP-12A-EVIDENCE.md`
§10 rather than as a silent weakening. One healthy Routine satisfies it through
three fresh activations. Account separation is a stronger optional assurance
tier that the allocator prefers when the fleet can supply it and that the report
never claims when it cannot. The control itself is not weakened, simulated or
substituted: the same-session refusal is exercised live by the evaluator, and
changing the separation minimum in either direction makes the gate report
`BLOCKED`.

---

## 6. Role, action and authority

| Action | OWNER | ADMIN | MEMBER | VIEWER | Worker | Russell system actor | Anonymous |
|---|---|---|---|---|---|---|---|
| Converse in an authorized project | ✓ | ✓ | ✓ | — | — | — | — |
| Read authorized project state | ✓ | ✓ | ✓ | ✓ | ✓ (scoped) | ✓ | — |
| Create a candidate | ✓ | ✓ | ✓ | — | — | ✓ (from an authorized turn) | — |
| Override Russell's priority | ✓ | ✓ | ✓ | — | — | — | — |
| Create / widen / revoke standing authority | ✓ | ✓ | — | — | — | — | — |
| Consume standing authority | — | — | — | — | ✓ | ✓ | — |
| Launch a mission | ✓ | ✓ | ✓ | — | — | ✓ within a valid grant | — |
| Change operating target or budget | ✓ | ✓ | — | — | — | — | — |
| Answer a Needs You request | ✓ | ✓ | ✓ if named | — | — | — | — |
| Promote private content to shared | owner of the content only | — | — | — | — | — | — |
| Enqueue work / mint credentials | ✓ (console) | ✓ | — | — | **never** | **never** | — |

A worker cannot invoke a human-only action, and a user override may change
Russell's recommendation but can never bypass project access, privacy, budget,
audit independence, a completion contract, or an external-effect prohibition.

Privacy inheritance is **most-restrictive-source-wins**. Every derived
fingerprint, candidate, probe, mission, summary, count and cache inherits the
most restrictive contributing scope, and promotion to shared knowledge needs a
separate source-bound, purpose-bound, audience-bound human authorization.

---

## 7. The frozen acceptance run

### The real idea, frozen before its answer is known

The live planner's own next best action is *Redo Monetization Logic v1D*, and
`Monetization Logic v1` states in its own filed text that the packet
"can conclude only that a New York-based, business-only, no-real-property
success-fee deal does not require a real estate broker licence… California,
Texas, Florida and Illinois remain open questions", with the Florida and
California sections short of **2026-currency evidence**. v1C then settled
Michigan. So the gap is real, live, and one state wide.

> **Question.** Under Florida law as in force in 2026, must a success-fee
> intermediary who arranges the sale of a privately held business hold a real
> estate broker licence when the transaction transfers no interest in real
> property and no lease?

**Why a light probe is genuinely justified here** — and it is, rather than being
staged so a probe has something to do: v1 already quotes Fla. Stat.
§475.01(1)(a) bringing "business enterprises or business opportunities" inside
the definition of *broker*, and did **not** accept the claim, because it could
not establish the text was current. The uncertainty is therefore about source
currency and reachability, not about substance — exactly what a cheap bounded
lookup settles, and exactly the Step 10 lesson that a publisher refusing
automation is a different fact from an unresolved question.

| Probe bound | Value |
|---|---|
| Question | Is the current official 2026 text of Fla. Stat. §475.01(1)(a) retrievable, and does it still contain "business enterprises or business opportunities"? |
| Destinations | fixed allowlist, official Florida statutory publishers only |
| Max lookups | **3** |
| Deadline | **5 minutes**, server clock |
| Effects permitted | none — read only |
| Outcomes | `SUPPORTED` \| `WEAKENED` \| `DUPLICATE` \| `UNKNOWN` \| `REFUSED` |

**Success criterion for the mission** the probe may promote: one accepted claim
carrying a canonical statutory URL, the exact section, and the relied-upon
passage, dated to the 2026 edition. A truthful terminal-with-gaps outcome is
reported as that, never relabelled COMPLETE.

**Frozen next eligible follow-on**, to prove Russell continues without another
prompt: the same question for **California** (Cal. Bus. & Prof. Code §10131 and
the business-opportunity definition), named open by the same document, covered
by the same standing authority.

### Hard bounds, frozen before any result

One primary mission · exactly one research fragment · at most one repair cycle ·
one concurrent mission · at most **two** packet/bin creations total (primary plus
follow-on). The follow-on proof ends the moment its exactly-once launch is
observed — it is not waited on, and no third item is launched.

### The eight frozen conversations

1. Casual, irrelevant → no candidate, no mission.
2. A question Deal Dispatch already answers (New York licensing) → answered from
   accepted knowledge, **no** redundant research.
3. A plausible automatic attachment, corrected through the ordinary interface →
   a later equivalent conversation uses the correction.
4. A premature build request → Russell rejects or parks it with an
   evidence-based reason, and exposes the override.
5. Two differently worded messages about the Florida gap → one canonical
   candidate.
6. The real Florida idea → probe → coverage → mission → pipeline → writeback.
7. After the result → the California follow-on launches with no second prompt.
8. An out-of-envelope action → parks in Needs You, resumes on an authorized
   answer.

---

## 8. Deployment ledger

At most **three** production delivery mutations. A promotion or an out-of-band
schema/secret/infrastructure change counts; ordinary operations through the
product contract do not; a failed local or CI check before promotion does not; a
failed or rolled-back promotion does.

| # | Intent | Status |
|---|---|---|
| 1 | Integrated foundation: schema, canonical services, Russell loop, API, shell — **plus the correct undeployed Step 11 fixes from `7a6453d`**, which are folded in here rather than spending a mutation to move a branch pointer | not yet spent |
| 2 | Acceptance correction — only defects the frozen acceptance finds that block safety, integrity or truthfulness | not yet spent |
| 3 | Final verification, only if the correction batch requires it | not yet spent |

A released image is not a passing deploy. Hosted verification must pass before
and after a real restart.

### The external dependency

**There is no longer an external identity dependency in the acceptance
contract.** `A11_INDEPENDENT_AUDIT` is satisfied by three distinct
authenticated sessions, which one healthy Routine supplies by being activated
three times. A second Claude account presenting its own Brain worker identity
raises the achieved tier from `SESSION_SEPARATED` toward `ACCOUNT_SEPARATED`,
which is worth having and is not a completion requirement.

What remains external is capacity: if **no** Routine checks in, the blocker is
`NO_HEALTHY_EXECUTION_SURFACE` — an operational fact naming an operational
remedy, never a missing person. It is inspected once, not polled beyond ten
minutes, everything else stays stored and resumable, and the matrix is not
weakened, simulated or substituted.

---

## 9. Where this invocation stopped, and how to resume

Phase 0 is frozen, Phase 1 is complete, and Phase 2 is the server half of the
loop. Nothing here is deployed: the running image is v98, and the first delivery
mutation has not been spent.

### Built and proved

| | Proof |
|---|---|
| Schema 027 / 018, thirteen tables | applies from empty on both backends |
| `russellConversations`, `russellCandidates`, `russellAuthority`, `russellProbes`, `russellMissions`, `russellCycle` | `tests/russellState.test.ts`, 46 tests, both backends |
| `routing`, `judgment`, `coverage`, `launch`, `writeback`, `loop` | `tests/russellNervousSystem.test.ts`, 33 tests |
| The capability field, end to end | `tests/fleet.test.ts`, through storage |
| Russell's loop starting with the server | wired in `server/index.ts` beside the dispatcher |
| Launch selection inside the tick | one mission per cycle, the rest preserved; only candidates carrying a complete mission specification are eligible |
| `services/russell/dealDispatch.ts` | the read-only connected system, `CURRENT` / `STALE` / `UNAVAILABLE` |
| `services/russell/proposal.ts` | zero-trust validation of a model's structured reply |
| `scripts/upgrade-check.ts` | the migration over existing data, on both chains |
| `services/russell/projections.ts` | the briefing's data half: what changed, why, next, whether you are needed |

### Not built yet

- **The turn.** The model-backed conversation carried by the fleet: persist a
  pending turn, dispatch a bin for it, resolve exactly once. Both ends now
  exist — `russell_messages` has the pending contract, `resolveMessage` is the
  once-only edge, and `validateProposal` is the zero-trust check the reply must
  pass. What is missing is the dispatch between them.
- **The probe runner.** The envelope is enforced (`permitLookup`,
  `destinationAllowed`, `recordObservation`); what is missing is the caller that
  performs the three allowed lookups and calls `completeProbe`.
- **The filing → mission link.** `linkMission` takes a `documentId` and nothing
  calls it with one yet, so an accepted packet's filed document never reaches
  its mission. The loop handles that correctly — it reports the mission as
  awaiting its filing rather than spending the once-only writeback on a
  placeholder — but **it is a wait with no answering transition until the link
  exists**, which is the one shape this project refuses. It must be wired in the
  same batch as the turn, and until it is, an accepted mission's writeback is
  only reachable by a caller that supplies the conclusion itself.
- **The HTTP API and the whole Russell shell.** Phase 3 in full. The adapter
  and the projections the shell would render are built and tested; nothing
  renders them, and there is no route to reach them.
- **Every production gate.** No deploy, no acceptance run.

### Resume

```
npm run typecheck && npm test
BRAIN_TEST_DATABASE_URL=postgresql://… npm test
```

Then continue at Phase 2's remaining pieces in the order above — **the turn
first**, because the shell has nothing to render until a conversation can
answer, and because everything downstream of it already exists: routing decides
the project, judgment decides whether to capture, coverage decides whether to
research, the launcher creates the work and the loop finishes it. The turn is
the one seam between a person's sentence and that chain.

Its shape is already fixed by two things in the tree. `russell_messages` has the
pending contract — a turn that cannot be answered yet persists with its reason
and resolves exactly once through `resolveMessage` — and the inference decision
in the evidence document says what carries it: the fixed-subscription fleet, not
a paid API. So the turn writes a `PENDING` row, dispatches a bin for it, and the
worker's structured reply is validated against authority, scope, enums,
references and transitions before any of it is stored. The model never writes
state and never self-authorizes.

The frozen acceptance idea, its bounds and the follow-on are in §7 and
unchanged; `RUSSELL_STATE_LICENSING_V1` is the envelope both missions name.

---

## 10. The usability floor was raised — 2026-09-04

The v3 addendum moved three things from Step 12B into Step 12A, because a
system that runs but cannot show what it knows has not finished Brain
Ignition. This section records what that changed in the plan; the evidence for
each is in `docs/STEP-12A-EVIDENCE.md` §18.

### 10.1 The read layer is a completion condition

`Russell`, `Work`, `Ideas`, `Knows`, `Who` and `Needs You` may be thin. They
may not be **hollow** while authoritative data exists. Every one of them now
projects from authoritative rows rather than from the one table Russell had
started filling, and an empty surface names which of six kinds of empty it is —
with `FORBIDDEN` and `UNAVAILABLE` word-for-word identical, because the server
cannot distinguish them and the interface must not invent an answer.

New services: `work.ts`, `ideas.ts`, `who.ts`, `progress.ts`, beside the
existing `knows.ts`. New schema: migration **028**, `projects.purpose`.

### 10.2 Progress has one implementation

`services/russell/progress.ts`, used by the briefing, Work, Ideas, the map and
the build report. A fraction only over a declared closed set; a stage and a
milestone list otherwise; blocking outranks every band. There is no code path
that turns a feeling into a percentage, and there is now only one place such a
path could be added.

### 10.3 A basic living constellation is in Step 12A

Real React over the same projection the Ideas list renders, with site → major
idea → ordinary idea drill-down, a breadcrumb, an announced detail card, and no
demo node anywhere. Step 12B still owns richer animation, user-arranged
layouts, cross-site constellations, simulation and final mobile refinement.

### 10.4 Fast conversation is in Step 12A

Three lanes, a provider-independent streamed seam, a retrieval-based context
hat, an asynchronous teacher loop, and a spending boundary that refuses by
default. Migration **029**. Nothing is switched on: there is no key, no
authorization and no enabled model, so every turn still goes to the fleet.

### 10.5 What this does not change

The acceptance chain, the audit separation contract, the fleet, the queue and
the effect mechanism are all untouched. The three new gates —
`A20_USABLE_READ_SURFACES`, `A21_LIVING_PROJECT_MAP`, `A22_FAST_CHAT_ROUTING` —
are additions to the 19, giving a corrected baseline of **10 PASS · 0 FAIL ·
0 BLOCKED · 12 NOT_RUN**. The earlier 19-gate tally is history and is not
rewritten to pretend these existed.

### 10.6 A22 is deferred by the owner — 2026-09-05

Paid text-API activation is outside Step 12A by the owner's written decision of
2026-09-05. `A22_FAST_CHAT_ROUTING` reports **`DEFERRED`**: it keeps its row in
the twenty-two-gate table, it is excluded from the completion denominator, it is
**not** `PASS`, and it still reads the database — so it passes on its own
evidence the day a paid provider is activated, with no code change. The fast
lane stays built, tested and switched off, and the local safety checks around
the disabled code stay where they are. See `docs/STEP-12A-EVIDENCE.md` §28.

The immediate post-12A priority — a person-authenticated conversation connector
so the owner can talk to Opus inside Claude against authorized Brain context —
is recorded at the top of `docs/STEP-12B-BACKLOG.md`. Neither it nor paid API
activation is a completion dependency of anything.
