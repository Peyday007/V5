# Run 13: fresh acceptance on the frozen release df922b3 (2026-11-28)

The build was frozen at the merge of PR #1361, which carries Run 12's repairs:
- a condition against a price Brain establishes must name the defect the spec recognises;
- a measured conversion now reads as paid orders;
- the reviewer judges the revision its item names.

The hosts ran from a worktree pinned to that SHA. An independent agent wrote the hidden cases: 12 established-opportunity cases (`ar-*`) and 4 raw-objective discovery cases (`as-*`); they are in `cases/`. Five authors and two fleet reviewers took work from Brain's queue, and no author was prompted. `changer.sh` applied two mid-run changes:
- **a04:** the supplier re-quoted (03:22:26);
- **a05:** the target was raised.

Both changed cases were re-planned, re-reviewed and republished.

**Grading:**
- **Bench:** the canonical grader (`scripts/planningReliabilitySession.ts grade`) read each published final revision. The changed cases (a04, a05) were graded at `--step 1`, against the final objective.
- **Discovery:** an independent grader agent graded the published plans against `cases/discovery.json` and COMPLETION-SPEC §2–§3. It recomputed the ledgers, hours, capital and settlement days, and opened nine of the cited pages.
- **Records:** grades are in `grades/` (`summary.txt` is one line per world), the published states are in `published/`, and Brain's run summaries are in `grading-inputs/`.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 12 / 12 | 1.00 | 0.76–1.00 | 0 | 12 / 12 | 12 / 12 |
| raw-objective discovery | 2 / 4 | 0.50 | 0.15–0.85 | 0 | (graded by rubric) | (graded by rubric) |
| **all** | **14 / 16** | **0.875** | **0.64–0.97** | **0** | | |

The standard (≥ 0.90 with zero critical failures) is **not met**. This is the recorded result, unchanged.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| as-01 (d01) cideries only, $2,500 / 21 days / no capital | NO_PLAN `rev_651a0431d6fc_37ea95` | UNJUSTIFIED_REFUSAL | no | Opus reasoning; Brain input (verification defect) | It names MARKET_VOLUME (how many cideries exist) as decisive. The strongest route needs only 3 of about 850 listed cideries, and Brain's record shows the price is the unestablished link: no price comes from a cidery. Its only measurement is a desk count; no priced-offer test runs inside the window. Its price research was blocked: the verifier's verdict was keyed to the claims of a superseded submission and judged nothing, and the gate then refused the real reading as already judged. |
| as-02 (d02) $6,000 / 30 days / $500 / 4 h a week | CONDITIONAL `rev_ee2ac1bf7374_4e8a43` | incorrect (B) | no | software check missing; Opus reasoning | Two of three openings state no owner hours under a 17-hour limit. The plan marks the SBA count of 36,207,130 small businesses EVIDENCED and argues from it, although Brain's gate had rejected that claim for its population and definitions. |

## Repairs, each at its owner (in the next build)

**Brain's checker (`checkRevision`):**
- **Rejected evidence:** a quantity marked EVIDENCED whose only sources are claims the evidence gate rejected (and accepted on none) is refused as `REJECTED_EVIDENCE_USED`, with the gate's reason.
- **Owner hours:** under an owner-hours limit, every weighed opening states `members[].ownerHours`, and it may be null only where FULFILMENT is unestablished (`ARITHMETIC_UNSTATED`).
- **Regressions:** both are kept in `tests/run13Regressions.test.ts` on the real d02 revision and the gate's recorded reason, with controls.

**Brain's verification tool (`verifyResearch`), reported by fleet-2:**
- **Defect:** a verdict keyed `claim_id`, or keyed to a superseded submission's claims, was taken as judging nothing, and the research was blocked on it. This happened in d01, d02 and d04.
- **Repair:** each verdict must now name a claim of the current submission, and every current claim needs a verdict. Otherwise the call is refused and nothing is recorded. The regression is in `tests/sessionPlanningPath.test.ts`.

**d01's choice of decisive link** is a reasoning failure. Its stalled price research comes from the verification defect above.

## Defects the fleet reported (not graded)

- **Duplicate review:** fleet-2's REVISE on d03 `rev_1015ff710e7e_1c1313` was stored twice; the review tool does not refuse a repeat from the same reviewer. No verdict changed.
- **Verify item handed out again:** a verify item was handed out for a question already judged, and was then refused as already judged.
- **Brain mis-read MARKET_VOLUME:** in d01–d04, Brain's planner marked MARKET_VOLUME established for a one-off sale to one buyer, but these plans sell once each to several buyers. The reviewers raised it as a condition, and each author added a count-or-stop step.
