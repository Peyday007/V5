# Planning recovery — 2026-11-14

The owner's order (2026-11-14): make Brain reliably able to take almost any
planning objective and construct, evaluate, challenge, revise and deliver the
strongest defensible plan its evidence supports — or say plainly that the
objective is infeasible or unsupported. Discovery first, repair concurrently,
one deduplicated inventory, verified on production.

This file is the durable inventory. It survives restarts because it is in the
repository; every status change is a commit.

## Method

Six independent investigations ran concurrently, each read-only against the
code and production, each asked for root causes with evidence and a
reproduction:

| lens | what it read |
|---|---|
| Q — quant economics | `goals/portfolio.ts`, `reconstruction.ts`, `reasoning/variables.ts`, `quant/*`, reproduced on `tests/fixtures/goal10k.ts` |
| O — openings and evidence | research → openings → model, the goal's derived state |
| G — objective intake and generality | how an objective enters, which kinds are planned, synthetic goals of other sizes |
| P — production history | goals/deploy/postgres/cheap-lane workflow runs, PRs, incidents |
| H — Hermes, compute, autonomy | operator, Factory director, RunPod, free lane, restart |
| C — critique, revision, acceptance | challenge, revision, acceptance, actionable output |

Production reading at the start (2026-11-14 07:15Z, `brain_operator_goal_plan`
on `wst_7b4fcbb5f2384f31b6c3`, the $10K/30-day goal): NOT_VIABLE, CANDIDATE_ONLY;
strategies labelled with raw research sentences ("The 10 Best Christmas
Decorators Near Me", a Coachella resale dated April 2026); the reconstruction's
"best" plan stacked three price multipliers and two capacity purchases and
reported a median of 34,533,142 at 97.9% coverage; the goal's derived state was
BLOCKED on a PERSON because one researched candidate was parked.

## Inventory

Status vocabulary: DISCOVERED · UNDER INVESTIGATION · ROOT CAUSE CONFIRMED ·
READY FOR REPAIR · REPAIRING · AWAITING VERIFICATION · VERIFIED FIXED · BLOCKED ·
NOT A DEFECT.

### Root causes

(filled as investigations report; each root cause lists the issues it explains)

### Issues

| id | component | symptom | root cause | sev | status |
|---|---|---|---|---|---|
| G-1 | `goals/plan.ts:770`, `:2130` | A goal without a cash target (build a business, an operational problem) gets no planner at all | Only cash metrics exist; the plan loop selects targeted goals only | BLOCKING | ROOT CAUSE CONFIRMED |
| G-2 | `scripts/goals.ts:321`, `routes/goals.ts`, `industry/construction/intent.ts:126` | An objective cannot be stated in words; the target is a hand-typed CLI spec. The existing interpreter reads "$10,000 in 30 days with ≤$3,000" as capital 10,000 and parses no deadline | No objective reader; no route or operator tool sets a target | BLOCKING | ROOT CAUSE CONFIRMED |
| G-3 | `goals/pathways.ts:97,186` ; `target.ts:139` | $100/48h and $1M/48h both read every structure IMPOSSIBLE | Feasibility assumes B2B cold email (2-day minimum cycle, 2/7/14-day settlement); deadline rounded to whole days | MAJOR | ROOT CAUSE CONFIRMED |
| G-4 | `domain/goalPolicy.ts:31`, `reconstruction.ts:456`, `portfolio.ts:544,87` | A 365-day $1M goal is forced into 30-day SQUEEZE; capacity question fixed at 10,000/day; starting capital from a fallback chain encoding one owner quote | Constants tuned to the $10K case | MAJOR | ROOT CAUSE CONFIRMED |
| G-5 | `goals/target.ts:177` | Changing capital or hours resets the goal's progress to zero; no remote way to change constraints | `setTarget` always rewrites `target_set_at` | MAJOR | ROOT CAUSE CONFIRMED |
| G-6 | `goals/plan.ts:75,1128,312` | An impossible goal searches at full capacity until its deadline, then reads MISSED | No INFEASIBLE verdict; structural/IMPOSSIBLE findings reach only prose | MAJOR | ROOT CAUSE CONFIRMED |
| G-7 | `goals/target.ts:110` | Two goals on one project both count the same dollars | Progress is the project ledger since `target_set_at`, unattributed | MAJOR | ROOT CAUSE CONFIRMED |
| G-8 | `goals/plan.ts:2131` | A paused goal keeps re-reading its plan and opening search rounds | `advanceGoalPlans` did not exclude paused goals | MINOR | REPAIRING |
| G-9 | `goals/plan.ts:2130,2153` | One busy slot skips every later goal for the pass; order unspecified | No fairness order | MINOR | DISCOVERED |
| G-10 | `goals/tick.ts` | No dependency graph inside one goal | Dependencies exist only between goals | MINOR | DISCOVERED |
