# Run 7: fresh acceptance on the frozen build cfebfd5 (2026-11-27)

Fresh hidden cases were written for this run by an independent agent that had not seen run 6's cases or results: 14 bench cases (`cases/cases.json`) and 4 raw-objective discovery cases (`cases/discovery.json`).
- **Process:** the same as run 6, with 4 bench authors, 2 discovery authors and 2 fleet identities taking every `PLAN_REVIEW` and `PLAN_VERIFY` item from the queues. Nobody relayed anything between sessions.
- **Mid-run changes:** three cases changed after first publication (ag-05 capital, ag-08 contradicting price, ag-14 objective). In each, the session saw `staleBecause` in `brain_planning_state` and re-planned with no prompt. This is the run 6 coordination repair working live.
- **Hosts:** none died. 18 hosts fit in memory.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical |
|---|---|---|---|---|
| bench (hidden, held-out) | 13 / 14 | 0.93 | 0.69–0.99 | 0 |
| raw-objective discovery | 1 / 4 | 0.25 | 0.05–0.70 | 0 |
| **all** | **14 / 18** | **0.78** | **0.55–0.91** | **0** |

The standard is **not met** on this build. All 18 results were published, and none is a critical failure.

## Failures and their causes

| case | outcome | cause | repair |
|---|---|---|---|
| ag-11 (one transit authority's $6,000 order against $18,000) | TARGET declared infeasible; rubric: MARKET_VOLUME missing | **Same cause as run 6's ac-15, only partly repaired.** The counted-market rule ran only when the chain did not mark MARKET_VOLUME missing. Here the chain marked it missing, and the older rule accepted any EVIDENCE fact, so `price` and `payer` passed. | The counted-market rule now applies to every TARGET limit, and the generic binding-fact check no longer stands in for it. Regression from this case. |
| ae-01, ae-02, ae-03 (discovery) | no-plan or conditional with a test; each cited public sources for one opening only | The provenance rule covered only the strategy's openings. The alternatives the session weighed were left as uncited categories ("Upwork hourly work", "Gumroad templates"). §2(B) and the rubrics need specific discovered opportunities. | Every session-discovered opening the plan weighs (strategy or chain) must cite a public page about it, for every stance. Regression with a weighed-but-uncited alternative. |
| ae-02 | also: the NPI count recorded EVIDENCED after the gate rejected it for scope | Opus reasoning despite adequate input: the gate's verdict was in the record. | Not repaired by code in this round. The reviewer brief already says rejected evidence is not established, and the reviewer passed the plan anyway. Recorded as a reasoning failure. |

ae-04 passed. It names three cited openings, the decisive links (CURRENT_DEMAND, CONVERSION), and a $122 test. Its net proof of $3,303 by day 21 was re-checked by the grader.
