# Planning-session release and Claude app connection test (prepared 2026-11-27; not executed)

This releases the app-session planning path on branch `claude/10k-revenue-30-days-9ba2t4`:
- the session planning adapter (`server/services/planning/sessionPlanning.ts`);
- ten `brain_planning_*` MCP tools;
- Brain's checks, the research-gate path, review conditions, grading;
- one operator command, `access grant-planning`.

**Nothing here has been run against production.** The owner's standing instruction for this work is no merge and no
deploy.

## Release readiness, as verified on the branch head

| item | state |
|---|---|
| relation to `origin/production` | 0 behind, ahead only: a trial merge in a scratch worktree applied cleanly (fast-forward possible) |
| migrations | none: nothing under `server/db/` differs from `origin/production`, so no schema change on either backend |
| `npm run typecheck` | clean |
| `npm run test:impacted` (SQLite) | 84 files, 1,359 tests passed |
| `npm run test:pg` (the same selection on a local Postgres) | see the run-5 README for the result on this head |
| full suite | not run here, by design (CLAUDE.md): it runs once in CI on the merged SHA (`Postgres suite`) and in `Deploy`'s test job |

**What ships:**
- **New MCP tools**, registered after the operator tools in `server/mcp/tools.ts`:
  - contract, context, admit_routes, run_brain;
  - research, verify_research;
  - submit_revision, review, finalize, state.
- **Authorization.** Reads need `project:read`. Writes need `operator:act` on the goal's project. There are no new scopes.
- **Planning state.** It lives in append-only `workstream_events` (`PLANNING_*`). Research uses the existing research
  tables through their repositories.
- **Shared behaviour changes outside the new module**, each with tests:
  - `research/gate.ts`: for a question that names no market, UNSTATED geography alone no longer rejects a claim.
    Production research uses this gate.
  - `domain/decision.ts`: an unknown cost or probability keeps expected value unknown.
  - `domain/planReady.ts`: review independence is identity- and credential-based.
  - `industry/construction/intent.ts`, `goals/objectiveAssist.ts`: labelled spending limits and the COLLECTED_CASH
    metric.
  - `goals/routeProposal.ts`: an unknown direct cost stays unknown.
  - `scripts/admin.ts`: `access grant-planning <worker> <project>` adds `OPERATOR_SCOPES` to what the worker already
    holds on that one project. It was verified on a copy of an evaluation world: a research-only worker ended with its
    research scopes plus `operator:act`.

## Release steps (canonical branch `production`, per `.github/CANONICAL_BRANCH`)

1. Open a PR from `claude/10k-revenue-30-days-9ba2t4` to `production`. No rebase is needed while it is 0 behind.
2. **Merge.** The `Postgres suite` workflow runs the full suite on the merged SHA (four shards plus a verdict job). It must
   be green.
3. **Dispatch `Deploy`** (`workflow_dispatch`, reason "app-session planning path") on `production`.
   - Its test job runs the full SQLite suite on that SHA, then `flyctl deploy` to `northline-brain`.
   - The canonical guard refuses any other SHA.
4. **Verify on production:**
   - `/healthz` returns 200.
   - Issue an operator-scoped worker credential and save it to a file. Then run
     `npx tsx scripts/planningMcpHost.ts probe --url https://<production host>/mcp --credential <file>`.
     It must report `planningTools: 10` and `missing: []`.
5. **Rollback.** Dispatch `Deploy` on the previous released commit with `allow_rollback` set. The workflow refuses an
   older commit than `deployed/production` unless that input is given.

## The Claude app connection test: exactly what needs the owner

**Why the existing connector is not enough.** The Claude app reaches Brain through a custom connector at
`https://<app>/mcp`, approved over OAuth as one named Brain worker (`server/routes/oauth.ts`). The connector this
session uses is `worker-05`. `brain_whoami`, 2026-11-27, shows it holds the research set on ten projects and
**`operator:act` on none**. With it, the planning reads work, and every planning write (`contract`, `submit_revision`,
`review`, `finalize`) is refused.

**Why two workers.** Review independence compares credential principals. Two Claude sessions on the same worker are
self-review and never certify. So the test needs **two workers on two connectors**:
- the author, which can be `worker-05` with planning granted;
- an independent reviewer: a second worker on its own connector.

**Steps, in order:**

1. **Merge and deploy** (release steps above). This is your authorization; the instruction for this work forbids it.
2. **Grant planning to the author worker** on the project the test goal will live in, from a terminal on the
   production deployment:
   `npm run admin -- access grant-planning worker-05 <project> --admin <your Brain admin email>`
3. **Create the reviewer worker and grant it planning:**
   - `POST /api/admin/workers` with `{ "name": "planning-reviewer", "displayName": "Planning reviewer" }`. There is no
     CLI for creating a worker. Alternatively, reuse an existing worker from `npm run admin -- workers list` that the
     author connector is not approved as.
   - Then: `npm run admin -- access grant <worker> <project> --admin <email>` followed by
     `npm run admin -- access grant-planning <worker> <project> --admin <email>`.
4. **In your claude.ai account**, add a second custom connector at the same `https://<app>/mcp`. On Connect, sign in
   and approve it **as the reviewer worker**. Each worker needs its own connector: reusing the existing one hands back
   `worker-05`.
5. **Author session.** In a new Claude app session with only the author connector enabled, give an unfamiliar objective
   in your own words. The session should:
   1. create the goal;
   2. call `brain_planning_contract` with your words verbatim;
   3. call `run_brain` and `context`;
   4. admit any routes it discovers, and research decisive questions through `brain_planning_research`;
   5. submit revisions until Brain's check is clean.
6. **Reviewer session.** In a second session with only the reviewer connector enabled:
   - call `brain_planning_state` for that goal;
   - review with `brain_planning_review`, putting any condition in `conditions` with its record;
   - verify any research claims with `brain_planning_verify_research` (a different identity from the researcher).
7. **Back in the author session:**
   - answer any conditions with a decision and the records checked;
   - after a PASS on the exact revision, call `brain_planning_finalize`;
   - check that `brain_planning_state` shows the same published revision id and digest from both sessions.
8. **Pass criteria:**
   - every call returns `isError: false`, or a stated refusal with its scope;
   - the published plan's ids and digest match across check, review and final;
   - the author's self-review is refused as not independent;
   - no spend, contact or goal-resume happened. Planning authority grants none.

**Not needed:** a staging app. If you want one first, create a second Fly app, for example `northline-brain-staging`,
with its own database:
- set its secrets per `docs/CLOUD.md`, with no provider credentials, so it can send and spend nothing;
- run `flyctl deploy -a northline-brain-staging` from a checkout of the SHA;
- point the two connectors at it instead.

That is a billable Fly resource and needs your Fly account. `Deploy` targets only `northline-brain`.

## The four outcomes, kept separate

1. **Software checks pass.** Verified on the branch (above). This alone completes nothing.
2. **Unfamiliar objectives produce usable plans.** Measured on Brain's real MCP router on isolated worlds (run-5
   README), not through the Claude app.
3. **The Claude app connection works.** Not tested. It needs steps 1–4 above, which are yours.
4. **A real commercial objective produces an evidence-supported plan or an actionable experiment.**
   - The owner's $10,000 objective, run as a discovery world (run 4, d01), published a no-plan.
   - The deciding problem is cost: the accepted costs to deliver are at or above the $1,500 price.
   - Its resolution is an ordered experiment:
     1. a written fulfiller quote at or under $257 per site, at no cost;
     2. a published count of reachable buyers, at no cost;
     3. only then, a $197 outreach test inside the $300 pre-proof cap.
   - That is an actionable experiment, not a supported $10,000 plan.
   - Running that through the real app is part of outcome 3's test.
