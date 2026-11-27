# Run 6: final acceptance on the frozen build 48e1ca5 (2026-11-27)

The complete process ran on Brain's real MCP router, one isolated world per case:
- **Authors:** 6 author sessions.
- **Fleet:** 3 fleet identities. They took every `PLAN_REVIEW` and `PLAN_VERIFY` item from each world's queue. Nobody passed revisions between sessions.
- **Publication:** a plan published only after a clean check and a PASS from a fleet identity that was not its author.
- **Cases:** written by an independent agent and hidden from authors and reviewers until grading: 20 bench cases (`cases/cases.json`) and 4 raw-objective discovery cases with rubrics (`cases/discovery.json`).
- **Bench grading:** the spec's own grader (`scripts/planningReliabilitySession.ts grade`), applied to each world's **published** plan.
- **Discovery grading:** a separate grader agent, applying each hidden rubric and COMPLETION-SPEC §2–§3 (`grades/discovery-grades.json`).

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical |
|---|---|---|---|---|
| bench (hidden, held-out) | 18 / 20 | 0.90 | 0.70–0.97 | 0 |
| raw-objective discovery | 0 / 4 | 0.00 | 0.00–0.49 | 0 |
| **all** | **18 / 24** | **0.75** | **0.55–0.88** | **0** |

The standard (≥ 0.90 with zero critical failures) is **not met** on this build. Every result was published, and none of the 24 is a critical failure.

## Failures and their causes

| case | outcome | cause class | cause | repair |
|---|---|---|---|---|
| ac-15 (one $3,500 RFQ against a $12,000 target) | TARGET declared infeasible; rubric: MARKET_VOLUME missing | Brain input and checker: Opus reasoned on a check that let it through | The author treated the openings on file as the whole market. The checker accepted a TARGET limit citing only `price`, because the author had not marked MARKET_VOLUME missing. | A TARGET limit must cite a counted market (an EVIDENCE `buyerVolume` fact). Test with matched control (ac-20: 380 dealerships). |
| ac-17 (net objective, cost = price) | TARGET plus ECONOMICS; rubric: ECONOMICS (missing evidence) | Label disagreement | The published reasoning matches the case's own description: "whole counted market has signed … net ≈ $1,450 < $3,000". It declares that as a TARGET limit on a counted market (the buyerVolume fact is cited), where the rubric expects the ECONOMICS gap. | None. The rubric is unchanged, the score stands, and this is recorded as a disagreement, not re-scored. |
| ad-01…ad-04 (discovery) | CONDITIONAL plans with zero-cost or capped tests; no critical | Brain schema and checker gaps | (1) A conditional plan had no field for, and no check requiring, the decisive missing evidence of §2(B); all four charted every link missing and singled out none. (2) Plans cited Brain's own cards (the brief's convention) for openings the session itself discovered, so the published plan showed no public provenance. The routes' searches are stored, but no plan had to cite them. | `validation.decides` is required for CONDITIONAL plans and checked against the chain and `resolves`. A session-discovered opening must be cited to a public page (`sources[].opportunityId`). Tests with matched controls. |

## Coordination defect found during the run

The four changing cases (ac-04 objective scope, ac-05 settlement, ac-12 contradicting price, ac-19 capital) were changed after their first publication. The author sessions had finished, and `brain_planning_state` still reported the old plan as published, so no session knew to re-plan. Each re-plan was prompted once by the run operator, standing in for the owner announcing the change. The re-planned results are the ones graded.

The defect is now fixed. Publication fingerprints what the plan rests on: the goal's words, its stored terms, and each weighed opening's card, facts and agreements. `planningState` reports a plan whose basis changed as `staleFinal`, with `staleBecause` naming what changed. A test covers the objective changing, the plan going stale, and the objective being restored, and the same sequence for a card fact.

## Operational notes

- **Memory:** each isolated host uses about 550 MB. With 24 hosts, the container's OOM killer took 6 hosts mid-run. They were restarted on their own databases and their state was intact, and a watchdog then restarted any host that died.
- **Typecheck:** `tsc` itself was OOM-killed while the hosts ran. A type error in a new test (lease expiry) went unseen until the hosts stopped. It was fixed in the next commit.

## Next

The repairs above are a changed build, so fresh acceptance evidence is required on new hidden cases (run 7).
