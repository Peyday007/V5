# Run 10: fresh acceptance on the frozen build a5412ec (2026-11-27)

This run used the same process as runs 6–9. An independent agent wrote fresh hidden cases: 12 bench cases with established opportunities and 4 raw-objective discovery cases.

- **Hosts:** each world ran on its own MCP host, 16 in all.
- **Authors:** A–C wrote the bench plans and E–F the discovery plans.
- **Reviewers:** two fleet identities (`fleet-1`, `fleet-2`) took reviews and verifications from Brain's queue.
- **No intervention:** nobody prompted an author or moved work between author and reviewer.
- **Mid-run changes:** `changer.sh` applied each case's change after the world's first publication:
  - a09 had its price contradicted (12:22:41);
  - a08 had its objective changed (13:44:09).

  Both were re-planned, re-reviewed and republished unprompted.

## Grading

Grading was recorded on 2026-11-27, after every world had finished. The build, plans and rubrics were not changed first.

- **Bench:** `npx tsx scripts/planningReliabilitySession.ts grade --case ID --dir w/W --cases cases/cases.json` was run on each world's published final revision.
  - It used `--step 1` for the two changed cases (a08, a09). This grades the final reading against the post-change rubric, as in run 9.
  - The rows are in `grades/aNN.json` and the summary in `grades/summary.txt`.
- **Discovery:** an independent grader agent graded the worlds against the hidden rubrics in `cases/discovery.json`. The verdicts are in `grades/discovery-grades.json`.
  - The grader read the same final revisions that remain published (d01 `rev_d0fb02872735_3cdc2d`, d02 `rev_a8c79b875ccf_0a445e`, d03 `rev_a7f883f8f043_95707f`, d04 `rev_5acf3f75bb94_c19b6c`).
  - None of them went stale afterwards.
- **States:** `published/*.state.json` is `planningState` read from each world database after the run.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical |
|---|---|---|---|---|
| bench (hidden, held-out) | 11 / 12 | 0.917 | 0.65–0.99 | 0 |
| raw-objective discovery | 3 / 4 | 0.75 | 0.30–0.95 | 0 |
| **all** | **14 / 16** | **0.875** | **0.64–0.97** | **0** |

The standard requires accuracy ≥ 0.90 with zero critical failures. It is **not met**:
- there were zero critical failures;
- but accuracy is 0.875, below 0.90.

Run 9's critical failure (ak-01, a route paying the owner a wage) did not recur.

## Failures

| case | published | expected | failure | critical | what happened |
|---|---|---|---|---|---|
| al-08 forklift (objective changed) | CONDITIONAL `rev_9a8c776187a7_da84c6` | EXECUTABLE_PLAN | UNJUSTIFIED_REFUSAL (e2e VERDICT_INCORRECT, OPENING_UNACCOUNTED) | no | See below. |
| am-03 large target, capital | NO_PLAN `rev_a7f883f8f043_95707f` | branch B, a justified limitation | UNJUSTIFIED_REFUSAL | no | The plan covers four openings, but its arithmetic against $12,000 is incomplete: no deal count or cash timing for Freelancehunt, no timing for PeoplePerHour, and no check of capital per cycle against $2,500. Every opening needs about 270–430 hours of the owner's own delivery, and the owner's ability to fulfil is unproven, yet FULFILMENT was never made a decisive link or tested. The test also wins real client awards before fulfilment is shown to be possible. The grader noted the case is ambiguous, since the prose does ask about owner hours. |

### al-08: what happened (diagnosis only; nothing was changed)

**The change.** After the objective was limited to forklift training, the case expects an executable plan: four signed $950 sessions, delivered by a trainer quoted at $520, invoiced net 10.

**The objection.** The reviewer returned REVISE with the condition below, which cites the evidence (link FULFILMENT, field `fulfillment`):

> "The fulfillment record says the trainer is 'available weekly in December'; it does not establish capacity for four sessions by about day 20, which the plan needs for all four net-10 payments to settle by day 30 (three give $2,850 < $3,000)."

**The outcome.** The author accepted the condition. The published plan goes ahead only if the trainer confirms four dates by day 20, with a stop on day 2.

**The open question.** The case's description assumes the trainer can deliver all four sessions in time, but the record says only "available weekly in December".
- If that means one session a week, the reviewer's arithmetic holds: the fourth net-10 payment lands after day 30.
- If it means any week, the plan should have been executable.

This run cannot tell whether the expected answer or the review is wrong, because the evidence wording supports both readings. It is recorded as a failure, as graded, and is left for the next repair cycle to settle against the evidence.

**A smaller defect.** The bowling opening, which became out of scope after the change, is never mentioned in the published plan. That produced OPENING_UNACCOUNTED.

## Process observations

- **a08's loop.** a08 went through four reviews: PASS, REVISE, REVISE and PASS.
  - The second REVISE answered an unchanged resubmission.
  - The loop ended on its own, without anyone stepping in.
- **Duplicate review.** fleet-2 accidentally submitted the first a09 review twice, so it appears twice in a09's review list. It did not change any outcome.
