# The $10K chain: final coordinated repair (2026-11-06)

Owner's order, 2026-11-06: reconcile the twelve problems the 2026-11-05 test
found (`10K-SYSTEM-TEST-2026-11-05.md`) with what is merged, deployed or owned
by another session; finish every remaining software fix; restore the database;
keep research moving without RunPod; run the permanent `GOAL_PLAN_MAP` test on
production and repair what it finds. Every figure below was printed by
production; the run that printed it is named beside it.

Goal `wst_7b4fcbb5f2384f31b6c3`, project `prj_22fb4fec295f403a8a22`.

## 1. The twelve problems, reconciled

The 2026-11-05 test marked fourteen stages BROKEN or MISSING. Two are not
software: the GPU (RunPod host capacity) and the free providers' own quotas.
Buyer identification and pricing are one requirement on the map
(`EVIDENCE.BUYER_PRICE`). That leaves twelve.

| # | problem (2026-11-05) | fix | owner | state at 01:46Z, 2026-11-06 |
|---|---|---|---|---|
| 1 | Database saturated: pool 8/8, 1 029 callers waiting | #531 #537 #538 #542 #543 #544 | DB session, this session | Server healthy (pool wait p95 57 ms, no lock waits); what remains is event-loop stalls of up to 65 s that cost the pool its connections (`CONNECTION_LOST` 54). See §2 |
| 2 | Deploy health: duplicate migration 137; guard read a timeout as a wrong build | #538, #540, #546 | DB session, 11-05 test session | Fixed. Deploys 42142024100 and 42145629357 succeeded |
| 3 | No permanent whole-chain test | #540 (`GOAL_PLAN_MAP`) | 11-05 test session | Fixed. Runs hourly and 15 min after each release |
| 4 | Goal planner held the event loop (11.6 s) | #541 | §90 session | Fixed |
| 5 | Cash passes held the event loop (82 s) | #547 | §90 session | Live 01:51Z |
| 6 | Scheduling: packets idle, claimable work waiting | #510, #530 | Factory, §90 session | Still BROKEN (`RECOVERY.STALLS` 1/29): the work is queued; the lane cannot execute it (rows 1, 12) |
| 7 | Error recovery: `RECOVERY.RETRY` 123/298 | #508, #523 | Factory, research session | UNPROVEN (12 retries in the window) |
| 8 | Research packets do not finish | #529, #535 | research session | `DECISION.JOB_OUTCOME` 0/5, `ANALYSIS.AUDIT` 9/15 |
| 9 | Source discovery 43%, verification 28% | #532 | research session | UNPROVEN: too few attempts since the fixes |
| 10 | Goal rounds end without a report; constructed rounds abandoned | #525, #547 | §90 session | No round settled in the window; 8 open |
| 11 | Buyer and price never established | behind 8 and 10 | — | `EVIDENCE.BUYER_PRICE` 0/17 |
| 12 | No opening reaches the plan | behind 10 and 11 | — | `RUNPOD_GOAL_OPENINGS` 0 |

## 2. What still held the chain at 01:46Z, and why

GOAL_PLAN_MAP, Admin 42145895943 (23:46Z → 01:46Z, on `36ac524`):
`{"WORKING":4,"BROKEN":4,"MISSING":0,"UNPROVEN":5}`. First connected gap:
`COMPUTE.DATABASE` 40/66 (rank 286, ten links downstream). Then `COMPUTE.GPU`
0/56 (external), `EVIDENCE.BUYER_PRICE` 0/17, `OPENINGS.SEARCH_WIDENS` 0/1.

The database server was not the cause. Connection report 42145911358 (01:46Z)
and 42152421973 (02:55Z): no lock waits, no running statements, 25 idle
connections, pool wait p95 0–57 ms. The failures were the Brain process itself:

| reading | value |
|---|---|
| event-loop stalls (04b2895, 01:43Z) | up to 65 s; `CONNECTION_LOST` 54 |
| event-loop stalls (6794476, 02:48Z) | worst 72.7 s |
| CPU profile, three windows 02:49–02:52Z (#548) | on the CPU 51–58 s of every 63–70 s |
| of which | garbage collection 8–10 s; opening TLS connections ~15 s (`wrap`, `init`, `start`, `setSession`, `setCiphers`) |

So "the database is overloaded" was a CPU-saturated Node process: a statement
whose answer arrived during a 60 s stall reads as a 60 s statement, and the
pooler drops a connection that went silent that long.

And the free lane, which carries all research while RunPod is down, could not
answer. OmniRoute's own log (Cheap lane status 42154057446, 03:02Z), combo
`Brain-a`:

| provider | state |
|---|---|
| Cerebras gpt-oss-120b | day's quota spent, resets in 5 h 53 m (external) |
| NVIDIA gpt-oss-120b | all accounts cooling down (external) |
| Cloudflare Playground ×2 | 503 "needs Playwright and its Chromium browser" since the OmniRoute image moved to node 26 |
| Groq gpt-oss-120b | 413 "TPM Limit 8000, Requested 8027" on every research call — **Brain's defect**: research asked `max_tokens: 8000` on top of its prompt |

## 3. Repairs released by this session

| PR | what | evidence |
|---|---|---|
| #548 | stall-triggered V8 CPU profiler in the liveness readings | connection report 42152421973 printed three profiles |
| #553 | ten console workflows get a job timeout; two hung 25 and 66 min on an SSH session a deploy cut, holding their queues | cancelled 42146262020 and 42150580065 |
| #554 | client sockets counted by host; profile samples with no Brain frame charged to their library | names which client opens the TLS connections |
| #555 | free-lane requests fit Groq's 8 000-token window when the prompt leaves ≥1 500 for the answer | `tests/cheapLaneFit.test.ts` |
| #557 | the document store keeps its connections: `node:https` keep-alive agent, ≤8 sockets kept 60 s; the socket counter read 847 new TLS sockets in 3.4 min (246/min) to the Supabase storage host | `tests/storageKeepAlive.test.ts` |

## 4. Production on Deploy 752 (`4564d96`: #552, #554, #555), 03:48Z

Cheap lane `runpod-report` 42158714846 and Admin `free-lane show` 42158711511:

- Free-lane jobs failing on Brain's database: 1 in the last hour (01:00–01:35Z had 8).
- Free-lane failures now: OmniRoute 502/503 "all models failed", because the
  combo is out of providers (Cerebras day spent, NVIDIA cooling down,
  Cloudflare Playground needs a browser). This is external, apart from Groq's
  413, which #555 addresses.
- 312 claims accepted of 417 submitted by free workers, 43 packets filed and
  154 resumed in 24 h: the lane works when a provider answers.
- The capacity controller still shrinks to one slot on event-loop lag
  (1.3–1.9 s). #557 is the repair for that cause.
- Goal: 7 rounds open, 0 opened, 0 harvested in the hour. Plan NOT_VIABLE,
  17 considered, 8 modelled. The plan is re-read about twice an hour.

## 5. What the socket counter named (Connection report 42161589617, 04:17Z, `4564d96`)

`outbound 43 485 client sockets in 38.7 min`:

| host | sockets | per minute |
|---|---|---|
| Supabase storage (`somjwbtqwmnxndmpujgn.supabase.co`), all TLS | 43 092 | 1 113 |
| Postgres pooler | 239 | 6.2 |
| everything else (browser, OmniRoute, RunPod, sources) | 154 | 4 |

The same process spent 41–49 s of every minute on the CPU: GC 5–6 s, and TLS
setup (`start`, `init`, `setSession`, `getPeerCertificate`, `wrap`,
`setCiphers`) about 15–20 s, under storage `#request`. Event-loop stalls
reached 13–43 s. Every storage existence check paid a full handshake. #557
caps the store at eight kept connections. #560 bounds every Russell pass, so
a stall that slow can no longer hold the tick for good.

## 6. Deploy 759 (`93bb258`, live 05:33Z): #557, #558, #561, #562

Deploys 750, 753, 754, 756 and 757 never reached production. 750 failed on
a flaky cash test, 756 on `tickOverlap` (fixed by #561), and the others were
superseded by a newer canonical tip while they ran. Production served
`4564d96` from 03:37Z to 05:33Z. During that time healthz timed out (04:45Z)
and stalls reached 57 s. Sessions held pushes so 759 could release.

Connection report 42169847822 (05:41Z, `93bb258`):

| reading | 4564d96 (04:17Z) | 93bb258 (05:41Z) |
|---|---|---|
| new TLS sockets to Supabase storage | 1 113/min | **3.9/min** |
| event loop p99 / worst | 13.5 s / 42.7 s | **25 ms / 1.6 s** |
| pool wait p95 | 77 ms – 2.2 s | **0 ms** |
| CPU-profile windows with a stall | 3 of 3 | none yet |

GOAL_PLAN map, Admin 42169850604 (04:41–05:41Z, mostly the old build):
`{"WORKING":4,"BROKEN":3,"MISSING":0,"UNPROVEN":6}`.
- `COMPUTE.DATABASE` 31/34 (91%), up from 40/66 (61%) at 01:46Z.
- `COMPUTE.GPU` WORKING 9/16 (RunPod answered this hour).
- `EVIDENCE.PATH_ANSWERS` 25/26; `QUANT.MODELLED` 8/17; `GOAL.PLAN_FRESH` 1/1.
- `OPENINGS.SEARCH_WIDENS` 0/1 is the goal's live-round cap (3 + spare)
  holding while its rounds are still researching. Opening more rounds while
  the free providers are saturated adds load, not answers, so the cap is
  kept.

What remained on 93bb258: statement p90 15.5 s and pressure SHEDDING, with
the server idle. `setRunDependencies` looked up each name and checked the
document store **inside one transaction** (the lookup from
`dependencies.ts:296` averaged 7.8 s over 1 076 calls in 8 min). #563
resolves the names before the transaction opens.

Russell and deep dives on `93bb258` (DB session, closeout report 42170884262, ~05:52Z):
- 4 deep dives started at 05:40Z: IHPA (researching), GBS, shared services and
  GPOs (queued for launch). Dives started rose to 380, from 376 where it had
  stood since 22:05Z. 4 are in flight, at the operator cap.
- The Russell cycle completes: lastRan 05:47:53Z, lastError empty.

## 7. Deploy 760 (`357e33c`, live 06:25Z): #563

Connection report 42175258232 (06:34Z):
- Pressure **NORMAL**, statement p90 162 ms. It was SHEDDING at 15.5 s on
  `93bb258`.
- Pool wait p95 0 ms. No lock waits on the server.
- Storage: 23.8 new TLS sockets a minute, against 1 113 on `4564d96`.
- CPU profile: TLS setup no longer appears in the top frames. GC takes 8–12 s
  a minute. Remaining stalls of 4–6 s sit in `russell:launch` as it catches
  up after the restart.

Research on `357e33c` (Cheap lane `runpod-report` 42175264906, last hour):
- The RunPod pod started at 04:40Z, once RunPod had capacity again: 48
  research jobs submitted, 56 claims, 100% sourced, $0.20 for 50 minutes.
- Accepted claims 38.9 an hour, against 2 an hour in the hour before.
- The goal opened 3 rounds and abandoned 4, and the plan was re-read 5.8
  times an hour.
- Plan: NOT_VIABLE, 17 considered, 8 modelled, no opening with a buyer and
  price accepted. 6 of the last 6 settled rounds ended without a report.

The self-improvement loop (Admin `improvement show` 42175261601) is ON and
ACTIVE. 11 candidates are recorded, one measured IMPROVED
(`FREE_LANE:CITATION_DROPPED`, z = 5.04). Owner interventions run at 59 in the
last 24 h, 157 of them over 7 days "deciding whether this project accepts a
report with unresolved gaps"; the loop holds that as candidate
`OWNER:DECIDING…`, stage DECIDE.

#565 (`91944e2`): #557's bounded store pool would keep the socket of any
response its caller does not read (a successful upload, a delete, a 404).
Responses up to 4 MB are now read whole, and an idle socket is ended after
45 s.
