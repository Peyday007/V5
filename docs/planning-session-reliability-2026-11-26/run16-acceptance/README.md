# Run 16: fresh acceptance on the frozen release f458f03 (2026-11-28)

The build was frozen at f458f03, which carries Run 15's repairs:
- a listed price reads as a price;
- `nonPurchase` on NOT_A_PURCHASE;
- `dealsMax`, and the strategy's members carry the target together;
- `accountFor`.

The hosts ran from a worktree pinned to that SHA.

An independent agent wrote the hidden cases in `cases/`: 12 established-opportunity cases (`ax-*`) and 4 raw-objective discovery cases (`ay-*`), in industries no earlier run used. Authors and two fleet reviewers took work from Brain's queue, and no author was prompted per case. `changer.sh` applied the mid-run changes to a07, a10 and a12 (`changer.log`).

**Grading:**
- **Bench:** the canonical grader read each published final revision. The changed cases were graded at `--step 1`.
- **Discovery:** an independent grader agent graded the published plans against `cases/discovery.json` and COMPLETION-SPEC §2–§3 (`grades/discovery-grades.json`).

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 12 / 12 | 1.00 | 0.76–1.00 | 0 | 12 / 12 | 12 / 12 |
| raw-objective discovery | 3 / 4 | 0.75 | 0.30–0.95 | 0 | (graded by rubric) | 3 / 4 published |
| **all** | **15 / 16** | **0.9375** | **0.72–0.99** | **0** | | |

Every bench case was published after an independent fleet review (`reviewer` in `grades/summary.txt`). ax-06 was revised once after a REVISE. The changed cases a07, a10 and a12 were re-reviewed after their change.

Stated in the spec's form: 15/16 = 0.9375 (Wilson 95% 0.72–0.99), on f458f03.

The standard (accuracy ≥ 0.90 with zero critical failures) is **met**.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| ay-04 (d04) "keep $3,500 after all direct costs within 21 days", $300 cap | none | no result (counted as run and failed, §4) | no | Brain input defect | Brain's objective reader stored no target: "keep … after … costs" matched neither a contribution metric nor a target verb, so the goal read as OTHER with no amount and could not be planned. |

## Grader notes on passing cases (not failures)

- **d01:** treats "3 business days" as 3 calendar days for the last orders.
- **d02:** the $20 per-store direct cost has no source.
- **d03:** its rationale mentions gate-rejected figures, which are not counted as established. It also depends on a messaging capability that is not connected.

## Repair, at its owner (after the frozen build; the measured result above is unchanged)

- **Objective reader** (`server/services/industry/construction/intent.ts`, PR #1372):
  - "keep / pocket / walk away with … after … costs / expenses" is a contribution target, and "keep" is a target verb.
  - Money kept aside or in reserve is still not the target.
  - Regression: `tests/run16Regressions.test.ts`, on the real d04 objective, with controls.
