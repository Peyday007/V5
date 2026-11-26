# Map B: where components disagree about the same goal or resource

Every item below is OBSERVED unless it is marked INFERRED. Ids refer to `observations.json`.

## Within one plan reading: four different "best" answers and different binding factors

| goal | chosen strategy | acceptance candidate | reconstruction best (binding) | committee blocker targets | obs |
|---|---|---|---|---|---|
| wst_7b4f… | only_o3 Lead‑Safe Booking Broker (cop_ec16…) | same cop_ec16… | "as planned", 0.986 (CLOSE); flagged implausible | MARKET_EXPERT on cop_ec16… volume. QUANT cites cop_090c… ($38,553). OWNER_PROXY cites $0. | B-O011–B-O013 |
| wst_db2e… | only_o1 HubSpot Agency Reseller | HVAC + Agorapulse (cop_631d…, cop_f0c6…) | cold-email mailboxes ($1,499) + retainer, 0.932 (COST) | QUANT critical on HVAC/Agorapulse, $320 | B-O020–B-O022 |
| wst_fa47… | only_o1 AI Regulation Market Report Resale | cop_c976… "Employers and small professional…" | pre-warmed cold email ($499), 0.906 (CLOSE) | SKEPTIC critical on cop_72e0… (cash-home-buyer leads), which is neither the chosen strategy nor the candidate | B-O024 |
| wst_deede… | only_o2 Notion (0.20; o1 LinkedIn 0.499 and o3 Fiverr 0.483 rank higher) | Upwork Profile (cop_f442…) | "as planned", 0.858 (REPLY); implausible | SKEPTIC/OWNER_PROXY on cop_fd92… (LinkedIn) | B-O029–B-O031 |
| wst_6631… | only_o1 AI Regulation Market Research Report | cop_c976… | variables winner, price ×2.5, 0.93 (MARKET_SIZE); implausible | SKEPTIC "model challenge answered REVISE" | B-O037–B-O038 |
| wst_4f0c… | only_o2 AI Script Bundle | HVAC + Agorapulse | "as planned", 0.988 (COST); implausible | QUANT critical, $320 | B-O039 |

## The same goal's reach, read by different components

| goal | plan forecast.reach (basis) | candidate reach | supportedReach | reconstruction baseline | allocation (07:15Z) | owner report |
|---|---|---|---|---|---|---|
| 7b4f | 0.97 (ASSUMPTION_ONLY) | 0.204 | 0 | 0.986 | 0.0%, "moved −97 pts" | 20.4% (07:05Z) |
| db2e | 0.86 (ASSUMPTION_ONLY) | 0 | 0 | 0.859 | 0.0% | — |
| fa47 | 0.85 (ASSUMPTION_ONLY) | 0.6995 | 0 | 0.867 | 0.0%, −90 | — |
| deede | 0.87 (**SUPPORTED**) | 0 | 0 | 0.858 | **87.0%** | — |
| 6631 | 0.87 (ASSUMPTION_ONLY) | 0.4715 | 0 | 0.873 | 0.0%, −87 | — |
| 4f0c | 0.96 (ASSUMPTION_ONLY) | 0 | 0 | 0.988 | 0.0% | — |

Timelines report reach 1.0 at the deadline horizon for every goal (COVERAGE). Obs: B-O012, B-O030, B-O041.

## "Proven" money: QUANT, OWNER_PROXY and support disagree in the same reading

- **7b4f.** QUANT: $38,553 proven. OWNER_PROXY: $0. Support: $0. (B-O013)
- **fa47.** QUANT: $412,920 proven (740 × 279 twice). OWNER_PROXY rule: $206,460. Specialist: "740 buyers … $213,860". Support: $0. The stated reachable-buyer count is being counted as purchases. (B-O026)
- **deede.** QUANT: $37,896,129,554 proven, including 100,000,000 × 378. OWNER_PROXY: $111,220,186. Support: expected $0, with the sentence "the outcome is the plan's". (B-O030, B-O031)
  - INFERRED: the 100M multiplier is the user count that the research labelled "not buyers". (B-O033)
- **6631.** QUANT: $206,460 proven. Support: $0. (B-O037)
- **4f0c / db2e.** QUANT: $320, against a reading that presents $750k / $30k. (B-O022, B-O039)

## Research findings vs the plan

- **deede.** Syntheses v1EM, v1GF and v1EG say no opening settles inside the window at zero capital. The plan reads 87% reach (allocation also says 87%). (B-O034)
- **deede, the chosen Notion route.** The qualify dive found:
  - the channel is gated by certified human partners;
  - the price band is far above the proposal's;
  - the only dated demand is Aug 2026.

  The plan's next step still asks for "a dated sign from the last 30 days". (B-O032)
- **deede, owner hours.**
  - A research packet assumed "~30 hrs/week".
  - The plan says "nobody has stated" the hours.
  - The goal's words give none.

  (B-O035)
- **fa47, capital.** The plan uses a $500 ceiling, but the goal's words state no capital. (B-O027)

## The project Master Planner vs the goal plan

For the $10k project (prj_22fb…), the Master Planner's next best action is a RECONCILE of an unreadable "UK DWP payer" document. The goal plan's next test is the Lead-Safe deep dive. (B-O019)

## The owner report vs live state (E1)

- **The pause.** The 07:05Z report presents the $10k goal as active (reach 20.4%, binding CLOSE, "50 plan readings" this hour). The goal is PAUSED, and its newest stored reading is from 05:40Z. (B-O042)
- **Research in flight.** The report says "research 3 running". Capacity says RESEARCH_SLOTS 330 running. (B-O047)
- **Idle capacity.** The report says "Idle or constrained: none". Capacity says RESEARCH_SLOTS is idle beside work, and FREE_LANE is held because "database connections contended". (B-O045, B-O047)
- **GPU demand.** The report says "MORE GPU CAPACITY: NO — nothing in the rows shows work waiting on it". The free lane has 1,264 items waiting, and GPU concurrency is restricted by DB contention. (B-O046, B-O047)
- **Model jobs.** The report says "Models: no research model jobs". The GPU accepted 662 jobs in 24 h. (B-O046)
- **Routines.** The report gives "STRONGER MODEL: NO" from Hermes' tool-call success. The plan steps all route through Claude routines, and that pool is idle (0/0). (B-O048)

## Cross-goal and cross-surface

- **Shared candidates.** Goals in the same project share candidate legs, strategy lists and near-identical small-strategy p50s. This holds even when their targets differ 50× (fa47 $2k vs 6631 $100k). (B-O040)
- **One buyer, two counts.**
  - Knowledge gives "firms sending year-end gifts" 21,400 from NAICS 4532 gift stores.
  - An unresolved contradiction on the same buyer stands at 3,570 vs 71,964.

  (B-O051)
- **Owner profiles disagree by model.**
  - In the probes, gpt-oss wrote "not stated" for p06's refusals.
  - The fallback wrote six refusals for the same words.

  (B-O060)
- **Specialist answers on the same review.** For fa47, the same model (gpt-oss) gave parseable verdicts for 3 roles and none for 2. (B-O025)

## Over time

- **The $10k goal.** On 11-14 it had an adopted reconstruction and 2 dated steps. On 11-26 it has a baseline adoption and 1 research step. (B-O010)
- **GPU credit (doc record, 11-19 to 11-24).** Reports credited GPU work while the pod was EXITED. (B-O067)
