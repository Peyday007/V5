# Coordinated repair blueprint (documentation only; NOT implemented in this mission)

**Principle.** Correct the four mechanism classes in dependency order, and prove each step on the production path with the diagnostics this investigation verified (Gate B). Each step is defined by the class it removes, not by a component bug list. This prevents another isolated bug-fix campaign (CR-12 loop).

## Stage 0: Make failure visible first (M4: CR-12, part of CR-01)

Nothing later can be verified without this stage.

1. **An end-to-end production-path evaluation.**
   - It runs from the owner's words through discovery → research → proposer → critic → plan reading to a blind grade on Map C's usable-plan rubric (U01–U12, Q-CM01–20).
   - It runs on goals created through the same door production uses, the operator path included (CR-13).
2. **Turn-level observability:**
   - served model;
   - finish reason;
   - completion tokens;
   - parse outcome, including incomplete parses;
   - every discard with its reason.
3. **The fault-injection set E-010–E-016 as standing negative controls.** The evaluation must detect each one.
4. **Proof:** the injected faults are detected, and a held-out objective set is not used in development.

## Stage 1: Contract on every model turn (M1: CR-01, CR-16, CR-03, CR-04)

Depends on Stage 0.

1. **A turn counts only when complete:**
   - finish reason is acceptable;
   - JSON is complete;
   - required fields are present;
   - the budget is adequate for reasoning models (resolve U-01).
2. **Fallback that cannot reason fails loudly** rather than planning.
3. **Economics are computed by code from every route's figures:**
   - price × volume against the target;
   - acquisition spend against capital;
   - cash dates against the window.
   - A missing figure means the route is incomplete, never assumed favourable.
4. **Critic objections must cite an existing finding or a computed violation.**
   - Code decides computable claims.
   - Uncomputable objections become research questions, not drops.
5. **Proof:**
   - E-001/E-002 replays: no truncated or empty acceptances.
   - E-010/E-011 replays: recorded false drops overruled, true hidden violations caught, F999 rejected.
   - Stage-0 evaluation, delta measured.

## Stage 2: One resolved owner and constraint record (M2: CR-05, CR-06, CR-13)

Can run in parallel with Stage 1 after Stage 0.

1. **The objective and the owner's means are read once**, with a per-field read/unread state.
   - Unread becomes a question to the owner, never "no limit".
2. **Policy and owner constraints are kept apart, with provenance.**
   - The standing operating rule is applied as data with the goal's lift.
   - Prompts and regex gates read the record rather than injected text.
3. **Search eligibility comes from the goal's authorization**, not from the door that created it.
4. **Proof:**
   - E-013 held-out paraphrases: ≥95% of fields correct, zero silent misses.
   - E-014 owners: no policy text appears as owner limits.
   - An operator-created goal is searched.

## Stage 3: One per-goal working state and one arbiter (M3: CR-09, CR-10, CR-11, CR-14)

Depends on Stage 2. Stage 1 must also be complete, so that candidates entering the arbiter are trustworthy.

1. **The goal record is read first and written last by every faculty.** It holds:
   - owner profile and constraints;
   - candidates and the chosen strategy;
   - binding factor and open questions;
   - lessons (no 24 h expiry) and refuted directions.
2. **One arbiter selects among all generators' candidates**, scoped to the goal and its owner.
   - Constructed arrangements with no owner provenance are excluded from the owner plan.
3. **Plan readiness is separate from money-commitment approval.**
4. **Buyer links name real segments**; otherwise they are estimates.
5. **The executable plan is rendered from the structured model**:
   - steps, performer, cost, day, first action;
   - checkpoints and kill criteria (Q-R066–071).
6. **Proof:**
   - E-016: a lesson changes ask 3.
   - One reading gives one answer across acceptance, committee, report and operator.
   - The owner plan contains only owner-provenanced strategies.

## Stage 4: Supply and capability (CR-08, CR-15, CR-02)

Can run in parallel with Stages 1–3. The owner's items are on the critical path.

1. **Research allocated by decision value per goal**, with per-goal supply visible.
2. **Owner items:**
   - a keyed search provider;
   - worker membership;
   - a route/critic model that passes the commercial-planning exam. That needs an Anthropic key, or a change to the §84 reservation.
3. **Question generation starts from the owner's means and decisive unknowns**, with structurally different mechanisms required.
4. **Proof:**
   - A fresh goal completes its planned research in-window, and its plan reads at least 20 relevant verified facts.
   - The exam-passing model serves the route turns.

## Stage 5: Acceptance measurement

After Stages 0–4.

- Run 30 unfamiliar feasible objectives on one frozen revision with independent grading.
- The target is at least 27/30 usable with zero critical mistakes (owner's standard).
- `planningReliability` stays as a component regression for `readGoalPlan` only (L-001).

## What must NOT be done

These are lessons from the evidence:
- **No repair validated only on the batch it was tuned on** (W1i).
- **No rule-name heuristics standing in for a computed check** (W1b).
- **No fix whose trigger depends on the model volunteering a new field** (W1c).
- **No time-window horizon on lessons** (W1h).
- **No "MERGED" counted as progress** without a Stage-0 production-path measurement.
