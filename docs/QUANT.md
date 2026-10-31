# Quantitative inference (§78)

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

* An unsized published rate carries ten events' worth of information (log-odds
  variance 1/10), whatever the rate.
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
