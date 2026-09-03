# Step 12A — evidence

What was built, what was measured, and what is still unproven. A claim in this
file is either a row you can go and read or it is marked as not yet
established. `docs/STEP-12A-PLAN.md` is the freeze; this is the record against
it.

Four kinds of proof, never conflated:

| Kind | Means |
|---|---|
| **CODE** | the mechanism exists and is wired to a caller |
| **TEST** | it is proven by an automated suite, on both backends where the repository supports both |
| **HOSTED** | it is proven against the deployed application, before and after a real restart |
| **PRODUCTION** | it is proven by authoritative rows written by a real run |

**"Implemented" is never a production verdict.** A green deployment is not proof
that the product works.

---

## 1. Gate status

Read `step12a acceptance` for the machine verdict; this table is its narrative
companion and must agree with it. Any disagreement means this document is
stale — re-run the reporter, do not edit the table.

| Gate | Verdict | Proof kind | Evidence |
|---|---|---|---|
| `A01_SHELL_IDENTITY` | NOT_RUN | | |
| `A02_CONVERSATION_ROUTE` | NOT_RUN | | |
| `A03_ROUTE_CORRECTION` | NOT_RUN | | |
| `A04_IRRELEVANT` | NOT_RUN | | |
| `A05_DEDUPE` | NOT_RUN | | |
| `A06_JUDGMENT_OVERRIDE` | NOT_RUN | | |
| `A07_PROBE_BOUNDS` | NOT_RUN | | |
| `A08_COVERAGE` | NOT_RUN | | |
| `A09_AUTH_BUDGET` | NOT_RUN | | |
| `A10_MISSION_PIPELINE` | NOT_RUN | | |
| `A11_INDEPENDENT_AUDIT` | BLOCKED | — | provisioning, outside this repository — §4 |
| `A12_WRITEBACK` | NOT_RUN | | |
| `A13_AUTO_NEXT` | NOT_RUN | | |
| `A14_HUMAN_RESUME` | NOT_RUN | | |
| `A15_RECOVERY` | NOT_RUN | | |
| `A16_DD_FRESHNESS` | NOT_RUN | | |
| `A17_PRIVACY_AUTH` | NOT_RUN | | |
| `A18_BASELINES` | NOT_RUN | | |
| `A19_DELIVERY` | NOT_RUN | | |

---

## 2. Phase 0 — what the inspection actually found

Recorded 2026-09-03, before any mutation.

### Verified starting state

Branch `claude/zealous-hypatia-78a2yp` at `7a6453d`, worktree clean, nothing
unpushed, no parallel-session work present locally or on the remote. Next
migrations are SQLite **027** and Postgres **018**. The client has no router, no
query library, no UI kit and no frontend test harness; `App.tsx` is 592 lines
over one implicitly selected project and `styles.css` is 1850.

Live fleet, read through `fleet show`: 4 accounts / 4 routines, `primary`/V1
`fires=12`, `friend-2`/V2 `fires=6`, both ENABLED with zero refusals and zero
no-shows, and two `verify-hosted-*` accounts that are structurally unroutable by
design and correctly reported as `MISSING SECRET`.

Live Deal Dispatch, read through the deployed Brain's own MCP surface as a
`WORKER` principal: eight layers, World Model `AUDIT_READY` v1, **Monetization
Logic `MORE_RESEARCH_REQUIRED` v1C**, six layers `NOT_STARTED`, and a planner
whose single next best action is *Redo Monetization Logic v1D*.

### Three defects confirmed in code, not assumed

**Capability routing is not wired end to end.** `bins.required_capabilities` and
`bins.workload_class` exist in migration 026 and Postgres 017;
`requiredCapabilities` appears nowhere in `server/domain/types.ts`; the
`createBin` path takes `workloadClass` and not `requiredCapabilities`; and
`services/dispatch/router.ts:102` reads the field through
`(bin as unknown as { requiredCapabilities?: string[] | null })`. A cast is not
a mapping, and `A10` routes on this, so it is fixed rather than recorded.

**`conversations.project_id` is `NOT NULL`.** Russell must open a conversation
before a project is chosen, so the existing table cannot be the Russell thread
unchanged. Resolved additively: `russell_conversations` carries a nullable
project and a unique `legacy_conversation_id`, a backfill gives every pre-12A
conversation a Russell thread, and **no message is copied or rewritten** — the
read projection unions legacy `messages` with `russell_messages` by
`created_at`, so ids, authors, timestamps and scope stay exactly where they are.

**The intent layer is a regex.** `services/agent/chat.ts:121` matches
`/^(what|which|why|how|…)\b/`. That is a deterministic rule layer and it is
useful; it is not cognition, and it stays behind Legacy rather than being
dressed up as Russell.

### The production read (run 33818496163, 2026-09-03T23:39Z)

`step12a-inspect.yml` reads the deployed release and the configured secret
**names and digests** — never values — and writes nothing.

| | |
|---|---|
| Image | `northline-brain:deployment-01M1JW5B0BZ75DVH24NHA6F6DS` |
| Release | **v98**, complete, deployed 2026-09-03T05:38:59Z |
| Machine | `811d651c26d948`, iad, started, 1/1 checks passing |
| Secrets configured | 11: the six database/storage ones, plus `BRAIN_ROUTINE_ID`, `BRAIN_ROUTINE_VERSION`, `BRAIN_ROUTINE_TOKEN`, `BRAIN_ROUTINE_TOKEN_2` and **`BRAIN_ROUTINE_TOKEN_3`** |

The schema/baseline step was skipped: `BRAIN_DATABASE_URL` is a Fly secret but
not a GitHub one, so the runner had nothing to connect with. The container has
it, and the baseline is read from inside the container before the first
mutation rather than from the runner.

**`BRAIN_ROUTINE_TOKEN_3` is deployed**, which was not known when Step 11's
blocker was written up. It is the credential a third Routine needs, so the
second friend-2 trigger can be registered as a real, fireable surface on that
account without asking for anything further. That does not by itself close
`A11` — the second Claude account must still authenticate as its own Brain
worker identity — but it removes the missing-secret half of the fallback.

### The inference seam — decided from what is actually deployed

**There is no `ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER` in production.**
`providers/index.ts:60` falls back to the mock when `BRAIN_PROVIDER` is unset,
and `providers/claude.ts:106` needs `ANTHROPIC_API_KEY` to reach the Anthropic
API at all. So the deployed Brain has exactly two candidate inference paths, and
only one of them is permitted:

| Path | Status |
|---|---|
| Mock provider | **Refused.** Deterministic canned prose presented as a grounded answer is the one thing Russell's conversation may never be. |
| Anthropic API | **Refused by authority, not by capability.** The key is absent, and setting it creates paid API usage the user has not authorized. `GOAL_BUDGET`'s default prohibits new spending, and a build that quietly bought its way past that would be the exact failure the rule exists for. |
| The fixed-subscription Cowork fleet | **Permitted, and already connected.** Three Routine credentials are deployed, the dispatcher fires them, and the default acceptance authority explicitly allows "use of already-connected fixed-subscription Routines". |

So **Russell's turn is served by the fleet, not by a paid API.** The turn
persists as pending with its retryable reason, a bin carries it to a worker, the
worker returns a structured response, the server validates every reference,
enum, transition, authority and side effect before anything is stored, and the
conversation shows the answer when it lands. That is genuinely model-backed, it
spends nothing new, and it reuses the dispatch, lease, fencing and recovery
machinery Steps 10 and 11 already proved.

It also costs latency, and the honest consequence is that a Russell reply is not
instant. The pending-turn contract the assignment already requires — persist,
show that Russell has not finished, never manufacture an answer, resume exactly
once — is what makes that truthful rather than broken.

---

## 3. Phase 1 — canonical state and authority

Not yet started.

---

## 4. What is not claimed

### `A11_INDEPENDENT_AUDIT` — blocked on provisioning, not on code

Step 11's signed matrix is enforced before the lease and again before storage,
proven load-bearing by inversion, and untouched by Step 12A. It cannot pass live
because both Claude accounts' Cowork sessions authenticate as one Brain worker,
so every audit role resolves to one account and `ACCOUNT` separation is
unsatisfiable. That is the check working on a fleet that cannot yet satisfy it.

The remedy is provisioning and it is the operator's: each external account
authenticates through its own Brain worker identity, created in the console and
connected by its own single-use invitation. Brain must not mint workers or pick
their permissions to get around it, and inferring an account from which Routine
Brain *attempted* to fire is rejected permanently.

It is inspected once during acceptance, not polled beyond ten minutes, and the
matrix is not weakened, simulated or substituted to close it. Step 12A is not
complete while it is open, and every gate that transitively depends on the real
mission's audit is reported as blocked rather than folded into a headline.

### Everything else

Every other gate reads `NOT_RUN` above, and will read a verdict here only when a
row supports it.
