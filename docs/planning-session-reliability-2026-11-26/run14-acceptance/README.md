# Run 14: fresh acceptance on the frozen release 5519919 (2026-11-28)

The build was frozen at the merge of PR #1364. It carries Run 13's repairs:
- rejected evidence is never EVIDENCED;
- owner hours are given per opening under a limit;
- verdicts must name current claims;
- the goal's own routes are weighed before the planner's cut;
- a read never predates the session's work.

The hosts ran from a worktree pinned to that SHA. An independent agent wrote the hidden cases in `cases/`: 12 established-opportunity cases (`at-*`) and 4 raw-objective discovery cases (`au-*`).

Five authors and two fleet reviewers took work from Brain's queue, and no author was prompted. A container restart stopped the run partway through. No world had yet changed or been published, and every recorded review and revision survived. The world hosts restarted against their databases, and each agent resumed from its own transcript.

`changer.sh` applied two mid-run changes:
- **a04:** the objective changed;
- **a12:** capital was raised (04:53:03).

**Grading:**
- **Bench:** the canonical grader (`scripts/planningReliabilitySession.ts grade`) read each published final revision. The changed cases a04 and a12 were graded at `--step 1`.
- **Discovery:** an independent grader agent graded the published plans against `cases/discovery.json` and COMPLETION-SPEC §2–§3, recomputing ledgers, hours and settlement and opening the cited pages.
- **Where the records are:** grades are in `grades/` (`summary.txt` has one line per world), published states in `published/`, and Brain's run summaries in `grading-inputs/`.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 12 / 12 | 1.00 | 0.76–1.00 | 0 | 12 / 12 | 12 / 12 |
| raw-objective discovery | 2 / 4 | 0.50 | 0.15–0.85 | 1 | (graded by rubric) | (graded by rubric) |
| **all** | **14 / 16** | **0.875** | **0.64–0.97** | **1** | | |

The standard (≥ 0.90 with zero critical failures) is **not met**. This is the recorded result, unchanged.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| au-01 (d01) $1,500 / 14 days / no capital | CONDITIONAL `rev_fbaffa0f79f8_1a025d` | non-purchase price counted | **yes** | software check missing; Opus reasoning | The only member is DataAnnotation's published $25/hr pay for evaluation work the owner performs (60 hours on days 2–5). That pay is treated as an evidenced price, but it is a wage, not a price a buyer pays for an offer. There is also no second priced opportunity, and the decisive link is misidentified. |
| au-03 (d03) $3,000 / 21 days / $300 / 2 h a week | NO_PLAN `rev_7bbf8e4113ce_6639e3` | incorrect (B) | no | software check missing | The test schedules 3.5 owner hours in week 1 against the owner's "2 hours a week, no more". The checker compared only the window's total, which was 6 hours. The grader notes the rubric's 6-hour total would pass it, and decided by the owner's words. |

## Repairs, each at its owner (in the next build)

- **`WAGE_AS_PRICE`:**
  - **What it refuses:** an opening in the strategy whose card states its revenue as hourly pay (`wageWording`: pay or wage wording together with a per-hour rate), where Brain's record says the owner performs the work.
  - **Controls:** an hourly service sold to buyers, a workbook price, and a wage earned by a supplier are not refused.
- **`OWNER_HOURS_OVER` per week:** a weekly owner-hours allowance now binds every week of the plan, not only the window's total.
- **Regressions:** `tests/run14Regressions.test.ts` covers both, on the real published revisions.
