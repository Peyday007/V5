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

## 24-hour mission — checkpoint hour 6 (2026-11-21 01:06Z; deadline 19:06Z)

**Verified on production since 19:06Z:**
- **Released in three batches:** #1188–#1192 (ca770ed5, check 44817141174 OK), #1193 (a770e1d3, check 44824077746 OK), #1194 (30ad4f43, check 44833635162 OK) and #1195–#1197 (Deploy 44842165280 reached Fly).
- **Recovered failure:** Deploy 44837932895 failed when #1193 and #1195 interacted in a test. #1197 fixed it, and the failed deploy did not touch the machine.
- **What landed:** dispatch reads a refused review as waiting (#1188); leases are returned on shutdown (#1189); designs that read identically are one plan member (#1190); a check is made by a different model than the producer (#1191); restructuring answers readmit an opening on evidence (#1192); owner hours follow the performer (#1193, $10K goal: 0 → 9 constructed estimates admitted); a keyed search provider (#1194, waiting on the owner's key); broker revenue is its commission (#1195); every cut is counted by reason, and the screen never credits price above the goal (#1196).
- **Research to plan, end to end:** accepted claim clm_d0422544 → construction fact $6,000 → goal C's homeowner design read at COMPARABLE p50 6000 (release owner, plan read 44842405254).

**In flight:** #1198 (a step names the price it holds) and #1199 (days to cash from the payment structure; the $10K midpoint was 880.7 days and is now 14.5). Both release at 01:25Z, followed by a $10K plan re-read.

**Critical path:** accepted evidence (prices, days to cash, close and reply rates), and structural misreadings that hide feasible designs. #1193, #1199 and #1195 each removed one of those misreadings. Search quality (#1194) needs the owner's Google key.

**Forecast:** an ACCEPTED (defensible 90%) plan by 19:06Z remains unlikely, as escalated at 19:20Z. All six goals read 0% coverage at the latest check. Spend: $0 an hour; the GPU stays off.

### 2026-11-21 ~03:10Z — batch #1198/#1199/#1200 live

- Deploy 44850160451 was refused by the Postgres suite (44850129351): two flaky tests. goalPlan's statement ceiling read 142 against <140 when the same SHA reads 139. machinesBrowserToDatabase had a findBy timeout. #1200 widens the ceiling to 160 and keeps the per-opening guard.
- Deploy 44856874965 succeeded; release check 44859370446 GOALS: OK; serving 5d5df434.
- $10K plan (44860552332), after #1199: 8 constructed estimates admitted (was 7), reach still 0%, CANDIDATE_ONLY. Every strategy, including a $15/3-day one-off, fails "breaks the money or hours limit in every tested case" (hours limit 0). The repeatable constructed design arr_6b722dfcb622 reads contacted 0, with outreach a day not established. Both are under diagnosis on claude/plan-infeasible-everywhere.
- Unfamiliar-objective acceptance on production HEAD: planTransfer, planMetamorphic, priceMechanismTransfer, surgeBMechanismTransfer and cashDiveEvidenceTransfer pass 70/70.

### 2026-11-21 07:07Z — hour-12 checkpoint (deadline 19:06Z)

**Completed and verified on production:**
- #1200–#1203 live at 91bf9ef8 (Deploy 44870095177, GOALS: OK). #1204 (the verdict describes the modelled constructed estimates) is merged and awaits the next Deploy.
- $10K plan (44873654201): a constructed design (arr_6b722dfcb622) leads for the first time, with 1 estimate in the best combination. The verdict names the real cause: no performer is established.
- Fresh reads of the other five goals (44874080198, 44874300029, 44874456775, 44874552077, 44874773179). Constructed designs lead all of them. C settles p50 $40,338, $100K p50 $29,232, $5K/mo p50 $2,475. All are at 0% reach.
- Unfamiliar-objective suites pass 70/70 on production HEAD.
- Investigated and correctly left alone: the 77 unpriced designs (their prices span about 5 orders of magnitude); Brain's production cost (no measured rows, so nothing to substitute without breaking invariant 33).

**Critical path to an accepted plan:** the leading designs deliver "(not yet specified)". So no performer is established, the direct cost is the blind sweep, and the plan cannot become executable. Specifying the deliverable from evidence (worker on claude/specify-deliverable), and removing false "performed by Brain" claims on unspecified steps (worker on claude/unspecified-deliverable-step), are the two engineering links. Beyond them, reach rests on unmeasured close rate, cost and timing, which need buyer contact (owner grants CONTACT_BUYER, QUOTE_AND_INVOICE, ACCEPT_PAYMENT).

**Forecast:** an accepted 90% plan by 19:06Z is unlikely without measured buyer facts. Engineering will deliver honest, executable candidates with their gaps named.

**Staffing:** 2 workers, both on the critical path. No idle workers, and no paid compute is warranted (the binding factor is evidence).

### 2026-11-21 13:07Z — hour-18 checkpoint (deadline 19:06Z)

**Completed and verified on production:**
- #1204–#1207 are live at 5618afb0 (Deploy 44885799952; release check 44889775679 reads GOALS: OK).
- #1206: the plan now reads the quant engine's reconstructed supply cost as its direct cost. It used to be read only by construct.ts's stress risk. It enters as an ASSUMPTION ("reconstructed, not established") unless the evidence is DIRECT and sufficient. Demonstration (hood-vent cleaning): direct cost moved from a 0–769.27 sweep to COMPARABLE p10 174.94 / p50 301.99 / p90 539.47.
- #1207: construction takes evidenced deliverables. Where no evidence names one, it asks research what the buyers pay for, and an unspecified design ranks after a specified one.
- Plan reads on 5618afb0:

  | Goal | Run | Reach | p50 | Change |
  |---|---|---|---|---|
  | $10K | 44891151218 | 9.9% (from 0%) | $4,029 | Reconstructed plan: a year-end client-mailing design plus 21 pre-warmed accounts ($370). |
  | C | 44890873692 | 0% | $41,099 (from $40,338) | |
  | $100K | 44891419181 | 0% | $29,232 | |
  | $5K/mo | 44891695324 | 0% | $2,475 | |
  | A | 44892068783 | 0% | $0 | Flagged implausible. |
  | B | 44892353756 | 0% | $0 | Flagged implausible. |

  On C, $100K and $5K/mo the COST lever still binds: their leading designs have no filed supplier rates, or Brain would produce them, so the sweep is correct for them.

**Critical path for the last 6 hours:** no new engineering that cannot be released and verified before 19:06Z. The remaining binding inputs are unmeasured buyer facts: cost, close rate and settlement timing. No code change honestly closes that gap; owner grants (CONTACT_BUYER, QUOTE_AND_INVOICE, ACCEPT_PAYMENT) would. The time is reserved for the acceptance run across unfamiliar objectives and the deadline delivery.

**Forecast:** no ACCEPTED (defensible 90%) plan by 19:06Z. Spend is $0.
