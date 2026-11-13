---
name: factory-objective
description: Hand a coding objective to Brain's Factory and carry it to a verified DONE without supervising it — use when the owner asks Factory to build, fix or ship something ("factory: …", "give this to Factory", "run this through Factory"). Submits, approves, waits on one watched run, merges/deploys what the session is authorized to, verifies on production, and sends exactly one final message.
---

# A Factory objective, submitted to finished

The owner submits an objective and the next substantive message they get is that
it is finished (or the one thing only they can do). Nothing in between: no
"planning started", "PR opened", "tests passed", "waiting". Progress lives in
Brain's rows; `factory outcome` reads it on demand.

## 1. Write the objective, push it, submit — no deploy needed

1. Write `objectives/<slug>.json` with `objective`, `expectedOutcome`, `nonGoals`,
   `acceptanceConditions` (`[{statement, verification}]` — each verifiable on
   production), `mutationScope` (globs), and a `submissionKey`. Name any external
   host the work needs in the objective: a worker that cannot reach it fails at
   planning, not after every unit.
2. Commit and push it to your branch.
3. Dispatch `factory.yml`: `command=submit file=objectives/<slug>.json extra="--ref <your-branch>"`.
   `--ref` reads the file from your branch through the forge, so it does not have
   to be merged and deployed first. The change request id (`fcr_…`) is in the run's
   annotations.
4. `command=approve change_request=fcr_…` (the owner's standing order covers it).
   If the contract's risk class is LOW, also `command=authorize-release
   change_request=fcr_… admin=<owner admin> file=objectives/<slug>.json extra="--ref <branch>"`,
   so Factory merges, deploys and verifies by itself (§58).
5. The campaign id (`fcp_…`) is printed by approve.

## 2. Wait on one run, not a polling loop

Dispatch `command=wait campaign=fcp_…`. That one run probes `factory outcome`
every fifteen minutes on its own and ends when the objective does (or after ~5.6 h,
printing `FACTORY-WAIT: STILL-RUNNING`). Watch **that run** to termination in the
background — GitHub's API only, never Brain's database:

```
until [ "$(gh api repos/Peyday007/V5/actions/runs/$RUN --jq .status)" = completed ]; do sleep 60; done
```

(run with `run_in_background`), then end the turn. The completion wakes you.
Never dispatch `status` on a timer: 41 of 60 factory.yml runs once were that.

## 3. On wake: act on the terminal line

Read the run's annotations for `FACTORY-OUTCOME-TERMINAL:` (or `STILL-RUNNING`).

| line | what you do |
|---|---|
| `LIVE` | Verify every acceptance condition yourself on production. Then the final report. |
| `BLOCKED (needs: Read and merge <pr>…)` | Yours, by the owner's standing order (never his): read the diff, merge it, dispatch `Deploy` on `production`, then `wait` again. |
| `BLOCKED (needs: Dispatch Deploy…)` | Dispatch `Deploy` on `production`, then `wait` again. |
| `BLOCKED (needs: MAINTAINER: …)` — `PROTECTED_SCOPE` | The scope is one no Factory worker may change (release gate, workflows, `.claude/**`). You are the maintainer: make the change directly on your branch, merge it, dispatch `Deploy`, verify — or `amend` the scope to writable paths and `wait` again. Never the owner's. |
| `BLOCKED (needs: …regrant/amend/widen/name the file…)` — detail *"Stopped until the submitting session amends the contract"* | Fix it through the operator door (`amend`, `regrant-unit`, `reauthorize`) and `wait` again — unless the need is a rule-11 reason. |
| `CANCELLED` | Find out why (`factory status`), resubmit if the objective still stands, else report. |
| `STILL-RUNNING` | Dispatch `wait` again. |

`factory outcome` is LIVE only when production runs the work: a merged pull request
production does not run yet is `BLOCKED (Dispatch Deploy)`, and one closed unmerged
is `CANCELLED` (`server/services/factory/delivery.ts`).

## 4. One final message

CLAUDE.md's format: `DONE` (what was delivered, where, the production evidence for
each acceptance condition, material limitations) or `NOT DONE` / `BLOCKED` with the
exact unmet requirement and the exact action. Send it once, and call
`PushNotification` with its first line so it reaches the owner's phone.
