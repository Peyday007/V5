# Lens S — search narrowing, multidirectional reasoning, transfer (Surge B)

Read-only. One scratch test (`tests/zzLensSScratch.test.ts`) was written, run and **deleted**.
`node_modules` was absent; `npm ci` was run to get vitest (gitignored, no tracked file changed).
Nothing here repeats PLANNING-RECOVERY-2026-11-14 items (Q-1…Q-9, C-1…C-15, O-3 etc.).

## 1. The funnel, every cutoff

| stage | file:line | cut | ranked by before the cut | verdict |
|---|---|---|---|---|
| forward construction | `cash/construct.ts:138,372-393` | `MAX_CONSTRUCTIONS = 400`, `break outer` | **nothing** — enumeration order: design (defaults first, then base×funding×aggregation×repeat) → sector → demand → need → supply | S-3 |
| reverse construction | `construct.ts:140,426-443` | `MAX_REVERSE = 4`, one per base | targets met, fewest parts, then `designKey` text | ok (diversity by base) |
| constructor rank | `construct.ts:452-505` | none (order only) | exposure, targetsMet, precedent, evidenced, repeat, tier, unknowns, key; interleaved by population | **not used downstream** by the model pick |
| arrangements → model | `cash/goalScenario.ts:179,272-298` | `MAX_ESTIMATED_ARRANGEMENTS = 12`, one per population | `score = min(remaining, p50 × min(200, ceil(remaining/p50)))` then **opportunity id (`arr_` + sha256 key)** | S-1, S-2 |
| openings → scenario model | `goalScenario.ts:76,771-790` | `MAX_MODEL_OPPORTUNITIES = 8` (80 vars) | in-flight/agreed, membership of quant best, demand p50, priced reach, evidence | quantitative; reconstruction still sees all candidates (`plan.ts:1408`) → not a defect |
| quant optimizer | `quant/portfolio.ts:282,959-985` | exhaustive ≤12 activities, greedy beyond; `ranked.slice(0,8)` | engine reading | ok |
| §99 operator target | `goals/reconstruction.ts:988-991,738,232` | single target | price×close at **midpoint of unknown ranges** | S-5 |
| §101 seeds | `reasoning/directions.ts:550,556,564,573` | `slice(0,3/5/6/5)` | `valuePerInterested` (midpoint, S-5) | S-5 |
| §101 pool | `directions.ts:765-766,882-893` | `distinct(..., budget+swept)` | order: sweep → library → seeds | S-8 |
| §102 channel targets | `reasoning/variables.ts:453-458` | top 4 | price×close×respond at midpoints | S-5 |
| §102 factorial | `variables.ts` (screen → drop weakest level by main effect), `:736-764` POOL 3000, `:910` approaches dropped per round | main effect only | S-16 |
| research asks | `goals/plan.ts:2933-2978` | live-cap half | `arrangementContribution` (only the 12 picked have one; the rest −1) | S-4 |

Reconsideration when evidence changes: every stage is recomputed per read (memo keys include openings' `updatedAt`
and priced observations, `construct.ts:307-309`; reconstruction keyed by inputs, `plan.ts:1410`). Mechanically fine —
but nothing records what was cut (S-17), and S-4 makes the arbitrary pick self-reinforcing.
Duplicate evaluation: constructions memoised 30 min, reconstruction cached per inputs, directions deduped by signature,
sweep by plan signature — no material duplicate-evaluation defect found.

## Experiment (Q4) — the strongest arrangement excluded by the early cutoff

Scratch test on `pickEstimatedArrangements` + `evaluateGoalPortfolio` with `tests/fixtures/goal10k.ts`
(8 fixture openings, $10K/30d/$3K, 2,000 worlds):

- 30 ordinary repeatable designs, MECHANISM tier, p50 $300 (all score exactly 10,000 = remaining).
- One strong design: DIRECT tier, 20 observations, p50 $3,000, SAFE, subscription — also scores 10,000.
- Picked or not, **by its key string alone**: `aa-strong` picked; `zz-strong`, `strong-1…6` all excluded.
  Production keys are 12-hex sha256 digests, so this is a coin flip by hash.
- A DIRECT one-off worth $9,000 (score 9,000) is excluded by every $300 repeatable design (score 10,000).
- Engine consequence: 12 as picked → best reach 1.55% (p50 $50, members `arr_ord00`+Sudoku);
  11 of them + the excluded strong one → 2.8% (best = `arr_zz-strong`). The engine prefers the arrangement the cut threw away,
  and no later stage (sweep, directions, invented methods) can bring it back (S-6).

## Findings

**S-1 · BLOCKING · `cash/goalScenario.ts:283-297`** — Arrangement pick is effectively random.
Symptom: which 12 of ≤404 constructed arrangements enter the goal model is decided by sha256 key order.
Root cause: `score = min(remaining, p50 × deals)` with `deals = min(200, ceil(remaining/p50))` saturates at `remaining`
for every repeatable design with p50 ≥ remaining/200 ($50 on the $10K goal); the tiebreak is `opportunity.id`
(`arr_<sha256>`). Tier, observations, exposure, value spread and the constructor's own rank (`construct.ts:452`) are ignored.
Repair: score each arrangement with the §102 closed form (`fastReading` on the arrangement alone plus the held openings,
microseconds each) or at least `p10 × min(volume_low_estimate, deals)` discounted by tier; tiebreak by the constructor's
rank index, never by id; reserve slots per base structure / funding (diversity quota) and 2 slots for high-variance
designs (largest p90/p50) so unusual-but-promising candidates are protected.

**S-2 · MAJOR · `goalScenario.ts:286-296`** — The design that stands for a buyer population is arbitrary.
Root cause: "the highest-scoring arrangement stands for the population", but all designs over one population tie
(S-1), so ON_DELIVERY vs PREPAID vs THRESHOLD_PRESALE vs SUBSCRIPTION is chosen by hash; structurally different
strategies for the same buyers never compete. Repair: pass every design of a population with a shared `marketKey`
(the engine already caps one market across clones, `goals/portfolio.ts:99,714`) so the optimizer picks the design and
never sums them; or pick the representative by fast reading.

**S-3 · MAJOR · `cash/construct.ts:372-393`** — Construction truncates at 400 in enumeration order, unranked.
Designs are outermost and defaults first, so on a map with ≥400/|bases| demand×need×supply combinations every non-default
design (prepaid, threshold presale, pooled, subscription — the §82 properties) of every forward arrangement is never built,
and sectors late in `sectors` iteration lose all variants. Repair: enumerate (design, population) pairs round-robin by
population and by design property set before the cap, or rank a cheap key (targetsMet, exposure, evidenced) on the
un-composed tuple and compose the top 400; report the truncated count.

**S-4 · MAJOR · `goals/plan.ts:2933-2978`** — The arbitrary pick also steers research.
`arrangementContribution` covers only the 12 estimates in `portfolio.demand`; the others get −1, so constructed rounds
ask the hash-picked arrangements first; their answers raise their tier and keep them picked. Repair: order research by
information value over the full constructed pool (S-1's fast reading), not by membership of the cut set.

**S-5 · MAJOR · `reasoning/directions.ts:225`, `reconstruction.ts:232-240,738,988-991`, `reasoning/variables.ts:453-458`** —
Unknowns ranked at their midpoint (invariant 39). `valuePerInterested`/`targets` use the midpoint of UNKNOWN sweep
ranges: an estimated arrangement's close `unknown(0.02,0.5)` reads 0.26 and outranks an evidenced 0.05–0.25 (0.15).
So §99's default operator target, FOCUS/TOP/REST scopes, RELATIONSHIP/OPPORTUNITY seeds and the sweep's four channel
targets favour the least-known candidates. Repair: rank on `low` (or p10) for UNKNOWN/ASSUMPTION provenance, midpoint only
for EVIDENCE; one shared `rankValue()` used by all three modules.

**S-6 · MAJOR · `directions.ts:78-88`, `variables.ts` levels** — No method can add a candidate.
The transform vocabulary is OPERATOR/PRICE/FOCUS/DROP/STRESS over `ctx.base.openings`; every direction, sweep strategy
and model-invented program can only re-weight what S-1 admitted. Repair: an `INCLUDE {arrangementKey}` transform (and a
sweep decision variable whose levels are the next-best K constructed arrangements by fast reading) drawing from the
full constructed pool, judged by the same engine.

**S-7 · MAJOR · `reasoning/learning.ts:77-81`** — The library learns from the wrong signal.
`lift = reading.reach − baseline.reach` on the unchallenged reading (coverage of assumptions) and includes readings the
plausibility critic flagged; only `wins` uses the challenged score. Assumption-stacking methods accrue improvements and
lift and rise in UCB. Repair: lift = `scoreOf(reading, challenged)` − greedy score; skip `implausible`; store bare reach.

**S-8 · MAJOR · `directions.ts:328-331`, `learning.ts:41-48`, `directions.ts:765`** — Learned methods are goal-instance
programs. Signatures and programs carry opening ids (`op:partner:>cop_…`, `id:` scopes); on another goal they do not
apply, yet they occupy `distinct` slots ahead of the seeds, and a partly-applied program (e.g. only `capital:prepaid`
lands) credits the foreign signature. Repair: store programs with role targets (TOP_k, LARGE_TICKET…) and key learning
by the abstract signature; drop non-applicable library entries before `distinct`.

**S-9 · MINOR · `learning.ts:36,66-75`** — Tries are not independent: every persisted re-read of one goal increments
tries, so UCB is one goal's repeated reads; SQL pre-cuts to 400 by wins/best_lift before UCB. Repair: one credit per
(goal, inputs key); UCB over all rows (or per stance).

**S-10 · MAJOR · `directions.ts:516-582,811-822`; `variables.ts:903-910`** — Method selection is not adaptive by stance.
Seeds produce the same stances every read; `stanceYield` is computed and recorded but never read back; the sweep's
approach UCB lives inside one sweep. Only whole programs (S-8) are learned. Repair: persist stance yield and allocate the
seed budget per stance by its posterior.

**S-11 · MAJOR · `reasoning/invent.ts:44-51`, `directions.ts:925-974`** — "Invented" methods can only re-parameterise
the four ops on held openings; a new buyer, mechanism or arrangement becomes an `ask` in the search brief, never a plan
candidate. Repair: let the model emit a design tuple + population, composed via `construct.compose` →
`estimatedFromArrangement` → engine (with S-6's INCLUDE).

**S-12 · MAJOR · `construct.ts:446-448,540-563,621-623`; `goalScenario.ts:241-246`** — TRANSFER accounts for no difference.
`material: []` on the value node, so no dimension (jurisdiction/legal, buyer kind, payment terms, sales cycle, capital)
must be bridged; the precedent's own close, days-to-cash and outlay are not carried (generic sweeps 2–50%, 3–60 days);
the precedent only adds a lexicographic rank bonus placed **above** `evidenced` and a sentence. Repair: carry the
precedent's measured terms as COMPARABLE bounds with material dimensions requiring a sourced adjustment (`pool.ts`
`findAdjustment`), widen by `SPREAD_FLOOR.COMPARABLE`; move the precedent key below `evidenced`.

**S-13 · MAJOR · `construct.ts:542`; `pool.ts:220-240`; `goals/portfolio.ts:714-721`** — Shared observations counted as
independent across arrangements. Every arrangement's value is reconstructed from the same project-wide `priced` pool
(broad for other payers); lineage collapse is per node, not across arrangements; in the portfolio each estimated
arrangement's price is an independent draw (only outreach is correlated), so 12 estimates built on the same few figures
diversify an error that is in fact common → coverage overstated. Repair: tag each estimate with its observation lineage
and draw one shared factor per lineage group per world (as resources already are), or one risk group for estimates
priced from the same broad set.

**S-14 · MINOR · `goalScenario.ts:283`** — a large one-off can never beat a repeatable design (experiment: $9,000 DIRECT
one-off loses to $300 designs). Fixed by S-1.

**S-15 · MINOR · `plan.ts:914,2913-2916,2952`** — `bestReachCents` never reaches construction: the plan read composes with
null and the 10-minute per-goal cache ignores the argument the asking pass passes; REPEATABLE is always a target
(`properties.ts:288`). Repair: key the cache on `bestReachCents` or derive targets after the reading.

**S-16 · MINOR · `variables.ts` narrowing, `:910`** — Factorial narrowing drops levels by main effect, losing
interaction-only levels (e.g. capacity × prepaid); approaches are dropped each local-search round. Repair: protect the
best level per family from the screen's top interactions.

**S-17 · MINOR · `goalScenario.ts:297`, `construct.ts:391`** — Cut arrangements leave no `excluded` row or reason
(openings do). Repair: return `excludedArrangements` with score and reason, print in `npm run goals -- plan`.

## 2. Methods (Q2)

All run on the same fixed opening set (S-6). "Changes plan" = can win and be adopted via `adoptReconstruction`.

| method | where | implemented | reachable in prod | changes plan |
|---|---|---|---|---|
| forward | `directions.ts:537-541`; sweep FORWARD | yes | yes | yes |
| backward | `directions.ts:528-535`; sweep BACKWARD; `pathways.requiredStructures`; reverse construction | yes | yes | directions/sweep yes; pathways arithmetic → brief only |
| middle-out | `directions.ts:543-551`; sweep MIDDLE_OUT | yes | yes | yes |
| constraint-first | `directions.ts:553-558`; sweep BOTTLENECK | yes | yes | yes |
| resource-first | `directions.ts:561`; PERSPECTIVE:CAPITAL | yes | yes | yes |
| opportunity-first | `directions.ts:571-573` (partner channel on an under-used opening) | narrow | yes | yes |
| causal decomposition | reconstruction diagnose; properties decomposition parts | not a planning method | yes | no — feeds seeds/asks |
| mechanism transfer | `construct.ts` TRANSFER only | rank bonus + question | yes | no (S-12) |
| combination | `recombine` `directions.ts:600`; sweep COMBINE | yes | yes | yes |
| portfolio | FOCUS 2/3/5; quant optimizer | yes | yes | yes |
| capital restructuring | `capital:prepaid`, `timing:deposit`, FINANCING var | yes (assumed) | yes | yes |
| risk redistribution | partner commission; threshold presale design | no explicit method | — | no |
| transaction restructuring | TRANSACTION bundle/retainer, PRICE | yes | yes | yes |
| counterfactual | `@no-assumptions` challenge; sweep "mathematically possible" | critique only | yes | scoring/eligibility only; math-only → prose/asks |
| adversarial | halved-conversion challenge, plausibility critic | critique only, no generator | yes | eligibility only |
| iterative improvement | generations ≤4, `mutate`; sweep local search | yes | yes | yes |
| model-invented | `invent.ts` (free lane, ≤1/15 min/goal) | yes, vocabulary-bound (S-11) | only if lane configured | yes |

Adaptive selection: program-level UCB library only (S-7…S-10); data flows on every persisted, non-cached plan read
(`plan.ts:1429-1432`). Production row counts not verified here.

## 3. Transfer (Q3)
See S-12 (differences not modelled) and S-13 (shared figures sampled as independent). Within one estimate, lineage
collapse prevents double counting (`pool.ts:220`); across arrangements it does not.
