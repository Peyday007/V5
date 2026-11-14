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
| IB-1 | **Knowledge grows only inside a cash sprint.** The industry kernel runs only under an ACTIVE Cash Mode, selects by fixed-order rules, asks each question once, and declares a subject permanently barren | W-1, W-2, W-3, W-4 | world-expansion | REPAIRING |
| IB-2 | **Economic facts are hand-entered, undated and logistics-shaped.** Construction facts come only from a person per goal, carry no date, resolve by status alone; positions are a closed logistics vocabulary; flows name no payer/supplier | W-5, W-6, W-7, W-10, W-13, W-9 | construction-knowledge | REPAIRING (W-9 DISCOVERED) |
| IB-3 | **Hermes cannot be given a mission or directly track/reattempt work.** Fixed $10K brief; no inventory, re-attempt or outside-verification tool; RunPod ceilings forbid a 48 GB director pod | H2-1, H2-2, H2-3, H2-5, H2-7, H2-9, H2-11 | hermes-director | REPAIRING |
| IB-4 | **Evidence lifecycle is thin.** Claims lack method, sample size, transaction type, limitations, validity window, invalidation; staleness windows are constants that cut off rather than widen | W-11, W-12 | (after IB-2) | ROOT CAUSE CONFIRMED |
| IB-6 | **Nothing Brain constructs is kept.** Arrangements live in process memory (10-min / 30-min caches), lost every restart; the only trace is a hash in a round's bucket id; research answers never attach back; no reuse across goals or projects | K-1…K-8 | arrangement-library | REPAIRING |
| IB-7 | **Selection is arbitrary where it matters most.** 400 cap cuts by enumeration order; 12 enter the model by a saturating score with a sha256-id tiebreak; unknowns ranked at their midpoint; learning rewards unchallenged reach and is keyed to one goal | S-1…S-12, S-14…S-17 | search-selection | REPAIRING |
| IB-8 | **The acceptance gates are mutually exclusive.** Chain links accept conversion only from Brain's own sales and fixed values; assurance counts *studies* (≥20) and puts a Wilson bound over them. Every input passes one gate only in the form the other refuses, so only TARGET_MET (cash already collected) can be ACCEPTED | Q2-1…Q2-12, S-13 | acceptance | REPAIRING |
| IB-5 | **Two construction vocabularies** (§82 designs vs §92 positions); transfer runs only under a goal | W-8 | (after IB-2, IB-6) | ROOT CAUSE CONFIRMED |

### Findings

| id | capability | symptom | sev | owner | status |
|---|---|---|---|---|---|
| W-1 | world expansion | kernel needs an ACTIVE sprint; questions worded as sprint work (`industry/kernel.ts:70,96`) | BLOCKING | world-expansion | REPAIRING |
| W-2 | adaptive selection | six fixed-order rules, oldest-first, constant concurrency 4 (`allocate.ts:16-23,97,369`) | MAJOR | world-expansion | REPAIRING |
| W-3 | expansion | root question and each breakdown asked once; repeat branch unreachable (`allocate.ts:152,260,313`) | MAJOR | world-expansion | REPAIRING |
| W-4 | exploration | barren after 3 scans is permanent (`verdict.ts:123-136`) | MAJOR | world-expansion | REPAIRING |
| W-5 | quantitative knowledge | construction facts written only by a person, per goal; map-built roles unpriced (`construction/service.ts:57-96`) | BLOCKING | construction-knowledge | REPAIRING |
| W-6 | decomposition | role-occupant answer asked once, never read back (`expand.ts:196,214`) | MAJOR | construction-knowledge | REPAIRING |
| W-7 | money-tree positions | closed logistics-shaped position vocabulary; 4 economics branches; no resale/subscription/finance/rent (`domain/construction.ts:31-224`) | MAJOR | construction-knowledge | REPAIRING |
| W-8 | transfer | two construction vocabularies; transfer goal-only | MAJOR | — | ROOT CAUSE CONFIRMED |
| W-9 | generality | one Metro Detroit last-mile reference pack applied to any "logistics" subject | MINOR | — | DISCOVERED |
| W-10 | freshness | construction facts undated; old OBSERVED beats new VERIFIED | MAJOR | construction-knowledge | REPAIRING |
| W-11 | evidence lifecycle | claims lack method, sample size, transaction type, limitations, validity, invalidation | MAJOR | — | ROOT CAUSE CONFIRMED |
| W-12 | freshness | constant staleness windows cut evidence off rather than widen uncertainty; map nodes undated | MAJOR | — | ROOT CAUSE CONFIRMED |
| W-13 | who pays | map flows point at "operators", no payer/supplier resolved (`service.ts:74-76`) | MAJOR | construction-knowledge | REPAIRING |
| H2-1 | Hermes direction | no way to give a run a mission (`domain/operator.ts:148`) | BLOCKING | hermes-director | REPAIRING |
| H2-2 | Hermes direction | no inventory tool | MAJOR | hermes-director | REPAIRING |
| H2-3 | Hermes diagnosis | deficiencies from three hard-coded detectors (`director.ts:883`) | MAJOR | — | DISCOVERED |
| H2-4 | Hermes honesty | lesson-only interventions reported as queued (= Surge A H-4, merged, unverified) | MAJOR | Surge A | AWAITING VERIFICATION |
| H2-5 | Hermes direction | no reassign/re-attempt of stalled Factory work | MAJOR | hermes-director | REPAIRING |
| H2-6 | Hermes research | research only via a commission | MINOR | — | DISCOVERED |
| H2-7 | Hermes verification | cannot verify a repair it did not commission | MINOR | hermes-director | REPAIRING |
| H2-8 | runtime | operator reads >20 s; DB contention | MAJOR | **Surge A** (RC-1) | handed off |
| H2-9 | compute | RunPod ceilings block any 48 GB pod; no 48 GB recipe | MAJOR | hermes-director | REPAIRING |
| H2-10 | verification | no operator proof since recovery merges | MAJOR | this operation, after release | DISCOVERED |
| H2-11 | generality | brief is $10K-specific | MINOR | hermes-director | REPAIRING |
| K-1 | persistent knowledge | constructed arrangements never persisted (`construct.ts:206`, `plan.ts:2909`) | BLOCKING | arrangement-library | REPAIRING |
| K-2 | search breadth | 400 cap cuts by enumeration order, unreported (`construct.ts:138,391`) | MAJOR | arrangement-library | REPAIRING |
| K-3 | traceability | which 12 reach a model is not recorded; `arr_` ids may be linked as openings (`plan.ts:2489`) | MAJOR | arrangement-library | REPAIRING |
| K-4 | learning | research answers never attach to the arrangement; refuted ones re-asked | MAJOR | arrangement-library | REPAIRING |
| K-5 | reuse | rounds per goal, keys are project-local hashes; no cross-goal/project reuse | MAJOR | arrangement-library | REPAIRING |
| K-6 | persistent knowledge | §92 positions, roles, flows not stored | MAJOR | — | ROOT CAUSE CONFIRMED |
| K-7 | identity | keys from row ids; recreated node loses history | MINOR | arrangement-library | REPAIRING |
| K-8 | geography | arrangements carry no geography; constraints never read | MINOR | arrangement-library | REPAIRING |
| S-1 | search narrowing | 12 picked by saturating score + sha256 tiebreak; experiment: strong DIRECT arrangement kept/dropped by its key string; swapping it in raised reach 1.55%→2.8% (`goalScenario.ts:283-297`) | BLOCKING | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-2 | diversity | one arbitrary design per buyer population | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-3 | breadth | = K-2 | MAJOR | arrangement-library | REPAIRING |
| S-4 | research routing | only the 12 get contribution; rest −1 → research self-reinforces the hash pick | MAJOR | (fixed by S-1) | REPAIRED via S-1, AWAITING VERIFICATION |
| S-5 | invariant 39 | unknown ranges ranked at midpoint (2–50% beats evidenced 5–25%) | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-6 | reasoning | no move can add a constructed arrangement outside the 12 | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-7 | method learning | learns from unchallenged and critic-flagged reach | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-8 | transfer of methods | learned methods keyed by opening ids; don't transfer across goals | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-9 | learning stats | repeat reads of one goal counted as independent | MINOR | — | DISCOVERED |
| S-10 | learning | stance yield computed, never fed back | MAJOR | search-selection | DISCOVERED (not repaired; stance yield still unused) |
| S-11 | invention | model-invented methods only retune 4 operations on held openings | MAJOR | search-selection | PARTIAL (INCLUDE move added; new-design invention not yet) |
| S-12 | transfer | transfers model no material differences; precedent bonus outranks gated evidence | MAJOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| S-13 | correlation | = Q2-10 | MAJOR | acceptance | REPAIRING |
| S-15 | wiring | `bestReachCents` never reaches construction (10-min cache) | MINOR | arrangement-library | REPAIRING |
| S-16 | screening | factorial screen drops levels that matter only in combination | MINOR | — | DISCOVERED |
| S-17 | traceability | nothing records what was cut | MINOR | search-selection | REPAIRED, AWAITING VERIFICATION (695077a) |
| Q2-1 | acceptance | chain link and assurance accept mutually exclusive input forms → EVIDENCED_PORTFOLIO unreachable (repro: 3 sized comparables → basis PROBABILITY, still CANDIDATE_ONLY) | BLOCKING | acceptance | REPAIRING |
| Q2-2 | statistics | "sample" = number of studies ≥ 20; Wilson bound double-counts (`quant/portfolio.ts:1027,1061`) | BLOCKING | acceptance | REPAIRING |
| Q2-3 | conversion | CONVERSION only from Brain's own sales (`plan.ts:549`) | MAJOR | acceptance | REPAIRING |
| Q2-4 | evidence | Brain's own outreach record relabelled UNKNOWN (`portfolio.ts:440`) | MAJOR | acceptance | REPAIRING |
| Q2-5 | evidence parsing | `readRate` never reads N; unsized ranges counted as ~57 trials | MAJOR | acceptance | REPAIRING |
| Q2-6 | improvement loop | below threshold → empty or generic research needs; next test blocked on contact permission → loop | MAJOR | acceptance | REPAIRING |
| Q2-7 | cash timing | inferred days-to-cash can only refuse, never establish | MAJOR | acceptance | REPAIRING |
| Q2-8 | verdicts | CONSTRUCTED vs IMPROVEMENT_REQUIRED collapse to CANDIDATE_ONLY; Hermes challenge only after ACCEPTED (never fires) | MAJOR | acceptance | REPAIRING |
| Q2-9 | calibration | MEASURED_RECORD deadlocked on RECOMMENDABLE readings | MAJOR | acceptance | REPAIRING |
| Q2-10 | correlation | shared-comparable rates drawn independently → invented diversification | MAJOR | acceptance | REPAIRING |
| Q2-11 | statistics | no small-k predictive interval, no vendor-figure bias discount, funnel stage not material, lineage only by URL, no model uncertainty | MAJOR | acceptance | REPAIRING (partial) |
| E-1 | cash timing | a signed $20K contract paying a deposit + milestone ($14K) inside the window counts $0 toward the goal (independent evaluation case E) | MAJOR | follow-up (portfolio cash timing) | REPAIRED, AWAITING VERIFICATION (paymentSchedule; eval case E passes) |
| L-1 | evidence interpretation | contradictory sources ($8K vs $45K for one quantity) pooled silently into a DIRECT-tier confident distribution; no contradiction surfaced (case L) | MAJOR | acceptance | REPAIRING |
| I-1 | capital restructuring | under a capital ceiling a presale design (reach 0.863) was refused as IMPLAUSIBLE: the plausibility critic compared gross settled cash ($50.6K, ~34×) to capital, though most passes back to the supplier; kept cash is ~12× (`reconstruction.ts:285`) | MAJOR | follow-up | REPAIRED, AWAITING VERIFICATION (critic reads kept cash; eval case I passes) |
| Q2-12 | robustness | assurance sample regex-parses prose (`plan.ts:852`) | MINOR | acceptance | REPAIRING |

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

### Repairs integrated (branch `claude/brain-intelligence-recovery-s0dl4l`)

| stream | commit | what changed | evidence |
|---|---|---|---|
| hermes-director | 0916bd8 (in PR #897, merged e37e0ff) | mission (`SURGE:B`), `brain_operator_inventory`, `brain_operator_reattempt`, outside verification, 48 GB recipe | operatorRepairs + runpodRestore tests; Deploy 1066 SQLite suite green |
| search-selection | 695077a | quantitative screen + reserved diverse slots replace hash-order pick; unknowns ranked at low end; INCLUDE move; learning on challenged score, role-keyed; transfers list unbridged dimensions | `tests/arrangementSelection.test.ts` 12/12; experiment reach 1.80% → 3.50%, strong arrangement kept for every key |
| E-1 / I-1 | this branch | `paymentSchedule` reads deposit/milestone terms into cash timing; plausibility critic reads kept cash | `tests/surgeBPaymentTerms.test.ts` 3/3; eval cases E and I pass |

Independent evaluation after these: **13 → 14 of 18 cases pass** (E, I, SEL newly
pass; remaining: G2 transfer differences, L contradiction, O interval/certify,
PERSIST — owned by in-flight streams).

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
