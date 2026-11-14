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

Fifty-nine distinct issues reduce to eight root causes. Each explains a class of
failures; repairing the cause is the unit of work, not the symptom.

| RC | root cause | issues it explains | repair owner (branch) | status |
|---|---|---|---|---|
| RC-1 | **Synchronous CPU-heavy quant work on the server's main event loop, recomputed every read** (2-CPU machine, heap ~840 MB/1 GB). Surfaces as "database" errors, 503s, tick passes that never settle, MCP timeouts after restart, DNS failures in research, failed release verification, the operator pausing goals | P-1, P-2, P-3, P-4, P-5, P-6, P-8, P-9, P-11, H-2 (partly), H-3 (in-run timeouts), H-7, C-12 | main-loop CPU repair | REPAIRING |
| RC-2 | **No economic plausibility in the plan search**: moves stack without a family limit, price rises are nearly free, supplier cost vanishes under prepaid fulfilment, a deposit pulls all cash to day 3, cloned channels resell one market, after-proof money is spent in every world, and nothing flags an absurd result | Q-1…Q-9, C-1…C-4, C-14, P-7 | quant engine economics repair | REPAIRING |
| RC-3 | **Three readings, three different "plans"**: verdict, acceptance candidate and reconstruction each pick their own; revision never reaches the plan; no dated actionable steps; research ranked against the wrong plan; the 90% gate counts simulated worlds as evidence | C-6, C-7, C-8, C-9, C-11, C-13, C-15 | plan coherence repair | REPAIRING |
| RC-4 | **No termination by arithmetic**: an impossible objective keeps searching past its deadline; no INFEASIBLE / NOT_SUPPORTED verdict | G-6, C-10 | plan coherence repair | REPAIRING |
| RC-5 | **Planning is defined only for a person-typed cash target**: no objective reader, no non-cash planner, constants tuned to the $10K case | G-1, G-2, G-3, G-4, G-5, G-7, G-10 | intake repair; non-cash planner repair; G-3 done here | REPAIRING |
| RC-6 | **Research claims become openings without an offer, a buyer, a price or a date**: titles are claim sentences, supplier rate cards pass as demand, expired events are modelled, one buyer population is counted once per design, capital-unknown blocks the validation ladder | O-1, O-2, O-3, O-5, O-6, O-7, C-5, H-9 | opening-quality repair | REPAIRING |
| RC-7 | **A goal's state is read from its worst link**: one parked research dead end marks a multi-path goal BLOCKED waiting on a PERSON, and the operator plans from that | O-4, H-1 | goal-state repair | REPAIRING |
| RC-8 | **The operator acts on what it cannot see or do**: read tools gated on the act scope, interventions that only write a lesson while reporting work queued, a 4B GPU model as the high-impact challenger, ranking credited to the wrong model | H-3, H-4, H-5, H-6 | operator repair | REPAIRING |

Not root-caused to code (external or operational): H-8 (GitHub drops scheduled
runs), P-10 (merges land faster than the release gate — a release-cadence
policy), RunPod runway (balance $33.70 at 11-14 03:33Z, ~7 days at $0.196/h —
a top-up only the owner can make).

### Issues

| id | component | symptom | root cause | sev | status |
|---|---|---|---|---|---|
| G-1 | `goals/plan.ts:770`, `:2130` | A goal without a cash target (build a business, an operational problem) gets no planner at all | Only cash metrics exist; the plan loop selects targeted goals only | BLOCKING | ROOT CAUSE CONFIRMED |
| G-2 | `scripts/goals.ts:321`, `routes/goals.ts`, `industry/construction/intent.ts:126` | An objective cannot be stated in words; the target is a hand-typed CLI spec. The existing interpreter reads "$10,000 in 30 days with ≤$3,000" as capital 10,000 and parses no deadline | No objective reader; no route or operator tool sets a target | BLOCKING | ROOT CAUSE CONFIRMED |
| G-3 | `goals/pathways.ts:97,186` ; `target.ts:139` | $100/48h and $1M/48h both read every structure IMPOSSIBLE | Feasibility assumes B2B cold email (2-day minimum cycle, 2/7/14-day settlement); deadline rounded to whole days | MAJOR | AWAITING VERIFICATION (INSTANT structure added; tests/goalPathways.test.ts) |
| G-4 | `domain/goalPolicy.ts:31`, `reconstruction.ts:456`, `portfolio.ts:544,87` | A 365-day $1M goal is forced into 30-day SQUEEZE; capacity question fixed at 10,000/day; starting capital from a fallback chain encoding one owner quote | Constants tuned to the $10K case | MAJOR | ROOT CAUSE CONFIRMED |
| G-5 | `goals/target.ts:177` | Changing capital or hours resets the goal's progress to zero; no remote way to change constraints | `setTarget` always rewrites `target_set_at` | MAJOR | ROOT CAUSE CONFIRMED |
| G-6 | `goals/plan.ts:75,1128,312` | An impossible goal searches at full capacity until its deadline, then reads MISSED | No INFEASIBLE verdict; structural/IMPOSSIBLE findings reach only prose | MAJOR | ROOT CAUSE CONFIRMED |
| G-7 | `goals/target.ts:110` | Two goals on one project both count the same dollars | Progress is the project ledger since `target_set_at`, unattributed | MAJOR | ROOT CAUSE CONFIRMED |
| G-8 | `goals/plan.ts:2131` | A paused goal keeps re-reading its plan and opening search rounds | `advanceGoalPlans` did not exclude paused goals | MINOR | AWAITING VERIFICATION |
| G-9 | `goals/plan.ts:2130,2153` | One busy slot skips every later goal for the pass; order unspecified | No fairness order | MINOR | DISCOVERED |
| G-10 | `goals/tick.ts` | No dependency graph inside one goal | Dependencies exist only between goals | MINOR | DISCOVERED |
| O-1 | `cash/discovery.ts:1604`, `repos/research.ts:1580-1726` | Openings titled with raw claim sentences; supplier rate cards and directory pages promoted to demand | Harvest files a claim without extracting offer/buyer/price; lane-only promotion | MAJOR | REPAIRING |
| O-2 | `domain/opportunitySignals.ts:149`, `discovery.ts:1619,1652`, `goalScenario.ts:651` | An April 2026 Coachella resale modelled on 2026-11-14 | No temporal validity check between claim and model | MAJOR | REPAIRING |
| O-3 | `cash/construct.ts:510,564`, `goalScenario.ts:286` | One buyer population appears several times in one combination | Designs over one population indistinguishable; picked once per design | MAJOR | REPAIRING |
| O-4 | `register/resolve.ts:224`, `register/view.ts:111`, `goals/model.ts:607,1051` | $10K goal reads BLOCKED waiting on a PERSON; 67 blockers are research dead ends | A parked research dead end maps to BLOCKED and outranks live work | BLOCKING | REPAIRING (= H-1) |
| O-5 | `research/packetRunner.ts:2685` | "No fragment cleared its gate" names a non-cause | First sentence taken; true cause is written last | MAJOR | REPAIRING |
| O-6 | `research/gate.ts:688` | Research rounds end without a report | Unreachable sources (downstream of RC-1) and verifier failures on all-conditional lanes | MAJOR | UNDER INVESTIGATION (after O-5 shows true causes) |
| O-7 | `goals/plan.ts:393-418` | Nothing reaches C_MARKET_TEST_READY | Capital must be a published figure; a bounded range is refused | BLOCKING | REPAIRING |
| H-1 | `domain/register.ts:75`, `register/resolve.ts:216` | (same as O-4) | (same) | MAJOR | REPAIRING |
| H-2 | `russell/loop.ts:1392`, `db/pressure.ts:104` | 1 plan scenario in 6 h against ≥2/h designed | SHEDDING skips goal-plans entirely; planning is itself the stall (RC-1) | BLOCKING | REPAIRING |
| H-3 | `mcp/operatorTools.ts:46,172`, `engineering/watchdog.ts:245` | Read-only operator tools refuse without act scope; capacity/continue_idle time out in Hermes' runs | Uneven gating; live reads past the 180 s call limit | MAJOR | REPAIRING |
| H-4 | `operator/director.ts:277` | Hermes reports "RCA now queued"; nothing was queued | MODEL/STRATEGY/EVIDENCE/WATCH only write a lesson | MAJOR | REPAIRING |
| H-5 | `operator/decisions.ts:47`, `operatorTools.ts:610` | High-impact decisions challenged by Qwen3-4B; challenger can outlive the tool call | Rank rotation puts the GPU first; 3×120 s inside 180 s | MAJOR | REPAIRING |
| H-6 | `operator/run.ts:101` | Model ranking ignores the benchmark; success credited to the wrong model | Missing setting; first-in-chain credit | MINOR | REPAIRING |
| H-7 | `goals/plan.ts:1706` | Every restart drops in-memory plan state | Process-memory state | MINOR | NOT A DEFECT alone (cadence is DB-backed); mitigated by fewer restarts |
| H-8 | `.github/workflows/cheap-lane.yml` | Hourly runpod-auto ran 3 times in 24 h | GitHub drops schedules; hung run holds the queue | MINOR | DISCOVERED |
| H-9 | free lane / GPU | 53 accepted vs 97 rejected research jobs; no opening with payer+price | Model quality plus stall-induced connection errors (RC-1) | MAJOR | UNDER INVESTIGATION |
| Q-1 | `reasoning/directions.ts:337-368,507,537` | Price ×17.6 / ×157.9; two capacity buys; $34.5M median | No family-level dedupe; per-move clamp only | BLOCKING | REPAIRING |
| Q-2 | `directions.ts:358`, `variables.ts:622`, `portfolio.ts:451` | Price rise is free until close binds | Demand curve applied to close, not to quantity | MAJOR | REPAIRING |
| Q-3 | `goals/portfolio.ts:624`, `quant/portfolio.ts:399,407` | Prepaid fulfilment turns reach 0→1 at identical revenue and cost | Gross receipts compared to target; buyer-funded cost zeroed | BLOCKING | REPAIRING (= C-1) |
| Q-4 | `reconstruction.ts:716` | Deposit lands all cash on day 3 in every world | Timing collapsed to the favourable end | MAJOR | REPAIRING |
| Q-5 | `reconstruction.ts:387` | "As-is floor" 0.84 vs 0.21 honest | Floor keeps every assumed move | MAJOR | REPAIRING |
| Q-6 | `reconstruction.ts:628,653` | Market sold twice through clones | Clones copy the market cap | MAJOR | REPAIRING (= C-2) |
| Q-7 | `reconstruction.ts:593` | After-proof purchases spent in worlds with no proof; per-week limit ignored | Purchase modelled as fixed capacity | MAJOR | REPAIRING |
| Q-8 | `reconstruction.ts:685` | Bundle keeps one unit's cost; retainer books a full month | Shape mis-costing | MINOR | REPAIRING |
| Q-9 | `reconstruction.ts:295,593` | $0→$50 counted material; labels report budget not cost | Relative-only materiality | MINOR | REPAIRING |
| C-1 | `goalScenario.ts:840`, `quant/portfolio.ts:407` | (= Q-3) | | BLOCKING | REPAIRING |
| C-2 | (= Q-6) | | | MAJOR | REPAIRING |
| C-3 | (= Q-1) | | | MAJOR | REPAIRING |
| C-4 | `reconstruction.ts:377`, `directions.ts:701` | No plausibility check anywhere | Missing critic | MAJOR | REPAIRING |
| C-5 | (= O-2) | | | MINOR | REPAIRING |
| C-6 | `goals/plan.ts:635,1028,1087` | Candidate 1.1% vs reconstruction 97.9%: two plans | Each reading selects its own plan; revision display-only | BLOCKING | REPAIRING |
| C-7 | `goals/plan.ts:657` | A plan with assurance 75–99% (n=12) is ACCEPTED | Wilson over simulated worlds | BLOCKING | REPAIRING |
| C-8 | `domain/planReady.ts` | No dated, costed, owned plan with kill criteria | Not derived | MAJOR | REPAIRING |
| C-9 | `goals/plan.ts:1492`, `reconstruction.ts:488` | Research ranked on the wrong plan; sweep's sensitive conditions never asked | Not routed | MAJOR | REPAIRING |
| C-10 | (= G-6) | | | MAJOR | REPAIRING |
| C-11 | `directions.ts:568`, `plan.ts:1599` | Same inputs, different verdict under load | Wall-clock bounds; winner in digest | MAJOR | REPAIRING |
| C-12 | `reasoning/evaluatorPool.ts:54,111` | After one timeout, every evaluation runs on the main loop | Sticky `broken` + inline fallback | MAJOR | REPAIRING |
| C-13 | `goals/plan.ts:777,1193,1208` | Failures silently drop reconstruction/arrangements | Swallowed errors | MINOR | REPAIRING |
| C-14 | `reconstruction.ts:465` | Wilson bound over the wrong world count | Uses limits.worlds | MINOR | REPAIRING |
| C-15 | `directions.ts:553,635` | A plan with challenged reach 0 can win | Challenge only lowers a score | MAJOR | REPAIRING |
| P-1 | plan read | 200→970 s reads, then 30-min timeouts | RC-1 | BLOCKING | REPAIRING |
| P-2 | event loop | 8–31 s stalls; /healthz to 31.5 s | RC-1 | BLOCKING | REPAIRING |
| P-3 | Russell tick | Passes "did not settle within 300 s" since 11-07 | RC-1 | MAJOR | REPAIRING |
| P-4 | release verification | 9 consecutive Deploys "VERIFICATION COULD NOT RUN" | RC-1 plus boot load | MAJOR | REPAIRING |
| P-5 | DB pool | "no free connection within 10000ms"; goal read LIGHT | RC-1 (loop not servicing sockets) | MAJOR | REPAIRING |
| P-6 | goals workflow | SSH killed mid-plan by a release | Long reads overlap restarts | MINOR | DISCOVERED |
| P-7 | (= RC-2) | | | MAJOR | REPAIRING |
| P-8 | research yield | Pool reach stuck at $250 then $3,249 | Downstream of RC-1 and RC-6 | MAJOR | REPAIRING |
| P-9 | plan read statement budget | `goalPlan` statement test times out on Postgres | Per-opening queries added by each feature | MAJOR | REPAIRING |
| P-10 | release gate | Deploys skipped as superseded | Merges faster than the gate | MINOR | DISCOVERED (policy) |
| P-11 | operator | Paused the owner's goal under congestion | RC-1; fixed by #876 | MEDIUM | VERIFIED FIXED (5618bc8) |

## Discovery coverage

Denominators are the components and paths enumerated by the six lenses, not a
guess at undiscovered defects.

- Critical planning stages traced end to end: objective intake → target →
  openings (research harvest) → model composition → portfolio engine →
  reconstruction / directions / sweep → acceptance → plan output → research
  routing → tick/scheduling → operator. 11 of 11 stages examined; every stage
  produced at least one confirmed defect.
- Independent confirmation: Q and C reached the same economics defects
  separately; O and H reached the same goal-state defect separately; P's
  production timeline independently explains H-2, H-3, O-6, H-9.
- Not yet examined: Russell research-mission internals beyond the gate summary
  (O-6 verifier share), the client UI's goal surface, Postgres-specific plan
  queries beyond the statement budget.
