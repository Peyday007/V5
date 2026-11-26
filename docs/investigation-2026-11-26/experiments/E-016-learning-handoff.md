# E-016: do lessons, plan verdicts and committee questions reach the next route ask? (W1h)

**Hypothesis.**
- A rethink written by one `proposeGoalRoutes` ask is read by the next (W1h).
- The plan's verdict, binding factor and committee questions reach `routeContext`.

**Harness (sandbox, real chain).** `harness/e015_e016.sandbox.test.ts`, the E-016 block, on a sandbox SQLite DB built with the repository's test helpers and a scripted model:
- **Ask 1** returns `rethink: "LESSON-ALPHA …"`.
- **Ask 2** runs 6 h 1 min later (the ordinary interval).
- **Ask 3** runs 25 h after ask 2.

**Raw output.** `raw/E-016/lessons.json`

## Results

| ask | at | prompt has the "WHAT EARLIER ASKS … LEARNED" section | contains LESSON-ALPHA |
|---|---|---|---|
| 1 | t | no (none yet) | no |
| 2 | t + 6 h | **yes** | **yes**: W1h works |
| 3 | t + 31 h | **no** | **no**: the lesson is gone |

**Why the lesson is gone at ask 3.**
- Lessons are read only from the `GOAL_ROUTES_PROPOSED` events inside `proposeGoalRoutes`' lookback, `now − max(DAY, 6 h)` = 24 h (`routeProposal.ts:1946,2023`).
- A lesson older than a day, or one from an ask whose later re-asks wrote `rethink: null`, is never read again.
- The durable copy goes to `operator_learnings`, and only when refutations exist (`:2137`). It was empty in this run (`operatorLearnings: []`), and the goal path never reads it (static: no read of `operator_learnings` in `routeProposal.ts`).

**Plan verdict, binding factor, committee questions (static).**
- `routeContext` (`:1591-1623`) builds the context from:
  - claims;
  - the goal's own openings: `refuted` and `scouted`;
  - exclusions;
  - delivers;
  - the target.
- `proposeGoalRoutes` adds today, the last ask's critique drops and the lessons.
- There is **no read** of `readGoalPlan`, a verdict, a binding factor or committee questions anywhere in `routeProposal.ts` (grep: no matches).

**Also (static, C32-R).** Replacement routes asked for after a critique are ranked and filed **uncritiqued** (`:1914`, score null).

## Diagnostics

| question | result |
|---|---|
| C04-R (lessons, refutations and committee questions reach the route ask) | lessons: **within 24 h only**; refutations: yes; committee: **no** |
| C22-I (plan verdict reaches the route ask) | **no** (static) |
| C22-R (committee questions answered) | **no** path into the route ask (static) |
| C32-R (replacements critiqued) | **no** (static) |
