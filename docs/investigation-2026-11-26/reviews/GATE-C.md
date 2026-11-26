# Gate C: independent causal-explanation review

**Reviewer:** Gate C. I did not author the register, the graph, the blueprint, the maps or the experiments.
**Scope:** `ROOT-CAUSES.md` (section G overrides earlier rows where they conflict), `GRAPH.md` and `REPAIR-BLUEPRINT.md`, checked against primary evidence: source at REF, the raw production readings in `maps/B/raw/`, the 30Q artefacts, the experiment raw outputs and git history.
**Method:** I opened every file:line I cite below. I did not re-run the E-010..E-016 harnesses, because Gate B re-ran them byte-identically and none of my findings depends on their outputs beyond what Gate B confirmed. My new evidence comes from four sources: the six raw production plan readings, the 30Q control prompts and grades, `git log -S`, and (added late, at the coordinator's request) E-017's raw output `experiments/raw/E-017/eval.txt` together with the probe code in `scripts/planningEval.ts:717-810`, tabulated against the 19 recorded replies in `experiments/raw/E-010/probes.json`.
**Constraints kept:** no source, production, database or experiment changes; no production or model calls.
**Machine-readable findings:** `reviews/gate_c_findings.json` (23 findings: 4 critical, 11 major, 8 minor).

## Verdict: NOT SUFFICIENT (v1)

The explanation of the **evaluation** outcome (0/12 usable plans in 30Q and dec1125c) is largely sound once GC-01 is corrected. The explanation of the **live goal** outcome is not. On the $10k goal, NEEDS_EVIDENCE, committee FAIL and supportedReach 0 are attributed to CR-10 and CR-11, but:

- the reading is E0, not live E1 (GC-02);
- the mechanism visible in the reading is different (GC-03);
- the goal's own research record, which holds the most direct explanation, is not in the register at all (GC-03).

Separately, the register's correction to RC14 rests on a strong-model control that is confounded by CR-05 and that never exercised the CR-10 machinery it is cited for (GC-01). The blueprint also omits two causes and orders its proofs so that unfixed upstream causes conceal their effect (GC-09, GC-10).

**What it takes to reach SUFFICIENT WITH CORRECTIONS:**
- resolve GC-01 to GC-04 (critical);
- apply the status and edge changes in the tables below.

Only GC-03 needs new evidence: a read-only, per-goal research trace for `wst_7b4f…`.

## 1. Per-cause review

| id | lead status (after G) | Gate C status | causal claim demonstrated? | finding |
|---|---|---|---|---|
| CR-01 | ESTABLISHED (acceptance defect). Section H: upstream mechanism ESTABLISHED for truncation | **Acceptance defect: ESTABLISHED. Upstream budget exhaustion: ESTABLISHED as operating on PROD a8c4699 for the E-002 prompt (n=1 per arm). E-002's own reply: SUPPORTED (consistent), not separated. E0 empties: SUPPORTED, now strongly** | <ul><li>Yes. The raw E-017 data: arm A `finish_reason:["length"]`, completion 4000/4000, `sawDone:true`, `errors:[]`, maxGap 1.98 s, `parsedRoutes:2`. Arm B completes (`stop`, 5046 tokens). Arm C completes (`stop`, 1384 tokens).</li><li>The probe uses the production system prompt (identical to `routeProposal.ts:1815-1816`), the real `routeContext`/`routePrompt`, the production temperature 0.3 (`modelBench.ts:90`) and the real `parseRoutes`.</li><li>Code: `modelBench.ts:166`, `:169`; `routeProposal.ts:1436-1447`.</li></ul> | <ul><li>Section H overreaches in saying it "supersedes NOT SEPARATED for E-002". E-017 is a new sample, not E-002's reply (GC-23).</li><li>The W1e × CR-01 interaction in section H is contradicted by E0 data (GC-22).</li><li>The error erasure was **introduced by W1j** (`56f2699`). It did not operate in E-017's sample, so it is a concealment path, not E-002's demonstrated cause (GC-06).</li><li>The edge CR-01 ⇒ MOD is misattributed (GC-05).</li></ul> |
| CR-02 | ESTABLISHED in isolation | **ESTABLISHED as a capability measurement; SUPPORTED as a cause of the production outcome** | Not as a production cause: the exam used its own prompts, and the only in-Brain counterfactual (the 30Q control) is confounded (GC-01). "Inert because no key is set" is a production-configuration claim that was never observed (U-07; GC-21). | GC-01, GC-21 |
| CR-03 | ESTABLISHED (co-rule defeat, F999) | **ESTABLISHED for the co-rule defeat on recorded drops** (`routeProposal.ts:1268`). F999 and the ruleless DROP are an **injected vulnerability, not an observed cause** | Partly. The recorded harm (p02 final, p10 Printful) is misreadings with WINDOW plus a co-rule. No recorded critique cites a non-existent finding. | GC-16 |
| CR-04 | ESTABLISHED (W1c fires only with the field); requirement unspecified | **ESTABLISHED (narrow)** | Yes, for the narrow claim. The correction class "derived by code from every route's figures" cannot derive a CPA the route does not state. It needs a required-field contract (M1a) **and** the unspecified cash-flow requirement (Q-R042). | GC-07, GC-15 |
| CR-05 | ESTABLISHED (mechanism); OBSERVED (E0 behaviour) | **ESTABLISHED (mechanism); OBSERVED E0; under-used** | <ul><li>The behavioural effect is more widely evidenced than the register says. The 30Q control prompts carry the standing rule *and* the lift together (GC-01).</li><li>On the live $10k goal, "0 owner hours in every tested case" kills 4 of 8 strategies for an owner whose words state no hours (GC-14).</li></ul> | GC-01, GC-14 |
| CR-06 | ESTABLISHED; amount misses silent (GB-G) | **ESTABLISHED (mechanism, constructed set)**; contribution to observed failures **UNRESOLVED** | The mechanism is yes. No observed failing goal is shown to have been misread: the 3 dec1125c classes read correctly. The live goal's $3,000 cap and 0 hours have untraced provenance (GC-14). | GC-14 |
| CR-07 | ESTABLISHED for `findingsOf`; DB cut SUPPORTED | **ESTABLISHED (`findingsOf`, 30Q category C 3/12); SUPPORTED (DB recency cut)** | Yes, for the cap. The graph's INF → CR-07 is the wrong edge type and direction (GC-08). Findings are also project-scoped (`routeProposal.ts:1595`), which is not in the register. **No blueprint stage repairs CR-07** (GC-09). | GC-08, GC-09 |
| CR-08 | SUPPORTED (E0); competing explanation GA-02 | **SUPPORTED (E0, on eval goals only)** | <ul><li>Measured on dec1125c eval goals (RESEARCH-STARVATION Part 1), not on the live goal.</li><li>The live goal has a third, unlisted competing explanation: research bins parked NEEDS_HUMAN at 0/5 attempts, and 6 unanswered DEADLINE-ceiling requests (GC-03).</li></ul> | GC-03 |
| CR-09 | ESTABLISHED | **ESTABLISHED (mechanism: E-016, `routeProposal.ts:1946`)** | Mechanism yes. The consequence node X_REPEAT ("same mistake each ask") is not observed in production. | GC-17 |
| CR-10 | ESTABLISHED (structure); OBSERVED (consequence) | **ESTABLISHED (project-wide opening read, `goalScenario.ts:3009`), with replaced evidence. "Generic constructed strategy chosen" is NOT OBSERVED** | <ul><li>The cited live evidence is E0 and conflated: 0.97 is `portfolio.best.reach` (`plan.ts:5305`), while the candidate's reach is 0.204.</li><li>Uncited but stronger evidence: two pairs of goals with very different objectives choose identical candidates (GC-04).</li><li>Not shown to cause NEEDS_EVIDENCE (GC-03).</li></ul> | GC-02, GC-03, GC-04 |
| CR-11 | SUPPORTED (code) | **SUPPORTED, restated** | <ul><li>"Cannot be reached by research" is overstated: the EVIDENCED_PORTFOLIO path accepts on evidence (`plan.ts:1809-1835`).</li><li>Masked on the live goal: with supportedReach 0, no relaxation of the gate yields a usable plan.</li></ul> | GC-13 |
| CR-12 | ESTABLISHED (concealment) | **ESTABLISHED for L-001 scope (gate blind). SUPPORTED for the repair loop. L-002 sub-claim SUPPORTED** | <ul><li>The ad-hoc 30Q and `planningEval` runs *did* see M1–M3; they are this investigation's evidence. So "conceals all M1–M3" is true only of the acceptance gate and of post-merge verification.</li><li>W1 is labelled MERGED_PENDING_PRODUCTION, not done (`PLANNING-FAILURE-MAP.md:619-633`).</li></ul> | GC-11 |
| CR-13 | SUPPORTED (code); incidence UNKNOWN | **SUPPORTED (code); observed contribution 0** | Eval goals pass a userId (`scripts/planningEval.ts:109`), and the live $10k goal holds route-proposal openings, so CR-13 explains none of the observed failures. It is grouped under M2 wrongly. | GC-07, GC-12 |
| CR-14 | SUPPORTED | **SUPPORTED (mechanism); path to the outcome not shown** | It feeds arrangements only (INTEGRATION-DIAGNOSIS:33). No reading chose an arrangement, and the live leg's causes include NO_BUYER, so the question was not falsely closed there. | GC-19 |
| CR-15 | SUPPORTED (E0) | **SUPPORTED (E0)** | It is the main explanation for p06 (category A, upstream), and it also confounds the control (GC-01). | — |
| CR-16 | ESTABLISHED; section H: partial loss reproduced on production | **ESTABLISHED** | <ul><li>Yes (E-002, E-010; `routeProposal.ts:2099-2108`).</li><li>E-017 arm A: a `length`-stopped reply parses to 2 routes; its `contentTail` ends inside a third route.</li><li>"The third left no record" is established by code reading (the chain accepts at least 1 route), not by a production record: the probe calls only `parseRoutes`.</li></ul> | GC-23 |
| CR-17 | SUPPORTED (code) | **SUPPORTED (code)** | Mechanism only. It is **absent from the graph and the blueprint** (GC-09, GC-20). | GC-09, GC-20 |

## 1a. E-017 and ROOT-CAUSES section H (judged from `raw/E-017/eval.txt`)

1. **The write-up matches the raw file on every figure.**
   - Prompt: 9,010 prompt tokens, 35,437 chars, 105 findings.
   - Arm A: 41,090 ms; content 4,085 chars, reasoning 11,112.
   - Arm B: 5,046 tokens.
   - Arm C: 1,384 tokens.
   - `thinkTagInContent:false` everywhere and `trailing_buffer_chars:0`.

   I found no misreport.
2. **Separation is valid for this sample.**
   - Only `max_tokens` and `reasoning_effort` vary. The prompt, model and server are held constant.
   - The probe bypasses `chatFor`/`readStream` (it uses raw `fetch`), so it sees exactly what they discard.
   - The arms are not the same draw (temperature 0.3, n=1), so "the budget is the variable" holds as a single paired observation, not as a rate.
3. **E-002 is not thereby separated.**
   - E-002 took 80.5 s for 2,103 chars. Arm A took 41 s for 4,085 chars of the same prompt.
   - The sample shows the length mechanism *operates*. It does not identify the mechanism of E-002's own reply, which is consistent with it but not separated from it.
   - Status for E-002: SUPPORTED, strongly (GC-23).
4. **The W1e × CR-01 "repair-induced amplification" is not supported, and E0 data contradict it.**
   - In the 18 recorded E0 replies (`raw/E-010/probes.json`), gpt-oss returned empty content on:
     - 3 of 6 asks with 40 findings (final_p02_cap, final_p06_cap, probe1_p10_cap);
     - 3 of 6 asks with 79–126 findings (final_p02_all, final_p10_all, probe1_p06_all).
   - final_p02_all at E0 had the *same* 105 findings and a 35,040-char prompt as E-017, and returned empty.
   - So budget exhaustion at 4,000 tokens was present at the same rate on 40-finding prompts before W1e.
   - E-017 ran no 40-finding arm, so the counterfactual the interaction needs was never measured.
   - The E0 "empty" versus E1 "truncated" difference has an unexcluded competing explanation: W1j moved the path from non-streamed to streamed (GC-06), and n is 1 at E1.
   - Correct status: SUSPECTED. It must not enter the graph as a demonstrated edge (GC-22).
5. **Effect on the blueprint.**
   - U-01 is resolved enough to set Stage 1's parameters: treat `length` as a failed turn, and use an adequate budget.
   - Arm C ("effort low") completed, but nobody graded its routes. Lowering reasoning effort is an untested quality trade, not a proven correction.
   - The 2× empty retry (`routeProposal.ts:1444`) never fires on partial content, so it does not cover arm A's case.

## 2. Shared classes: genuine or thematic?

| class | verdict | reason |
|---|---|---|
| M1 | **Partly thematic. Split it.** | <ul><li>**M1a, turn integrity** (CR-01, CR-16, GA-24) is genuine: one completion and parse contract removes all of them.</li><li>**M1b, deterministic verification of model claims** (CR-03, CR-04) needs computed economics and a cash-timing model (Q-R042), and Gate B shows that model's requirement is unspecified. A turn contract does not remove M1b.</li><li>CR-03's correction also depends on CR-04's computed figures.</li></ul> |
| M2 | **Genuine for CR-05 and CR-06 (and the CR-09 owner profile). Not genuine for CR-13.** | CR-13 is search eligibility derived from the creating door (`goalSprint.ts:67`, `lifecycle.ts:520-541`). A resolved owner and constraint record does not touch it. |
| M3 | **Genuine for CR-09 and CR-10. Thematic for CR-11 and CR-14.** | <ul><li>CR-11 is an acceptance-policy threshold (`plan.ts:1648ff`).</li><li>CR-14 is knowledge-link quality in `knowledge/apply.ts`.</li><li>Neither is removed by a goal record or an arbiter.</li></ul> |
| M4 | **Genuine as a concealment class**, with its scope corrected (GC-11). | The served-model mislabel (L-002) belongs here too, and is SUPPORTED. |

## 3. Graph edge findings

| edge | finding |
|---|---|
| `CR01 ==> MOD` ("hands reasoning to laguna") | **Misattributed.** Handoff to the fallback is the *working* path: empty or error, then 2× retry, then the next model (E-015 ✓). CR-01 acts the other way: a truncated reply with at least one complete route, or with all routes rule-rejected, **ends** the chain (`routeProposal.ts:2099-2108`). The cause of the handoff is the primary's failure (U-01, unresolved) plus an unqualified fallback. "Largely the fallback's" is also overstated: the 30Q measured 6/12. (GC-05) |
| `INF --> CR07` | **Wrong type and direction.** CR-07's mechanism is independent of supply, and more supply makes the newest-first cut worse (E-012 noise). It should read: CR-08 masks CR-07, and fixing CR-08 amplifies it. (GC-08) |
| `M2 --> CR13`, `M3 --> CR11`, `M3 --> CR14` | Class membership is not genuine (section 2). (GC-07) |
| `CR13 --> CAP_DISC --> X_NOROUTE --> FINAL` | **No incidence evidence.** Mark it hypothetical. (GC-12) |
| `CR10 --> CAP_SELECT --> X_GENERIC` | **The node is not observed.** All six readings chose `cop_` openings (sources STRATEGY or QUANT_PORTFOLIO); none chose an `arr_`. Replace X_GENERIC with "different goals in one project get the same candidate" (GC-04). Constructed arrangements do inflate the **headline** best-combination reach (unpriced `arr_` members in shortfalls), and that needs its own node. |
| `CR10 --> CAP_PLAN --> X_NOSTEPS` | **No demonstrated path.** Every reading has exactly 1 research step because its legs lack links (`causes`: VOLUME_UNRESEARCHED, NO_BUYER, …). That is a consequence of missing evidence. Whether the step renderer could produce an executable plan from a complete chain is untested. |
| `CR14 --> CAP_BUYER --> X_BADMATH` | No demonstrated path to the outcome (GC-19). |
| `CR09 --> CAP_STATE --> X_REPEAT` | X_REPEAT is not observed in production (GC-17). |
| `CR12 -.-> FINAL` ("conceals all M1-M3") | Overstated: it conceals from the gate and from post-merge verification, not from end-to-end probes (GC-11). |
| proposed `W1e ==> CR-01` (section H) | **Reject as a demonstrated edge.** The E0 empty rate was the same at 40 and at more than 79 findings (GC-22). Record it as SUSPECTED. |
| `FINAL ==> LOOP ==> FINAL` | **Supported, and the best evidence is missing from it.** W1j's streaming repair for a refuted cause introduced the `readStream` error erasure (GC-06). That is the demonstrated instance of "repair declared, new failure introduced". |
| `X_NOFACTS -.-> CR03/CR04/CR07` | Supported: the supplied-facts arms exposed each one. |
| `CR04 <==> CR03` | Supported by code reading only. Acceptable as an amplification edge. |

**Failures missing from the graph:**
- CR-17 (change propagation, fingerprint).
- GA-18 (arrangements screened without the labour offer).
- GA-01 (model challenge in `optimizePortfolio`, a CR-01/CR-02 call site on every plan read).
- GA-24 (a rule-rejected reply ends the chain).
- Project-scoped **findings** (`projectEvidenceClaims(projectId)`, `routeProposal.ts:1595`; Map C Q-R010 has no capability).
- The repair-introduced `readStream` erasure (W1j).
- The live goal's research parking: 13 of 15 listed bins NEEDS_HUMAN at 0/5 attempts, 2 exhausted, and 6 open DEADLINE-ceiling requests.

## 4. Repair blueprint versus the graph

1. **Two causes have no stage.**
   - CR-07 (findings by relevance) appears in no stage.
   - CR-17 appears in no stage.
   - GA-01 is a model call site that Stage 1's turn contract does not name.

   (GC-09)
2. **The order of proofs contradicts the concealment edges.**
   - Stages 1 and 3 claim a "Stage-0 evaluation, delta measured" on the production path.
   - Stage 4 (supply, and the model owner item) is "parallel".
   - Per the graph, unfixed CR-08 conceals CR-03, CR-04 and CR-07.
   - With an unfixed CR-02 (gpt-oss empty 50%, fallback 1/30), a loud-failing turn contract produces *more* NO_ANSWER outcomes.
   - So the end-to-end deltas of Stages 1–3 will read near zero whether or not those stages are correct.
   - **Fix:** Stage 0 needs a factorial design: production supply versus supplied verified facts, and production model versus an exam-passing model. Alternatively, Stage 4 must land before the end-to-end proofs of Stages 1–3.

   (GC-10)
3. **The M1b proof depends on a requirement nobody has specified.**
   - Stage 1's "acquisition spend against capital" proof has no correct answer until Q-R042 is specified (Gate B GB-60s).

   (GC-07, GC-15)
4. **The Stage 4 rationale rests on the confounded control.** "A strong model alone gives 0/3" is cited as the reason the model is not sufficient. That reading is confounded (GC-01). U-05 must be run with the post-W1g prompt before the model item's priority is set.
5. **Stage 3 will not change the live goal's outcome.** Stage 3's single arbiter will not change NEEDS_EVIDENCE on the live goal while its legs have no supported evidence (GC-03).

## 5. Unexplained outcomes

1. **Why the live $10k goal's own research did not complete.**
   - 25 bins; of the 15 listed, 13 are NEEDS_HUMAN at 0/5 attempts and 2 are exhausted at 5/5.
   - planSet attempts: researched 18, authorized 0, executed 0.
   - 6 requests "Raising the research goal's DEADLINE ceiling" have been open since 2026-10-18, each marked "the card names no mission".
   - None of these is in any CR row.
2. **Why a goal to "collect $10,000 in 30 days using little up-front capital" plans around "Lead-Safe Certification Booking Broker".** A plausible cause is project-wide findings and openings in a project shared with three research goals, but it is untested.
3. **Where the live goal's constraints come from.**
   - "3000 USD the owner said this goal may commit": the reader's LITTLE_CAPITAL rule would give $1,000 (`intent.ts:899-922`).
   - "0 owner hours … in every tested case": the owner's words state no hours.
   - Both constraints kill strategies.
4. **The PROD a8c4699 plan behaviour is unobserved.**
   - All six readings are 02:05–05:43Z (E0).
   - Every goal is now PAUSED by the owner's priority override, and a paused goal gets no route asks (`routeProposal.ts:1944`).
5. **"Brain was too busy to derive the goal this run"** appears on all ten goals at 06:34Z. The interaction with DB contention is listed as untested, but it is now an observed symptom.

## 6. Required corrections (summary; details in JSON)

| # | correction |
|---|---|
| GC-01 | Restate D-CORRECTED (RC14), CR-02 "partial" and GRAPH reading 1: the control is confounded by CR-05 and the fact gaps, and it never ran CR-10. Downgrade CR-02 as a production cause to SUPPORTED. |
| GC-02 | Tag every live reading E0. State that no E1 plan reading exists. |
| GC-03 | Add a per-goal research trace for `wst_7b4f…`. Add an UNRESOLVED row for research parking (NEEDS_HUMAN, ceiling requests). Re-attribute the live outcome. |
| GC-04 | Replace CR-10's evidence with the identical-candidate pairs. Drop X_GENERIC. |
| GC-05, GC-06 | Re-draw the fallback edge. Record W1j as having introduced the erasure, both as a cause and as loop evidence. |
| GC-07 | Split M1. Remove CR-13 from M2, and CR-11 and CR-14 from M3. |
| GC-08 | Correct INF → CR-07. Add project-scoped findings. |
| GC-09, GC-10 | Add CR-07, CR-17 and GA-01 to the blueprint. Make the Stage 0 evaluation factorial, or reorder the stages. |
| GC-11 to GC-21 | The status and edge corrections listed in the JSON. |
| GC-22, GC-23 (E-017 and section H) | Downgrade I-W1e × CR-01 to SUSPECTED; it is contradicted by the equal E0 empty rate at 40 and at more than 79 findings. Word E-017 as "H1b operates on PROD for this prompt (n=1)", not as a re-separation of E-002. |
