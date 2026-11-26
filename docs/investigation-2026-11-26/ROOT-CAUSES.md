# Root-cause register (lead draft v1: subject to Gate C; revision REF 2d79f7d / PROD a8c4699)

Status vocabulary (owner's Section 13):
- OBSERVED SYMPTOM
- SUSPECTED CAUSE
- SUPPORTED CAUSE
- ESTABLISHED CAUSE
- REFUTED CAUSE
- UNRESOLVED

**ESTABLISHED** here means all four of the following:
1. The failure is evidenced.
2. The mechanism is located at file:line.
3. A deterministic reproduction or recorded production trace shows that mechanism producing the symptom at REF.
4. The competing explanations have been considered.

Independent verification (Gate C) is pending for every row. Until Gate C confirms a row, read its ESTABLISHED as *ESTABLISHED (lead), unverified*.

Prior IDs (RC1–RC15) come from `docs/PLANNING-FAILURE-MAP.md`. CR-numbers are this investigation's own.

## A. Mechanism-level causes

| id | mechanism (where) | evidence | status | prior | correction class (not implemented) | proof the correction worked |
|---|---|---|---|---|---|---|
| **CR-01** Model output is accepted without checking that the turn is complete | <ul><li>`askModel` retries only on fully empty content (`routeProposal.ts:1436-1447`).</li><li>`chatFor`/`readStream` record no `finish_reason`, erase a stream error when partial text arrived, and drop the last line when it lacks a newline (`modelBench.ts:81-166`).</li><li>`stripThink` keeps an unclosed think block (`:169`).</li><li>Budgets are 2500–4000 tokens for a reasoning model (`routeProposal.ts:1874,1898,2037,2062,2097`).</li></ul> | <ul><li>E-001: 6/12 empty, error null, 47–85 s.</li><li>E-002 (E1): 2,103-char truncated reply, error null, zero routes.</li><li>E-015: fault injections pass silently.</li></ul> | **ESTABLISHED** (the acceptance defect). **UNRESOLVED**: which upstream truncation mechanism operates, reasoning-budget exhaustion (H1b) or a dropped stream (E-015 #1). The idle-cut explanation is **REFUTED** for empty bodies. | RC1 (corrected: RC1 merged two mechanisms) | A turn counts only when its completion contract is met: finish reason, a complete parse, and the served model recorded. Otherwise it is retried on the same capable model with an adequate budget. | <ul><li>Replays of E-001/E-002 prompts record `finish_reason` and give zero truncated or empty acceptances.</li><li>A fallback's success is recorded as "the primary failed for reason X".</li></ul> |
| **CR-02** The models serving production reasoning are below the bar | gpt-oss-120b is primary. The fallback `auto/best-coding` is actually laguna-xs-2.1. `strongRouteModels` is inert because no key is set (`routeProposal.ts:1419-1425`). | Model exam (isolation): gpt-oss 14/30, 0/4 complete plans; fallback 1/30; Claude Opus 28/30. | **ESTABLISHED** in isolation. *Partial*: the 30Q control (Claude Sonnet with Brain's prompt) scored 0/3, so the model alone is not sufficient (see CR-10 and CR-15). | RC14 | Route and critique turns served by a model that passes the commercial-planning exam. The fallback may not reason; it may only fail loudly. | The same prompts served by the exam-passing model reach at least 9/11 on the planning items. Zero reasoning turns are answered by laguna. |
| **CR-03** The critic's veto is unverified | `applyCritique` accepts a drop under any rule label, including citations to findings that do not exist (F999) and drops with no rule. W1b's WINDOW/CAPITAL guard is defeated by any co-rule, and it keeps true violations the route's own figures hide. | E-011: 9/10 recorded critique outcomes unchanged at REF. Controls fail both ways. | **ESTABLISHED** | RC2 | A drop must cite an existing finding or a limit violation that code computes. The code decides what it can compute; an uncomputable objection becomes a research question. | Replay of the 10 recorded critiques: false window drops are overruled, true hidden violations are dropped, and F999 is rejected. |
| **CR-04** Route economics are computed only when the model volunteers the field | The W1c ACQUISITION rule needs `acquisitionCostPerSale`. Acquisition spend is never compared with capital (`parseRoutes`/`routeEconomics`). | E-010: the "445 sales at $38.99 CPA" route is kept. $65,655 of spend against a $5,000 cap is not flagged. | **ESTABLISHED** | RC8 | Economics are derived by code from every route's figures. A missing figure makes the route incomplete, never assumed favourable. | The E-010 constructed and recorded routes are flagged, and the sound control passes. |
| **CR-05** Brain's standing operating rule is injected as text into goal prompts and discovery | <ul><li>The discovery question appends "owner does no physical work … no licence … no hourly positions" beside the lifted focus (W1g partial).</li><li>The `ownerLabourOffer` regex misses 3 of 4 ordinary phrasings.</li><li>The rule is re-implemented in three regex gates (integration diag).</li></ul> | E-014. E0: 4/4 fallback replies invented the owner's refusals. | **ESTABLISHED** (mechanism). Behavioural effect OBSERVED in E0. | RC3 | The goal's constraints are resolved once, from the owner's words plus policy with provenance, and handed to every prompt and gate as data. | Discovery and route prompts for the E-014 owners carry no policy text as owner limits. No invented refusals appear in replies. |
| **CR-06** The objective reader is regex-tuned to the phrasings it has seen, and it misreads silently | <ul><li>`readObjective` (`intent.ts`).</li><li>"Zero budget" is read as no capital limit.</li><li>"Minimal owner involvement" sets no hours limit (Map A #9).</li><li>11 of 14 misses produce no `unread` flag.</li></ul> | E-013: 7/7 tuned classes read correctly, but only 2/12 new paraphrases fully correct. | **ESTABLISHED** | RC15 (W1i overfit) | Every field is read with an explicit read/unread state and a verified reading. Not read means a question to the owner, never "no limit". | A held-out paraphrase set (not the tuning batch) reads at least 95% of fields correctly with zero silent misses. |
| **CR-07** The proposer sees findings chosen by lane and recency, not by relevance to the decision | <ul><li>`findingsOf` caps at 120 (`routeProposal.ts`).</li><li>The DB newest-first limit of 360/600 is applied before selection.</li><li>Contested findings are shown unmarked.</li></ul> | E-012: W1e fixed p10 (0→4/4). Under 400 newer claims, 0 real facts are shown. | **ESTABLISHED** (mechanism). Production magnitude depends on CR-08. | RC4 (partly repaired) | Findings are selected by the decision they bear on: route field and open question. Contested findings are marked. | Under the E-012 noise injection, the decisive facts are still shown and contested ones are labelled. |
| **CR-08** Research supply is starved | <ul><li>Queue FIFO within priority.</li><li>Search refusals of about 70%.</li><li>Firecrawl at 15 credits a day.</li><li>No keyed search provider.</li><li>Worker membership gaps.</li></ul> | RESEARCH-STARVATION (E0): 1/16 fragments completed; 0 relevant facts reached planning. | **SUPPORTED** (E0 measured). E1 status UNKNOWN (Map B). | RC6 | Research capacity is allocated by decision value per goal, and supply is observable per goal. Owner items: a search key. | A fresh goal completes its planned fragments within its window. At least 20 relevant verified facts are read by the plan. |
| **CR-09** There is no shared per-goal working state | <ul><li>Lessons are read only from a 24 h event lookback (E-016).</li><li>The plan verdict, binding factor and committee questions never reach `routeContext`.</li><li>The owner profile is re-derived on every ask.</li><li>Calibration and rethink lessons go to `operator_learnings`, which the planner never reads (Map A #10).</li></ul> | E-016 harness; integration diag §2. | **ESTABLISHED** | RC7 | One durable goal record that every faculty reads first and writes last: owner profile, constraints, chosen strategy, binding factor, open questions, lessons and refuted directions. | A lesson recorded at ask 1 changes ask 3 (+31 h). The committee's question appears in the next ask. |
| **CR-10** Fifteen generators and eighteen selectors run with no arbiter, over project-wide state | <ul><li>Map A G1–G15 and S1–S18.</li><li>The plan reads every opening in the project with no goal filter (`goalScenario.ts:3017`).</li><li>The constructed arrangements (G1) read nothing of the owner (RC13).</li><li>LLM routes reach the plan only as openings on a later pass.</li></ul> | <ul><li>wst_db2e: four "best" answers (integration diag).</li><li>Live $10k goal reading (05:40Z): chosen only_o3, reach 0.97 on ASSUMPTION_ONLY, supported 0, committee FAIL; plan set of 424 candidates, 355 collapsed, 64 double-counted.</li></ul> | **ESTABLISHED** (structure). Behavioural consequence OBSERVED. | RC11, RC13 | One arbiter per goal. Generators submit candidates to it. Strategies are scoped to the goal and its owner. | One chosen strategy is read identically by acceptance, committee, report and operator. No strategy lacks owner provenance. |
| **CR-11** Readiness cannot be reached by research | `judgeAcceptance` needs a p5 reach of at least 90%. A non-accepted reading relabels RECOMMENDABLE as NEEDS_EVIDENCE (Map A #7). The measured success rate stays null until 10 plan outcomes exist. | Code (Map A); BRAIN-FAILURE-DIAGNOSIS-2026-11-17. | **SUPPORTED** (code). Owner-visible effect OBSERVED: every live goal's verdict is NEEDS_EVIDENCE or NOT_VIABLE. | RC12 | Plan readiness is separate from money-commitment approval. | A research-grounded plan reaches an owner-usable state while the money gate stays closed. |
| **CR-12** Brain's own evaluation and observability cannot see the failing path (**concealment cause**) | <ul><li>`planningReliability` feeds given openings to `readGoalPlan` and never runs discovery, research, proposer, critic or models (L-001).</li><li>Evaluation goals pass a userId, which operator goals lack (L-003).</li><li>No `finish_reason` is captured.</li><li>Served-model labels can misreport (L-002).</li><li>A fallback hides the primary's failure (E-015 #4).</li></ul> | L-001, L-002, L-003, E-015 | **ESTABLISHED** | (new) | An end-to-end evaluation from the owner's words to a graded plan, on the production path, recording turn-level facts (served model, finish reason, parse outcome). | Injected faults from E-010–E-016 are detected by the end-to-end suite. |
| **CR-13** A goal the operator creates may never be searched | `operatorTools.ts:1025` passes `userId: null`. `sprintCandidate` requires `createdByUserId`, so `discoveryAllowed` returns NOT_DUE (`routeProposal.ts:1977`). | L-003 (code) | **SUPPORTED** (code). Incidence UNKNOWN (Map B). | (new) | Search eligibility derives from the goal's authorization, not from which door created it. | An operator-created goal in a project without a mode gets route asks and discovery. |
| **CR-14** Buyer identity comes from fuzzy knowledge links | `knowledge/apply.ts` links sentence-fragment buyers to NAICS counts and closes the buyer question. | Integration diag §2 (E0 production view) | **SUPPORTED** | RC10 | A link must name a real segment. Otherwise it is an ESTIMATE that keeps the question open. | Fragment-shaped buyers get an ESTIMATE status. |
| **CR-15** Question generation and scouting anchor on one shape | `directionPrompt` framing. W1f merged. | 30Q: p06/p10 question sets all brokerage or dropshipping. | **SUPPORTED** (E0). E1 not re-tested. | RC5 | Inquiry starts from the owner's means and decision-relevant unknowns, with structurally different mechanisms required. | Fresh goals' question sets include direct owner-paid work and at least 3 distinct mechanisms. |
| **CR-16** Parsers and filters discard silently | <ul><li>A truncated JSON yields `{routes:[],rejected:[]}`; production records only NO_ANSWER, and only if every model fails.</li><li>A reply with one complete route is accepted while the lost routes leave no trace.</li><li>Replacement routes are filed without critique.</li></ul> | E-002, E-010, E-015 | **ESTABLISHED** | RC9 family | Every discard is counted with its reason. An incomplete parse is a failed turn. | A truncation replay records PARSE_INCOMPLETE and the turn is retried. |

## B. Shared causes (one mechanism class appearing in several components)

The rows above are not independent. Four mechanism classes account for most of them:

| class | members | the shared mechanism |
|---|---|---|
| **M1. A model's text is trusted without a contract** | CR-01, CR-03, CR-04, CR-16, and partly CR-02 | Nothing checks a model turn against what it must deliver: completeness, required fields, figures that can be computed, citations that exist. So the weakest or truncated answer decides the outcome. |
| **M2. The owner's facts are read by regex and injected as text, not resolved once as data** | CR-05, CR-06, the CR-09 owner profile, CR-13 (authorization by creation door) | Owner meaning is re-derived in many places, by brittle readers, with policy mixed into owner limits and silent nulls meaning "no limit". |
| **M3. There is no single per-goal state or arbiter** | CR-09, CR-10, CR-11, CR-14 | Faculties write to their own stores and pick their own "best". Nothing consumes a decision another faculty made. |
| **M4. Evaluation and observability do not cover the failing path** | CR-12 (and the missing `finish_reason` in CR-01) | Failures are invisible to Brain's own gates. This class conceals M1–M3. |

Independent of these classes: CR-08 (research supply, an infrastructure/allocation cause) and CR-15 (prompt framing).

## C. Interactions (how the causes compound and conceal)

1. **CR-01 into CR-02.** A truncated or empty primary turn hands reasoning to the fallback model (laguna, 1/30). The "weak model reasoning" observed in E0 traces was largely the fallback's, so CR-02's production magnitude is inflated by CR-01.
2. **CR-08 hides CR-07, CR-03 and CR-04.** With 0 relevant facts delivered, the proposer, critic and economics never faced real evidence in production. Only the supplied-facts experiments (30Q, E-002, E-010–E-012) exposed them. This is the owner's "upstream failure conceals downstream" case, now examined (Section H).
3. **CR-03 and CR-04 amplify each other.** Without computed economics, the critic's figures cannot be checked, and the model's optimistic figures cannot be overruled. One error passes either way.
4. **CR-12 feeds every repair loop (feedback loop).**
   - Repairs are validated on component tests or on the very batch they were tuned on: W1i reads 7/7 tuned classes and 2/12 new phrasings; W1b's guard is defeated by co-rules.
   - So they are declared done while production behaviour is unchanged (E-002).
   - The next evaluation fails again, and a new local repair follows. This is the "isolated bug-fix campaign" pattern the owner named.
5. **CR-10 with CR-09.** Even a correct LLM route enters only as one opening among project-wide constructed arrangements that read nothing of the owner. The selector then ranks by deterministic reach, often ASSUMPTION_ONLY (live $10k reading). Good reasoning upstream can be outvoted downstream.
6. **CR-13 with CR-12.** Every evaluation goal is created with a user, so evaluation results do not represent operator-created production goals.

## D. Refuted or corrected prior conclusions

- **REFUTED:** "Empty gpt-oss replies are the proxy idle cut (repaired W1j)" (C23-M, RC1 text). Empty bodies arrived with no error before 100 s (E-001).
- **CORRECTED:** "W1a–W1j MERGED_PENDING_PRODUCTION" read as near-complete.
  - In deterministic replay, W1b, W1c, W1g, W1h and W1i change little or none of the recorded behaviour (E-010–E-016).
  - The one E1 production replay (E-002) still produced no plan.
- **CORRECTED:** RC14 "No prompt or software repair raises a model past its own ceiling" is true, but it is not sufficient.
  - The 30Q control with a strong model inside Brain's prompt and machinery gave 0/3 usable.
  - So the model gap and Brain's machinery are jointly causal (C07-M marked INCOMPLETE).

## E. Remaining uncertainty attached to causes

See `UNCERTAINTY.md`.

## F. Additions from Gate A (independent coverage review, reviews/GATE-A.md). Status pending Map A's response.

| new / extended | Gate A finding | effect on register |
|---|---|---|
| CR-08 gains a **competing explanation** | GA-02: the Russell judgment between a goal round and its launch can end the round as `answeredByArchive`, or refuse it at `compileMission` (russell/loop.ts:1965-1986; planning.ts:404-470). | Research starvation may be partly *research never launched*, not only *launched and unexecuted*. A distinguishing observation is needed: per-goal judgment outcomes (U-13). |
| CR-05 extended | GA-18: arrangements are screened without the owner-labour argument (goalScenario.ts:1883; construct.ts:1346, 1746). Only openings honour the offer. | One more place where the standing rule overrides the owner's offer (M2). |
| CR-13 extended | GA-19: any existing `cash_modes` row, including WINDING_DOWN or ARCHIVED, blocks reactivation (goalSprint.ts:104-107), and the launch gate then refuses discovery. | A second path to a goal never being searched. |
| CR-09 extended | GA-13: owner-recorded construction facts carry `workstream_id`, and `construct.ts` reads only `workstream_id IS NULL`. | The owner's own evidence never reaches the cash plan (M2/M3). |
| CR-10 extended | GA-09: `buildPlanSet` is a second "best" ranking persisted in the forecast. GA-01: a model challenge inside `optimizePortfolio` can replace `portfolio.best` and withdraw the 90% claim on every read. | There are at least two more selectors, one of them model-driven. CR-01/CR-02 apply to this call site too. |
| CR-16 extended | GA-24: a reply whose routes all failed the rules (routes=0, rejected>0) ends the model fallback chain (routeProposal.ts:2095-2110). | One weak model's rule-rejected reply ends the ask. |
| new CR-17 (SUPPORTED, code) | GA-03/GA-29: `changeObjective` keeps the old links and does not make routes due (up to 6 h). `planInputsFingerprint` ignores knowledge and world-model facts, library verdicts and person facts, so a goal held NOT_SUPPORTED stays stuck through those changes. | Change propagation (Map C Q-R009) fails. The owner's goal changes are not acted on promptly, and the plan does not re-read when relevant evidence changes. |

## G. Corrections from Gate B (independent diagnostic-validity review, reviews/GATE-B.md). These supersede the rows above where they conflict.

- **CR-01.** Statuses:
  - ESTABLISHED: Brain accepts incomplete turns and cannot tell a length stop, a reasoning-only reply, a stream drop or a stream error apart. Evidence: `readStream:166` erases the error when partial content arrived, `askModel` drops `completionTokens`, and no `finish_reason` is read. The E0 empties were not the idle cut.
  - SUPPORTED only: the reasoning-budget explanation (H1b) for the E0 empties.
  - NOT SEPARATED: E-002's E1 truncation, between a budget stop and a stream drop or reset.
  - NOT EXCLUDED: H1c, the answer placed in the reasoning field.
  - The separating experiment is GATE-B.md §2 (U-01). The correction class therefore has to cover both turn completeness and stream-error surfacing; it cannot be "raise the budget" alone.
- **CR-03.** Two claims change status:
  - **Withdrawn** as defects: "true WINDOW/CAPITAL violations kept". The critic is instructed to REPAIR a disputed figure (W1b). Whether a live critic does repair is an **untested** critic-compliance question.
  - **ESTABLISHED, unchanged**: a drop citing a non-existent finding (F999) or no rule at all is accepted; a co-rule defeats the WINDOW-only guard; the recorded false drops still drop.
- **CR-04.** The "spend over capital not caught" injection has no defined correct answer, because no rule says whether acquisition spend is bounded by capital or recycled from proceeds (GB-60s).
  - Restated: **the requirement itself is unspecified**. Map C Q-R042 (cash-flow timeline and peak capital) has no implementation.
  - ESTABLISHED, unchanged: the W1c rule fires only when the model fills the new field.
- **CR-06.** Window misses are refused loudly (correct behaviour). Capital misses become "no capital limit".
  - **Amount misses silently create a goal with no target** (GB-G). This is a stronger and separate defect.
  - The production `objectiveAssist` second-read path remains untested.
- **CR-07.** The newest-first DB-limit claim (E-012 F3) is simulated, not executed through `projectEvidenceClaims`. Status SUPPORTED, pending that execution.
- **Register.**
  - Regenerated after fixing GB-48/49/50, with 4 more overrides.
  - New counts: 88 recheck-after-change, 73 unverified, 41 incomplete, 16 reusable.
  - The C23-M override is now INCOMPLETE (confounded) rather than CONTRADICTED. The map's idle-cut attribution remains contradicted, recorded in the note.
  - 14 questions carry a `spec_defect`: the test as written cannot detect its intended failure.

**Diagnostic validity (Gate B).**
- VERIFIED_DIAGNOSTIC: E-012 delivery and dedupe, E-013 (objective reader), E-014, E-015, E-016, L-001.
- PARTIAL: E-001, E-002, E-010, E-011, E-012 F3.
- INVALID: none.
- All harness outputs re-ran byte-identically.

## H. Separating probe E-017 (finish_reason recorded on production, run 45774422897)

- **CR-01** upstream mechanism: **ESTABLISHED for truncation.**
  - At the production budget of 4,000 tokens: `finish_reason: length`, 4,000/4,000 completion tokens, 11k characters of reasoning, `[DONE]` received, no error, the answer cut off mid-route.
  - The same prompt completes at 16,000 tokens (5,046 used) and with low reasoning effort at 4,000 (1,384 used).
  - A stream drop and H1c are excluded for this sample. The E0 empties remain SUPPORTED, consistent with the same mechanism.
  - This supersedes G's "NOT SEPARATED" for E-002.
- **CR-16**: the partial loss is reproduced on production. A truncated reply parsed to 2 routes and the third left no record.
- **New interaction (I-W1e×CR-01).** The W1e repair delivers 105 findings instead of 40, which makes a 9k-token prompt and a longer reasoning chain under the unchanged budget. The repair raised the truncation incidence. This is a repair-induced amplification and belongs in the graph.

## I. Corrections from Gate C (independent causal review, reviews/GATE-C.md, verdict NOT SUFFICIENT) and Map B (maps/B). These supersede every earlier row where they conflict.

| finding | correction applied |
|---|---|
| GC-01 | **CR-02** is downgraded to SUPPORTED as a cause of the production outcome. It stays ESTABLISHED only in isolation (the model exam). The 30Q strong-model control (0/3) was confounded by the pre-W1g standing rule (CR-05) and by missing facts (p10 category A). It ran no critic, arbiter or plan reading. "Model and machinery are jointly causal" is therefore **UNRESOLVED (U-05)**, and the CR-10 reference is withdrawn from section D. |
| GC-02 | **Every goal plan reading is E0.** The readings run 01:31–05:43Z, before the a8c4699 deploy at 05:41–05:50Z. Since then every goal is PAUSED by the owner's override (B-O001), and a paused goal gets no route asks (`routeProposal.ts:1944`). **Plan behaviour on PROD a8c4699 is unobserved for every live goal.** The word "live" in CR-10, GRAPH and elsewhere means E0. |
| GC-03 + Map B | **New row CR-18: goal research is parked for a person or routed to an empty pool** (SUPPORTED). The outcome on wst_7b4f (NEEDS_EVIDENCE, committee FAIL, supportedReach 0) is explained by unresearched legs, not by the selector. The committee FAIL is a correct block on unresearched volume. Evidence: 13 of 15 bins NEEDS_HUMAN at 0/5 attempts; research attempts read 18 researched, 0 authorized, 0 executed; DEADLINE-ceiling requests open since October (Gate C). Every plan's only step names Claude routines, whose pool shows 0 waiting and 0 running (B-O048). 47 fragments are QUEUED with 0 LEASED (B-O017). The pipeline shows 0 qualified and 0 strategies constructed in the hour (B-O044). The mechanism (why bins go to NEEDS_HUMAN, why routines receive nothing, the judgment and compile outcomes) is **UNRESOLVED (U-13, U-14)**. **CR-10 and CR-11 are withdrawn as the explanation of this outcome**: acceptance refuses unpriced legs whatever the selector. |
| GC-04 | **CR-10's behavioural evidence is replaced.** "Generic constructed strategy chosen" was never observed; every chosen candidate is a `cop_` opening, and the 0.97 is the headline combination, not the chosen candidate (0.204). The new evidence (E0): different goals in one project, with different targets, receive the identical candidate (two pairs, Gate C). One reading holds up to four different "best" strategies in 5 of 6 goals (B-O020, B-O024, B-O029). A **separate node** is added: headline and committee figures inflated by unpriced or absurd quantities (B-O026: $412,920 "proven" against $0 supported). |
| GC-05 | Edge corrected. "Primary empty or truncated" leads to the fallback (the working path, measured 6/12 in E0). "Partial turn accepted" **ends the chain** (E-002, E-017 arm A). The phrase "largely the fallback's" is replaced by 6/12. |
| GC-06 | The `readStream` error erasure was **introduced by W1j** (commit 56f2699), the repair for the refuted idle-cut cause. It is a concealment path, not the demonstrated cause of E-002, and it is evidence for the CR-12 repair loop. E0 and E1 truncations ran different code paths (U-01 note). |
| GC-07 | **Shared classes revised.** **M1a, turn integrity**: CR-01 and CR-16, one correction (a turn contract). **M1b, deterministic verification of model claims**: CR-03 and CR-04. It depends on a specification that does not yet exist (Q-R042, the cash-flow and peak-capital rule). **M2**: CR-05, CR-06, owner profile (CR-09). CR-13 is removed. **M3**: CR-09, CR-10. CR-11, CR-13 and CR-14 are listed as **independent causes**. |
| GC-08 | The supply-to-CR-07 edge is corrected. **CR-08 masks CR-07; fixing CR-08 amplifies CR-07** (more claims, harder recency cut). Findings are read project-wide, a goal-isolation gap added to CR-07. |
| GC-11 | **CR-12** stays ESTABLISHED only for "the acceptance gate and post-merge verification are blind to the failing path". The repair feedback loop is **SUPPORTED**, with evidence from W1i (E-013) and W1j (GC-06). The L-002 label misreport is SUPPORTED. |
| GC-12 | **CR-13**: observed contribution **0, pending U-03**. Its graph edge is hypothetical. |
| GC-13 | **CR-11** is restated: the readiness bar *is* the money-commitment confidence bar, and NEEDS_EVIDENCE covers both. It stays SUPPORTED, with its contribution to the observed outcome undemonstrated. |
| GC-14 | **New row CR-19: constraint provenance on live goals is untraced** (OBSERVED SYMPTOM). wst_7b4f's 0 owner hours and $3,000 capital are not stated in the owner's words, and the reader's own rule would give $1,000. The source (createGoal reading, objectiveAssist, terms PATCH or policy) is **UNRESOLVED (U-15)**. |
| GC-15, GC-16 | CR-04's correction depends on a required-field contract and the Q-R042 specification. In CR-03, the F999 and ruleless drops are labelled **vulnerability, not an observed cause**. The co-rule defeat stays ESTABLISHED. |
| GC-17, GC-19, GC-21 | X_REPEAT and the CR-14→bad-math edge are **hypothetical**. CR-14 is re-routed to the headline-inflation node (U-08). "strongRouteModels inert" is SUPPORTED pending U-07. |
| GC-22 | **I-W1e×CR-01 is downgraded to SUSPECTED and withdrawn from the graph.** Pre-repair data shows 3/6 empties at 40 findings and 3/6 at 79–126, and the pre-repair 105-finding prompt also came back empty. The decisive test (arm A at 40 vs 105 findings, n≥5) was not run. |
| GC-23 | **H1b is ESTABLISHED as operating on PROD for the E-002 prompt (n=1 per arm).** E-002's own reply is SUPPORTED-consistent, and the E0 empties are SUPPORTED. "No record" for the lost route cites the code (`routeProposal.ts:2099-2108`), not a production record. |

### Status table after Gates A, B and C (authoritative)

| id | status | contribution to the observed outcome |
|---|---|---|
| CR-01 turn completeness (M1a) | ESTABLISHED (acceptance defect; H1b budget mechanism on PROD, n=1) | E0 evaluation failures; E1 probe (E-002) |
| CR-02 model ceiling | ESTABLISHED in isolation; SUPPORTED as production cause | model and machinery share UNRESOLVED (U-05) |
| CR-03 critic veto (M1b) | ESTABLISHED (co-rule defeat, recorded false drops still drop); F999 is a vulnerability | E0 p02 |
| CR-04 economics (M1b) | ESTABLISHED (field-conditional rule); requirement unspecified (Q-R042) | E-010 |
| CR-05 standing rule as text (M2) | ESTABLISHED mechanism; E0 behaviour observed | E0 fallback replies |
| CR-06 objective reader (M2) | ESTABLISHED (silent misreads; amount miss gives a goal with no target) | E-013 |
| CR-07 findings selection | ESTABLISHED mechanism (project-wide, recency); masked by CR-08 | latent |
| CR-08 research supply | SUPPORTED (E0); E1 queue 47 queued / 0 leased (B-O017) | major, mechanism shared with CR-18 |
| CR-09 per-goal state (M3) | ESTABLISHED | E-016 |
| CR-10 no arbiter (M3) | ESTABLISHED (structure); E0 behaviour: identical candidates across goals, four "bests" | not the cause of the wst_7b4f verdict |
| CR-11 readiness = commitment bar | SUPPORTED; contribution undemonstrated | — |
| CR-12 evaluation blind | ESTABLISHED (gate); loop SUPPORTED | concealment |
| CR-13 operator goals unsearched | SUPPORTED (code); incidence 0 observed | — |
| CR-14 fuzzy buyer links | SUPPORTED; B-O050 observed E0 | headline inflation (hypothetical edge) |
| CR-15 question anchoring | SUPPORTED (E0) | E0 30Q |
| CR-16 silent discard (M1a) | ESTABLISHED | E-002, E-017 |
| CR-17 (Gate A) | as recorded in F | — |
| **CR-18 research parked / routed to empty pool** | **SUPPORTED** (observed); mechanism UNRESOLVED | **explains the live goals' NEEDS_EVIDENCE / supportedReach 0 (E0)** |
| **CR-19 constraint provenance** | OBSERVED SYMPTOM; UNRESOLVED | — |
