# Autonomous execution: authority, continuation, completion — 2026-11-11

The objective: one instruction, and Brain builds, tests, repairs, integrates and
verifies without routine owner intervention. Every figure below was read from
production rows (`factory.yml` runs on `production`) or session records. Nothing
new was built beside the existing Factory, finish-job ledger and Ralph Loop.

## What was actually denied

### Factory (production, `factory campaigns`, 137 campaigns)

85 LIVE, 17 CANCELLED, 13 BUILDING, **22 BLOCKED on a person**. The blockers
read for the newest ones:

| campaign | blocker | what the rows say |
|---|---|---|
| `fcp_17725629` | `UNIT_EXHAUSTED_ATTEMPTS` (planning) | Whole scope is `server/services/factory/release/outcome.ts`, which the V5 grant forbids to workers (`release/**`). The plan bin was handed out **38+ times** (2026-11-09 16:14 → 11-11 03:19). Every worker read the grant and wrote the same thing: "the only mutation-scope path is forbidden". Then the campaign parked on the owner. |
| `fcp_0cdb6b11` | `UNIT_EXHAUSTED_ATTEMPTS` | Two repairs disagree on one line. The integrator may not edit, so a reconciling unit is needed. Three attempts went to the same conflict. |
| `fcp_4ad48edf` | integration stage exhausted | `FACTORY_TICK_FAILED` twice, plus two review findings. |

`fcp_17725629` is the failure the owner described: a worker repeatedly
planning work it can never execute, then a protection with no resolution path
except the owner.

### Claude Code (40 recent sessions, ~800 tool decisions)

- 731 decisions were allowed by a rule. No prompt timed out and no user denied
  anything in the sample.
- **92 of 100 session inits ran in `default` permission mode.** In that mode,
  compound shell commands (`a && b`, loops, heredocs), `gh api`/`curl` reads and
  remote-trigger tools are not covered by the project allow-list. They passed only
  where auto mode's classifier approved them.
- `mcp__claude-code-remote__delete_trigger` waited for the owner once. That is
  correct: deleting a scheduled task deletes its sessions.
- Hooks: `finish-job.mjs`'s tamper guard refused one read-only script that named
  the ledger path. `engineering-guard.mjs` refused nothing.
- **In this session**, the finish-job ledger accepted a subagent's report
  (`<agent-message …>`) as 16 owner requirements (R18–R33). It had also glued the
  owner's PRIORITY 1–3 paragraphs onto one bullet.

## What changed (PR #712, merged and deployed)

| defect | fix | test |
|---|---|---|
| Work no worker may do is dispatched to worker after worker | `scopeOnlyForbidden` is checked before planning. No plan bin is made, a waiting one is retired, and the campaign blocks `PROTECTED_SCOPE` with a new `MAINTAINER` wait. Like PERSON, a MAINTAINER block holds no files and is not re-ticked, but it is not the owner's. The outcome reads `MAINTAINER: …`, and `factory-objective` tells the waiting session to make the change itself. An amended scope plans on the next tick. | `tests/factoryProtectedScope.test.ts` |
| Owner's prose requirements lost inside a bullet | A blank line ends an item. Paragraphs after the first item are requirements, prefixed by their heading. | `tests/finishJob.test.ts` |
| A subagent's report became owner requirements | `HARNESS_NOTICE` also matches `<agent-message>`, `<teammate-message>`, `<webhook-payload>` and `[SYSTEM NOTIFICATION`. | `tests/finishJob.test.ts` |
| A repeated identical failure ended the session (STALLED) | The first stall since progress is `CONTINUE — CHANGE STRATEGY`: same refusal of the stop, with a prompt demanding a different hypothesis, path or owner. A second stall is STALLED. | `tests/finishJob.test.ts` |
| Ralph's 20-iteration limit ended long objectives that kept moving | A newly verified requirement resets the iteration count. The limit now bounds unproductive stops only. | `tests/finishJob.test.ts` |

Boundaries unchanged: the deny list (force-push, production pushes, `flyctl`,
`sudo`, secrets, `.env`), the repository grant's forbidden paths, and the release
gate's risk rule. The demonstration hit that last one: the contract classed it
MEDIUM, so it finished at a PR that the session merged.

## Permission prompts: the change that needs the owner

Editing `.claude/settings.json`'s allow-list from inside a session was refused by
the Claude Code auto-mode classifier as self-modification. That is a boundary on
the agent, and it was not worked around. These rules cover the routine
operations that prompt in `default` mode. Add them to `permissions.allow`:

```
"Bash(cat:*)", "Bash(sed -n:*)", "Bash(find:*)", "Bash(jq:*)", "Bash(sort:*)", "Bash(uniq:*)",
"Bash(cut:*)", "Bash(diff:*)", "Bash(echo:*)", "Bash(date:*)", "Bash(which:*)", "Bash(test:*)",
"Bash(timeout:*)", "Bash(npm run:*)", "Bash(npm test:*)", "Bash(npx vitest:*)",
"Bash(npx tsx scripts/:*)", "Bash(node scripts/:*)", "Bash(git merge:*)", "Bash(git stash:*)",
"Bash(git pull origin:*)",
"mcp__github__get_*", "mcp__github__list_*", "mcp__github__actions_get", "mcp__github__actions_list",
"mcp__github__get_job_logs", "mcp__github__actions_run_trigger", "mcp__github__pull_request_read",
"mcp__github__create_pull_request", "mcp__github__update_pull_request",
"mcp__github__update_pull_request_branch", "mcp__github__merge_pull_request",
"mcp__github__create_branch", "mcp__github__add_issue_comment",
"mcp__claude-code-remote__send_later", "mcp__claude-code-remote__create_trigger",
"mcp__claude-code-remote__update_trigger", "mcp__claude-code-remote__list_triggers",
"mcp__claude-code-remote__get_trigger", "mcp__claude-code-remote__subscribe_pr_activity",
"mcp__claude-code-remote__unsubscribe_pr_activity", "Monitor", "TaskStop"
```

Left out on purpose: `gh api`/`curl` (a prefix rule cannot stop `-X DELETE`),
`python3` (arbitrary execution), `delete_trigger` (it deletes sessions),
`request_credential` and environment edits.

## Verified on production, and what production then showed

- **`fcp_17725629` is off the owner.** After #712 and #717 deployed, its outcome
  reads *"Routed to the maintainer: no Factory worker may change this scope"*
  with `MAINTAINER: … no owner action` (recorded 2026-11-11T08:22:46Z). It had
  read *"Stopped until a person acts"* since 11-09. #717 was needed because
  program campaigns always add a writable `tests/program-…*.test.ts` to their
  scope. The first rule (every path forbidden) therefore never matched. Test
  globs are now no way in.
- **A contract could not be corrected from a session.** `factory.yml`'s
  `extra` refuses quotes and splits on spaces, so `amend` could not carry an
  acceptance condition. #723 adds `amend --value-file <path> [--ref <branch>]`.
- **Deploy livelock.** Between 08:31 and 09:25, eleven Deploy runs ended
  `success` with their `Deploy to Fly` job skipped. Each was superseded by a
  newer canonical tip while its ~15-minute gate ran, because parallel sessions
  merged faster than that. Nothing reached production after 08:20. The
  finish-job checker read every one as a release. It now requires the Fly job's
  own success (`tests/finishJob.test.ts`). The livelock itself is left as
  §28/invariant 36 has it, because the fix is a policy change: a superseded run
  could still release when its commit *descends from the running revision*.
  That is forward progress and never a rollback, but it is not "the tip". It is
  recorded here as the recommended change, not made.

## The demonstration

One instruction: a live defect in `server/services/documents/normalize.ts`.
`SOFT_HYPHEN_BREAK` turned "pre- and post-closing" into "preand post-closing" in
`normalized_text`, which retrieval and audits read. An earlier Factory campaign
on it (`fcp_4bc9ef45`) had run out of attempts and parked on the owner.

What happened, in order (owner interventions: **0**):

| # | event | who resolved it |
|---|---|---|
| 1 | `objectives/normalize-suspended-hyphen-v2.json` submitted, approved, planned (`fcp_b11abd00`). | session → Factory |
| 2 | **Failure.** Two implementer attempts refused: `tests/documents.test.ts:704` asserts the defect ('di- ation' → 'intermediation'), so A03 contradicted A01. | session amended the scope and regranted the unit (`regrant-unit --why ownership-widened`) |
| 3 | **Failure.** The worker read A03 as forbidding the fixture edit. `amend` could not carry prose through `factory.yml` (`extra` refuses quotes). | #723 added `amend --value-file`. The Deploy livelock (above) kept it off production, so the session **changed strategy**: it retired `fcp_b11abd00` and resubmitted the corrected contract as v3. |
| 4 | **Temporary outage.** The v3 submit hit the forge's hourly read budget. | waited for the window, resubmitted (`fcr_3f494a99`) |
| 5 | **Interruption.** This session's context was compacted mid-run and its watcher was killed at its time limit. The Factory kept working on its own: campaign `fcp_ef7bb04a` planned in 35s, and a worker wrote the fix and test and integrated it (attempt 1/3). The resumed session read the state from production rows. | Factory, durable state |
| 6 | **Failure found by Brain itself.** The independent review found a regression: a hyphen before CRLF (`'recog-\r\nnition'`) was no longer rejoined. Brain created `repair-F1` without being asked. | Factory review → repair unit |

| 7 | **Failure in Factory itself.** A scope amendment read "Stopped until a person acts", and the amended campaign was never re-ticked. | #747: contract blockers read as the submitting session's; `amend` ticks a parked campaign |
| 8 | **A second review found a correct MAJOR defect.** Every extractor flattened line breaks to spaces, so after the fix a PDF line-wrap hyphen ("recog-" / "nition") would stay split. Factory asked for four more files. | session amended the scope (routine, not the owner's) |
| 9 | **Failure in Factory itself.** Both reviews numbered their finding `F1`. The MAJOR one was attached to the first review's INTEGRATED `repair-F1` and marked REPAIRED on a commit that never touched it. The campaign then reported COMPLETE, so #748 alone would have shipped the regression. | #749: one repair unit per finding (`tests/factoryRepairKeyPerFinding.test.ts`). Session held #748 and submitted the follow-up `objectives/extractor-line-wrap-hyphen.json` on #748's branch. |
| 10 | **Temporary outage.** The forge read budget again, then GitHub runners failed DNS for the Ubuntu mirrors in every Postgres shard. | waited for the reset; reran the failed shards |
| 11 | Follow-up campaign `fcp_200e1076` built, reviewed and opened #750 (one shared line joiner in pdf/ocr/text/extraction). | session reviewed it, ran its tests, and merged #750 into #748, then #748 into `production` (1f8ad02) |

| 12 | **Outage, and a strategy change.** Every Postgres suite from 13:32 failed DNS for `azure.archive.ubuntu.com`, and reruns repeated it. | #753: the install retries fall back to `archive.ubuntu.com`. The suite then passed 10/10 on aa06483. |
| 13 | **Released.** Deploy 43065787279 released aa06483, which contains the demo merge 1f8ad02. The hosted verification passed before the restart. After it, one MCP call timed out (`could-not-complete`), and the workflow mislabelled that BEHAVIOUR DEFECTIVE. | labelled correctly in deploy.yml; the next Deploy re-verifies |
| 14 | **Verified on production.** `factory release-revision` on the live machine: `aa064839…`. The demo's acceptance tests pass at that revision (`normalizeSuspendedHyphen`, `extractorLineWrapHyphen`, `documents`: 67/67), as did Deploy's own test job on the same commit. | session |
| 15 | **Post-restart verification failed three times, on a different call each time.** The fault lined up with Factory release SSH sessions, which run operator commands at full priority on the 2-CPU machine and starve the server's health checks. | #760: every `scripts/*.sh` operator wrapper runs `nice -n 19`. |
| 16 | **Session error.** While merging #760 the session merged #758 by guessing the PR number. #758 was a Factory program PR (MONEY-13-4), and it pushed the goal plan's statement budget to 159 against a limit of 120, which turned the Postgres suite red. Bisecting confirmed #758 as the cause. | #761 reverts it (goalPlan 60/60 again). Campaign `fcp_e60b337d`'s branch is intact, so its program can redo the requirement within the budget. The rule now is to merge only the PR number `create_pull_request` returned. |
| 17 | **Outage.** GitHub's artifact upload returned HTML in Postgres shards 3 and 4 on fd070ee. The tests themselves passed. | the failed shards reran |

Owner interventions: **0**. Every block was a routine contract correction, a
merge the owner's standing order assigns to the session, or a temporary outage.
