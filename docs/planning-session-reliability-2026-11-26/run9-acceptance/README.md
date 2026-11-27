# Run 9: fresh acceptance on the frozen build dc5b81e (2026-11-27)

The process was the same as runs 6–8. An independent agent wrote fresh hidden cases for this run: 12 bench cases and 4 raw-objective discovery cases. Each world ran on its own MCP host, 16 in all; 3 bench authors and 2 discovery authors did the work, and 2 fleet identities took the queue-dealt reviews and verifications. The harness watchdog now probes each host's port, and no host failed.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical |
|---|---|---|---|---|
| bench (hidden, held-out) | 12 / 12 | 1.00 | 0.76–1.00 | 0 |
| raw-objective discovery | 2 / 4 | 0.50 | 0.15–0.85 | **1** |
| **all** | **14 / 16** | **0.875** | **0.64–0.97** | **1** |

The standard (≥ 0.90 with zero critical failures) is **not met**: accuracy is 0.875, and one critical failure occurred.

- **Bench:** every bench case passed, including both mid-run changes (aj-04 objective, aj-07 contradicting price). Each was re-planned unprompted through `staleBecause`.
- **Earlier repairs held:** run 8's repairs (job-title payers, disputed exclusions, integrity scoped to the plan) held on these new cases.

## Failures and their causes

| case | outcome | critical | cause class | cause | repair (in the next build) |
|---|---|---|---|---|---|
| ak-01 ($1,000 in 14 days, no capital) | CONDITIONAL on the owner doing 44 hours of paid AI-training work at $25/h | **yes** (NON_PURCHASE_PRICE: a wage) | Brain supplied misleading input, and Opus reasoned on it | Brain admitted the route "Hourly AI-response evaluation/writing tasks performed by the owner", paid by one platform, as a commercial opening. The planner did not exclude it, and the author and the reviewer built on it. | `arrangementExclusion` excludes an opening that pays the owner by the hour for the owner's own work, as a wage. Controls: a fixed-price owner-delivered deliverable, and an hourly service a provider sells to buyers, both stay sales. |
| ak-03 ($12,000 in 45 days) | NO_PLAN with a test | no | Opus reasoning | The decisive links were right, but the proof rule could not make the plan executable: 2 deposits from 1,500 emails, applied to 8 sales, needs about 6,000 emails, above the cited 5,000/month tier. A designer quote between $701 and $900 met neither proof nor stop. | Not a Brain defect. The checker does not test a proof rule's arithmetic sufficiency. Recorded as a reasoning failure. |
