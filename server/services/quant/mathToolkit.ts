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
  type PredictionRow,
} from './forecast.ts';
import { claimedRange } from './ledger.ts';

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

/* ------------------------------------------------------------------------- */
/* Production consumers: the figures Brain actually states                    */
/* ------------------------------------------------------------------------- */

/**
 * The toolkit is not a library waiting for a caller: every material number
 * the running Brain states goes through it where that number is made.
 *
 *  - The cash forecast (`cash/forecast.ts`, recorded by `ledger.ts
 *    keepCashLedger`) — every version of its revenue, contribution and
 *    most-cash-out-at-once figures is recorded with its provenance, the
 *    method selection for that question is recorded beside it, and the
 *    ledger's forecast-vs-realized bias is read on the same refresh: a
 *    systematic error is recorded and carried into the figure's provenance as
 *    the corrected alternative, so the next reader sees the correction.
 *  - The intelligence sprint (`improvement/sprint.ts`) — the baseline's
 *    probabilities are fitted base rates with provenance, and the general
 *    method's probability is recorded with the evidence counts it multiplies.
 */

export const BIAS_EVENT = 'FORECAST_BIAS';

/** A count read from rows, as a sourced figure. */
export function countFigure(meaning: string, n: number, source: string, scope: string | null = null): Figure {
  return {
    meaning,
    unit: 'count',
    value: n,
    source,
    derivedFrom: [],
    status: 'OBSERVED',
    window: null,
    geography: null,
    scope,
    bounds: null,
    invalidatedBy: [],
  };
}

/** An input nobody has evidence for: carried as unknown, never as a convenient figure. */
export function unknownInput(key: string, meaning: string, unit: string): ProvenanceInput {
  return {
    key,
    figure: { meaning, unit, value: null, source: null, derivedFrom: [], status: 'UNKNOWN', window: null, geography: null, scope: null, bounds: null, invalidatedBy: [] },
    source: { ref: `unknown:${key}`, retrievedAt: new Date(0).toISOString() },
  };
}

/**
 * A rate k/n read from rows, as a claimed probability with provenance. With no
 * rows the rate is unknown, not a default. The alternatives are the
 * Laplace-smoothed rate and the rate if one more case had gone either way, so
 * a reader sees how fragile a small sample is.
 */
export function rateProvenance(input: {
  key: string;
  definition: string;
  hits: number;
  considered: number;
  source: string;
  retrievedAt: string;
  horizon: string;
  applicability: { method: string; evidence: readonly string[] };
  interdependence?: readonly string[];
  calibration?: CalibrationBucket | null;
}): ProvenanceResult {
  const inputs: ProvenanceInput[] =
    input.considered > 0
      ? [
          { key: 'hits', figure: countFigure(`cases where ${input.definition}`, input.hits, input.source), source: { ref: input.source, retrievedAt: input.retrievedAt } },
          { key: 'considered', figure: countFigure('cases considered', input.considered, input.source), source: { ref: input.source, retrievedAt: input.retrievedAt } },
        ]
      : [unknownInput('hits', `cases where ${input.definition}`, 'count'), unknownInput('considered', 'cases considered', 'count')];
  const k = input.hits;
  const n = input.considered;
  return buildNumberProvenance({
    key: input.key,
    quantity: { kind: 'PROBABILITY', definition: input.definition },
    units: 'probability',
    horizon: input.horizon,
    formula: { op: '/', args: [{ ref: 'hits' }, { ref: 'considered' }] },
    inputs,
    alternatives: n > 0
      ? [
          { label: 'Laplace-smoothed (k+1)/(n+2)', parameters: { hits: k + 1, considered: n + 2 } },
          { label: 'one more case succeeded', parameters: { hits: k + 1, considered: n + 1 } },
          { label: 'one more case failed', parameters: { hits: k, considered: n + 1 } },
        ]
      : [{ label: 'no cases: unknown', parameters: {} }],
    interdependence: input.interdependence ?? [],
    applicability: input.applicability,
    form: 'PROBABILITY',
    calibration: input.calibration ?? null,
  });
}

/** Which forecast figure, the quantity it is, and how its cents are named. */
const CASH_FIGURES = {
  revenue: { kind: 'GROSS_BILLED', definition: 'amount billed to the payer per deal, as the cash forecast states it' },
  contribution: { kind: 'NET_CONTRIBUTION', definition: 'payments less refunds, costs and amounts owed per deal, as the cash forecast states it' },
  upfrontCash: { kind: 'OTHER', definition: 'the most cash out at once before a deal pays, as the cash forecast states it' },
} as const satisfies Record<string, { kind: QuantityKind; definition: string }>;
export type CashFigureName = keyof typeof CASH_FIGURES;

/** The part of a cash forecast's estimate provenance needs (structurally `cash/forecast.ts Estimate`). */
export interface CashEstimate {
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  fromRows: number;
  basis: string;
}

/**
 * The provenance of one cash-forecast figure. The forecast derives it from
 * its opportunity rows (the source, with the rows' count), so it is an
 * estimate over those rows; its spread is the uncertainty and the low and high
 * rows are alternative parameterizations. A systematic forecast-vs-realized
 * error on the same comparable bucket adds the corrected alternative and
 * names the correction. A withheld estimate is recorded as unknown.
 */
export function cashFigureProvenance(input: {
  projectId: string;
  currency: string;
  name: CashFigureName;
  estimate: CashEstimate;
  horizon: string;
  retrievedAt: string;
  claimId?: string | null;
  bias?: BiasReading | null;
}): ProvenanceResult {
  const spec = CASH_FIGURES[input.name];
  const est = input.estimate;
  const units = `${input.currency.replace(/[^A-Za-z0-9_]/g, '') || 'currency'}_cents`;
  const source = `cash_forecast:${input.projectId}:${input.currency}:${input.name} (${est.fromRows} opportunity row(s): ${est.basis})`.slice(0, 400);
  const known = est.valueCents !== null && est.fromRows > 0;
  const figure: Figure = {
    meaning: spec.definition,
    unit: units,
    value: known ? est.valueCents : null,
    source: known ? source : null,
    derivedFrom: [],
    status: known ? 'EVIDENCED' : 'UNKNOWN',
    window: input.horizon,
    geography: null,
    scope: `${input.projectId}:${input.currency}`,
    bounds: known && est.lowCents !== null && est.highCents !== null && est.highCents >= est.lowCents ? { low: est.lowCents, high: est.highCents } : null,
    invalidatedBy: ['a change to any opportunity row the forecast read'],
  };
  const alternatives: { label: string; parameters: Record<string, number> }[] = [];
  if (est.lowCents !== null) alternatives.push({ label: 'lowest row in the spread', parameters: { figure: est.lowCents } });
  if (est.highCents !== null) alternatives.push({ label: 'highest row in the spread', parameters: { figure: est.highCents } });
  const correction = input.bias?.verdict === 'SYSTEMATIC' ? input.bias.correction : null;
  if (correction?.kind === 'SCALE_FIGURE' && est.valueCents !== null) {
    alternatives.push({ label: `corrected for realized bias: ${correction.rationale}`.slice(0, 240), parameters: { figure: Math.round(est.valueCents * correction.amount) } });
  }
  if (alternatives.length === 0) alternatives.push({ label: 'no spread stated: unknown', parameters: {} });
  const evidence = [source, ...(input.claimId ? [`ledger claim ${input.claimId}`] : [])];
  if (input.bias && input.bias.verdict !== 'INSUFFICIENT') evidence.push(`forecast vs realized on ${input.bias.comparableKey}: ${input.bias.verdict} over ${input.bias.n} outcome(s)`);
  return buildNumberProvenance({
    key: `cash:${input.projectId}:${input.currency}:${input.name}`,
    quantity: { kind: spec.kind, definition: spec.definition },
    units,
    horizon: input.horizon,
    formula: { ref: 'figure' },
    inputs: [{ key: 'figure', figure, source: { ref: source, retrievedAt: input.retrievedAt } }],
    alternatives,
    interdependence: [
      `revenue, contribution and cash out are read from the same ${est.fromRows} opportunity row(s) and move together`,
      ...(input.name === 'contribution' ? ['contribution = revenue − refunds − costs − owed (money.ts contributionFrom)'] : []),
    ],
    applicability: { method: 'cash-flow identities over sourced opportunity rows', evidence },
    form: 'ESTIMATE',
  });
}

/**
 * The method selection for a cash-forecast question, judged from what the
 * ledger actually holds: cash-flow identities fit when opportunity rows state
 * the figure; calibration fits only with enough realized outcomes on the
 * comparable bucket; forecast-error correction fits only when a bias reading
 * says the error is systematic.
 */
export function selectCashMathematics(input: {
  projectId: string;
  currency: string;
  estimate: CashEstimate;
  name: CashFigureName;
  bias: BiasReading | null;
}): MathSelection {
  const rowsRef = `cash_forecast:${input.projectId}:${input.currency}:${input.name}`;
  const biasRef = input.bias ? `ledger:${input.bias.comparableKey}:${input.bias.basis}` : null;
  const n = input.bias?.n ?? 0;
  return selectMathematics({
    question: `What ${input.name} will a ${input.currency} deal produce, and how far can the stated figure be trusted?`,
    subject: `${input.projectId}:${input.currency}:${input.name}`,
    candidates: [
      {
        family: 'cash_flow_identities',
        purpose: 'state the figure exactly from the amounts the opportunity rows carry',
        preconditions: [
          input.estimate.fromRows > 0 && input.estimate.valueCents !== null
            ? { condition: 'opportunity rows state the amounts', state: 'HOLDS', evidence: [rowsRef] }
            : { condition: 'opportunity rows state the amounts', state: 'FAILS', evidence: [rowsRef] },
        ],
      },
      {
        family: 'statistical_estimation_calibration',
        purpose: 'judge the stated range against realized deals',
        preconditions: [
          biasRef === null
            ? { condition: `at least ${MIN_CALIBRATION_SAMPLE} realized outcomes on the comparable bucket`, state: 'UNKNOWN', evidence: [] }
            : { condition: `at least ${MIN_CALIBRATION_SAMPLE} realized outcomes on the comparable bucket`, state: n >= MIN_CALIBRATION_SAMPLE ? 'HOLDS' : 'FAILS', evidence: [`${biasRef} n=${n}`] },
        ],
      },
      {
        family: 'forecasting_state_estimation',
        purpose: 'correct the figure for systematic forecast error',
        preconditions: [
          biasRef === null || input.bias!.verdict === 'INSUFFICIENT'
            ? { condition: 'a systematic forecast-vs-realized error is measured', state: 'UNKNOWN', evidence: [] }
            : { condition: 'a systematic forecast-vs-realized error is measured', state: input.bias!.verdict === 'SYSTEMATIC' ? 'HOLDS' : 'FAILS', evidence: [`${biasRef} ${input.bias!.verdict}`] },
        ],
      },
    ],
  });
}

/** Record a forecast-vs-realized reading (only readings with enough outcomes to say anything). */
export async function recordForecastBias(reading: BiasReading, deps: MathRecordDeps = {}): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: BIAS_EVENT,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'math-toolkit',
    outcome: reading.verdict,
    reason: `${reading.comparableKey} (${reading.basis}): bias ${reading.bias ?? 'unknown'} over ${reading.n}${reading.correction ? `; correction ${reading.correction.kind} ${reading.correction.amount}` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { bias: reading },
  });
}

export interface CashProvenanceReport {
  provenance: number;
  refused: string[];
  selections: number;
  biasReadings: number;
  systematic: number;
}

/**
 * The cash ledger's production consumer of the toolkit, run on every refresh
 * that wrote something new (`ledger.ts keepCashLedger`): forecast-vs-realized
 * bias over this project's ledger, then for each forecast figure that was
 * recorded as a new version its method selection and its provenance —
 * carrying the correction when the error is systematic. Readings that cannot
 * say anything (too few outcomes) are not recorded; a refused provenance is
 * named, never forced through.
 */
export async function keepCashNumberProvenance(input: {
  projectId: string;
  forecasts: readonly { currency: string; horizon: string; figures: readonly { name: CashFigureName; estimate: CashEstimate; claimId: string | null }[] }[];
  ledger: { predictions: readonly PredictionRow[]; exposures: readonly ExposureRow[]; outcomes: readonly OutcomeRow[] };
  /** Whether any outcome was recorded on this refresh: the bias is re-read only when it could have moved. */
  newOutcomes: boolean;
  retrievedAt: string;
}, deps: MathRecordDeps = {}): Promise<CashProvenanceReport> {
  const scoped: MathRecordDeps = { ...deps, projectId: input.projectId, caller: deps.caller ?? 'cash-ledger' };
  const readings = forecastBias(input.ledger.predictions, input.ledger.exposures, input.ledger.outcomes);
  const report: CashProvenanceReport = { provenance: 0, refused: [], selections: 0, biasReadings: 0, systematic: 0 };
  const anyNew = input.forecasts.some((f) => f.figures.length > 0);
  if (input.newOutcomes || anyNew) {
    for (const r of readings) {
      if (r.verdict === 'INSUFFICIENT') continue;
      await recordForecastBias(r, scoped);
      report.biasReadings += 1;
      if (r.verdict === 'SYSTEMATIC') report.systematic += 1;
    }
  }
  const figureBias = (currency: string, name: CashFigureName): BiasReading | null =>
    readings.find((r) => r.basis === 'FIGURE' && r.comparableKey === `cash:${currency}:${name}`) ?? null;
  for (const f of input.forecasts) {
    for (const fig of f.figures) {
      const bias = figureBias(f.currency, fig.name);
      await recordMathSelection(selectCashMathematics({ projectId: input.projectId, currency: f.currency, estimate: fig.estimate, name: fig.name, bias }), scoped);
      report.selections += 1;
      const built = cashFigureProvenance({ projectId: input.projectId, currency: f.currency, name: fig.name, estimate: fig.estimate, horizon: f.horizon, retrievedAt: input.retrievedAt, claimId: fig.claimId, bias });
      if (!built.ok) {
        report.refused.push(`${f.currency}:${fig.name}: ${[...built.missing.map((m) => `missing ${m}`), ...built.problems].join('; ')}`.slice(0, 300));
        continue;
      }
      await recordNumberProvenance(built.record, scoped);
      report.provenance += 1;
    }
  }
  return report;
}
