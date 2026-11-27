# Planning-session release and claude.ai connection test (prepared 2026-11-27, not executed)

This releases the app-session planning path on branch `claude/10k-revenue-30-days-9ba2t4`:
- the session planning adapter (`server/services/planning/sessionPlanning.ts`);
- `brain_planning_*` MCP tools;
- checks, the research gate path, and grading.

Nothing below has been run against production. The owner's instruction for this round is not to merge or deploy.

## What ships

- **New MCP tools** (10), registered after the operator tools in `server/mcp/tools.ts`:
  - contract, context, admit_routes, run_brain;
  - research, verify_research;
  - submit_revision, review, finalize, state.
- **Authorization:** reads need `project:read`; writes need `operator:act` on the goal's project. No new scope.
- **No migrations.** Planning state is append-only `workstream_events` (`PLANNING_*`). Research uses the existing
  research tables (candidates, missions, orchestrations, fragments, claims) through their repositories.
- **Shared behaviour changes outside the new module**, each with tests:
  - `research/gate.ts`: for a question that names no market (`ANY_NAMED_MARKET`), an UNSTATED geography no longer
    rejects a claim on its own. Production research uses this gate too.
  - `domain/decision.ts`: an unknown cost or probability keeps expected value unknown.
  - `domain/planReady.ts`: the review condition replaces the Hermes-only one. Review independence is identity- and
    credential-based.
  - `industry/construction/intent.ts` and `goals/objectiveAssist.ts`: labelled spending limits; the COLLECTED_CASH
    metric.
  - `goals/routeProposal.ts`: an unknown direct cost stays unknown; budgets are carried separately.

## Release steps (canonical branch `production`, `.github/CANONICAL_BRANCH`)

1. **Developer gates on the branch head:**
   - `npm run typecheck`;
   - `npm run test:impacted`;
   - `npm run test:pg` (the selection on Postgres);
   - `npm run loop`, where the bench must show no regression against `origin/production`.
2. **Open a PR** `claude/10k-revenue-30-days-9ba2t4` → `production`. Rebase onto `origin/production` first. The
   branch also carries the planning documents under `fast-cash/` and `docs/`.
3. **Merge.** The `Postgres suite` workflow runs the full suite on the merged SHA (four shards plus a verdict job)
   and must be green.
4. **Dispatch `Deploy`** (`workflow_dispatch`, reason "app-session planning path"). Its test job runs the full
   SQLite suite on the released SHA, then `flyctl deploy` to `northline-brain`. The canonical guard refuses any
   non-canonical SHA.
5. **Verify on production:**
   - `/healthz` returns 200.
   - Run `npx tsx scripts/planningMcpHost.ts probe --url https://<production host>/mcp --credential <file>`, using
     an operator-scoped worker credential issued on the target project. It must report `planningTools: 10`,
     `missing: []`.
6. **Roll back if needed:** dispatch `Deploy` with the rollback input set to the previous released SHA.

## The actual claude.ai connection test

The claude.ai app reaches Brain through the existing connector, the `cloud_brain` MCP server on production `/mcp`.
After step 5:

1. **Planning session.** In a Claude app session that has the Brain connector, the owner gives an unfamiliar
   objective in their own words. The session must:
   1. find or create the goal (`brain_operator_create_goal`);
   2. `brain_planning_contract` with the words verbatim;
   3. `brain_planning_run_brain` and `brain_planning_context`;
   4. for any route it proposes, `brain_planning_admit_routes`;
   5. for decisive open questions, `brain_planning_research` with real sources;
   6. `brain_planning_submit_revision` until the check is clean.
2. **Independent review.** A second, independent session reviews with `brain_planning_review`, under its own
   connector identity. The same identity is refused as self-review. Verification of research
   (`brain_planning_verify_research`) also needs a different identity from the researcher.
3. **Publish.** The author calls `brain_planning_finalize`. `brain_planning_state` from either session must show the
   same published revision id and digest, and the review bound to that digest.
4. **Pass criteria:**
   - every call returns `isError: false` or a stated refusal with its scope;
   - the published plan's identifiers match across context, check, review and final;
   - no spend, contact or goal-resume happened (planning authority grants none).

## Isolated / staging option (not available today; needs the owner)

No staging deployment exists: `fly.toml` names one app, and `Deploy` targets only it. An isolated option:

1. Create a second Fly app, for example `northline-brain-staging`, with its own database: a SQLite volume, or a
   separate Postgres. Never the production database.
2. Set its secrets the way `docs/CLOUD.md` describes. Without any provider credentials, it can send nothing and
   spend nothing.
3. Deploy the branch SHA to it with `flyctl deploy -a northline-brain-staging` from a checkout of that SHA.
4. In claude.ai, add it as a second custom connector at `https://northline-brain-staging.fly.dev/mcp`, then run the
   connection test above against it.
5. Probe it: `npx tsx scripts/planningMcpHost.ts probe --url https://northline-brain-staging.fly.dev/mcp --credential <file>`.

Steps 1–3 need the owner's Fly account (a new app is a billable resource), and step 4 needs their claude.ai
account. Locally, `scripts/planningMcpHost.ts serve` already runs Brain's real MCP router on an isolated world. All
of this round's evaluation used it, but claude.ai cannot reach a container-local port.
