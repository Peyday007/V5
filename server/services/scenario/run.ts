/**
 * The engine's one public entrance: a definition and options in, a labelled
 * result out. Pure — it reads no rows, writes no rows, calls no model and
 * performs no effect, so a future integration (a Cash opportunity, a Factory
 * capacity question) calls this with a definition it composed from its own
 * records and gets the identical answer this page does.
 *
 * Reproducibility is a property of what goes in: the definition's canonical
 * hash, the seed, the evaluation count, the basis and the overrides. The same
 * five produce the same `resultDigest` on every machine and after every
 * restart; `elapsedMs` is the one field excluded from it, because it is a fact
 * about the machine rather than about the model.
 */
import {
  ENGINE_VERSION,
  VARIABLE_PROVENANCES,
  type RunOptions,
  type ScenarioModelDefinition,
  type ScenarioResult,
  type ScenarioVariable,
  type VariableProvenance,
} from '../../domain/scenario.ts';
import { canonicalJson, compileModel, sha256, type CompiledModel } from './model.ts';
import { ScenarioRunError, draw, evaluateAll, resolveBasis, scenariosFor } from './engine.ts';
import { dominance, dominanceCriteria, rankByObjective, sensitivity, strategyResults } from './analyze.ts';

export { ScenarioModelError } from './model.ts';
export { ScenarioRunError } from './engine.ts';

function describe(v: ScenarioVariable): string {
  const s = v.spec;
  const unit = v.unit ? ` ${v.unit}` : '';
  let text: string;
  switch (s.kind) {
    case 'FIXED': text = `${s.value}${unit}`; break;
    case 'RANGE': text = `${v.controllable ? 'decision within' : 'anywhere in'} ${s.min}–${s.max}${unit}`; break;
    case 'TRIANGULAR': text = `triangular ${s.min} / ${s.mode} / ${s.max}${unit}`; break;
    case 'NORMAL': text = `normal mean ${s.mean}, sd ${s.sd}, bounded ${s.min}–${s.max}${unit}`; break;
    case 'EMPIRICAL': text = `${s.values.length} observed values${unit}`; break;
    case 'CHOICE': text = `${v.controllable ? 'decision among' : 'one of'} ${s.options.map((o) => o.label + (o.weight !== undefined ? ` (weight ${o.weight})` : '')).join(', ')}`; break;
    default: text = '?';
  }
  for (const r of v.responses ?? []) text += `; scales with (${r.to} ÷ ${r.reference})^${r.elasticity} [${r.provenance}]`;
  if (v.activeWhen) text += `; applies only when ${v.activeWhen.variable} is ${v.activeWhen.in.join(' or ')}, otherwise ${v.activeWhen.inactiveValue}`;
  return text;
}

function limitationsFor(model: CompiledModel, basis: ScenarioResult['basis'], probabilistic: boolean, options: RunOptions): string[] {
  const out: string[] = [];
  if (!probabilistic) {
    out.push(`This is a sweep: ${model.unjustified.length > 0 ? model.unjustified.join('; ') : 'no sampled input carries a sourced distribution'}. Percentiles and shares are coverage of the tested ranges, not probabilities.`);
  } else {
    out.push('Every sampled input carries a sourced distribution, so shares estimate probabilities — but only as well as those sources describe the future.');
  }
  const weak = model.variables.filter((v) => ['ASSUMPTION', 'HYPOTHETICAL', 'UNKNOWN'].includes(v.spec.provenance));
  if (weak.length > 0) out.push(`${weak.length} of ${model.variables.length} inputs are assumptions, hypotheticals or unknowns: ${weak.map((v) => v.spec.key).join(', ')}.`);
  if (model.responses.length > 0) out.push('Relationships between inputs are constant-elasticity responses as declared; nothing about their shape was estimated here.');
  if (model.correlation) out.push('Declared correlations are imposed as rank correlations through a Gaussian copula; tail dependence beyond that is not modelled.');
  out.push('Tornado bars, break-evens and stress readings move one input at a time with every other input at its stated baseline, so they do not show interactions.');
  out.push('Money is rounded to whole cents per line per evaluation; contribution is revenue lines minus cost lines, each counted once.');
  if (options.overrides && Object.keys(options.overrides).length > 0) out.push(`Stress overrides applied to every scenario: ${Object.entries(options.overrides).map(([k, o]) => (o.value !== undefined ? `${k} = ${o.value}` : `${k} × ${o.multiply}`)).join(', ')}.`);
  if (basis === 'SWEEP') out.push('Nothing here is a forecast of revenue, and no figure is income earned or guaranteed.');
  return out;
}

/** Run a model. Throws `ScenarioModelError` or `ScenarioRunError` with the reason. */
export function runScenarioModel(definition: ScenarioModelDefinition, options: RunOptions): ScenarioResult {
  const startedAt = Date.now();
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
    throw new ScenarioRunError('The seed must be a whole number from 0 to 4294967295.');
  }
  const model = compileModel(definition);
  const scenarios = scenariosFor(model, options.evaluations);
  const basis = resolveBasis(model, options.basis);
  const probabilistic = basis === 'MONTE_CARLO' && model.justified;
  const overrides = options.overrides ?? {};
  const draws = draw(model, scenarios, options.seed, basis);
  const raw = evaluateAll(model, draws, { overrides }, startedAt);

  const distinct = new Set<string>();
  if (model.sampled.length === 0) distinct.add('');
  else {
    for (let i = 0; i < scenarios; i++) {
      let key = '';
      for (const v of model.sampled) key += `${draws.base[v * scenarios + i]!.toPrecision(12)}|`;
      distinct.add(key);
    }
  }

  const minContributionCents = options.acceptable?.minContributionCents ?? 0;
  const strategies = strategyResults(model, draws, raw, overrides, minContributionCents);
  const criteria = dominanceCriteria(model);
  const { dominance: dominated, tradeOffs } = dominance(strategies, criteria);
  const ranking = options.objective ? rankByObjective(model, strategies, options.objective) : null;
  const sens = sensitivity(model, draws, raw, overrides);

  const provenance = Object.fromEntries(VARIABLE_PROVENANCES.map((p) => [p, 0])) as Record<VariableProvenance, number>;
  for (const v of model.variables) provenance[v.spec.provenance]++;

  const invalidTotal = strategies.reduce((sum, s) => sum + s.invalid, 0);
  const limitations = limitationsFor(model, basis, probabilistic, options);
  if (invalidTotal > 0) {
    limitations.unshift(`${invalidTotal} evaluation(s) produced no finite answer and are counted as invalid rather than as zero: ${[...raw.invalidReasons.entries()].map(([r, n]) => `${r} (${n})`).join('; ')}.`);
  }

  return {
    simulated: true,
    engineVersion: ENGINE_VERSION,
    configHash: runConfigHash(model.hash, options),
    seed: options.seed,
    basis,
    probabilistic,
    basisNote: probabilistic
      ? 'Monte Carlo over sourced distributions: shares are estimated probabilities.'
      : 'Sweep (Latin hypercube) over declared ranges: shares are coverage of the tested conditions, not probabilities.',
    scenarios,
    evaluations: scenarios * model.strategies.length,
    distinctScenarios: distinct.size,
    elapsedMs: Date.now() - startedAt,
    currency: definition.currency,
    horizon: definition.horizon,
    provenance,
    assumptions: model.variables.map((cv) => ({
      key: cv.spec.key,
      label: cv.spec.label,
      provenance: cv.spec.provenance,
      describe: describe(cv.spec),
      sources: cv.spec.sources ?? [],
    })),
    strategies,
    dominance: dominated,
    tradeOffs,
    dominanceCriteria: criteria.map((c) => c.label),
    ranking,
    sensitivity: sens,
    limitations,
  };
}

/** What a run was asked: the model's hash and every option that changes the answer. */
export function runConfigHash(modelHash: string, options: RunOptions): string {
  return sha256(canonicalJson({
    engine: ENGINE_VERSION,
    model: modelHash,
    seed: options.seed,
    evaluations: options.evaluations,
    basis: options.basis ?? null,
    overrides: options.overrides ?? {},
    objective: options.objective ?? null,
    acceptable: options.acceptable ?? null,
  }));
}

/** A digest of everything a result says except how long it took. */
export function resultDigest(result: ScenarioResult): string {
  const { elapsedMs: _elapsed, ...rest } = result;
  return sha256(canonicalJson(rest));
}
