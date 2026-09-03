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
| `A11_INDEPENDENT_AUDIT` | PRIMARY/ADVERSARIAL on different accounts, JUDGE on a distinct session, shared lineage refused | unchanged Step 11 | existing 24 tests | **externally blocked** — see §8 |
| `A12_WRITEBACK` | knowledge, project, conversation, candidate, priority, briefing update exactly once | observer | replay + concurrent test | the real mission |
| `A13_AUTO_NEXT` | the frozen follow-on launches once without another prompt | cycle | test | frozen conversation 7 |
| `A14_HUMAN_RESUME` | a true boundary parks, appears in Needs You, resumes the same mission | human requests | idempotent-answer test | frozen conversation 8 |
| `A15_RECOVERY` | restart, provider refusal, worker death and takeover lose and duplicate nothing | cycle + existing fencing | crash injection | fault-scope run |
| `A16_DD_FRESHNESS` | Deal Dispatch state is `CURRENT`/`STALE`/`UNAVAILABLE` and never presents memory as live | adapter | test | deployed adapter |
| `A17_PRIVACY_AUTH` | private stays private through candidate/probe/mission/knowledge; IDOR reveals neither content nor existence; injection changes nothing | policy reuse | negative tests | fault-scope run |
| `A18_BASELINES` | Step 9/10/11 authoritative baselines unchanged but for authorized 12A rows | — | — | before/after read |
| `A19_DELIVERY` | typecheck, build, both suites, migrations from empty, hosted verify before **and after** a real restart | — | CI | deployment ledger |

`A11` depends on provisioning outside this repository. It does not block
building anything else, and it is not weakened, simulated or substituted.

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

`A11_INDEPENDENT_AUDIT` needs the second Claude account to present its **own**
Brain worker identity. It is inspected once, not polled beyond ten minutes, and
if it still presents the primary identity the blocker is recorded, everything
else is stored and resumable, and the matrix is not weakened, simulated or
substituted. Step 12A is not called complete while it is open.
