# Factory autonomy, measured and corrected — 2026-11-02

Follows `docs/FACTORY-PERFORMANCE-2026-11-02.md` (branch
`claude/factory-performance-investigation-nb49ct`). Every figure here is from
GitHub runs, Factory rows or session records; where something was not measured
it says so.

## What still held, and what was corrected

| finding (prior report) | still true on 2026-11-02? | correction |
|---|---|---|
| Deploy goes red after a working release | Yes: 6 of 8 sampled red Deploys (41223245438 … 41416175495) released, then the verifier died opening its own connection (`EMAXCONNSESSION`, pool 15; storage HTTP 429 `too_many_connections`). The restart pass then failed on "no beacon". | `scripts/hostedOpen.ts`: bounded wait (15/30/60/120 s) on a "not now" refusal only. Verdict names `RELEASED, VERIFICATION COULD NOT RUN` vs `RELEASED, BEHAVIOUR DEFECTIVE`. Gate not loosened. (#417) |
| Fire waits dominate the critical path (31 min to start a plan, 41 min first integration, 2 h 07 m plan waits) | Yes: a fire nobody answered held its slot and blocked a re-fire for `IN_FLIGHT_WINDOW_MS` = 30 min; an abandoned intent revived after 2 h. | `NO_SHOW_WINDOW_MS` = 8 min for unanswered fires, used by both the in-flight count and the no-show reopen; revive after 20 min. (#417) |
| Integration is serial and slow | Partly. One integrator per campaign is a deliberate guarantee (only it moves the campaign branch) and it already batches every implemented unit. What made rounds slow: every unit bin and every round ran the full suite. | Intermediate rounds and unit bins run typecheck + `test:impacted`; the final round and the release gate run every contract command. (#417) |
| COMPLETE ≠ delivered (75 COMPLETE, 53 PRs open) | Yes: COMPLETE was set when the PR was opened, and nothing re-read the forge unless the campaign sat under a register workstream. | `delivery.ts` observes every finished campaign's PR (one list call per repository per 10 min): closed → CANCELLED, merged-not-running → BLOCKED "Dispatch Deploy", running → LIVE. `factory campaigns` prints the outcome and a tally. (#417) |
| Sessions poll `factory status` (41 of 60 runs) | Yes: nothing announced an end. | One `OBJECTIVE_FINISHED` record per terminal outcome (runIdempotent). `factory wait` is one run that ends with the objective; the session watches that run. (#417) |
| — (new) A new objective had to be merged and deployed before it could be submitted | Yes: `submit --file` read the image. ~27 min median per Deploy. | `submit/authorize-release --ref <branch>` read the file through the forge. (#417) |
| — (new) A review stage could wait for ever with every reviewer refused, silently | Yes. | The stage detail names the refusals and their reason. (#417) |

## The Factory's critical path now

submission (`--ref`, seconds) → approve → plan bin (fire, ≤ 8 min if the first
fire is a no-show) → units in parallel (one bin per ready unit) → integration
rounds (typecheck + impacted) → final round (full suite) → independent review →
delivery bin (PR) → release gate (LOW + grant: merge, Postgres suite, Deploy,
live verification) or the waiting session merges and deploys (MEDIUM/HIGH) →
`OBJECTIVE_FINISHED` → `factory wait` ends → one final message.

## Direct Claude Code baseline

53 of the owner's last 99 sessions map to a merged PR (session created → first
merge). With the 17 rows over 600 min removed (overnight idling):

| size | n | median | p90 |
|---|---|---|---|
| small (≤3 files) | 4 | 147 min | 387 min |
| medium (4–12) | 14 | 66 min | 251 min |
| large (>12) | 18 | 73 min | 242 min |
| all | 36 | 69 min | 305 min |

Caveats: timing starts at session creation (includes investigation and owner
reply time); merge only, not deploy; the small class has four rows.

## Benchmark: three real objectives, submission to production

Real backlog work: one new defect found during this work, and two stale Factory
objectives (#53+#63, #66) re-run against current production. Each was submitted
through the operator door with `--ref`, so no deploy was needed before
submission. Each was approved, built by the Factory, and carried to production
by the session protocol (`.claude/skills/factory-objective`). Times are UTC on
2026-11-02. "Live" is the time Deploy's release step completed.

| objective | files | submitted | PR | merged by session | live | submission → live |
|---|---|---|---|---|---|---|
| small — `fcp_90dacf0a`, next-action reads the objective outcome | 2 | 10:40:05 | #427 14:33 | 14:59 | 15:35 | **4 h 55 m** |
| substantial — `fcp_8cd968ad`, Russell turn boundary + Build preview (2 independent parts) | 6 | 10:41:53 | #431 15:37 | 15:42 | 16:01 | **5 h 20 m** |
| medium — `fcp_cc5ef744`, one writer for goal dependencies | 4 | 10:48:23 | #435 17:09 | 17:13 | see the Deploy record | **~6 h 50 m** |

Every acceptance condition was met, and each PR had an independent review pass.
They were verified on production as follows:
- **Small:** `brain_next_engineering_action` returned DONE for a LIVE campaign and NEEDS_HUMAN for a person-blocked one with `human_blocker_open:false`. A building campaign still read BRANCH.
- **Substantial:** the new Build disclosures are in the live client bundle.
- **Medium:** live with the release that carried #435.

Owner interventions: **0**. Every merge and deploy was done by the session, under the owner's standing order. One integrate bin needed a session `answer-bin`, because Brain had spent its attempts on its own defect.

### Where the hours went

Useful worker time per objective was a few minutes each: plans took 15–44 s, units 4–11 min, and integration rounds a few minutes. The rest was defects found by these runs. Each is fixed and deployed:

| cost | measured on | cause | fix |
|---|---|---|---|
| ~2 h 15 m (small), ~1 h 30 m (substantial) | integrate stage | The unit manifest promised that an independent session would integrate. The implementer took the integrate bin, believed the promise, and refused it twice, so the bin parked for a person. Each refusal also counted as an unproductive start, which throttled the only account, so the substantial campaign's independent second unit started 44 min late. | #424 |
| 4 h 35 m (medium) | before implementation | The objective was held by `fcp_3a8b4e75`, BLOCKED on a person since 10-30 and still holding the same files. | #430 |
| full suite ×3–4 per objective | integration, review, Deploy | Every round and the reviewer re-ran the whole suite. | #417, #423: once, in CI |
| 8–11 min per stage | plan, each stage | A fire wait. A no-show held its slot for 30 min; abandoned intents revived after 2 h. | #417: 8 min / 20 min |
| 25–36 min per release | merge → live | Deploys serialise, each runs the full suite, and newer canonical tips (often other sessions') supersede them. | not changed (§28) |

### Compared with direct Claude Code

Direct sessions (above): about **70 min** median from session start to merged PR, **4–5 h** at p90, merge only. On 2026-11-02 the Factory took **4 h 55 m – 6 h 50 m** from submission to *live*: roughly 4–6× slower than the direct median, and in line with the direct p90.

**The Factory is not yet as fast as direct Claude Code, and these runs do not show that it is.** The defects above account for most of the difference, and all are fixed. Removing them leaves a critical path of about 8 min plan + 5–11 min units + ~10 min integration + review + 25–35 min Deploy. That is about 1–1.5 h submission → live, which would match direct sessions *including deploy*. This is a projection from measured stage times. No run has been timed after every fix landed.

### Remaining limitations that constrain the workflow

1. **One usable worker surface.** `factory line` at 15:02 showed seven Factory surfaces: one free, the rest retired or quarantined. Observed concurrency was 1 on every campaign, so independent units cannot run in parallel. Restoring surfaces is configuration (accounts and Routines).
2. **The production machine stalls when operator consoles run.** Every operator command and the hosted verifier is a `node --import tsx` process on the `shared-cpu-2x` machine that serves Brain. `/healthz` took 25–30 s at the times console sessions appear in the Fly log, and post-restart verification passes ran out of time. Mitigated (#434: `nice`, probes every 15 min). The structural options are precompiled operator scripts or dedicated CPU; dedicated CPU is a spending decision.
3. **The database pool fills right after a restart.** The session pooler allows 15 clients. After a restart the app retries its boot and answers 503 for minutes. The verifier now waits out a refusal (#417) and names an unfinished pass as such (#428). Raising the pool limit is the owner's Supabase setting.
4. **MEDIUM/HIGH objectives finish at a PR by design** (§58). The waiting session merges and deploys them. Only LOW-risk objectives with a grant release with no session at all.
