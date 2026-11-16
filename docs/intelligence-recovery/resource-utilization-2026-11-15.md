# Brain resource utilization: baseline 2026-11-15 22:15Z, and the changes it led to

Directive: owner, 2026-11-15 ~22:05Z (full resource utilization, capacity allocation and scaling audit). This file is the **start** reading for the eight-hour comparison. Every figure is a production read; resource classes are separate pools and are never added together. "not measured" means no reading exists, never zero.

Sources: connection report runs 43767404016 (22:06Z) and 43768266235 (22:15Z), productivity report 43767409816, RunPod report (cheap lane 43767406968, 8 h), `brain_operator_capacity` at 22:05Z, 22:07Z and 22:15Z, Deploy runs 1093–1105, and the session list.

## Start reading (window 14:06Z–22:15Z)

| resource | capacity | measured use | idle / headroom | bottleneck |
|---|---|---|---|---|
| App server CPU | 2 dedicated vCPU | ~10% machine at steady state (processes 30+ min old: 9.8%, 10.6%); 40–61% for 2–3 min after each restart; steal ≤0.4% | ~90% | CPU-bound planning stalls of 2–4 s (`planSet.canonical`, `quant/reconstruct`, evaluator pool) |
| App server memory | 4 GB; V8 heap limit 2,608 MB | RSS 1,207–2,157 MB; heap 517–951 MB | 47–71% | none |
| GC | — | 1.5–2.9 s of every 60 s profile; 11–20% of on-CPU time | — | — |
| Event loop | — | p50 20 ms, p99 25–74 ms, max stall 4.1 s | — | the stalls above |
| App DB pool | 8 workload + 2 control | 2–6 workload idle; 0 waiting; checkout p95 0–2 ms | 25–75% | none |
| DB host (Supabase) | 2 vCPU, 2 GB RAM, max_connections 90 | **70% CPU** (user 64.8%, iowait 1.3%, steal 0.1%; 531 s between reads); 65% memory used; root disk 84% full; 24 backends | 30% CPU | one report-only query (below) |
| GPU (RunPod) | 1 pod, RTX 2000 Ada 16 GB, Qwen3-4B-AWQ, 2 slots, $0.19–0.24/h | **stopped ~440 of 480 min**; 109 refused starts ("not enough free GPUs on the host machine"); 2 jobs | unavailable | host capacity |
| Free lane, brain-a (OmniRoute free providers) | controller target 12 | 0 of 104 items accepted; provider failure 97% (1 h), 91% (6 h); quota 0% | — | provider availability |
| Claude Routines | target 12, 13 eligible surfaces | 0–1 active; research routines last checked in 12:57Z | 92–100%, beside 1 executable item | dispatch (below) |
| Factory | 3 surfaces registered, 1 usable (surfaces 1 and 3 quarantined: cannot authorize) | 90 assigned, 86 accepted in 8 h (10.8/h); at 22:15Z 1 executable, 1 free surface, 0 running | — | one surface; dispatch |
| Research slots | 13 (grant ceilings) | 13/13 | 0; 538 waiting, 537 at grant ceilings | grants (§16/§52) and the dead free lane |
| Release pipeline | 1 Deploy at a time, ~28 min | 12 finished in 8 h (~70% busy); 6 succeeded | ~30% | 50% failure rate |
| Claude Code sessions | plan limit not measured | 2 working (Evolution Engine; this audit); 9 waiting on a person | — | — |

**Attribution.** Engineering work in the window was ~90% up curve (9 Evolution Engine PRs, 3 Factory releases) and ~10% down curve (#947 R-SLOW-RESTART, verification repairs). Inference and research slots are all normal Brain operations (the $10K goal). Server and database CPU cannot be attributed by process identity (one Node process); profiles name planning code, and the database's one large consumer is named below. The rest is UNATTRIBUTED.

**Split of each class's measured capacity (each row sums to 100%).** These figures are utilization, not allocation.

| class | up curve | down curve | normal ops | idle / reserved | unavailable | unattributed |
|---|---|---|---|---|---|---|
| App CPU (2 vCPU) | 0 | 0 | 7 | 90 | 0 | 3 |
| App DB pool (8) | 0 | 0 | 11 | 50 | 0 | 39 |
| DB host CPU (2 vCPU) | 0 | 0 | 43 | 30 | 0 | 27 |
| GPU (2 slots) | 0 | 0 | 0 | 8 | 92 | 0 |
| brain-a (12 slots) | 0 | 0 | 0 | 0 | 100 | 0 |
| Routines (12) | 4 | 0 | 0 | 96 | 0 | 0 |
| Factory (1 usable of 3 surfaces) | 33 | 0 | 0 | 0 | 67 | 0 |
| Research slots (13) | 0 | 0 | 100 | 0 | 0 | 0 |
| Release pipeline | 58 | 12 | 0 | 30 | 0 | 0 |

**Allocation versus utilization.** Of the active engineering work, ~90% was up curve. Engineering capacity itself was mostly idle (Routines 4%, Factory 1 of 3 surfaces). Utilization is read from leases, running items, process CPU and database time, never from queue length. Waiting work is not counted as capacity: 538 waiting ideas are reported as waiting, and the slots are only the 13 that exist. Running is not productive either: the lane "ran" 220 items in 8 h and 2 were accepted.

**Throughput.** Merged PRs: 12 (1.5/h). Deploys fully released: 6 (0.75/h). Factory units accepted: 10.8/h. Accepted research claims: **2/h**, against 25.1/h in the 8 h before. Plan evaluations: 5.5/h, against 13.3/h. Kept improvement outcomes: 0 of 2 (6 h).

## Inference and model endpoints (8 h)

| measure | GPU route (runpod/Qwen3-4B-AWQ) | brain-a (OmniRoute free providers) |
|---|---|---|
| available endpoints | 1 pod, 2 slots; GPU memory 16 GB (RTX 2000 Ada) | 1 switchboard, controller target 12 |
| actual requests | 116 items attempted, 2 submitted | 104 items attempted, 0 submitted |
| requests per minute | 0.24/min attempted | 0.22/min attempted |
| tokens per second | not measured (vLLM metrics not scraped) | not measured |
| rate limits | none hit (providerQuota 0/209 over 6 h) | none hit |
| error rate | 98% not accepted; pod unavailable | 100% not accepted; provider failure 91% (6 h) |
| average latency | ~80 s per accepted research item | not measured (no accepted item) |
| concurrency | at most 2; average 0.3 jobs at once across the lane (8 h before: 1.1, peak 7) | — |
| pending requests | 29–31 research items waiting | same queue |
| cost per hour | $0.19–0.24 while running (recipe ceiling); ~0 while stopped; `BRAIN_RUNPOD_USD_PER_HOUR` unset, so the report could not price it | $0 (free providers) |

## Engineering and research detail

- **Claude Code sessions.** Plan concurrency limit: not measured. Running: 2 (Evolution Engine "the end?", productive; this audit). 9 sessions are idle on a person's action; 0 are blocked on capacity.
- **Factory.** Registered surfaces: 3. Active: 1 (surface 2, last check-in 22:05Z). Quarantined: 2 (surfaces 1 and 3: "3 consecutive fired sessions never checked in"). Free slots at 22:15Z: 1, beside 1 executable item. Completed: 86 accepted units in 8 h (10.8/h). 9 completions refused: 4 malformed `conflicts`, 2 missing PR number, 2 forge rate limit, 1 bad kind. 5 released: scope conflict, cause outside `tests/**`. Average productive task duration: not measured (no per-unit duration row).
- **Engineering agents.** Running: the Evolution Engine's worktree engineers (count not visible from here) and this session. Queued: 1 Factory item, 1 Routine item. Blocked: the 5 scope-conflict releases above.
- **Tasks completed per hour.** Merged PRs 1.5/h. Fully released deploys 0.75/h. Factory units 10.8/h.
- **Research.** Surfaces available: 13 grant slots, plus the free lane. Occupied: 13/13. Queue: 538 ideas, plus 29–31 free-lane items. Completion: 3 of 39 jobs in the last hour (7.7%), 57/250 over 6 h (22.8%), 1,274/2,471 over 24 h (51.6%). Evidence validation (claims accepted): 13/29 over 6 h (44.8%), 365/528 over 24 h (69.1%). Useful to planning: the $10K plan accepted buyer and price for 2 of 11 openings; 0 new openings in 8 h; 7 of the goal's last 7 rounds ended without a report.
- **Active vs queued vs blocked vs rate-limited vs idle (research).** Active: 13 grant missions, plus 4 free-lane items in flight at 22:15Z. Queued: 538 ideas and 31 lane items. Blocked: 537 ideas at grant ceilings, plus the lane's failing routes. Rate-limited: 0. Idle: Routines (0 of 12) beside 1 executable item.
- **Disk and network.** Database disks were busy 0.7% and 5.8% of the window. Root disk is 84% full (1.71 GB free of 10.46 GB); /data is 47% full. The app opened 466 client sockets in 32 min, 235 of them to the database pooler (7.3/min).

## Safe operating limits (from the readings, per resource)

| resource | measured | operating limit | why this limit |
|---|---|---|---|
| App CPU | ~10% steady; 60% for 2–3 min after a restart | sustain ≤60% machine; event-loop p99 ≤100 ms | stalls of 2–4 s already occur at 10% average, so they come from single CPU-bound passes, not load; more concurrency on this CPU buys little |
| App memory | peak RSS 2,157 MB of 4 GB | ≤3 GB RSS, heap ≤2 GB of 2,608 | #947 measured an OOM in the verifier at 4 GB; restart peaks sit near 2.2 GB |
| App DB pool | 0 waiters, 8 workload | keep `waiting` at 0 and checkout p95 <50 ms; the free lane keeps its share of 3 of 6 (#922) | pool exhaustion recorded twice on 11-15 (00:03Z, 01:12Z) |
| DB host CPU | 70% (with the 55 s query) | ≤60% sustained; `db/pressure.ts` sheds optional work above its p90 | 2 vCPU are shared by every Brain path (§61) |
| DB host memory and disk | 65% memory; root disk 84% | memory ≤80%; root disk ≤85%. It is at 84%, managed by Supabase, and re-read in the end reading | 1.37 TB of temp spills since stats began |
| GPU | 2 slots | the controller's measured ceiling (2 on 4B AWQ) | grows only on measured acceptance (stageCapacity) |
| Release pipeline | ~70% busy | one Deploy at a time; merge only between Deploys | a merge during a Deploy supersedes it (P-12) |

The controllers that already raise and lower concurrency stay in charge: free-lane `stageCapacity` grows on acceptance and halves on errors, `db/pressure.ts` defers optional work, and the §98 watchdog records idle-beside-work. This audit adds no second controller. Hermes runs on the same switchboard as research, and no separate engineering-inference compute is needed while that lane is idle.

## Down-curve reserve (minimum, measured)

Surge A (reliability) holds no dedicated agents. Its open items: R-SLOW-RESTART, shipped in #947 and in Deploy 1105; the 50% Deploy failure rate; and the 2 quarantined Factory surfaces. The minimum reserve is process-level, and all of it is kept: Deploy's two verification passes, the hourly report routine, Hermes' self-scheduled runs, and incident response by the session that holds the incident. Everything else is up curve. On an incident (Deploy fails after restart, `/healthz` above 5 s, or the pool exhausted), the owning session redirects its engineers to it first and releases them after recovery. That is the protocol already in `resource-allocation.md`, kept unchanged. Regressions are caught by the Postgres suite on every canonical push and by Deploy's full SQLite suite. No worker was taken from unfinished cleanup: #947 was left to release, and this audit's merge waited for its Deploy. Freed capacity returns to the up curve automatically, because Factory and Routines are dispatched by rank, never by a surge label.

## What limits engineering

| candidate constraint | reading | binding? |
|---|---|---|
| Number of coding agents | Routines 0–8% busy, Factory 1 surface with a free slot | no |
| Claude subscription capacity | no quota refusal recorded; Routines idle | no (limit not measured) |
| Factory registration or routing | 2 of 3 surfaces quarantined; dispatch starved (fixed) | **yes** |
| Model inference throughput | GPU and brain-a both down | **yes, for research** |
| CPU or GPU resources | app CPU ~10%; GPU unavailable | GPU yes, CPU no |
| Task dependencies | the $10K plan waits on buyer evidence that research did not produce | yes |
| Code ownership conflicts | 5 Factory releases: cause outside `mutationScope` | minor |
| Integration and verification | Deploy ~70% busy, 50% failing | **yes** |
| Research evidence availability | 2 claims/h | **yes** (because inference is down) |

Models are idle while engineering assignments wait, so the fault is in routing and registration, not missing capacity: dispatch starvation (fixed) and the quarantined surfaces (they need the surface owner's connector re-authorized). Dispatch diagnosis (run 43771922118, 22:56Z) names the waiting items:
- Factory's "1 executable item, 1 free surface" is a pair of `FACTORY_SURFACE_PROBE` bins pinned to the quarantined surfaces (`ALL_SURFACES_INELIGIBLE`, 34 tries each).
- The Routines item is a bin in prj_ede218e7… that no surface serves (`NO_SURFACE_SERVES_THIS_PROJECT`, 34 tries).
- Factory units 18:20–20:12Z waited on `ACCOUNT_TARGETS_REACHED`, a per-account cap that worked as intended.

None of these is idle capacity that could be reassigned. The watchdog's "unexplainedly idle" and "a fault" wording counts a pinned probe as executable work. Adding agents removes none of these constraints. Inference is not saturated (it is unavailable), and no suitable worker class is fully occupied, so no extra capacity is justified by occupancy.

**Bottleneck resource:** model inference for research (GPU and free providers down), then integration and verification (one Deploy at a time, 50% failing).

**Duplicate work.** The productivity report counts 937 fragments in 30 days that re-asked an accepted question. 531 of them are `hosted-verification-fragment`, which each Deploy re-asks on purpose. The market-signal re-asks stopped on 11-11 (0 in the last 24 h). No live duplicate was found to consolidate.

## Throughput estimates (with uncertainty)

- **Now (measured):** verified engineering improvements 0.75 released deploys/h; Factory units 10.8/h; research claims accepted 2/h; plan evaluations 5.5/h; Hermes-directed improvement outcomes kept 0/h (0 of 2 in 6 h).
- **Sustainable with existing resources:** the 8 h before the outage measured 25.1 accepted claims/h and 13.3 plan evaluations/h on the same pool. That is the evidence-backed sustainable rate.
- **After reallocation (the two fixes):** research back to roughly 25 claims/h if the GPU serves again (one reading, so medium confidence). Dispatch cadence ×6. The database host should lose about 0.86 of a core. The Factory and Routine effect is not estimated until it is measured: one reading would be a guess.
- **After more spending:** no measured constraint is removed by money, so no forecast is made.

## Defects found and changed

1. **Dispatch starvation (PR #949).** `laneCoverage()` always ran `consumedLastDay`, a correlated count over `work_items` × `bin_events` that took 48–82 s a read (30 reads, 1,652 s of database time in 32 min). Only `admin free-lane show` prints it. `watchDisplacedWork()` awaits it inside `dispatchTick` once a minute, so the 10 s dispatch loop ran about once a minute, `dispatchTickIfIdle` (the Factory stage handoff) declined, and roughly 0.86 of a database core was spent on it. Now it runs only on the admin readout's request.
2. **GPU stranded on a full host.** A stopped pod stays on its host, and nothing moved it when that host's GPUs were taken. This audit moved it once by hand (cheap lane 43768013494, `runpod-upgrade`, active recipe, same price ceiling). The permanent fix is the Evolution Engine's #950, merged in parallel: the server moves the pod after 3 host refusals while research waits. This audit's own workflow-level mover was dropped as a duplicate mechanism (rule 6). Result at 22:24Z: new pod 8hkqnboqyv6kad (RTX 2000 Ada, $0.19/h) served after 595 s, every probe passed (tool calls, 64K context, 4 in parallel), it is connected as slot A, and odsft6ptpi2reh is retired.
3. **Why brain-a accepted nothing.** Cheap lane `test` (run 43771040346, 22:45Z): brain-a answered HTTP 429 because "[cerebras] All 1 connection(s) credits exhausted — please reconnect in the dashboard (HTTP 402)". brain-b answered `ALL_TARGETS_SKIPPED` (every target quota-exhausted). The free providers' credit is the owner's to reconnect in the OmniRoute dashboard. Brain records these as provider availability, not quota, so `providerQuota` read 0% while the cause was quota. With the GPU back as slot A, research no longer depends on them.

## Scaling options, priced

Prices are the RunPod recipe ceilings in `cheap/runpodRestore.ts` (measured $0.19–0.24/h for this pod) and the community prices from runpod-survey 43281884981. Fly and Supabase plan prices were not read in this session, so they are marked unpriced and no figure is invented for them.

| option | extra $/h | total expected (8 h) | bottleneck removed | expected productivity | completion time | confidence | release at once |
|---|---|---|---|---|---|---|---|
| Move the GPU to a host with stock (**done**) | 0 (same pod) | ≤ $1.92 of pod time, as before | GPU unavailable | research back toward 25 claims/h from 2 | the $10K plan reads again at the pre-outage rate | high | yes (idle auto-stop at 15 min) |
| Unblock dispatch (**done**) | 0 | 0 | dispatch cadence; DB CPU | dispatch ×6; DB host −0.86 core | Factory and Routine handoffs on time | high | — |
| Second GPU pod | +0.19–0.24 | +$1.52–1.92 | none: before the outage the GPU averaged 1.18 of 2 slots busy | ~0 until research waits on inference | none | medium | yes |
| Stronger model on the GPU (qwen3-8b-awq, 16 GB) | ~0 | ~0 | claim quality (44.8% accepted over 6 h) | unknown until `runpod-bench` on Brain's tasks | unknown | low | yes (`runpod-upgrade` back) |
| Additional isolated agent compute | unpriced | — | none: Routines 0–8% busy | ~0 | none | high | — |
| More concurrent coding agents | 0 (subscription) | 0 | none until surfaces are authorized and dispatch runs | ~0 | none | high | — |
| Additional research capacity (raise grant ceilings) | 0 money | 0 | grant ceilings (§16/§52; a person's ceiling, never raised by Brain) | ~0 while the lane is down; re-judge after | — | medium | yes |
| Larger app CPU or memory | unpriced | — | none: CPU ~10%, memory ≤53% | 0 | 0 | high | — |
| Larger database | unpriced | — | DB CPU 70%, mostly the removed query | re-judge on the post-fix reading | — | medium | plan change |
| Better model routing | 0 | 0 | routing a failing provider's role to the other model (already done by stageCapacity) | covered by the GPU move | — | — | — |

**Best value:** the dispatch fix ($0). **Fastest justified:** the GPU move (at most $0.24/h, existing infrastructure). **Spending more accomplishes little** while idle pools sit beside waiting work. No consolidated funding request is made. The shared $100 ceiling is untouched ($0 committed by this audit) and is counted once.

## Verified after release (2026-11-16 00:32Z)

#949 reached production in Deploy 1109 (f76dbc7, "Deploy to Fly" succeeded 00:19:23Z). Deploys 1107 and 1108 did not release it: 1107 failed on an unrelated flaky test (fixed by #953), and 1108 was superseded.

| measure | before (22:06Z–23:41Z, revisions 6fdb3ec and c72ce1c) | after (f76dbc7, connection reports 43779717565 and 43780910883) |
|---|---|---|
| the 24 h consumption count in the serving process | 30–34 reads per ~35 min, 1,652–1,875 s of DB time, max 89 s | **absent** from the process's statement costs (0 of the 11 costliest) |
| DB host CPU busy (2 vCPU) | 70.2% (22:06–22:15Z), 75.2% (22:15–23:41Z) | **40.7%** (00:20–00:32Z, 733 s) |
| app workload pool idle | 4–6 of 8 | 7 of 8; 0 waiting |
| event loop p99 | 44–92 ms | 35 ms |
| dispatch tick stalls | 6–11 per process lifetime | 1 in 16 min (the restart warm-up) |
| GPU slots busy | 0 (pod stranded) | 2/2 (pod moved; see above) |
| free lane running | 2 (22:05Z) | 7 (00:32Z) |

The database host gained about 30 points of CPU headroom (0.6 of a core), in line with the ~0.86 core the query had used. Dispatch-cadence and research-throughput effects are read in the eight-hour end reading, because one 16-minute window does not establish a rate.

## End reading (due ~2026-11-16 06:15Z)

Re-read the same sources over 22:15Z–06:15Z. Report, against the table above: capacity, utilization at both times, average and peak, up/down allocation, capacity transferred, productive versus idle worker-hours, contention, actual spend, throughput before and after, remaining bottlenecks, and the measured time saved by each change.
