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

## Reconciliation against the original completion requirements (2026-11-27)

The owner set these requirements in the "Continue the current mission… WHAT COUNTS AS FINISHED" message. No new requirement is added here.

| requirement | state | evidence / reason |
|---|---|---|
| The real Claude-app workflow works without the owner managing its stages | **NOT MET on the real app** | **On the isolated host it works.** `scripts/planningMcpHost.ts` mounts Brain's real `mcpRouter`, with the same authentication, authorization and tool dispatch the app connector uses. On it, runs 6–10 went from author → Brain checks → queue-dealt independent review → publication. Runs 7–10 ran with no prompting and no hand-carrying of work between author and reviewer. In run 10, both mid-run changes (a08, a09) were re-planned unprompted.<br>**On production it does not.** The `production` branch does not contain a5412ec (verified with `git merge-base --is-ancestor`), and the production connector lists no `brain_planning_*` tool. It is blocked by **MISSING_AUTHORITY**: deploying needs the owner's authorization. |
| Planning reliability meets COMPLETION-SPEC (≥ 0.90, zero critical, representative, independently evaluated, hidden cases included) | **NOT MET** | Run 10 scored 14/16 = 0.875 (Wilson 0.64–0.97), with 0 critical failures. The step-5 rule applies: diagnose, repair, keep the regression, then run a fresh acceptance on the changed build (run 11). This run records the evaluation only. |
| Each result is an evidence-supported plan, or a justified limitation with a concrete measurement or experiment | **14 / 16 met** | The 12 passing cases carry graded plans or justified NO_PLAN outcomes. Each NO_PLAN names its binding constraint and either a measurement or the change to the goal that would remove the constraint. Both failures (al-08, am-03) are above. |
| Software tests, tool registration, a review PASS or a release document alone are not "finished" | respected | Nothing above is counted as done on that basis. |

**What the owner must do to test this in the real Claude app.** None of these steps spends money or contacts anyone.

1. Authorize the merge of `claude/10k-revenue-30-days-9ba2t4` into `production` and dispatch `Deploy`.
2. Run `npm run admin -- access grant-planning worker-05 <project> --admin <your account>` to give the app's worker planning rights on the project.
3. Become the goal's owner via `PATCH /api/goals/<goal>/terms`.
4. Open the Claude app with the Brain connector and state an objective. The `brain_planning_*` tools then run the same loop that runs 6–10 exercised.
