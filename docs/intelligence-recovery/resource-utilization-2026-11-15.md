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

**Throughput.** Merged PRs: 12 (1.5/h). Deploys fully released: 6 (0.75/h). Factory units accepted: 10.8/h. Accepted research claims: **2/h**, against 25.1/h in the 8 h before. Plan evaluations: 5.5/h, against 13.3/h. Kept improvement outcomes: 0 of 2 (6 h).

## Defects found and changed

1. **Dispatch starvation (PR #949).** `laneCoverage()` always ran `consumedLastDay`, a correlated count over `work_items` × `bin_events` that took 48–82 s a read (30 reads, 1,652 s of database time in 32 min). Only `admin free-lane show` prints it. `watchDisplacedWork()` awaits it inside `dispatchTick` once a minute, so the 10 s dispatch loop ran about once a minute, `dispatchTickIfIdle` (the Factory stage handoff) declined, and roughly 0.86 of a database core was spent on it. Now it runs only on the admin readout's request.
2. **GPU stranded on a full host.** A stopped pod stays on its host, and nothing moved it when that host's GPUs were taken. Moved by hand once (cheap lane 43768013494, `runpod-upgrade`, active recipe, same price ceiling). From now on the hourly `runpod-auto` moves it itself when its last three starts were refused for that reason (PR #949, `POD_STRANDED`).

## Scaling decision

No new spending. The $0 fixes above remove the measured bottlenecks; a second GPU, a larger app server or more agents would add capacity next to pools that were idle. A larger database is re-judged on the post-fix reading. The shared $100 ceiling is untouched.

## End reading (due ~2026-11-16 06:15Z)

Re-read the same sources over 22:15Z–06:15Z. Report, against the table above: capacity, utilization at both times, average and peak, up/down allocation, capacity transferred, productive versus idle worker-hours, contention, actual spend, throughput before and after, remaining bottlenecks, and the measured time saved by each change.
