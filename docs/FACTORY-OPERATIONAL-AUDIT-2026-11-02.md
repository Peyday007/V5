# Factory operational audit and autonomy gap analysis — 2026-11-02

Window: 2026-10-19 → 2026-11-02, widened to 2026-10-01 → 2026-11-02 for the Software
Factory campaigns. Sources:

- GitHub: 170 PRs, 133 Deploy runs, 400 `factory-release` runs, 162 `postgres-suite` runs
- `git log origin/production`
- the `factory campaigns` listing from Actions run 41285269101 (93 campaigns)
- the owner's Claude Code session transcripts, read through the remote-session API
- the code at `dd2f40e`

Labels: **[OBS]** is observed in records, **[EST]** is an estimate with its method given,
and **UNKNOWN** means not established.

---

## The answer, first

**What stops Factory from carrying one instruction to verified completion is mostly not
missing machinery. It is three structural facts.**

1. **The work does not go through Factory.**
   - 94% of shipped changes (161 of 170 PRs in 14 days) come from owner-driven Claude Code
     sessions on `claude/*` branches.
   - These sessions have none of Factory's stage ownership. Nobody owns them after merge:
     they open and merge their own PR in a median of **8 seconds** with no CI, dispatch
     Deploy, and report done.
   - The Software Factory pipeline delivered **1 PR in 14 days** (#361). It took 15 h to
     merge, and the owner merged it with 2 of 6 acceptance conditions marked **NOT_MET**.
   - Across October, 18 of 286 merged PRs (6.3%) came from Factory campaigns.
   - Only 6 went live with nobody involved after approval, all one-sentence UI hints. The
     last was on 10-12.
   - **51 Factory PRs whose campaigns reached COMPLETE are still open and unmerged.**

2. **"Done" is never checked against the owner's outcome in production, by either path.**
   - A session stops at "merged and deployed".
   - A Factory campaign stops at "review passed", or at LIVE, which is only owner-written
     string probes (`release/verify.ts:83-109`).
   - Acceptance conditions are never evaluated in production.
   - The Deploy verdict cannot fill the gap. It fails **68% of the time** (90 of 132
     completed runs failed or were cancelled), mostly after the image was already released,
     on a scripted harness that has nothing to do with the change. The longest stretch was
     **8.6 days with no successful Deploy** (#520 → #568).
   - So nobody, human or machine, gets a reliable "it works in production" signal, and the
     owner becomes the production detector.
   - 70% of the owner's follow-up prompts are corrections or reports of missed failures.

3. **Nothing turns a failure into work, and nothing coordinates the sessions.**
   - No code path turns a production defect, a red CI run, a failed Deploy verdict, a failed
     LIVE check or a watchdog reading into an objective.
   - `watchIdleOnTick` is record-only (`services/engineering/watchdog.ts:87-91`,
     `continueWork: false`).
   - A FAILED release is terminal (`release/plan.ts:120`).
   - Parallel owner sessions have no claim on the files they change. The Factory's
     mutation-surface exclusion (`line.ts`, `remoteLoop.ts`) covers campaigns only. That is
     how #400 reversed half of #389 fifteen hours after it shipped, and how the owner ended
     up relaying results between sessions and pasting the same prompt into two of them.

**Underneath all three is a compounding cost.** Every correction is appended to `CLAUDE.md`
as narrative. The file is now **1,006,613 bytes, 14,789 lines, roughly 250k tokens**. It was
52 KB on 2026-09-01 and 842 KB on 2026-10-01. Every owner session and every fleet worker
that checks out the repository loads all of it. Each recorded fix makes every future session
slower and more likely to compact, which shows up as the next correction prompt. **Factory is
accumulating maintenance obligations faster than reliable capabilities.**

**The smallest permanent correction set (section H)** extends what already exists:

| # | Correction | Extends |
|---|---|---|
| 1 | A completion contract enforced at session stop | the existing engineering-guard hook and `brain_evidence_record` |
| 2 | Per-objective production checks, used by sessions as well as campaigns | `release/verify.ts` live checks |
| 3 | A Deploy verdict that says one thing: is the released commit serving, and did its own checks pass | Deploy, with the scripted harness made non-gating and reported separately |
| 4 | Failures become objectives | watchdog → submit; FAILED release → repair campaign |
| 5 | Sessions claim paths | Factory's unit ownership line, opened to `claude/*` sessions through `brain_engineering_preflight` |
| 6 | Clear the 51-PR backlog and fix the keyword risk classifier | release gate |
| 7 | Split CLAUDE.md into a rules file under 40 KB and a history document | — |

**Proof (section J):**

| Measure | Target | Today |
|---|---|---|
| Owner prompts per objective | median 1 | median 2, p90 3, only 1 of 9 sessions single-prompt |
| Deploy verdict success | > 90% | 32% |
| Merge → verified-in-production | hours, not days | median 291 min, p90 5.8 days |
| Corrections among owner follow-ups | 0 | 50% |
| Open COMPLETE Factory PRs | 0 | 51 |

---

## A. Factory architecture: the real flow

There are **two delivery paths**, and almost all work uses the one that has no Factory
ownership.

### A1. The path that carries the work: owner → Claude Code session → production [OBS]

```
owner types a prompt on a phone
  → a cloud Claude Code session reads CLAUDE.md (~250k tokens) and the repo
  → it edits code, runs typecheck + test:impacted itself
  → it opens a claude/* PR and merges it itself (median 8 s; 122/161 within 1 min)
  → it dispatches Deploy (workflow_dispatch only; no CI on PRs)
  → Deploy: guard → test shards → build → flyctl deploy (image released)
       → hosted verification (scripted harness) → verdict
  → the session reports DONE / review_ready
  → the owner checks production and finds what is wrong → a new prompt or a new session
```

| Stage | Owner | Exists / works |
|---|---|---|
| Intake and interpretation | the session's model, from the owner's prose | works, but not persisted; no acceptance record |
| Prerequisite discovery | the session, ad hoc | PARTIAL: stops at the first missing prerequisite |
| Planning and decomposition | the session | no record |
| Coordination with other sessions | **nobody** | MISSING |
| Code | the session | works |
| Tests | the session (`test:impacted`), then Deploy's shards, then `postgres-suite` on push | works; production tip red on 10.7% of pushes |
| PR / merge | the session merges its own PR | works, with no review or CI gate |
| Deploy | Deploy workflow, dispatched by the session | releases reliably; the **verdict is red 68% of the time** |
| Production verification of the outcome | **nobody** | MISSING |
| Failure → repair | **the owner** | MISSING |
| Completion report | the session's final message | works, but often claims done while the goal is unmet |
| Learning | appended to CLAUDE.md as prose | counterproductive (section F) |

### A2. The Software Factory pipeline: Build/Russell/Cash → campaign → PR [OBS, from code]

| Stage | Owner file | Live? | Verdict |
|---|---|---|---|
| Intake | `routes/factory.ts:207`, `scripts/factory.ts`, `russell/software.ts:687`, `cash/factoryHandoff.ts:221`, `cash/journey/fulfillment.ts:1407`, `realize/handoff.ts:101` | Build, terminal and Russell are used; no production record of the other three firing | PARTIAL |
| Risk | `contract.ts:322-326`, a keyword regex | yes | PARTIAL: "production", "auth", "migration" or "deploy" in the text makes it HIGH |
| Approval | `start.ts` | a person, except cash handoff under the standing grant | works |
| Plan / units / ownership | `architect.ts`, `planner.ts`, `ownership.ts`, `remoteLoop.ts:175` | 20 s tick | works; the plan bin waited 2h07m on fcp_0b8d9fcc [OBS, #361 body] |
| Fleet dispatch | `dispatch/loop.ts`, `bins/routing.ts` | yes | works; `FLEET_TARGET_REACHED` starved units until #349 and #357 |
| Implement / integrate / review / repair | `remoteLoop.ts`, `integrate.ts`, `review.ts`, `repair.ts` | yes | works for small changes; large ones exhaust attempts |
| PR | `pullRequest.ts` | yes | works |
| Merge | `factory-release` workflow | **only LOW risk with an owner grant** (`release/gate.ts:56-63`) | narrow |
| Reserved from automatic release | `domain/factoryRelease.ts:163-224` | — | 21.7% of `server/` lines; **41% of October's production changes touched a reserved path** (40 of them migrations) |
| LIVE check | `release/verify.ts:83-133` | yes | owner-written string probes only |
| Failed LIVE | `release/plan.ts:120` | terminal | no re-entry; rollback blocked because Actions may not open PRs (fcp_4cc6c148 stayed live at FAILED) |
| Learning | `metrics.ts`, `throughput.ts` | report only | MISSING feedback |

### Stages with no effective owner today

- outcome verification in production
- turning a failure into an objective
- coordination between sessions
- merging COMPLETE Factory PRs
- retiring stale PRs: #266–#273 have been open 11–12 days, and #348 and #391 are also open
- learning that removes a failure class rather than describing it

---

## B. Performance baseline

### B1. Throughput [OBS]

| Measure | Value |
|---|---|
| PRs created, 10-19 → 11-02 | 170 (#231–#400) |
| Merged | 161 (94.7%); 1 closed unmerged; 8 open |
| Merges per day | mean 11.5; peak 23–24 on 10-30 and 10-31; 3 on 10-25 |
| Median PR size | 3 files, 71 lines |
| Factory campaign PRs in window | **1** (#361) |
| Factory campaigns, 10-01 → 11-02 | about 47; 18 PRs merged (6.3% of 286); 6 auto-released (all one-line UI hints); **51 COMPLETE PRs unmerged**; 9 of the 10 open BLOCKED campaigns are `UNIT_EXHAUSTED_ATTEMPTS` or `SCOPE_AMENDMENT_REQUIRED` |
| `factory-release` | 400 runs; `RELEASE-PLAN: null` on every inspected run since 10-12; nothing released |

### B2. Deploy [OBS]

| Measure | Value |
|---|---|
| Runs | 133 |
| Success | 42 (32%) |
| Failure | 79 |
| Cancelled | 11 |
| Median duration, success | 22.1 min (p90 47.1) |
| Median duration, failure | 78.2 min (p90 129.3, max 224.7) |
| Longest streak with no successful Deploy | **8.6 days** (#520 on 10-21 → #568 on 10-29; 47 runs) |
| Merge → first Deploy containing the change finished | median 72 min, p90 174 min |
| Merge → first **successful** Deploy containing the change | **median 291 min, p90 8,331 min (5.8 days)** |
| Failure shape (3 sampled: #523, #557, #618) [EST] | image released in all three; the hosted verification and verdict failed |

**Deploy 618** (the #389 commit) [OBS]:
- `flyctl deploy` succeeded and the image was released.
- The pre-restart verification failed in 4 s: `EMAXCONNSESSION … pool_size: 15`, the
  shared Supabase session pooler. The app logged the same error in the same second.
- Post-restart it scored 274/275, and the one failure followed from the first pass never
  running.
- **Cause: connection saturation, not the change.** Deploy 619 succeeded 13.9 h later.

### B3. Per-objective timing

Sessions record none of the following stage times, so for the session path they are
**UNKNOWN**:

- planning, research, editing and test-fix time
- time waiting on tools or models
- queue time
- idle time

**What is established [OBS]:**
- Owner sessions run 3.5 h to 16 h+ (01QF5Tk8abZ: about 16 h and not yet done).
- Merge → verified-in-production is UNKNOWN for every objective: there is no
  outcome-verification step.
- For the 6 auto-released Factory campaigns, approval → LIVE was 2h20m to 3h14m, and
  PR open → merge 4 to 68 min.

The smallest way to measure the session path is a session-start and session-end row through
`brain_engineering_preflight` and `brain_evidence_record` (both exist), carrying the
objective id. See correction H1.

### B4. Owner burden [OBS where read; a lower bound everywhere]

- **Coverage.** 16 owner sessions in the window: 4 read completely, 6 read through
  compaction summaries, 6 unreadable (UNKNOWN). Measured on the 10 readable ones.

| Measure | Value |
|---|---|
| Owner prompts per objective | median **2**, p90 **3** (lower bound) |
| Sessions completed on one prompt | 2 of 10. One of those is a duplicate of another session's prompt, so in effect 1 of 9 |
| Follow-up prompts, by class | CORRECTION 5 (50%), CONTINUE 2 (20%), MISSED_DETECTION 2 (20%), NEW_SCOPE 1 (10%), DECISION/AUTHORIZATION **0** |
| Follow-ups that were necessary (answering a genuine question) | **0 of 10** |
| Sessions that closed "done" while the goal was unmet | at least 4: "0 qualified", "0 jobs", "NOT_VIABLE", "can't call the Routines more productive" |
| Re-opened objectives | cash generation (4 sessions in 33 h, $0 collected); parked research packets (3 sessions: 132 → 225 → 138); account-usage waste (3 sessions); the $10K mechanism goal (4 sessions, one a duplicate prompt) |

**Representative owner quotes [OBS]:**
- "THIS IS AN EXECUTION TASK, NOT AN INVESTIGATION … Do not conclude that the mission is
  complete merely because code was merged" (01F1oj6)
- "Do not return at 'PR ready' when an authorized completion path exists" (01QF5Tk93)
- "Stop escalating routine decisions to me." (01QF5Tk5fH)
- "PR #246 is confirmed live … Return to the original assignment." (01KZfTU — the owner
  relaying between sessions)

### B5. Quality [OBS / EST]

- About 16–22% of merged PRs correct something shipped in the prior 48 h **[EST]**:
  title semantics plus file overlap. Nine were explicit test, CI or flake fixes.
- Chains:
  - #358 → #364 → #371: migration numbering, three tries in 17 h
  - #362 → #363: 22 min apart
  - #333 → #334: 1h47m apart
  - #373 → #375 → #382
  - eight PRs just to make report output readable (#340–#342, #347–#351, #367, #369)
- `postgres-suite` was red on 10.7% of production pushes (16 of 149), about 3% of
  wall-clock time.

---

## C. Bottleneck ranking (by measured impact on time to verified outcome)

1. **No outcome verification, so correction loops run through the owner.**
   - Measured as half of all owner follow-ups.
   - Re-opened objectives span 3–4 sessions of 3–16 h each.
   - This is the largest cost, and it compounds.

2. **The Deploy verdict is noise.**
   - Merge → successful Deploy: median 4.9 h, p90 5.8 days.
   - The 8.6-day drought meant no change in that period could be shown working by the
     pipeline.
   - Cause: post-release harness failures, pooler saturation (`EMAXCONNSESSION`, pool 15
     shared by the app, the harness and Supabase Storage), and OOM before #379. The change
     itself was not the cause.

3. **Large Factory objectives stall at person-only transitions.**
   - 9 of 10 BLOCKED campaigns are waiting on attempt ceilings or scope amendments.
   - 51 COMPLETE PRs wait on a merge nobody owns.
   - Big objectives (screening, Magic, throughput v1, GOAL_BUDGET) ended BLOCKED or
     cancelled, then were redone by hand in a session: fcp_0b8d9fcc→#366, fcp_0157a2bc→#399,
     fcp_085a9ec7→#121. The Factory time was spent twice.

4. **Context load.**
   - About 250k tokens of CLAUDE.md per session forces early compaction.
   - 6 of 16 sessions were only readable through compaction summaries.
   - Compaction shows up as lost tasks ("earlier truncated task message — not visible") and
     re-asking.
   - The time cost is UNKNOWN; the fix is cheap and reversible.

5. **Dispatch starvation of Factory bins** (measured before #349/#357): a 2h07m plan wait,
   one unit per campaign in flight, every dispatch reading `FLEET_TARGET_REACHED`. This is
   largely fixed. The remaining queue delay can now be measured with `factory throughput`.

### Why the fastest jobs were fast

- **The fastest were 6 Factory UI-hint campaigns, approval → LIVE in 2h20m to 3h14m.** Each
  was one LOW-risk sentence, with an owner grant written in advance and live checks
  specified up front.
- **Short sessions also finished fast.** For example, 01FD8NL was one prompt, and the
  deliverable was a report rather than a production outcome.

Reproducible difference: **the outcome was stated as a checkable production condition before
work started, and nothing on the path needed a person.**

### Why the slowest were slow

The slowest were the cash-generation and mechanism objectives, at 3–4 sessions each:
- the outcome was a business result (money, a qualified opening);
- no production check was defined;
- the sessions stopped at an intermediate milestone (code merged);
- parallel sessions changed overlapping files (#389/#400).

---

## D. Autonomy failure analysis

Each pattern below gives its root cause, the component, the ownership gap, why recovery did
not happen, its frequency, its cost, the fix, and how to verify the fix.

**D1. Stopping at an intermediate milestone (premature completion)**
- **Root cause:** no recorded acceptance condition per objective; a session's stop is
  unconstrained.
- **Component:** owner sessions.
- **Ownership:** missing.
- **Why recovery did not happen:** CLAUDE.md rule 5 states the rule, but nothing enforces
  it. The engineering-guard hook enforces only two edges: a full test suite and short
  check-ins.
- **Frequency:** at least 4 of 10 measured sessions; 5 CORRECTION prompts.
- **Cost:** one extra session or prompt per occurrence, i.e. hours.
- **Fix:** H1.
- **Verification:** a Stop hook refusal is logged, and CORRECTION prompts fall to 0.

**D2. The owner detects production failures**
- **Root cause:** no per-objective production check, and the Deploy verdict is unreliable.
- **Components:** Deploy and `release/verify.ts`.
- **Ownership:** ineffective.
- **Why recovery did not happen:** a red verdict is the normal state, so it carries no
  information.
- **Frequency:** 2 MISSED_DETECTION prompts.
- **Cost:** the 8.6-day drought; median 4.9 h to a green verdict.
- **Fix:** H2 and H3.
- **Verification:** verdict success above 90%, and objective checks recorded on the
  released SHA.

**D3. Failures are not turned into work**
- **Root cause:** watchdog `continueWork: false`; FAILED release is terminal; no
  defect → objective writer.
- **Components:** `services/engineering/watchdog.ts`, `release/plan.ts:120`.
- **Ownership:** missing.
- **Frequency:** every red Deploy (79) and every FAILED campaign.
- **Fix:** H4.
- **Verification:** a forced verify failure produces a repair campaign with no owner
  prompt.

**D4. Large campaigns block on person-only answers**
- **Root cause:** `UNIT_EXHAUSTED_ATTEMPTS` and `SCOPE_AMENDMENT_REQUIRED` resolve only
  through a person. The keyword risk classifier blocks auto-release of anything that names
  production.
- **Components:** `regrant.ts`, `repair.ts`, `contract.ts:322`.
- **Ownership:** ineffective.
- **Frequency:** 9 of 10 blocked campaigns.
- **Fix:** H6.
- **Verification:** the BLOCKED backlog drains with no owner prompt.

**D5. Parallel sessions collide**
- **Root cause:** `claude/*` sessions take no claim on paths. `preflight` and
  `duplicateMechanismCheck` are advisory (`domain/engineering.ts:348, 456`).
- **Ownership:** missing.
- **Evidence:** #389 → #400 partly reversed within 15 h; the owner pasted a duplicate prompt
  into two sessions; 8 PRs are stale; CLAUDE.md was touched by 35 commits in 14 days.
- **Fix:** H5.
- **Verification:** an overlapping preflight is refused naming the holder.

**D6. A routine repeats research without advancing the goal**
- **Evidence:** parked research packets (132 → 225 → 138 across 3 sessions); four cash
  sessions in 33 h with $0 collected.
- **Root cause:** each session optimises a mechanism metric, not the owner's outcome,
  because the outcome is not recorded anywhere that the next session reads.
- **Fix:** H1. The goals register (§50) already models an outcome with "what counts as
  finished" — sessions do not use it.

---

## E. Parallelism analysis

### Where concurrency helps

- Factory units with disjoint owned paths. #361 now holds only by real unit ownership.
- Fleet research bins.
- The four Postgres test shards.

### Where it conflicts [OBS]

- **Owner sessions on shared hot files.** Commits in 14 days:

  | File | Commits |
  |---|---|
  | CLAUDE.md | 35 |
  | `cash/discovery.ts` | 23 |
  | `tests/goalPlan.test.ts` | 21 |
  | `fast-cash/OPS.md` | 20 |
  | `goals/plan.ts` | 15 |
  | `russell/loop.ts` | 13 |

- **Branch reuse.** #400 re-squashed §82's commit because the branch was reused.
- **Deploy races.** These are handled: the second canonical-tip asking (§47) refuses a
  stale release. But it costs a whole Deploy cycle each time.
- **Pooler contention between the app, the verify harness and operator workflows**
  (`EMAXCONNSESSION`, pool_size 15). This is the most frequent shared-resource conflict,
  and it fails deploys that were otherwise fine.

### The current three parallel missions

The three missions are the owner sessions 01QF5Tk8abZ ("Brain economic mechanism
construction"), 01QF5Tk8HEJ ("Cash Mode economic-mechanism research") and 01QF5Tk6Dj
("Magic deck optimizer").

- **Two of the three are the same objective.** The owner sent the same prompt to both
  ("The economic-mechanism constructor from PR #398 is deployed, but its production
  execution path is blocked").
- Both touch `cash/construct.ts`, `cash/discovery.ts` and `goals/plan.ts` (#398, #389,
  #400).
- Magic (#399, 78 files, +11,360) is disjoint except for `RussellShell.tsx`, `router.ts`,
  `design.css` and CLAUDE.md.
- **Duplicate effort is real, and no system detected it.**

### The rule that would make concurrency safe without serialising

Use **path ownership at session start** (preflight claims the paths it expects to change) and
**objective identity** (two sessions naming the same goal or workstream are told about each
other). Both already exist for campaigns (`line.ts` admission, `remoteLoop.ts` unit deferral)
and for goals (`workstreams`). They are not connected to sessions.

---

## F. Why improvements have not compounded

1. **Fixes are instances, not classes.**
   - CLAUDE.md says so itself, repeatedly: "the fifth time this file has had to write…",
     "the seventh time…", "a mechanism nothing calls is not a mechanism" (written at least
     8 times).
   - Each occurrence got a local fix plus a paragraph. The class is a mechanism with no live
     caller, and it has no automated guard. A reachability check — every exported
     transition has a production caller — was never built.

2. **Fixes moved the bottleneck.**
   - Factory throughput work (#349, #357, #361) fixed dispatch starvation.
   - But Factory's output share fell, and the work moved to sessions. Throughput of the
     pipeline nobody uses improved.
   - Release automation (§58) proved zero-touch release in principle, then released nothing
     after 10-12, because real objectives are not LOW-risk one-liners.

3. **Failures returned.**
   - Pool exhaustion appears in §27 (seven occurrences), §61, §63 and again in Deploy 618.
   - Connector reliability: §51, §53, §59, §64, and the session titles "Connection
     reliability closure" ×2.
   - Parked packets: §69, §71, §80.

4. **New restrictions created new manual work.**
   - `RELEASE_EXCLUDED_PATHS` and `forbiddenPaths` are sound for safety. Together with
     keyword risk they mean Factory cannot ship 41% of real changes or any objective that
     mentions production.
   - The result: owners bypass Factory entirely, and the bypass has no safety at all (no
     review, no CI on the PR).

5. **Records grew instead of rules.**
   - CLAUDE.md went from 52 KB to 1,006 KB in two months: +802 lines in this window alone.
   - Its header says it "records rules, not state". Its bulk is incident history.
   - The cost is paid on every future session — the opposite of compounding.

6. **Regression protection exists for code and not for outcomes.** 401 test files guard
   behaviour. Nothing guards "the owner's objective X is still working in production", so an
   objective can be silently undone (#389's focus stop, reversed by #400).

**Net:** Factory accumulates reliable *mechanisms* inside a pipeline that carries 6% of the
work, and maintenance *obligations* (the CLAUDE.md narrative, report tooling, rules without
enforcement) on the path that carries 94%.

---

## G. Current vs target

| Capability | Current (measured) | Target | Root cause | Correction |
|---|---|---|---|---|
| End-to-end ownership | the owner drives 2–3 prompts per objective; stages after merge are unowned | one prompt | no persisted objective or completion contract on the session path | H1 |
| Prerequisite discovery | stops at the first prerequisite | continues within authority | the stop is unconstrained | H1 |
| Failure recovery | 0 automatic | automatic repair | no failure → objective writer | H4 |
| Dependencies / coordination | none between sessions | claims and holds by path | ownership exists only inside Factory | H5 |
| Production verification | none per objective; Deploy verdict 32% green | objective checks on the released SHA | harness conflated with outcome | H2, H3 |
| Completion standard | "merged / deployed / review passed" | section J standard | not enforced | H1 |
| Knowledge reuse | 250k-token narrative, compaction | rules file under 40 KB + history doc | everything appended to CLAUDE.md | H7 |
| Resource use | fleet starvation fixed; sessions bypass the fleet | Factory carries ordinary objectives | auto-release scope, person-only blocks | H6 |
| Owner independence | 0 of 10 follow-ups were necessary | no follow-ups unless a decision is needed | all of the above | H1–H7 |

**Already exists but is disconnected:**
- `brain_engineering_preflight`, `brain_evidence_record` and `brain_next_engineering_action`
  (advisory today)
- the goals / workstreams register with "what counts as finished" (§50)
- `release/verify.ts` live checks
- Factory unit-ownership holds
- the watchdog (record-only)
- `production-guard.yml`

**Each should be connected, not replaced.**

---

## H. Permanent corrections, ranked by expected operational impact

The direction of each correction comes from the evidence. No percentage improvements are
predicted.

**H1. Completion contract enforced at session stop**
- **Change:** extend `.claude/hooks/engineering-guard.mjs` with a `Stop` hook.
  - It refuses the stop unless one of two things is recorded for the session's objective:
    - an outcome reading through `brain_evidence_record`: a production check on a released
      SHA, or
    - a rule-11 blocker through `brain_engineering_blocker`.
  - At session start, `preflight` records the objective's acceptance checks, using the
    `workstreams.intent` or goal "what counts as finished" fields.
- **Removes:** D1 and D6. This addresses the largest measured burden: 50% corrections and
  20% continues.
- **Compounds:** yes. It applies to every future session.
- **Cost:** a hook plus one table column or link. Low risk: a hook can be bypassed by the
  owner only.

**H2. Objective checks reused for sessions**
- **Change:** let a session register `liveChecks` (the `release/verify.ts` shape: HTTP or
  bundle text, run inside the released container by `release-verify`) against its
  objective. Deploy then runs them for every objective whose commits it released.
- **Removes:** D2. Production detection moves from the owner to Deploy.
- **Compounds:** yes. Checks persist as outcome regression protection, so an objective
  silently undone (#389/#400) turns a check red.

**H3. A Deploy verdict that means one thing**
- **Change:** split the verdict into
  - RELEASED (flyctl, and the observed revision is serving);
  - OBJECTIVE CHECKS (H2);
  - HARNESS (the scripted `verify-hosted` packet).

  Only the first two gate "done". Give the harness its own pooler budget, or move it to
  transaction-mode pooling, so it stops competing with the app (Deploy 618:
  `EMAXCONNSESSION`).
- **Removes:** B2 noise.
- **Compounds:** yes. It turns 79 uninformative reds into a meaningful signal.

**H4. Failures become objectives**
- **Change:**
  - a FAILED release (`release/plan.ts`) submits a repair objective through
    `submitObjective`, carrying the failing check and the diff;
  - a red H2 check after Deploy does the same;
  - the watchdog (`watchdog.ts:87`) gets `continueWork` for a defined set: a stuck bin, a
    BLOCKED campaign on `UNIT_EXHAUSTED_ATTEMPTS`, which gets one bounded regrant through
    the existing `regrant.ts`.

  Keep the existing bounds: the attempt ceiling, and a person after N rounds.
- **Removes:** D3 and part of D4.
- **Compounds:** yes.

**H5. Sessions claim paths**
- **Change:**
  - `brain_engineering_preflight --paths` writes a lease into the Factory ownership line
    (`line.ts`), the same table used for live units of campaigns;
  - an overlapping claim from another session or campaign is refused or held, naming the
    holder;
  - two preflights naming one goal or workstream are told about each other.
- **Removes:** D5, and the owner's coordination role.
- **Compounds:** yes.
- **Cost:** moderate; it uses existing ownership code.

**H6. Unblock the Factory's own output**
- **Change:**
  - (a) Decide the 51 open COMPLETE Factory PRs: merge or close each with its reason. This
    is a one-time task and needs **owner merge authority**.
  - (b) Replace the keyword risk regex (`contract.ts:322`) with risk derived from the
    planned owned paths against `RELEASE_EXCLUDED_PATHS`. This is already the second check
    at the gate.
  - (c) Answer `UNIT_EXHAUSTED_ATTEMPTS` once automatically by a bounded regrant (H4),
    leaving a person for the second time.
- **Owner decision needed:** whether MEDIUM-risk changes outside reserved paths may
  auto-release after the full gate.
- **Removes:** D4.

**H7. Split CLAUDE.md**
- **Change:** a rules-only `CLAUDE.md` under 40 KB (invariants, the engineering connector,
  conventions, checks). Move the §-narratives verbatim to `docs/HISTORY/` and reference
  them by section.
- **Removes:** about 240k tokens per session and per checked-out worker, which reduces
  compaction and the lost-task re-asks.
- **Compounds:** strongly. Every future session benefits.
- **Cost:** low and reversible. Nothing is deleted, only moved.

### What is deliberately not proposed

- new models, accounts or paid APIs
- a new dashboard or orchestrator
- a Factory rewrite

The measured constraint is ownership of the outcome and verification, not AI capacity. Fleet
starvation was the AI-capacity constraint, and it is already fixed (#349, #357, #385).

---

## I. Execution plan (files and settings)

| Step | Files / settings |
|---|---|
| H7 | `CLAUDE.md` split into `CLAUDE.md` + `docs/HISTORY/*.md`. First, because it lowers the cost of every later step |
| H1 | `.claude/hooks/engineering-guard.mjs` (Stop hook); `.claude/settings.json` hook registration; `server/domain/engineering.ts` and `scripts/engineering.ts` (objective + acceptance record); `server/repos/engineering.ts` (link to a workstream or goal) |
| H2 | `server/services/factory/release/verify.ts` (accept objective checks); `scripts/factory-release.ts release-verify`; `deploy.yml` (run objective checks for released commits) |
| H3 | `deploy.yml` verdict job; `scripts/verify-hosted.ts` (own pool budget); `.github/workflows/hosted-verify.sh` |
| H4 | `server/services/factory/release/plan.ts` (FAILED → submit); `server/services/engineering/watchdog.ts` (`continueWork` set); `server/services/factory/regrant.ts` |
| H5 | `server/services/factory/line.ts` (session leases); `server/mcp/engineeringTools.ts` (preflight writes a claim) |
| H6 | `server/services/factory/contract.ts:322` (path-derived risk); one-time triage of the 51 open campaign PRs (owner) |

The sequence is H7 → H3 → H1 → H2 → H4 → H5 → H6. H3 comes before H1 and H2 because "done"
needs a trustworthy signal. Each step is small enough for one Factory campaign or session
with its own production check, and **each must itself satisfy the H1 contract**.

---

## J. Completion proof

### The completion standard to enforce

A job is DONE only when:

1. the objective's acceptance checks are recorded;
2. its prerequisites are satisfied or recorded as external blockers;
3. focused tests pass;
4. the change is released;
5. the observed serving revision contains it;
6. every acceptance check passes on that revision, recorded through `brain_evidence_record`
   against the released SHA;
7. remaining follow-up is either done or a recorded rule-11 blocker.

A failed check re-enters repair automatically (H4).

### How to show the corrections worked

Use the same measurements as this audit, re-run over the 14 days after deployment:

| Metric | Baseline (this audit) | Pass condition | Source |
|---|---|---|---|
| Owner prompts per objective | median 2, p90 3 | median 1, p90 ≤ 2 | session transcripts (`list_events`, `client_platform: ios`) |
| CORRECTION + MISSED_DETECTION share of follow-ups | 70% | ≤ 10% | same |
| Objectives closed "done" with the goal unmet | ≥ 4 of 10 | 0 | session finals vs recorded checks |
| Deploy RELEASED+CHECKS verdict success | 32% (combined verdict) | > 90% | Deploy runs |
| Merge → verified | median 291 min, p90 5.8 days | median < 60 min | Deploy + evidence rows |
| Open COMPLETE Factory PRs | 51 | 0 | GitHub |
| Factory share of merged PRs | 6.3% | rising week over week | git |
| Repair objectives created with no owner prompt | 0 | > 0, each bounded | `factory_campaigns` |
| Session path collisions refused or held | not measured | recorded | `engineering_interventions` |
| CLAUDE.md size | 1,006,613 bytes | < 40,000 bytes | `wc -c` |

**The live demonstration:**
- Give one ordinary objective: one prompt, with a production-observable acceptance check.
- Deliberately make the first attempt fail its check (for example, a flag left off).
- Factory passes if it detects the failure, repairs, redeploys and records a passing check
  with no second owner prompt.

---

## K. Remaining limitations

- **Owner-only:**
  - merging the 51 COMPLETE Factory PRs, or giving a standing merge policy;
  - allowing GitHub Actions to create PRs (Settings → Actions → Workflow permissions), so
    automatic rollback can open its revert;
  - deciding whether MEDIUM-risk, non-reserved changes may auto-release;
  - Supabase compute and pooler sizing, if H3's separation is not enough (spending).
- **Not fixable from Brain:**
  - a Claude Routine holding the wrong connector;
  - Claude's own needs-auth state (§51, §64).
- **Measurement gaps in this audit:**
  - 6 of 16 sessions were unreadable;
  - per-stage session timings are UNKNOWN (H1 records them from now on);
  - only 3 of 79 failed Deploys were classified (released vs not);
  - `factory-release` runs before 10-19 07:01Z were not fetched.
- **No production code was changed by this audit.** Raw extracts used for it are in the
  audit session's scratch directory, which is not committed.
