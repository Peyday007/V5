# The $10K planning chain, tested end to end (2026-11-05)

Owner's order, 2026-11-05: test every stage of the $10K planning process against
production, find every material blocker rather than the first, repair them
together, prove the chain on production, and keep the test.

Goal `wst_7b4fcbb5f2384f31b6c3`, project `prj_22fb4fec295f403a8a22` (Cash Mode 1).
Every figure below was printed by production. The run that printed it is named
next to it.

## 1. First reading (22:13Z–22:59Z, serving `044b1d5`)

Sources:
- Cash report 42118464680
- Cheap lane `runpod-report` 42123806769
- Admin `capabilities show 24` 42124719859
- Admin `improvement show` 42124735902
- Admin `free-lane show` 42125288419
- Goals `plan` 42124715738
- Goals `construct` 42099808306
- Production guard 42118267972

| stage | status | reading |
|---|---|---|
| Goal received, requirements read | WORKING | 10 000 USD within 22 days. Capital 3 000 in all, 375 per arrangement, 750 a week tied up. Government, website-repair and domain plays are excluded by the goal. Physical-work openings are left out with the reason recorded. |
| Opportunity discovery (goal rounds) | BROKEN | The goal's last 5 settled rounds ended without a report. No openings were filed in 2 h. |
| Economic construction | WORKING as computation, BROKEN as a connection | 404 arrangements were composed (245 have a SAFE worst case). The top ones are "not asked yet". Of 26 constructed rounds, 24 were ABANDONED. |
| AI research (packets) | BROKEN | `DECISION.JOB_OUTCOME` 3/31 over 24 h. Packets ended: CANCELLED ×80 because no fragment cleared its gate (fragment work faulted), MORE_RESEARCH ×24, and NEEDS_HUMAN ×20 because an audit faulted. |
| Real source discovery | BROKEN | `DISCOVERY.SEARCH` 152/355 (43%, bar 70%). `DISCOVERY.READABLE` 77%. |
| Website access | WORKING | `ACCESS.READ` 3 214/4 670 (69%). `ACCESS.ROUTINE_FETCH` 10/10. |
| Evidence verification | BROKEN | `VERIFICATION.GATE` 85/301 (28%). WORK_FAULTED 120, REQUIRED_LANE_EMPTY 64. |
| Buyer and payer identification | BROKEN | 16 of 17 considered openings lack a reachable buyer or a dated sign of demand. |
| Pricing and demand estimates | BROKEN | 15 of 17 lack a price buyers are shown to pay. 0 openings have buyer and price accepted by the plan. |
| Quantitative evaluation | WORKING | 2 000 worlds and 255 combinations searched. Runs take 0.3–0.4 s. 8 openings modelled. |
| Portfolio optimisation | WORKING, starved | Best combination: 0.0% of worlds reach the target. Settled p10 0, p50 50, p90 225. |
| Complete plan | NOT_VIABLE | "cannot reach the 10000 USD … at prices buyers are shown to pay (at most 250)". Every one of the 17 openings is a one-off. |
| GPU (RunPod Qwen) | BROKEN, external | The pod was stopped by the 21:34Z cycle test. It has been refused START ×14 since: "not enough free GPUs on the host machine". Brain retries the start on its own. |
| Free AI fallback | WORKING, degraded | Free models carried the research. Providers released 1 605 of 2 310 items for their own failures (external). |
| Worker capacity / scaling | WORKING | Slots shrank to 1 on database saturation and event-loop lag, then grew back. |
| Database | BROKEN | Pool 8/8 with 1 029 callers waiting (22:42Z). 27 of the goal's last 34 research jobs were refused for a pool error. |
| Scheduling and queue progression | BROKEN | `RECOVERY.STALLS` 5/35. `RECOVERY.IDLE_CAPACITY` 8/25. |
| Error recovery | BROKEN | `RECOVERY.RETRY` 123/298. `RECOVERY.LEASES` 2 912/2 912. |
| Results reaching the next stage | BROKEN | `RUNPOD_GOAL_OPENINGS 0`. No opening reached a plan in 2 h. |
| A permanent whole-chain test | MISSING | Only the research map existed. Nothing read the goal → plan connections. |
| Deploy health | BROKEN | Deploy 42123843643 (`cf852ff`, the database fix) failed all four test shards on a duplicate migration 137. Production guard 42118267972 reported a 30 s timeout as "a non-canonical build". |

## 2. Material blockers and their owners

| # | blocker | cause | owner | state |
|---|---|---|---|---|
| 1 | Database saturated | Each canonical-name lookup scanned the documents table (about 50 000 an hour) | `repos/documents.ts`, `services/dependencies.ts` | Fixed by #537 and #538 (another session) |
| 2 | Database fix could not deploy | #531 and #537 merged minutes apart, and both took migration 137 / pg 128 | migrations | Fixed by #538. #539 (the same fix, here) was closed as a duplicate |
| 3 | Production guard reads a timeout as a wrong build | `curl -w '%{http_code}' … \|\| echo 000` printed `000000` | `production-guard.yml`, `cheap-lane.yml` | Fixed in #540 |
| 4 | No test of the whole goal → plan chain | Only the research map existed | `domain/capabilityMap.ts` | Fixed in #540 (`GOAL_PLAN_MAP`) |
| 5 | Today's parks were hidden from `packets parks` | It listed the oldest 60 | `russell/routineDecisions.ts` | Fixed in #540 |
| 6 | GPU cannot restart | RunPod host capacity | RunPod | External. Brain retries; the free fallback carries the work |
| 7 | Research packets do not finish | Mostly #1: work faulted and audits refused on pool errors (routine decisions threw too) | packet runner, free lane | Re-read after #1 deployed (below) |
| 8 | No repeatable opening reaches the plan | Repeatable needs a researched buyer volume. Path research goes only to considered openings, which are small one-offs below the materiality floor, so only constructed rounds can bring one. Those rounds sit behind #7 | `cash/goalScenario.ts`, `goals/pathResearch.ts` | Behind #7 |

## 3. The $10K plan as Brain reads it (Goals `plan`, 42124715738, 22:59Z)

- **Verdict: NOT_VIABLE under the current evidence.** The 17 openings held reach
  at most 250 of the 10 000 USD at prices buyers are shown to pay.
- **Quant engine.** 255 combinations were searched over 2 000 worlds. The best
  reaches the target in 0.0% of worlds, settling p10 0 · p50 50 · p90 225 USD.
  The basis is coverage of tested conditions: this Brain has no finished plans
  to calibrate a probability against.
- **Every limit is applied:**
  - 3 000 USD in all;
  - 375 USD per arrangement before proof;
  - 750 USD a week tied up;
  - no owner physical work;
  - government, website-repair and domain plays left out.
- **142 openings were left out by name**, mostly government contracts the goal
  excludes. Openings that would need the owner's physical work were left out
  too.
- **What the 17 are:** one-off sales of 50–3 450 USD each. Several are not
  openings at all, but competitors' published price points (Rev.com 1.99 USD a
  minute, Verblio 0.06 USD a word).
- **What nothing yet establishes:**
  - for 15 of 17 openings, a price buyers pay;
  - for 16 of 17, a reachable buyer with a dated need;
  - for 13 of 17, settlement timing;
  - for all of them, reply and close rates for this seller.
- **The 404 arrangements Brain constructed** (245 with a SAFE worst case) carry
  mechanism-reconstructed values but are not yet openings. Their buyer counts,
  conversion, price and days to cash are "to establish". Only a research round
  that finishes can establish them.
- **Why 90% is not supported:** reaching 10 000 USD in 22 days from one
  outreach pool of 10–60 contacts a day (220–1 320 contacts) needs a repeatable
  offer priced in the high hundreds or more. Brain holds no such offer with an
  evidenced buyer population, price or conversion rate. This is a gap in
  evidence and research capacity, not a computation that came out against it.
