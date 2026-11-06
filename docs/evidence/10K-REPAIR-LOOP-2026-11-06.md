# The repair-to-$10K loop, connected and running (2026-11-06)

Owner's order, 2026-11-06 08:16Z: connect Brain's repair, testing, scheduling,
Factory and goal systems into one permanent automatic process — a released
repair triggers the `GOAL_PLAN_MAP` check, a failed check becomes Factory
work, a passing check resumes the $10K goal — with no session open and no
owner message. Goal `wst_7b4fcbb5f2384f31b6c3`. Every figure below is
production's, from the run named beside it.

## What was not connected (Admin 42186638991, 08:18Z, `91944e2`)

- GOAL_PLAN map: 9 WORKING, 4 BROKEN. The improvement register held **no**
  GOAL_PLAN candidate: every connected gap sat behind `COMPUTE.DATABASE`,
  which had no improvement route, and a gap behind another is never routed.
- `COMPUTE.DATABASE` read 69% over 24 h while the build then serving had not
  failed once; the window was mostly the night's outage on earlier builds.
- A cleared gap reached nothing: the goal tick did not hear of it.

## What was released

| PR | change |
|---|---|
| #567 | `COMPUTE.DATABASE` routed (callers Factory may release); a gap waits only behind an upstream gap that is in hand; `assessMap({ since })` judges the running release on its own sample; `cleared` gaps call `requestGoalPlanPass` → `GOAL_RESUMED_AFTER_REPAIR` |
| #568 | `goals plan` prints the loop's rows; `scripts/verify-repair-loop.mjs` |
| #569 | the first check on each release is a row |
| #571 | packet-ceiling race on Postgres (`pg_advisory_xact_lock` per grant and kind); goalPlan test timing |
| #572 | verifier: a release's check is one after the machine was replaced |

Deploy 42196314183 released `3a0cb4d` (machine replaced 10:00–10:07Z), after
Postgres suite 42196268325 passed on it.

## The loop on production, with nobody involved

Goals `plan` 42205696082 (`3a0cb4d`) and 42235653325 (`b5a807f`, released by
another session's Deploy 42221172426 at 13:09Z while this session was down):

| check (CAPABILITY_ASSESSED) | cleared | goal resumed (GOAL_RESUMED_AFTER_REPAIR) |
|---|---|---|
| 10:35Z, first on `3a0cb4d` | COMPUTE.DATABASE, RECOVERY.PROVIDERS | 10:46Z, plan read at once |
| 11:44Z, hourly | DECISION.JOB_OUTCOME, EVIDENCE.PACKETS_COMPLETE, OPENINGS.SEARCH_WIDENS, VERIFICATION.REASONS | 11:50Z |
| 13:46Z, first on `b5a807f` | DISCOVERY.SEARCH, RECOVERY.IDLE_CAPACITY, RECOVERY.STALLS | 14:09Z |

Still blocking at 13:46Z: EVIDENCE.BUYER_PRICE, LEARNING.DELIVER,
OPENINGS.ROUNDS_FILE, OPENINGS.SEARCH_WIDENS, RECOVERY.RETRY,
VERIFICATION.GATE, VERIFICATION.REASONS. Repair work in Factory (Admin
42235657395): `CAPABILITY:RESEARCH.RECOVERY.RETRY` (fcp_86c90fcc…) and
`CAPABILITY:RESEARCH.RECOVERY.STALLS` (fcp_0d6ad09f…).

## The goal (Goals `plan` 42188095510, 08:30Z)

- Target 10 000 USD settled in 21 days; spending at most USD 375 before
  income, USD 750 newly tied up a week, USD 3 000 in all — the owner's limits.
- NOT_VIABLE: the 17 openings held reach at most 250 USD at prices buyers are
  shown to pay; the best combination reaches the target in 0.0% of swept
  worlds (coverage, not a probability); no chance is stated (too few finished
  plans to measure one).
- 404 constructed arrangements, 165 search rounds, 31 unknowns reconstructed
  from evidence; RunPod Qwen3-4B and the free models answering.
- 149 live openings left out by the goal's own exclusions (government
  contracts, domain speculation, website repair).
- Prepared market test: `cop_665f0a84…` (Artisanal Sudoku, up to 50 USD),
  blocked on `CONTACT_BUYER` — an owner approval, kept; planning and research
  continue without it.

## Research reaches the plan (Admin `capabilities show` 42237190810, `4a4d868`)

GOAL_PLAN map, 24 h: `EVIDENCE.PATH_ANSWERS`, `QUANT.MODELLED`,
`PLAN.READS_NEW_EVIDENCE` (a plan run after each new opening) and
`GOAL.PLAN_EVALUATED` WORKING; `RECOVERY.LEASES`, `COMPUTE.GPU`,
`COMPUTE.FREE_MODELS` and `GOAL.PLAN_FRESH` WORKING. An earlier reading the
same day (42204583769, ~10:40Z) had `PLAN.READS_NEW_EVIDENCE` UNPROVEN —
below its sample, not failing — while no new opening arrived in the window.
