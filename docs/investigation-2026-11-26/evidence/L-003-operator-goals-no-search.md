# L-003: A goal the operator creates may never be searched (lead check of Map A fact 4)

**Code at REF (lead verified):**
- `server/mcp/operatorTools.ts:1025`: `createGoal({ …, actorRef: 'operator:…', userId: null })`.
- `server/services/russell/goalSprint.ts` `sprintCandidate`: `if (!goal.createdByUserId) return false`. A goal with no creating person never gets the auto-activated Cash Mode (research sprint).
- `server/services/goals/routeProposal.ts:1977-1978`: `discoveryAllowed(target.projectId)`. With no active mode it returns `NOT_DUE, 'the project is not searching'`. The route proposer, and goal discovery behind the same gate, do not run.
- Contrast: `scripts/planningEval.ts:109` passes `userId: admin.id`. **Evaluation goals do get searched. Operator-created goals in a project without a Cash Mode do not.**

**Consequence.**
- Every evaluation, including the 30Q test, dec1125c and fm1126a, exercised a path that an operator-created production goal never reaches.
- Evaluation results therefore do not represent operator-created goals. This is a sampling gap between evaluation and production behaviour.

**Status.**
- SUPPORTED in code.
- Production incidence UNKNOWN. Map B must check which live goals were created by `operator:` and whether their projects hold an active Cash Mode.
- The live $10k goal `wst_7b4f…` shares project `prj_22fb…` with research goals, which may already hold a mode.

**Diagnostic it requires:** for each live cash goal, record creator (person or operator), project Cash Mode state, and whether any `proposeGoalRoutes` ask has ever been recorded.
