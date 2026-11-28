# Run 11: fresh acceptance on the frozen release e8ef992 (2026-11-27/28)

The build was frozen at the commit released to production as PR #1357. It holds Run 10's repairs:
- a test may not sell before fulfilment is established;
- the arithmetic is stated per opening;
- every opening is accounted for;
- planning review and verification items ride one-item bins the routine fleet can be handed.

The hosts ran from a worktree pinned to that SHA, so no later edit could reach them.

An independent agent wrote the hidden cases. Its brief now requires capacity, dates and payment terms to be stated whenever a verdict depends on them: Run 10's al-08 rubric defect. The set has 12 established-opportunity cases (`an-*`) and 4 raw-objective discovery cases (`ao-*`).

| Role | Who |
|---|---|
| Authors | Five, A–C on the bench and E–F on discovery |
| Reviewers and verifiers | Two fleet identities (`fleet-1`, `fleet-2`), taking work from Brain's queue |

No author was prompted. `changer.sh` applied each case's change after the world's first publication:
- a11: capital raised (23:19:22);
- a09: objective changed (23:26:55).

Both were re-planned, re-reviewed and republished.

**Grading:**
- **Bench:** the canonical grader (`scripts/planningReliabilitySession.ts grade`) read each published final revision. Changed cases (a09, a11) were graded at `--step 1`, against the final objective.
- **Discovery:** an independent grader agent graded each world against the hidden rubrics in `cases/discovery.json` and COMPLETION-SPEC §2–§3. Its grades are in `grades/discovery-grades.json`.

Reruns of the grader read `grading-inputs/` (keys and Brain's run summary) and `published/`.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 12 / 12 | 1.00 | 0.76–1.00 | 0 | 12 / 12 | 12 / 12 |
| raw-objective discovery | 1 / 4 | 0.25 | 0.05–0.70 | 0 | (graded by rubric) | (graded by rubric) |
| **all** | **13 / 16** | **0.8125** | **0.57–0.93** | **0** | | |

The standard is not met: accuracy ≥ 0.90 with zero critical failures is required. There are zero critical failures, but accuracy is 0.8125.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| ao-01 (d01) $1,500 / 21 days / no capital | CONDITIONAL `rev_fec500de1845_94bc38` | incorrect (B) | no | software check missing; Opus reasoning | The proof is 1 paid of 200, and the continue path reaches only about 600 contacts. At the proof rate that is 3 sales × $485, about $1,456, under $1,500, so passing the test does not carry the target. |
| ao-02 (d02) $6,000 / 30 days / auto repair | CONDITIONAL `rev_c74406c7f734_0cb485` | incorrect (B) | no | software check missing; Opus reasoning | The proof is 1 of 150 (0.67%), but 7 sales are needed, about 2.3% of the contacts it plans. The rate a pass needs is never computed. |
| ao-04 (d04) $12,000 / 45 days / $2,500 | CONDITIONAL `rev_ea31974a7082_278bec` | incorrect (B) | no | Opus reasoning | The settlement estimate omits the platform's 4-day safety clearance, although the plan's own cited source states it. The last sale can settle after day 45. The plan's continue rule (1 per 1,000) also contradicts its stop rule (under 1 per 500). |

**ao-01 and ao-02 share a demonstrated cause with Run 9's ak-03.** Brain's checker never tested whether a conversion test, passing exactly at its threshold, carries the target over the contacts the plan reaches.
- **Repair** (in the next build), in `checkRevision`:
  - a conditional plan whose test decides CONVERSION states `validation.threshold {paid, of, reach}`;
  - Brain refuses (`PROOF_INSUFFICIENT`) a threshold whose rate over `reach` gives fewer than the members' deals, and names the threshold that would carry them.
- **Guidance:** the author's tool description and the reviewer's instructions state the same.
- **Regression:** kept in `tests/run11Regressions.test.ts` on the real published d01/d02 revisions, with controls that pass a sufficient threshold.
- **ao-04:** this is a reading of a cited source. No general check owns it, and it is recorded as a reasoning failure.

## Defects the fleet reported (not graded, repaired or recorded)

- **Verification without a verdict.** `brain_planning_verify_research` accepted a call with no verdicts and no sufficiency. That blocked the research, and the verifier's real verdict was then refused as already judged. The outcome matched the verifier's reading, so no grade changed.
  - **Repair:** the tool now refuses such a call (`verdictsArg`/`sufficiencyArg`, tested in `tests/run11Regressions.test.ts`).
- **a02: review recorded against the wrong revision's figures.** fleet-1 recorded its review on `rev_8eb56276b06e` using figures from its sibling revision. The reviewer's own recheck still supports PASS, and the published revision is the sibling the review figures came from. Recorded as a reviewer error.
