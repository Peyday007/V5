# L-001: Brain's acceptance suite cannot observe the failing path (lead finding, REF 2d79f7d)

**Claim.** `planningReliability` (COMPLETION-SPEC §5, the owner's 90% / zero-critical measure) never exercises the mechanisms that produced 0/12 usable plans in production:
- objective-to-opening discovery;
- research execution;
- the LLM route proposer, critic and parser path;
- model serving.

**Evidence.**
- COMPLETION-SPEC.md:230-234. For each case the runner "files the case's openings on a database of its own", creates the goal through `createGoal`, and reads `readGoalPlan`. The openings and their evidence are supplied by the case.
- `grep -rn "proposeGoalRoutes|routeProposal|openGoalDiscovery|chatFor|askModel" bench/planningReliability/*.ts` returns nothing. The suite never calls the route proposer, discovery or any model.
- Its recorded baseline failures (BASELINE.md) all concern `readGoalPlan`'s judgement of openings it was handed: `dealsForGoal`, `conservative`, `economicsState` and `changeObjective`.

**Consequence.**
- A rising `planningReliability` score is evidence about the quantitative reading of given openings only.
- It cannot detect:
  - question anchoring (RC5);
  - research starvation (RC6);
  - empty or fallback model turns (RC1);
  - critic vetoes (RC2);
  - findings-delivery loss (RC4);
  - the operating-rule injection (RC3).
- This is a missing capability hidden by a passing component test (owner's Section 8). Gate B should confirm it by checking whether any suite in `bench/` or `tests/` drives objective → discovery → research → proposer → critic → plan end to end with an independent grader.
- The 30Q test and `scripts/planningEval.ts` probe do drive that path. They are ad-hoc, read-only and not in the gate.

**Status:** OBSERVED (code and spec). Diagnostic validity of `planningReliability` for the owner's outcome: **INVALID as an end-to-end diagnostic**, and valid only for the `readGoalPlan` stage.
