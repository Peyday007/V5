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
| INF-1 | OWNER/PROVIDER | §4.2: WAL-write waits on single-row updates, Storage 544, pooler checkout refusals — the database is I/O-bound. The dashboard reading and any resize are the owner's. |
| INF-2 | VERIFIED | §4.2: on `2bb5879` the split reads pool wait p95 0 ms, event loop p99 21 ms, response up to 136 s, server waits `LWLock:WALWrite`. The time is the database host's. |
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
| CON-1 | VERIFIED | §4.6. |
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

### 4.1 The release

| Fact | Reading |
|---|---|
| Deploy 458 (`7af7cfa`) | Cancelled. Its full SQLite suite failed on `neutralWorkerIdentity`: WS-B's `arrivalIdentity.ts` read a worker's handle directly, and `test:impacted` did not select that guard. Fixed in `2bb5879` (named through `workerIdentity`). |
| Deploy 459 (`2bb5879`, run 38435096965) | Typecheck plus the whole SQLite suite passed (29 min). Postgres suite 571 passed on the same SHA (70 min). `flyctl deploy` then failed on its health-check deadline. |
| Why flyctl failed | Supabase Storage answered `544 DatabaseTimeout`. The boot proof retried at 30 s, 60 s and 120 s, and Brain served from 18:18:38Z, so §18's retry worked as designed. flyctl's wait ran out first. |
| Observed | `NEW_SERVING`: the machine runs `2bb5879`, and the Brain answers. Schema version 107 (migration `107_kernel_round_abandoned` applied). `deployed/production` names `2bb5879`. |
| Hosted verification | **Did not run**: it is skipped when `flyctl` fails. The release is live, and its verification is unknown, not passed. |
| Release passes after the Deploy | Exactly one `workflow_run` pass followed Deploy 459 (Factory release 110, success). Pass 109 belongs to the cancelled 458. Scheduled pass 111 (18:22Z) died on `ECHECKOUTTIMEOUT` before reading anything. |
| `production` tip | `07f9e4d` = `2bb5879` plus a workflow and test change only (closeout-report markers, §4.4). No image change, so no Deploy. |

### 4.2 What the released process measured (connection report, 18:48–18:58Z, `SERVING_REVISION 2bb5879`)

This is the reading INF-1 and INF-2 were waiting for. It moves INF-2 to VERIFIED.

- **Brain is not where the time goes.** On the new process:
  - workload pool wait was p95 **0 ms** over 500 statements;
  - event loop was p50 20 ms, p99 21 ms;
  - statements still took 63–136 s *in response*, with wait ≈ 0 (`SELECT * FROM factory_campaigns …` up to 135.9 s; the single-row lease `UPDATE` up to 63 s).
- **The server is waiting on its own write-ahead log.** `pg_stat_activity` showed 5 active and 7 idle connections. Three single-row `UPDATE`s were waiting on **`LWLock:WALWrite`** (14–22 s) with no lock waits between sessions. That is storage I/O on the database host, not contention from Brain.
- **Supabase itself is starved.** Supabase Storage answered `544 DatabaseTimeout` during the boot. Separately, a one-client operator read was refused by the pooler (`ECHECKOUTTIMEOUT` after 15 s, in Session mode) at 18:23Z and again at 18:49Z, with Brain holding 8 workload + 1 control connections.

**INF-1 is now owner evidence, not conjecture: the database is I/O-bound.** The Supabase dashboard's disk-I/O budget and CPU for this window are the next reading; resizing is spending.

### 4.3 Connections and fleet, as read

| ID | Reading |
|---|---|
| CON-3 / CON-4 | Airyn 2-B and 2-D are **QUARANTINED**, each with a wrong-worker cause naming session, connector (`/mcp`, client `brnc_e9f3…`) and both remedies. Airyn 2-A and 2-C are ENABLED and checking in (last 18:07:48Z). This is B's behaviour: one activation, then stop. The owner action (§5.3) still stands. |
| CON-1 / INF-6 | 8 `UNSERVED_ARRIVAL CHECK_IN_BUDGET` incidents, 16:42–18:08Z, every one recorded as Brain's and charged to no surface. `MISSES` shows `infra=1`, `no-show=0`, `auth=0`. |
| Auth | 3 `INVALID_CREDENTIALS` in 3 h. No credential was reported refused during the outage. |
| Research fleet | Brain Research A, 1-B, 1-C and 1-D are all ENABLED and attributed to `cnr_8ee3…` / `wkr_1cdd…`. |
| Caleb | 3-A ENABLED; 3-B QUARANTINED (no-shows, 2026-10-12); 3-C QUARANTINED. CON-8 is unchanged and needs a healthy-time probe. |

### 4.4 Readings that could not be taken, and one defect they exposed

- `cash-report` failed in `initDatabase` (`ECHECKOUTTIMEOUT`).
- `packet-report orc_c576…` failed in `initStorage` (Storage `544`).
- The connection report died at its final ALERTS query on a statement timeout. That query has an index (`idx_bin_events_routine`), so the cause is the starvation above, not a missing index.

So RES-1..RES-13 and FAC-15 stay AWAITING-VERIFICATION until the database answers.

**Defect found and fixed (`07f9e4d`).** `closeout-report campaigns` went **green** while `factory.sh` died before printing anything. Its marker was `.`, which matches a stack trace; `fleet`, `routing`, `projects` and `bins` had the same marker. Each now greps the script's own OK line, and `tests/closeoutReportMarkers.test.ts` refuses any marker that a failure would match. The test was run against the old file and failed there.

### 4.5 Second reading (20:04Z–20:25Z, `2bb5879`)

**The database is still I/O-starved.**
- The pooler refused `fleet show` and the packet report (`ECHECKOUTTIMEOUT`, Storage `544`).
- The connection report and the cash report each died part-way on statement timeouts (`bin_events` by routine; `monetization_rank_snapshots`).
- Server sessions were waiting on `LWLock:WALInsert` and `IO:DataFileRead`, with 14 connections open server-wide and no lock waits.
- Brain's own side read clean again: workload pool wait p95 0 ms, event loop p99 21 ms.

**What could be read:**
- **Campaigns:** `closeout-report campaigns` read the campaign list, ending in `FACTORY: OK` (so this green is real).
- **The marker fix in production:** `closeout-report fleet` now reads **red** when it fails. Before `07f9e4d` the same failure read green.
- **Research packets:** 609 in total. 15 RESEARCHING, 132 NEEDS_HUMAN, 8 QUEUED, 2 AUDITING.
- **INF-3 (pool churn):** the workload pool opened 585 connections in 110 minutes (about 5.3 per minute), up from 99 in 35 minutes (about 2.8 per minute) on the first reading. Each new connection costs the pooler `pgbouncer.get_auth` and `DISCARD ALL`. Under an I/O-starved database, the 10-second idle release is churn rather than relief. This is a measurement, not a decision; the comparison wants a reading in healthy time.

**No research is moving.** Since the restart at 18:18Z the connection report shows no fired session arriving and no work done. Earlier in the three-hour window, two sessions did check in: 1-B at 17:33Z, and Airyn 2-C at 18:07Z (one arrival as the right worker, one as the wrong one). The dispatcher's own reads take up to 63 s per statement on this database. Everything points the same way: the work is not refused, the database simply cannot answer fast enough to hand any of it out. RES-* and FAC-15 remain AWAITING-VERIFICATION. The next step is the owner's Supabase reading (INF-1), not another Brain change.

### 4.6 Third reading (22:29Z, `2bb5879`): the database answered, and work is flowing

All three reads completed: `CONNECTION-REPORT: OK`, `CASH-REPORT: OK`, `PACKET-REPORT: OK`.

**The connection path in healthy time:**
- `authenticate` p95 54 ms over 500 calls.
- `brain_check_in` p95 4.9 s over 161 calls.
- Pool wait p95 0 ms on both pools; event loop p99 21 ms.
- No credential refusals.
- One `UNSERVED_ARRIVAL` (20:43Z, `CHECK_IN_BUDGET`), charged to nobody. 1-D's one miss is `infra=1`, not a no-show.

**Work:**
- Since 20:25Z, Brain Research 1-B, 1-C and 1-D each have 5 arrivals, Airyn 2-A has 29 and Airyn 2-C has 27.
- `wkr_1cdd…` was assigned 20 bins and claimed 16 items on Cash Mode 1.
- `wkr_9826…` (Airyn) was assigned 97 bins and released 95, with 10 completions refused. That is the mixed-connector pattern below spending activations.

**What is still slow:** `oauth_token` p95 42.7 s, and `UPDATE factory_campaigns … lease` up to 152 s. The first is the refresh lineage walk (CON-2's remainder). The second sat inside the outage window.

| ID | Status | Reading |
|---|---|---|
| CON-1, INF-6a/b/c/e | VERIFIED | Check-in is bounded (p95 4.9 s, inside 60 s). The unserved arrival was recorded as Brain's and was not charged. |
| CON-3 | VERIFIED (behaviour); OWNER for the fix | Airyn 2-B, 2-C and 2-D read `MIXED_WORKERS`, `who=ACCOUNT_OWNER`, with week counts (2-C: 403 right, 52 wrong, interleaved) and both remedies. One right arrival no longer lifts anything. |
| CON-6 | VERIFIED | Caleb 3-B and Factory surface 3 read `RECOVERING`, `who=NOBODY`, with the next probe time. Caleb 3-C reads `RECOVERY_EXHAUSTED`, `who=ACCOUNT_OWNER` (last probe `NO_MCP`). |
| CON-8, CON-9 | OWNER/PROVIDER | Caleb 3-C and Factory surface 3: as above. |
| INF-3 | AWAITING-DECISION | The workload pool opened 1 380 connections in 4 h 15 m, about 5.4 per minute, against 2.8 per minute in the first reading. That is churn, not relief. A longer idle timeout (now 10 s) is the candidate change; it is a decision, not a fix. |
| RES-1 | UNRESOLVED | Over 7 days, 782 fragments were judged: 67 accepted, 715 blocked. Of the blocked, **334 are `UNCLASSIFIED`**; the rest are `VERIFIER_INSUFFICIENT` 144, `REQUIRED_LANE_EMPTY` 98, `SOURCES_UNREADABLE` 62 and smaller causes. Next action: widen `classifyBlock` against the recorded reasons of the 334. |
| RES-9 | PARTIAL | Every mission row now carries a reason. **13 NEEDS_HUMAN packets still show "(no reason recorded)"**; whether they predate C's writer is not yet read. Next action: list them with their `updated_at`. |
| RES-10, RES-12 | VERIFIED | The packet report prints each ended item's reason. The cash report lists stale under-ceiling items with their packet and mission, and the cancellations behind the 37 "left RESEARCHING" missions. Parked missions read `waiting_on`. |
| RES-3 | AWAITING-VERIFICATION | 66 asked, **2 answered**, 58 unresolved, 6 open: no movement yet since the 15:21Z baseline. |
| RES-5 | AWAITING-VERIFICATION | 173 openings, 86 of them re-found (26 distinct); 1 689 possibilities merged. Whether re-finding continues after the release needs a dated count. |
| Source access | OWNER/PROVIDER | Blocks are now attributed to the Routine that hit them. Mostly `DNS_FAILURE` (134 unattributed, plus 35 on Airyn 2-A, 31 on 2-C, and a few on Brain Research A) and `UNREADABLE_CONTENT`. These are the Routines' network environments. |
| Storage | VERIFIED | 117 documents in Cash Mode 1, every one present in the bucket. |

**One new defect, in `orc_c576…`.** The packet is `CANCELLED`, yet its bin `bin_2b9d…` sits at `NEEDS_HUMAN`, telling a person to decide about a packet that is already over. Its fragment also still reads `QUEUED`. That is an escalation nobody can answer (§24). It dates from 2026-10-07. Next action: when its packet is terminal, a parked bin should be reconciled to terminal.

### 4.7 Database stabilization and the overnight run (2026-10-14)

**Release.** Deploy 460 released `d5fce97` (database pressure, the token-history
cache, the per-card read, and the extended connection report): `release: success`.
The hosted verification passed **261/261** before the restart. After the restart
it scored 278/280; the two failures were the scenario engine's 50 000-evaluation
run, which took **30.5 s against its 20 s budget** (945 ms before the restart),
and the reproduction check that depends on it.

That slowdown is the machine, not the scenario code:
- On the same image, the first process's event loop was healthy (p99 24 ms) for
  five minutes.
- The second process stalled for 35.8 s at 06:24Z, ten minutes after the
  harness had run its whole suite inside the same `shared-cpu-1x` machine.
- A 32× slowdown matches a shared Fly CPU throttled to its baseline (about a
  sixteenth of a core) once its burst budget is spent.
- The previous three deploys measured the same check at 800–940 ms after
  their restarts.

It is recorded as unresolved, not fixed: the remedy is either a bigger machine
(spending, so the owner's call) or a harness that does not run inside the
machine it is measuring.

**Before and after.** The "before" reading is `2bb5879`, healthy, over 9.7 hours.
The "after" readings are `d5fce97`.

| Reading | Before | After |
|---|---|---|
| `cash_card_facts` single-field reads | 360 198 in 9.7 h (~620/min) | 8 066 in 33 min (~245/min, −60%) |
| connector token-history `LIKE` reads | 5 892 in 9.7 h, mean 118 ms | absent from the new process's top statements |
| authenticate p95 | 91 ms | 800 ms during the post-restart stall; to be re-read |
| event loop p99 | 67 ms | 401 ms 30 min after restart (worst 35.8 s at 06:24Z) |

**What the new database sections established.**
- **Write volume.** 10.3 GB of WAL since 2026-10-05.
- **The largest writer was Brain's own bookkeeping:** `UPDATE monetization_paths
  SET last_evaluated_at` wrote about **2.5 GB** across 6.4 M updates of 3 695
  rows, restamping every path on every pass. Fixed overnight: the stamp now rewrites only when older than an hour.
- **Other large writers:** `russell_frontier` 828 MB, `bin_events` inserts
  1.26 GB, and factory campaign lease claim, release and state updates about
  470 MB.
- **The frontier stamp is not throttled.** It decides what counts as resolved,
  so changing it is a design change, not a tuning.
- **The database itself:** cache hit 99.93%, `max_connections` 60,
  `shared_buffers` 280 MB, `synchronous_commit` on, 32 GB of temp files.

**A defect in my own change, found by the reading and fixed.** SHEDDING began at
the 06:24Z stall and did not leave, although statements had recovered (p90
68 ms). The leave rule required *zero* failures, and a steady few lost
connections per two minutes kept that false. So discovery and the kernels were
deferred from 06:24Z until the fix was released. The fix: only timeout and
unavailable kinds count as overload, fewer than the entry count no longer
blocks recovery, and the reading now prints every failure kind it felt.

**Fixes committed overnight** (all on `production`, released together after
Deploy 460):
- `reconcileBins` closes a parked research bin whose packet is CANCELLED
  (`bin_2b9d…`, which had been re-asked on every tick since 2026-10-07).
- Gate outcomes name the 391 "UNCLASSIFIED" blocks: `SOURCE_ACCESS` (the reason
  names DNS, a proxy or a host refusal), or `NO_GATE_VERDICT` (a worker's own
  blocker). `UNCLASSIFIED` is kept for a gate verdict no rule fits.
- The cash report dates every stopped-packet reason and lists reasonless
  packets with their last update (RES-9).
- Campaign tick heartbeats are single-flight. The one-row lease `UPDATE`
  averaged 11.5 s (152 s worst) against a 15 s interval, so beats stacked up,
  each holding a pooled connection.
- The pressure leave rule above, and the monetization evaluation stamp.

**Is Brain doing useful work?** Yes. Over the eight hours to 06:29Z:
- **Ideas:** 589 → 612.
- **Missions:** 535 → 587.
- **Work items succeeded:** 1 157 → 1 258.
- **Opportunities:** 173 → 190, of which 19 closed.
- **Research fragments accepted:** 83 this week against 67 in the previous
  reading's window.

**Not changed, on purpose.** Pool churn (INF-3): about 6 new connections a
minute costs the server roughly 0.6 s a minute (`get_auth` 30 ms plus
`DISCARD ALL` 68 ms), so it is not worth a change. `fleet_policy` per-routine
reads (~230 a minute) are cheap per call; they are a candidate, not a measured
problem.

### 4.8 Deploy 461 and the morning reading (2026-10-14)

- **Deploy 461 (`d028e4c1`) did not release.** Its test job failed on
  `campaignTickHeartbeat`: the guard expected `void extendCampaignTick` to open
  the timer callback, and the overnight single-flight beat put
  `if (beating) return; beating = true;` first. That same prelude hid both
  heartbeats from the companion check that every timer promise carries a catch.
  Fixed on the branch (`fa550912`): both patterns accept the prelude, and the
  catch check reads to the end of the callback. Verified by removing a
  heartbeat's `.catch`; the guard names `loop.ts`.
- **The Postgres suite on `d028e4c1` also failed `signInIdentity`.** This is a
  false finding: the PIN `232323` occurs inside the random event id
  `iev_40a2323237974656b146`. Minted ids are now blanked before the secret
  search. A PIN placed in a recorded value is still caught (checked).
- **`fleet_policy` reads (~230/min)** are now one read per dispatch snapshot
  (`c215e830`). The impacted tests passed on SQLite and Postgres (1,334/1,334).
- **The release is blocked on a person.** `.claude/settings.json` forbids a
  session from pushing `production`, and this run did not route around that.
  The branch is a fast-forward of `production`, and `production` itself fails
  the test gate until it takes `fa550912`.
- **Pressure on the live process (`d5fce97`, the connection report at
  ~08:40Z):** it shed from 06:24Z and recovered at **08:25:46Z** under the old
  rule ("no failure for 5 minutes"). It now reads NORMAL: p90 19 ms over 2,000
  statements, 0 overload failures. The worst event-loop stall since start was
  **35.8 s at 06:24:42Z**, the same instant shedding began, so that stall was
  this process's own loop rather than the database. The fix that keeps a few
  CONNECTION_LOST from holding shedding (`OVERLOAD_KINDS`) is in `d028e4c1` and
  is not yet live.
- **Not read this run:** the kernel reports, the monetization WAL rate after
  the throttle, and gate outcomes under the new categories. All of these need
  the next release to be live to mean anything.

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
