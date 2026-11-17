/**
 * The mathematics is a tool chosen per question, and every material number
 * keeps its provenance (META-18-3).
 *
 * Two halves, both pure apart from the two `record*` writers at the bottom:
 *
 *  - `selectMathematics` judges, for one economic question, which method
 *    families fit it. The family list is illustrative — never a ceiling and
 *    never a whitelist (R01-A1): a family outside it is accepted when it is
 *    declared with a reason. Fitness is judged per case from the evidence the
 *    caller supplies about the method's own preconditions, and the judgment is
 *    recorded with its reasons. Nothing is chosen by a fixed rule, and no
 *    question is required to use every family.
 *
 *  - `buildNumberProvenance` / `validateProvenance` keep, for every material
 *    number or claimed probability, what quantity it is, its units and time
 *    horizon, its source and retrieval date, its formula, alternative
 *    parameterizations, uncertainty and interdependence, sensitivity to its
 *    inputs and the evidence the method applies here. An unknown input stays
 *    unknown (the result is unknown, never a convenient figure), a formula
 *    whose units do not reconcile is refused (`checkDimensions`), an
 *    accounting identity is exact *conditional on its inputs*, and a
 *    probability is calibrated only when the existing calibration
 *    (`forecast.ts calibrate`) says its bucket is.
 *
 *  - `forecastBias` compares forecasts with realized results through the
 *    existing prediction and outcome rows (`forecast.ts`, `ledger.ts`) and
 *    proposes a correction when the systematic error exceeds the calibration
 *    band.
 *
 * It owns no table, schedule or queue. Records are written through the
 * existing append-only writer (`recordBinEvent` → `bin_events`), as the
 * forecast ledger already is.
 */
import { recordBinEvent } from '../../repos/bins.ts';
import { derive, type Figure } from './graph.ts';
import {
  buildLedger,
  calibrate,
  MIN_CALIBRATION_SAMPLE,
  MISCALIBRATION_Z,
  type CalibrationBucket,
  type ExposureRow,
  type OutcomeRow,
  impliedProbability,
  type PredictionRow,
} from './forecast.ts';
import { claimedRange, readLedger } from './ledger.ts';

/* ------------------------------------------------------------------------- */
/* Method families: an illustrative toolbox                                  */
/* ------------------------------------------------------------------------- */

/** Illustrative, not exhaustive and not a filter (S-0197, S-0198, R01-A1). */
export const ILLUSTRATIVE_METHOD_FAMILIES = [
  'probability_bayesian_inference',
  'statistical_estimation_calibration',
  'causal_inference',
  'sensitivity_analysis',
  'value_of_information_experimental_design',
  'constrained_optimization',
  'robust_stochastic_optimization',
  'monte_carlo_scenario_simulation',
  'time_to_event_settlement',
  'queuing_theory',
  'network_graph_algorithms',
  'matching_assignment',
  'flow_routing',
  'portfolio_dependence',
  'cash_flow_identities',
  'operations_research',
  'game_theory_competitive_response',
  'real_options',
  'forecasting_state_estimation',
  'reliability_engineering',
] as const;

/** One precondition a method needs, and what the evidence says about it in this case. */
export interface MethodPrecondition {
  condition: string;
  /** HOLDS / FAILS when evidence says so; UNKNOWN when nothing does. */
  state: 'HOLDS' | 'FAILS' | 'UNKNOWN';
  /** References to the evidence (rows, sources) the state was read from. Required unless UNKNOWN. */
  evidence: readonly string[];
}

export interface MethodCandidate {
  family: string;
  /** What the method would answer for this question. */
  purpose: string;
  preconditions: readonly MethodPrecondition[];
  /** Required when the family is outside the illustrative list: why it is needed here. */
  declaredReason?: string;
}

export interface MathQuestion {
  /** The economic question, in words. */
  question: string;
  /** The opportunity or decision the answer is for. */
  subject: string;
  candidates: readonly MethodCandidate[];
}

export interface FitnessJudgment {
  family: string;
  declared: boolean;
  verdict: 'FIT' | 'UNFIT' | 'UNJUDGED' | 'REFUSED';
  reasons: string[];
}

export interface MathSelection {
  question: string;
  subject: string;
  judgments: FitnessJudgment[];
  /** The fit families, composed in the order given; empty is a finding, not a default. */
  selected: string[];
  /** Preconditions nobody has evidence about: research that would let a family be judged. */
  openQuestions: { family: string; condition: string }[];
}

const KNOWN_FAMILIES: ReadonlySet<string> = new Set(ILLUSTRATIVE_METHOD_FAMILIES);

/**
 * Judge each candidate family's fitness for this question from the evidence
 * about its preconditions, and record why. A family whose preconditions all
 * hold on evidence is FIT; any that fails makes it UNFIT; an unanswered one
 * leaves it UNJUDGED (an unknown never makes a method fit, §7.39). A family
 * outside the illustrative list is accepted when declared with a reason and
 * judged like any other; undeclared, it is REFUSED with that named.
 */
export function selectMathematics(input: MathQuestion): MathSelection {
  const judgments: FitnessJudgment[] = [];
  const openQuestions: MathSelection['openQuestions'] = [];
  for (const c of input.candidates) {
    const family = c.family.trim();
    const declared = !KNOWN_FAMILIES.has(family);
    const reasons: string[] = [];
    if (!family) {
      judgments.push({ family, declared, verdict: 'REFUSED', reasons: ['A method family is named.'] });
      continue;
    }
    if (declared && !c.declaredReason?.trim()) {
      judgments.push({ family, declared, verdict: 'REFUSED', reasons: [`"${family}" is outside the illustrative list and declares no reason it is needed here.`] });
      continue;
    }
    if (declared) reasons.push(`declared: ${c.declaredReason!.trim()}`);
    if (c.preconditions.length === 0) {
      reasons.push('No precondition was stated, so nothing shows the method applies to this case.');
      judgments.push({ family, declared, verdict: 'UNJUDGED', reasons });
      continue;
    }
    let fails = false;
    let unknown = false;
    for (const p of c.preconditions) {
      if (p.state !== 'UNKNOWN' && p.evidence.length === 0) {
        reasons.push(`"${p.condition}" is said to ${p.state === 'HOLDS' ? 'hold' : 'fail'} without evidence; read as unknown.`);
        unknown = true;
        openQuestions.push({ family, condition: p.condition });
      } else if (p.state === 'FAILS') {
        fails = true;
        reasons.push(`"${p.condition}" fails (${p.evidence.join(', ')}).`);
      } else if (p.state === 'UNKNOWN') {
        unknown = true;
        reasons.push(`"${p.condition}" is unknown.`);
        openQuestions.push({ family, condition: p.condition });
      } else {
        reasons.push(`"${p.condition}" holds (${p.evidence.join(', ')}).`);
      }
    }
    judgments.push({ family, declared, verdict: fails ? 'UNFIT' : unknown ? 'UNJUDGED' : 'FIT', reasons });
  }
  return {
    question: input.question,
    subject: input.subject,
    judgments,
    selected: judgments.filter((j) => j.verdict === 'FIT').map((j) => j.family),
    openQuestions,
  };
}

/* ------------------------------------------------------------------------- */
/* Dimensional validation                                                    */
/* ------------------------------------------------------------------------- */

/** A formula as data, so it can be checked and re-evaluated, never as prose. */
export type Expr =
  | { ref: string }
  | { const: number; unit?: string }
  | { op: '+' | '-' | '*' | '/'; args: readonly Expr[] };

type Dims = Map<string, number>;

/** Parse a unit such as `USD/month`, `USD*month^-1`, `count`, or `1` (dimensionless) into base exponents. */
export function parseUnit(unit: string): Dims | null {
  const dims: Dims = new Map();
  const text = unit.replace(/\s+/g, '');
  if (!text) return null;
  if (text === '1' || text === 'ratio' || text === 'probability' || text === 'dimensionless') return dims;
  let sign = 1;
  for (const token of text.split(/(?=[*/])/)) {
    let t = token;
    if (t.startsWith('*')) { sign = 1; t = t.slice(1); } else if (t.startsWith('/')) { sign = -1; t = t.slice(1); }
    const m = /^([A-Za-z_%$][A-Za-z0-9_%$.-]*)(?:\^(-?\d+))?$/.exec(t);
    if (!m) {
      if (t === '1') continue;
      return null;
    }
    const exp = sign * Number(m[2] ?? 1);
    dims.set(m[1]!, (dims.get(m[1]!) ?? 0) + exp);
  }
  for (const [k, v] of [...dims]) if (v === 0) dims.delete(k);
  return dims;
}

function sameDims(a: Dims, b: Dims): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function showDims(d: Dims): string {
  return d.size === 0 ? '1' : [...d].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (v === 1 ? k : `${k}^${v}`)).join('*');
}

export type DimensionResult = { ok: true; unit: string } | { ok: false; problems: string[] };

/**
 * Check that a formula's units reconcile: terms added or subtracted share a
 * dimension, products and quotients combine exponents, and the result matches
 * the declared unit. A refusal names every place the units disagree.
 */
export function checkDimensions(formula: Expr, inputUnits: Readonly<Record<string, string>>, declaredUnit: string): DimensionResult {
  const problems: string[] = [];
  const walk = (e: Expr): Dims | null => {
    if ('ref' in e) {
      const u = inputUnits[e.ref];
      if (u === undefined) { problems.push(`input "${e.ref}" has no unit`); return null; }
      const d = parseUnit(u);
      if (!d) problems.push(`unit "${u}" of "${e.ref}" cannot be read`);
      return d;
    }
    if ('const' in e) {
      const d = parseUnit(e.unit ?? '1');
      if (!d) problems.push(`constant unit "${e.unit}" cannot be read`);
      return d;
    }
    const parts = e.args.map(walk);
    if (parts.some((p) => p === null) || parts.length === 0) return null;
    const ds = parts as Dims[];
    if (e.op === '+' || e.op === '-') {
      const first = ds[0]!;
      for (const d of ds.slice(1)) {
        if (!sameDims(first, d)) problems.push(`cannot ${e.op === '+' ? 'add' : 'subtract'} ${showDims(d)} and ${showDims(first)}`);
      }
      return first;
    }
    const out: Dims = new Map(ds[0]!);
    for (const d of ds.slice(1)) {
      for (const [k, v] of d) out.set(k, (out.get(k) ?? 0) + (e.op === '*' ? v : -v));
    }
    for (const [k, v] of [...out]) if (v === 0) out.delete(k);
    return out;
  };
  const result = walk(formula);
  const declared = parseUnit(declaredUnit);
  if (!declared) problems.push(`declared unit "${declaredUnit}" cannot be read`);
  if (result && declared && !sameDims(result, declared)) problems.push(`the formula yields ${showDims(result)} but the figure is declared in ${showDims(declared)}`);
  return problems.length === 0 && result ? { ok: true, unit: showDims(result) } : { ok: false, problems };
}

/** Evaluate a formula over named values. */
export function evaluate(formula: Expr, values: Readonly<Record<string, number>>): number {
  if ('ref' in formula) {
    const v = values[formula.ref];
    if (v === undefined) throw new Error(`no value for "${formula.ref}"`);
    return v;
  }
  if ('const' in formula) return formula.const;
  const xs = formula.args.map((a) => evaluate(a, values));
  switch (formula.op) {
    case '+': return xs.reduce((s, x) => s + x, 0);
    case '-': return xs.slice(1).reduce((s, x) => s - x, xs[0] ?? 0);
    case '*': return xs.reduce((s, x) => s * x, 1);
    case '/': return xs.slice(1).reduce((s, x) => s / x, xs[0] ?? 0);
  }
}

export function showFormula(e: Expr): string {
  if ('ref' in e) return e.ref;
  if ('const' in e) return e.unit ? `${e.const}[${e.unit}]` : String(e.const);
  return `(${e.args.map(showFormula).join(` ${e.op} `)})`;
}

/* ------------------------------------------------------------------------- */
/* Per-number provenance                                                     */
/* ------------------------------------------------------------------------- */

/** Illustrative quantity kinds; any other is declared (`OTHER` with a definition). */
export const QUANTITY_KINDS = ['GROSS_BILLED', 'CASH_RECEIVED', 'NET_CONTRIBUTION', 'RETAINED_CASH', 'ENTERPRISE_VALUE', 'PROBABILITY', 'OTHER'] as const;
export type QuantityKind = (typeof QUANTITY_KINDS)[number];

/** What kind of truth the number can carry. */
export type NumberNature =
  /** An accounting or cash-flow identity: exact, conditional on its inputs. */
  | 'EXACT_CONDITIONAL_ON_INPUTS'
  /** A probability backed by a calibrated bucket of comparable forecasts. */
  | 'CALIBRATED_PROBABILITY'
  /** A probability with no calibrated evidence behind it. */
  | 'UNCALIBRATED_PROBABILITY'
  /** A modelled estimate. */
  | 'ESTIMATE'
  /** Not known: no value is shown. */
  | 'UNKNOWN';

export interface SourceRef {
  ref: string;
  /** ISO-8601 date the source was retrieved. */
  retrievedAt: string;
}

export interface ProvenanceInput {
  key: string;
  figure: Figure;
  source: SourceRef;
}

export interface Alternative {
  label: string;
  /** The input values that differ from the base case. */
  parameters: Readonly<Record<string, number>>;
  /** The result under them; null when an input it needs is unknown. */
  value: number | null;
}

export interface Sensitivity {
  input: string;
  /** Relative perturbation applied to the input. */
  step: number;
  /** Result change per +step on that input (absolute), or null when it cannot be computed. */
  change: number | null;
  /** Elasticity: relative result change over relative input change. */
  elasticity: number | null;
}

export interface NumberProvenance {
  key: string;
  quantity: { kind: QuantityKind; definition: string };
  value: number | null;
  units: string;
  horizon: string;
  /** Where each input came from, with when it was retrieved. */
  sources: { input: string; ref: string; retrievedAt: string }[];
  computation: { formula: string; expr: Expr; dimensionCheck: DimensionResult };
  alternatives: Alternative[];
  uncertainty: { bounds: { low: number; high: number } | null; interdependence: string[] };
  sensitivity: Sensitivity[];
  applicability: { method: string; evidence: string[] };
  nature: NumberNature;
  /** Inputs that are unknown; when non-empty the value is null. */
  unknownInputs: string[];
}

export interface BuildProvenanceInput {
  key: string;
  quantity: { kind: QuantityKind; definition?: string };
  units: string;
  horizon: string;
  formula: Expr;
  inputs: readonly ProvenanceInput[];
  alternatives?: readonly { label: string; parameters: Readonly<Record<string, number>> }[];
  /** Named dependencies between inputs or with other figures (shared payer, shared capacity, …). */
  interdependence?: readonly string[];
  applicability: { method: string; evidence: readonly string[] };
  /** EXACT for an accounting identity, PROBABILITY for a claimed probability, ESTIMATE otherwise. */
  form: 'IDENTITY' | 'PROBABILITY' | 'ESTIMATE';
  /** For a probability: the comparable bucket whose calibration backs it. */
  calibration?: CalibrationBucket | null;
  /** Relative step for sensitivity; default 10%. */
  sensitivityStep?: number;
}

export type ProvenanceResult = { ok: true; record: NumberProvenance } | { ok: false; missing: string[]; problems: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Check a provenance record carries everything S-0198 lists, naming each
 * missing field. A record with a value but an unknown input, a source without
 * a retrieval date, or units that do not reconcile is refused.
 */
export function validateProvenance(record: NumberProvenance): { ok: boolean; missing: string[]; problems: string[] } {
  const missing: string[] = [];
  const problems: string[] = [];
  if (!(QUANTITY_KINDS as readonly string[]).includes(record.quantity?.kind)) missing.push('quantity kind');
  else if (record.quantity.kind === 'OTHER' && !record.quantity.definition?.trim()) missing.push('quantity definition (OTHER)');
  if (!record.units?.trim()) missing.push('units');
  if (!record.horizon?.trim()) missing.push('time horizon');
  if (!record.sources || record.sources.length === 0) missing.push('source');
  for (const s of record.sources ?? []) {
    if (!s.ref?.trim()) missing.push(`source of "${s.input}"`);
    if (!s.retrievedAt || !ISO_DATE.test(s.retrievedAt)) missing.push(`retrieval date of "${s.input}"`);
  }
  if (!record.computation?.formula?.trim()) missing.push('formula');
  if (!record.alternatives || record.alternatives.length === 0) missing.push('alternative parameterizations');
  if (!record.uncertainty) missing.push('uncertainty and interdependence');
  if (!record.sensitivity || record.sensitivity.length === 0) missing.push('sensitivity');
  if (!record.applicability?.method?.trim() || !record.applicability.evidence || record.applicability.evidence.length === 0) missing.push('applicability evidence');
  if (record.computation?.dimensionCheck && !record.computation.dimensionCheck.ok) problems.push(...record.computation.dimensionCheck.problems);
  if ((record.unknownInputs ?? []).length > 0 && record.value !== null) problems.push(`a value is shown although ${record.unknownInputs.join(', ')} is unknown`);
  if (record.nature === 'CALIBRATED_PROBABILITY' && record.quantity?.kind !== 'PROBABILITY') problems.push('only a probability can be calibrated');
  if (record.quantity?.kind === 'PROBABILITY' && record.value !== null && !(record.value >= 0 && record.value <= 1)) problems.push('a probability lies between 0 and 1');
  return { ok: missing.length === 0 && problems.length === 0, missing, problems };
}

/**
 * Build the provenance of one material number from its formula and sourced
 * inputs, computing the alternatives and the sensitivity rather than taking
 * them on trust, then validate it. An input with a value but no source is a
 * convenient figure and is refused; an unknown input makes the result unknown.
 */
export function buildNumberProvenance(input: BuildProvenanceInput): ProvenanceResult {
  const problems: string[] = [];
  for (const i of input.inputs) {
    if (i.figure.status !== 'UNKNOWN' && !i.figure.source && i.figure.derivedFrom.length === 0) problems.push(`"${i.key}" has a value but no source; an unknown is not filled with a convenient figure`);
    if (i.figure.status === 'ASSUMED') problems.push(`"${i.key}" is an assumption, not a sourced figure; state it as unknown or source it`);
  }
  const units: Record<string, string> = Object.fromEntries(input.inputs.map((i) => [i.key, i.figure.unit]));
  const dimensionCheck = checkDimensions(input.formula, units, input.units);
  const keys = input.inputs.map((i) => i.key);
  const unknownInputs = input.inputs.filter((i) => i.figure.status === 'UNKNOWN' || i.figure.value === null).map((i) => i.key);
  const compute = (values: number[]): number => evaluate(input.formula, Object.fromEntries(keys.map((k, n) => [k, values[n]!])));
  const derived = derive(input.key, input.units, input.inputs.map((i) => i.figure), compute);
  const known = unknownInputs.length === 0;
  const base: Record<string, number> = known ? Object.fromEntries(input.inputs.map((i) => [i.key, i.figure.value as number])) : {};
  const value = known && dimensionCheck.ok ? derived.value : null;

  const alternatives: Alternative[] = (input.alternatives ?? []).map((a) => {
    const merged: Record<string, number> = { ...base, ...a.parameters };
    const complete = keys.every((k) => merged[k] !== undefined);
    return { label: a.label, parameters: { ...a.parameters }, value: complete && dimensionCheck.ok ? evaluate(input.formula, merged) : null };
  });

  const step = input.sensitivityStep ?? 0.1;
  const sensitivity: Sensitivity[] = keys.map((k) => {
    if (!known || value === null) return { input: k, step, change: null, elasticity: null };
    const x = base[k]!;
    const bumped = evaluate(input.formula, { ...base, [k]: x === 0 ? step : x * (1 + step) });
    const change = bumped - value;
    const elasticity = x !== 0 && value !== 0 ? change / value / step : null;
    return { input: k, step, change, elasticity };
  });

  let nature: NumberNature;
  if (value === null) nature = 'UNKNOWN';
  else if (input.form === 'IDENTITY') nature = 'EXACT_CONDITIONAL_ON_INPUTS';
  else if (input.form === 'PROBABILITY') nature = input.calibration?.verdict === 'CALIBRATED' ? 'CALIBRATED_PROBABILITY' : 'UNCALIBRATED_PROBABILITY';
  else nature = 'ESTIMATE';

  const record: NumberProvenance = {
    key: input.key,
    quantity: { kind: input.quantity.kind, definition: input.quantity.definition?.trim() || input.quantity.kind.toLowerCase().replace(/_/g, ' ') },
    value,
    units: input.units,
    horizon: input.horizon,
    sources: input.inputs.map((i) => ({ input: i.key, ref: i.source.ref, retrievedAt: i.source.retrievedAt })),
    computation: { formula: showFormula(input.formula), expr: input.formula, dimensionCheck },
    alternatives,
    uncertainty: { bounds: value === null ? null : derived.bounds, interdependence: [...(input.interdependence ?? [])] },
    sensitivity,
    applicability: { method: input.applicability.method, evidence: [...input.applicability.evidence] },
    nature,
    unknownInputs,
  };
  if (input.quantity.kind === 'OTHER' && !input.quantity.definition?.trim()) record.quantity.definition = '';
  const verdict = validateProvenance(record);
  const allProblems = [...problems, ...verdict.problems.filter((p) => !problems.includes(p))];
  if (verdict.missing.length > 0 || allProblems.length > 0) return { ok: false, missing: verdict.missing, problems: allProblems };
  return { ok: true, record };
}

/* ------------------------------------------------------------------------- */
/* Forecasts against realized results                                        */
/* ------------------------------------------------------------------------- */

export interface BiasReading {
  comparableKey: string;
  /** PROBABILITY: observed rate minus mean forecast. FIGURE: mean of realized / range midpoint, minus one. */
  basis: 'PROBABILITY' | 'FIGURE';
  n: number;
  bias: number | null;
  zScore: number | null;
  verdict: 'INSUFFICIENT' | 'WITHIN_BAND' | 'SYSTEMATIC';
  /** A proposed correction when the error is systematic; null otherwise. */
  correction: { kind: 'SHIFT_PROBABILITY' | 'SCALE_FIGURE'; amount: number; rationale: string } | null;
}

/**
 * Systematic forecast error per comparable bucket, from the existing ledger
 * rows. Probability claims are read through the existing calibration (pooled
 * where it exists, else the bucket's window); figure claims compare the
 * realized figure with the midpoint of the stated range. Either is systematic
 * only beyond the calibration band (`MISCALIBRATION_Z` standard errors on at
 * least `MIN_CALIBRATION_SAMPLE` outcomes), and then a correction is proposed.
 */
export function forecastBias(predictions: readonly PredictionRow[], exposures: readonly ExposureRow[], outcomes: readonly OutcomeRow[], windowDays = 90): BiasReading[] {
  const ledger = buildLedger(predictions, exposures, outcomes);
  const out: BiasReading[] = [];
  const buckets = calibrate(ledger, windowDays);
  const byKey = new Map<string, CalibrationBucket>();
  for (const b of buckets) {
    const held = byKey.get(b.comparableKey);
    if (!held || (b.scope === 'POOLED' && held.scope !== 'POOLED') || (b.scope === held.scope && b.n > held.n)) byKey.set(b.comparableKey, b);
  }
  for (const b of byKey.values()) {
    const systematic = b.verdict === 'MISCALIBRATED';
    out.push({
      comparableKey: b.comparableKey,
      basis: 'PROBABILITY',
      n: b.n,
      bias: b.gap,
      zScore: b.zScore,
      verdict: b.verdict === 'INSUFFICIENT' ? 'INSUFFICIENT' : systematic ? 'SYSTEMATIC' : 'WITHIN_BAND',
      correction: systematic && b.gap !== null
        ? { kind: 'SHIFT_PROBABILITY', amount: b.gap, rationale: `observed ${b.observedRate?.toFixed(3)} against forecast ${b.meanForecast?.toFixed(3)} over ${b.n} outcomes (z ${b.zScore?.toFixed(2)})` }
        : null,
    });
  }
  const ratios = new Map<string, number[]>();
  for (const e of ledger) {
    if (!e.outcome || e.outcome.realized === undefined) continue;
    const range = claimedRange(e.prediction);
    if (!range) continue;
    const mid = (range.low + range.high) / 2;
    if (mid === 0) continue;
    const list = ratios.get(e.prediction.comparableKey) ?? [];
    list.push(e.outcome.realized / mid - 1);
    ratios.set(e.prediction.comparableKey, list);
  }
  for (const [comparableKey, xs] of ratios) {
    const n = xs.length;
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const enough = n >= MIN_CALIBRATION_SAMPLE;
    const zScore = enough && sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
    const systematic = zScore !== null && Math.abs(zScore) > MISCALIBRATION_Z;
    out.push({
      comparableKey,
      basis: 'FIGURE',
      n,
      bias: enough ? mean : null,
      zScore,
      verdict: !enough || zScore === null ? 'INSUFFICIENT' : systematic ? 'SYSTEMATIC' : 'WITHIN_BAND',
      correction: systematic ? { kind: 'SCALE_FIGURE', amount: 1 + mean, rationale: `realized figures ran ${(mean * 100).toFixed(1)}% from the stated midpoint over ${n} outcomes (z ${zScore!.toFixed(2)})` } : null,
    });
  }
  return out.sort((a, b) => a.comparableKey.localeCompare(b.comparableKey) || a.basis.localeCompare(b.basis));
}

/* ------------------------------------------------------------------------- */
/* Records, through the existing append-only writer                          */
/* ------------------------------------------------------------------------- */

export const MATH_EVENTS = {
  SELECTION: 'MATH_METHOD_SELECTION',
  PROVENANCE: 'NUMBER_PROVENANCE',
  BIAS: 'FORECAST_BIAS_CORRECTION',
} as const;

export interface MathRecordDeps {
  record?: typeof recordBinEvent;
  projectId?: string | null;
  caller?: string;
}

/** Record a method-selection judgment. */
export async function recordMathSelection(selection: MathSelection, deps: MathRecordDeps = {}): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: MATH_EVENTS.SELECTION,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'math-toolkit',
    outcome: selection.selected.length > 0 ? 'SELECTED' : 'NONE_FIT',
    reason: `${selection.subject}: ${selection.question}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { selection },
  });
}

/** Record a number's provenance; refuses (throws) a record that does not validate. */
export async function recordNumberProvenance(record: NumberProvenance, deps: MathRecordDeps = {}): Promise<void> {
  const verdict = validateProvenance(record);
  if (!verdict.ok) throw new Error(`provenance refused: ${[...verdict.missing.map((m) => `missing ${m}`), ...verdict.problems].join('; ')}`);
  await (deps.record ?? recordBinEvent)({
    eventType: MATH_EVENTS.PROVENANCE,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'math-toolkit',
    outcome: record.nature,
    reason: `${record.key} = ${record.value ?? 'unknown'} ${record.units} (${record.horizon})`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { provenance: record },
  });
}

/** Record one systematic forecast error and its proposed correction. */
export async function recordForecastBias(reading: BiasReading, deps: MathRecordDeps = {}): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: MATH_EVENTS.BIAS,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'math-toolkit',
    outcome: reading.verdict,
    reason: `${reading.comparableKey} (${reading.basis}) n=${reading.n} bias=${reading.bias ?? 'unknown'}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { bias: reading },
  });
}

/* ------------------------------------------------------------------------- */
/* The production pass over the forecast ledger                              */
/* ------------------------------------------------------------------------- */

type Ledger = Awaited<ReturnType<typeof readLedger>>;

/**
 * The method question every comparable bucket of the forecast ledger poses —
 * "how far can these forecasts be trusted, and should they be corrected?" —
 * with each candidate family's preconditions read from the bucket's own rows.
 * Calibration needs enough resolved outcomes with a probability; figure
 * correction needs realized figures against a stated range; Bayesian
 * updating needs at least one resolved outcome. A precondition the rows do
 * not answer is UNKNOWN (§7.39), never assumed.
 */
export function ledgerBucketQuestion(comparableKey: string, ledger: Ledger): MathQuestion {
  const preds = new Map(ledger.predictions.filter((p) => p.comparableKey === comparableKey).map((p) => [p.id, p]));
  const outcomes = ledger.outcomes.filter((o) => preds.has(o.predictionId));
  const ev = (rows: readonly OutcomeRow[]): string[] => rows.map((o) => o.evidence ?? `prediction:${o.predictionId}@${o.observedAt}`).slice(0, 20);
  const withProbability = outcomes.filter((o) => {
    const p = preds.get(o.predictionId);
    return p ? impliedProbability(p) !== null : false;
  });
  const withFigure = outcomes.filter((o) => {
    const p = preds.get(o.predictionId);
    return o.realized !== undefined && p ? claimedRange(p) !== null : false;
  });
  const sampleState = (rows: readonly OutcomeRow[]): MethodPrecondition['state'] => (rows.length >= MIN_CALIBRATION_SAMPLE ? 'HOLDS' : rows.length === 0 ? 'UNKNOWN' : 'FAILS');
  return {
    question: 'How far can these forecasts be trusted, and does their systematic error call for a correction?',
    subject: `forecast bucket ${comparableKey}`,
    candidates: [
      {
        family: 'statistical_estimation_calibration',
        purpose: 'compare stated probabilities with how often the outcome occurred',
        preconditions: [{
          condition: `at least ${MIN_CALIBRATION_SAMPLE} resolved outcomes carry a stated or implied probability`,
          state: sampleState(withProbability),
          evidence: withProbability.length > 0 ? ev(withProbability) : [],
        }],
      },
      {
        family: 'forecasting_state_estimation',
        purpose: 'compare realized figures with the stated range and scale the forecast',
        preconditions: [{
          condition: `at least ${MIN_CALIBRATION_SAMPLE} realized figures against a stated range`,
          state: sampleState(withFigure),
          evidence: withFigure.length > 0 ? ev(withFigure) : [],
        }],
      },
      {
        family: 'probability_bayesian_inference',
        purpose: 'update the bucket\'s probability from each resolved outcome',
        preconditions: [{
          condition: 'at least one resolved outcome with a stated or implied probability',
          state: withProbability.length > 0 ? 'HOLDS' : 'UNKNOWN',
          evidence: withProbability.length > 0 ? ev(withProbability) : [],
        }],
      },
    ],
  };
}

/**
 * The provenance of one forecast's claimed probability: the stated (or
 * range-implied) probability as a sourced input, judged calibrated only when
 * its bucket's calibration says so, with the bucket's correction as the
 * alternative parameterization when one is proposed.
 */
export function predictionProbabilityProvenance(p: PredictionRow, bucket: CalibrationBucket | null, bias: BiasReading | null): ProvenanceResult | null {
  const probability = impliedProbability(p);
  if (probability === null) return null;
  const source = `bin_events:${p.id}`;
  const figure: Figure = {
    meaning: `probability that ${p.outcome}`,
    unit: 'probability',
    value: probability,
    source,
    derivedFrom: [],
    status: p.probability !== null ? 'MODELED' : 'EVIDENCED',
    window: p.horizonDays !== null ? `${p.horizonDays} days` : null,
    geography: null,
    scope: p.population,
    bounds: null,
    invalidatedBy: [...p.assumptions],
  };
  const corrected = bias?.correction?.kind === 'SHIFT_PROBABILITY' ? Math.min(1, Math.max(0, probability + bias.correction.amount)) : null;
  const alternatives = [
    ...(corrected !== null ? [{ label: `corrected by bucket bias (${bias!.correction!.rationale})`, parameters: { p: corrected } }] : []),
    ...(bucket?.observedRate !== null && bucket?.observedRate !== undefined ? [{ label: `bucket observed rate over ${bucket.n} outcomes`, parameters: { p: bucket.observedRate } }] : []),
    { label: 'uninformed (no evidence either way)', parameters: { p: 0.5 } },
  ];
  return buildNumberProvenance({
    key: `prediction:${p.id}`,
    quantity: { kind: 'PROBABILITY', definition: `probability that ${p.outcome} (${p.population})` },
    units: 'probability',
    horizon: p.horizonDays !== null ? `${p.horizonDays} days from ${p.madeAt}` : `unstated horizon from ${p.madeAt}`,
    formula: { ref: 'p' },
    inputs: [{ key: 'p', figure, source: { ref: source, retrievedAt: p.madeAt } }],
    alternatives,
    interdependence: [`shares comparable bucket ${p.comparableKey}`, ...p.data.map((d) => `rests on ${d}`)],
    applicability: {
      method: bucket ? `calibration of bucket ${p.comparableKey}: ${bucket.verdict} (n=${bucket.n})` : 'no calibration bucket yet',
      evidence: [source, ...p.data],
    },
    form: 'PROBABILITY',
    calibration: bucket,
  });
}

export interface LedgerMathResult {
  buckets: number;
  selections: MathSelection[];
  biases: BiasReading[];
  provenanceRecorded: number;
  provenanceRefused: { key: string; reasons: string[] }[];
}

export interface LedgerMathDeps extends MathRecordDeps {
  read?: () => Promise<Ledger>;
  windowDays?: number;
}

/**
 * The production consumer of this toolkit over real forecast rows: for every
 * comparable bucket of the ledger it judges which mathematics fits (and
 * records the judgment), measures forecast-against-realized bias (and records
 * each systematic one with its correction), and records the provenance of the
 * current version of every claimed probability. Idempotence is the caller's
 * cadence; every record is append-only.
 */
export async function assessLedgerMathematics(deps: LedgerMathDeps = {}): Promise<LedgerMathResult> {
  const ledger = await (deps.read ?? (() => readLedger(deps.projectId ?? null)))();
  const windowDays = deps.windowDays ?? 90;
  const keys = [...new Set(ledger.predictions.map((p) => p.comparableKey))].sort();
  const selections = keys.map((k) => selectMathematics(ledgerBucketQuestion(k, ledger)));
  for (const s of selections) await recordMathSelection(s, deps);

  const biases = forecastBias(ledger.predictions, ledger.exposures, ledger.outcomes, windowDays);
  for (const b of biases) if (b.verdict === 'SYSTEMATIC') await recordForecastBias(b, deps);

  const pooled = new Map<string, CalibrationBucket>();
  for (const b of calibrate(buildLedger(ledger.predictions, ledger.exposures, ledger.outcomes), windowDays)) {
    const held = pooled.get(b.comparableKey);
    if (!held || (b.scope === 'POOLED' && held.scope !== 'POOLED')) pooled.set(b.comparableKey, b);
  }
  const probabilityBias = new Map(biases.filter((b) => b.basis === 'PROBABILITY').map((b) => [b.comparableKey, b]));
  const current = new Map<string, PredictionRow>();
  for (const p of ledger.predictions) {
    const held = current.get(p.claimId);
    if (!held || p.version > held.version) current.set(p.claimId, p);
  }
  let provenanceRecorded = 0;
  const provenanceRefused: LedgerMathResult['provenanceRefused'] = [];
  for (const p of current.values()) {
    const built = predictionProbabilityProvenance(p, pooled.get(p.comparableKey) ?? null, probabilityBias.get(p.comparableKey) ?? null);
    if (!built) continue;
    if (!built.ok) {
      provenanceRefused.push({ key: `prediction:${p.id}`, reasons: [...built.missing.map((m) => `missing ${m}`), ...built.problems] });
      continue;
    }
    await recordNumberProvenance(built.record, deps);
    provenanceRecorded += 1;
  }
  return { buckets: keys.length, selections, biases, provenanceRecorded, provenanceRefused };
}
