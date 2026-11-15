# Intelligence recovery (Surge B) — 2026-11-14

The owner's order (2026-11-14, ~19:40Z): a separate, concurrent operation to
discover, repair, expand and verify how intelligently Brain understands the
economic world, reconstructs quantities, reasons about strategy, learns, and
plans — directed by Hermes. Surge A (planning/reliability recovery,
`docs/PLANNING-RECOVERY-2026-11-14.md`, session "Evil dies tn") keeps the
runtime, deploy, database-pressure and event-loop work; this operation does not
edit those owners (`russell/loop.ts` pressure paths, `db/pressure.ts`,
`evaluatorPool.ts`, deploy workflows) and hands findings there through this
file and the engineering records.

This file is the durable inventory. Every status change is a commit.

## Method

Five independent read-only lenses, concurrently, each asked for root causes
with file:line evidence and a reproduction:

| lens | what it reads |
|---|---|
| K — knowledge storage | what economic knowledge is durable vs in-memory; census SQL; persistent arrangement design |
| Q — reconstruction → acceptance | quant ladder → goalScenario → portfolio basis → judgeAcceptance |
| S — search and strategy | arrangement cutoffs, diversity, multidirectional reasoning, transfer |
| W — world expansion | standing knowledge growth, money-tree decomposition, evidence freshness |
| H — Hermes as director | operator tools, model routing, RunPod, what directing this surge needs |

Production at the start (2026-11-14 19:35Z, `brain_operator_goals`): five goals,
every one `NOT_DERIVED` ("Brain was too busy to derive the goal this run");
free lane "Brain database saturated"; `brain_operator_history` HTTP 503. The
runtime is Surge A's; this operation's production measurements wait on it
where they need a live derivation.

## Inventory

Full lens reports with file:line evidence: `docs/intelligence-recovery/lens-*.md`.
Status vocabulary as the owner gave it. Owner = the Surge B repair stream
(branch) or "Surge A" for a handoff.

### Root causes (grouping)

| RC | root cause | findings | repair stream | status |
|---|---|---|---|---|
| IB-1 | **Knowledge grows only inside a cash sprint.** The industry kernel runs only under an ACTIVE Cash Mode, selects by fixed-order rules, asks each question once, and declares a subject permanently barren | W-1, W-2, W-3, W-4 | world-expansion | RELEASED (Deploy 1070; standing rounds, F7 in 1078) — production growth NOT YET VERIFIED (nodes 91→91 at 02:25Z) |
| IB-2 | **Economic facts are hand-entered, undated and logistics-shaped.** Construction facts come only from a person per goal, carry no date, resolve by status alone; positions are a closed logistics vocabulary; flows name no payer/supplier | W-5, W-6, W-7, W-10, W-13, W-9 | construction-knowledge | RELEASED (1070) + F2/F3 (1078) — production construction facts 0 at 02:25Z; NOT YET VERIFIED |
| IB-3 | **Hermes cannot be given a mission or directly track/reattempt work.** Fixed $10K brief; no inventory, re-attempt or outside-verification tool; RunPod ceilings forbid a 48 GB director pod | H2-1, H2-2, H2-3, H2-5, H2-7, H2-9, H2-11 | hermes-director | VERIFIED on production: Hermes runs with the SURGE:B mission, keeps the inventory, decides, commissions, re-attempts (opr_a1f7…, opr_1981…) |
| IB-4 | **Evidence lifecycle is thin.** Claims lack method, sample size, transaction type, limitations, validity window, invalidation; staleness windows are constants that cut off rather than widen | W-11, W-12 | (after IB-2) | ROOT CAUSE CONFIRMED |
| IB-6 | **Nothing Brain constructs is kept.** Arrangements live in process memory (10-min / 30-min caches), lost every restart; the only trace is a hash in a round's bucket id; research answers never attach back; no reuse across goals or projects | K-1…K-8 | arrangement-library | VERIFIED on production: 404 constructed arrangements stored, 404 unique design signatures (census 23:42Z, 02:25Z) |
| IB-7 | **Selection is arbitrary where it matters most.** 400 cap cuts by enumeration order; 12 enter the model by a saturating score with a sha256-id tiebreak; unknowns ranked at their midpoint; learning rewards unchallenged reach and is keyed to one goal | S-1…S-12, S-14…S-17 | search-selection | VERIFIED on production: 12 of 404 arrangements evaluated in the goal model, 1 picked (02:25Z) — screen/diversity live |
| IB-8 | **The acceptance gates are mutually exclusive.** Chain links accept conversion only from Brain's own sales and fixed values; assurance counts *studies* (≥20) and puts a Wilson bound over them. Every input passes one gate only in the form the other refuses, so only TARGET_MET (cash already collected) can be ACCEPTED | Q2-1…Q2-12, S-13 | acceptance | RELEASED (1070): production plan CANDIDATE_ONLY with stated coverage, never certified on assumption (02:23Z read); certification path verified by evaluation case O |
| IB-5 | **Two construction vocabularies** (§82 designs vs §92 positions); transfer runs only under a goal | W-8 | (after IB-2, IB-6) | ROOT CAUSE CONFIRMED |

### Findings

| id | capability | symptom | sev | owner | status |
|---|---|---|---|---|---|
| W-1 | world expansion | kernel needs an ACTIVE sprint; questions worded as sprint work (`industry/kernel.ts:70,96`) | BLOCKING | world-expansion | REPAIRED, AWAITING VERIFICATION (6862da0, migrations 150/141) |
| W-2 | adaptive selection | six fixed-order rules, oldest-first, constant concurrency 4 (`allocate.ts:16-23,97,369`) | MAJOR | world-expansion | REPAIRED, AWAITING VERIFICATION (6862da0, migrations 150/141) |
| W-3 | expansion | root question and each breakdown asked once; repeat branch unreachable (`allocate.ts:152,260,313`) | MAJOR | world-expansion | REPAIRED, AWAITING VERIFICATION (6862da0, migrations 150/141) |
| W-4 | exploration | barren after 3 scans is permanent (`verdict.ts:123-136`) | MAJOR | world-expansion | REPAIRED, AWAITING VERIFICATION (6862da0, migrations 150/141) |
| W-5 | quantitative knowledge | construction facts written only by a person, per goal; map-built roles unpriced (`construction/service.ts:57-96`) | BLOCKING | construction-knowledge | RELEASED (1070) + F3 back-fill (1078); NOT YET VERIFIED (facts 0) |
| W-6 | decomposition | role-occupant answer asked once, never read back (`expand.ts:196,214`) | MAJOR | construction-knowledge | RELEASED (1070); NOT YET VERIFIED |
| W-7 | money-tree positions | closed logistics-shaped position vocabulary; 4 economics branches; no resale/subscription/finance/rent (`domain/construction.ts:31-224`) | MAJOR | construction-knowledge | RELEASED (1070); NOT YET VERIFIED |
| W-8 | transfer | two construction vocabularies; transfer goal-only | MAJOR | transfer-positions | RELEASED in Deploy 1075 (parts 3+4) — repaired (5426902): Position↔Design adapter; kernel asks precedent transfers with no live goal, naming TRANSFER_MATERIAL; surgeBMechanismTransfer 6/6 |
| W-9 | generality | one Metro Detroit last-mile reference pack applied to any "logistics" subject | MINOR | transfer-positions | RELEASED in Deploy 1075 (parts 3+4) — repaired (5426902): reference packs apply only where an operator named the industry; residual: map roots carry no economics until research facts (W-5) feed them |
| W-10 | freshness | construction facts undated; old OBSERVED beats new VERIFIED | MAJOR | construction-knowledge | RELEASED (1070): dated facts, newest within top status; NOT YET VERIFIED (no facts yet) |
| W-11 | evidence lifecycle | claims lack method, sample size, transaction type, limitations, validity, invalidation | MAJOR | evidence-lifecycle | RELEASED in Deploy 1075 (parts 3+4) — repaired (a66b80a): claims carry method, sample size, limitations, valid_until, invalidated_by (migrations 154/145) into quant observations; surgeBEvidenceLifecycle passes |
| W-12 | freshness | constant staleness windows cut evidence off rather than widen uncertainty; map nodes undated | MAJOR | evidence-lifecycle | RELEASED in Deploy 1075 (parts 3+4) — repaired (a66b80a): past its window an observation decays (half-weight per half-life, wider spread) instead of being dropped; met invalidation excludes with reason; staleRefreshPriority ranks by plan sensitivity (not yet wired into dispatch) |
| W-13 | who pays | map flows point at "operators", no payer/supplier resolved (`service.ts:74-76`) | MAJOR | construction-knowledge | RELEASED (1070); NOT YET VERIFIED |
| H2-1 | Hermes direction | no way to give a run a mission (`domain/operator.ts:148`) | BLOCKING | hermes-director | VERIFIED on production (mission set, opr runs) |
| H2-2 | Hermes direction | no inventory tool | MAJOR | hermes-director | VERIFIED on production (inventory upserts by Hermes) |
| H2-3 | Hermes diagnosis | deficiencies from three hard-coded detectors (`director.ts:883`) | MAJOR | hermes-direction | RELEASED in Deploy 1075 (parts 3+4) — repaired (b5198b8): + inventory, stuck-plan and unreported-round detectors; surgeBHermesDirection 10/10 |
| H2-4 | Hermes honesty | lesson-only interventions reported as queued (= Surge A H-4, merged, unverified) | MAJOR | Surge A | AWAITING VERIFICATION |
| H2-5 | Hermes direction | no reassign/re-attempt of stalled Factory work | MAJOR | hermes-director | VERIFIED on production (reattempt used 02:35Z) |
| H2-6 | Hermes research | research only via a commission | MINOR | hermes-direction | RELEASED in Deploy 1075 (parts 3+4) — repaired (b5198b8): EVIDENCE commission on a goal (incl. paused) or as method research; spend/outreach still refused |
| H2-7 | Hermes verification | cannot verify a repair it did not commission | MINOR | hermes-director | VERIFIED on production (decide used) |
| H2-8 | runtime | operator reads >20 s; DB contention | MAJOR | **Surge A** (RC-1) | handed off |
| H2-9 | compute | RunPod ceilings block any 48 GB pod; no 48 GB recipe | MAJOR | hermes-director | VERIFIED on production |
| H2-10 | verification | no operator proof since recovery merges | MAJOR | this operation, after release | DISCOVERED |
| H2-11 | generality | brief is $10K-specific | MINOR | hermes-director | VERIFIED on production |
| K-1 | persistent knowledge | constructed arrangements never persisted (`construct.ts:206`, `plan.ts:2909`) | BLOCKING | arrangement-library | VERIFIED on production (404 stored rows survive restarts/redeploys 1070→1075) |
| K-2 | search breadth | 400 cap cuts by enumeration order, unreported (`construct.ts:138,391`) | MAJOR | arrangement-library | RELEASED (1070) |
| K-3 | traceability | which 12 reach a model is not recorded; `arr_` ids may be linked as openings (`plan.ts:2489`) | MAJOR | arrangement-library | RELEASED (1070) |
| K-4 | learning | research answers never attach to the arrangement; refuted ones re-asked | MAJOR | arrangement-library | RELEASED (1070) |
| K-5 | reuse | rounds per goal, keys are project-local hashes; no cross-goal/project reuse | MAJOR | arrangement-library | RELEASED (1070) |
| K-6 | persistent knowledge | §92 positions, roles, flows not stored | MAJOR | transfer-positions | RELEASED in Deploy 1075 (parts 3+4) — repaired (5426902): arrangement rows carry position_json/position_key (155/146); census counts positions and money flows |
| K-7 | identity | keys from row ids; recreated node loses history | MINOR | arrangement-library | VERIFIED on production (404 distinct design signatures for 404 rows) |
| K-8 | geography | arrangements carry no geography; constraints never read | MINOR | arrangement-library | RELEASED (1070) |
| S-1 | search narrowing | 12 picked by saturating score + sha256 tiebreak; experiment: strong DIRECT arrangement kept/dropped by its key string; swapping it in raised reach 1.55%→2.8% (`goalScenario.ts:283-297`) | BLOCKING | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-2 | diversity | one arbitrary design per buyer population | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-3 | breadth | = K-2 | MAJOR | arrangement-library | RELEASED (1070) |
| S-4 | research routing | only the 12 get contribution; rest −1 → research self-reinforces the hash pick | MAJOR | (fixed by S-1) | REPAIRED via S-1, AWAITING VERIFICATION |
| S-5 | invariant 39 | unknown ranges ranked at midpoint (2–50% beats evidenced 5–25%) | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-6 | reasoning | no move can add a constructed arrangement outside the 12 | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-7 | method learning | learns from unchallenged and critic-flagged reach | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-8 | transfer of methods | learned methods keyed by opening ids; don't transfer across goals | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-9 | learning stats | repeat reads of one goal counted as independent | MINOR | adaptive-search | RELEASED in Deploy 1075 (parts 3+4) — repaired (91030b6), AWAITING RELEASE |
| S-10 | learning | stance yield computed, never fed back | MAJOR | adaptive-search | RELEASED in Deploy 1075 (parts 3+4) — repaired (91030b6): stance seed budget by posterior with floor; surgeBAdaptiveSearch 7/7 |
| S-11 | invention | model-invented methods only retune 4 operations on held openings | MAJOR | search-selection | RELEASED in Deploy 1075 (parts 3+4) — repaired (9f4f908): a model-invented design + buyer population is composed by construction and enters as a MECHANISM-tier, never-certifiable candidate; refusals carry reasons. surgeBInventedDesign 4/4 |
| S-12 | transfer | transfers model no material differences; precedent bonus outranks gated evidence | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-13 | correlation | = Q2-10 | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| S-15 | wiring | `bestReachCents` never reaches construction (10-min cache) | MINOR | arrangement-library | RELEASED (1070) |
| S-16 | screening | factorial screen drops levels that matter only in combination | MINOR | adaptive-search | RELEASED in Deploy 1075 (parts 3+4) — repaired (91030b6), AWAITING RELEASE |
| S-17 | traceability | nothing records what was cut | MINOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| Q2-1 | acceptance | chain link and assurance accept mutually exclusive input forms → EVIDENCED_PORTFOLIO unreachable (repro: 3 sized comparables → basis PROBABILITY, still CANDIDATE_ONLY) | BLOCKING | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-2 | statistics | "sample" = number of studies ≥ 20; Wilson bound double-counts (`quant/portfolio.ts:1027,1061`) | BLOCKING | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-3 | conversion | CONVERSION only from Brain's own sales (`plan.ts:549`) | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-4 | evidence | Brain's own outreach record relabelled UNKNOWN (`portfolio.ts:440`) | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-5 | evidence parsing | `readRate` never reads N; unsized ranges counted as ~57 trials | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-6 | improvement loop | below threshold → empty or generic research needs; next test blocked on contact permission → loop | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-7 | cash timing | inferred days-to-cash can only refuse, never establish | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-8 | verdicts | CONSTRUCTED vs IMPROVEMENT_REQUIRED collapse to CANDIDATE_ONLY; Hermes challenge only after ACCEPTED (never fires) | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-9 | calibration | MEASURED_RECORD deadlocked on RECOMMENDABLE readings | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-10 | correlation | shared-comparable rates drawn independently → invented diversification | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| Q2-11 | statistics | no small-k predictive interval, no vendor-figure bias discount, funnel stage not material, lineage only by URL, no model uncertainty | MAJOR | acceptance | PARTIAL (t-widening, vendor discount, funnel stage, study-level lineage done; model uncertainty not) |
| E-1 | cash timing | a signed $20K contract paying a deposit + milestone ($14K) inside the window counts $0 toward the goal (independent evaluation case E) | MAJOR | follow-up (portfolio cash timing) | REPAIRED, AWAITING VERIFICATION (paymentSchedule; eval case E passes) |
| L-1 | evidence interpretation | contradictory sources ($8K vs $45K for one quantity) pooled silently into a DIRECT-tier confident distribution; no contradiction surfaced (case L) | MAJOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |
| I-1 | capital restructuring | under a capital ceiling a presale design (reach 0.863) was refused as IMPLAUSIBLE: the plausibility critic compared gross settled cash ($50.6K, ~34×) to capital, though most passes back to the supplier; kept cash is ~12× (`reconstruction.ts:285`) | MAJOR | follow-up | REPAIRED, AWAITING VERIFICATION (critic reads kept cash; eval case I passes) |
| P-SPEED | planning speed | production `goals plan` on the $10K goal (run 43635941750, e37e0ff): 26 min 41 s for one full read (target 1–5 min) | MAJOR | planning-speed (algorithmic); runtime half (thread copy, 384 MB heap) → Surge A | VERIFIED on production: plan read 71 s after Deploy 1075 (baseline 26 min 41 s) |
| PRICE-POOL | economic model | production read: every constructed arrangement — anime production committees, HVAC firms, homeowners, contractors — shows the identical price E 281, fulfil 0–43,661, capital 0–72,769: arrangements are priced from one project-wide observation pool, not their own buyer's evidence (production instance of S-13) | MAJOR | arrangement-library | RELEASED (1070); its fallback regressed as F4, repaired in 1078 — NOT YET VERIFIED |
| Q2-12 | robustness | assurance sample regex-parses prose (`plan.ts:852`) | MINOR | acceptance | REPAIRED, AWAITING VERIFICATION (367b2f5) |

### Economic knowledge baseline (production, 2026-11-14 19:53Z, Goals run 43634448117)

| layer | population | count |
|---|---|---|
| stored | mapped industries (SECTOR nodes) | 52 |
| stored | industry subcategories | 12 |
| stored | economic nodes (all) / of which Brain discovered | 91 / 17 |
| stored | buyer populations (BUYER_TYPE) | 11 |
| stored | customer needs / bottlenecks (BOTTLENECK) | 7 |
| stored | supplier categories (FULFILMENT_SOURCE) | 7 |
| stored | transaction mechanisms (TRANSACTION_TYPE) | 2 |
| stored | projects holding an industry map | 1 |
| stored | labor roles | not stored (no vocabulary; text only) |
| stored | commercial positions | not stored (closed in-code table) |
| stored | openings held / distinct capture mechanisms on them | 498 / 6 |
| evidenced | money flows (openings with payer and price) | 49 |
| evidenced | research claims / SOURCED claims / distinct sources | 19,929 / 16,762 / 4,930 |
| evidenced | construction facts (any status) | 0 |
| evidenced | unresolved economic variables (as stored facts) | 0 stored — unknowns exist only in memory |
| generated | constructed arrangements asked about (`-mx-` rounds) | 70 |
| stored | constructed arrangements durably stored / unique / transfers | **0 — no store exists** (K-1) |
| evaluated | plans constructed / evaluated (goal plan readings) | 100 / 100, on 1 goal |
| evaluated | non-cash objective readings | 0 |
| validated | plans accepted (RECOMMENDABLE) | 0 |
| validated | plans verified by an outcome | 0 |
| validated | commercially validated openings (settlement recorded) | 0 |

Reading: Brain holds a large evidence base (16.8K sourced claims) but a very
small structured world model (91 nodes, one project, 2 transaction types), no
stored quantities (0 construction facts), and nothing it constructs. "400
arrangements per pass" were 0 durable arrangements. 100 plan readings exist for
one goal and none was ever accepted — consistent with Q2-1 (acceptance
unreachable).

### Independent evaluation baseline (pre-repair code)

`tests/intelligenceEvaluation.test.ts` (kept beside the record as
`docs/intelligence-recovery/intelligenceEvaluation.test.ts.txt` until the
repairs land, so the release gate is not run against known failures), written by
an evaluator who did not read the repair branches: **18 cases, 11 pass, 7 fail;
61/76 assertions**. Failing: E (deposit+milestone $0), G2 (transfer names no
differences), I (no capital restructuring), L (contradiction pooled), O4/O5
(no interval; strong comparables never certified), SEL (strong arrangement
dropped by key string), PERSIST 0/3. Full table:
`docs/intelligence-recovery/evaluation-baseline.md`.

### Repairs integrated (branch `claude/brain-intelligence-recovery-s0dl4l`; part 2 released in PR #901 / Deploy 1070; part 3 in PR #905, merge 0fd9e61, Deploy 1074)

| stream | commit | what changed | evidence |
|---|---|---|---|
| hermes-director | 0916bd8 (in PR #897, merged e37e0ff) | mission (`SURGE:B`), `brain_operator_inventory`, `brain_operator_reattempt`, outside verification, 48 GB recipe | operatorRepairs + runpodRestore tests; Deploy 1066 SQLite suite green |
| search-selection | 695077a | quantitative screen + reserved diverse slots replace hash-order pick; unknowns ranked at low end; INCLUDE move; learning on challenged score, role-keyed; transfers list unbridged dimensions | `tests/arrangementSelection.test.ts` 12/12; experiment reach 1.80% → 3.50%, strong arrangement kept for every key |
| E-1 / I-1 | this branch | `paymentSchedule` reads deposit/milestone terms into cash timing; plausibility critic reads kept cash | `tests/surgeBPaymentTerms.test.ts` 3/3; eval cases E and I pass |

Independent evaluation after these: **13 → 14 of 18 cases pass** (E, I, SEL newly
pass; remaining: G2 transfer differences, L contradiction, O interval/certify,
PERSIST — owned by in-flight streams).

| acceptance | 367b2f5 | one evidence representation for links and assurance; certification = 5th percentile of reach under parameter draws ≥ 90%; TRANSFERRED conversion; own outreach record HISTORICAL; sized `readRate`; contested sources (L-1); verdict classes QUANTITATIVELY_CONSTRUCTED / CONFIDENCE_VERIFIED / IMPROVEMENT_REQUIRED / NOT_SUPPORTED | `tests/planningConfidence.test.ts` 17/17; 10 acceptance/selection/economics files 106/106 |
| world-expansion | 6862da0 | kernel runs under a standing research grant with no sprint (sprint wind-down stops only sprint rounds; revoking the grant stops standing rounds); scored selection (information + relevance + transfer + novelty) with a 1-in-4 exploration pick; root question re-asked after 90 d, breakdowns after 60 d; barren → WATCH with reopen conditions | `tests/industryKernelStanding.test.ts` 15/15; kernel 41/41; migrations + deploymentOwnership pass |
| integration | this branch | `estimateInput` (one estimate→input conversion); Brain's measured close rate carries its counts | eval case O passes |

**Independent evaluation now: 18 of 18 (baseline 11), on the integrated branch
at 5e8ba32.** G2 closed by construction: a TRANSFER arrangement carries
`differences` (legal context, payment terms, sales cycle, capital, buyer
behaviour — `TRANSFER_MATERIAL`, now owned by `construct.ts`) and its research
question asks for a source on each. PERSIST closed by the arrangement library
(69 rows, 36 constructed keys found by key after caches cleared). Decision recorded: three sized comparables *can* certify at 90% when
the margin is large (5th-percentile reach 98.75% at 2,100 contacts for 7 deals);
unsized, single-source, assumed and contested evidence never certifies, and more
simulated worlds never raise confidence.

### Hermes as director — production record

| when (Z) | run | model | what Hermes did | source |
|---|---|---|---|---|
| 21:12–21:28 | `opr_322701cdf14f411e9b6b` (Agents run 43641617727, mission `SURGE:B` set, 3,048 chars) | `auto/best-coding` (free switchboard) | RUN_DONE, 41 tool calls, 0 failed: 19 × `brain_operator_inventory` (populated the Surge B inventory from the mission), `brain_operator_decide` (opd_0943d48c45d6ea1d), `continue_idle`, `record_learning`; commissioned **no** duplicate engineering (every root cause was already REPAIRING by a stream) | `agents.yml operator-show` run 43643347745 |
| 23:59–00:04 | opr_a1f757372a4d439b8564 (Agents run 43654508964) | auto/best-coding | mission refreshed (SURGE:B, part-2 release state); 29 tool calls: 13 inventory reads/upserts, 3 `brain_operator_decide` (incl. RESUME_GOAL deciding to re-attempt stalled commission imp_02321af4d6e9433782cd on a different path), goal plan read, record_learning. One inventory call failed `POOL_CHECKOUT_TIMEOUT` (Surge A runtime). | agents.yml operator-run log |
| 01:12 | opr_f08f44610451473b8ee4 | auto/best-coding | RUN_FAILED: database pool 8/8 in use, 7 waiting (Surge A runtime) | operator-show 02:59Z |
| 01:59–02:01 | opr_7842591db1544e3f9cc8 (self-scheduled) | auto/best-coding | 22 tool calls; engineering read, record_learning, allocation | operator-show |
| 02:33–02:51 | opr_198160824b9a460a9966 (self-scheduled; my dispatch at 02:33 was refused "an operator run is already in progress") | auto/best-coding | 23 tool calls: goal plan read ×2, inventory, verify, history, 3× `brain_operator_decide`, continue_idle, **2× `brain_operator_commission`**, **`brain_operator_reattempt`**, `brain_operator_submit_fix`, record_learning, engineering ×3 — directing without a Claude prompt | operator-show (Agents run 43670283980) |

Limits observed honestly: the run's own decision and lessons still centre on
the $10K goal and infrastructure congestion (Surge A's area); it tracked the
Surge B inventory but did not yet reprioritise or re-attempt Surge B work —
nothing in flight had stalled. The post-run `show` crashed on `LIMIT NaN`
(argument parsing in `scripts/operator.ts`, fixed e45cb30).

### Production after Deploy 1070 (census Goals run 43654436460, 23:42Z, revision 7a8b565)

| population | baseline 19:53Z | 23:42Z | reading |
|---|---|---|---|
| constructed arrangements durably stored | 0 | **404** (404 unique design signatures) | K-1 persistence VERIFIED on production |
| sourced economic observations | 16,762 | 16,786 | +24 |
| plan readings | 100 | 101 | — |
| construction facts | 0 | 0 | W-5/6/7 released; facts are written by the kernel pass on its next standing round — NOT YET VERIFIED |
| arrangements researched / evaluated / picked / transferred | n/a | 0 / 0 / 0 / 0 | counters exist; no plan read or round has run since release — NOT YET VERIFIED |
| sectors / nodes / buyer populations | 52 / 91 / 11 | 52 / 91 / 11 | no standing round has run since release |
| commercial positions, labor roles | not stored | not stored | K-6 repair in flight |

### Production plan read after Deploy 1070 (Goals run 43654511789, 23:43→00:08Z)

Total ≈ 25 min (baseline 26 min 41 s): construct 247 s, shared frontier (979 openings) 210 s, quant portfolio 189 s, scenario 34 s, reconstruction 346 s.
**Critical finding P-ADMIT (REPAIRED on branch 09a1c27: unpriced arrangements enter on comparable published prices at MECHANISM tier, never certifiable; with no price anywhere they stay out with a reason; surgeBArrangementAdmission passes):** `estimated arrangements: 0 of 404 (404 cut, 0 in reserve)` — every stored arrangement is cut before the goal model on production; the plan compares 11 found openings + 0 constructed estimates and reaches 0.0% (pool reaches at most $265 of $10,000). Owner: Surge B (admission engineer, REPAIRING).
**P-SPEED-2:** the planning read is still ~25 min on production. REPAIRED on branch (df6ef39 + tie-break): on a production-shape fixture (979 openings, 404 of 2,474 arrangements) the read went 565 s → ~160 s on 2 contended cores and 25 s → 18.7 s on free cores; a warm re-read is 0.44 s. Changes: construction runs ≤24 compositions inline (no idle pool wait); the plan reads frontier tiers only (67 queries / 6.6 MB → 2); baseline portfolio held by input digest; drawn world order and quantiles cached per sample; exactly tied strategies break on key so re-reads are identical.
**Handed to Surge A (runtime, measured):** (1) evaluator pool threads run at nice 19 (`evaluatorWorker.ts:13`) and on a 2-vCPU host each job waits its 60–120 s timeout before running inline — construction 127 s and quant 63 s under contention vs 0.4 s and 1.6 s free; (2) production's 210 s frontier was ~2,700 serial queries at ~76 ms from `readStandingRows` → `whyNotDiving` (`validation.ts:388`) — the plan no longer calls it, cash views still do; (3) one plan read calls `listOpportunities` 8× (1.5 MB each) and `cardFactsForProject` 5×.

### Production after Deploy 1075 (parts 3+4; census Goals run 43667549093, 02:25Z)

| population | 23:42Z | 02:25Z | reading |
|---|---|---|---|
| stored arrangements quantitatively evaluated in a goal model | 0 | **12** | P-ADMIT VERIFIED on production |
| stored arrangements picked by a best combination | 0 | **1** | constructed knowledge now reaches the plan |
| commercial positions (distinct §92 position_key) | not stored | **14** | K-6 VERIFIED on production |
| constructed money flows (payer population × position) | not stored | **247** | K-6 |
| arrangements carrying a position | — | 404 | |
| sourced observations | 16,786 | 16,817 | +31 |
| construction facts | 0 | 0 | F2/F3 back-fill repaired on branch, awaiting release |
| arrangements researched / transferred | 0 / 0 | 0 / 0 | F1 and F7 repaired on branch, awaiting release |

**Production plan read after Deploy 1075 (Goals run 43667546686, 02:23Z):** total **71 s** (baseline 26 min 41 s; 25 min after part 2): construct 6.1 s (was 247 s), shared frontier 0.25 s (was 210 s), quant portfolio 7.0 s (was 189 s), scenario 1.0 s, reconstruction 55 s (was 346 s). Planning speed VERIFIED on production inside the 1–5 min target. `estimated arrangements: 12 of 404 (392 cut, 6 in reserve)`; `compared 11 found + 12 constructed estimates; 1 in the best combination`. The F4 defect is visible: best-combination p90 $101M and reconstruction p50 $30M from uniform pooled prices; acceptance stays CANDIDATE_ONLY (correctly not certified). F4 repair ships in part 5.

### Production after Deploy 1079 (part 5 live; census Goals run 43674356399, plan read 43674354479, 03:53Z)

| check | before part 5 | after part 5 (03:53Z; 04:17Z) | reading |
|---|---|---|---|
| best-combination p90 settled cash | $101,384,753 | **$15,000** | F4 VERIFIED: inflated pooled prices gone |
| reconstruction best | 44.6% coverage, p50 $30M | 23.1% coverage, p50 $0, p90 $15,000 | honest; CANDIDATE_ONLY |
| cross-industry TRANSFER arrangements | 0 | **377** | F1/W-8 VERIFIED on production |
| variable sweep | "abandoned: no evaluation thread" | 46,070 variations read, 7 strategies to the engine; 11 stances | F9.1 VERIFIED resolved (P-10 dedicated vCPUs) |
| constructed estimates admitted | 12 (on pooled prices) | 0: "no comparable price: published prices for other buyers span …" ×40 | correct refusal; the gap is price evidence per buyer population, which F2/F3 back-fill and F7 rounds must supply |
| construction facts / arrangements researched | 0 / 0 | 0 / 0 (20 min after release) | F2/F3/F7 NOT YET VERIFIED: watch the standing pass |
| model lane | 16/16 off-shape | 0 proposed; 2× "not JSON", 2× timeout | F9.2 NOT FIXED → F9.2b (engineer assigned) |
| plan read time | 71 s | 64 s | |
| stored arrangements (04:17Z) | 404 | 639 (377 transfers), 14 positions, 249 flows | F5 evidence-only openings feed construction — VERIFIED |
| construction facts / arrangements researched (04:17Z, 40 min after release) | 0 / 0 | 0 / 0 | NOT VERIFIED — production diagnostic being added to the census (part 6) |

### Production DIAG after part 6 (census Goals run 43680544935, 05:19Z)

Cash Mode is ACTIVE and the kernel back-fills: `kernelSkips no`, authority SPRINT, 5 kernel SCAN rounds open. The back-fill read 118 candidates and found 0: **102 rejected "opening payer matches no mapped buyer type"** and 16 "opening names no payer". The unmatched payers are research prose ("GitHub, Inc. is the payer: …", "Market: City of St. Louis, MO. The payer/buyer is …").
- Root cause **P-FACTS:** the map's 11 buyer types never meet the payers of priced openings.
- Repair (part 7, PR #916): priced payers become DISCOVERED buyer nodes; the payer is read out of the prose (`payerNamedIn`).

Arrangement research is allowed (SPRINT), yet 0 constructed rounds opened in 24 h. The gate is now reported by DIAG `constructedGate` (part 7); finding **P-ROUNDS**, under investigation.

### Surge A closed (02:45Z; its closeout in docs/PLANNING-RECOVERY-2026-11-14.md)

Its handoffs return to Surge B, which now owns them:
- **F9.1** (variable sweep abandoned, "no evaluation thread is running"). Likely resolved by P-10: Deploy 1075 moved Brain to dedicated vCPUs, and the engine ran in 1.05 s instead of 37.8 s. To verify on the first plan read after Deploy 1079 by the absence of the "sweep abandoned" line.
- **Evaluator threads at nice 19:** moot on dedicated vCPUs unless the plan read shows otherwise.
- **`whyNotDiving` serial queries and repeated `listOpportunities`:** noncritical; the plan no longer calls `whyNotDiving`.

Release discipline (P-12): a merge supersedes a Deploy in flight, and the gate takes about 45 min. Surge B releases in batches no closer than one per completed Deploy.
External: the RunPod balance needs a top-up before about 11-20 (owner; it does not block this operation).

### Adversarial pass: capabilities that pass on fixtures but are inert on production (01:49Z, `docs/intelligence-recovery/adversarial-production-gaps.md`)

New failure categories the inventory did not cover: gates on a fact kind production never writes; a writer whose only reader is off the failing path; uniform sampling over pooled prices spanning orders of magnitude; capabilities that only run on worker threads; model output refused for shape.

| id | finding | severity | owner | status |
|---|---|---|---|---|
| F1 | TRANSFER precedent requires a `captureMechanism` EVIDENCE fact production never writes (only RECOMMENDATION) — W-8/G2 pass only on fixtures | CRITICAL | transfer-facts engineer | VERIFIED on production: 377 TRANSFER arrangements (census 03:55Z) |
| F2 | construction facts are read only by goalConstruction; arrangement value and the goal model never read them | CRITICAL | transfer-facts engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (a988208) |
| F3 | facts rarely written: no UNIT_ECONOMIC question, exact buyer-name match, 16.8K claims never back-filed | MAJOR | transfer-facts engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (a988208): back-fill ≤20/pass from held claims, normalised buyer matching, unit-economics questions |
| F4 | P-ADMIT fallback pools every project price ($15–$325K) sampled uniformly: unpriced arrangements inflate reach (cannot certify) | CRITICAL (regression in parts 3+4) | admission engineer | VERIFIED on production: best p90 $101M → $15,000 (plan 03:53Z) |
| F5 | 282 of 418 live openings (no payer) feed no construction/transfer | MAJOR | discovery engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (7c7b22f) |
| F6 | capital tied up inferred across mechanisms treated as established; 3 of 11 openings hard-refused | MAJOR | admission engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (b86f2ed): only own evidence refuses; pooled inference swept UNKNOWN |
| F7 | arrangement research rounds and library counters still gated on Cash Mode ACTIVE | MAJOR (CRITICAL when the sprint winds down) | discovery engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (7c7b22f): arrangement rounds open under the standing grant |
| F8 | stuck-plan detector needs identical shortfall text; unreported-round detector ignores kernel rounds | MAJOR | discovery engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (7c7b22f) |
| F9.1 | variable sweep (§102) abandoned on production: "no evaluation thread is running" (`evaluatorPool.ts:173,198`) | CRITICAL | Surge B (returned when Surge A closed) | VERIFIED resolved on production: sweep read 46,070 variations (plan 03:53Z) |
| F9.2 | 16/16 model-proposed methods refused as off-shape; 2/4 calls HTTP 429 | MAJOR | discovery engineer | RELEASED in PR #909 (part 5; deploying in 1079, 1078 superseded) — repaired (7c7b22f): empty design = no design; tolerant parse; refusal reasons recorded; 429 retried once |
### Received from Surge A (22:09Z scope adjustment)

| id | finding | status |
|---|---|---|
| A-O6 | research rounds end without a report (`research/gate.ts`, `packetRunner.ts`) — verifier on all-conditional lanes vs unreachable sources | RELEASED in Deploy 1075 (parts 3+4) — repaired (540ea63): verifier lane names resolved to declared ids; an all-conditional fragment is not failed by INSUFFICIENT, which is carried as an unresolved gap. Unreachable-source blocks stay with RC-1 (Surge A). evidenceLanes 24/24 |
| A-10K | the $10K plan has no buyer-validated or market-test-ready opening, and conversion is unmeasured | ROOT CAUSE CONFIRMED — evidence gap, not a code defect: it closes only by measurement (outreach replies through Instantly, §94) or sourced comparables; acceptance now certifies on sized comparables with margin (case O), never on assumption. Directed to Hermes. |
| A-CAP | starting-capital fallback chain `perWeek ?? beforeProof ?? capitalCeiling` (`goals/portfolio.ts` ~905) | REVIEWED — NOT A DEFECT: every link is a limit the goal itself states; with no weekly or before-proof limit the ceiling is the most that may be tied up, and the reconstruction's CAPITAL factor sweeps it. No owner figure is hard-coded. |

### Handed to Surge A

- `tests/goalPlan.test.ts` "reads a large project in a bounded number of
  statements": 153 reads against a bound of 140 **on unmodified
  `origin/production` (aefd41f) locally**, identical with Surge B's changes, so
  not caused here. It is Surge A's P-9 (statement budget). Deploy 1066's CI
  shards passed it, so the count is environment-sensitive.
- Local test timeouts (~30 s) under memory pressure from concurrent engineers:
  `goalPlan.test.ts`/`openingsFromClaims.test.ts` pass 71/72 single-worker.

### Measurement

`scripts/knowledge-census.ts` counts every population the owner listed from the
rows, prints UNMEASURED with the reason when a table does not exist, and
NOT_STORED with where a computed population lives. Production:
`Goals` workflow, command `census` (read-only, no administrator needed).
