# Commercial planning — live capability record

Started 2026-11-20 for the owner's "Final crusade" order. The status of each row is demonstrated behaviour on real planning outputs, never code written. Legend: **IMPL** = implemented, **INTEG** = on the production decision path, **VERIF** = a regression test or release check proves it, **DEMO** = shown on live goals or transfer variants.

The measure is `goals.sh check`, run on every release over the six live goals: plan integrity rules, reach (coverage), and acceptance. Alongside it, `tests/planTransfer.test.ts` runs 16 unseen variants (capital, unit, deadline, industry, autonomy), plus the metamorphic suite (W1). Progress counts only as fewer confirmed general failure classes, earlier ones staying corrected, and more variants producing defensible plans.

| # | Capability (owner §) | Existing implementation | Status | Gap / workstream |
|---|---|---|---|---|
| 1 | Objective interpretation (§17.1) | target.ts / objective.ts; rehearsal R1–R5 (amount, deadline, capital, monthly unit, hours) | IMPL INTEG VERIF | Monthly unit preserved end to end: W1 property 3 |
| 2 | Requirement discovery, recursive (§4) | portfolioNeeds (price, history, plan questions), researchAllocation, materiality, openQuestions | IMPL INTEG VERIF (W3 #1172: restructuring questions for held-out openings, stated deposit share kept) | Answers about supplier terms, staged delivery and a broker have no field to land in yet |
| 3 | Applied judgment: YES/NO/CONDITIONAL/UNKNOWN, unknown never favourable (§5) | rank.ts (unknowns at low end), #1157 capital held out, #1166 no scaling of an unestablished price, provenance on every ModelInput | IMPL INTEG VERIF DEMO ($10K 6.2%→0%, C 25.3%→10.1%→0%) | Done by W2 (#1175): headline reach comes from `Reconstruction.established`, and assumed moves are shown separately as AssumedUpside. #1178: an UNKNOWN supplier cost no longer reads as SUPPORTED |
| 4 | Buyers and counterparties (§2) | industry.ts `namesABuyerPopulation`; #1149 one organisation ≠ population; #1163 record field / clause ≠ buyer | IMPL INTEG VERIF | — |
| 5 | Money, time, capital modelling (§17.7) | portfolio.ts Monte Carlo (kept cash, deposits, ceilings, before-proof, days to cash) | IMPL INTEG VERIF | Metamorphic monotonicity (capital, deadline, ceiling): **W1** |
| 6 | Strategy generation and comparison (§7–8) | reconstruction operators, directions (stances, recombine, mutate, invented directions via model), variables sweep, challenge (C-15) | IMPL INTEG VERIF (#1175, #1177, #1178 fulfilment-route lever) | — |
| 7 | Independent verification (§9) | planIntegrity (13 deterministic rules incl. WITHIN_LIMITS, NO_FAVOURABLE_UNKNOWN, NO_CONTRADICTORY_STEPS), release check, deep-review model challenge | IMPL INTEG VERIF | Done: W1 metamorphic suite (#1170), W4 EXECUTABLE_BY_BRAIN (#1175), STEPS_BELONG_TO_PLAN (#1177); the release check reads each goal in its own bounded process (#1180) |
| 8 | Coherent execution sequence (§9) | planSteps (one step per move, scheduled, depends-on); #1153, #1154, #1167 (collect inside deadline), #1169 (no bring-in-then-leave-out) | IMPL INTEG VERIF DEMO | Every step belongs to the adopted strategy: W1 property 5 |
| 9 | AI-executable operations (§10) | ownerOf (act → BRAIN/PERSON), Instantly outreach, Hermes operator | IMPL INTEG VERIF (W4 #1175: stepExecutor gives each step BRAIN/PROVIDER/OWNER/CAPABILITY_MISSING plus an approval reason) | Not demonstrated on an accepted plan, because no live goal has one yet |
| 10 | Infeasibility recognized (§17.11) | NOT_VIABLE / NEEDS_EVIDENCE verdicts, binding constraint, limitation text | IMPL INTEG DEMO ($10K, $100K, A at 0% with named blockers) | — |
| 11 | Research acquisition and interpretation (§17.4) | goal-price research (#1160 ranked first, #1162 unit not instruction, #1165 re-ask parked needs) | IMPL INTEG; price missions RESEARCHING since 03:22Z | Evidence reaching plans: watch re-reads as packets complete |
| 12 | Learning and retention (§11, §17.13) | stance posterior, outcome lessons, arrangement library (signatures reused across goals) | IMPL INTEG | Not yet demonstrated on a corrected failure class |
| 13 | Transfer across variation (§13, §17.12) | planTransfer 16 variants, rehearsal cases | VERIF | VERIF via W1 (#1170) plus NO_CAPITAL intent (#1171); planTransfer passes |

## Workstreams (started 2026-11-20 ~06:00Z)

- **W1** metamorphic property suite over real plan reads — branch `claude/plan-metamorphic`
- **W2** assumed levers never set headline reach or adoption — branch `claude/assumption-honest-reach`
- **W3** restructuring requirement discovery for held-out openings — branch `claude/restructure-requirements`
- **W4** per-step executor and approval, plus an EXECUTABLE_BY_BRAIN integrity rule — branch `claude/plan-executability`
- Coordinator: this session merges, deploys and re-reads in one queue with the release owner session.

## Release state, 2026-11-20 ~16:00Z

Live in production at a0ee88f1: #1158 #1163 #1164 #1166 #1167 #1169 #1170 #1171 #1172 #1175 #1177 #1178 #1180 #1181. Release check 44738453008 passed with GOALS: OK: integrity OK on all six goals and CANDIDATE_ONLY everywhere. Reach is 0% on all six. That figure is honest, not a regression: before W2, every non-zero reach depended on assumed levers. The binding constraints are an unknown direct cost ($5K/mo, at the $1,500 ceiling) and market size (C, p90 $35K against a $50K target). Price research is the critical path: the first ACCEPTED goal-price fragments have arrived since #1174.

**Not yet demonstrated:** an accepted, executable plan on any live goal; learning measured on a corrected failure class.
