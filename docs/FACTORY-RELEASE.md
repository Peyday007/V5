# Factory: from an approved objective to a live, verified result

The intended experience: approve a bounded software objective, go offline, come
back to Brain, and see either the functioning deployed capability or one
specific blocker — and whether that blocker is yours.

This document is the mechanism. CLAUDE.md §58 is why it is shaped this way.

## The status a person reads

Every campaign on Build carries one status, derived from rows on every read
(`server/services/factory/release/outcome.ts`) and stored nowhere:

| status | means |
|---|---|
| **BUILDING** | planning, implementing, integrating, reviewing or repairing |
| **VERIFYING** | final checks and the pull request; or built and waiting for the release gate |
| **RELEASING** | the gate is merging and testing, Deploy is running, or the released Brain is being verified |
| **LIVE** | the merge commit is what the Brain is serving, `/healthz` answers, and every live check the owner wrote passed — measured inside the released process |
| **BLOCKED** | the exact blocker, and `needsPerson` says whether anything will move without you |

A pull request is never LIVE. A merge is never LIVE. LIVE comes only from
`release-verify`, run inside the deployed container.

## The one decision: automatic release

Approving an objective starts work on a branch. Letting the result reach
production without you is a second, larger decision, made once, at approval:

- **On Build:** tick *Release it to production by itself…* before *Approve and
  start*. Shown only for a LOW-risk objective; it needs project ADMIN.
- **On a terminal:** `npm run factory authorize-release --change-request fcr_… --admin you@example --file objectives/x.json`
  (the file's `release` section carries the page path and live checks).

The grant (`factory_release_grants`) records who granted it, through which
channel, the page the feature lives on, and the live checks that define "live".
It widens nothing: a campaign still may not touch what its scope excludes, the
review floor is unchanged, and the reserved paths below refuse at the gate
whatever the grant says. Withdraw it on Build or with the HTTP route.

## What is never released automatically

`RELEASE_EXCLUDED_PATHS` in `server/domain/factoryRelease.ts`. A campaign that
touches any of these finishes at a pull request exactly as before:

- new financial authority (`cash/authority.ts`, the ledger, the providers, effects)
- secrets and deployment configuration (`.github/**`, `fly.toml`, `Dockerfile`, `server/config.ts`, `server/env.ts`)
- identity and authorization policy (`services/identity/**`, auth/OAuth/guard routes, MCP endpoint, bin routing)
- every migration (`server/db/**`) — a glob cannot tell an additive migration from a destructive one
- dependencies (`package.json`, `package-lock.json`)
- the release machinery itself, the repository envelope and the approval envelopes

And: anything not LOW risk, anything without a PASS review at a known
independence tier on the integration commit, anything with an open finding, and
any repository other than the one the workflow deploys.

## The release workflow

`.github/workflows/factory-release.yml`, every fifteen minutes and on demand.
Brain decides; the workflow performs. Brain holds no forge write credential and
no deployment credential, and no Factory worker holds either.

1. **plan** — asks Brain (`factory release-plan`) through the console door.
   Brain records the attempt (`factory_release_runs`, state GATING or REFUSED)
   *before* answering. An attempt already in flight is always resumed first.
2. **gate** — no secrets, read-only token, credentials not persisted. Merges the
   reviewed head into the canonical branch locally, refuses a head that moved,
   scans the diff from the *trusted* checkout (reserved paths, credential
   patterns), then `typecheck`, `test:impacted` and `build` on the merged tree.
   This is the only job that executes the change's code.
3. **release** — runs only the trusted checkout. Pushes exactly the commit the
   gate tested as a plain fast-forward (never a force; a moved branch means the
   next pass re-gates), records MERGED, dispatches the canonical `Deploy`
   workflow (whose full suite is the release SHA's one full gate, rule 3),
   records DEPLOYING, watches it to termination, then runs `release-verify`
   inside the released Brain.

Rollback: on a Deploy failure or a failed verification, the merge is reverted on
the canonical branch and Deploy is dispatched for the revert. There is
deliberately no second path that runs `flyctl deploy` (§28), so production
returns to the previous behaviour on that deploy, and branch and image never
disagree. The attempt is recorded ROLLED_BACK with every step.

## Continuation and recovery

Every effect is recorded before the next is attempted, so a workflow run that
dies anywhere leaves a row the next run resumes:

- died before pushing → the attempt is still GATING; the next run re-gates (or,
  if the push landed, finds the merge commit and records it);
- died after merging → MERGED; the next run dispatches Deploy (or adopts the
  Deploy run already dispatched for that commit);
- died while watching → DEPLOYING; the next run watches the recorded Deploy run;
- died before verifying → VERIFYING; the next run verifies.

Runner-shaped failures (`INFRA`, `DISPATCH`) are retried on the same head up to
three attempts; a verdict about the work (`GATE`, `MERGE`, `DEPLOY`, `VERIFY`)
is not. The campaign side (sessions, restarts, provider refusals, repairs) is
the existing queue, leases and bins — nothing here adds another.

## Unattended execution: permissions

Fired Factory workers check out this repository and load `.claude/settings.json`.
It pre-approves narrowly scoped routine commands (typecheck, impacted tests,
build, git branch work, `scripts/test-postgres.sh`, `npm run test:pg`) and
denies force pushes, pushes to the canonical branch, `flyctl`, `sudo`, and
environment dumps. There is no `Bash` or `Bash(*)` rule, and a test refuses one.

`scripts/test-postgres.sh` replaces the privileged ad hoc setup (`sudo -u
postgres`, `pg_ctlcluster`, inline `DO $$` blocks) that used to stop an
unattended session at a prompt: one throwaway cluster on loopback, owned by the
caller (or the `postgres` account when the caller is root), one `LOGIN CREATEDB`
role, never a superuser.

**Stated constraint:** OS-level sandboxing (`sandbox.enabled`) needs bubblewrap
and socat, which the cloud worker image does not ship, so it is not enabled —
enabling it there would not sandbox anything. Least privilege is carried by the
allowlist and the deny rules instead. A command outside the allowlist still
prompts; that is a defect to fix with another narrow rule, never with a wider one.

## Setup-time actions a person performs once

- Grant automatic release per objective (above).
- Optional and recommended: protect the `production` branch so only the release
  workflow's token and administrators can push. Brain cannot set branch
  protection; the workflow's pinned fast-forward and the environment's
  deployment-branch policy are what bind today.
