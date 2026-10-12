# Brain V5: system-wide failure inventory and repair plan (2026-10-12)

This was an investigation and planning pass. Nothing was implemented, migrated
or deployed while doing it.

Evidence used:

- the code at `production` e6f8eee;
- GitHub Actions run history and logs:
  - Deploy runs 417–456;
  - Postgres suite, last 200 runs;
  - Factory release runs 1–97;
  - Connection report runs 23–30;
  - Cash report runs 84–86;
  - Fleet/Factory reads;
- read-only Brain MCP calls.

Production readings:

| Reading | Run | Time | Revision |
|---|---|---|---|
| Connection report | 38305341452 | 20:36Z | `a8e883d` |
| Cash report | 38304534409 | 20:29Z | `a8e883d` |
| Factory campaigns | 38264526401 | 14:39Z | — |
| Fleet show | 38259543167 | 13:58Z | — |

Each finding is assigned one of these classes:

| Class | Meaning |
|---|---|
| **A** | Confirmed; root cause and fix known |
| **B** | Confirmed; root cause or fix unresolved |
| **C** | Suspected; needs a targeted check |
| **D** | External; needs provider or owner action |
| **E** | Historical; already corrected, regression risk only |

---

## 1. System coverage

Columns:

- **Start** — can the journey start?
- **Exec** — does it execute?
- **Deps** — can it reach its dependencies?
- **Persist** — does it persist its results?
- **Recover** — does it recover from interruption?
- **Terminal** — does it reach a truthful terminal state?
- **Result** — does it produce the result the user actually wants?

Cell values: ✓ means verified from production rows or logs. ✗ means a verified
failure. ~ means it works only intermittently, or verification was partial.
? means not established.

| Journey / subsystem | Start | Exec | Deps | Persist | Recover | Terminal | Result | How verified |
|---|---|---|---|---|---|---|---|---|
| Boot and deploy (Fly) | ~ | ~ | ✗ | ✓ | ~ | ✗ | ~ | Deploy logs 417–456 |
| Supabase Postgres and Storage | ✓ | ✗ | — | ✓ | ~ | — | — | Connection report, boot logs |
| MCP and OAuth control plane | ✓ | ~ | ✗ | ✓ | ✓ | ~ | ~ | Latency and incidents, 20:36Z |
| Fleet dispatch, arrival, check-in | ✓ | ~ | ✗ | ✓ | ~ | ✗ | ~ | Connection report, fleet show |
| Research packets | ✓ | ✓ | ~ | ✓ | ~ | ✗ | ✗ | Cash report packet/mission counts |
| Russell tick and launch | ✓ | ✓ | ~ | ✓ | ? | ~ | ✗ | Cash report, code |
| Cash Mode 1 (discovery → qualification) | ✓ | ✓ | ~ | ✓ | ~ | ✗ | ✗ | Cash report tiers |
| Cash commercial journey (contact → settle) | ✗ | — | ✗ | — | — | — | ✗ | Grant absent; providers missing |
| Monetization commissions | ✓ | ✓ | ~ | ✓ | ~ | ✗ | ✗ | 61 asked, 2 answered |
| Kernels: industry, dealflow, manufacturing, puzzle | ✓ | ~ | ~ | ✓ | ✗ | ✗ | ✗ | Dealflow slots held since 09-21 |
| Kernels: labor, design, capability | ? | ? | ? | ? | ? | ? | ? | No production report read |
| Software Factory (hosted) | ✓ | ✓ | ✓ | ✓ | ~ | ~ | ~ | Campaign list; PR #193 |
| Factory automatic release | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | §58 proofs; rollback blocked |
| CI: Postgres suite and Deploy gate | ✓ | ✓ | ✓ | — | — | ~ | ~ | 200 runs: 96 ok / 92 cancelled / 11 failed |
| Engineering policy hooks | ✓ | ~ | — | — | — | — | ~ | `.claude/` read |
| Monitoring and reports | ✓ | ~ | ✗ | — | — | ~ | ~ | Reports fail or mislead (below) |
| Goals register and research goals | ? | ? | ? | ? | ? | ? | ? | Not read; MCP timing out |

**The bottom line on usefulness.** In 26 days, Cash Mode 1 has produced:

- 128 openings, made up of 96 SIGNAL, 31 CANDIDATE, 1 QUALIFIED and **0 READY_TO_TEST**;
- no commercial grant;
- no outbound provider;
- money ledger figures that nothing prints.

Of 521 research packets, 345 were cancelled and 26 completed. 308 missions
failed with *"No fragment cleared its evidence gate"*. The system is not yet
producing the outcome the owner wants.

---

## 2. Findings register

### 2.1 Infrastructure: database, storage, Fly, boot

**INF-1 · D — Supabase capacity is exhausted, and it is the shared upstream of almost everything below**

Evidence:

- `max_connections` is 60 (deploy 456 banner). That fits Supabase's smallest compute tiers.
- Storage answered 544 `DatabaseTimeout` and 429 `too_many_connections` at boot in deploys 424, 453, 454 and 456 (17:50–17:51Z).
- The pooler was unreachable from operator scripts (Connection report runs 23, 24, 26 and 29).
- Session-mode `ECHECKOUTTIMEOUT` appeared in hosted verification on deploys 420, 422 and 456.
- At 20:36Z there were 3 active database connections, while client-measured single-row writes took 154–210 s.

CPU, disk-IO burst budget and the compute tier cannot be read from inside Brain.

Owner action: read the Supabase dashboard (CPU, disk IO budget, connections),
then decide whether to resize the compute. Resizing is spending (invariant 18).

Verify: the dashboard reading taken beside the next connection report.

**INF-2 · C — §61's conclusion "the server is not executing" is not supported by its own measurement**

- `noteStatement` (`server/db/adapters/postgres.ts:513-530`) measures client wall time, including the wait for a pooled client.
- The workload `statement_timeout` is 120 s (`:231`). A statement that was actually executing would have been cancelled at 120 s, yet the recorded times reach 207–210 s.
- The remaining time was therefore spent outside Postgres execution. Candidates are the Supavisor queue, network (22 `CONNECTION_LOST`) or Node event-loop stalls.
- Brain does not measure event-loop delay. There is no `monitorEventLoopDelay` anywhere in `server/` or `scripts/`.

Smallest check:

- record checkout wait and execution time separately;
- record event-loop delay p99 beside liveness;
- print `pg_stat_activity` wait events and a `pg_locks` blocking summary in the connection report.

This decides whether INF-1 is purely capacity or partly a Brain process stall.

**INF-3 · B — Connection churn costs about as much server time as Brain's top statements**

- `DISCARD ALL`: 64,080 calls, 3,743 s.
- `pgbouncer.get_auth`: 81,550 calls, 2,520 s.

Suspected cause: the workload pool's 10 s idle timeout (`postgres.ts:294`, a
§53 change) reconnects to the session pooler again and again.

Fix: measure the hourly delta, then lengthen the idle timeout within the
pooler's 15-session budget. Transaction mode is the structural alternative, but
it breaks per-session `SET`.

**INF-4 · A — The pool's `connect` handlers issue `SET`s without awaiting them**

- `postgres.ts:348-354` and `:396-400`.
- The result is the warning "Calling client.query() when the client is already executing" (20:36Z), which becomes a hard error in pg@9.
- The comment says the statements are "sent one at a time", but they are not awaited in sequence.

Fix: chain them.

**INF-5 · B — Long transactions hold workload connections and row locks**

- Recompute (`stateEngine.ts:769`): 13 holds in 2.5 h, mean about 51 s, max 237 s.
- Effects (`effects/engine.ts:257`): max 133 s.
- With 8 workload connections, one recompute ties up 12% of the pool for minutes.
- `storage.search` ran 227k times. It is recompute's existence prefetch going through Supabase Storage, which talks to the same database.

Fix:

- break down recompute by statement (the instrumentation already exists);
- move the existence prefetch and the plan build outside the transaction, or skip work that produces nothing in cloud mode (§53 already skips the plan build there).

**INF-6 · A — Polls that rescan unchanged rows on a timer**

| Poll | Code | Measured |
|---|---|---|
| (a) Connector health on quarantined Routines, every 10 s dispatch tick | `connectorBinding.ts:322` → `connectorHealth.ts:286-299`: two LIKE scans over 45 days of `identity_events` | 1,330 calls in 3 h, 1,728 s, max 109 s. Produces nothing until a new consent row exists. |
| (b) Connect projection refresh, every 5 s | `connect/service.ts:279` | 1,428 runs in 2.5 h, 1,146 s. Re-projects the oldest 100 rows. Starvation is possible if more than 100 records. |
| (c) Shared-findings pool read | `sharedFindings.ts:228` | 6,741 calls at 470 ms mean, max 136 s. First pass of every Russell tick. |
| (d) `SELECT * FROM factory_campaigns WHERE state NOT IN …` | Factory loop every 20 s, plus every check-in via `deriveReadyWork` | 83k calls, 7,326 s |
| (e) Dispatch tick heads: `unansweredFiresByRoutine`, `inFlightByRoutine` | dispatch tick | 56k and 85k calls at about 58 ms, unconditional |
| (f) Seq scans of tiny tables | `workers` 1.55M, `worker_sessions` 656k, `routine_delivery_proofs` 140k | Cheap per call; shows per-request reads with no cache |

Fix for (a): read `lastGrantAt` from `oauth_tokens` first, and compute health
only when a grant is newer than the quarantine. For (b)–(e), gate each on a
change watermark or a longer interval.

**INF-7 · A — Deploy reports "nothing released" when the new image is in fact running**

- Deploys 424, 453 and 454 printed "still serving the previous version".
- Processes on `dcee3e7` and `4bff1c2` are visible in the connection report. Migration 106 was applied by `4bff1c2` at 16:21Z.
- Cause: a rolling update on one machine. The machine holds the new image and `bootRetry` later brings it up.
- Consequences:
  - `deployed/production` is not moved, so the rollback guard compares against a stale tag;
  - `factory-release` reads a false fact.

Fix: after a failed `flyctl deploy`, read the running revision (`flyctl status`
or `BRAIN_REVISION`) and record it truthfully.

**INF-8 · A (guard missing) / E (incident) — Boot migrations may still index large, write-hot tables**

- Migration 115 / pg 106 indexed `identity_events` at boot and blocked boot (§61).
- The rule against this exists only as prose.

Fix: a test that reads both migration chains and refuses `CREATE INDEX` on
`identity_events`, `bin_events` or `project_events`.

**INF-9 · A — The deploy pre-flight is skipped**

- The pre-flight step is skipped because `BRAIN_DATABASE_URL` is not an Actions secret (`deploy.yml:185,201-216`).
- Whether to add that secret is an owner decision, so this is informational only.

### 2.2 Connections, OAuth, fleet, dispatch

Current state, from Connection report 20:36Z and Fleet show 13:58Z:

- 7 of 15 active Routines are eligible and arriving: Brain Research A, 1-B, 1-C and 1-D, Caleb 3-A and 3-D, and Airyn 2-A.
- Quarantined:
  - Airyn 2-B, 2-C and 2-D (wrong worker);
  - Caleb 3-B (RECOVERY_EXHAUSTED) and 3-C (RECOVERING);
  - Factory surface 3 (RECOVERY_EXHAUSTED);
  - V2 (operator hold).
- Factory surface 1 has an OUT_OF_SCOPE alert. Two Deal Dispatch bins have waited since 09-27.

**CON-1 · A — Check-in exceeds the client's 60 s limit**

- `brain_check_in`: p50 34 s, p95 274 s, max 302 s.
- 12 `UNSERVED_ARRIVAL` incidents in 3 h.
- The 25 s budget gates only per-candidate admission (`bins/service.ts:518,659-768`).
  - `workerRoutingFor`, the `binAdmission` build and `assignNextBin`'s candidate query and swap are unbounded.
  - "No work" triggers `deriveReadyWork`, which runs the factory tick, the source of the hottest `factory_campaigns` statements.

Fix: bound the pre-swap reads with the same deadline, and skip
`deriveReadyWork` when check-in is past half its budget or the pool is
degraded. Keep §53's rule that once a lease is taken the answer is never
"nothing".

Verify: check-in p95 under 60 s in the next connection report.

**CON-2 · B — The control plane still times out**

- `authenticate`: p95 15,002 ms, max 163 s.
- `oauth_token`: p50 15,001 ms, which equals the control `query_timeout` of 15 s.
- Counts: `CONTROL:POOL_CHECKOUT_TIMEOUT` 4, `CONTROL:STATEMENT_TIMEOUT` 2.
- Deploy 456's verification got "a valid worker credential authenticates — 503".
- A rotation transaction (`oauth.ts:759`) held one of the 2 control connections for up to 30 s.

Fix direction: per-site control hold times. Keep rotation off the 2-connection
control pool, or raise the control share. The rest is mostly INF-1.

**CON-3 · B — Wrong-worker quarantine flaps through the recovery probe (Airyn 2-C)**

- `liftableQuarantine` includes `WRONG_WORKER_MARK` (`recoveryProbe.ts:277-285`).
- One right-worker probe arrival lifts the quarantine (`:412-438`).
- `quarantineWrongWorkerSurfaces` checks only the same session (`arrivalIdentity.ts:281-300`).
- So a Routine whose Claude config holds both connectors oscillates, and every cycle costs activations.
- 2-C produced right arrivals (n=2) and wrong arrivals (n=3) within 3 h, with the last of each at 20:36:16 and 20:36:33Z.

Fix: a WRONG_WORKER quarantine lifts only when the Routine's recent ordinary
arrivals are all right-worker. Report "mixed arrivals" as its own problem:
*remove the other connector from this Routine*.

**CON-4 · D — Airyn 2-B and 2-D select the factory connector**

- Every arrival since 10-11 at about 17:07Z authenticated as `wkr_f8e118` (factory-brain) through `/mcp`.
- Airyn's endpoints are mapped the opposite way round from what their URLs suggest:
  - `/mcp` → factory-brain;
  - `/mcp/factory` → his research worker `wkr_9826`.

Owner action: in Claude, set each Routine to the connector that authorizes as
`wkr_9826`.

**CON-5 · A — Alert remedies cannot be acted on, or name the wrong cause**

- (a) The wrong-worker remedy names a worker id, not a connector endpoint or name the account owner can see (`arrivalIdentity.ts:254-270`, `connectionAlerts.ts:128-137`).
- (b) OUT_OF_SCOPE fires whenever `servesBinScope` is false (`connectionAlerts.ts:170-200`). That condition is also false for repository, capability, delivery-FAILED or pin refusals, so it tells the operator to run `admin access grant` even when the membership is fine.
  - Factory surface 1 reads "serves: Deal Dispatch · waiting in: Deal Dispatch".
- (c) "Not fired since 09-27" sits beside a check-in at 09:57Z, because probe fires do not update `last_fired_at`.

**CON-6 · A — Outage-caused probe AMBIGUOUS exhausts the recovery budget and blames the account owner**

- `autoRecovery.ts historyFor` counts every non-HEALTHY state as failed, including AMBIGUOUS settled because "Brain itself was failing" (`recoveryProbe.ts:551-571`).
- Caleb 3-B: last probe was AMBIGUOUS at 16:32:24Z, during a pooler outage (run 38278559255 at 16:36:43Z). It is now RECOVERY_EXHAUSTED and points at `ACCOUNT_OWNER`, while 3-A and 3-D on the same connector are healthy.

Fix: give an outage-AMBIGUOUS probe its own outcome, and do not count it
toward `AUTO_PROBE_LIMIT`.

**CON-7 · A (diagnostic) — Workload-pool exhaustion inside `chooseWork` is recorded as `@CONTROL`**

- `bins/service.ts:603-608`; `infra.ts:244` reads the current plane.
- Fix: record the failure inside the `asWorkload` scope.

**CON-8 · C — Caleb 3-B and 3-C no-shows while 3-A and 3-D arrive on the same connector**

- Possible causes:
  - the Claude Routines lack the connector;
  - the trigger secret names are transposed (3-A↔_3_D, 3-B↔_3_C; `docs/FLEET-FOUR-ACCOUNTS-HANDOFF.md:1164-1167`);
  - outages that the narrow excuse did not cover.

Check: compare `DISPATCH_NO_SHOW` times with `infra_incidents`. After CON-6
lands, run one probe of 3-B while the database is healthy.

**CON-9 · C/D — Factory surface 3 (Caleb) is stranded**

- Quarantined since 10-04, with no bound connector.
- Last probe: NO_MCP at 10:14:37Z.
- Likely needs a Claude config fix by the owner.

**CON-10 · C — Worker submissions fail during degraded windows**

- `brain_submit_synthesis` FAILED 6 times (last at 19:23Z); `complete_work` FAILED 2 times; completion refused 3 times.
- Check: the `idempotent_attempts` failure categories.
- The likely cause is INF-5 (long effect transactions holding the lease row) combined with the 60 s client limit.

**CON-11 · E — Historical, already corrected**

- Lineage-recovery hot statement: throttled and indexed (`4bff1c2`/`a8e883d`).
- §59 worker-04 out-of-scope: resolved; Caleb's Routines run as `wkr_1db119`.

### 2.3 Research engine, Russell, kernels, Cash, monetization

Current production state (Cash report 20:29Z):

- Packets: 521, of which CANCELLED 345, NEEDS_HUMAN 123, COMPLETE 26, RESEARCHING 13, QUEUED 7, AWAITING_REPAIR 5, AUDITING 2.
- Missions:
  - 308 FAILED "No fragment cleared its evidence gate";
  - 54 NEEDS_HUMAN with no reason;
  - 37 FAILED "left RESEARCHING with nothing queued".
- On 10-12: 104 cancelled against 9 completed.

**RES-1 · B — Most research ends with no fragment ACCEPTED, while the same claims are used as evidence elsewhere**

- `packetRunner.ts:1780-1795` parks or fails a packet when no fragment is ACCEPTED.
- `citableClaims` (`repos/research.ts:1076-1100`) deliberately treats BLOCKED fragments' gated claims as citable, and cards do cite them (`…@orc_…/BLOCKED`).
- The *reason* fragments block is not established. It is not printed anywhere read.

Smallest check: the distribution of `research_fragments.blocked_reason` and of
per-condition gate failures for Cash Mode 1 packets in the last 7 days. This is
one SQL read through the console door.

The fix then depends on the answer:

- if most blocks are coverage or independent-source shortfalls on broad bucket questions, narrow the compiled questions or the lane bars;
- if instead a packet holding citable claims should file COMPLETE_WITH_GAPS, that collides with invariant 20 and §16. **That is an owner design decision, not a code fix.**

**RES-2 · A — Kernel rounds never settle when their mission fails, or falls outside a 100-row window**

- `dealflow/expand.ts:410-418`, `industry/expand.ts:292-300`, `manufacturing/expand.ts:363-371` and `puzzle/expand.ts:418-426`:
  - settle only on `mission.state === 'DONE'`;
  - read missions through `listMissions({projectId})`, which is LIMIT 100 by `updated_at` (`repos/russellMissions.ts:243-256`).
- Cash Mode 1 has more than 300 missions, and about 74% fail.
- Dealflow has held 3 of 3 slots since 2026-09-21. Industry nodes all show scans 0/10, and the bootstrap is "running".
- Labor already does this correctly (`labor/expand.ts:256-280`).

Fix:

- look up missions by the open rounds' candidate ids;
- settle HARVESTED on DONE and ABANDONED on FAILED or CANCELLED.

The same window is used in `commissionPass.ts:468`, `cash/discovery.ts:537` and
`cash/answers.ts:221`; audit and fix those together.

**RES-3 · A — The monetization allocator asks every open attribute of a BLOCKED path**

- `commission.ts:522-530`: ruleRank 10 applies to any open attribute on a BLOCKED path.
- `feeds()` always includes EVIDENCE_DEPTH and ANSWERED (`:159-175`), so the "cannot change a decision" filter almost never declines.
- 61 commissions asked, 2 answered, 53 unresolved. One path was asked 10 attributes in a row.
- `probabilityOfSuccess`, which §49 says nothing may propose, is still commissioned.

Fix: under BLOCKED, admit only the attribute the blocker names, and exclude
`probabilityOfSuccess`.

**RES-4 · A — Duplicate openings are enumerated and commissioned**

- 2,558 possibilities across 128 openings, 53 of them duplicates.
- `monetization/enumerate.ts:167,322` skip only ARCHIVED and DECLINED, not `duplicate_of_id`.

Fix: skip duplicates, and mark their existing rows `mergedInto` the primary.

**RES-5 · B — Discovery re-researches openings it already holds**

- The SLDC MBE/WBE RFQ was found dozens of times and has 4 primaries, 2 of which hold deep dives.
- `duplicates.ts` keys on URL plus signal family, so an index page and the document it links to are different keys.
- Held openings are never passed into the next round's question.

Fix: pass held source keys and titles as exclusions into the bucket question,
and widen duplicate keys to canonical document identity where one exists.

**RES-6 · A — Cards claim Brain can fulfil any opening**

- `answers.ts:678-695` derives delivery and fulfilment from `RESEARCH_A_QUESTION` alone.
- A Christmas-tree supply bid, a GitHub bug bounty and hauling all read "Brain, with a person reviewing".

Fix: derive these from labor needs and required capabilities, and withhold them
when the deliverable is physical.

**RES-7 · B — A QUALIFIED opening stuck on `exposure`**

- `cop_f2ddfa6e…`: 17/17 answered, both rounds spent, and `exposure` is withheld because no published cost states a figure.

Fix: raise a need for it (the one answering transition). This has low value
until RES-6 is fixed, because the opening is gig hauling.

**RES-8 · B — AWAITING_REPAIR packets with no answering transition**

- 5 packets, e.g. `orc_d0cd97…`. Their own reason: "awaiting a repair that has no claimable work and no scheduled time".

**RES-9 · B — NEEDS_HUMAN with no reason recorded**

- 6 packets and 54 missions. A person cannot answer them.
- The site that writes them has not been identified.

**RES-10 · C — Stale claimable work items**

- LEASED with expired leases from 09-17 to 09-21 while still under their ceilings: `wki_570933…`, `wki_d4e85d…`, `wki_0b50f8…`, `wki_2ff3dd…`.
- Over-ceiling LEASED rows: `wki_207ff7…` 4/2, `wki_7b51a4…` 5/2.
- Probably attached to parked or cancelled packets with no bin. Not verified; MCP timed out.

**RES-11 · D — Owner prerequisites for any revenue**

- `commercial_grant=ABSENT`.
- Resend and Stripe secrets are unset, so MESSAGING, INVOICES and PAYMENTS all read MISSING.
- Even a READY opening cannot be contacted, invoiced or paid.

**RES-12 · A — Reports truncate or contradict**

- (a) The Cash report caps ideas and missions at 100 and work items at 500 (`scripts/cash-report.ts:186,226,287`). So it prints "missions 100 — FAILED=74" beside an uncapped 308.
- (b) The Cash report prints no money ledger.
- (c) The connection report prints "connectors needing a person: 0" beside 5 ACCOUNT_OWNER alerts (`connection-report.ts:271-273` counts only `HUMAN_REAUTH_REQUIRED`).
- (d) PARKED ideas print the priority sentence rather than the park reason.

**RES-13 · C — Validation plans are refused by the approval envelope**

- 5 packets, "fragment 'opening-validation' … outside the preauthorized envelope". The full reason is truncated in the report.

**RES-14 · C — The industry map holds the same sectors twice, across classification systems**

- This is deliberately not merged (§38). Recorded as a cost only.

### 2.4 Software Factory, release, CI, engineering workflow

**FAC-1 · A — A campaign has read "EXECUTING — units in flight" since 09-27 and can never move**

- Campaign `fcp_f359799f…`.
- `remoteLoop.ts:1638-1644` counts dependency-BLOCKED units as outstanding, and the early return at `:1780-1786` precedes the failed-unit check at `:1810`.
- Fix exists as PR #193, which touches only `remoteLoop.ts` and its test. **A person must merge it**, because it touches release-excluded Factory paths.

**FAC-2 · C — Units of `fcp_f359799f…` exhausted 3 attempts because a needed test file was outside their scope**

- The ownership validator should have prevented this (§27 `REQUIRED_FILE_NOT_WRITABLE`).
- Check: `factory events --campaign fcp_f359799f…`.

**FAC-3 · D — Automatic rollback cannot open its revert PR**

- GitHub refuses with "Actions not permitted to create … pull requests".
- PR #178's change (`adfa949`) is still live after a FAILED release.
- Owner action: Settings → Actions → General → Workflow permissions → allow Actions to create and approve PRs.

**FAC-4 · A — Every human-dispatched Deploy triggers two release passes**

- Runs 96/97, 93/94, 91/92 and others, each pair a few seconds apart and each opening a `flyctl ssh` session against the saturated database.
- Cause: `factory-release.yml:63-65` (`workflow_run`) plus `deploy.yml:879-893` (`hand-off`).
- Fix: have `hand-off` fire only when the Deploy actor is the bot, or drop `workflow_run`.

**FAC-5 · A — A release plan for a campaign with no grant polls 15 times and holds the release slot**

- Run 38211775607 printed `RELEASE-PLAN: null` ×15.
- Cause: `release/plan.ts:72` returns null for both "no grant" and "not complete yet".

**FAC-6 · A — Deploy races between sessions**

- 6 of 17 recent Deploy failures (433, 436, 438, 440, 443, 446) each spent about 28 min of tests, then were refused by the second canonical check.
- Fix:
  - run the freshness check at the start of the test job too;
  - report "superseded" as neutral rather than red;
  - only one session dispatches Deploy (see Integration).

**FAC-7 · A — The Postgres gate is cancelled before released commits pass it**

- `postgres-suite.yml:72-74` sets `cancel-in-progress: true` on `production`. 92 of 200 runs were cancelled.
- Commits `4fcb143`, `b2e2589`, `8cc6fab` and `4bff1c2` were released without a completed Postgres run.
- Fix: do not cancel on the canonical branch. Or have Deploy require a green Postgres run on its commit, or on a descendant that contains it.

**FAC-8 · A — The engineering hook never sees `send_later`**

- The matcher `mcp__Claude_Code_Remote__send_later` (`.claude/settings.json:100`, `engineering-guard.mjs:53`) does not match the real tool name, `mcp__claude-code-remote__send_later`.

**FAC-9 · A — The hook's full-suite regex is anchored and misses ordinary forms**

- `engineering-guard.mjs:41`.
- `scripts/test-postgres.sh run -- npx vitest run` and `npx vitest run --reporter dot` both pass.

**FAC-10 · C (policy) — Pushing to the canonical branch by refspec is permitted**

- `Bash(git push origin claude/:*)` also matches `git push origin claude/x:production`.
- CLAUDE.md §28 instructs exactly this fast-forward push, so it is the documented path, not an accident.
- The owner decides whether sessions may advance `production` at all. If not, add a deny rule and a test. If yes, leave it, and document that the deny list does not cover it.

**FAC-11 · D — GitHub cron is unreliable**

- The `factory-release` and `production-guard` schedules run about every 3–7 h instead of every 15 min / 1 h.
- Already mitigated by event triggers (§58). The workflow header comment is now misleading.

**FAC-12 · A — 72 open PRs, including migration-colliding stacks**

- PRs #94–#97 add migrations 100–103 / pg 091–094, which production already uses for other files. GitHub shows them as mergeable, and merging would refuse boot.
- #134 is superseded.
- #3 is the branch that restored `/operator` (§28).
- 53 stale Factory PRs.
- Fix: close the superseded ones, and decide whether the stacks are retired or renumbered. This needs the owner's authorization to close PRs.

**FAC-13 · A (owner decision) — CLAUDE.md is about 937 KB and 13.8k lines, injected into every session, and touched by about 14% of commits**

- This is the largest single context cost and merge-conflict source for parallel work.
- Fix: keep the rules and invariants, and move incident narratives to `docs/`. Owner decision on documentation policy.

**FAC-14 · B — Release gate wall time exceeds 1.5 h**

- Postgres suite about 42 min, then Deploy SQLite about 28 min, then hosted verification about 30 min.
- The full Postgres suite is unsharded, and successful runs span 37–71 min.
- Sharding would roughly halve the gate. Not required today.

**FAC-15 · C — About 60 campaigns read REMOTE COMPLETE with their PRs never merged; 5 BLOCKED campaigns since September**

- Not established: whether Build shows these as a person's action. Read the five blocker reasons.

**FAC-16 · E — Historical flakes, fixed**

- `persistence.test.ts`.
- `operationsListIndex.test.ts`.
- `cashPostSale.test.ts:1643` failed once (C, watch).

---

## 3. Shared root causes

**SR-1 — Database throughput.** INF-1, INF-2, INF-3, INF-5, INF-6, CON-1, CON-2, CON-6, CON-10, RES-10 (probably), FAC (hosted-verification failures 420, 422, 425, 439, 444, 450, 456; boot failures 424, 453, 454) and the report failures all trace here.

Two halves:

- **External.** Supabase capacity (owner).
- **Internal.** Brain's own waste:
  - timers rescanning unchanged rows;
  - long transactions;
  - connection churn;
  - check-in triggering the factory tick.

Shrinking the internal half is the largest single lever available today. Making
check-in and authentication independent of that load (CON-1, CON-2) removes the
user-visible "connector down" class even before the database recovers.

**SR-2 — A windowed or unbounded read treated as the whole truth.**

- RES-2: kernel rounds never settle.
- RES-12a: report counts are truncated.
- Commissions, discovery and answers use the same window.

One correction applies everywhere: read by key (candidate ids, round ids), not
"the last 100 rows".

**SR-3 — Two readers of one fact disagree, and a status lies.**

- INF-7: Deploy says "not released".
- CON-5: the OUT_OF_SCOPE cause is wrong.
- CON-6: AMBIGUOUS is counted as a failure.
- RES-1: a packet fails although its evidence is cited.
- RES-12c: "0 need a person".
- FAC-1: "units in flight".

The fix in each case is to derive the sentence from the same predicate that
makes the decision.

**SR-4 — Multi-session repository and CI contention.**

- FAC-6: deploy races.
- FAC-7: cancelled Postgres runs.
- FAC-12: colliding migration stacks.
- FAC-13: CLAUDE.md conflicts.
- Migration-number collisions (§47–§49).

This is solved by process (one deployer, reserved migration numbers, no
CLAUDE.md edits in workstreams), plus FAC-6 and FAC-7.

**SR-5 — Research spend that cannot change an outcome.**

- RES-1: the gate blocks most packets.
- RES-3: commissions on attributes that cannot change a decision.
- RES-4: duplicates.
- RES-5: re-discovery.

These four together consume most of the Routine fleet's allowance and produce no
qualified work. Fixing them is what makes research *useful*. SR-1 only makes it
*run*.

**Is the architecture sufficient?** Yes. Every confirmed fix above is a
targeted modification inside an existing owner. No finding shows a structural
limit of Brain's design. The one possible structural limit is Supabase
session-mode pooling against a small compute tier (INF-1, INF-3). The remedy
there is capacity, or transaction-mode pooling. Transaction mode would mean
reworking the per-session `SET`s and the pinned transactions, so it should only
be undertaken if the INF-2 measurement shows the pooler, not CPU or IO, is the
bottleneck. No outside framework is warranted by the evidence.

---

## 4. Repair inventory and dependency map

### 4.1 Essential for reliable operation

| Id | Work | Depends on |
|---|---|---|
| R1 | Owner: Supabase dashboard reading, plus a resize decision (INF-1) | — |
| R2 | Measurement split: checkout vs execution, event-loop delay, wait events and locks in the report (INF-2) | — |
| R3 | Await pool `SET`s (INF-4); idle-timeout churn fix (INF-3, after R2's hourly delta) | R2 for INF-3 |
| R4 | Stop polls that produce nothing (INF-6 a–e) | — |
| R5 | Shorten recompute and effect transactions (INF-5) | R2 (per-statement breakdown) |
| R6 | Bound check-in end to end; no `deriveReadyWork` under pressure (CON-1); record the plane correctly (CON-7) | — |
| R7 | Control-plane hold times and rotation off the 2-connection pool (CON-2) | R2 |
| R8 | Deploy truthfully records what is running (INF-7) | — |
| R9 | Boot-migration index guard (INF-8) | — |

### 4.2 Essential for useful outcomes

| Id | Work | Depends on |
|---|---|---|
| U1 | Kernel and commission round settlement by key, with ABANDONED on failure (RES-2) | — |
| U2 | Measure why fragments block (RES-1 check); then targeted question/lane fix, or an owner decision on filing short | Measurement before fix |
| U3 | Commission allocator blocker-only and no `probabilityOfSuccess` (RES-3); skip duplicates (RES-4) | — |
| U4 | Discovery exclusions for held openings (RES-5) | — |
| U5 | Truthful fulfilment and delivery on cards (RES-6) | — |
| U6 | Answering transitions: AWAITING_REPAIR (RES-8), reasonless NEEDS_HUMAN (RES-9), stale items (RES-10) | RES-10 check |
| U7 | Owner: commercial grant plus Resend/Stripe secrets (RES-11) | Owner decision |
| U8 | Merge PR #193 (FAC-1) | Owner merge |
| U9 | Airyn and Caleb connector config (CON-4, CON-8, CON-9) | Account owners |

### 4.3 Recurrence prevention

| Id | Work |
|---|---|
| P1 | Wrong-worker flap rule (CON-3) |
| P2 | Outage-AMBIGUOUS not counted (CON-6) |
| P3 | Alert texts derived from the deciding predicate (CON-5) |
| P4 | Reports count by SQL, print the ledger and the park reason, and count alerts (RES-12) |
| P5 | Postgres gate not cancelled on `production`; Deploy freshness at the test start, with superseded reported neutral (FAC-6, FAC-7) |
| P6 | Single release pass (FAC-4); no-grant early exit (FAC-5) |
| P7 | Hook matchers and regex (FAC-8, FAC-9) |
| P8 | PR clean-up and the colliding stacks (FAC-12) |

### 4.4 Performance (evidence-backed)

- Connection churn (INF-3).
- Shared-findings read (INF-6c).
- Postgres suite sharding (FAC-14).

### 4.5 Optional, not required today

- CLAUDE.md slimming (FAC-13): high value, but conflicts with everything else in flight. Do it after today's merges.
- Industry duplicate sectors (RES-14).
- Retiring the seven one-off proof workflows.
- RES-7 exposure need.

### Dependency map

```
Owner now (parallel): R1 Supabase · U7 grant/secrets · U8 merge #193 · U9 connectors · FAC-3 Actions PR perm · FAC-10/12/13 decisions

WS-A db+obs ─┐ (R2,R3,R4b-c,R5,R9,INF-6c, report wait/locks)
WS-B conn    ─┤ (R6,R7,P1,P2,P3, R4a connector-health gating)       ─┐
WS-C research┤ (U2 measure→fix, U6)                                  ├→ WS-F integrate: merge order A→B→C→D→E,
WS-D cash/kern┤ (U1,U3,U4,U5,P4)                                      │   one Deploy per batch, then verify
WS-E factory/CI┘ (R8,P5,P6,P7,FAC-2, R4d factory_campaigns read)      ─┘
            after #193 merged: WS-E touches remoteLoop.ts
```

---

## 5. Recommended assignment count: 6

That is 5 parallel implementation sessions plus 1 integration and verification
session. The number comes from five disjoint code-ownership regions that do not
depend on each other's code:

1. `server/db/*`, the report scripts, and the hot non-connector polls;
2. connection and fleet services, plus check-in;
3. the research engine;
4. Cash, monetization and kernels;
5. Factory, workflows and hooks.

Fewer sessions would serialize unrelated code. More would split files two
sessions must both touch (e.g. `connectorHealth.ts` and `connectionAlerts.ts`
belong together), or create sessions with under an hour of work. Integration is
separate because deploy dispatch must have exactly one owner (FAC-6, §28).

## 6. Assignment ownership

Every assignment follows these rules:

- branch from `origin/production`;
- `npm run typecheck && npm run test:impacted`, plus `npm run test:pg` if persistence changed;
- **do not dispatch Deploy**;
- **do not edit CLAUDE.md**: put a 5–15 line note for it in the PR body;
- **no migration** unless unavoidable. The reserved numbers are:

| Workstream | SQLite | Postgres |
|---|---|---|
| WS-A | 116 | 107 |
| WS-C | 117 | 108 |
| WS-D | 118 | 109 |

- no `CREATE INDEX` on `identity_events`, `bin_events` or `project_events` in a migration;
- open a PR into `production` and stop.

**WS-A — Database load and observability**

- Owns:
  - `server/db/adapters/postgres.ts`, `server/db/infra.ts`;
  - `scripts/connection-report.ts`;
  - `server/services/connect/service.ts` refresh;
  - `server/repos/sharedFindings.ts` read path;
  - `server/services/stateEngine.ts` transaction scope;
  - `server/services/effects/engine.ts` (hold-time only);
  - a new migration-guard test.
- Delivers:
  - INF-2 instrumentation (checkout vs execution, event-loop delay, wait events and `pg_locks`, stats-reset time);
  - INF-4;
  - INF-3 after a measured delta;
  - INF-5;
  - INF-6 b and c;
  - INF-8;
  - RES-12c (alert count in the connection report).
- Verify: the connection report shows the new fields, and statement and transaction totals fall against the 20:36Z baseline.

**WS-B — Connection, check-in and fleet correctness**

- Owns:
  - `server/services/bins/service.ts` (check-in only);
  - `server/services/fleet/{arrivalIdentity,autoRecovery,recoveryProbe,connectionAlerts,connectorBinding,connectorHealth}.ts`;
  - `server/routes/oauth.ts` rotation transaction scope;
  - the dispatch tick heads (`dispatch/loop.ts`, `candidates.ts`) for INF-6e.
- Delivers: CON-1, CON-2 (hold scope), CON-3, CON-5, CON-6, CON-7, INF-6 a and e.
- Verify:
  - a test for each refusal;
  - in production, check-in p95 under 60 s;
  - no 2-C quarantine/lift cycle in 24 h;
  - 3-B's next probe after the outage is not counted.

**WS-C — Research engine outcomes**

- Owns `server/services/research/{packetRunner,gate,reissue,outcome}.ts` and `server/repos/research.ts`.
- First, one read-only SQL measurement through the console door: the `blocked_reason` / gate-condition distribution for Cash Mode 1, last 7 days. Report it.
- Then:
  - targeted fix for whichever cause dominates, within the evidence bar;
  - RES-8 answering transition;
  - RES-9: find and fix the writer of reasonless NEEDS_HUMAN;
  - RES-10: identify which packets own the stale items and retire or deliver them.
- Stop and escalate if the fix needs filing short over uncovered mandatory requirements (invariant 20).
- Verify: the share of gate-failed missions in the next Cash report, and no AWAITING_REPAIR without a transition.

**WS-D — Cash, monetization and kernels usefulness**

- Owns:
  - `server/services/{dealflow,industry,manufacturing,puzzle}/expand.ts`;
  - `server/services/cash/monetization/*`;
  - `server/services/cash/{discovery,answers,duplicates}.ts`;
  - `scripts/cash-report.ts`.
- Delivers: RES-2 (and the same window in commissions, discovery and answers), RES-3, RES-4, RES-5, RES-6, RES-12 a, b and d.
- Verify:
  - dealflow and industry slots free within one tick after deploy;
  - commissions per path drop;
  - the Cash report counts match SQL and print the ledger.

**WS-E — Factory, release, CI and engineering workflow**

- Owns `.github/workflows/{deploy,postgres-suite,factory-release}.yml`, `server/services/factory/release/*`, `scripts/factory-release.ts`, `.claude/settings.json`, `.claude/hooks/*`, and `server/services/factory/remoteLoop.ts` (only after #193 is merged).
- Delivers: INF-7, FAC-4, FAC-5, FAC-6, FAC-7, FAC-8, FAC-9, FAC-2 (read the events, and fix the ownership validator if confirmed), and the `factory_campaigns` read and heartbeat contention (INF-6d), after #193.
- Verify: workflow tests, the next human Deploy produces one release pass, and a superseded Deploy reads neutral.

**WS-F — Integration and production verification (sequential, last)**

- The only session that dispatches Deploy.
- Merges the PRs in the order A → B → E → C → D:
  - infrastructure relief first;
  - E before C and D, so the Postgres gate fix is in before the bigger diffs land.
- Before each merge:
  - re-read the highest migration number in both chains;
  - run `test:impacted` on the merged tree.
- Batch into at most two Deploys. Watch each to its verdict (rule 4).
- Then run the verification plan (§8) and write the one consolidated CLAUDE.md section.

## 7. Integration plan

- **One deployer.** Only WS-F dispatches Deploy. The other sessions push branches and open PRs. This removes the FAC-6 races.
- **Migrations.** Use the reserved numbers above. WS-F renumbers on collision, and only before first application (§3 checksum rule).
- **CLAUDE.md.** No workstream edits it. WS-F writes one section from the PR notes after the last merge.
- **Order.** A → B → E → C → D. A and B reduce load, so the deploys after them are more likely to boot and pass verification.
- **Postgres gate.** Wait for the Postgres suite on each merged tip before dispatching Deploy, until P5 has landed.
- **Hot files.**
  - `server/domain/types.ts` and `server/mcp/tools.ts` are shared. Any session that must touch them keeps the change additive and minimal.
  - `remoteLoop.ts` waits for #193.

## 8. Verification plan

Production is proven only by readings taken from the released revision:

1. **Connection report** (same run type as 20:36Z). Targets:
   - check-in p95 under 60 s;
   - authenticate p95 under 2 s;
   - no `UNSERVED_ARRIVAL` for 1 h;
   - `DISCARD ALL`/`get_auth` and the top statements' hourly deltas reduced;
   - wait events and event-loop delay printed;
   - alert counts consistent.
2. **Fleet.**
   - 2-B, 2-C and 2-D arrive as `wkr_9826` after the owner's fix, and the quarantine lifts by itself.
   - No 2-C oscillation for 24 h.
   - Caleb 3-B is probed with the database healthy.
3. **Cash report.**
   - Dealflow and industry rounds settled or abandoned.
   - Kernel slots free.
   - Commissions answered ratio up.
   - Counts uncapped.
   - Ledger printed.
   - Gate-failure share measured against the RES-1 baseline (308/521).
4. **Factory.**
   - `fcp_f359799f…` reads BLOCKED with `UNIT_EXHAUSTED_ATTEMPTS`.
   - The next Deploy produces exactly one release pass.
5. **Deploy.**
   - Hosted verification passes before and after the restart.
   - The `deployed/production` tag matches the running `BRAIN_REVISION`.
6. **Useful outcome (after U7).**
   - One sandbox invoice issued and read back through Stripe test mode (`tests/commercialProviders` is fake-only today).
   - At least one opening reaches READY_TO_TEST within the next discovery cycle. This is not provable today.

## 9. Human actions (owner or provider only)

1. **Supabase.**
   - Read CPU, disk IO budget, connections and pooler on the dashboard.
   - Decide whether to resize the compute. This is spending.
   - Optionally add `BRAIN_DATABASE_URL` as an Actions secret for the deploy pre-flight.
2. **GitHub setting.** Allow Actions to create pull requests (rollback).
3. **Merge PR #193**, or explicitly authorize a session to merge it.
4. **Airyn.** Set 2-B, 2-C and 2-D's Brain connector to the one authorizing as his research worker, and remove the factory connector from those Routines.
5. **Caleb.** Check 3-B, 3-C and Factory surface 3's connector selection in Claude.
6. **Revenue prerequisites.** Decide whether to grant commercial authority to Cash Mode 1, and set the Resend and Stripe secrets (sandbox first).
7. **Decisions.**
   - FAC-10: may sessions fast-forward `production`?
   - FAC-12: authorize closing stale or superseded PRs and retiring #94–#97.
   - FAC-13: CLAUDE.md slimming policy.
   - RES-1: if measurement shows the gate's coverage bar is what stops packets, whether a packet may file short (an evidence-policy decision).
8. Grant or deny Factory surface 1's out-of-scope project once CON-5 reports the real failing check.

## 10. Remaining unknowns

| Unknown | Why unknown | Smallest way to resolve |
|---|---|---|
| Supabase CPU/IO saturation vs pooler vs Brain event loop | Not readable from Brain; event loop not instrumented | Owner dashboard + WS-A instrumentation |
| Why fragments block | Not printed by any report | WS-C one SQL read |
| Goals register and research goals state | No report run; MCP timed out | `npm run goals` read via the Goals workflow, after load relief |
| Labor, design, capability, puzzle and manufacturing kernel output | No production report read | Their report workflows, after load relief |
| Money ledger figures | Cash report does not print them | WS-D (RES-12b) |
| Who owns the stale work items (RES-10) | MCP timed out | WS-C SQL read |
| Real failing check behind Factory surface 1 OUT_OF_SCOPE | Report collapses causes | `fleet explain` / CON-5 |
| Caleb 3-B/3-C no-show cause | Needs incident overlap and a healthy-time probe | CON-8 check |
| Whether branch protection would stop a refspec push to `production` | Environments/branch API blocked via proxy | Owner reads repo settings |
| `fcp_f359799f…` unit ownership history | Rows not read | `factory events` |
| PR #178 revert failure: 403 vs network | Log ambiguous | Re-read run 38181885679 |
| `pg_stat_statements` window | Reset time not printed | WS-A prints `stats_reset` |

No claim is made here that every possible failure has been found. The main
blind spots are:

- the provider side (Supabase, Claude Routines' internal configuration, the GitHub scheduler);
- kernels whose reports were not read;
- anything that only appears once the database is healthy enough for work volume to rise.

**Same-day feasibility.** As of about 21:30Z the remaining UTC day allows
roughly two Deploy cycles (each 60–90 min, with gate and verification).
Completion today is uncertain for two reasons:

- deploy boot and verification currently fail on INF-1 until the database eases or is resized;
- U2 and the RES-1 decision depend on a measurement taken first.

WS-A, WS-B, WS-D and WS-E can all be implemented and opened as PRs today
regardless.
