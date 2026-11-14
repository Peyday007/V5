# Intelligence evaluation — baseline (Surge B, 2026-11-14)

The independent evaluator's cases (`tests/intelligenceEvaluation.test.ts`) run
on the code **before** the Surge B repairs: base commit `63bc337` (the
inventory commit in `docs/INTELLIGENCE-RECOVERY-2026-11-14.md`). The cases are
written from the owner's requirements and the public planning interfaces only,
not from any repair branch. A failure here is a measured gap in the planner, and
the same file is re-run on the repaired code.

How to run and get the measured lines:

```
npx vitest run tests/intelligenceEvaluation.test.ts
npx vitest run tests/intelligenceEvaluation.test.ts 2>&1 | grep '^INTEL_EVAL '
```

Each line is JSON with the case id, PASS/FAIL per assertion, verdict, reach,
strategies considered, distinct mechanisms, and elapsed ms, plus the values the
case measured. Every assertion in a case runs and is recorded even after an
earlier one fails, and the case fails if any assertion did.

**Baseline: 18 cases, 11 pass and 7 fail; 76 assertions, 61 PASS and 15 FAIL.
The whole file runs in about 26–47 s on SQLite.**

## By case

| case | world / objective | assertions passed | verdict | reach | strategies | mechanisms | ms |
|---|---|---|---|---|---|---|---|
| A | agricultural equipment rental co-ops (map: grain farms / harvest shortage / dealers' demo fleets; one sourced price) | 5/5 | — | — | 74 constructed | 4 structures | 1,470 |
| E | $20K contract, 30% deposit + 40% milestone by day 20, balance after deadline; $10K in 45 d | **2/4** | CANDIDATE_ONLY | 0 | 1 | 1 | 33 |
| G | dental pooled-purchasing precedent carried to vet clinics | **3/4** | — | — | 40 constructed | 4 | 450 |
| H | $30K/30 d, three capped evidenced streams | 4/4 | CANDIDATE_ONLY | 1.00 | 511 | 3 | 234 |
| I | pallet-racking resale, $1,500 ceiling; presale vs self-funded | **2/4** | CANDIDATE_ONLY | 0 | 8 | 1 | 4,931 |
| J | bike-repair lines, every input a sweep | 6/6 | CANDIDATE_ONLY | 0.145 (coverage) | 11 | 1 | 698 |
| K | $1M in 48 h with $0 | 6/6 | CANDIDATE_ONLY + structural | 0 | 4 | 1 | 732 |
| L | contradictory sources ($8K vs $45K, same population) | **1/3** | tier DIRECT, distribution justified | — | — | — | 5 |
| M | obvious $15K net-60 deal vs two fast small lines (portfolio) | 3/3 | CANDIDATE_ONLY | 1.00 | 127 | 2 | 142 |
| N | same world through strategy reconstruction | 3/3 | CANDIDATE_ONLY | 1.00 | 15 | 2 | 2,501 |
| O | three sized comparables (40/200, 46/200, 36/200); stronger 10× variant; unsized-only | **4/6** | CANDIDATE_ONLY (all three) | 1.00 | 7 | 1 | 122 |
| Q | an opening's market sized by a new sourced claim | 4/4 | NEEDS_EVIDENCE → NEEDS_EVIDENCE | 0.50 → 0.90 | 3 | — | 7,814 |
| SEL | strong DIRECT arrangement among 30 ordinary ones, 6 key strings | **4/7** | — | — | 31 | — | 29 |
| PERSIST | constructed arrangements after caches cleared | **0/3** | — | — | 40 constructed | 4 | 5,602 |
| SIZE $100/48h | marketplace templates + one posted gig, $0 | 4/4 | CANDIDATE_ONLY + structural | 0.012 | 1 | 2 | 104 |
| SIZE $10K/30d ≤$3K | the production $10K fixture + measured Instantly record | 4/4 | CANDIDATE_ONLY | 0.90 (coverage) | 27 | 1 | 9,593 |
| SIZE $100K/90d | B2B implementation lines, $10K | 3/3 | CANDIDATE_ONLY + structural | 0.28 | 20 | 1 | 1,999 |
| SIZE $1M/1y | wholesale / private label / SaaS, $50K | 3/3 | CANDIDATE_ONLY + structural | 0.06 | 20 | 1 | 1,205 |

(ms varies run to run with machine load. "strategies" is the number of
combinations searched by the portfolio engine, the number of variants tried by
reconstruction, or the arrangements constructed, depending on the entry point.)

## What the failures measure

| case | failed assertion | what the planner did | inventory finding |
|---|---|---|---|
| E | E1, E3 | A signed $20K contract that pays $6K deposit plus $8K milestone inside the window settles **$0**, reach 0. Neither the deposit nor the milestone in the payment terms is counted, and the engine's only reason is "whether the buyer will pay in full before delivery". E4 passes only because nothing settles at all. | payment structure not modelled (new, near Q2-7) |
| G | G2 | The TRANSFER exists and carries the right precedent, but nothing on it names how vet clinics differ from dental practices (jurisdiction, terms, purchase volume, sales cycle). | S-12 |
| I | I2, I3 | Reconstruction tried 8 variants and kept **no change**: reach 0, with a $1,400 per-unit capital need under a $1,500 ceiling. `capital:prepaid-fulfilment` moves direct cost to the buyer but leaves capital-at-start binding, so presale never beats self-funding. | capital restructuring (S §2 table "capital restructuring … assumed") |
| L | L1, L3 | Two DIRECT sources 5.6× apart were pooled into p50 $18,974 (DIRECT tier, `distributionJustified: true`) with no contradiction recorded. The interval is wide (heterogeneity 1.22), but the disagreement is never surfaced. | contradiction handling (new) |
| O | O4, O5 | The comparable conversion enters as COMPARABLE evidence (basis PROBABILITY, reach 1.0), but assurance is `CALIBRATION_UNAVAILABLE` with no range, and even the 10× stronger variant stays CANDIDATE_ONLY. Only unsized-only evidence is refused, which is correct. | Q2-1, Q2-2 |
| SEL | zz-strong, strong-3, one-off | Whether the strong DIRECT $3K/subscription arrangement is kept depends on its key string: kept as `aa-strong`, `fff…`, `000…` and `9c1e…`, dropped as `zz-strong` and `strong-3`. A DIRECT $9K one-off is dropped behind 30 MECHANISM $300 designs. | S-1, S-14 |
| PERSIST | P1–P3 | No table holds constructed arrangements, so after caches are cleared nothing remains. | K-1 |

Passing cases that are worth noting:

- **H, M and N:** combination search works when every input is evidenced and fixed.
- **J and K:** the planner is honest under insufficient evidence and under infeasibility.
- **Q:** new evidence does change the plan once a market is sized.
- **A:** an unfamiliar industry is constructed with no per-industry code.
- **Size cases:** SIZE $10K, $100K and $1M each end on **one** stream (`cop_lists`, `o_crm`, `o_wholesale`), and every plan is CANDIDATE_ONLY. None is certifiable while assurance is unavailable (O).

## Every assertion

| case | assertion | result | measured |
|---|---|---|---|
| E | E1 milestone tranche counted: reach >= 0.9 ($14K of $20K settles by day 20) | **FAIL** | verdict=CANDIDATE_ONLY reach=0 strategies=1 mechanisms=1 ms=33; settledP50=0; basis="PROBABILITY"; refused=null; missing=["the best combination reaches the target in 0% of worlds, which is not a defensible 90%: calibration is unavailable: 1 input(s) fail validation; the 0% is shar; depositOnlyReach=0 |
|  | E2 balance after the deadline is not counted: settledP50 <= $14,000 | **PASS** |  |
|  | E3 settled cash inside window >= $14,000 (deposit + milestone) | **FAIL** |  |
|  | E4 control: deposit-only terms do not reach $10K (reach < 0.5) | **PASS** |  |
| H | H1 best combination has >= 2 simultaneous streams | **PASS** | verdict=CANDIDATE_ONLY reach=1 strategies=511 mechanisms=3 ms=234; members=["o_bookkeeping","o_permits","o_menu"]; singleReach=[{"id":"o_bookkeeping","reach":0},{"id":"o_permits","reach":0},{"id":"o_menu","reach":0}]; settledP50=53000; settledP10=53000; overSpend=0; capitalShort=0 |
|  | H2 portfolio reach > every single stream reach | **PASS** |  |
|  | H3 no single stream reaches the goal (reach < 0.05 each) | **PASS** |  |
|  | H4 portfolio reach >= 0.5 | **PASS** |  |
| I | I1 self-funded baseline is capital-bound (reach < 0.3) | **PASS** | verdict=CANDIDATE_ONLY reach=0 strategies=8 mechanisms=1 ms=4931; baselineReach=0; committed=0; changes=[]; planMs=4931 |
|  | I2 the chosen plan restructures capital (prepaid/deposit/presale) | **FAIL** |  |
|  | I3 restructured plan reach exceeds self-funded by >= 0.2 | **FAIL** |  |
|  | I4 committed capital stays within the $1,500 ceiling | **PASS** |  |
| J | J1 a plan is constructed (members non-empty) | **PASS** | verdict=CANDIDATE_ONLY reach=0.145 strategies=11 mechanisms=1 ms=698; basis="COVERAGE"; assumed=2; planMs=697; assurance="CALIBRATION_UNAVAILABLE" |
|  | J2 reach basis is COVERAGE, not probability | **PASS** |  |
|  | J3 the uncertainty is stated (assumed inputs listed) | **PASS** |  |
|  | J4 not certified: acceptance is not ACCEPTED | **PASS** |  |
|  | J5 a candidate is still named for pursuit (CANDIDATE_ONLY) | **PASS** |  |
|  | J6 engine assurance does not claim 90% | **PASS** |  |
| K | K1 reach < 0.01 | **PASS** | verdict=CANDIDATE_ONLY reach=0 strategies=4 mechanisms=1 ms=732; structural=true; limitation="For the openings as held, even every estimate at its favourable end reaches 0.0%: better estimates or more capacity cannot close the gap. No change tried impro; planMs=731 |
|  | K2 reported as structurally infeasible | **PASS** |  |
|  | K3 the binding constraint is named (time/capital/market) | **PASS** |  |
|  | K4 never ACCEPTED | **PASS** |  |
|  | K5 every non-instant structure is IMPOSSIBLE by arithmetic | **PASS** |  |
|  | K6 even instant sales need a $1M/48h inbound volume the openings cannot hold (settledP90 < 1% of target) | **PASS** |  |
| L | L1 the contradiction is surfaced (trace/excluded/field names it) | **FAIL** | verdict=DIRECT reach=None strategies=None mechanisms=None ms=5; p10=2802; p50=18974; p90=128474; heterogeneity=1.2172; distributionJustified=true |
|  | L2 not silently averaged: interval spans both sources (p10 <= 8,800 and p90 >= 40,500) | **PASS** |  |
|  | L3 a contradicted figure is not exported as a confident distribution | **FAIL** |  |
| M | M1 chosen combination contains both less-obvious lines | **PASS** | verdict=CANDIDATE_ONLY reach=1 strategies=127 mechanisms=2 ms=142; members=["o_audits","o_calendars"]; obviousAloneReach=0 |
|  | M2 chosen reach > the obvious strategy alone | **PASS** |  |
|  | M3 the obvious deal alone reaches < 0.25 (cash lands after deadline) | **PASS** |  |
| N | N1 reconstructed plan members include both less-obvious lines | **PASS** | verdict=CANDIDATE_ONLY reach=1 strategies=15 mechanisms=2 ms=2501; members=["o_audits","o_calendars"]; planMs=2501 |
|  | N2 reconstructed plan is not the obvious deal alone | **PASS** |  |
|  | N3 reconstructed reach >= 0.5 | **PASS** |  |
| O | O1 conversion estimate is COMPARABLE evidence, not ASSUMED | **PASS** | verdict=CANDIDATE_ONLY reach=1 strategies=7 mechanisms=1 ms=122; closeTier="COMPARABLE"; closeP10=0.1372; closeP90=0.2939; basis="PROBABILITY"; assurance="CALIBRATION_UNAVAILABLE"; range=null; strongVerdict="CANDIDATE_ONLY"; strongBasis=null; strongAssurance="CALIBRATION_UNAVAILABLE"; strongReach=1; unsizedVerdict="CANDIDATE_ONLY"; unsizedAssurance="CALIBRATION_UNAVAILABLE"; unsizedTier="COMPARABLE" |
|  | O2 the plan treats close as established (not in unestablished) | **PASS** |  |
|  | O3 plan is constructed with a probability basis | **PASS** |  |
|  | O4 plan carries a defensible interval (assurance range, not CALIBRATION_UNAVAILABLE) | **FAIL** |  |
|  | O5 stronger evidenced variant is certified ACCEPTED at 90% (EVIDENCED_PORTFOLIO) | **FAIL** |  |
|  | O6 unsized-only evidence is never certified | **PASS** |  |
| SEL | SEL key "aa-strong" kept | **PASS** | verdict=None reach=None strategies=31 mechanisms=None ms=29; kept={"aa-strong":true,"zz-strong":false,"ffffffffffff":true,"000000000000":true,"strong-3":false,"9c1e5b7a2d40":true}; oneOffKept=false |
|  | SEL key "zz-strong" kept | **FAIL** |  |
|  | SEL key "ffffffffffff" kept | **PASS** |  |
|  | SEL key "000000000000" kept | **PASS** |  |
|  | SEL key "strong-3" kept | **FAIL** |  |
|  | SEL key "9c1e5b7a2d40" kept | **PASS** |  |
|  | SEL strong DIRECT $9K one-off kept over $300 MECHANISM designs | **FAIL** |  |
| SIZE-100-48h | reconstruction is never worse than the plan as held | **PASS** | verdict=CANDIDATE_ONLY/STRUCTURAL reach=0.0117 strategies=1 mechanisms=2 ms=104; settledP50=0; committed=0; members=["o_templates","o_gig"]; basis="COVERAGE"; asHeldReach=0.0117; planMs=104 |
|  | basis is COVERAGE when any change is assumed | **PASS** |  |
|  | spends nothing | **PASS** |  |
|  | a plan is constructed (reach > 0) | **PASS** |  |
| SIZE-10K-30d | reconstruction is never worse than the plan as held | **PASS** | verdict=CANDIDATE_ONLY reach=0.9017 strategies=27 mechanisms=1 ms=9593; settledP50=35540; committed=364; members=["cop_lists"]; basis="COVERAGE"; asHeldReach=0.4983; planMs=9592 |
|  | basis is COVERAGE when any change is assumed | **PASS** |  |
|  | committed <= $3K | **PASS** |  |
|  | settledP50 < $100K (no fantasy median) | **PASS** |  |
| SIZE-100K-90d | reconstruction is never worse than the plan as held | **PASS** | verdict=CANDIDATE_ONLY/STRUCTURAL reach=0.2817 strategies=20 mechanisms=1 ms=1999; settledP50=118824; committed=0; members=["o_crm"]; basis="COVERAGE"; asHeldReach=0.0033; planMs=1998 |
|  | basis is COVERAGE when any change is assumed | **PASS** |  |
|  | committed <= ceiling | **PASS** |  |
| SIZE-1M-1y | reconstruction is never worse than the plan as held | **PASS** | verdict=CANDIDATE_ONLY/STRUCTURAL reach=0.06 strategies=20 mechanisms=1 ms=1205; settledP50=739005; committed=0; members=["o_wholesale"]; basis="COVERAGE"; asHeldReach=0; planMs=1205 |
|  | basis is COVERAGE when any change is assumed | **PASS** |  |
|  | committed <= ceiling | **PASS** |  |
| A | A1 at least one arrangement in the new industry | **PASS** | verdict=None reach=None strategies=74 mechanisms=4 ms=1470; inIndustry=70; named=70; pickedFromIndustry=1; sample={"label":"Grain farms of 500 to 2000 acres \u2014 Harvest-week combine rental for a grain farm: pool several buyers\u2019 purchases with one supplier and keep p |
|  | A2 an arrangement names payer AND supplier from the map | **PASS** |  |
|  | A3 the arrangement is decomposed into named parts to establish | **PASS** |  |
|  | A4 >= 2 distinct capture structures constructed for the industry | **PASS** |  |
|  | A5 an arrangement from the new industry enters the goal model as an estimate | **PASS** |  |
| G | G1 a TRANSFER of the pooled design to veterinary clinics exists, naming the dental precedent | **PASS** | verdict=None reach=None strategies=40 mechanisms=4 ms=450; transfers=9; tier="MECHANISM"; observations=1; label="Independent veterinary clinics \u2014 High per-unit cost of vaccines and consumables: pool several buyers\u2019 purchases with one supplier and keep part of th |
|  | G2 the transfer names material differences between the populations | **FAIL** |  |
|  | G3 the precedent does not raise the target to DIRECT/COMPARABLE evidence | **PASS** |  |
|  | G4 three dental figures from one study count as at most one observation | **PASS** |  |
| Q | Q1 (world check) before the evidence, the chosen plan does not rest on unsized B | **PASS** | verdict=NEEDS_EVIDENCE->NEEDS_EVIDENCE reach=0.8979 strategies=3 mechanisms=None ms=7814; bestReachMoney=49200; chosenBefore={"key":"only_o2","ids":["A"],"verdict":"NEEDS_EVIDENCE","reach":0.4985}; chosenAfter={"key":"basket_all","ids":["B","A"],"verdict":"NEEDS_EVIDENCE","reach":0.8979}; strategiesBefore=["basket_all:B+A:NEEDS_EVIDENCE:0.8904","only_o1:B:NEEDS_EVIDENCE:0.521","only_o2:A:NEEDS_EVIDENCE:0.4985"]; strategiesAfter=["basket_all:B+A:NEEDS_EVIDENCE:0.8979","only_o1:B:NEEDS_EVIDENCE:0.539","only_o2:A:NEEDS_EVIDENCE:0.4985"]; readMs=[5808,1999] |
|  | Q2 after the evidence, the chosen strategy changes | **PASS** |  |
|  | Q3 after the evidence, the chosen strategy includes the newly sized B | **PASS** |  |
|  | Q4 after the evidence, B is no longer missing MARKET_VOLUME | **PASS** |  |
| PERSIST | P1 a table holds constructed arrangements | **FAIL** | verdict=None reach=None strategies=40 mechanisms=4 ms=5602; tables=[]; rows=0; constructedKeysFound=0 |
|  | P2 rows exist after caches are cleared | **FAIL** |  |
|  | P3 the constructed (forward) arrangements are found by key in the rows | **FAIL** |  |

Totals: 61 PASS, 15 FAIL
