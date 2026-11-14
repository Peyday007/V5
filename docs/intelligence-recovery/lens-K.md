# Lens K — what economic knowledge Brain durably holds, and what is only computed in memory

Investigator K, Surge B. Read-only. Repo /home/user/V5 at HEAD on 2026-11-14.
Sources read: docs/ARCHITECTURE-RECORD.md §81 (l.13733), §82 (l.13763), §92 (l.14690);
server/services/cash/{construct,properties,goalScenario,discovery}.ts; server/services/goals/{plan,reconstruction}.ts;
server/services/industry/construction/*; server/services/quant/{knowledge,ledger}.ts; migrations listed below.

## Bottom line

Brain durably holds **the parts** of economic knowledge (industry-map nodes, openings and their card facts,
gated claims, constraints, capital structures, monetization paths, construction facts, plan readings) but
**none of what it builds from them**. Every constructed arrangement (§81/§82), every commercial position and
business (§92), every causal/quant decomposition graph, every money flow beyond the raw TRANSACTION_TYPE node,
and every arrangement's value estimate, unknown-parts list, stress reading and transfer precedent exist only in
process memory (two Map caches with 10- and 30-minute lifetimes), are lost on restart/deploy, are recomputed
identically per process, and leave behind only a 12-hex hash inside a `cash_discovery_rounds.bucket_id` when a
research round was opened for them. The construction function is documented as "Pure over the rows it reads;
writes nothing" (construct.ts:206).

---

## 1. Tables/columns holding economic-world knowledge (SQLite migration / Postgres migration)

| Knowledge | Table / columns | SQLite | Postgres |
|---|---|---|---|
| Industry map (SECTOR, SUB_INDUSTRY, VALUE_CHAIN_LAYER, BUYER_TYPE, FULFILMENT_SOURCE, TRANSACTION_TYPE, BOTTLENECK, ADJACENT_INDUSTRY) | `industry_nodes(kind, name, description, parent_id, origin SEED/BOOTSTRAP/DISCOVERED, source_claim_id, retired_at)` | 072_industry_kernel.sql | 063_industry_kernel.sql |
| Map research rounds | `industry_rounds(purpose BOOTSTRAP/MAP/SCAN/CAPITAL, node_id, found)` | 072 | 063 |
| Capital requirements / restructurings (incl. PRESALE, BROKERAGE, SUBCONTRACT… mechanisms) | `capital_structures(entry_kind, requirement, mechanism, amount_cents, residual_cents, source_claim_id)` | 072 | 063 |
| Legal/structural constraints on a node or opening | `opportunity_constraints(kind, statement, effect, node_id/opportunity_id, source_claim_id)` | 072 | 063 |
| Structural tags on claims | `research_claims.structural_finding/_subject/_qualifier/_amount_cents` | 072 | 063 |
| Gated claims (source, geography, timeframe, population) | `research_claims(source_url, accepted, sourced, geography, timeframe, population, opportunity_signal, monetization_method)` | 006 (+008, 023, 064, 072, 090) | 001_baseline (+014…) |
| Openings (payer, price, mechanism, industry, terms, peak funding, hours, node link) | `cash_opportunities` (+`industry_node_id`, `discovered_by_candidate_id`, `discovery_round_id`, `opportunity_signal`) | 052 (+054, 064, 065, 072, 118) | 043 (+045, 055, 056, 063, 109) |
| Opening card facts — EVIDENCE vs RECOMMENDATION vs PERSON | `cash_card_facts(field, kind, value, claim_id, basis, assumptions, uncertainty)` | 058 | 049 |
| Ways of being paid per subject (§49) + facts, judgments, edges, rank history | `monetization_paths(method, origin SEED/ENUMERATED/EVIDENCED, opportunity_id XOR industry_node_id)`, `monetization_path_facts`, `monetization_path_judgments`, `monetization_path_edges(ENABLES/REQUIRES/COMPETES_WITH/…/STEPPING_STONE_TO)`, `monetization_rank_snapshots` | 090 (+091 commissions) | 081 (+082) |
| §92 construction facts (OBSERVED/VERIFIED/ESTIMATE/ASSUMPTION, low–high) | `construction_facts(workstream_id, fact_key, segment, low, high, status, source_url)` | 139 | 130 |
| Measured buyer behaviour | `cash_observations(kind BUYER_REPLIED/ACCEPTED/…)`, `cash_outcomes`, `cash_agreements`, `cash_fulfillments` | 109 | 100 |
| Constructed-arrangement research (only the hash) | `cash_discovery_rounds.bucket_id = 'goal-<goalId>-mx-<12hex key>'`, `found`, `state` | 057 | 048 |
| Plan readings (strategies, forecast JSON incl. acceptance, adoption, steps, reconstruction summary) | `goal_plan_readings`, `goal_outcomes` | 128 | 119 |
| Non-cash objective plans (generated strategies + critique) | `goal_objective_readings` | 148 | 139 |
| Scenario model / Monte-Carlo runs (gate-slot openings only) | `scenario_models.definition_json`, `scenario_runs.result_json` | 113 | 104 |
| Reasoning-method library / explorations (§101/§102) | `reasoning_methods`, `reasoning_explorations(+variations, variables, sweep)` | 143, 144 | 134, 135 |
| Forecast prediction/exposure/outcome ledger | `bin_events` rows of kind FORECAST_PREDICTION/EXPOSURE/OUTCOME (quant/ledger.ts:33) | 024 | 015 |
| Plan → opening adoption | `workstream_links(kind='OPPORTUNITY', relation='PURSUES')` | 082 | 073 |
| Generic research uncertainties | `research_uncertainties(disposition, belief_basis, consumer_kind)` | 076 | 067 |
| Cross-border two-sided deals (separate domain) | `deal_parties`, `deal_costs`, `deal_structure_evidence`, `deals`, `deal_observations` | 083 | 074 |
| Promoted cross-project findings (§31) | `shared_findings(claim_id, state)` | 060 | 051 |

**Computed only in memory (no table):**
- Constructed arrangements (`ConstructedArrangement`, construct.ts:95-135) — FORWARD/TRANSFER/REVERSE, design, value p10/p50/p90, unknownParts, stress, properties.
- Quant causal graphs (`composeArrangement` graph, quant/mechanism.ts; `reconstruct` estimates). quant/knowledge.ts:1-30 says explicitly "There is no second database of economic facts here" — observations are read from card facts + outcomes per call, cached per project for minutes.
- §92 positions/businesses/strategies/roles (`domain/construction.ts` Position; roles.ts:31-37 "there is no second position model and no store"); actors/segments/flows/chokepoints are re-derived from `industry_nodes` by `evidenceFromMap` (service.ts:57-95) — a money flow is a TRANSACTION_TYPE node re-read as `{kind:'MONEY'}` (service.ts:72-74).
- Goal model portfolio (which arrangements entered, their contribution) — only fragments survive in `goal_plan_readings.forecast` JSON.
- Transfers (`precedentByBase`, construct.ts:266-272) — never stored.

---

## 2. Owner baseline populations — production SQL (positional-free, SQLite + Postgres)

All statements use only `COUNT`, `COUNT(DISTINCT)`, `LOWER`, `COALESCE`, `substr`, `length`, `||`, `LIKE` — valid in both dialects. Add `AND <alias>.project_id = ?` to scope one project. No JSON functions are used (json_extract vs `::jsonb` differ by dialect), so JSON-only facts are marked accordingly.

1. **Mapped industries** (map roots — SECTOR or seeded subject)
   ```sql
   SELECT COUNT(*) FROM industry_nodes WHERE parent_id IS NULL AND retired_at IS NULL;
   ```
2. **Industry subcategories**
   ```sql
   SELECT COUNT(*) FROM industry_nodes WHERE kind IN ('SUB_INDUSTRY','VALUE_CHAIN_LAYER') AND parent_id IS NOT NULL AND retired_at IS NULL;
   ```
3. **Economic nodes** (all live map nodes; breakdown with GROUP BY kind)
   ```sql
   SELECT kind, COUNT(*) AS n FROM industry_nodes WHERE retired_at IS NULL GROUP BY kind ORDER BY kind;
   ```
4. **Buyer populations** (map BUYER_TYPE + distinct evidenced payers, which construct.ts:245-258 also treats as populations)
   ```sql
   SELECT (SELECT COUNT(*) FROM industry_nodes WHERE kind = 'BUYER_TYPE' AND retired_at IS NULL)
        + (SELECT COUNT(DISTINCT o.project_id || '|' || LOWER(COALESCE(o.industry, '')) || '|' || LOWER(o.payer))
             FROM cash_opportunities o
             JOIN cash_card_facts f ON f.opportunity_id = o.id AND f.field = 'payer' AND f.kind = 'EVIDENCE'
            WHERE o.payer IS NOT NULL AND o.duplicate_of_id IS NULL AND o.state NOT IN ('DECLINED','ARCHIVED')) AS buyer_populations;
   ```
   (No dedup between a node name and an identical payer text — the constructor dedups by normalised name only within a sector.)
5. **Customer needs** — BOTTLENECK nodes + distinct evidenced openings' offer scope. NB `cash_needs` is Brain's own operational blockers, NOT customer needs.
   ```sql
   SELECT (SELECT COUNT(*) FROM industry_nodes WHERE kind = 'BOTTLENECK' AND retired_at IS NULL)
        + (SELECT COUNT(DISTINCT o.project_id || '|' || LOWER(COALESCE(o.offer_scope, o.title)))
             FROM cash_opportunities o JOIN cash_card_facts f ON f.opportunity_id = o.id AND f.field = 'payer' AND f.kind = 'EVIDENCE'
            WHERE o.duplicate_of_id IS NULL AND o.state NOT IN ('DECLINED','ARCHIVED')) AS customer_needs;
   ```
6. **Bottlenecks**
   ```sql
   SELECT COUNT(*) FROM industry_nodes WHERE kind = 'BOTTLENECK' AND retired_at IS NULL;
   ```
7. **Supplier categories**
   ```sql
   SELECT COUNT(*) FROM industry_nodes WHERE kind = 'FULFILMENT_SOURCE' AND retired_at IS NULL;
   ```
8. **Labor roles — NOT MEASURABLE.** No table stores an industry's labor roles. `ActorRole 'LABOR'` (domain/construction.ts:210) exists only in code reference packs (references.ts) and is rebuilt per call; `labor_tasks`/`labor_market_options` (079) are *Brain's own* production tasks and hiring channels, not the economy's. Nearest stored proxy: `SELECT COUNT(*) FROM construction_facts WHERE fact_key IN ('labor_cost_per_day','contractor_day_rate','contractor_rate_per_unit','hiring_days','placement_fee');`
9. **Commercial positions — NOT MEASURABLE.** §92 positions (`CONTRACT_HOLDS × SUPPLY_MODES × ASSET_MODES × AGGREGATIONS × INFORMATION_MODES`, domain/construction.ts:32-56) and COM-13-1 roles are computed per call; roles.ts:31-37 states "no store". The space size is a code constant, not a measurement.
10. **Transaction mechanisms (capture structures)** — the constructor's vocabulary is a code table (5 structures, 51 coherent designs — verified by running `allDesigns(STRUCTURE_KEYS)`), not rows. What *is* stored and observed:
    ```sql
    SELECT 'map_transaction_type' AS src, COUNT(*) AS n FROM industry_nodes WHERE kind = 'TRANSACTION_TYPE' AND retired_at IS NULL
    UNION ALL SELECT 'opening_mechanism', COUNT(DISTINCT mechanism) FROM cash_opportunities WHERE duplicate_of_id IS NULL
    UNION ALL SELECT 'monetization_method', COUNT(DISTINCT method) FROM monetization_paths WHERE merged_into_id IS NULL
    UNION ALL SELECT 'capital_restructuring', COUNT(DISTINCT mechanism) FROM capital_structures WHERE entry_kind = 'RESTRUCTURING';
    ```
11. **Money flows** — only TRANSACTION_TYPE nodes (that is all `evidenceFromMap` turns into a MONEY flow):
    ```sql
    SELECT COUNT(*) FROM industry_nodes WHERE kind = 'TRANSACTION_TYPE' AND retired_at IS NULL;
    ```
    Flows of WORK/RISK/CAPACITY/AUTHORITY/DEMAND are not stored anywhere (reference packs in code only).
12. **Constructed arrangements — NOT MEASURABLE.** Never written (construct.ts:206 "writes nothing"). Only arrangements a round was opened for leave a trace (item 14).
13. **Unique arrangements — NOT MEASURABLE** for the same reason. Proxy (asked-about, distinct across goals): see 14.
14. **Researched arrangements** (distinct §81/§82 arrangement keys a constructed round was opened for; `pw…` keys are pathway constructions, excluded):
    ```sql
    SELECT COUNT(DISTINCT project_id || '|' || substr(bucket_id, length(bucket_id) - 11)) AS researched,
           COUNT(DISTINCT CASE WHEN state = 'HARVESTED' THEN project_id || '|' || substr(bucket_id, length(bucket_id) - 11) END) AS harvested,
           COUNT(DISTINCT CASE WHEN found > 0 THEN project_id || '|' || substr(bucket_id, length(bucket_id) - 11) END) AS produced_opening
      FROM cash_discovery_rounds
     WHERE bucket_id LIKE 'goal-%-mx-%' AND bucket_id NOT LIKE '%-mx-pw%';
    ```
    Openings filed by those rounds: `SELECT COUNT(*) FROM cash_opportunities o JOIN cash_discovery_rounds r ON o.discovered_by_candidate_id = r.candidate_id WHERE r.bucket_id LIKE 'goal-%-mx-%';`
    Accepted claims they produced: `SELECT COUNT(*) FROM cash_discovery_rounds r JOIN russell_missions m ON m.candidate_id = r.candidate_id JOIN research_claims c ON c.orchestration_id = m.orchestration_id AND c.accepted = 1 WHERE r.bucket_id LIKE 'goal-%-mx-%';`
15. **Quantitatively evaluated arrangements — NOT MEASURABLE.** Every arrangement's `value` is reconstructed in memory; the ≤12 that enter a goal model (goalScenario.ts:179, 297) are not recorded. Only proxy: readings whose stored forecast mentions an arrangement id (count of readings, not of arrangements):
    `SELECT COUNT(*) FROM goal_plan_readings WHERE forecast LIKE '%arr\_%' ESCAPE '\';` — `ESCAPE` is valid in both dialects.
16. **Opportunities incorporated into plans**
    ```sql
    SELECT COUNT(DISTINCT ref) AS pursued_openings,
           COUNT(DISTINCT CASE WHEN ref LIKE 'arr\_%' ESCAPE '\' THEN ref END) AS pursued_non_row_arrangements
      FROM workstream_links WHERE kind = 'OPPORTUNITY' AND relation = 'PURSUES' AND superseded_at IS NULL;
    ```
17. **Independently sourced economic observations (sourced claims)** — distinct source URLs behind accepted claims that some economic row cites:
    ```sql
    SELECT COUNT(DISTINCT c.source_url) FROM research_claims c
     WHERE c.accepted = 1 AND c.source_url IS NOT NULL
       AND (c.id IN (SELECT claim_id FROM cash_card_facts WHERE kind = 'EVIDENCE' AND claim_id IS NOT NULL)
         OR c.id IN (SELECT source_claim_id FROM industry_nodes WHERE source_claim_id IS NOT NULL)
         OR c.id IN (SELECT source_claim_id FROM capital_structures)
         OR c.id IN (SELECT source_claim_id FROM opportunity_constraints)
         OR c.id IN (SELECT claim_id FROM monetization_path_facts WHERE claim_id IS NOT NULL)
         OR c.structural_finding IS NOT NULL OR c.opportunity_signal IS NOT NULL);
    ```
    plus `SELECT COUNT(*) FROM construction_facts WHERE source_url IS NOT NULL;` and measured `SELECT COUNT(*) FROM cash_observations;`
18. **Unresolved economic variables — NOT MEASURABLE as such.** Arrangement `unknownParts` and §92 UNKNOWN inputs are never stored. Proxies:
    `SELECT COUNT(*) FROM research_uncertainties WHERE disposition IN ('OPEN','INVESTIGATING');` (all research, not economic-only) and
    `SELECT COUNT(*) FROM cash_needs WHERE state = 'OPEN' AND blocker_key IS NOT NULL;` (opening blockers).
19. **Reusable cross-industry relationships (transfers) — NOT MEASURABLE.** TRANSFER arrangements and `precedentByBase` are memory only. Nearest stored: `SELECT COUNT(*) FROM industry_nodes WHERE kind = 'ADJACENT_INDUSTRY' AND retired_at IS NULL;` and `SELECT COUNT(*) FROM monetization_path_edges;` and `SELECT COUNT(*) FROM shared_findings WHERE state = 'ACTIVE';`
20. **Plans constructed**
    ```sql
    SELECT (SELECT COUNT(*) FROM goal_plan_readings) AS cash_plan_readings,
           (SELECT COUNT(DISTINCT workstream_id) FROM goal_plan_readings) AS goals_with_plan,
           (SELECT COUNT(*) FROM goal_objective_readings) AS objective_readings;
    ```
    (A reading is written only when its digest changes, plan.ts:2444-2446, so this counts distinct conclusions, not passes.)
21. **Plans evaluated**
    ```sql
    SELECT (SELECT COUNT(*) FROM scenario_runs WHERE state = 'COMPLETE') AS scenario_runs,
           (SELECT COUNT(*) FROM reasoning_explorations) AS explorations,
           (SELECT COUNT(*) FROM goal_plan_readings WHERE scenario_run_id IS NOT NULL) AS readings_with_run;
    ```
22. **Plans independently verified**
    ```sql
    SELECT (SELECT COUNT(*) FROM goal_outcomes) AS outcomes_recorded,
           (SELECT COUNT(*) FROM goal_outcomes WHERE kind = 'ACHIEVED') AS achieved,
           (SELECT COUNT(*) FROM goal_plan_readings WHERE forecast LIKE '%"status":"ACCEPTED"%') AS accepted_readings,
           (SELECT COUNT(*) FROM goal_objective_readings WHERE critique <> '[]') AS critiqued_objective_plans;
    ```
    "Independent" holds only for `goal_outcomes` (reality) and the second-model critique on objective readings; cash plans have no independent verifier row.

---

## 3. The in-memory arrangement cache

**Production path** (one goal pass):
1. `readGoalPlanUnscoped` (plan.ts:904) → `goalArrangements(goal, target, now)` (plan.ts:914, def. 2913-2930).
2. `goalArrangements` returns from `lastArrangements: Map<goalId,{at, arrangements}>` (plan.ts:2909) if younger than `ARRANGEMENTS_FRESH_MS = 10 min` (plan.ts:2910, 2915-2916); else calls `constructArrangements` (construct.ts:208).
3. `constructArrangements` reads `industry_nodes` (BUYER_TYPE→demand, BOTTLENECK→needs, FULFILMENT_SOURCE→supply, grouped by map root = "sector", construct.ts:234-243), evidenced payers from `cash_card_facts` (245-258), precedents (266-272), priced/tied-up observations (275-299). It hashes all inputs + **the UTC day** into `memoKey` (307-309) and returns `constructionMemo` hit if < `CONSTRUCTION_MEMO_MS = 30 min` (310-311, 404); max 8 entries, FIFO eviction (333, 405-406).
4. On a miss, `composeConstruction` runs on the evaluator worker pool (`evaluatorPool.ts:81`, `evaluatorWorker.ts:25`) or inline: loop `designs (51, defaults first) → sectors → demand → needs → supplies`, `break outer` at `MAX_CONSTRUCTIONS = 400` (construct.ts:138, 391), then appends ≤ `MAX_REVERSE = 4` reverse designs (399), ranks lexicographically and interleaves by population (`rank`, `interleaveByPopulation`).
5. Into the goal model: `composeGoalModel` (goalScenario.ts:590) → `pickEstimatedArrangements` (goalScenario.ts:266-298, called 705-714): drops excluded / operating-model-breaking / `value.tier === 'UNKNOWN'` / p50 ≤ 0 / EXCEEDS (`estimatedFromArrangement` 189-192); scores `min(remaining, p50 × deals)`; keeps **one arrangement per buyer population** (290-296); **cutoff `slice(0, MAX_ESTIMATED_ARRANGEMENTS = 12)`** (goalScenario.ts:179, 297). These enter the quant portfolio as `arr_<key>` "ESTIMATE" candidates with every other input swept, never the gate's slots (comment 695-703).
6. Into research: `askConstructedArrangements` (plan.ts:2950-2990) filters EXCEEDS, orders by contribution then `byLeastAsked`, opens ≤ max(1, liveCap/2) rounds, one population per pass, via `openConstructedRound` (discovery.ts:1217) → `cash_discovery_rounds` row with bucket `goal-<goal>-mx-<key>`.

**Lost at restart:** both Maps are module-level; a restart/deploy loses all of it; two production processes each hold their own copy and recompose independently. Nothing about a composed arrangement survives except the 12-hex key on an asked round.

**What an arrangement carries** (construct.ts:95-135, built 655-675): key; structure; design {base, funding, aggregation, repeat}; origin FORWARD/TRANSFER/REVERSE; precedent {opportunityId,title}; sector (root name); demand/need/supply Primitives {name, claimId, from, ref}; label; properties/targetsMet/emergent; stress {exposure, worstCaseCents, failures}; evidenced count; value {tier,p10,p50,p90,observations}; unknownParts; relatedOpenings; question (prose); repeatBusiness.

**Owner's wanted fields vs held:**
| Wanted | Held? |
|---|---|
| industry context | partial — root name only (`sector`), no node path |
| buyer / need / fulfilment | yes, as Primitive refs (node or opening id) |
| assets | no |
| position | no (§92 Position not linked; structure only) |
| capture mechanism / transaction structure | yes (`structure`, `design`) |
| dependencies | no |
| economic model | no — graph built and discarded; only value p10/50/90 kept |
| known / unknown quantities | unknown part *names* only; known estimates not kept except value |
| evidence | claimId per primitive + observation count; no observation ids |
| lineage | precedent + primitive refs; no construction version, no input digest |
| geography | no (`safeName` actively rejects names stating a US state, construct.ts:144-148) |
| time | no (period = daysLeft at compose time) |
| legal restrictions | no (only owner exclusions; `opportunity_constraints` not read) |
| risks | partial (`stress.failures`) |
| capital | partial (`stress.worstCaseCents`) |
| payment timing | design.funding only; no days |
| related mechanisms | no |
| prior planning uses / evaluations / outcomes | no |

---

## 4. Findings

**K-1 BLOCKING — Constructed arrangements are never persisted.**
Evidence: construct.ts:206 ("writes nothing"), 331-334 (memo set), 404-406; plan.ts:2909-2930.
Symptom: owner asks "how many arrangements has Brain constructed / researched / evaluated" — unanswerable; after every deploy the space is recomposed from zero; the two production processes compose separately.
Root cause: §81/§82 treated construction as a pure derivation of rows; the only cache is a process Map keyed by an input digest and the day.
Repair: persist on compose (design in §5). Keep the pure function; add the write in `goalArrangements` after construction.

**K-2 MAJOR — `MAX_CONSTRUCTIONS = 400` silently truncates the design space by map order.**
Evidence: construct.ts:138, 372-392 (designs outermost, `break outer`); 51 designs (verified).
Symptom: with a map of e.g. 3 buyers × 3 needs × 3 supplies in one sector, ~15 designs exhaust the cap; later non-default designs (prepaid, threshold presale, subscriptions) are never composed for most buyers, and sectors later in `listNodes` order lose first. The pass reports no truncation.
Root cause: the cap was a CPU guard (comment 313-326), applied before ranking, and the order is enumeration order, not merit.
Repair: once persisted, compose incrementally (only signatures not already stored or whose inputs changed), and record a `truncated` count on the trace/degraded list; drop the cap to a per-pass work budget rather than a universe limit.

**K-3 MAJOR — Only ≤12 arrangements, one per buyer population, ever reach a goal model, and which ones is not recorded.**
Evidence: goalScenario.ts:179, 266-298 (one per population, `slice(0, 12)`), 705-714 (trace only).
Symptom: "quantitatively evaluated arrangements" and "opportunities incorporated into plans" for arrangements are not measurable; `arr_` ids appear only inside `goal_plan_readings.forecast` JSON and possibly as non-row `workstream_links.ref` values (plan.ts:2489-2494 links `accepted.opportunityIds` without filtering `isArrangementId`).
Root cause: estimates are synthetic `CashOpportunity` objects with id `arr_<key>` "Never a row" (goalScenario.ts:173).
Repair: record per reading the arrangement signatures entered and their contribution (the persisted arrangement row, §5, gets an evaluation entry); filter `isArrangementId` before `linkWorkstream` or link to the persisted arrangement instead.

**K-4 MAJOR — Research results are not attached to the arrangement; refutation is remembered only as backoff.**
Evidence: discovery.ts:1256-1260 (bucket = goal-scoped hash), 954-983 (`nextGoalRoundFor` barren backoff up to 7 days), construct.ts:647-649 ("refutes the arrangement … is a useful answer").
Symptom: a refuted arrangement is re-composed every pass and re-asked after backoff; the accepted claims a round produced are reachable only via rounds→missions→claims joins, and nothing marks the arrangement REFUTED or CONFIRMED.
Root cause: no row for the arrangement to carry a verdict.
Repair: on harvest of an `-mx-` round, write the outcome (found count, claim ids, refuted/confirmed) to the persisted arrangement.

**K-5 MAJOR — Research and arrangements are goal-scoped; nothing is reused across goals or projects.**
Evidence: bucket `goal-<goalId>-mx-<key>` (discovery.ts:1237, 1256-1257); `byLeastAsked` reads only this goal's rounds (plan.ts:2969); key built from node/opening ids (construct.ts:536-541), which are project-local.
Symptom: a second goal on the same project re-asks the same arrangement; a second project with the same buyer population cannot see it.
Root cause: identity = hash of row ids, not of the economic structure.
Repair: structural signature (§5) as the identity; round lookup by signature across goals in the project.

**K-6 MAJOR — §92 positions, roles, flows, businesses and strategies are never stored; money flows = TRANSACTION_TYPE nodes only.**
Evidence: roles.ts:31-37 ("no store"); service.ts:57-95; strategy.ts:196-203 (per-call Map cache); only `construction_facts` (139) persists.
Symptom: "commercial positions", "labor roles", "money flows" baselines not measurable; a decision cannot be compared with its predecessor.
Root cause: §92 "Learning is a row" was applied to facts only.
Repair: lower priority than K-1; a persisted arrangement row can carry the §92 `Position` the construction chose (`position_json`) when the construction hands its first transaction to the cash path.

**K-7 MINOR — Arrangement identity mixes two key schemes and depends on row ids.**
Evidence: construct.ts:536-541 (default design: `[structure, refs]`; others: `[designKey, refs]`; reverse: `['reverse', designKey]`), 12-hex truncation (166-168).
Symptom: retiring and re-creating a node with the same name yields a new key and loses round history; duplicates across sectors with identical names are separate arrangements.
Repair: signature over normalised content (§5); keep the legacy key as an alias column so existing round history still resolves.

**K-8 MINOR — Geography is actively stripped and legal constraints are not read.**
Evidence: construct.ts:144-148 (`safeName` rejects any name naming a state); construct.ts never reads `opportunity_constraints`.
Symptom: arrangements carry no geography or legal restriction, though the rows exist.
Repair: carry `research_claims.geography` of the primitive's claim and the node's `opportunity_constraints` ids on the persisted row (as references, not copied text).

**K-9 MINOR — `cash_needs` is not "customer needs".** Naming trap for whoever builds the baseline; customer needs are BOTTLENECK nodes + evidenced opening scope (SQL 5).

---

## 5. Minimal persistent design (extend, not duplicate)

**Which table.** Extend the §49 ledger, `monetization_paths` (+ `_facts`, `_judgments`, `_edges`, `_rank_snapshots`). It is already "a way of being paid, for a subject, with evidence-vs-recommendation facts, judgments, typed edges between paths and rank history" — exactly the arrangement's shape — and today it holds a *second* payment vocabulary (`MonetizationMethod`) beside the constructor's `Structure`. Persisting arrangements anywhere else would be the third. `industry_nodes` is wrong (its CHECK requires a claim per non-seed node; an arrangement is a hypothesis).

**Migration** (SQLite `149_constructed_arrangements.sql`, table rebuild per the `_rebuilt` precedent because the subject CHECK must relax; Postgres `140_constructed_arrangements.sql` with `ALTER TABLE … DROP CONSTRAINT / ADD CONSTRAINT`):
- `origin` CHECK adds `'CONSTRUCTED'`.
- Subject CHECK becomes `(opportunity_id IS NULL) <> (industry_node_id IS NULL) OR construction_origin = 'REVERSE'` (reverse designs have no buyer yet).
- New columns: `design_signature TEXT` (unique per project where not null), `legacy_key TEXT` (the 12-hex key, so `-mx-` rounds still resolve), `design_json TEXT` ({base,funding,aggregation,repeat}), `construction_origin TEXT CHECK IN ('FORWARD','TRANSFER','REVERSE')`, `need_node_id`, `supply_node_id` (→ industry_nodes), `precedent_opportunity_id` (→ cash_opportunities), `first_goal_id`, `last_composed_at`, `inputs_digest`.
- `CREATE UNIQUE INDEX idx_monetization_paths_signature ON monetization_paths(project_id, design_signature) WHERE design_signature IS NOT NULL;`
- Update `MonetizationPath` row type in `server/domain/types.ts` / `server/domain/monetization.ts` and the mapper in `server/repos/monetization.ts` in the same change (CLAUDE.md §3).

**Dedup key — structural signature, not text:** `sha256(designKey(design) | kindPath(demand) | kindPath(need) | kindPath(supply))` where `kindPath(node)` = the node's kind plus the chain of normalised names from its map root (or `OPENING:<normalised payer>|<normalised industry>` for an evidenced payer; `REVERSE` for none). Normalisation = construct.ts's `norm`. Row ids are excluded, so a re-created node or the same population in another goal maps to the same row.

**Hypothesis vs observed:** the row itself is `origin='CONSTRUCTED'` (a hypothesis by definition, §82). Its quantities go into `monetization_path_facts` with the kinds that already encode the distinction: `RECOMMENDATION` (basis = reconstruction tier + observation ids, assumptions = swept range, uncertainty = p10–p90) for reconstructed estimates; `EVIDENCE` with `claim_id` only when a gated claim from its round establishes the part (the CHECK `kind <> 'EVIDENCE' OR claim_id IS NOT NULL` already enforces it). Unknown parts are *not stored* — they are the decomposition parts with no fact row (072's rule 3: what can be derived is not stored).

**Reload / reuse:** `constructArrangements` gains a read of stored CONSTRUCTED paths for the project (`listPaths({projectId, origin:'CONSTRUCTED'})`); composition then only (re)composes signatures whose `inputs_digest` changed or that are new, which also replaces the 400-cap truncation (K-2) with incremental work. Cross-goal: `openConstructedRound`/`byLeastAsked` look up rounds by `legacy_key`/signature across all goals in the project. Cross-project reuse stays through `shared_findings` (§31) for the *claims*; the arrangement row is project-private (§34).

**Write hooks (concrete):**
1. `server/services/goals/plan.ts` `goalArrangements` (2913-2930): after `constructArrangements`, `await recordConstructedArrangements(projectId, goal.id, arrangements)` — new function in `server/repos/monetization.ts` beside `recordPath`, idempotent by the unique index (same collide-and-lose pattern as `enumeratePossibilities`, enumerate.ts:135-148).
2. `server/services/cash/goalScenario.ts` `composeGoalModel` (705-714): for the ≤12 picked, write a `monetization_rank_snapshots` row (reason `ENTERED_THE_LEDGER` / `THE_FIELD_AROUND_IT_CHANGED`, criterion = goal id + contribution) — evaluation history without a new table.
3. `server/services/cash/discovery.ts` harvest of a `goal-*-mx-*` round: record claim-backed `EVIDENCE` facts on the matching path and, when a round finds nothing and states refutation, a Brain-sourced judgment — requires widening `monetization_path_judgments.channel`/`decided_by_id` to allow `BRAIN` (same migration).
4. `server/services/goals/plan.ts` persistReading (2489-2494): skip `isArrangementId` refs or link `kind='OPPORTUNITY'` only for rows; arrangement adoption is a rank snapshot.
5. Expose counts through the existing read surfaces (`npm run goals`, `GET /goals/:id/construction`) — no new page (invariant 35).

Run `brain_duplicate_mechanism_check` before building: this design is an extension of `monetization_paths`, not a new mechanism.
