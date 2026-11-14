# Lens H — Hermes as director of Surge B (read-only, 2026-11-14)

## 1. What the operator can do today

Cadence and trigger: hourly Russell tick `operatorTickIfDue` (server/services/operator/run.ts:218), interval `BRAIN_OPERATOR_INTERVAL_MINUTES` (domain/operator.ts:62 = 60). It wakes early on an unseen engineering outcome (+10 min) or a changed constraint. Limits: 40 turns and a 20-minute budget (domain/operator.ts:66-67). The 45-minute RUNNING timeout is failed stale. `scripts/operator.ts run` / `agents.yml operator-run` starts one run now, with the same brief.

Brief: `operatorBrief` (domain/operator.ts:148) is a fixed $10K-centred script, plus the goal snapshot, the engineering outcomes, the deficiencies, the gaps from the previous run and the latest report's bottlenecks. **It has no mission or custom brief input.** `operatorBrief` takes {nowIso, runId, goals, engineering}; `runOperatorNow` takes no text; operator/server.py takes `prompt` from Brain only.

Tools (19, domain/operator.ts:118):
- Read: goals, goal, goal_plan, capacity, integrations, history, allocation, deficiencies, engineering.
- Act: withdraw_moot_request, continue_idle, submit_fix, record_learning, decide, verify, set_goal_focus, create_goal, commission, prioritize_engineering.
- Hermes' own toolsets: memory, skills, todo. It has no web, shell or files.

Memory: `operator_memory` rows, replaced each run; `operator_learnings` is append-only.

Engineering to Factory: `brain_operator_commission` → director.commission (services/operator/director.ts:235) → §87 register `registerDirected` (key `OPERATOR:<class>:<hash>`) → `advanceNow`: submitObjective plus approveAndStartCampaign under the standing improvement grant. Results come back through `brain_operator_engineering` / `directorPass`, with the judgement DELIVERED_UNMEASURED or RESOLVED and a re-read of the goal.

Research: an EVIDENCE intervention opens §87 method research and a goal research round (director.ts:275, 356). STRATEGY opens a goal research round only. A paused goal opens nothing (director.ts:367).

## 2. Model routing and run evidence

Chain in production: `free:auto/best-coding → gpu:Qwen/Qwen3-4B-AWQ → free:brain-a`. Read from operator-prove run 43398696087 (11-13 09:07Z), run opr_dddf4101202c4ba383ef.
- The run finished DONE. All seven proof checks PASSED.
- Tool failures: capacity failed twice and continue_idle failed. Both are the 180 s timeouts H-3 describes.
- The model used 19 tools coherently, decided with a prediction, commissioned work and recorded lessons. **The model was not the failure.**

§108 bench (runs 43285247214, 43289119187, 43309470657):

| model | quality | tool calls |
|---|---|---|
| auto/best-coding | 0.98 | 15/15 |
| Qwen3-4B | 0.65 | — |
| brain-a | 0 | 429 on every call |
| gpt-oss-20b | — | never served |
| Qwen3-8B-AWQ | — | HTTP 500 |

The current GPU recipe is `qwen3-4b-awq-tools` (64K, hermes parser), with probe TOOLS on (run 43399029412).

Production now (19:40Z, my own call to brain_operator_capacity):
- The read is no longer refused for want of the act scope, so H-3's read gate is fixed.
- The live read did not finish in 20 s, so I was served a reading 426 s old.
- FREE_LANE is "database connections contended".
- RESEARCH_SLOTS: 490 waiting, idle=true.
- FACTORY: capacity 1, 1 running, 1 waiting.

`brain_operator_history` was refused to this session (act scope), which is correct per F1.

**No operator-show, operator-run or operator-prove has run since #884 (75c6fb6) and #892.** The latest agents.yml run is 11-13 09:07Z, so the RC-8 repairs (H-3 to H-6) are unverified on production.

Verdict: the bottlenecks are the tools and the brief, plus production latency. The model is not the bottleneck.

## 3. RunPod

- **Recipes** (cheap/runpodRestore.ts:66-206): qwen3-4b-legacy, qwen3-8b-awq, qwen3-4b-awq-tools (ACTIVE, :204), qwen3-4b-tools-32k, gpt-oss-20b (20 GB+), qwen3.8-27b-awq (24 GB), gemma-4-26b-a4b-awq (24 GB). **There is no 48 GB recipe.**
- **Ceilings:** `DEFAULT_MAX_USD_PER_HOUR` 0.24 (:30); the repo variable `RUNPOD_MAX_USD_PER_HOUR` is empty (log of 43399029412). `RUNPOD_MAX_TOTAL_USD_PER_HOUR` defaults to 0.45 (scripts/runpod-bench.ts:28) and is **not passed** by cheap-lane.yml:109.
- **Balance:** $32.25 at $0.196/h, about 165 h of runway (scheduled run 43587582962, 11-14 10:56Z). The pod is odsft6ptpi2reh, RTX 2000 Ada, $0.19/h.
- **Report 43544814242:** the GPU produced 45 jobs in 6h and 74 claims, 100% sourced. **0 of 42 openings carried a payer and a price; plan NOT_VIABLE.**
- **48 GB survey** (43281884981, 11-12 — two days stale):

| card | community price | stock |
|---|---|---|
| RTX A6000 | $0.33/h | — |
| A40 | $0.35/h | Low |
| L40 | $0.69/h | — |
| 6000 Ada | $0.74/h | — |

**Recommended director recipe:** Qwen3-32B-AWQ (or Qwen3-30B-A3B-AWQ, faster as an MoE) on an A6000 or A40.
- vLLM v0.32 image; `--enable-auto-tool-choice --tool-call-parser hermes --reasoning-parser qwen3`; 64K via YaRN, FP8 KV; containerDisk about 60 GB.
- Cost: about $0.33–0.35/h, about $8/day. $100 buys about 290 h of a 48 GB pod beside the existing $0.196/h pod, or about 10 days of both together.
- It needs `RUNPOD_MAX_USD_PER_HOUR=0.36` and `RUNPOD_MAX_TOTAL_USD_PER_HOUR=0.60`, the second wired into the workflow env.
- gpt-oss-20b already has a recipe, but it failed to serve in 40 min on a 20 GB card.
- Bench first with `runpod-bench`, then take the winner with `runpod-upgrade`.

## 4. Findings

| id | where | symptom | root cause | sev | repair |
|---|---|---|---|---|---|
| H2-1 | domain/operator.ts:148, run.ts:243 | A run cannot be given the Surge B mission | Brief has no mission input; runOperatorNow takes no text | BLOCKING | `operatorBrief({mission})`; `scripts/operator.ts run --mission-file`; `agents.yml operator-run` input `mission` (base64) |
| H2-2 | operatorTools.ts (no tool) | No inventory of findings Hermes can read or update | Inventory lives in docs/PLANNING-RECOVERY md; §87 `improvement_candidates` is the only row store and is filtered to OPERATOR keys | MAJOR | `brain_operator_inventory` read/update over `improvement_candidates` (status, dedup by weaknessKey, evidence); seed from the doc's 59 ids |
| H2-3 | director.ts:883-1016 | Deficiencies has 3 hard-coded detectors only (moot cards, operator model fails, repeated kind) | It only reads three things | MAJOR | Add detectors from the ops report bottlenecks and from inventory rows; or let inventory rows be commissioned by id |
| H2-4 | director.ts:310-340 | STRATEGY/MODEL/PERSON/WATCH → lesson; Hermes reported "RCA now queued" (opr_dddf4101) | H-4; the fix is unverified in production | MAJOR | Verify with operator-prove after #884; the commission result must carry `started[]` empty → the brief forbids claiming queued |
| H2-5 | no tool | Cannot reassign stalled Factory work or allocate agents | Factory's watchdog/leases own it; no operator door except prioritize_engineering | MAJOR | Expose a reprioritize/cancel-and-reattempt via the existing `NEW_ATTEMPT` path (§87 attempt ≤3); no new mechanism |
| H2-6 | no tool | Cannot commission standalone research except via a deficiency's EVIDENCE path, and not at all on a paused goal | Research reaches Hermes only through commission | MINOR | `commission` with intervention EVIDENCE plus a goal is enough; document it in the brief; allow a non-goal method research |
| H2-7 | domain/operator.ts:118 | No verify-a-repair tool for non-Factory fixes (direct-session merges) | `engineeringOutcomes` covers only its own candidates | MINOR | Inventory update requires evidence (sha, run id, production read) to set VERIFIED |
| H2-8 | capacity tool, live | Live read >20 s; FREE_LANE DB-contended | RC-1 second layer still open | MAJOR | (Lens P/RC-1) |
| H2-9 | cheap-lane.yml:109, runpod-bench.ts:28 | A 48 GB bench is impossible ($0.33 + $0.196 > $0.45) | Total ceiling not configurable from the workflow; per-pod ceiling 0.24 | MAJOR | Set repo vars and pass `RUNPOD_MAX_TOTAL_USD_PER_HOUR`; add a recipe `qwen3-32b-awq-48` (GPUS_48: A6000, A40) |
| H2-10 | agents.yml runs | No operator run proved since #884/#892 | Not dispatched | MAJOR | Dispatch `operator-prove` (by the integrator) |
| H2-11 | run.ts:390-417 | Every run re-reads all goals; a $10K-specific brief | Brief is fixed | MINOR | Same fix as H2-1 |

## 5. Minimal plan: "Hermes directs Surge B"

1. **Mission in:** add an optional `mission` to `operatorBrief` (placed first), stored on `operator_runs`. Supply it from a register row (preferred, survives restarts): a STRATEGY-class candidate keyed `SURGE:B` whose evidence carries the mission text, injected while it is open. As a fallback, pass it to `operator.ts run --mission`.
2. **Inventory:** add the tool `brain_operator_inventory {list | upsert{id, status, rootCause, owner, evidence}}` over `improvement_candidates`, keyed `SURGE-B:<issue id>`, with the status vocabulary from the planning doc. VERIFIED FIXED is refused without a production evidence string. Seed it from docs/PLANNING-RECOVERY-2026-11-14.md.
3. **Commission:** use the existing `brain_operator_commission`, per inventory id: ENGINEERING goes to Factory, EVIDENCE goes to research. Dedup by key.
4. **Stalls:** `brain_operator_engineering` already returns `next`. Add `brain_operator_reattempt {candidate_id, reason}`, which calls §87's next attempt (≤3).
5. **Model:** keep `auto/best-coding`. Optionally add the 48 GB Qwen3-32B pod (about $0.34/h, within $100) as a challenger and fallback after a `runpod-bench`.
6. **Proof:** `operator-prove latest` plus `operator.ts engineering`. Each Hermes decision is an `opd_` row with prediction and challenge, each commission an `OPERATOR_INTERVENTION_DECIDED` event with actor `operator:<runId>`, and each inventory change is a row naming the run. Proof means: count rows where the run id made the decide, commission and inventory calls, and match those rows to SURGE-B ids.
