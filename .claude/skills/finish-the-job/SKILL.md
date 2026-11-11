---
name: finish-the-job
description: Carry an owner's assignment to a verified DONE, or to a genuine WAITING or BLOCKED, under the mechanical completion check — use for every direct assignment (build, fix, ship, prove, research-to-outcome), when the FINISH-THE-JOB ledger appears in context, when Ralph Loop feeds "FINISH THE JOB" back, or after a compaction or resume. Covers attaching evidence, waiting on external results without stopping or polling, merging and deploying your own work, and the final report.
---

# Finish the Job

The owner's message is the contract, and a program — not you — decides when it is met.

## What is already running (you do not start it)

- **Ledger.** The `UserPromptSubmit` hook copies each list item of an assignment,
  verbatim, into `.claude/finish-job/<session>.json` as `R1…Rn`. Later owner
  messages with lists add requirements. `npm run finish -- status` shows it.
  If it is missing (an assignment without a list, or a fresh container), run
  `npm run finish -- init` — it reads the owner's words from the transcript.
- **The stop is refused.** The ledger arms the official **Ralph Loop** plugin
  (`.claude/ralph-loop.local.md`): its Stop hook refuses to end the turn and feeds
  the open list back, at most 20 times. Writing "DONE" does nothing. Only
  `npm run finish -- check` releases it.
- **The repository's own requirements** are added by `check`, from git and the
  GitHub API: `GIT-COMMIT`, `GIT-PUSH`, `MERGE` (into the branch in
  `.github/CANONICAL_BRANCH`), `CI` (the Postgres suite green on the merged
  commit) and `DEPLOY` (a successful Deploy containing it, when deployable
  files changed). You satisfy them by doing the work, not by attaching anything.

## The loop

1. Do the work for the next actionable requirement. Independent ones in parallel.
2. Attach evidence the checker can run **itself** — a claim you write is not evidence:
   ```
   npm run finish -- evidence R3 --cmd "npx vitest run tests/foo.test.ts"
   npm run finish -- evidence R4 --pr 455                       # merged into canonical
   npm run finish -- evidence R5 --workflow deploy.yml --pr 455   # released that merge
   npm run finish -- evidence R6 --http https://… --expect "…"
   npm run finish -- evidence R1 --covered R3,R4,R5             # a heading over its items
   ```
   A command that cannot fail (`true`, `echo`, `… || true`) is refused. Results are
   cached per tree, so re-checking unchanged work costs nothing and repeats nothing.
3. `npm run finish -- check`. It prints one verdict:

| verdict | meaning | what you do |
|---|---|---|
| `CONTINUE` | something is actionable now | do it; the stop stays refused |
| `WAITING` | every open item waits on an armed wake | end the turn; the stop is released |
| `BLOCKED` | everything left has a rule-11 reason | final report: **NOT DONE**, each blocker |
| `CONTINUE — CHANGE STRATEGY` | the same failing state 3 checks in a row, the first time since progress | the stop stays refused: a different hypothesis, path or owner (Factory, or the maintainer route for a protected file); never the same attempt |
| `STALLED` | the same failing state again after a strategy change | final report: **NOT DONE**; never retry the same attempt |
| `DONE` | every requirement's evidence passed and the repository checks passed | final report: **DONE** |

## Waiting (the failure this exists for)

On 2026-11-03 the $10K session read the plan (NOT_VIABLE), merged a PR recording
the reading, scheduled a check-in six hours out, and stopped. A status read and a
scheduled check are not the objective. Here:

- A wait is recorded per requirement, naming what it waits on **and the wake you
  already armed**: `npm run finish -- wait R7 --on "Goals plan run" --wake run:41574598841`
  (`monitor:<id>`, `task:<id>`, `pr:<n>`, `run:<id>`, `trigger:<id>`). Arm the
  wake first — a Monitor or background task on the real process, a subscribed
  PR, or `send_later` only for what nothing can watch.
- While **anything** else is actionable the verdict is `CONTINUE`: keep working.
- A wait on a run or PR that has already ended stops counting — act on its result.
- When everything open is waiting, `check` says `WAITING` and releases the stop.
  The ledger stays open. Your first tool call after the wake re-arms the loop, so
  the assignment resumes, not just the status read.
- Re-waiting on an unchanged state doubles the minimum `send_later` delay
  (45 → 90 → 180 min…, enforced by the hook). Watch the event instead of polling.

## Blocked

Only the rule-11 reasons (`SPEND_OVER_CEILING`, `IRREVERSIBLE_PRODUCTION_LOSS`,
`LEGAL_RISK`, `SECRET_EXPOSED`, `MAJOR_NEWS`, `MISSING_AUTHORITY`):
`npm run finish -- block R9 --code MISSING_AUTHORITY --detail "needs the Square login"`.
A merge, a deploy or a routine decision is never a blocker — it is yours.

## Rules the checker cannot see, so you keep them

- Evidence must prove the requirement it is attached to. A test of something
  else, or a probe of the wrong URL, passes the checker and is a lie.
- Never narrow a requirement: `npm run finish -- add "<text>"` adds work you
  discover; nothing removes the owner's.
- The owner ends an assignment early by saying "stop" or "cancel"; nothing else does.
- `dismiss --reason` exists only for a message that was not an assignment
  (first 15 minutes, before any evidence or commit).

## Final report

The verdict word is the report's first word: `DONE` only after a `DONE` check in
this turn; otherwise **NOT DONE** with every open, waiting or blocked item and its
reason as `check` printed it. Then DECIDED / YOU DO / BIG NEWS per CLAUDE.md.
