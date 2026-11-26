# Brain V5 causal investigation: diagnostic dashboard (2026-11-26)

**Verdict: DIAGNOSIS PARTIALLY COMPLETE.**
- The major failure landscape is mapped, reviewed by three independent gates, and organized for repair planning.
- The landscape is *not* complete. Plan behaviour on the deployed revision is unobserved (every goal is paused), and the mechanism that best explains the live goals' outcome (CR-18) is located only as a symptom.

Reference: REF `2d79f7d`, PROD `a8c4699`. Evidence epochs are E0 (before about 05:50Z), E1 (after the deploy) and REF-local (REFERENCE.md).

## 1. Coverage

All figures are derived from the inventories, not estimated.

| measure | figure | source |
|---|---|---|
| Goal-relevant mechanisms inventoried (Map A) | **175** (17 kinds) and **62** handoffs. Independently reviewed: Gate A raised 52 findings, and all 30 open ones were accepted. | maps/A, reviews/GATE-A.md, maps/A/GATE-A-RESPONSE.md |
| Requirements for a usable plan (Map C) | **89**, of which 53 are critical | maps/C/requirements.json |
| Requirements with no existing capability | **28**, of which 11 are critical (Q-R010, 018, 021, 026, 069, 070, 071, 085–088) | register/C_to_existing_capabilities.json |
| Requirements with a verified diagnostic on REF or E1 | **12** (10 critical) | register/coverage.json |
| Requirements with diagnostics that have evidence but none verified | **49** (32 critical) | register/coverage.json |
| Map A mechanisms referenced by no existing question | **122 of 175**. A lexical join under-reports this, so a keyword sweep confirms 42 of the 45 decision mechanisms as uncovered. These include the portfolio selector and model challenge, the plan set, planReady, plan integrity, goal sprints and research selection. | register/coverage.json, register/new_diagnostics.json |
| Production behaviour observed (Map B) | 71 observations (45 E0, 21 E1, 5 undated); 65 read directly. Gaps are listed. | maps/B |

## 2. Diagnostics

| measure | figure |
|---|---|
| Existing questions | **218** (the recount matches the map: 27 PASS, 85 FAIL, 32 NEEDS RECHECK, 74 UNKNOWN) |
| Evidence class after reconciliation | 88 valid but needing recheck after changes · 73 unverified (no evidence) · 41 incomplete (code reading only or unmeasured) · **16 valid and reusable** |
| Spec-defective questions (as written, they cannot detect their own failure) | **14** (Gate B §4) |
| Questions backed by a verified experiment | 9 · partial 8 · unverified 187 |
| Newly justified diagnostic requirements | **73**: 28 from uncovered requirements and 45 from uncovered decision mechanisms (42 confirmed). There is no quota; each comes from an inventory row. |
| Verified effective diagnostics (Gate B) | **VERIFIED**: E-012 (delivery and dedupe), E-013, E-014, E-015, E-016, L-001. **PARTIAL**: E-001, E-002, E-010, E-011, E-012 F3. **INVALID**: none. E-017 was checked by Gate C against raw output. |
| Known-bad replay / known-good control / fault injection | Every experiment from E-010 to E-016 includes each one (see the experiments). E-002 and E-017 ran on production read-only. |

## 3. Causes

| category | items |
|---|---|
| **Established root causes** | CR-01 (a model turn is accepted without checking it is complete; on PROD a 4,000-token budget gives `finish_reason: length`, n=1 per arm) · CR-03 (a co-rule defeats the critic guard; recorded false drops still drop) · CR-04 (economics are computed only when the model volunteers the field) · CR-05 (the standing rule is injected as text) · CR-06 (the objective reader misreads silently; an amount miss gives a goal with no target) · CR-07 (findings are selected by recency and project-wide) · CR-09 (no per-goal state) · CR-10 (no arbiter, structurally) · CR-12 (the evaluation gate is blind to the failing path) · CR-16 (silent discard) |
| **Supported** | CR-02 as a production cause (ESTABLISHED in isolation) · CR-08 research supply · CR-11 · CR-13 (incidence 0 observed) · CR-14 · CR-15 · **CR-18 research parked for a person or routed to an empty routine pool**, whose mechanism is unlocated · the repair feedback loop (W1i, W1j) |
| **Refuted** | "Empty replies are the proxy idle cut" (E-001) · "a stream drop truncated the E-002-type reply" (E-017 sample) · "the answer sits in the reasoning field" (H1c, E-017) · "a generic constructed strategy was chosen on live goals" (GC-04) · "the critic keeps true violations" as a defect (Gate B) |
| **Unresolved** | CR-19 constraint provenance · model vs machinery share (U-05) · I-W1e×CR-01 (SUSPECTED) · whether W1a–W1j changed any live plan (U-16) |
| **Observed failure classes** | goal interpretation · invented owner restrictions · conflicting operating rules · empty or truncated replies · silent fallback · critic false vetoes · destructive parsing · conflicting selectors · lessons not reaching decisions · research starvation, plus research parked or queued with no lease · inflated or absurd committee figures (B-O026) · one-step plans routed to an idle pool (B-O048) · owner report contradicting capacity (B-O042, B-O047) |
| **Unexplained** | Why bins sit at NEEDS_HUMAN with 0/5 attempts, and why 47 fragments are queued with 0 leased (U-14) · where the live goal's 0 hours and $3,000 came from (U-15) · E1 rates of empty, truncated and fallback replies (U-02) |

**Shared causes (revised by Gate C):**
- **M1a turn integrity** (CR-01, CR-16).
- **M1b deterministic verification of model claims** (CR-03, CR-04). It needs the Q-R042 cash-flow specification first.
- **M2 owner facts read by regex or injected as text** (CR-05, CR-06, and the owner profile in CR-09).
- **M3 no per-goal state or arbiter** (CR-09, CR-10).
- **M4 evaluation blind to the failing path** (CR-12).
- Independent causes: CR-08, CR-11, CR-13, CR-14, CR-15, CR-18.

**Important interactions:**
- The primary model's empty replies hand reasoning to the weak fallback, which invents refusals.
- A partial turn ends the chain silently.
- CR-08 masks CR-07, and fixing CR-08 makes CR-07 worse.
- W1j's streaming repair introduced error erasure, which conceals CR-01.
- CR-12 feeds a repair loop that declares repairs done without verifying them.
- Upstream supply failure (CR-18, CR-08) produces the live NEEDS_EVIDENCE, and that outcome would mask any selector fix.

Detail: ROOT-CAUSES.md §I (authoritative), GRAPH.md (revision), UNCERTAINTY.md.

## 4. Independent review

| gate | reviewer | verdict | outcome |
|---|---|---|---|
| A: implementation coverage | separate agent, primary code | the map was not sufficient: 9 gaps, 52 findings | 30 accepted and mapped, 0 disputed |
| B: diagnostic validity | separate agent, re-ran harnesses byte-identically | 56 findings; 10 of 25 sampled register rows misclassified | rules fixed, register regenerated, 14 spec defects recorded, claims withdrawn |
| C: causal explanation | separate agent, primary evidence and raw E-017 | **NOT SUFFICIENT**: 23 findings (4 critical) | all applied in ROOT-CAUSES §I; the remaining open items are U-14, U-15 and U-16 |

**Limitation (U-12):** every reviewer is the same model family as the authors. This is mitigated by separate assignments, primary evidence and re-execution, but it is not removed.

## 5. Readiness for coordinated repair planning

- **Ready**:
  - Stage 1 (M1a turn contract, at every model call site, with a measured budget).
  - Stage 2 (M2 owner constraints resolved once, as data).
  - Stage 3 (M3 per-goal state and arbiter; CR-07, CR-17).
  - The Stage 0 factorial measurement design.
- **Not ready**:
  - Stage 1b, which needs a specification decision on the cash-flow and peak-capital rule (Q-R042).
  - Stage 4 supply, because the CR-18 mechanism is not yet located.
  - Any claim about post-deploy plan behaviour (U-16).
- **Section 20 gates unmet**:
  - C: every handoff has diagnostic coverage. 42 decision mechanisms are uncovered; they are recorded as requirements but not executed.
  - F: major diagnostics have been verified. 187 questions are unverified.
  - G: the cause of the live outcome is established. CR-18 is SUPPORTED, not ESTABLISHED.
  - H, partially: downstream failures on E1 are unobserved.

## 6. Records

- REFERENCE.md and TASKS.json (T01–T15)
- maps/A, maps/B, maps/C
- register/: questions.json, coverage.json, new_diagnostics.json, C_to_existing_capabilities.json
- experiments/: E-001, E-002, E-010–E-017, with raw/ and harness/
- evidence/: L-001–L-003
- reviews/: GATE-A, GATE-B, GATE-C, with their findings JSON
- ROOT-CAUSES.md, GRAPH.md, UNCERTAINTY.md, REPAIR-BLUEPRINT.md

The register files are regenerated with `python3 -I experiments/build_register.py <repo>` followed by `build_coverage.py` and then `build_new_diagnostics.py`.
