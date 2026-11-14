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

(Filled as lenses report.)
