# Planning reliability of app-session-authored plans (2026-11-26)

**What was measured:** plans written by Opus sessions through the planning adapter
(`scripts/planningSession.ts`, the service behind the `brain_planning_*` MCP tools). They were graded
by the completion specification's own grader (`grade` in `bench/planningReliability/grade.ts`) through
`observeSession`, which reads structured fields only.

**Sample:** all 22 held-out cases of the bench (`ho-*`, `mv-*`). Each had its own isolated world, built
the way the bench builds one:
- openings filed by `fileOpening`;
- the goal created from the case's words by `createGoal`;
- ho-14's objective change applied by `applyChange`, after the session planned the first objective.

**Executors:** 6 fresh agents, each given only `BRIEF.md`, neutral world names (`worlds.txt` maps
them to cases) and the planning CLI. They were told not to open the bench, tests, docs or grader
files; the grader's keys sit outside the world folders.

**Not done in this run:**
- No independent review or publication: the session's current revision is what was graded.
- Step records carry no capability declarations, so `BRAIN_CAPABILITY_NOT_HELD` can only fire on a
  performer the evidence contradicts.

| | run 1 (adapter defect) | run 2 (fixed adapter) |
|---|---|---|
| verdict level (completion spec §2–3) | 15/22 = 68.2% (Wilson 47.3–83.6%) | **20/22 = 90.9% (Wilson 72.2–97.5%)** |
| critical failures | 0 | **0** |
| owner-usable | 17/22 | 14/22 |
| end to end (§3a) | 11/22 | 12/22 |

**Run 1:** the context did not show the session each opening's record or its written agreements,
although Brain's planner reads both. The sessions refused plans that the evidence they could not
see supported. That was fixed in `consideredOpenings`. The brief gained one line naming the new
context fields, and all 22 were rerun on fresh worlds by fresh agents.

**Run 2, verdict-level failures** (both non-critical `UNJUSTIFIED_REFUSAL`):
- mv-01: the evidence-missing blocker was declared arithmetically infeasible (TARGET).
- mv-03: the same, on MARKET_VOLUME.

**Run 2, end-to-end failures:** 6 executable plans gave the delivery the evidence assigns to Brain to
the owner instead (`PERFORMER_MISMATCH`, `OWNER_ROUTINE_WORK`), apparently reading the card's
per-deal `humanHours` as owner work. That is also why owner-usable fell.

**For comparison:** Brain's own planner on the same 22 held-out cases, same SHA base, scored
20/22 = 90.9% at the verdict level (bench `accuracy.heldOut`).

**Reading:**
- The point estimate meets the 90% target, but 22 cases cannot establish it: the 95% lower bound
  is 72%.
- This is planning reliability, not the chance that any business reaches its target.
- Run 2 rows and revisions: `run2/`. Run 1 rows: `run1/`.
