# BRAIN CAPABILITY EVOLUTION — EIGHT-HOUR WAKE-UP STATUS (2026-11-16 05:40Z)

Directive: owner, 2026-11-15 21:44Z. Status: **NOT COMPLETE.** The engine is built and live. Hermes now sees benchmark deficiencies on production. No experiment with competing approaches has run, so no improvement cycle is complete.

## A. Evolution Engine: state

| item | state | evidence |
|---|---|---|
| Experiments, variants, results, hidden cases, approach statistics (tables, repos, service, CLI) | LIVE | #951, Deploy 43782867159 (90e6b3d) |
| Hermes tools: commission with ≥2 `approaches` + `suite`; `brain_operator_experiments`; `brain_operator_add_hidden_case` | LIVE | #951 |
| Independent evaluator (`evolution-eval.yml`, every 30 min, variant code in network-less containers, hidden cases from the database only, never echoed) | LIVE | runs 43789051209, 43807483374, 43808177839 |
| Capability suites: `feasibility` (67 public cases + hidden), `planSpeed` | LIVE | `bench/` |
| CAPABILITY_BELOW_TARGET detector, wired into Hermes' deficiency register | LIVE, **verified on production 05:2xZ** | `revision` reading on 6ad270ac: detector returns feasibility + planSpeed |
| Verified improvement cycles | **0** | — |

### Defects found and fixed tonight (all merged and live)

| PR | defect | root cause |
|---|---|---|
| #957 | evaluator could not record results | 11 KB ssh command line |
| #958 | chunked upload wrote only the first chunk | flyctl read the loop's stdin; colon in ref |
| #960 | baselines recorded on the wrong commit | workflow checkout HEAD ≠ BRAIN_REVISION |
| #963 | detector silence unreadable | readDeficiencies swallows detector errors by design; added a `revision` reading |
| #964 | **every result carried sha "unknown"** | `git rev-parse` inside the container cannot read the worktree metadata, so no baseline ever matched production |
| #962 | watchdog reported a false "Factory fault" that Hermes cited to avoid engineering | bins pinned to quarantined surfaces were counted as executable |

## B/C. Resources

Full audit by the resource session: `docs/intelligence-recovery/resource-utilization-2026-11-15.md` (start 22:15Z; its end reading is due ~06:20Z). Key measured figures:

| class | measured |
|---|---|
| App CPU (2 vCPU) | ~10% steady |
| DB host CPU | 70–75% → **40.7%** after #949 |
| GPU (RunPod) | down ~440 of 480 min on 11-15 (idle stop, then host-full refusals); **restored and auto-migrating since 00:33Z** (#950/#952/#955) |
| Free lane brain-a | 0 of 104 items accepted (provider failures 91–97%) |
| Factory | **1 of 7 registered surfaces usable**; bottleneck SCHEDULING; 3,252 bins, 559 units integrated in 7 days |
| Claude Routines | 0–8% busy |
| Research slots | 13/13, all normal operations ($10K goal) |

Engineering this window: ~90% up curve. Surge A holds no dedicated agents; its reserve is process-level (Deploy verification, hourly reports, incident response).

## D. Hermes

- **Model:** `free:auto/best-coding → free:brain-a → gpu:Qwen3-4B-AWQ`.
- **Runs since the directive:** ≥10, mostly self-scheduled. One run (opr_10d4053932874cca92f7) exceeded its budget after 23 minutes.
- **Independent decisions, none scripted by Claude:**
  1. Picked dfx_2b21d109a13d (116 research rounds abandoned in 7 days) and commissioned diagnostic research (opd_cb28af7138b63975, rgl_cef9c1274065408fa28e).
  2. Judged repeated code fixes for the moot-request defect (dfx_d319a3c45a55) ineffective and switched to diagnosis first (opd_2895b50d216656c9). Lesson recorded.
  3. Re-attempted blocked imp_83515c82b5fb43fa8b83 as imp_3284f5f78219413aa1c5.
  4. Committed the $10K concierge-sprint decision opd_1ce9fb44c8806ba6.
- **Not yet done:** Hermes has not commissioned an experiment with competing approaches. Until 05:2xZ it could not see either benchmark deficiency.
- **Model benchmark:** the director-task suite (#948) exists. A stronger model has not yet been benchmarked or adopted.

## E/F. Experiments and cycles

- Experiments initiated / completed / alternatives rejected / adopted: **0 / 0 / 0 / 0**.
- Production baselines on 6ad270ac:

| suite | metric | value | target |
|---|---|---|---|
| feasibility | accuracy | 0.881 (59/67) | 0.95 |
| feasibility | falseAccept | 0.163 | — |
| feasibility | falseRefuse | 0 | — |
| feasibility | weakest category: AWARD_AS_REPEATABLE | 0.667 | — |
| feasibility | weakest category: CAPABILITY_NOT_HELD | 0.818 | — |
| feasibility | weakest category: PREPAYMENT_UNEVIDENCED | 0.833 | — |
| planSpeed | p50 | ~16.2 s | below target |

- Complete improvement cycles: 0. Second autonomous cycle: not started. Restart survival: the engine is rows plus a scheduled workflow, so it survives a restart; the eight deploys tonight did not lose state.

## G. Money

- New spending tonight: the RunPod pod at ~$0.19–0.24/h. That is ~$1–2 since 00:33Z. It is not metered, because `BRAIN_RUNPOD_USD_PER_HOUR` is unset.
- The combined surge total stays well under the shared $100 ceiling. No additional funding is requested: money removes no measured constraint.

## H. Blockers and critical path

1. Hermes commissions an experiment on a CAPABILITY_BELOW_TARGET deficiency. Both are EVIDENCE today: the cause is not established, so the commission opens cause research first.
2. Factory builds ≥2 variants. Only 1 of 7 surfaces is usable. Surfaces 1 and 3 need the surface owner's connector re-authorized (owner action, already listed by the audit session).
3. The evaluator scores the variants, Hermes decides, the winner is released, and production is re-measured.
4. A second cycle, from the next deficiency.

Risk: the free model times out on longer runs. If the next autonomous runs do not reach a commission, benchmark stronger models (#948 suite) and adopt the best one within budget.

**Estimate:** first cycle in 6–14 h (low confidence; Factory surface count and model quality dominate). The 24 h target is plausible but not likely; the 48 h maximum remains plausible.

## J. Commercial relevance

- The feasibility suite measures exactly the defect class behind the $10K plan's false leads: unfunded deals, unevidenced prepayment, awards treated as repeatable.
- The $10K goal is not qualified. Its best candidate reaches ~9–14% coverage; binding factor CAPITAL; no buyer-validated opening.
- No engine change has improved it yet.
