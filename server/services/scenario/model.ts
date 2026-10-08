/**
 * A model definition, validated to death and compiled once.
 *
 * Everything that could make a result unreadable is refused here, before a
 * single scenario is drawn: an identifier nobody declared, a distribution an
 * assumption cannot justify, a correlation matrix that cannot hold, a strategy
 * that sets something it does not control, a cost declared twice. A refusal
 * names every problem at once, because a person correcting a model one error
 * per run would learn to stop trusting the refusals.
 *
 * What comes out is a `CompiledModel`: a slot layout over one `Float64Array`
 * and closures over it, so an evaluation is arithmetic and nothing else.
 */
import { createHash } from 'node:crypto';
import {
  DISTRIBUTION_PROVENANCES,
  SCENARIO_LIMITS,
  VARIABLE_PROVENANCES,
  type ScenarioModelDefinition,
  type ScenarioVariable,
  type StrategySpec,
} from '../../domain/scenario.ts';
import { ExpressionError, compile, identifiers, parse, type Compiled } from './expr.ts';
import { cholesky } from './random.ts';

export class ScenarioModelError extends Error {
  constructor(readonly problems: string[]) {
    super(`The scenario model is not valid: ${problems.join(' ')}`);
  }
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface CompiledVariable {
  index: number;
  spec: ScenarioVariable;
  slot: number;
  isChoice: boolean;
  /** For a CHOICE: attribute name → slot, and per option the attribute values in that order. */
  attributeSlots: number[];
  attributeNames: string[];
  optionAttributes: number[][];
  optionKeys: string[];
  /** Sampled: uncontrollable and not FIXED. */
  sampled: boolean;
  /** A probability distribution a source justifies. */
  justified: boolean;
  activeWhen: { variable: number; options: Set<number>; inactiveValue: number } | null;
  /** 32-bit stream id, derived from the key so a new variable shifts no other stream. */
  stream: number;
}

export interface CompiledStrategy {
  index: number;
  spec: StrategySpec;
  /** Per variable index: the value (or option index) this strategy fixes, NaN when it fixes nothing. */
  values: Float64Array;
}

export interface CompiledModel {
  definition: ScenarioModelDefinition;
  hash: string;
  slotCount: number;
  variables: CompiledVariable[];
  byKey: Map<string, CompiledVariable>;
  /** Sampled variable indexes, in declaration order. */
  sampled: number[];
  /** Responses in an order where every `to` is final before it is read. */
  responses: Array<{ variable: number; to: number; elasticity: number; reference: number }>;
  derived: Array<{ slot: number; fn: Compiled; key: string }>;
  lines: Array<{ key: string; label: string; kind: 'REVENUE' | 'COST'; fn: Compiled }>;
  metrics: Array<{ key: string; label: string; unit: string; better: 'HIGHER' | 'LOWER'; role: string; fn: Compiled }>;
  constraints: Array<{ key: string; label: string; op: string; value: number; fn: Compiled }>;
  strategies: CompiledStrategy[];
  /** Cholesky factor over the sampled numeric variables, or null when nothing is correlated. */
  correlation: { order: number[]; factor: number[][] } | null;
  /** True when every sampled input and every correlation is justified by a source. */
  justified: boolean;
  unjustified: string[];
}

/** A canonical JSON encoding: object keys sorted, so the hash describes content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fnv32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function checkSpec(v: ScenarioVariable, problems: string[]): void {
  const s = v.spec as Record<string, unknown> & { kind?: string };
  const at = `Variable "${v.key}":`;
  switch (s.kind) {
    case 'FIXED':
      if (!finite(s.value)) problems.push(`${at} a FIXED value must be a finite number.`);
      break;
    case 'RANGE':
      if (!finite(s.min) || !finite(s.max) || (s.min as number) > (s.max as number)) problems.push(`${at} a RANGE needs finite min ≤ max.`);
      break;
    case 'TRIANGULAR':
      if (![s.min, s.mode, s.max].every(finite) || !((s.min as number) <= (s.mode as number) && (s.mode as number) <= (s.max as number)) || s.min === s.max) {
        problems.push(`${at} a TRIANGULAR needs finite min ≤ mode ≤ max with min < max.`);
      }
      break;
    case 'NORMAL':
      if (![s.mean, s.sd, s.min, s.max].every(finite) || (s.sd as number) <= 0 || (s.min as number) >= (s.max as number)) {
        problems.push(`${at} a NORMAL needs a finite mean, sd > 0 and finite bounds min < max.`);
      }
      break;
    case 'EMPIRICAL': {
      const values = s.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > SCENARIO_LIMITS.maxEmpiricalValues || !values.every(finite)) {
        problems.push(`${at} EMPIRICAL needs 1 to ${SCENARIO_LIMITS.maxEmpiricalValues} finite observations.`);
      }
      break;
    }
    case 'CHOICE': {
      const options = s.options;
      if (!Array.isArray(options) || options.length === 0 || options.length > SCENARIO_LIMITS.maxChoiceOptions) {
        problems.push(`${at} a CHOICE needs 1 to ${SCENARIO_LIMITS.maxChoiceOptions} options.`);
        break;
      }
      const keys = new Set<string>();
      let names: string | null = null;
      for (const option of options as Array<Record<string, unknown>>) {
        if (typeof option.key !== 'string' || !KEY.test(option.key)) problems.push(`${at} option key "${String(option.key)}" is not a valid identifier.`);
        else if (keys.has(option.key)) problems.push(`${at} option "${option.key}" is declared twice.`);
        else keys.add(option.key);
        const attrs = option.attributes as Record<string, unknown> | undefined;
        if (!attrs || typeof attrs !== 'object') { problems.push(`${at} option "${String(option.key)}" has no attributes object.`); continue; }
        for (const [name, value] of Object.entries(attrs)) {
          if (!KEY.test(name)) problems.push(`${at} attribute "${name}" is not a valid identifier.`);
          if (!finite(value)) problems.push(`${at} attribute "${name}" of option "${String(option.key)}" must be a finite number.`);
        }
        const signature = Object.keys(attrs).sort().join(',');
        if (names === null) names = signature;
        else if (names !== signature) problems.push(`${at} every option must carry the same attributes, so an expression never reads a value one option lacks.`);
        if (option.weight !== undefined && (!finite(option.weight) || (option.weight as number) <= 0)) {
          problems.push(`${at} option "${String(option.key)}" has a weight that is not a positive number.`);
        }
      }
      const weighted = (options as Array<Record<string, unknown>>).filter((o) => o.weight !== undefined).length;
      if (weighted > 0 && weighted !== options.length) problems.push(`${at} either every option carries a weight or none does.`);
      break;
    }
    default:
      problems.push(`${at} spec kind "${String(s.kind)}" is not one of FIXED, RANGE, TRIANGULAR, NORMAL, EMPIRICAL, CHOICE.`);
  }
}

/**
 * Validate and compile. Throws `ScenarioModelError` listing every problem.
 */
export function compileModel(definition: ScenarioModelDefinition): CompiledModel {
  const problems: string[] = [];
  const d = definition as Partial<ScenarioModelDefinition>;
  if (!d || typeof d !== 'object') throw new ScenarioModelError(['The definition must be an object.']);
  if (typeof d.title !== 'string' || d.title.trim() === '') problems.push('A model needs a title.');
  if (typeof d.currency !== 'string' || !/^[A-Z]{3}$/.test(d.currency)) problems.push('The currency must be a three-letter ISO code such as USD.');
  if (typeof d.horizon !== 'string' || d.horizon.trim() === '') problems.push('A model must say what one evaluation covers (its horizon).');
  const variables = Array.isArray(d.variables) ? d.variables : [];
  const strategies = Array.isArray(d.strategies) ? d.strategies : [];
  const derivedSpecs = Array.isArray(d.derived) ? d.derived : [];
  const lineSpecs = Array.isArray(d.lines) ? d.lines : [];
  const metricSpecs = Array.isArray(d.metrics) ? d.metrics : [];
  const constraintSpecs = Array.isArray(d.constraints) ? d.constraints : [];
  const correlationSpecs = Array.isArray(d.correlations) ? d.correlations : [];
  if (variables.length === 0) problems.push('A model needs at least one variable.');
  if (variables.length > SCENARIO_LIMITS.maxVariables) problems.push(`A model may have at most ${SCENARIO_LIMITS.maxVariables} variables.`);
  if (strategies.length === 0) problems.push('A model needs at least one strategy to evaluate.');
  if (strategies.length > SCENARIO_LIMITS.maxStrategies) problems.push(`A model may compare at most ${SCENARIO_LIMITS.maxStrategies} strategies.`);
  if (derivedSpecs.length > SCENARIO_LIMITS.maxDerived) problems.push(`At most ${SCENARIO_LIMITS.maxDerived} derived quantities.`);
  if (lineSpecs.length === 0) problems.push('A model needs at least one money line; contribution is computed from them.');
  if (lineSpecs.length > SCENARIO_LIMITS.maxLines) problems.push(`At most ${SCENARIO_LIMITS.maxLines} money lines.`);
  if (metricSpecs.length > SCENARIO_LIMITS.maxMetrics) problems.push(`At most ${SCENARIO_LIMITS.maxMetrics} metrics.`);
  if (constraintSpecs.length > SCENARIO_LIMITS.maxConstraints) problems.push(`At most ${SCENARIO_LIMITS.maxConstraints} constraints.`);
  if (problems.length > 0 && variables.length === 0) throw new ScenarioModelError(problems);

  // One namespace for everything an expression can read, plus the outputs.
  const names = new Set<string>(['contribution']);
  const claim = (key: unknown, what: string): boolean => {
    if (typeof key !== 'string' || !KEY.test(key)) { problems.push(`${what} key "${String(key)}" is not a valid identifier.`); return false; }
    if (names.has(key)) { problems.push(`${what} key "${key}" is used twice (or is reserved).`); return false; }
    names.add(key);
    return true;
  };

  const slots = new Map<string, number>();
  let slotCount = 0;
  const addSlot = (name: string): number => { const s = slotCount++; slots.set(name, s); return s; };

  const compiledVars: CompiledVariable[] = [];
  const byKey = new Map<string, CompiledVariable>();
  for (const [index, v] of variables.entries()) {
    if (!claim(v?.key, 'Variable')) continue;
    if (typeof v.label !== 'string' || v.label.trim() === '') problems.push(`Variable "${v.key}" needs a label.`);
    if (typeof v.unit !== 'string') problems.push(`Variable "${v.key}" needs a unit (an empty string is allowed).`);
    if (!VARIABLE_PROVENANCES.includes(v.provenance)) problems.push(`Variable "${v.key}" must say where it came from: one of ${VARIABLE_PROVENANCES.join(', ')}.`);
    if (typeof v.controllable !== 'boolean') problems.push(`Variable "${v.key}" must say whether it is controllable.`);
    if (!v.spec || typeof v.spec !== 'object') { problems.push(`Variable "${v.key}" has no spec.`); continue; }
    checkSpec(v, problems);
    const kind = v.spec.kind;
    const isDistribution = kind === 'TRIANGULAR' || kind === 'NORMAL' || kind === 'EMPIRICAL';
    const weighted = v.spec.kind === 'CHOICE' && v.spec.options.some((o) => o.weight !== undefined);
    const sourcedProvenance = DISTRIBUTION_PROVENANCES.includes(v.provenance);
    if ((isDistribution || weighted) && !sourcedProvenance) {
      problems.push(`Variable "${v.key}" is ${v.provenance}, and only EVIDENCE or HISTORICAL may carry a probability distribution or choice weights. Give it a RANGE (or an unweighted CHOICE) to sweep instead.`);
    }
    if (v.provenance === 'UNKNOWN' && kind !== 'RANGE' && kind !== 'CHOICE') {
      problems.push(`Variable "${v.key}" is UNKNOWN, so it cannot be one value or a distribution — give the range to sweep.`);
    }
    if (v.controllable && (isDistribution || weighted)) problems.push(`Variable "${v.key}" is controllable, so it is a decision and is never sampled.`);
    if ((v.sources ?? []).some((s) => !s || typeof s.ref !== 'string' || typeof s.kind !== 'string')) problems.push(`Variable "${v.key}" has a source reference without a kind and a ref.`);
    if (v.testRange && (!finite(v.testRange.min) || !finite(v.testRange.max) || v.testRange.min >= v.testRange.max)) {
      problems.push(`Variable "${v.key}" has a testRange that is not min < max.`);
    }
    const isChoice = kind === 'CHOICE';
    const slot = addSlot(v.key);
    const options = v.spec.kind === 'CHOICE' ? v.spec.options : [];
    const attributeNames = isChoice ? Object.keys(options[0]?.attributes ?? {}).sort() : [];
    const attributeSlots = attributeNames.map((name) => addSlot(`${v.key}.${name}`));
    const optionAttributes = options.map((o) => attributeNames.map((name) => o.attributes?.[name] ?? Number.NaN));
    const sampled = !v.controllable && kind !== 'FIXED';
    const compiled: CompiledVariable = {
      index,
      spec: v,
      slot,
      isChoice,
      attributeSlots,
      attributeNames,
      optionAttributes,
      optionKeys: options.map((o) => o.key),
      sampled,
      justified: sampled && (isDistribution || weighted) && sourcedProvenance,
      activeWhen: null,
      stream: fnv32(v.key),
    };
    compiledVars.push(compiled);
    byKey.set(v.key, compiled);
  }

  // activeWhen and responses refer to other variables; resolve after all are known.
  for (const cv of compiledVars) {
    const v = cv.spec;
    if (v.activeWhen) {
      const on = byKey.get(v.activeWhen.variable);
      if (!on || !on.isChoice) problems.push(`Variable "${v.key}" is conditional on "${v.activeWhen.variable}", which is not a CHOICE variable.`);
      else if (cv.isChoice) problems.push(`Variable "${v.key}" is a CHOICE and cannot itself be conditional.`);
      else {
        const options = new Set<number>();
        for (const key of v.activeWhen.in ?? []) {
          const at = on.optionKeys.indexOf(key);
          if (at < 0) problems.push(`Variable "${v.key}" is conditional on option "${key}", which "${on.spec.key}" does not have.`);
          else options.add(at);
        }
        if (!finite(v.activeWhen.inactiveValue)) problems.push(`Variable "${v.key}" needs a finite inactiveValue for when it does not apply.`);
        cv.activeWhen = { variable: on.index, options, inactiveValue: v.activeWhen.inactiveValue };
      }
    }
  }

  const responseEdges: Array<{ variable: number; to: number; elasticity: number; reference: number }> = [];
  for (const cv of compiledVars) {
    for (const r of cv.spec.responses ?? []) {
      const to = byKey.get(r?.to);
      if (!to || to.isChoice) { problems.push(`Variable "${cv.spec.key}" responds to "${String(r?.to)}", which is not a numeric variable.`); continue; }
      if (cv.isChoice) { problems.push(`Variable "${cv.spec.key}" is a CHOICE and cannot respond to another variable.`); continue; }
      if (to.index === cv.index) { problems.push(`Variable "${cv.spec.key}" cannot respond to itself.`); continue; }
      if (!finite(r.elasticity) || !finite(r.reference) || r.reference <= 0) problems.push(`Variable "${cv.spec.key}"'s response to "${r.to}" needs a finite elasticity and a positive reference.`);
      if (!VARIABLE_PROVENANCES.includes(r.provenance)) problems.push(`Variable "${cv.spec.key}"'s response to "${r.to}" must say where the relationship came from.`);
      responseEdges.push({ variable: cv.index, to: to.index, elasticity: r.elasticity, reference: r.reference });
    }
  }
  // Order responses so a variable's own responses run after the variables it reads have settled.
  const responses: typeof responseEdges = [];
  {
    const settled = new Set<number>();
    const pending = new Set(responseEdges.map((e) => e.variable));
    let guard = 0;
    while (pending.size > 0 && guard++ < compiledVars.length + 2) {
      for (const v of [...pending]) {
        const edges = responseEdges.filter((e) => e.variable === v);
        if (edges.every((e) => !pending.has(e.to) || settled.has(e.to))) {
          responses.push(...edges);
          settled.add(v);
          pending.delete(v);
        }
      }
    }
    if (pending.size > 0) problems.push('Variable responses form a cycle, so no order of applying them is well defined.');
  }

  // Expressions.
  const readable = new Set<string>();
  for (const cv of compiledVars) {
    if (!cv.isChoice) readable.add(cv.spec.key);
    for (const name of cv.attributeNames) readable.add(`${cv.spec.key}.${name}`);
  }
  const compileExpr = (expr: unknown, where: string): Compiled | null => {
    try {
      const tree = parse(expr as string);
      for (const name of identifiers(tree)) {
        if (!readable.has(name)) {
          const choice = byKey.get(name);
          problems.push(choice?.isChoice
            ? `${where} reads "${name}" directly; a choice is read through one of its attributes, e.g. "${name}.${choice.attributeNames[0] ?? 'attribute'}".`
            : `${where} reads "${name}", which is not declared before it.`);
        }
      }
      return compile(tree, (name) => slots.get(name) ?? 0);
    } catch (error) {
      problems.push(`${where}: ${error instanceof ExpressionError ? error.message : String(error)}`);
      return null;
    }
  };

  const derived: CompiledModel['derived'] = [];
  for (const spec of derivedSpecs) {
    if (!claim(spec?.key, 'Derived quantity')) continue;
    const fn = compileExpr(spec.expr, `Derived "${spec.key}"`);
    const slot = addSlot(spec.key);
    readable.add(spec.key);
    if (fn) derived.push({ slot, fn, key: spec.key });
  }

  const lines: CompiledModel['lines'] = [];
  const seenLineExpr = new Map<string, string>();
  for (const spec of lineSpecs) {
    if (!claim(spec?.key, 'Money line')) continue;
    if (spec.kind !== 'REVENUE' && spec.kind !== 'COST') problems.push(`Money line "${spec.key}" must be REVENUE or COST.`);
    const normalized = typeof spec.expr === 'string' ? spec.expr.replace(/\s+/g, '') : '';
    const twin = seenLineExpr.get(`${spec.kind}:${normalized}`);
    if (twin) problems.push(`Money line "${spec.key}" has the same expression as "${twin}" — the same ${spec.kind === 'COST' ? 'cost' : 'revenue'} would be counted twice.`);
    seenLineExpr.set(`${spec.kind}:${normalized}`, spec.key);
    const fn = compileExpr(spec.expr, `Money line "${spec.key}"`);
    if (fn) lines.push({ key: spec.key, label: spec.label ?? spec.key, kind: spec.kind, fn });
  }

  const metrics: CompiledModel['metrics'] = [];
  for (const spec of metricSpecs) {
    if (!claim(spec?.key, 'Metric')) continue;
    if (spec.better !== 'HIGHER' && spec.better !== 'LOWER') problems.push(`Metric "${spec.key}" must say whether HIGHER or LOWER is better.`);
    const fn = compileExpr(spec.expr, `Metric "${spec.key}"`);
    if (fn) metrics.push({ key: spec.key, label: spec.label ?? spec.key, unit: spec.unit ?? '', better: spec.better, role: spec.role ?? 'OTHER', fn });
  }
  const roles = metrics.map((m) => m.role).filter((r) => r !== 'OTHER');
  if (new Set(roles).size !== roles.length) problems.push('Each standard metric role (capital exposure, days to cash, labour hours) may be played by one metric only.');

  const constraints: CompiledModel['constraints'] = [];
  for (const spec of constraintSpecs) {
    if (!claim(spec?.key, 'Constraint')) continue;
    if (!['<=', '>=', '<', '>'].includes(spec.op) || !finite(spec.value)) problems.push(`Constraint "${spec.key}" needs an operator (<=, >=, <, >) and a finite value.`);
    const fn = compileExpr(spec.expr, `Constraint "${spec.key}"`);
    if (fn) constraints.push({ key: spec.key, label: spec.label ?? spec.key, op: spec.op, value: spec.value, fn });
  }

  // Strategies.
  const strategyKeys = new Set<string>();
  const compiledStrategies: CompiledStrategy[] = [];
  for (const [index, s] of strategies.entries()) {
    if (typeof s?.key !== 'string' || !KEY.test(s.key)) { problems.push(`Strategy key "${String(s?.key)}" is not a valid identifier.`); continue; }
    if (strategyKeys.has(s.key)) { problems.push(`Strategy "${s.key}" is declared twice.`); continue; }
    strategyKeys.add(s.key);
    if (typeof s.label !== 'string' || s.label.trim() === '') problems.push(`Strategy "${s.key}" needs a label.`);
    const values = new Float64Array(compiledVars.length).fill(Number.NaN);
    for (const [key, value] of Object.entries(s.set ?? {})) {
      const cv = byKey.get(key);
      if (!cv) { problems.push(`Strategy "${s.key}" sets "${key}", which is not a variable.`); continue; }
      if (!cv.spec.controllable) { problems.push(`Strategy "${s.key}" sets "${key}", which is uncertain rather than controllable — a strategy decides only what a person controls.`); continue; }
      const position = compiledVars.indexOf(cv);
      if (cv.isChoice) {
        const at = cv.optionKeys.indexOf(String(value));
        if (at < 0) problems.push(`Strategy "${s.key}" sets "${key}" to "${String(value)}", which is not one of its options.`);
        else values[position] = at;
      } else {
        if (!finite(value)) { problems.push(`Strategy "${s.key}" sets "${key}" to something that is not a finite number.`); continue; }
        const spec = cv.spec.spec;
        if (spec.kind === 'RANGE' && (value < spec.min || value > spec.max)) problems.push(`Strategy "${s.key}" sets "${key}" to ${value}, outside its allowed ${spec.min}–${spec.max}.`);
        values[position] = value;
      }
    }
    for (const [position, cv] of compiledVars.entries()) {
      if (!cv.spec.controllable || !Number.isNaN(values[position]!)) continue;
      if (cv.spec.spec.kind === 'FIXED') values[position] = cv.spec.spec.value;
      else problems.push(`Strategy "${s.key}" does not set the controllable "${cv.spec.key}", and it has no single default value.`);
    }
    compiledStrategies.push({ index, spec: s, values });
  }

  // Correlations: only between sampled numeric variables, through a matrix that can hold.
  let correlation: CompiledModel['correlation'] = null;
  const unjustified: string[] = [];
  if (correlationSpecs.length > 0) {
    const involved: number[] = [];
    const pairs = new Set<string>();
    for (const c of correlationSpecs) {
      const a = byKey.get(c?.a);
      const b = byKey.get(c?.b);
      if (!a || !b || a === b) { problems.push(`A correlation names "${String(c?.a)}" and "${String(c?.b)}", which are not two distinct variables.`); continue; }
      if (!a.sampled || !b.sampled || a.isChoice || b.isChoice) { problems.push(`The correlation between "${c.a}" and "${c.b}" needs both to be sampled numeric variables.`); continue; }
      if (!finite(c.rho) || c.rho <= -1 || c.rho >= 1 || c.rho === 0) problems.push(`The correlation between "${c.a}" and "${c.b}" needs -1 < rho < 1, non-zero.`);
      if (!VARIABLE_PROVENANCES.includes(c.provenance)) problems.push(`The correlation between "${c.a}" and "${c.b}" must say where the relationship came from.`);
      const pair = [c.a, c.b].sort().join('|');
      if (pairs.has(pair)) problems.push(`The correlation between "${c.a}" and "${c.b}" is declared twice.`);
      pairs.add(pair);
      if (!DISTRIBUTION_PROVENANCES.includes(c.provenance)) unjustified.push(`the correlation between ${c.a} and ${c.b} is ${c.provenance}`);
      for (const v of [a, b]) if (!involved.includes(compiledVars.indexOf(v))) involved.push(compiledVars.indexOf(v));
    }
    involved.sort((x, y) => x - y);
    const matrix: number[][] = involved.map((i) => involved.map((j): number => (i === j ? 1 : 0)));
    for (const c of correlationSpecs) {
      const a = byKey.get(c?.a);
      const b = byKey.get(c?.b);
      if (!a || !b) continue;
      const i = involved.indexOf(compiledVars.indexOf(a));
      const j = involved.indexOf(compiledVars.indexOf(b));
      if (i < 0 || j < 0 || !finite(c.rho)) continue;
      // A rank correlation ρs becomes the Gaussian copula's r = 2 sin(π ρs / 6).
      const r = 2 * Math.sin((Math.PI * c.rho) / 6);
      matrix[i]![j] = r;
      matrix[j]![i] = r;
    }
    if (involved.length > 0) {
      const factor = cholesky(matrix);
      if (!factor) problems.push('The declared correlations cannot all hold at once (the matrix is not positive definite).');
      else correlation = { order: involved, factor };
    }
  }

  if (problems.length > 0) throw new ScenarioModelError(problems);

  for (const cv of compiledVars) {
    if (cv.sampled && !cv.justified) unjustified.push(`${cv.spec.key} is a ${cv.spec.provenance} ${cv.spec.spec.kind === 'CHOICE' ? 'choice' : 'range'}`);
  }

  return {
    definition,
    hash: sha256(canonicalJson(definition)),
    slotCount,
    variables: compiledVars,
    byKey,
    sampled: compiledVars.filter((v) => v.sampled).map((v) => compiledVars.indexOf(v)),
    responses,
    derived,
    lines,
    metrics,
    constraints,
    strategies: compiledStrategies,
    correlation,
    justified: unjustified.length === 0,
    unjustified,
  };
}
