# Session F closeout — integration of A–E, remaining repairs, production verification (2026-10-13)

This is the one record mapping every finding in
`docs/FAILURE-INVENTORY-2026-10-12.md` (branch
`claude/brain-v5-failure-inventory-r6t7ol`, preserved there unchanged) to what
happened to it. A merged pull request does not by itself close a finding.

Statuses:

| Status | Meaning |
|---|---|
| **VERIFIED** | Fixed, and a production reading on the released revision shows it |
| **AWAITING-VERIFICATION** | Implemented and tested; the production reading is still to be taken or still running |
| **AWAITING-AUTHORIZATION** | Implemented, held behind a person-only decision |
| **UNRESOLVED** | Not fixed; the smallest next action is named |
| **OWNER/PROVIDER** | Only the owner, an account owner or a provider can act |
| **DISPROVED** | The inventory's claim did not hold |
| **DEFERRED** | Explicitly out of this campaign, with the reason |

## 1. What was integrated

Integration branch: `claude/brain-v5-session-f-integration-gmupqr`, from
`origin/production` at `f96f323` (which already carried the optional-lane gate
and `ANY_NAMED_MARKET` corrections; they are kept, not reapplied).

| PR | Workstream | Head integrated | Migration |
|---|---|---|---|
| #194 | A — database load and measurement | `07555fb` | none |
| #195 | B — connections, check-ins, recovery, alerts | `f01cea7` | none |
| #198 | E — release machinery, CI, hooks | `4cc4dd7` | none |
| #196 | C — research outcomes (incl. `148d743`, expired-grant stop) | `148d743` | none |
| #197 | D — cash, commissions, duplicates, kernel settlement | `67eb654` | 118 / pg 109 → **renumbered 116 / pg 107** |
| #193 | Factory failed-unit progression | `1d690f8` | **not integrated — owner approval pending** |

Order A → B → E → C → D. Every merge was textually clean; the only file two
PRs both changed is `server/repos/research.ts` (C adds `gateFailureDistribution`,
D adds an additive `offset` to the claim reads), reviewed and kept whole.

**Migrations.** A, B, C and E add none. D's 118 / pg 109 had never been applied
anywhere: no branch or environment holds 116–118 or pg 107–109, and
production's chain ends at 115 / pg 106. They were renumbered to 116 / pg 107
before any release; `deploymentOwnership`'s gap check is satisfied rather than
waived. PRs #94–#97 (colliding 100–103 / pg 091–094) are not integrated and not
closed.

## 2. Session F's own corrections (on top of A–E)

| Commit | What | Inventory |
|---|---|---|
| Storage 429 | A Supabase upload refused `429 too_many_connections` / `SlowDown` (req_F11L81JQNiBz) is answered `RATE_OR_CAPACITY_RETRYABLE`; the effect attempt is non-terminal and the same call files once the store takes it. A 5xx on an upload stays unclassified (may have landed). Regression drives `brain_submit_synthesis` through `callTool` against a real `SupabaseStorageProvider`, retries, and reads the document back. | CON-10, #196 handoff |
| Cash report | Prints C's `gateFailureDistribution` (four populations, stated window); reads a parked mission's reason from `waiting_on` (the schema already requires it), so "54 NEEDS_HUMAN with no reason" was the report reading the wrong column. | RES-1, RES-9, RES-12 |
| Labor settlement | `labor/expand.ts` now settles by `missionsForRounds`, not the newest-100 window; ending rounds read every claim. | RES-2 (labor half) |
| Reports for F's accounting | `packet-report` prints each ended item's `cancelled_reason`; the Cash report adds stale under-ceiling research items with their parent packet and mission, the cancellations under "left RESEARCHING with nothing queued" missions, and source-access blocks by Routine/account classified DNS / provider-environment denial / host refusal / unreadable. | RES-10, 37 missions, source access |
| Dependency refresh | A no-change recompute now opens **no** transaction: `refreshProjectDependencies` reads first and opens one only when a link moved. | INF-5 |
| `byClaimTime` | D's merge sort broke same-millisecond ties by random claim id, so a capital restructuring could be filed before the requirement it names and be refused. Stable on the timestamp alone. `industryKernel` "capital and constraints" failed on D's own head and now passes. | RES-2 regression |

## 3. Findings register

### 3.1 Infrastructure

| ID | Status | Notes |
|---|---|---|
| INF-1 | OWNER/PROVIDER | Supabase dashboard (CPU, disk-IO budget, pooler) is not readable from Brain. See §5. |
| INF-2 | AWAITING-VERIFICATION | A's wait/response split, event-loop delay, wait events, locks and `stats_reset` are released; readings in §4. |
| INF-3 | AWAITING-VERIFICATION | Churn counted per pool; decision needs two comparable readings ~60 min apart (§4). |
| INF-4 | AWAITING-VERIFICATION | Session settings awaited in `#checkout` (A, tested against real Postgres). |
| INF-5 | AWAITING-VERIFICATION | Recompute rescoped (A); dependency refresh no longer opens a transaction (F). Effect-transaction recomputes (judge/submission) **not changed**: see §6. |
| INF-6a,b,c,e | AWAITING-VERIFICATION | A (b, c) and B (a, e). |
| INF-6d | AWAITING-AUTHORIZATION | Implemented on top of #193 (quiet person-blocked campaigns skipped while a watermark is unchanged). |
| INF-7 | AWAITING-VERIFICATION | E: observed serving revision decides; `deployed/production` follows only NEW_SERVING. |
| INF-8 | AWAITING-VERIFICATION | A: `migrationHotTableIndexGuard`. |
| INF-9 | OWNER/PROVIDER | Deploy pre-flight needs `BRAIN_DATABASE_URL` as an Actions secret — owner decision. |

### 3.2 Connections and fleet

| ID | Status | Notes |
|---|---|---|
| CON-1 | AWAITING-VERIFICATION | B: whole pre-swap path bounded; no factory derivation under pressure. |
| CON-2 | AWAITING-VERIFICATION | B: refresh lineage walk moved out of the transaction; remainder depends on A's split. |
| CON-3 | AWAITING-VERIFICATION | B: mixed arrivals no longer lift on one right arrival. Baseline 15:21Z: Airyn 2-C 45 right / 49 wrong. 24-h observation required. |
| CON-4 | OWNER/PROVIDER | Airyn: remove the `/mcp` Brain connector from 2-B, 2-C, 2-D (keep `/mcp/factory`, which authorizes as `wkr_9826…`). Verified from bindings, not URL wording. |
| CON-5 | AWAITING-VERIFICATION | B: alert cause from `binScopeRefusal`; Factory surface 1/2 should stop reading OUT_OF_SCOPE if membership passes. |
| CON-6 | AWAITING-VERIFICATION | B: outage-AMBIGUOUS probes not counted; Caleb 3-B to be re-probed in healthy time. |
| CON-7 | AWAITING-VERIFICATION | B. |
| CON-8 | UNRESOLVED | Caleb 3-B/3-C: re-read after B lands (§4). |
| CON-9 | OWNER/PROVIDER | Factory surface 3: NO_MCP in healthy time → Caleb checks the connector selection. |
| CON-10 | AWAITING-VERIFICATION | Storage 429 now retryable (F). |
| CON-11 | E | Historical. |

### 3.3 Research, Cash, kernels

| ID | Status | Notes |
|---|---|---|
| RES-1 | AWAITING-VERIFICATION | Measured (C); verifier-conditional and geography placeholder fixed in `f96f323`; payer shortfall genuine; source-access owner/provider (§5). Post-deploy reading only compares the post-deploy population. |
| RES-2 | AWAITING-VERIFICATION | D (four kernels, commissions, discovery, answers) + F (labor, ordering). |
| RES-3 | AWAITING-VERIFICATION | D. Baseline: 66 asked, 2 answered, `probabilityOfSuccess` commissioned. |
| RES-4 | AWAITING-VERIFICATION | D. |
| RES-5 | AWAITING-VERIFICATION | D (25 held exclusions + canonical document key). Whether repeated discovery is still active is read from the post-deploy duplicate count. |
| RES-6 | AWAITING-VERIFICATION | D. Already-READY cards with the old sentence are listed for a person, not rewritten. |
| RES-7 | DEFERRED | Low value until RES-6 (gig hauling). |
| RES-8 | AWAITING-VERIFICATION | C. |
| RES-9 | AWAITING-VERIFICATION | C (packet writer) + F (report column). |
| RES-10 | AWAITING-VERIFICATION | C (over-ceiling); under-ceiling parents read through F's report section (§4). |
| RES-11 | OWNER/PROVIDER | Commercial grant absent; Resend/Stripe unset. |
| RES-12 | AWAITING-VERIFICATION | D (a, b, d), A (c). |
| RES-13 | UNRESOLVED | Read the full envelope refusal on one packet after release. |
| RES-14 | DEFERRED | Deliberate (§38). |

### 3.4 Factory, release, CI

| ID | Status | Notes |
|---|---|---|
| FAC-1 | AWAITING-AUTHORIZATION | #193 needs a person to merge (asked on the PR). |
| FAC-2 | AWAITING-AUTHORIZATION | The static-validator claim is DISPROVED. Implemented: a second identical work-rejection on an unchanged scope refunds that attempt, stops the campaign at SCOPE_AMENDMENT_REQUIRED, and waits for an amendment or re-authorization. Held with #193. |
| FAC-3 | OWNER/PROVIDER | Allow Actions to create PRs (rollback). |
| FAC-4..9 | AWAITING-VERIFICATION | E. |
| FAC-10 | OWNER/PROVIDER | Policy. |
| FAC-11 | AWAITING-VERIFICATION | E rewrote the header. |
| FAC-12 | OWNER/PROVIDER | #94–#97 untouched; closing PRs needs authorization. |
| FAC-13, FAC-14 | DEFERRED | CLAUDE.md slimming; suite sharding. |
| FAC-15 | UNRESOLVED | Read the five BLOCKED campaigns' reasons after release. |
| FAC-16 | E | Historical. |

## 4. Production verification

_Filled from the released revision's own readings; see the sections below._

## 5. Owner and provider actions (consolidated)

1. **Merge #193** at `1d690f8`, or reply on it authorizing Session F to merge. Unblocks FAC-1, FAC-2, INF-6d.
2. **GitHub → Settings → Actions → General → Workflow permissions:** allow Actions to create and approve pull requests (FAC-3, rollback).
3. **Airyn (CON-4):** in Claude, on Routines Airyn 2-B, 2-C and 2-D, remove the Brain connector at `/mcp` (it authorizes as the Factory worker `wkr_f8e118…`); keep the one at `/mcp/factory` (`wkr_9826…`).
4. **Caleb (CON-9):** Factory surface 3 (`trig_01EhddNqYaQGC49fF9NVBcnT`) — confirm its Brain connector is attached in Claude.
5. **Supabase dashboard (INF-1):** read CPU, disk-IO budget and pooler connections beside the next connection report. Resizing is spending and is only justified by that reading.
6. **Optional:** `BRAIN_DATABASE_URL` as an Actions secret for the deploy pre-flight (INF-9).
7. **Revenue (RES-11):** commercial grant for Cash Mode 1; Resend and Stripe secrets (sandbox first). Without them the commercial journey cannot be claimed operational.
8. **Decisions:** FAC-10 (may sessions fast-forward `production`), FAC-12 (retire/renumber #94–#97, close stale PRs).

## 6. Design decision stated, not taken

The judge and synthesis submissions run `recomputeProject` inside the effect's
own transaction, so the layer state moves atomically with the recorded audit or
filed document. Moving it after commit would shorten the hold, but a
fire-and-forget `afterCommit` is not recoverable after a process dies, and a
durable deferred recompute is a new mechanism. The existing tick does not
re-derive every project's state on a schedule. Shortening these holds therefore
changes a consistency guarantee and is left as a decision: either (a) accept
layer status lagging an audit until the next recompute, with a durable "needs
recompute" marker the tick drains, or (b) keep it atomic. Nothing was changed
here. The fence that `proveLeaseOwnership` places at the start of the effect was
also not moved (§27 FENCE_LOST semantics).
