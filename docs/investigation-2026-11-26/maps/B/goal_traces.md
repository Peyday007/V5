# Map B — goal traces (behavioural, read-only)

Investigator: Map B (behavioural). Production read via the `cloud_brain` MCP read tools as `worker-05`, 2026-11-26 06:34Z–07:26Z.
Epoch boundary: wave-1 planning repairs deployed ~05:50Z. **E0** is before that, **E1** after. Every observation cited as `B-O###` is in `observations.json`, and its raw evidence is in `raw/`.
Labels: **OBSERVED** means read directly in a primary record. **INFERRED** means a conclusion drawn from records, marked as such. A chain step with no record is an **OBSERVATION GAP** (`observation_gaps.md`).

The common chain each live cash goal shows (the per-goal sections give the ids):

```
owner objective (title) ─► intake (capital / hours / deadline as read)
   ─► discovery + route proposals ─► openings (cop_… / arr_…) ─► research fragments (wki_…) ─► documents (doc_…)
   ─► knowledge library (Census counts → buyers) ─► arrangement constructor (≈400 composed of 600–1,650)
   ─► planner reading: strategies, chosen, acceptance candidate, reconstruction, adoption
   ─► committee (rule roles; model specialists) ─► steps shown to the owner ─► hourly owner report
```

The read tools cannot show three links: route-ask records, the model attribution of planner turns, and the work-item → goal linkage (`observation_gaps.md` G3, G4, G8).

---

## 1. wst_7b4fcbb5f2384f31b6c3 — "$10,000 settled cash within 30 days, little up-front capital" (prj_22fb4fec295f403a8a22, "Cash Mode 1")

| # | step | what was observed | epoch / time | obs |
|---|---|---|---|---|
| 1 | intake | Target SETTLED_CASH 10000 USD. Capital ceiling read as $3,000 ("commits USD 0 of the USD 3,000"). Owner hours read as 0 ("against the 0 owner hours this goal has"). Deadline floats: "within 30 days of the start of commercial execution (not started)". dueAt moves on each read. | E0 05:40 / E1 06:34, 07:05 | B-O011, B-O015 |
| 2 | authority | Research grant "within the limits you set on 2026-09-17". No commercial grant. Six person-requests "Raising the research goal's DEADLINE ceiling" (10-18 … 11-06) are open, unanswered and "the card names no mission". | E1 06:40 | B-O016, B-O069 |
| 3 | openings | 15 considered, 8 modelled, 2 with an evidenced buyer and price. Ladder: B_EVIDENCED 8, C_MARKET_TEST_READY 7, D/E/F 0. Opening titles include "Rush Lead‑Safe Certification (24‑48h)", "Lead‑Safe Certification Booking Broker", "Shared 9x12 Postcard Advertising (Presale)", "Pennsylvania DGS … has an open", and "Recurring outsourced work: US trade-association member firms". | E0 05:40 | B-O011, B-O071 (INFERRED: route-proposal origin) |
| 4 | knowledge → buyers | Census counts were filed onto buyers of this goal: "US trade-association member firms" 14,855 (05:35Z), "MJM Group's About page states they build…" 145,813–480,699, "Contractors" 212,178–1,109,958 and "US local businesses" 32,020–420,316. Each was marked "buyers established… next round asks for conversion". | E0 21:55Z–05:35Z | B-O050 |
| 5 | research queue | 47 fragments QUEUED and 0 LEASED. Three new fragments were created after the pause (06:36, 06:44, 06:52Z). Items show leaseGeneration up to 7 with attemptCount 0, and 5 show WORKER_ERROR. Historic audits (11-04/05): 9 of 14 FAILED "free lane produced no answer Brain accepted". | E1 07:19 / E0 | B-O017, B-O018 |
| 6 | arrangement constructor | 400 of 1,658 composed. 424 candidates → 69 distinct, 355 collapses, 64 double-counted. Rebuild move: SUPPLIER_FAILED "unknown fulfiller". | E0 05:40 | B-O006, B-O007, B-O008 |
| 7 | planner | Chosen: only_o3 "Lead‑Safe Certification Booking Broker", goalMetShare 0.204, p50 $8,437. Four reach figures appear: 0.97 assumption-only, 0.986 reconstruction (binding CLOSE), 0.204 candidate, 0 supported. The reconstruction was "flagged implausible (44× … bound ×20)", so adoption = BASELINE. | E0 05:40 | B-O011, B-O012, B-O009 |
| 8 | committee | ROUTINE tier, specialists NOT_RUN. FAIL on MARKET_EXPERT (volume). QUANT PASS on another opening's $38,553; OWNER_PROXY FAIL at $0. Questions were sent and none came back (answered 0). | E0 05:40 | B-O013, B-O014 |
| 9 | steps to owner | 1 step: "Establish an offer and a price — research the deep dive on Lead‑Safe Certification Booking Broker", via Claude routines. The ROUTINES pool has 0 waiting and 0 running. | E0 / E1 07:12 | B-O005, B-O048 |
| 10 | Master Planner (project) | nextBestAction is a RECONCILE of an unreadable "UK DWP" payer document, unrelated to step 9. | E1 07:18 | B-O019 |
| 11 | owner report | The 07:05Z report shows "best reach 20.4%", "binding factor CLOSE", "50 plan reading(s)" and "reach 20.4% → 20.4%". It omits the pause. | E1 07:05 | B-O042 |
| 12 | allocation | Reach 0.0%, "reach moved −97.0 pts", HOLD. | E1 07:15 | B-O041 |
| 13 | lifecycle | PAUSED by the owner's priority override; 25 bins held. | E1 | B-O002 |

Longitudinal: on 11-14 this goal had an adopted reconstructed plan with 2 dated steps. On 11-26 it has a baseline adoption and 1 research step (B-O010).

## 2. wst_db2e2e0e5204477692d5 — "$5,000 a month recurring within 60 days, ≤10 h/week, ≤$1,500" (prj_f1d8f9d6a9854c65939a, "Cash Mode 4")

| # | step | observed | epoch | obs |
|---|---|---|---|---|
| 1 | intake | Recurring run-rate of 5000. Capital $1,500 and 86 owner hours (≈10 h/week × 52 days ÷ 7, INFERRED arithmetic). 52 days left. | E0 02:05 | B-O022 |
| 2 | openings | 10 considered, 8 modelled, 0 with an evidenced buyer and price. Ladder: B 4, C 6. | E0 | — |
| 3 | knowledge | "Small and mid-size firms sending year-end … gifts" got 21,400 (NAICS 4532 gift stores). An unresolved contradiction on the same buyer reads 3,570 vs 71,964. | E0 00:10–00:25Z | B-O051 |
| 4 | planner | Three "best" answers: chosen only_o1 HubSpot reseller (0.486); acceptance candidate HVAC + Agorapulse (reach 0); reconstruction best cold-email mailboxes ($1,499 bought) + retainer (0.932, binding COST). The adoption rejects the reconstruction for counting HubSpot's unestablished price, yet HubSpot is the chosen strategy. | E0 | B-O020, B-O021 |
| 5 | committee | FAIL. QUANT critical: "$30,000 toward $5,000 … at most $320". Specialists NOT_RUN. | E0 | B-O022 |
| 6 | steps | 1 research step ("deep dive on HubSpot Agency Reseller Program"). | E0 | B-O005 |
| 7 | work | 0 bins, 0 requests. | E1 06:41 | B-O023 |
| 8 | allocation | Reach 0.0%, HOLD. | E1 | B-O041 |

This goal shares its project and its candidate legs with wst_4f0c… (B-O040).

## 3. wst_fa4761773e4441b89e5a — "Collect $2,000 of customer payments within 14 days" (prj_c56705b8a3164d4190a0, "Cash Mode 3")

| # | step | observed | epoch | obs |
|---|---|---|---|---|
| 1 | intake | COLLECTED_CASH 2000, 7 days left. A $500 capital ceiling is applied, though the title states none. | E0 05:43 | B-O027 |
| 2 | knowledge | "Employers and small professional firms" → 7,782 (NAICS 56133 PEOs + 813920). Marked established. | E0 02:39–02:57Z | B-O050 |
| 3 | planner | Chosen: only_o1 "AI Regulation Market Report Resale" (0.6048). Acceptance candidate: cop_c97670f8157541428d84 "Employers and small professional…" (0.6995). basket_all goalMetShare 1 with infeasibleShare 0.92. Reconstruction best buys pre-warmed cold-email capacity for $499 (0.906, binding CLOSE); adoption = BASELINE. | E0 | B-O024, B-O028 |
| 4 | committee | Tier FULL. Specialists BOUND at 04:51Z: gpt-oss answered INVESTOR, OPERATOR and MARKET_EXPERT; the fallback answered OWNER_PROXY; SKEPTIC and QUANT were "no parseable verdict". The blocking defect is about a third opening (cop_72e0… cash-home-buyer leads; its $1,500 deposit is not a price). QUANT "proven $412,920" contrasts with support $0. | E0 | B-O025, B-O026 |
| 5 | steps | 1 research step on "AI Regulation Market Report Resale". | E0 | B-O005 |
| 6 | work | 2 bins NEEDS_HUMAN, GOAL_PAUSED. | E1 06:41 | — |
| 7 | allocation | Reach 0.0%, "moved −90 pts". | E1 | B-O041 |

## 4. wst_deede4995a0c471c95ee — "$3,000 settled cash in 30 days selling services, no starting capital" (prj_630132c1875545548727, "Cash Mode 2")

| # | step | observed | epoch | obs |
|---|---|---|---|---|
| 1 | intake | Capital $0. Owner hours "which nobody has stated". 23 days left. One research packet (v1AF) assumed "~30 hrs/week". | E0 05:33 / unknown | B-O035 |
| 2 | research | About 200 documents. Many openings are named after the source site ("buyer not yet named — Wikipedia / GOV.UK / Upwork…"). Qualify dives exist for Notion, LinkedIn, Upwork, Etsy and Remote Onboarding. Syntheses v1EM, v1GF and v1EG: no opening settles cash inside the window. | unknown (≤ 11-26) | B-O034, B-O035 |
| 3 | qualify dive on the chosen route | doc_09545a208e0d4fef8c62: the channel requires certified human Notion partners; price $1,000–20,000; demand evidence dated Aug 2026; no buyer count; "~100 million users … not buyers". | unknown | B-O032 |
| 4 | knowledge | Fragment buyers given NAICS counts ("Requesters", "Canon is a merchant…", "Named clients publicly reviewed", "Independent film producers"). | E0 22:33Z–02:55Z | B-O050 |
| 5 | planner | Chosen only_o2 Notion (0.20), although LinkedIn (0.499) and Fiverr (0.483) score higher. Acceptance candidate: Upwork Profile (reach 0, p50 0). reachBasis SUPPORTED with reach 0.87, supportedReach 0 and expected $0. Reconstruction implausible (14100×). | E0 05:33 | B-O029, B-O030 |
| 6 | committee | QUANT PASS on "proven $37,896,129,554", which includes 100,000,000×378 (INFERRED: Notion's user count, B-O033). SKEPTIC and OWNER_PROXY fail critically because the LinkedIn audit's $300 is a refund figure. | E0 | B-O031, B-O033 |
| 7 | steps | 1 step: "Find a dated sign from the last 30 days that the buyer for Notion … needs it now". The dive had already found only Aug-2026 reviews and a gated channel. | E0 | B-O005, B-O032 |
| 8 | work | 3 bins; bin_753a… updated 06:56Z (E1), READY, GOAL_PAUSED. | E1 | B-O036 |
| 9 | allocation | The only goal at 87.0% reach (−4 pts). | E1 | B-O041 |

## 5. wst_66311cabe7e5442faa98 — "Turn $10,000 into $100,000 within 90 days" (prj_c567…) — supplementary

Chosen: only_o1 "AI Regulation Market Research Report". The candidate is cop_c976, the same opening as fa47's candidate. The reconstruction winner (price ×2.5, deposit, bundle, referral partner) was discarded as implausible. All committee specialists are PENDING. Allocation reach moved −87 pts. Obs: B-O037, B-O038, B-O040, B-O041.

## 6. wst_4f0c312400e1425dab2e — "$50,000 collected in 6 months with up to $25,000" (prj_f1d8…) — supplementary

Chosen: only_o2 "AI Script Bundle". The candidate (HVAC + Agorapulse) is identical to db2e's. QUANT is critical at $320 against $750,000 and flags that the downside estimators disagree. Obs: B-O039, B-O040.

---

## 7. Evaluation goals: dec1125c p02 / p06 / p10 (the 30Q test goals)

These projects are not in this credential's memberships (prj_5b2e08eb38034b369350, prj_0d617ea990f1496b8472, prj_0497f093bbbb42ff8167). The trace below is from recorded `planningEval trace/probe` outputs on revision c52d6d3 (E0) under `docs/intelligence-test-2026-11-26/planner/`.

| step | p02 drone pilot, Phoenix (wst_3e23e344ac2040fb900e) | p06 Seattle $500/7 d (wst_4e256872ee2c4ccb8f76) | p10 Minneapolis $20k/90 d, 0 h (wst_2fc80fc56136446d9c1b) | obs |
|---|---|---|---|---|
| created | 2026-11-25T19:28:18Z | 19:28:20Z | 19:28:21Z | B-O055–57 |
| route asks (production) | 20:09Z SCOUT: 0 directions, 5 rejected (4 no owner fit, 1 physical work). 20:48Z SCOUT: 4 directions. | 20:09Z SCOUT: 3 directions. 21:44Z ROUTE: findings seen 3, shown 1; 1 proposed; 2 rejected. | 20:28Z SCOUT: 2 directions, both rejected as "not a proved deliverable". | B-O055–57 |
| research | 6 fragments queued, 0 done. 18 searched, 2 read. Replies `{"claims":[]}`, DNS/HTTP errors. | 1 fragment done, 1 blocked (REQUIRED_LANE_EMPTY). The only claims: 3 identical forestry "no published evidence" claims from Wikipedia. | 0 searched, 0 pages. | B-O055–58 |
| plan | NEEDS_EVIDENCE, chosen null | NEEDS_EVIDENCE; chosen "2‑Hour Email Inbox Triage", price $70 ASSUMPTION | NEEDS_EVIDENCE, chosen null | B-O055–57 |
| probes with supplied facts (12 asks) | gpt-oss empty on 2 of 4 asks; the critic dropped ARMLS routes on "net 30 … not within 60 days" | gpt-oss empty on 2 of 4; the fallback invented owner refusals; TaskRabbit rejected MARGIN; critique unreadable | gpt-oss empty on 2 of 4; parser OWNER_FIT rejections; critic "Dec 3-7 after the 90-day window" | B-O059–B-O063 |
| graded outcome | NOT_USABLE in the final arms; CREDIBLE_INCOMPLETE in round 1 | NOT_USABLE in all arms | CREDIBLE_INCOMPLETE in final-cap only | B-O064 |

Information that disappeared between steps:
- The p06 owner offered 15 hours, and the fallback's owner profile turned that into refusals (B-O060). The route prompt states the no-service rule before the exception (B-O061).
- Of 111 verified findings, 40 were shown (B-O063).
- Correct routes were dropped by critic assertions (B-O062).

## 8. fm1126a batch

No raw record was found outside the excluded planning-failure-map files (B-O068). See observation gap G6.

## 9. Coordinator check: creator, Cash Mode/sprint, route-proposal evidence (per live cash goal)

| goal | project | created by (visible?) | active Cash Mode / research sprint (visible?) | route-proposal ask / opening / GOAL_RESEARCH_SPRINT_ACTIVATED event |
|---|---|---|---|---|
| wst_7b4f… | prj_22fb "Cash Mode 1" | not visible; authority "limits you set on 2026-09-17" | project is named Cash Mode 1; plan continuation reads "SQUEEZE goal"; no sprint row or event readable | Openings carry route-style titles and the nextTest cites "each route proposal assumed" (INFERRED that proposals ran). No ask or event record is readable. |
| wst_db2e… | prj_f1d8 "Cash Mode 4" | not visible; "2026-11-19" | same | same: HubSpot/AI after-hours/3D model titles (INFERRED) |
| wst_4f0c… | prj_f1d8 "Cash Mode 4" | not visible; "2026-11-19" | same | same: Compliance Docs Pack/AI Script Bundle/SaaS Funnel Pack titles (INFERRED) |
| wst_fa47… | prj_c567 "Cash Mode 3" | not visible; "2026-11-19" | same | same: AI Regulation Market Report Resale/.AI domain titles (INFERRED) |
| wst_6631… | prj_c567 "Cash Mode 3" | not visible; "2026-11-19" | same | same (INFERRED) |
| wst_deed… | prj_6301 "Cash Mode 2" | not visible; "2026-11-19" | same | The strongest indirect evidence: "Qualify: Notion Template…/LinkedIn…/Upwork…/Etsy…" dive documents exist for route-titled openings (B-O035) |

All "not visible" cells are gaps G1–G3. Obs: B-O069, B-O070, B-O071.
