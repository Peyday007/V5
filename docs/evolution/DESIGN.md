# Capability Evolution Engine — design (owner's order 2026-11-15 ~21:40Z)

It extends §87 (the improvement loop) and §109 (the operator directs engineering).
It adds no scheduler, no second register, no second release path and no second
source of truth.

## Production reading at the start (agents.yml operator-engineering, 21:45Z)

- **Commissioned by Hermes:** 9 engineering interventions. **0** are RESOLVED, so `verifiedCycle` has never passed.
  - 4 delivered and live but unmeasured: their goal is UNKNOWN or no metric is bound.
  - 3 BLOCKED in Factory.
  - 1 KEPT_NO_EFFECT (owner interventions 66 → 60/day, NO_CHANGE).
  - 1 REJECTED.
- **Operator model:** free `auto/best-coding`, then brain-a, then RunPod Qwen3-4B. RunPod currently returns 404.
- **Gap map (code).**
  - One approach per deficiency: `weakness_key` is UNIQUE, and one live objective is allowed per owner component.
  - Nothing compares alternatives before adoption. The only comparison is §87's single before/after z-test after release.
  - Methods are never retired, and no metric scores the loop itself.

## The cycle

1. **Identify.** These come from `readDeficiencies`, plus a generic detector: any capability benchmark whose production baseline misses its declared target becomes a deficiency. Hermes chooses which to pursue; nothing names a specific problem for it.
2. **Explain.** The cause is stated with evidence. EVIDENCE comes first when no cause is established, as now.
3. **Approaches.** `brain_operator_commission` takes `approaches[]`, at least 2. Each is materially different, enforced by a structural signature: approach type plus the owner paths and mechanism words.
4. **Build in parallel.** Each approach becomes its own Factory objective under an *experiment*, without a release grant, so each ends at a pull request. Siblings are exempt from the one-live-objective-per-owner rule.
5. **Evaluate independently.**
   - `evolution-eval.yml` is scheduled and dispatchable. It asks Brain over ssh which experiments are awaiting evaluation.
   - It checks out the baseline (production SHA) and every variant PR head, and runs the experiment's declared benchmark suite on each.
   - Scores are computed by code (`npm run bench`), and the results are recorded back over ssh.
   - **Hidden cases** live in Brain's database, never in the repository, and are fetched only by the evaluator. Implementing agents cannot see them.
6. **Select.** `selectVariant` (pure): the best variant that beats the baseline beyond its noise bound on the primary metric, with no regression past tolerance on any guard metric. Ties go to the smaller diff. If none qualifies, the result is REJECTED_ALL and the next attempt changes method (invariant 16).
7. **Adopt.**
   - The winner gets the existing release grant (LOW risk under the standing order; otherwise it waits for a person), and `factory-release.yml` merges and deploys it.
   - The losing pull requests are closed and recorded REJECTED with their scores.
   - §87's post-release measurement stays as the final KEPT/REVERTED check.
8. **Learn.** For each approach type × capability class, record wins, losses and lift. UCB uses these to prioritise the next experiment's approach types, and an approach type below its threshold after n ≥ 5 trials is retired. The loop's own metric is the experiment yield: adopted improvements per experiment, and hours from identification to adoption.
9. **Prove it.** `verifiedCycle` gains `ALTERNATIVES_COMPARED`: at least 2 variants, an evaluator verdict, and the merged variant must be the selected one.

## Benchmarks (code-scored, offline, deterministic)

- **feasibility.** Plans and pathways must not treat a hypothetical answer to a constraint as available (unfunded deals, unevidenced prepayment, unestablished capabilities, unknown conditions). Scored as the share of cases judged correctly. Public cases live in the repository and hidden cases in Brain's database.
- **planSpeed.** Wall time of the full reconstruction on frozen production plan inputs, with reach and quality held within tolerance as a guard metric.
- Further suites are added by registering a suite (name, primary metric, direction, target, guards, noise bound).

## Ownership (parallel work)

| Workstream | Owns |
|---|---|
| A (experiment core) | `server/domain/evolution.ts`, `server/services/evolution/**`, migrations (both chains), the touch points in `services/improvement/loop.ts`, `services/operator/director.ts` and `domain/engineeringDirector.ts`, and `server/mcp/operatorTools.ts` |
| B (benchmarks + evaluator) | `bench/**`, `scripts/bench.ts`, `scripts/evolution.ts` (the ssh CLI A exposes), `.github/workflows/evolution-eval.yml` |
| C (Hermes model) | the model benchmark, and the routing configuration, by evidence |

Result JSON shared by A and B:
`{ suite, sha, ref, cases:[{id, pass:boolean, score:number, ms:number}], metrics:{ <name>: number }, ranAt }`.
