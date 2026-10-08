/**
 * Drawing the world, and evaluating every strategy against the same draw.
 *
 * Two decisions shape this file.
 *
 * **Common random numbers.** Scenario *i* is one draw of every uncertain input,
 * made once, and every strategy is evaluated against exactly that draw. So a
 * comparison between strategies is paired — strategy A lost to B *in the same
 * world* — and a difference between them is never sampling noise between two
 * different sets of worlds. Win share and regret are only meaningful because
 * of it.
 *
 * **Two bases, and the basis is a label on the result.** `MONTE_CARLO` draws
 * independently and is permitted only when every sampled input is a sourced
 * distribution; then a percentile is an estimate of a probability. `SWEEP` is
 * a Latin hypercube over the declared ranges — every stratum of every range is
 * covered once per variable — and its percentiles are coverage of the tested
 * interval, never probabilities. A run over assumptions is a sweep whatever a
 * caller asked for, because a frequency over an invented uniform is not a
 * likelihood.
 *
 * Money is rounded to whole cents per line per evaluation and contribution is
 * the integer sum of those lines, so it is exact and identical on every run.
 */
import { SCENARIO_LIMITS, type RunBasis, type RunOptions } from '../../domain/scenario.ts';
import type { CompiledModel, CompiledVariable } from './model.ts';
import { inverseNormal, makeRng, normalCdf, permutation } from './random.ts';

export class ScenarioRunError extends Error {}

/** How one value of a variable is drawn from a uniform u in (0, 1). */
export function fromUniform(cv: CompiledVariable, u: number): number {
  const s = cv.spec.spec;
  switch (s.kind) {
    case 'FIXED': return s.value;
    case 'RANGE': return s.min + u * (s.max - s.min);
    case 'TRIANGULAR': {
      const span = s.max - s.min;
      const cut = (s.mode - s.min) / span;
      return u < cut ? s.min + Math.sqrt(u * span * (s.mode - s.min)) : s.max - Math.sqrt((1 - u) * span * (s.max - s.mode));
    }
    case 'NORMAL': {
      const lo = normalCdf((s.min - s.mean) / s.sd);
      const hi = normalCdf((s.max - s.mean) / s.sd);
      const v = s.mean + s.sd * inverseNormal(lo + u * (hi - lo));
      return Math.min(Math.max(v, s.min), s.max);
    }
    case 'EMPIRICAL': {
      const sorted = sortedEmpirical(cv);
      return sorted[Math.min(sorted.length - 1, Math.floor(u * sorted.length))]!;
    }
    case 'CHOICE': {
      const options = s.options;
      if (options.every((o) => o.weight !== undefined)) {
        const total = options.reduce((sum, o) => sum + (o.weight ?? 0), 0);
        let acc = 0;
        for (let i = 0; i < options.length; i++) {
          acc += (options[i]!.weight ?? 0) / total;
          if (u < acc) return i;
        }
        return options.length - 1;
      }
      return Math.min(options.length - 1, Math.floor(u * options.length));
    }
    default: return Number.NaN;
  }
}

const empiricalCache = new WeakMap<CompiledVariable, number[]>();
function sortedEmpirical(cv: CompiledVariable): number[] {
  let sorted = empiricalCache.get(cv);
  if (!sorted) {
    const s = cv.spec.spec;
    sorted = s.kind === 'EMPIRICAL' ? [...s.values].sort((a, b) => a - b) : [];
    empiricalCache.set(cv, sorted);
  }
  return sorted;
}

/** The world, drawn: `base[v * scenarios + i]` is variable v's value (or option index) in scenario i. */
export interface Draws {
  scenarios: number;
  base: Float64Array;
  basis: RunBasis;
}

export function resolveBasis(model: CompiledModel, requested: RunBasis | undefined): RunBasis {
  if (requested === 'MONTE_CARLO' && !model.justified) {
    throw new ScenarioRunError(
      `Monte Carlo needs every sampled input to carry a sourced distribution, and ${model.unjustified.join('; ')}. Run a SWEEP instead — its results are coverage of the tested ranges, not probabilities.`,
    );
  }
  return requested ?? (model.justified && model.sampled.length > 0 ? 'MONTE_CARLO' : 'SWEEP');
}

export function draw(model: CompiledModel, scenarios: number, seed: number, basis: RunBasis): Draws {
  const n = model.variables.length;
  const base = new Float64Array(n * scenarios);
  // Unsampled variables hold their single value (or NaN for a controllable, which a strategy fills).
  for (const [v, cv] of model.variables.entries()) {
    if (cv.sampled) continue;
    const s = cv.spec.spec;
    const value = s.kind === 'FIXED' ? s.value : Number.NaN;
    base.fill(value, v * scenarios, (v + 1) * scenarios);
  }
  // A uniform per sampled variable per scenario, each variable on its own stream.
  const uniforms = new Map<number, Float64Array>();
  for (const v of model.sampled) {
    const cv = model.variables[v]!;
    const rng = makeRng(seed, cv.stream);
    const u = new Float64Array(scenarios);
    if (basis === 'SWEEP') {
      const order = permutation(scenarios, makeRng(seed, cv.stream ^ 0x5bd1e995));
      for (let i = 0; i < scenarios; i++) u[i] = (order[i]! + rng()) / scenarios;
    } else {
      for (let i = 0; i < scenarios; i++) u[i] = rng();
    }
    uniforms.set(v, u);
  }
  // Impose declared rank correlations through a Gaussian copula.
  if (model.correlation) {
    const { order, factor } = model.correlation;
    const z = new Float64Array(order.length);
    for (let i = 0; i < scenarios; i++) {
      for (let k = 0; k < order.length; k++) z[k] = inverseNormal(uniforms.get(order[k]!)![i]!);
      for (let k = order.length - 1; k >= 0; k--) {
        let sum = 0;
        for (let j = 0; j <= k; j++) sum += factor[k]![j]! * z[j]!;
        uniforms.get(order[k]!)![i] = normalCdf(sum);
      }
    }
  }
  for (const v of model.sampled) {
    const cv = model.variables[v]!;
    const u = uniforms.get(v)!;
    for (let i = 0; i < scenarios; i++) base[v * scenarios + i] = fromUniform(cv, u[i]!);
  }
  return { scenarios, base, basis };
}

export interface Overrides {
  [key: string]: { multiply?: number; value?: number };
}

/** The outcome of evaluating one strategy in one world. */
export interface Evaluation {
  valid: boolean;
  invalidReason: string | null;
  /** Indexes of violated constraints. */
  violated: number[];
  lineCents: number[];
  contributionCents: number;
  metrics: number[];
}

/**
 * A reusable evaluator: one environment, one set of output buffers.
 *
 * `values` holds each variable's base value or option index for this world;
 * the strategy's decisions, conditional applicability, stress overrides and
 * documented responses are applied here, in that order, every time.
 */
export class Evaluator {
  readonly env: Float64Array;
  private readonly overrideList: Array<{ v: number; multiply?: number; value?: number }>;

  constructor(private readonly model: CompiledModel, overrides: Overrides = {}) {
    this.env = new Float64Array(model.slotCount);
    this.overrideList = [];
    for (const [key, o] of Object.entries(overrides)) {
      const cv = model.byKey.get(key);
      if (!cv || cv.isChoice) throw new ScenarioRunError(`A stress override names "${key}", which is not a numeric variable.`);
      if (o.multiply !== undefined && !(Number.isFinite(o.multiply))) throw new ScenarioRunError(`The override on "${key}" multiplies by something that is not a finite number.`);
      if (o.value !== undefined && !Number.isFinite(o.value)) throw new ScenarioRunError(`The override on "${key}" sets something that is not a finite number.`);
      if ((o.multiply === undefined) === (o.value === undefined)) throw new ScenarioRunError(`The override on "${key}" must either multiply or set a value, not both or neither.`);
      this.overrideList.push({ v: model.variables.indexOf(cv), ...o });
    }
  }

  /** Fill the environment for one world and one strategy. Returns per-variable effective values. */
  fill(values: ArrayLike<number>, strategy: number): void {
    const { model, env } = this;
    const decisions = model.strategies[strategy]!.values;
    for (let v = 0; v < model.variables.length; v++) {
      const cv = model.variables[v]!;
      const value = cv.spec.controllable ? decisions[v]! : values[v]!;
      if (cv.isChoice) {
        const option = cv.optionAttributes[value]!;
        for (let a = 0; a < cv.attributeSlots.length; a++) env[cv.attributeSlots[a]!] = option[a]!;
      }
      env[cv.slot] = value;
    }
    // Conditionals are applied once every choice is set, so declaration order does not matter.
    for (const cv of model.variables) {
      if (!cv.activeWhen) continue;
      const on = env[model.variables[cv.activeWhen.variable]!.slot]!;
      if (!cv.activeWhen.options.has(on)) env[cv.slot] = cv.activeWhen.inactiveValue;
    }
    for (const o of this.overrideList) {
      const cv = model.variables[o.v]!;
      if (!this.isActive(o.v)) continue;
      env[cv.slot] = o.value !== undefined ? o.value : env[cv.slot]! * o.multiply!;
    }
    for (const r of model.responses) {
      if (!this.isActive(r.variable)) continue;
      const slot = model.variables[r.variable]!.slot;
      env[slot] = env[slot]! * Math.pow(env[model.variables[r.to]!.slot]! / r.reference, r.elasticity);
    }
  }

  isActive(v: number): boolean {
    const cv = this.model.variables[v]!;
    if (!cv.activeWhen) return true;
    const on = this.env[this.model.variables[cv.activeWhen.variable]!.slot]!;
    return cv.activeWhen.options.has(on);
  }

  /** Evaluate after `fill`. Writes into `out` and returns it. */
  evaluate(out: Evaluation): Evaluation {
    const { model, env } = this;
    out.valid = true;
    out.invalidReason = null;
    out.violated.length = 0;
    for (const d of model.derived) {
      const value = d.fn(env);
      env[d.slot] = value;
      if (!Number.isFinite(value) && out.valid) { out.valid = false; out.invalidReason = `derived "${d.key}" is not a finite number`; }
    }
    let contribution = 0;
    for (let i = 0; i < model.lines.length; i++) {
      const line = model.lines[i]!;
      const value = line.fn(env);
      if (!Number.isFinite(value)) {
        if (out.valid) { out.valid = false; out.invalidReason = `money line "${line.key}" is not a finite number`; }
        out.lineCents[i] = 0;
        continue;
      }
      const cents = Math.round(value * 100);
      out.lineCents[i] = cents;
      contribution += line.kind === 'REVENUE' ? cents : -cents;
    }
    out.contributionCents = contribution;
    for (let i = 0; i < model.metrics.length; i++) {
      const value = model.metrics[i]!.fn(env);
      out.metrics[i] = value;
      if (!Number.isFinite(value) && out.valid) { out.valid = false; out.invalidReason = `metric "${model.metrics[i]!.key}" is not a finite number`; }
    }
    for (let i = 0; i < model.constraints.length; i++) {
      const c = model.constraints[i]!;
      const value = c.fn(env);
      const holds = c.op === '<=' ? value <= c.value : c.op === '>=' ? value >= c.value : c.op === '<' ? value < c.value : value > c.value;
      if (!holds) out.violated.push(i);
    }
    return out;
  }

  newEvaluation(): Evaluation {
    return {
      valid: true,
      invalidReason: null,
      violated: [],
      lineCents: new Array<number>(this.model.lines.length).fill(0),
      contributionCents: 0,
      metrics: new Array<number>(this.model.metrics.length).fill(0),
    };
  }
}

/** Every evaluation of the run, columnar. Index `s * scenarios + i`. */
export interface RawRun {
  scenarios: number;
  strategies: number;
  contribution: Float64Array;
  lines: Float64Array[];
  metrics: Float64Array[];
  /** 0 valid and feasible, 1 invalid, 2 infeasible. */
  status: Uint8Array;
  violated: Uint16Array;
  invalidReasons: Map<string, number>;
}

export function scenariosFor(model: CompiledModel, evaluations: number): number {
  if (!Number.isInteger(evaluations) || evaluations < 1) throw new ScenarioRunError('The number of evaluations must be a positive whole number.');
  if (evaluations > SCENARIO_LIMITS.maxEvaluations) throw new ScenarioRunError(`At most ${SCENARIO_LIMITS.maxEvaluations.toLocaleString('en-US')} evaluations per run.`);
  const scenarios = Math.floor(evaluations / model.strategies.length);
  if (scenarios < 1) throw new ScenarioRunError(`${evaluations} evaluations cannot cover ${model.strategies.length} strategies once each.`);
  return scenarios;
}

export function evaluateAll(model: CompiledModel, draws: Draws, options: Pick<RunOptions, 'overrides'>, startedAt: number): RawRun {
  const { scenarios } = draws;
  const strategyCount = model.strategies.length;
  const total = scenarios * strategyCount;
  const raw: RawRun = {
    scenarios,
    strategies: strategyCount,
    contribution: new Float64Array(total),
    lines: model.lines.map(() => new Float64Array(total)),
    metrics: model.metrics.map(() => new Float64Array(total)),
    status: new Uint8Array(total),
    violated: new Uint16Array(total),
    invalidReasons: new Map(),
  };
  const evaluator = new Evaluator(model, options.overrides ?? {});
  const out = evaluator.newEvaluation();
  const values = new Float64Array(model.variables.length);
  const n = model.variables.length;
  for (let i = 0; i < scenarios; i++) {
    if (i % 1024 === 0 && Date.now() - startedAt > SCENARIO_LIMITS.maxRunMs) {
      throw new ScenarioRunError(`The run passed its ${SCENARIO_LIMITS.maxRunMs / 1000}s budget after ${i} scenarios and was stopped rather than left running.`);
    }
    for (let v = 0; v < n; v++) values[v] = draws.base[v * scenarios + i]!;
    for (let s = 0; s < strategyCount; s++) {
      evaluator.fill(values, s);
      evaluator.evaluate(out);
      const at = s * scenarios + i;
      raw.contribution[at] = out.contributionCents;
      for (let l = 0; l < out.lineCents.length; l++) raw.lines[l]![at] = out.lineCents[l]!;
      for (let m = 0; m < out.metrics.length; m++) raw.metrics[m]![at] = out.metrics[m]!;
      if (!out.valid) {
        raw.status[at] = 1;
        raw.invalidReasons.set(out.invalidReason!, (raw.invalidReasons.get(out.invalidReason!) ?? 0) + 1);
      } else if (out.violated.length > 0) {
        raw.status[at] = 2;
        let mask = 0;
        for (const c of out.violated) mask |= 1 << c;
        raw.violated[at] = mask;
      }
    }
  }
  return raw;
}
