# Quantitative inference (§79)

Brain can now estimate a number nobody has published, from what the world does
know about the mechanism behind it, and say exactly how far that estimate can
be trusted. It extends the scenario engine (§60) and the plan gate (§77) and
adds no second simulator, evidence store or approval path.

## Where it lives

| piece | file | what it decides |
|---|---|---|
| vocabulary | `server/domain/quant.ts` | tiers, observations, nodes, estimates |
| synthesis | `server/services/quant/pool.ts` | staleness, transfer, shared data, random-effects pooling |
| reconstruction | `server/services/quant/reconstruct.ts` | the evidence ladder, recursion, propagation |
| arrangements | `server/services/quant/mechanism.ts` | demand × supply × capture, for arrangements with no name |
| information value | `server/services/quant/value.ts` | which unknown could change the choice |
| calendar | `server/services/quant/deadline.ts` | research first, learn by doing, act, or ignore |
| combinations | `server/services/quant/portfolio.ts` | shared resources, capital recycling, correlated risk |
| export | `server/services/quant/export.ts` | an estimate as a scenario input, never overstated |
| knowledge | `server/services/quant/knowledge.ts` | Brain's own card facts and outcomes as observations |
| problems | `server/services/quant/problem.ts`, `npm run quant` | one question end to end, from a file |

## The ladder

An estimate climbs and stops at the first rung that is precise enough
(`sufficientWidth`; by default p90/p10 ≤ 2.5 for a magnitude, p90 − p10 ≤ 0.15
for a share):

1. **DIRECT**: evidence about this exact population.
2. **COMPARABLE**: other populations whose context matches on every dimension
   the quantity declares *material*. Each immaterial difference discounts the
   observation (weight × 0.7). A material difference excludes it unless a
   declared adjustment, with its own source, bridges that exact difference. A
   material dimension the source does not state is never assumed to match.
3. **COMPONENT**: the node's formula over child nodes, each resolved on its
   own ladder (memoized, depth 8, 200 nodes, cycles refused). Samples are
   propagated through the formula under declared correlations. When the
   result shares no data with the pooled evidence, the two are combined by
   inverse variance.
4. **MECHANISM**: broad economic evidence only. These are bounds, never a
   distribution.
5. **ASSUMED / UNKNOWN**: a person's range, or physical bounds.

Pooling is DerSimonian–Laird random effects. Shares are pooled on the logit
scale and magnitudes on the log scale. The between-population spread has a
floor: 0 for direct evidence, 0.3 across comparables, 0.8 for broad evidence.
The predictive spread for the target is the pooled mean's uncertainty plus that
spread, because a new population is not the average population.

Observations whose lineages intersect are one observation counted twice. The
group keeps its most informative member and reports the others as collapsed.

### Conventions, named so a reader can see what was assumed

* An unsized published rate carries four events' worth of information (log-odds
  variance 1/4), whatever the rate, and **an estimate resting only on unsized
  rates is bounds, never a distribution**: the source stated where the rate is,
  not how precisely anyone measured it. (Reviewed 2026-11-01; it was ten events
  and always a distribution, which let three unsized benchmarks pool into a
  spread as narrow as a few dozen observed contacts.) A ratio of two published
  amounts about one case — a cost over a price — is marked `exact` and is not a
  sampled rate.
* One published magnitude has a 10% reading error.
* A published range is read as a 90% interval.

## What may become a probability

Only DIRECT, COMPARABLE, or COMPONENT estimates whose parts all rest on
evidence may be exported as a distribution (an `EMPIRICAL` scenario variable
built from 101 quantiles). Everything else is exported as a `RANGE`, so a run
over it is a sweep. §77 then refuses to read its coverage as a chance.

## In the live goal workflow

* `composeGoalModel` infers each unknown days-to-cash, direct-cost share,
  capital share and agreement rate from the project's other openings
  (`knowledge.ts`) before it falls back to the blind sweep range. The
  opening's own facts are direct evidence. Other openings of the same
  mechanism are comparables. Openings of other mechanisms are broad evidence.
* An inferred input keeps `value: null`, so it never establishes a link in the
  plan gate. It only replaces a blind sweep with an evidenced one.
* When a justified reconstruction puts nine settlements in ten after the
  deadline, the strategy is NOT_VIABLE and the reason says so.
* The goal's scenario run is asked for `informationValue` on `goal_met`. Each
  sampled input becomes a `researchPriority` entry with a calendar decision.
  Path research no longer asks a question whose answer could not change the
  choice, or one that waiting for would cost the deadline.
* `npm run goals -- plan <goal>` and the Goals workflow print what was
  inferred, which questions matter, and the time taken.

## Constructing arrangements and asking whether they repeat (§81)

* `services/cash/construct.ts` composes arrangements from parts the project
  holds independently — a `BUYER_TYPE`, `BOTTLENECK` and `FULFILMENT_SOURCE` on
  the industry map, an evidenced payer on an opening, a deliverable Brain proved
  — and a closed table of capture structures (produce for a fee, broker for a
  commission, refer for a fee, subcontract for a margin, pool purchases for a
  margin). A structure applies only where its parts exist, and an opening
  already held in that shape is not offered back.
* Each arrangement is decomposed with `composeArrangement` and resolved by
  `reconstruct`. The parts nothing establishes become the research round's
  question; a part already established (what this buyer pays, from the
  project's own priced openings) is stated and only confirmed.
* When the held pool cannot reach a goal, the plan pass opens rounds for the
  best-ranked arrangements (`goal-<id>-mx-<key>`) beside the lens rounds,
  through the same gate, frame, harvest and live cap. The reading says
  `POOL_INSUFFICIENT` — a fact about what Brain holds, never that nothing
  viable exists.
* A play sold repeatedly is worth its price times the deals the market can
  take in the window, and that number is `buyerVolume` on the card: reachable
  buyers and how often each buys, read by `services/cash/volume.ts` only where
  a source states a count. Until research states it the model sweeps it, the
  plan's `MARKET_VOLUME` link is missing, and a supported reach counts one
  deal. Any opening becomes repeatable when research shows more than one deal
  in the window; path research asks it whenever one deal cannot carry the goal.
* `npm run goals -- plan <goal>` prints the arrangements and their unknown
  parts; `goals construct <goal>` opens this pass's rounds now, as the tick would.

## Designs, properties and reverse construction (§82)

Every constructed arrangement carries a transaction design (base structure,
funding, aggregation, repeat) and the economic properties derived from it
(`server/services/cash/properties.ts`). A property adds the parts that would
establish it to the decomposition, so the round asks for them. Reverse
construction starts from the properties the goal's limits require and asks the
world for buyers that fit; transfer carries a design a gated opening shows
working to another buyer. `stressDesign` judges the worst case on bounds, and
`composeArrangement` takes `pooling`, `funding` and `repeat` parts so a shared
run's threshold, fixed cost and unfunded exposure are formulas, not prose.
`npm run goals -- plan <goal>` prints the targets, exclusions, origins and
worst cases of what was constructed.

## Information value

EVPPI is estimated by sorting worlds into ten quantile bins of an input. A bin
switches from the baseline strategy only when the paired gain is more than two
standard errors above zero. Without that check, taking the largest bin mean
rewards noise, and an irrelevant input reads as worth knowing.

## What it does not do

* It does not invent a distribution for an assumption, or a probability from
  bounds.
* It does not average incompatible figures. A different definition or
  population is either excluded or explicitly adjusted.
* It does not spend, contact or publish. A problem file is an analysis. A
  quantitative recommendation to a person still goes through `npm run
  plan:check`.
