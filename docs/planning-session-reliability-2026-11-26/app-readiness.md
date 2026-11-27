# Can the owner use the planning workflow in the Claude app today? (2026-11-27)

**No.** Direct evidence, taken through the owner's own production Brain connector (`cloud_brain`) in this session:

1. **The tools are absent.** The connector's tool list carries **no `brain_planning_*` tool**. The first operation of
   the journey, `brain_planning_contract`, has nothing to call, because the branch holding the planning path is not
   deployed to production.
2. **The connector cannot write a plan.** It is approved as `worker-05`, and `brain_whoami` shows it holds the research
   set on ten projects and **`operator:act` on none**. After a deploy, its planning reads would work and its planning
   writes would be refused.

## What only the owner can do, and the exact action

| need | action |
|---|---|
| The planning tools in production | Authorise merge and `Deploy` of `claude/10k-revenue-30-days-9ba2t4`. It is 0 behind `production`, merges cleanly, has no migrations, and passes the impacted selection on SQLite and Postgres. Steps: `../planning-session-release.md`. |
| Planning writes for the author connector | After the deploy, run `npm run admin -- access grant-planning worker-05 <project> --admin <your admin email>` on the production deployment. |
| Fleet review of a goal your app session creates | Take ownership of the goal (`PATCH /api/goals/<goal>/terms` with your `ownerUserId`). A goal your connector creates has no owner, because a worker carries no person identity. Under your brain-only rule (§84), routines take an unowned goal's review only if you own it (§118). Found and verified in journey 2. |

## What no longer needs the owner (built 2026-11-27)

- **Independent review.** It was a second claude.ai connector and a manual switch between author and reviewer sessions.
  Now a clean revision is queued (`PLAN_REVIEW`) on Brain's own work queue, and research is queued for verification
  (`PLAN_VERIFY`). Any connected fleet worker other than the author claims the item. Its lease authorises that one review
  or verification, and the item cannot be completed until the verdict is recorded. The author's session reads the
  verdict from `brain_planning_state`.
- **Reviewer permissions.** Reviewers need no `operator:act`; the research set your workers already hold is enough.

## The two journeys run on the isolated MCP router

Results are in `journeys/`. Both use one author session and a fleet worker that only claims from the queue:
- **Journey 1:** an objective with established opportunities, testing the planning machinery.
- **Journey 2:** the owner's $10,000 objective with no supplied opportunities, from discovery to final output.
