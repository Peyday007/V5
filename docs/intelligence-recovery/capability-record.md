# Commercial planning — live capability record

Started 2026-11-20 for the owner's "Final crusade" order. The status of each row is demonstrated behaviour on real planning outputs, never code written. Legend: **IMPL** = implemented, **INTEG** = on the production decision path, **VERIF** = a regression test or release check proves it, **DEMO** = shown on live goals or transfer variants.

The measure is `goals.sh check`, run on every release over the six live goals: plan integrity rules, reach (coverage), and acceptance. Alongside it, `tests/planTransfer.test.ts` runs 16 unseen variants (capital, unit, deadline, industry, autonomy), plus the metamorphic suite (W1). Progress counts only as fewer confirmed general failure classes, earlier ones staying corrected, and more variants producing defensible plans.

| # | Capability (owner §) | Existing implementation | Status | Gap / workstream |
|---|---|---|---|---|
| 1 | Objective interpretation (§17.1) | target.ts / objective.ts; rehearsal R1–R5 (amount, deadline, capital, monthly unit, hours) | IMPL INTEG VERIF | Monthly unit preserved end to end: W1 property 3 |
| 2 | Requirement discovery, recursive (§4) | portfolioNeeds (price, history, plan questions), researchAllocation, materiality, openQuestions | IMPL INTEG partly | Held-out structure → restructuring requirements → readmit on evidence: **W3** |
| 3 | Applied judgment: YES/NO/CONDITIONAL/UNKNOWN, unknown never favourable (§5) | rank.ts (unknowns at low end), #1157 capital held out, #1166 no scaling of an unestablished price, provenance on every ModelInput | IMPL INTEG VERIF DEMO ($10K 6.2%→0%, C 25.3%→10.1%) | Assumed levers (deposit, bundle, partner) still lift headline reach: **W2** |
| 4 | Buyers and counterparties (§2) | industry.ts `namesABuyerPopulation`; #1149 one organisation ≠ population; #1163 record field / clause ≠ buyer | IMPL INTEG VERIF | — |
| 5 | Money, time, capital modelling (§17.7) | portfolio.ts Monte Carlo (kept cash, deposits, ceilings, before-proof, days to cash) | IMPL INTEG VERIF | Metamorphic monotonicity (capital, deadline, ceiling): **W1** |
| 6 | Strategy generation and comparison (§7–8) | reconstruction operators, directions (stances, recombine, mutate, invented directions via model), variables sweep, challenge (C-15) | IMPL INTEG | Assumption-dependent upside used as headline: **W2** |
| 7 | Independent verification (§9) | planIntegrity (13 deterministic rules incl. WITHIN_LIMITS, NO_FAVOURABLE_UNKNOWN, NO_CONTRADICTORY_STEPS), release check, deep-review model challenge | IMPL INTEG VERIF | Executability not verified: **W4**; metamorphic properties: **W1** |
| 8 | Coherent execution sequence (§9) | planSteps (one step per move, scheduled, depends-on); #1153, #1154, #1167 (collect inside deadline), #1169 (no bring-in-then-leave-out) | IMPL INTEG VERIF DEMO | Every step belongs to the adopted strategy: W1 property 5 |
| 9 | AI-executable operations (§10) | ownerOf (act → BRAIN/PERSON), Instantly outreach, Hermes operator | PARTIAL | Executor and approval per step from the registered capabilities; routine owner labor refused: **W4** |
| 10 | Infeasibility recognized (§17.11) | NOT_VIABLE / NEEDS_EVIDENCE verdicts, binding constraint, limitation text | IMPL INTEG DEMO ($10K, $100K, A at 0% with named blockers) | — |
| 11 | Research acquisition and interpretation (§17.4) | goal-price research (#1160 ranked first, #1162 unit not instruction, #1165 re-ask parked needs) | IMPL INTEG; price missions RESEARCHING since 03:22Z | Evidence reaching plans: watch re-reads as packets complete |
| 12 | Learning and retention (§11, §17.13) | stance posterior, outcome lessons, arrangement library (signatures reused across goals) | IMPL INTEG | Not yet demonstrated on a corrected failure class |
| 13 | Transfer across variation (§13, §17.12) | planTransfer 16 variants, rehearsal cases | VERIF | Held-out objectives and metamorphic: **W1** |

## Workstreams (started 2026-11-20 ~06:00Z)

- **W1** metamorphic property suite over real plan reads — branch `claude/plan-metamorphic`
- **W2** assumed levers never set headline reach or adoption — branch `claude/assumption-honest-reach`
- **W3** restructuring requirement discovery for held-out openings — branch `claude/restructure-requirements`
- **W4** per-step executor and approval, plus an EXECUTABLE_BY_BRAIN integrity rule — branch `claude/plan-executability`
- Coordinator: this session merges, deploys and re-reads in one queue with the release owner session.
