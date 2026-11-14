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

### Measurement

`scripts/knowledge-census.ts` counts every population the owner listed from the
rows, prints UNMEASURED with the reason when a table does not exist, and
NOT_STORED with where a computed population lives. Production:
`Goals` workflow, command `census` (read-only, no administrator needed).
