# Run 8: fresh acceptance on the frozen build a664ccd (2026-11-27)

The process was the same as runs 6 and 7. An independent agent wrote fresh hidden cases for this run: 14 bench cases and 4 raw-objective discovery cases. Each world ran on its own MCP host; 4 bench authors and 2 discovery authors did the work, and 2 fleet identities took the queue-dealt reviews and verifications.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical |
|---|---|---|---|---|
| bench (hidden, held-out) | 13 / 14 | 0.93 | 0.69–0.99 | 0 |
| raw-objective discovery | 2 / 4 | 0.50 | 0.15–0.85 | 0 |
| **all** | **15 / 18** | **0.83** | **0.61–0.94** | **0** |

The standard is **not met** on this build. No case is a critical failure.

**The earlier repairs held on new cases:**
- **Counted-market rule:** ah-11 (one authority's one order) is a MARKET_VOLUME gap, and ah-14 (140 counted firms × $480) is a real TARGET limit. Both pass.
- **Staleness:** three mid-run changes (ah-05, ah-12, ah-13) were re-planned unprompted through `staleBecause`.
- **Discovery provenance:** ai-01 and ai-03 pass, each naming 3–4 discovered openings with verified public citations and a decisive link.

## Failures and their causes

| case | outcome | cause class | cause | repair (in the next build) |
|---|---|---|---|---|
| ah-06 (5 signed $420 orders from rink "program directors") | not published | Brain supplied misleading input | (1) `paymentNature` read "Ice rink program directors" as a funding program, so all three openings were excluded as "not a sale". (2) An excluded opening was not "admitted", so even a stated EXCLUSION dispute could never build on it (`OPPORTUNITY_NOT_ADMITTED`). | A program word followed by a role (director, manager, coordinator, …) is a person's job, not the body. Excluded openings are admitted. Regressions added in commercialHoldout and sessionPlanningPath. |
| ai-02 (craft distilleries) | not published | Brain software | A plan-integrity finding (NO_FAVOURABLE_UNKNOWN) about a route the session had set aside refused every revision, whatever the plan used. | Integrity findings that quote an opening the plan does not use no longer refuse it. Findings about a used opening, or naming none, still do. Regression added. |
| ai-04 ($3,000 net in 14 days) | not published | Operational failure in the test harness | Under memory pressure the watchdog restarted the host while the old process held the port (EADDRINUSE). No route was ever admitted, and every planner run returned no reading. | Harness: fewer hosts per run. The case counts as run and failed (§4). |

**Noted, not repaired:** a route filed with performer "BRAIN" can record a provider named "BRAIN" (seen by author B on ah-06's route copies).
