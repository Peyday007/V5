# Scenario simulation and optimization

A reusable Brain capability that evaluates up to 50,000 scenarios per run, compares
controllable strategies on the same scenarios, exposes downside risk, and says which
inputs drive the result. CLAUDE.md §59 records the rules; this page is how to use it.

## Where it is

- **In Brain:** More → **Scenarios** (`/scenarios`), inside the open project. The page
  opens on a read-only **demonstration model** (illustrative, computed on read, never
  stored). *Save an editable copy* turns it into a saved model you can change and run.
- **API** (project-scoped, a person only; a worker is refused by type):

| Method | Path | What |
|---|---|---|
| GET | `/api/projects/:id/scenarios` | saved models, limits |
| GET | `/api/projects/:id/scenarios/demonstration` | the demonstration and its 50,000-evaluation result (writes nothing) |
| POST | `/api/projects/:id/scenarios` | `{ definition }` or `{ fromDemonstration: true }` |
| GET / PATCH | `/api/projects/:id/scenarios/:modelId` | read with its runs / revise the definition |
| POST | `/api/projects/:id/scenarios/:modelId/archive` | archive (destroys nothing) |
| POST | `/api/projects/:id/scenarios/:modelId/runs` | `{ options: { seed, evaluations, basis?, overrides?, objective?, acceptable? }, label? }` |
| GET | `/api/projects/:id/scenarios/:modelId/runs/:runId` | a run with its full result and the exact definition it evaluated |
| POST | `/api/projects/:id/scenarios/:modelId/runs/:runId/reproduce` | re-run the recorded config and compare digests (writes nothing) |

- **Code:** `runScenarioModel(definition, options)` in `server/services/scenario/run.ts` is
  the one pure entrance — no rows, no effects. The vocabulary is `server/domain/scenario.ts`.
- **Benchmark:** `npm run scenario:bench -- --runs 5 --evaluations 50000`.

## A model

```ts
{
  title, currency: 'USD', horizon: 'six months of operation',
  variables: [ { key, label, unit, provenance, controllable, spec, sources?, responses?, activeWhen?, testRange? } ],
  correlations?: [ { a, b, rho, provenance } ],      // rank correlation, Gaussian copula
  derived?: [ { key, label, unit, expr } ],          // evaluated in order
  lines: [ { key, label, kind: 'REVENUE' | 'COST', expr } ],
  metrics?: [ { key, label, unit, expr, better, role? } ],   // CAPITAL_EXPOSURE, DAYS_TO_CASH, LABOR_HOURS
  constraints?: [ { key, label, expr, op, value } ],          // violated = infeasible, counted
  strategies: [ { key, label, set: { controllableKey: value | optionKey } } ],
}
```

**Spec kinds:** `FIXED`, `RANGE` (swept), `TRIANGULAR`, `NORMAL` (bounded), `EMPIRICAL`
(observed values), `CHOICE` (options with numeric attributes, read as `choice.attribute`).

**Provenance** — `EVIDENCE`, `HISTORICAL`, `ASSUMPTION`, `HYPOTHETICAL`, `UNKNOWN`:

- Only `EVIDENCE` and `HISTORICAL` may carry a distribution or choice weights.
- An `UNKNOWN` must be a `RANGE` (or an unweighted `CHOICE`): it is swept, never given one value.
- Relationships (`responses`, `correlations`) carry their own provenance.

**Expressions** are a closed grammar parsed by hand: numbers, declared identifiers,
`+ - * / ^`, comparisons, `&& ||`, and `min max abs floor ceil round pow sqrt if clamp`.
An undeclared name is a refusal; division by zero makes the scenario **invalid** (counted),
never zero.

**Money** is the line items: contribution = Σ revenue lines − Σ cost lines, each line rounded
to whole cents per evaluation. A model cannot write contribution, and two lines with the same
expression are refused as a double count.

## A run

- **Evaluations** = scenarios × strategies, at most 50,000. Every strategy is evaluated
  against the identical scenario draws (common random numbers), so differences are paired.
- **Basis.** `MONTE_CARLO` is allowed only when every sampled input and correlation is
  sourced; then shares are estimated probabilities. Otherwise the run is a `SWEEP` — a Latin
  hypercube over the declared ranges — and every share is *coverage of the tested
  conditions*, never a probability. Requesting Monte Carlo over assumptions fails with the
  reason.
- **Reproducible.** xoshiro128** seeded from the recorded seed, one stream per variable key.
  The same definition, seed and options give the same `resultDigest` after any restart; the
  page's *Re-run and compare* checks it.
- **Bounded.** 50,000 evaluations, 40 variables, 8 strategies, expression size and depth caps,
  and a 20 s wall-clock budget past which the run fails rather than hangs.
- **Stress tests** (`overrides`) multiply or replace an input in every scenario and are
  recorded on the result.

## What a result says

Per strategy: contribution P5–P95, mean, worst-10% mean, loss share, acceptable share, share of
scenarios where it was best (paired), regret, each metric's distribution, money lines, a shared
histogram, distinct outcomes, and the five worst scenarios **with the exact inputs behind each**.

Across strategies: which are **dominated** (no better on any named criterion — P50, P10 and P90
contribution, acceptable share, each metric — and worse on one), the **trade-offs** among the
rest, and an order **only under an objective a person chose**. No weights, no single winner.

Sensitivity: one-at-a-time swings around a stated baseline ("must hold" when the adverse end
turns contribution negative), Spearman rank correlation over the whole run, **break-evens**
by bisection on the baseline, *what if this input doubled*, and **what to find out next** — the
assumptions and unknowns whose range would change which strategy does best come first.

Every result carries `simulated: true`, the configuration hash, the seed, the basis note, the
provenance count and a list of limitations.

## Measured

On the development container (Node 22, linux/x64), the demonstration model — 15 variables,
4 strategies, 50,000 evaluations (12,500 scenarios × 4) plus all sensitivity — took a median
of about 0.5 s (5 runs: 473–630 ms), peak RSS about 210 MiB, result JSON about 56 KiB, the
same digest every run. A reading of one machine, not a claim about any other.

## Integration points (not wired to any live decision)

A future integration composes a `ScenarioModelDefinition` from its own rows and calls
`runScenarioModel`; it does not copy a business model into this engine.

- **Values and sources:** each variable's `sources` takes `{ kind, ref }` — `CLAIM`,
  `CASH_OPPORTUNITY`, `CARD_FACT`, `LEDGER_ENTRY`, `DOCUMENT`, `URL`, `PERSON`. A card fact
  with an `EVIDENCE` source may become a distribution; a proposal stays an `ASSUMPTION` range;
  a blank stays `UNKNOWN` and is swept — the same rule `cash/forecast.ts` applies by withholding.
- **Candidates:** Cash opportunity economics, monetization path comparisons, Factory capacity
  planning (the fleet replay in `dispatch/simulate.ts` stays the owner of fleet throughput),
  resource allocation, research prioritization (`investigate` is a value-of-information list).

**Before live Cash integration:** a mapper from an opportunity's card facts and ledger rows to
variables (one owner per fact — the card stays the owner), a decision about which Cash
surface reads a result and how it is labelled there, and evidence-backed distributions, which
today exist for almost no Cash field. Nothing in this capability reads or writes Cash rows,
and no result may move an opportunity, spend money or contact anybody.
