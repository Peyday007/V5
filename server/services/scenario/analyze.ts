/**
 * What a run means: distributions, comparison, and what drives the answer.
 *
 * **Nothing here declares a winner.** A weighted score would need weights, the
 * weights would be a judgement nobody made, and the number would then read
 * like a measurement — §30's argument, at a decision engine. So the comparison
 * reports what can be established without one: which strategies are dominated
 * (worse or equal on every named criterion, worse on at least one), the
 * trade-offs among the rest, paired win share and regret, and — only when a
 * person names an objective and its constraints — the order under that
 * objective.
 *
 * Sensitivity is answered three ways because the three questions differ:
 * one-at-a-time swings around a stated baseline (which input moves the
 * outcome, holding the others), rank correlation across the whole run (which
 * input the outcome actually tracked), and break-evens found by bisection on
 * the baseline (where the contribution crosses zero). Each says what it held
 * fixed, because a break-even quoted without its baseline is a different claim.
 */
import type {
  BreakEven,
  Distribution,
  DominanceFinding,
  DownsideCase,
  Histogram,
  InvestigationPriority,
  ObjectiveRanking,
  SelectedObjective,
  Sensitivity,
  StrategyResult,
  StressReading,
  SummaryStatistic,
  TornadoBar,
  TradeOff,
} from '../../domain/scenario.ts';
import type { CompiledModel, CompiledVariable } from './model.ts';
import { Evaluator, fromUniform, type Draws, type Overrides, type RawRun } from './engine.ts';

const HISTOGRAM_BINS = 24;
const DOWNSIDE_CASES = 5;

function quantileSorted(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function distribution(values: Float64Array, better: 'HIGHER' | 'LOWER'): Distribution | null {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / sorted.length;
  let sq = 0;
  for (const v of sorted) sq += (v - mean) * (v - mean);
  const tailCount = Math.max(1, Math.floor(sorted.length * 0.1));
  let tail = 0;
  if (better === 'HIGHER') for (let i = 0; i < tailCount; i++) tail += sorted[i]!;
  else for (let i = sorted.length - tailCount; i < sorted.length; i++) tail += sorted[i]!;
  return {
    mean,
    sd: Math.sqrt(sq / sorted.length),
    min: sorted[0]!,
    p5: quantileSorted(sorted, 0.05),
    p10: quantileSorted(sorted, 0.1),
    p25: quantileSorted(sorted, 0.25),
    p50: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p90: quantileSorted(sorted, 0.9),
    p95: quantileSorted(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    tail10: tail / tailCount,
  };
}

function pick(dist: Distribution | null, statistic: SummaryStatistic): number | null {
  if (!dist) return null;
  switch (statistic) {
    case 'MEAN': return dist.mean;
    case 'P10': return dist.p10;
    case 'P50': return dist.p50;
    case 'P90': return dist.p90;
    case 'MIN': return dist.min;
    case 'MAX': return dist.max;
    default: return null;
  }
}

/** The inputs one strategy actually saw in one world, by key, for inspection. */
export function inputsFor(model: CompiledModel, evaluator: Evaluator, values: ArrayLike<number>, strategy: number): Record<string, number | string> {
  evaluator.fill(values, strategy);
  const inputs: Record<string, number | string> = {};
  for (const [v, cv] of model.variables.entries()) {
    if (cv.isChoice) inputs[cv.spec.key] = cv.optionKeys[evaluator.env[cv.slot]!] ?? '?';
    else inputs[cv.spec.key] = evaluator.isActive(v) ? round6(evaluator.env[cv.slot]!) : `n/a (${round6(evaluator.env[cv.slot]!)})`;
  }
  return inputs;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function worldValues(model: CompiledModel, draws: Draws, i: number): Float64Array {
  const values = new Float64Array(model.variables.length);
  for (let v = 0; v < model.variables.length; v++) values[v] = draws.base[v * draws.scenarios + i]!;
  return values;
}

export function strategyResults(
  model: CompiledModel,
  draws: Draws,
  raw: RawRun,
  overrides: Overrides,
  minContributionCents: number,
): StrategyResult[] {
  const { scenarios } = raw;
  const strategyCount = raw.strategies;
  // Paired comparison: per scenario, the best feasible contribution.
  const best = new Float64Array(scenarios).fill(Number.NEGATIVE_INFINITY);
  const bestStrategy = new Int32Array(scenarios).fill(-1);
  const bestAny = new Float64Array(scenarios).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < scenarios; i++) {
    for (let s = 0; s < strategyCount; s++) {
      const at = s * scenarios + i;
      if (raw.status[at] === 1) continue;
      const c = raw.contribution[at]!;
      if (c > bestAny[i]!) bestAny[i] = c;
      if (raw.status[at] === 0 && c > best[i]!) { best[i] = c; bestStrategy[i] = s; }
    }
  }
  // Shared histogram edges across strategies, over feasible contributions.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < raw.contribution.length; at++) {
    if (raw.status[at] !== 0) continue;
    const c = raw.contribution[at]!;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const edges: number[] = [];
  if (Number.isFinite(lo)) {
    const width = hi > lo ? (hi - lo) / HISTOGRAM_BINS : 1;
    for (let b = 0; b <= HISTOGRAM_BINS; b++) edges.push(Math.round(lo + b * width));
  }

  const evaluator = new Evaluator(model, overrides);
  return model.strategies.map((strategy, s) => {
    const feasible: number[] = [];
    let invalid = 0, infeasible = 0, losses = 0, acceptable = 0, wins = 0;
    const regret: number[] = [];
    for (let i = 0; i < scenarios; i++) {
      const at = s * scenarios + i;
      const status = raw.status[at]!;
      if (status === 1) { invalid++; continue; }
      const c = raw.contribution[at]!;
      if (c < 0) losses++;
      if (Number.isFinite(bestAny[i]!)) regret.push(bestAny[i]! - c);
      if (status === 2) { infeasible++; continue; }
      feasible.push(at);
      if (c >= minContributionCents) acceptable++;
      if (bestStrategy[i] === s) wins++;
    }
    const contributionValues = Float64Array.from(feasible, (at) => raw.contribution[at]!);
    const metrics: StrategyResult['metrics'] = {};
    for (const [m, metric] of model.metrics.entries()) {
      metrics[metric.key] = distribution(Float64Array.from(feasible, (at) => raw.metrics[m]![at]!), metric.better);
    }
    const lines: StrategyResult['lines'] = {};
    for (const [l, line] of model.lines.entries()) {
      const values = Float64Array.from(feasible, (at) => raw.lines[l]![at]!);
      const dist = distribution(values, 'HIGHER');
      lines[line.key] = { meanCents: dist ? Math.round(dist.mean) : 0, p50Cents: dist ? Math.round(dist.p50) : 0 };
    }
    const counts = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
    if (edges.length > 1) {
      const first = edges[0]!;
      const span = edges[edges.length - 1]! - first;
      for (const c of contributionValues) {
        const bin = span > 0 ? Math.min(counts.length - 1, Math.floor(((c - first) / span) * counts.length)) : 0;
        counts[bin]!++;
      }
    }
    const histogram: Histogram = { edges, counts };
    // The worst outcomes this strategy had, with exactly the inputs that produced them.
    const order = [];
    for (let i = 0; i < scenarios; i++) if (raw.status[s * scenarios + i] !== 1) order.push(i);
    order.sort((a, b) => raw.contribution[s * scenarios + a]! - raw.contribution[s * scenarios + b]! || a - b);
    const downside: DownsideCase[] = order.slice(0, DOWNSIDE_CASES).map((i) => {
      const at = s * scenarios + i;
      const violated: string[] = [];
      for (const [c, constraint] of model.constraints.entries()) if (raw.violated[at]! & (1 << c)) violated.push(constraint.label);
      return {
        scenario: i,
        contributionCents: raw.contribution[at]!,
        inputs: inputsFor(model, evaluator, worldValues(model, draws, i), s),
        infeasible: violated,
      };
    });
    const regretSorted = Float64Array.from(regret).sort();
    const regretMean = regret.length ? regret.reduce((a, b) => a + b, 0) / regret.length : 0;
    return {
      key: strategy.spec.key,
      label: strategy.spec.label,
      evaluated: scenarios,
      invalid,
      infeasible,
      contribution: distribution(contributionValues, 'HIGHER'),
      lines,
      metrics,
      lossShare: losses / scenarios,
      acceptableShare: acceptable / scenarios,
      winShare: wins / scenarios,
      regret: {
        meanCents: Math.round(regretMean),
        p90Cents: Math.round(quantileSorted(regretSorted, 0.9) || 0),
        maxCents: regretSorted.length ? regretSorted[regretSorted.length - 1]! : 0,
      },
      histogram,
      downside,
      distinctContributions: new Set(contributionValues).size,
    };
  });
}

interface Criterion {
  label: string;
  better: 'HIGHER' | 'LOWER';
  read: (r: StrategyResult) => number | null;
}

/** The named summary criteria dominance is judged on. No weights, no blend. */
export function dominanceCriteria(model: CompiledModel): Criterion[] {
  const criteria: Criterion[] = [
    { label: 'typical contribution (P50)', better: 'HIGHER', read: (r) => r.contribution?.p50 ?? null },
    { label: 'downside contribution (P10)', better: 'HIGHER', read: (r) => r.contribution?.p10 ?? null },
    // Upside is a criterion too: without it a strategy whose whole case is its
    // upside would read as dominated by one that is merely safer.
    { label: 'upside contribution (P90)', better: 'HIGHER', read: (r) => r.contribution?.p90 ?? null },
    { label: 'share of scenarios acceptable', better: 'HIGHER', read: (r) => r.acceptableShare },
  ];
  for (const metric of model.metrics) {
    const statistic = metric.role === 'CAPITAL_EXPOSURE' ? 'p90' : 'p50';
    criteria.push({
      label: `${metric.label} (${statistic.toUpperCase()})`,
      better: metric.better,
      read: (r) => r.metrics[metric.key]?.[statistic] ?? null,
    });
  }
  return criteria;
}

function compare(a: number | null, b: number | null, better: 'HIGHER' | 'LOWER'): number {
  // A missing reading is the worst reading — an unknown never ranks higher.
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a === b) return 0;
  return (better === 'HIGHER' ? a > b : a < b) ? 1 : -1;
}

export function dominance(results: StrategyResult[], criteria: Criterion[]): { dominance: DominanceFinding[]; tradeOffs: TradeOff[] } {
  const found: DominanceFinding[] = [];
  const dominated = new Set<string>();
  for (const a of results) {
    for (const b of results) {
      if (a === b) continue;
      const verdicts = criteria.map((c) => compare(c.read(a), c.read(b), c.better));
      if (verdicts.every((v) => v >= 0) && verdicts.some((v) => v > 0)) {
        found.push({ dominated: b.key, by: a.key, on: criteria.map((c) => c.label) });
        dominated.add(b.key);
      }
    }
  }
  const tradeOffs: TradeOff[] = [];
  const open = results.filter((r) => !dominated.has(r.key));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!, b = open[j]!;
      const aBetterOn: string[] = [], bBetterOn: string[] = [];
      for (const c of criteria) {
        const v = compare(c.read(a), c.read(b), c.better);
        if (v > 0) aBetterOn.push(c.label);
        if (v < 0) bBetterOn.push(c.label);
      }
      if (aBetterOn.length > 0 && bBetterOn.length > 0) tradeOffs.push({ a: a.key, b: b.key, aBetterOn, bBetterOn });
    }
  }
  return { dominance: found, tradeOffs };
}

export function rankByObjective(model: CompiledModel, results: StrategyResult[], objective: SelectedObjective): ObjectiveRanking {
  const read = (r: StrategyResult, metric: string, statistic: SummaryStatistic): number | null =>
    pick(metric === 'contribution' ? r.contribution : r.metrics[metric] ?? null, statistic);
  const known = new Set(['contribution', ...model.metrics.map((m) => m.key)]);
  if (!known.has(objective.metric)) throw new Error(`The objective names "${objective.metric}", which is neither contribution nor a metric of this model.`);
  for (const c of objective.constraints ?? []) if (!known.has(c.metric)) throw new Error(`An objective constraint names "${c.metric}", which is neither contribution nor a metric.`);
  const excluded: ObjectiveRanking['excluded'] = [];
  const eligible: Array<{ strategy: string; value: number }> = [];
  for (const r of results) {
    const value = read(r, objective.metric, objective.statistic);
    if (value === null) { excluded.push({ strategy: r.key, reason: 'no feasible scenario to measure it on' }); continue; }
    const broken = (objective.constraints ?? []).find((c) => {
      const v = read(r, c.metric, c.statistic);
      return v === null || (c.op === '<=' ? v > c.value : v < c.value);
    });
    if (broken) { excluded.push({ strategy: r.key, reason: `${broken.metric} ${broken.statistic} must be ${broken.op} ${broken.value}` }); continue; }
    eligible.push({ strategy: r.key, value });
  }
  eligible.sort((a, b) => (objective.direction === 'MAX' ? b.value - a.value : a.value - b.value));
  return { objective, order: eligible, excluded };
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

/** The value a variable is held at while another is moved. Stated, never hidden. */
export function baselineValue(cv: CompiledVariable): number {
  const s = cv.spec.spec;
  switch (s.kind) {
    case 'FIXED': return s.value;
    case 'RANGE': return (s.min + s.max) / 2;
    case 'TRIANGULAR': return s.mode;
    case 'NORMAL': return Math.min(Math.max(s.mean, s.min), s.max);
    case 'EMPIRICAL': return fromUniform(cv, 0.5);
    case 'CHOICE': {
      if (s.options.every((o) => o.weight !== undefined)) {
        let bestAt = 0;
        s.options.forEach((o, i) => { if ((o.weight ?? 0) > (s.options[bestAt]!.weight ?? 0)) bestAt = i; });
        return bestAt;
      }
      return 0;
    }
    default: return Number.NaN;
  }
}

/** The adverse-to-favourable interval a variable is swung over: its range, or P5–P95. */
function swingBounds(cv: CompiledVariable): [number, number] | null {
  const s = cv.spec.spec;
  if (cv.spec.controllable) {
    if (cv.spec.testRange) return [cv.spec.testRange.min, cv.spec.testRange.max];
    return s.kind === 'RANGE' ? [s.min, s.max] : null;
  }
  switch (s.kind) {
    case 'FIXED': return cv.spec.testRange ? [cv.spec.testRange.min, cv.spec.testRange.max] : null;
    case 'RANGE': return [s.min, s.max];
    case 'TRIANGULAR':
    case 'NORMAL':
    case 'EMPIRICAL': return [fromUniform(cv, 0.05), fromUniform(cv, 0.95)];
    default: return null;
  }
}

/** The full interval a break-even may be searched over. */
function searchBounds(cv: CompiledVariable): [number, number] | null {
  const s = cv.spec.spec;
  if (cv.spec.testRange) return [cv.spec.testRange.min, cv.spec.testRange.max];
  switch (s.kind) {
    case 'RANGE':
    case 'TRIANGULAR':
    case 'NORMAL': return [s.min, s.max];
    case 'EMPIRICAL': return [fromUniform(cv, 0), fromUniform(cv, 0.999999)];
    default: return null;
  }
}

export function sensitivity(
  model: CompiledModel,
  draws: Draws,
  raw: RawRun,
  overrides: Overrides,
): Sensitivity {
  const evaluator = new Evaluator(model, overrides);
  const out = evaluator.newEvaluation();
  const baseValues = new Float64Array(model.variables.map((cv) => baselineValue(cv)));
  const strategyCount = model.strategies.length;

  /** Baseline contribution with some variables replaced, for one strategy. */
  const at = (strategy: number, replace: Map<number, number>): number => {
    const values = Float64Array.from(baseValues);
    const decisions = model.strategies[strategy]!.values;
    const saved: Array<[number, number]> = [];
    for (const [v, value] of replace) {
      if (model.variables[v]!.spec.controllable) { saved.push([v, decisions[v]!]); decisions[v] = value; }
      else values[v] = value;
    }
    try {
      evaluator.fill(values, strategy);
      evaluator.evaluate(out);
      return out.valid ? out.contributionCents : Number.NaN;
    } finally {
      for (const [v, value] of saved) decisions[v] = value;
    }
  };
  const activeFor = (v: number, strategy: number): boolean => {
    evaluator.fill(baseValues, strategy);
    return evaluator.isActive(v);
  };

  const baselineCents: Record<string, number> = {};
  for (let s = 0; s < strategyCount; s++) baselineCents[model.strategies[s]!.spec.key] = at(s, new Map());

  const tornado: Sensitivity['tornado'] = {};
  for (let s = 0; s < strategyCount; s++) {
    const key = model.strategies[s]!.spec.key;
    const base = baselineCents[key]!;
    const bars: TornadoBar[] = [];
    for (const [v, cv] of model.variables.entries()) {
      if (cv.spec.controllable || !activeFor(v, s)) continue;
      if (cv.isChoice) {
        if (!cv.sampled) continue;
        const outcomes = cv.optionKeys.map((_, o) => at(s, new Map([[v, o]])));
        let loAt = 0, hiAt = 0;
        outcomes.forEach((c, o) => { if (c < outcomes[loAt]!) loAt = o; if (c > outcomes[hiAt]!) hiAt = o; });
        bars.push({
          variable: cv.spec.key, label: cv.spec.label, provenance: cv.spec.provenance,
          lowValue: loAt, highValue: hiAt, lowLabel: cv.optionKeys[loAt], highLabel: cv.optionKeys[hiAt],
          lowCents: outcomes[loAt]!, highCents: outcomes[hiAt]!, swingCents: outcomes[hiAt]! - outcomes[loAt]!,
          mustHold: base >= 0 && outcomes[loAt]! < 0,
        });
        continue;
      }
      const bounds = swingBounds(cv);
      if (!bounds) continue;
      const lowCents = at(s, new Map([[v, bounds[0]]]));
      const highCents = at(s, new Map([[v, bounds[1]]]));
      bars.push({
        variable: cv.spec.key, label: cv.spec.label, provenance: cv.spec.provenance,
        lowValue: bounds[0], highValue: bounds[1], lowCents, highCents,
        swingCents: Math.abs(highCents - lowCents),
        mustHold: base >= 0 && Math.min(lowCents, highCents) < 0,
      });
    }
    bars.sort((a, b) => b.swingCents - a.swingCents || (a.variable < b.variable ? -1 : 1));
    tornado[key] = bars;
  }

  // Spearman rank correlation of each sampled numeric input with contribution.
  const rankCorrelation: Sensitivity['rankCorrelation'] = {};
  const { scenarios } = raw;
  const ranksOf = (values: Float64Array): Float64Array => {
    const order = Array.from(values.keys()).sort((a, b) => values[a]! - values[b]! || a - b);
    const ranks = new Float64Array(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
      const rank = (i + j) / 2;
      for (let k = i; k <= j; k++) ranks[order[k]!] = rank;
      i = j + 1;
    }
    return ranks;
  };
  const pearson = (a: Float64Array, b: Float64Array): number => {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
    ma /= n; mb /= n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const x = a[i]! - ma, y = b[i]! - mb; cov += x * y; va += x * x; vb += y * y; }
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN;
  };
  for (let s = 0; s < strategyCount; s++) {
    const valid: number[] = [];
    for (let i = 0; i < scenarios; i++) if (raw.status[s * scenarios + i] !== 1) valid.push(i);
    const contribution = ranksOf(Float64Array.from(valid, (i) => raw.contribution[s * scenarios + i]!));
    const rows: Array<{ variable: string; label: string; rho: number }> = [];
    for (const v of model.sampled) {
      const cv = model.variables[v]!;
      if (cv.isChoice || !activeFor(v, s) || valid.length < 3) continue;
      const rho = pearson(ranksOf(Float64Array.from(valid, (i) => draws.base[v * scenarios + i]!)), contribution);
      if (Number.isFinite(rho)) rows.push({ variable: cv.spec.key, label: cv.spec.label, rho: Math.round(rho * 1000) / 1000 });
    }
    rows.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho) || (a.variable < b.variable ? -1 : 1));
    rankCorrelation[model.strategies[s]!.spec.key] = rows;
  }

  // Break-evens on the baseline, by bisection inside the searched interval.
  const breakEvens: BreakEven[] = [];
  for (let s = 0; s < strategyCount; s++) {
    for (const [v, cv] of model.variables.entries()) {
      if (cv.isChoice || !activeFor(v, s)) continue;
      const bounds = searchBounds(cv);
      if (!bounds) continue;
      const [min, max] = bounds;
      const f = (x: number): number => at(s, new Map([[v, x]]));
      const grid = Array.from({ length: 9 }, (_, k) => min + ((max - min) * k) / 8);
      const values = grid.map(f);
      if (values.some((x) => !Number.isFinite(x))) continue;
      const direction = values[8]! > values[0]! ? 'RISES' : values[8]! < values[0]! ? 'FALLS' : 'NONE';
      let crossings = 0, first = -1;
      for (let k = 0; k < 8; k++) if (Math.sign(values[k]!) !== Math.sign(values[k + 1]!) && (values[k] !== 0 || values[k + 1] !== 0)) { crossings++; if (first < 0) first = k; }
      const base = {
        variable: cv.spec.key, label: cv.spec.label, strategy: model.strategies[s]!.spec.key,
        searched: { min, max }, direction: direction as BreakEven['direction'],
      };
      if (first < 0) {
        breakEvens.push({ ...base, value: null, note: `Baseline contribution stays ${values[0]! >= 0 ? 'at or above' : 'below'} zero across ${fmt(min)}–${fmt(max)}; no break-even in the tested range.` });
        continue;
      }
      let a = grid[first]!, b = grid[first + 1]!, fa = values[first]!;
      for (let k = 0; k < 60 && b - a > Math.abs(b) * 1e-9 + 1e-9; k++) {
        const mid = (a + b) / 2;
        const fm = f(mid);
        if (Math.sign(fm) === Math.sign(fa) && fm !== 0) { a = mid; fa = fm; } else b = mid;
      }
      breakEvens.push({
        ...base,
        value: Math.round(((a + b) / 2) * 1e4) / 1e4,
        note: crossings > 1
          ? `Contribution crosses zero ${crossings} times in this range; this is the first crossing, others exist.`
          : `Baseline contribution is zero here, with every other input at its baseline.`,
      });
    }
  }

  // What if one input doubled, everything else at baseline.
  const stress: StressReading[] = [];
  for (let s = 0; s < strategyCount; s++) {
    const key = model.strategies[s]!.spec.key;
    for (const [v, cv] of model.variables.entries()) {
      if (cv.isChoice || cv.spec.controllable || !activeFor(v, s)) continue;
      const base = baseValues[v]!;
      if (base === 0) continue;
      const doubled = at(s, new Map([[v, base * 2]]));
      const bounds = searchBounds(cv) ?? swingBounds(cv);
      stress.push({
        variable: cv.spec.key, label: cv.spec.label, strategy: key,
        baselineCents: baselineCents[key]!, doubledCents: doubled,
        outsideTestedRange: bounds ? base * 2 > bounds[1] || base * 2 < bounds[0] : true,
      });
    }
  }

  // Which unknown to investigate next: one whose range flips the best strategy first.
  const investigate: InvestigationPriority[] = [];
  const bestOf = (values: number[]): string => {
    let bestAt = 0;
    values.forEach((c, i) => { if (c > values[bestAt]!) bestAt = i; });
    return model.strategies[bestAt]!.spec.key;
  };
  for (const [v, cv] of model.variables.entries()) {
    if (cv.spec.controllable || !['ASSUMPTION', 'HYPOTHETICAL', 'UNKNOWN'].includes(cv.spec.provenance)) continue;
    let points: number[];
    if (cv.isChoice) {
      if (!cv.sampled) continue;
      points = cv.optionKeys.map((_, o) => o);
    } else {
      const bounds = swingBounds(cv);
      if (!bounds) continue;
      points = [bounds[0], bounds[1]];
    }
    const outcomes = points.map((point) => model.strategies.map((_, s) => at(s, new Map([[v, point]]))));
    let maxSwing = 0;
    model.strategies.forEach((_, s) => {
      const column = outcomes.map((row) => row[s]!);
      maxSwing = Math.max(maxSwing, Math.max(...column) - Math.min(...column));
    });
    const bests = outcomes.map(bestOf);
    const bestAtLow = bests[0]!, bestAtHigh = bests[bests.length - 1]!;
    const decisionRelevant = new Set(bests).size > 1;
    investigate.push({
      variable: cv.spec.key, label: cv.spec.label, provenance: cv.spec.provenance,
      decisionRelevant, bestAtLow, bestAtHigh, maxSwingCents: maxSwing,
      why: decisionRelevant
        ? `Which strategy does best depends on it (${[...new Set(bests)].join(', ')} across its range). Narrowing it could change the decision.`
        : `It moves contribution by up to ${fmtCents(maxSwing)} but the same strategy (${bestAtLow}) does best across its whole range.`,
    });
  }
  investigate.sort((a, b) => Number(b.decisionRelevant) - Number(a.decisionRelevant) || b.maxSwingCents - a.maxSwingCents || (a.variable < b.variable ? -1 : 1));

  return { baselineCents, tornado, rankCorrelation, breakEvens, stress, investigate };
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
