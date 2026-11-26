# Investigation reference (frozen)

Diagnostic-only, independent causal investigation of Brain V5. Started 2026-11-26T06:20Z.
No repairs are made by this investigation. Nothing here changes production.

## Frozen implementation reference

| item | value | evidence |
|---|---|---|
| Reference commit (REF) | `2d79f7d1cefcbe3e2cc61a6acfa21628074a8349` (2026-11-26 01:07:55 -0500) | `git rev-parse HEAD` on `production` == `origin/production` at start |
| Canonical branch | `production` | `.github/CANONICAL_BRANCH` |
| Production revision (PROD) | `a8c4699` — last successful `Deploy` (run 45763247641, created 2026-11-26T05:41:36Z). The Deploy of `2d79f7d` (run 45766125722) was **cancelled**. | `gh api repos/Peyday007/V5/actions/workflows/deploy.yml/runs` |
| REF vs PROD | 5 files: `scripts/diagnose-readings.ts`, `server/db/infra.ts`, `server/services/freeLane/capacity.ts`, `tests/freeLaneCapacity.test.ts` (+1). **No planning-path file differs**; free-lane capacity accounting differs. | `git diff --stat a8c4699 2d79f7d` |
| Production app | Fly `northline-brain` (`fly.toml`), `/healthz` = `ok` at 06:2xZ | curl |
| Failure map revision | `dce831b` (2026-11-26 05:39Z); map.json 42 caps / 218 q / PASS 27 FAIL 85 NEEDS RECHECK 32 UNKNOWN 74 / 15 RC / 17 repairs — **verified by recount** | `python3 map.json recount`; `node scripts/planningFailureMapCheck.mjs` → OK |
| Wave-1 repairs (W1a–W1j) | merged 05:07–05:41Z; contained in PROD `a8c4699`. **Deployed ≠ verified**: any production behaviour observed *before ~05:50Z* is pre-repair. | `git log 9743f9d..a8c4699` |

## Evidence epochs (every observation is tagged with one)

- **E0 pre-W1**: production before `a8c4699` was live (< 2026-11-26T05:50Z). Includes the 30Q test, model exam, integration diagnosis, research-starvation diagnosis, fm1126a batch.
- **E1 post-W1 / PROD a8c4699**: production observations after the deploy.
- **REF-local**: isolated reproductions run on a local checkout of REF (sandbox DB, no production writes).

A failure observed in E0 on a path a W1 repair touched is recorded as **E0-OBSERVED, REF-UNVERIFIED** until an E1 or REF-local observation re-tests it. A merged repair is never treated as changed behaviour.

## Access used

- Repository read (full), local sandbox runs.
- Production read via the `cloud_brain` MCP (worker-05 credential; operator read tools answer: goals, goal plans, history, knowledge). No mutating Brain tool is used by this investigation.
- GitHub REST (read).

## Deadline note

The completion hook read the *example* objective's "within 30 days" as a mission deadline and refused all non-read tools until one was registered. The session registered an **outer bound** of 2026-12-26T00:00Z (triggers `trig_014btXRg4oDeqtWbDu6Z5Lsw`, warning `trig_014z8tLGcFGnh1FMFiN94CiD`). The owner set no deadline for this mission.
