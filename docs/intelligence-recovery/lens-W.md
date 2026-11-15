# Lens W — continuous economic-world expansion, money-tree decomposition, evidence lifecycle

Read-only. Repo /home/user/V5 at the working tree of 2026-11-14. Sources read: ARCHITECTURE-RECORD §65, §72, §82, §92, §105;
docs/PLANNING-RECOVERY-2026-11-14.md; server/services/industry/{kernel,allocate,expand,graph,questions,verdict}.ts;
industry/construction/{roles,model,openWorld,economics,businesses,service,references}.ts; domain/{construction,industry,quant}.ts;
cash/{discovery,lifecycle,construct,properties,infoValue}.ts; russell/loop.ts; quant/{knowledge,pool,graph}.ts; migrations 006/008/023/072/114/139.

## Q1. Is there a standing process that grows economic knowledge with no goal active?

Partly. One exists, the industry kernel (`industry/kernel.ts`, called from `russell/loop.ts:1924` on every tick, and still running under DB pressure, `loop.ts:1892`).
But it is tied to an ACTIVE Cash Mode sprint, and every question it asks is framed as a short cash sprint.

| step | exists? | where | note |
|---|---|---|---|
| gap identification | yes, sprint-gated | `allocate.ts:124-366` (coverage rules over `graph.ts:coverageOf`) | gaps are only "never scanned / never mapped / bucket unasked", never "a fact that prices a position is UNKNOWN" |
| selection | yes: 6 lexicographic rules, no score | `allocate.ts:16-23,150-366`; tiebreak oldest-first `:369` | no information value, no decision or plan linkage; exploitation is only "this produced openings" (rules 2/3); slots are a constant 4 (`allocate.ts:97`) |
| research | yes | `expand.ts:263-374` → Russell candidate → gate | question text is `sprintGoalLine(objective)` (`questions.ts:52,83,121`; `operatingModel.ts:284`) |
| decomposition | yes, one-shot | MAP rule `allocate.ts:255,313` (`mapRounds === 0`); 8 node kinds (`072_industry_kernel.sql:72-75`) | a strict tree, never re-mapped; bootstrap asked once (`allocate.ts:152`) |
| commercial positions | partly | role asks `expand.ts:140-208`, one reserved slot `:283-296` | open-world arrangements reach research only through goal lenses (`discovery.ts:1113`, inside `openGoalDiscovery`, which needs a goal with daysLeft>0, `:1048`) |
| value capture | in code only | `roles.ts:286-325` (needs `broker_take_rate`, `price_per_unit`… facts) | with no facts it is UNKNOWN, and see W-5/W-6 |
| economics | goal-only | `goalConstruction` (`service.ts:155-183`), callers are only `routes/goals.ts:283,297,339` and `objectivePlan.ts:566` | nothing prices the world map without a goal |
| link to existing knowledge | weak | tree `parent_id`; constraints by node; ADJACENT_INDUSTRY is a child name, not an edge | no cross-industry mechanism link (W-8) |
| evidence | yes | `industry_nodes.source_claim_id` (072:66-90) | no date or validity on a node |
| persistence | yes for structure, no for numbers | industry_nodes, opportunity_constraints, capital_structures | numeric facts never persisted from research (W-5) |
| next gap | yes, but it dead-ends | allocator next tick | bootstrap and MAP run once; DEAD_END is permanent (W-3, W-4) |

## Findings

**W-1. Knowledge expansion needs an active cash sprint.** BLOCKING
- Where: `industry/kernel.ts:70` (`getCashMode` → EMPTY), `kernel.ts:96` (`discoveryAllowed`), `cash/lifecycle.ts:507-527` (ACTIVE only); `expand.ts:267,467`.
- Symptom: with no sprint, or a wound-down one, the economic map stops growing. Rounds already open are still absorbed. Every question says "This is for a short cash sprint whose goal is: …", so the map is biased toward 30-day cash.
- Root cause: the kernel was built as the "where" axis of Cash Mode discovery (§38) and reuses the sprint's gate and objective.
- Repair: extend `runIndustryKernel` with a standing world-map authority, the §80 standing grant shape (`ensureDiscoveryAuthority`), so it runs whenever research capacity is idle and no sprint exists. Give `questions.ts` a neutral context line when there is no sprint objective; `sprintGoalLine(objective|null)`. Keep `discoveryAllowed` for sprint buckets only.

**W-2. Selection has no information value and a constant concurrency.** MAJOR
- Where: `allocate.ts:16-23` (no score, by design), `:369-371` (rank then age), `:97` (`MAX_OPEN_KERNEL_ROUNDS = 4`).
- Symptom: the next subject is picked by rule order and age. Nothing asks whether an answer would change a construction, a goal or a position's price. Exploration versus exploitation is fixed by rank constants. Concurrency stays at 4 while the fleet is idle, which contradicts §78 and §98.
- Root cause: the allocator predates §92's decisive-input probe and `goals/researchYield`.
- Repair: within each rule, order by decision value. Count the UNKNOWN fact keys that leave coherent positions unpriced in the node's subtree (`openWorld(...).arrangements[].unpriced`), plus live goals or constructions whose `subtreeFor` reaches the node. Derive slots from `spareResearchSurfaces`, the way `openGoalDiscovery`'s `liveCap` does.

**W-3. The bootstrap and MAP rounds never refresh.** MAJOR
- Where: `allocate.ts:152` (only `!bootstrap.asked`), so the `round>1` branch at `questions.ts:57-63` is dead; MAP only when `mapRounds === 0` at `allocate.ts:260,313`.
- Symptom: classification revisions and structural change in an industry are never re-read. Only SCAN is revisited (rule 6, 24 h cool-off, `discovery.ts:1401`).
- Repair: re-admit BOOTSTRAP and MAP past a cool-off scaled by node age and by W-2's value. `nextRound` already numbers repeat rounds.

**W-4. An industry DEAD_END is a permanent verdict.** MAJOR
- Where: `verdict.ts:123-136` (3 barren scans and an empty map); `allocate.ts:215-218` declines it on every pass; `BARREN_ROUNDS = 3` at `discovery.ts:1404`.
- Symptom: a subject searched three times with sprint-framed buckets is never asked again, under any later goal. This contradicts §65 ("a dead end is a watch"), §47 and §105.
- Repair: make it a watch. Record reopen conditions on the existing `cash_reopen_conditions`/`BlockerKey` path: a new goal whose objective differs, a different SEARCH_BUCKET family, a new adjacent opening, or age. `standingOf` then returns WATCH until a condition fires.

**W-5. Research never reaches the economics.** BLOCKING
- Where: `industry_nodes` holds only name and description (072:66-90). `evidenceFromMap` (`service.ts:57-96`) emits no facts. `construction_facts` has exactly one writer, `POST /goals/:goalId/construction/facts` (`routes/goals.ts:312-323`), and is goal-scoped (`139_construction_facts.sql:18`, `workstream_id NOT NULL`).
- Symptom: every map-derived role and business is UNPRICED unless the one reference pack matches. Gated claims stating a price, a take rate or payment days never become `Fact` rows.
- Repair: in `expand.ts` `file()`, absorb claims that declare a fact key plus an amount (extend `STRUCTURAL_FINDINGS` with UNIT_ECONOMIC and reuse `structural_qualifier`/`structural_amount_cents`) into `construction_facts`. Make `workstream_id` nullable with `node_id` (a migration in both chains) and have `listConstructionFacts` union project facts. `assembleEvidence` already layers recorded facts.

**W-6. The role question's answer is never read back.** MAJOR
- Where: role asks `expand.ts:214-226` ask who occupies the role, on what terms and under which licence. Absorption is structural nodes, constraints or openings only (`expand.ts:505-530`). The round key subject|bucket means one asking per role (`expand.ts:196`).
- Symptom: `Segment.acceptsIntermediary`, gates and `broker_take_rate` stay unset, so `occupiable` stays UNKNOWN and value stays UNKNOWN for ever. The asking is not repeated.
- Repair: add ROLE_OCCUPANT and ROLE_TERMS findings that `file()` writes as gates (`opportunity_constraints`), with segment acceptance and take-rate facts going through W-5's path.

**W-7. The decomposition vocabulary is closed and shaped by logistics.** MAJOR (Q2)
- Where:
  - Positions: contract × supply × assets × aggregation × information, 4·4·4·2·2 (`domain/construction.ts:31-55`), with coherence rules at `businesses.ts:70-82`.
  - ASSETS: FLEET, FLEET_EQUITY, ROUTE_DENSITY, DISPATCH_DATA (`construction.ts:77-108`).
  - FACT_KEYS: capacity-unit service economics only (`:133-180`).
  - Economics has 4 branches: RECRUIT, INTRODUCE/REPRESENT, PRIME+NETWORK, EMPLOY (`economics.ts:168-262`).
  - FLOW_KINDS: MONEY, WORK, RISK, CAPACITY, AUTHORITY, DEMAND, with no INFORMATION, FINANCING or OBLIGATION (`:224`).
  - Node kinds: 8 (072:72-75), a strict tree (unique project/parent/name).
- Symptom:
  - These cannot be expressed or priced: resell/hold inventory, a software subscription (`technology_provider` value is 'NONE' at `roles.ts:155`, so a platform is only a cost), finance or factoring (`capital_arranger` is gated, `:162`, and TAKE only), owning and renting out an asset, and combinations.
  - No tasks or subtasks, information flows, obligations or financing chains.
  - Depth is recursion by kind (`domain/industry.ts:148-157`), unbounded but not adaptive, one MAP per node.
- Repair:
  - Extend `Position` with a revenue-basis or inventory dimension and give `formulasCore` a branch for each.
  - Add FLOW_KINDS INFORMATION, FINANCING and OBLIGATION.
  - Generalise the asset names (CAPACITY, CAPACITY_EQUITY, DENSITY, DATA).
  - Let MAP declare TASK nodes.
  - Seeds stay seeds; EVIDENCE roles already extend them (`roles.ts:403-423`).

**W-8. No cross-industry mechanism layer, and two construction vocabularies.** MAJOR
- Where: §82 `cash/properties.ts` Design (who fulfils, when money moves, a shared run, recurrence; the TRANSFER precedent) is used only in goal construction (`cash/construct.ts:208-218`, caller `goals/plan.ts:70`). §92 Position (`businesses.ts`) is separate. The quant COMPARABLE transfer is keyed on `mechanism` (`quant/knowledge.ts:718-726`).
- Symptom: a mechanism proven in one industry (a threshold presale, prepaid fulfilment) is not offered to §92 positions or to the world map. Transfer runs only under a live goal.
- Repair: one adapter, Position ↔ Design, with money timing and recurrence added as Position dimensions. Let `openWorld` enumerate both. Run the §82 transfer (a held gated precedent carried to another buyer) in the kernel pass as an ask.

**W-9. A fixed industry pack and sector buckets.** MINOR/MAJOR
- Where: `references.ts:223` holds the single pack `lastMileDelivery` (Metro Detroit, `:45-215`), matched by /logistics|courier|parcel…/. `assembleEvidence` applies it to map roots in `expand.ts:204` and `discovery.ts:841`.
- Symptom: a world-level "logistics" subject inherits Detroit actors, flows and undated ESTIMATE facts; `geography` is overwritten but the figures remain. SEARCH_BUCKETS include sector-specific lenses such as `broad-logistics` and `broad-physical-resale` (`discovery.ts:282-352`). Geography is otherwise unbiased (`operatingModel.ts:33`).
- Repair: apply reference packs only in `goalConstruction`, where the operator named the industry, never to map roots. Date pack facts (W-10).

**W-10. Construction facts have no time.** MAJOR (Q3)
- Where: `Fact` (`domain/construction.ts:194-206`) has no observed, published or validity date. The `construction_facts` columns (139:15-29) have none either. `resolveFact` (`model.ts:61-78`) takes the strongest status and unions every same-status range.
- Symptom:
  - A year-old OBSERVED price beats today's VERIFIED one.
  - Two OBSERVED readings months apart widen into a union instead of the newer one superseding.
  - The history is kept (`superseded`), but only by status.
- Repair: add `observed_at`, `source_date` and `valid_until` (both chains). `resolveFact` should take the newest within the top status and move expired facts to `superseded`.

**W-11. Claim metadata is incomplete.** MAJOR
- Has:
  - from 006:203-, 008:205-216, 023:15, 114:9: source url/title/publisher, `source_date` (publication), `retrieved_at` (observed), geography, timeframe, population, definition, primary_source, confidence (a float), `derived`/`derived_from` (lineage), contradiction_state, reconciliation, retrieval_state, `closes_on`;
  - from 060: a shared promotion with a declared good-for.
- Missing: method, sample size (it exists only in quant `ObservationValue.sampleSize`, `domain/quant.ts:56-63`), transaction type, industry (only `structural_subject`), limitations, a per-claim validity window, and invalidation conditions. Those exist only on quant Figures (`quant/graph.ts:105`, `invalidatedBy`), not on claims.
- Repair: add method, sample_size, limitations, valid_until and invalidated_by to the claim submission (`brain_submit_claims` schema and gate) and to research_claims (both chains). Feed them into the quant Observation (`knowledge.ts:838-841`).

**W-12. Staleness is a constant cliff, and refresh is not tied to plan impact.** MAJOR
- Where:
  - Per-quantity constants: `knowledge.ts:52-64` (365 days for cost and time, 1095 for respond and close).
  - Demand: `goals/plan.ts:124`, 30 days.
  - `quant/pool.ts:153-156` excludes outright when past the window.
  - `observationExpiry` covers only POINT_IN_TIME signals (`opportunitySignals.ts:257-271`).
  - industry_nodes carry no date.
  - World re-scan order is "most productive, past 24 h" (`allocate.ts:327-366`).
- Symptom: windows are per quantity, but they are not read from the evidence and do not widen uncertainty with age. Unrelated quantities share a window. Map knowledge never ages. Plan-impact refresh exists only for goals (C-9).
- Repair: the window comes from the claim's own `valid_until` when declared, else the quantity constant. In `pool.ts`, age widens the range instead of excluding. Add a kernel rule to refresh nodes whose supporting claims are past their window and which price a live construction (W-2's value).

**W-13. The map's flows have no payer.** MAJOR
- Where: `service.ts:74-76` turns a TRANSACTION_TYPE into `{from: parent, to: 'operators'}`. 'operators' is no actor, and the parent is usually a SUB_INDUSTRY, so `segmentOf` (`roles.ts:252-254`) returns null.
- Symptom: per relationship, nothing answers who pays, who supplies, or what the barrier is. Roles are enumerated with no buyer segment.
- Repair: have MAP declare the payer and supplier names on TRANSACTION_TYPE (`structural_qualifier`). Resolve them to BUYER_TYPE and FULFILMENT_SOURCE siblings in `evidenceFromMap`.

## What is good and should be kept

- No hardcoded industry list: the bootstrap asks the classification systems (`questions.ts:29-47`).
- Roles are seeds and are extended by evidence.
- An unknown is never favourable.
- History is append-only: claims, construction_facts, superseded.
- Quant observations carry lineage and context and are deduplicated.
- §105 removed the industry exclusion.
