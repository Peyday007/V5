# Finishing an assignment, enforced (2026-11-03)

The 11-02 corrections made the definition of done impossible to lose; they
could not force it ("A model can still choose to stop"). The $10K session
(`session_01QF5Tk9P9WiYWeXRCMDcviQ`) showed the remaining failure: it read the
plan (NOT_VIABLE), merged a PR recording the reading, scheduled a check-in six
hours out (`trig_01RxbZdJruyusxb1EcdF5UJa`) and ended its turn. The status read
was done; the objective had no owner.

## Mechanism

| Piece | Owner | What it does |
|---|---|---|
| Continuation | `ralph-loop@claude-plugins-official` (enabled in `.claude/settings.json`) | Its Stop hook refuses every stop while `.claude/ralph-loop.local.md` names the session, feeding the open list back, ≤ 20 times. Its text "promise" is left unset, so nothing written ends it. No Stop hook of ours. |
| Ledger | `.claude/hooks/finish-job.mjs` (`UserPromptSubmit`) | Copies each list item of an assignment verbatim into `.claude/finish-job/<session>.json`; arms Ralph. |
| Verdict | `npm run finish -- check` | Runs each requirement's evidence itself (commands cached per tree, git, `gh api`, HTTP) and adds the repository's requirements: committed, pushed, merged into the canonical branch, Postgres suite green on the merge, Deploy succeeded when deployable files changed. Only DONE, WAITING, BLOCKED (rule-11 code) or STALLED (3 identical failing checks) remove the Ralph state. |
| Waiting | same | WAITING needs every open item to name an armed wake; a wait on a run or PR that ended stops counting. The next tool call after the wake re-arms the loop. An unchanged re-wait doubles the minimum `send_later` delay (45 → 90 → 180 … min). |
| Tamper | `PreToolUse` `*` | Refuses Write/Edit/Bash on the ledger or Ralph state except through the CLI. The owner's "stop"/"cancel" ends it. |
| Restart | `restore-objective.mjs` | After compaction or resume, restores the ledger (from the transcript, where every check prints it, if the container is fresh), re-arms Ralph, injects it beside the owner's words. `SessionStart startup` installs Ralph if a container lacks it. |

Tests: `tests/finishJob.test.ts` — the $10K replay, false DONE, genuine DONE,
independent work while waiting, ended waits, stall bound, rule-11 BLOCKED,
cancellation, compaction in a fresh container, registration. Where the plugin is
installed it runs Ralph's own `stop-hook.sh` against the state written.

## Still judgment

- Whether a piece of evidence proves the requirement it is attached to.
- Whether a wake ID names a wake that was really armed (only `run:`/`pr:` are checked).
- Whether a message is an assignment: ≥ 2 list items, or ≥ 300 characters with
  a work verb, not ending in `?`. `init` covers a miss; `dismiss` a false arm
  (first 15 minutes, nothing attached).

## Limits

- Ralph loads at session start; a container where the plugin is not installed
  gets it installed for the next session, not the current one.
- A determined session can still edit the files through a path the guard does
  not recognise. The guard stops accidents and shortcuts, not adversaries.
- STALLED and Ralph's 20-iteration cap end the loop deliberately; the ledger
  stays open and the report must say NOT DONE.
