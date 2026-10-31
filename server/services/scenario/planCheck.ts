/**
 * A quantitative plan, checked before anybody is shown it.
 *
 * On 2026-10-31 a plan was presented to the owner as roughly 90% likely to
 * reach $10,000 in settled cash. Every expression in it was arithmetic somebody
 * could do, and the expressions did not agree with each other:
 *
 *   * 4,000 contacts × 3% interested × 20% closing is 24 sales, and the
 *     checkpoint that was supposed to confirm it — 2 sales per 1,000 contacts —
 *     projects 8;
 *   * 23 prepaid packages at $450 collect $10,350, and the delivery promised
 *     for them — four cities, three mailings each, about $1,300 a mailing — is
 *     $15,600 that had not been put anywhere;
 *   * and "about 90%" came from no model at all.
 *
 * That is not an arithmetic error. Each figure was worked out on its own and
 * the plan was assembled from them, so nothing forced one figure to answer to
 * another. The remedy is that a plan is not a sentence with numbers in it: it
 * is a scenario model (`domain/scenario.ts`, the engine every other
 * quantitative question in this Brain already uses) plus the few things a model
 * alone cannot say — which quantity the goal reads, what the plan has promised
 * to deliver, the checkpoints it will be judged at, and the narrative a person
 * will read. This module evaluates all of it from one set of inputs and refuses
 * anything that does not reconcile.
 *
 * What it enforces, each as a named problem a reader can act on:
 *
 *   1. The model compiles and **every expression's units agree** with what it
 *      is declared to produce (`units.ts`). A cost per mailing times a number
 *      of cities is a unit error, not a number.
 *   2. Every sampled input is **stated at the point the plan quotes**. A plan's
 *      figures are figures *at some values of its unknowns*; leaving them
 *      implicit is how two figures come to assume different conversion rates.
 *   3. **Whole things are whole.** A plan cannot sell 23.4 packages.
 *   4. **Capacity bounds hold**: what is sold is at most what can be delivered,
 *      contacted, printed or staffed, per place where that is the constraint.
 *   5. **An obligation is costed and carried.** Revenue a buyer prepays creates
 *      a delivery the plan owes; the plan must name the cost of it, a money line
 *      must charge it, and the plan's capital exposure must depend on it. A
 *      prepaid figure whose delivery is in nobody's arithmetic is refused.
 *   6. **The goal's limits hold at the quoted point**: the outcome reaches the
 *      target in the goal's own unit, peak exposure is under the capital
 *      ceiling, spending before the first payment is under its ceiling, and the
 *      outcome lands before the deadline (settlement included, because the
 *      outcome's own timing role must say when the money *settles*).
 *   7. **A checkpoint supports the plan.** A checkpoint rate below the rate the
 *      plan itself needs passes a plan that is on course to fail. It is refused
 *      with what the checkpoint would project.
 *   8. **A probability is computed, never stated.** A plan may quote a chance
 *      only when the engine can produce one — every sampled input carries a
 *      sourced distribution, so the run is Monte Carlo rather than a sweep —
 *      and only the chance the engine computed, for the plan's own outcome,
 *      target and limits. A sweep's share is coverage of tested ranges and is
 *      reported as that.
 *   9. **The narrative may not say a number the model did not produce.** Every
 *      number in the text a person reads must equal a figure of this plan at
 *      the precision written ("about" admits rounding; a bare figure does not),
 *      and any chance-of-success wording must match the computed probability.
 *      The narrative is inside the digest, so editing a word after
 *      verification produces a plan that has not been verified.
 *
 * It does not decide whether an input is *true*. That is the evidence gate's
 * (§12) and the goal-plan gate's (`services/goals/plan.ts`). It decides whether
 * the plan's numbers are one plan, and labels each input with the provenance it
 * declared, so a reader can see which figures rest on a source and which on a
 * hope.
 */
import { compileModel, canonicalJson, sha256, ScenarioModelError, type CompiledModel } from './model.ts';
import { draw, Evaluator, resolveBasis, ScenarioRunError } from './engine.ts';
import { identifiers, parse } from './expr.ts';
import { checkExpressionUnit, formatUnit, parseUnit, sameUnit, unitOfExpression, type Unit } from './units.ts';
import type { ScenarioModelDefinition, VariableProvenance } from '../../domain/scenario.ts';

export const PLAN_METRICS = ['SETTLED_CASH', 'COLLECTED_CASH', 'CONTRIBUTION', 'QUANTITY'] as const;
export type PlanMetric = (typeof PLAN_METRICS)[number];

export interface QuantitativePlan {
  version: 1;
  title: string;
  /**
   * `REACHES_TARGET` (default) asserts the plan reaches its goal at the quoted
   * point and is refused if it does not. `ANALYSIS` presents figures about a
   * plan that may not reach it — still reconciled, never called a plan to run.
   */
  claim?: 'REACHES_TARGET' | 'ANALYSIS';
  goal: {
    metric: PlanMetric;
    target: number;
    /** The unit the target is in — the model currency for a cash metric. */
    unit: string;
    deadlineDays?: number;
    capitalCeiling?: number;
    preFirstPaymentCeiling?: number;
    goalId?: string;
  };
  model: ScenarioModelDefinition;
  /** Which strategy of the model this plan is. */
  strategy: string;
  /** The value of every sampled input at which the plan's figures are stated. */
  point?: Record<string, number | string>;
  roles: {
    /** The derived quantity the goal reads. */
    outcome: string;
    /** Days until the outcome is *settled*, not merely sold. */
    daysToOutcome?: string;
    /** The most owner money committed at once, obligations included. */
    peakExposure?: string;
    /** What is spent before the first customer payment arrives. */
    preFirstPaymentSpend?: string;
  };
  /** Derived quantities that are counts of whole things. */
  integers?: string[];
  /** Capacity: `quantity` may not exceed `atMost` (both derived or variable keys). */
  bounds?: { label: string; quantity: string; atMost: string }[];
  /** What prepaid revenue commits the owner to deliver, and what it costs. */
  obligations?: { label: string; revenueLine: string; costLine: string; costDerived: string }[];
  /** The plan passes the checkpoint when numerator / denominator ≥ atLeast. */
  checkpoints?: { label: string; numerator: string; denominator: string; atLeast: { numerator: number; denominator: number } }[];
  /** A chance of reaching the outcome. Admitted only as computed. */
  probability?: { value: number; outcome: string };
  /** What the owner reads. Every number in it must be one of this plan's. */
  narrative: string;
}

export const PLAN_PROBLEMS = [
  'MALFORMED',
  'MODEL_INVALID',
  'UNIT_MISMATCH',
  'UNKNOWN_KEY',
  'POINT_NOT_STATED',
  'POINT_OUTSIDE_RANGE',
  'INVALID_EVALUATION',
  'NOT_INTEGER',
  'BOUND_EXCEEDED',
  'CONSTRAINT_VIOLATED',
  'OUTCOME_UNIT',
  'TARGET_NOT_REACHED',
  'CAPITAL_CEILING',
  'PRE_PAYMENT_CEILING',
  'DEADLINE',
  'LIMIT_NOT_MODELLED',
  'OBLIGATION_UNCOSTED',
  'NEGATIVE_CONTRIBUTION',
  'OBLIGATION_NOT_IN_EXPOSURE',
  'CHECKPOINT_TOO_LOW',
  'PROBABILITY_UNSUPPORTED',
  'PROBABILITY_MISMATCH',
  'NARRATIVE_UNVERIFIED_NUMBER',
  'NARRATIVE_UNVERIFIED_PROBABILITY',
  'EVIDENCE_WITHOUT_SOURCE',
] as const;
export type PlanProblemCode = (typeof PLAN_PROBLEMS)[number];

export interface PlanProblem {
  code: PlanProblemCode;
  message: string;
}

export interface PlanFigure {
  key: string;
  label: string;
  unit: string;
  value: number;
  /** For an input: what it declared it is. Derived figures inherit nothing. */
  provenance: VariableProvenance | 'DERIVED' | 'MONEY_LINE' | 'GOAL' | 'CHECKPOINT' | 'COMPUTED';
}

export interface PlanCheck {
  verdict: 'VERIFIED' | 'VERIFIED_ANALYSIS' | 'REJECTED';
  digest: string;
  title: string;
  problems: PlanProblem[];
  figures: PlanFigure[];
  /** Over the tested conditions: how often the outcome is met inside every limit. */
  sweep: { basis: 'MONTE_CARLO' | 'SWEEP'; scenarios: number; goalMetShare: number } | null;
  /** The engine's own chance, only when the run is Monte Carlo. */
  probability: number | null;
  /** Which inputs rest on what. */
  provenance: Record<string, string[]>;
  narrative: string;
}

const SWEEP_SCENARIOS = 4_000;
const PROBABILITY_SCENARIOS = 20_000;
const PROBABILITY_TOLERANCE = 0.01;

/** Units whose quantities are counts of whole things. Declared by the plan, too. */
const COUNT_UNITS = new Set(['contact', 'contacts', 'customer', 'customers', 'package', 'packages', 'mailing', 'mailings', 'city', 'cities', 'sale', 'sales', 'unit', 'units', 'piece', 'pieces', 'spot', 'spots', 'job', 'jobs', 'reply', 'replies', 'install', 'installs', 'order', 'orders', 'person', 'people', 'card', 'cards', 'home', 'homes']);

function problem(code: PlanProblemCode, message: string): PlanProblem {
  return { code, message };
}

/** The digest a verified plan is published under. The narrative is inside it. */
export function planDigest(plan: unknown): string {
  return sha256(canonicalJson(plan));
}

export function checkPlan(input: unknown): PlanCheck {
  const problems: PlanProblem[] = [];
  const plan = input as QuantitativePlan;
  const digest = planDigest(input);
  const empty = (verdict: PlanCheck['verdict'] = 'REJECTED'): PlanCheck => ({
    verdict, digest, title: typeof plan?.title === 'string' ? plan.title : '', problems, figures: [], sweep: null, probability: null, provenance: {}, narrative: typeof plan?.narrative === 'string' ? plan.narrative : '',
  });

  if (!plan || typeof plan !== 'object' || plan.version !== 1) {
    problems.push(problem('MALFORMED', 'A plan is an object with version 1.'));
    return empty();
  }
  if (typeof plan.narrative !== 'string' || plan.narrative.trim() === '') problems.push(problem('MALFORMED', 'A plan must carry the narrative a person will read.'));
  if (!plan.goal || !PLAN_METRICS.includes(plan.goal.metric) || !Number.isFinite(plan.goal.target) || typeof plan.goal.unit !== 'string') {
    problems.push(problem('MALFORMED', 'A plan names its goal: a metric, a finite target and the target’s unit.'));
  }
  if (!plan.roles || typeof plan.roles.outcome !== 'string') problems.push(problem('MALFORMED', 'A plan names the derived quantity its goal reads (roles.outcome).'));
  for (const [name, value] of Object.entries({ deadlineDays: plan.goal?.deadlineDays, capitalCeiling: plan.goal?.capitalCeiling, preFirstPaymentCeiling: plan.goal?.preFirstPaymentCeiling })) {
    if (value !== undefined && (!Number.isFinite(value) || (value as number) < 0)) problems.push(problem('MALFORMED', `goal.${name} must be a non-negative finite number when given.`));
  }
  const listOf = (name: string, value: unknown, fields: string[]): void => {
    if (value === undefined) return;
    if (!Array.isArray(value)) { problems.push(problem('MALFORMED', `${name} must be a list.`)); return; }
    value.forEach((item, i) => {
      if (fields.length === 0) {
        if (typeof item !== 'string') problems.push(problem('MALFORMED', `${name}[${i}] must be a key.`));
        return;
      }
      if (!item || typeof item !== 'object') { problems.push(problem('MALFORMED', `${name}[${i}] must be an object.`)); return; }
      for (const f of fields) if (typeof (item as Record<string, unknown>)[f] !== 'string') problems.push(problem('MALFORMED', `${name}[${i}].${f} must be a string.`));
    });
  };
  listOf('integers', plan.integers, []);
  listOf('bounds', plan.bounds, ['label', 'quantity', 'atMost']);
  listOf('obligations', plan.obligations, ['label', 'revenueLine', 'costLine', 'costDerived']);
  listOf('checkpoints', plan.checkpoints, ['label', 'numerator', 'denominator']);
  for (const [i, c] of (Array.isArray(plan.checkpoints) ? plan.checkpoints : []).entries()) {
    const a = (c as { atLeast?: { numerator?: unknown; denominator?: unknown } } | null)?.atLeast;
    if (!a || typeof a.numerator !== 'number' || typeof a.denominator !== 'number' || !Number.isFinite(a.numerator) || !(a.denominator > 0)) {
      problems.push(problem('MALFORMED', `checkpoints[${i}].atLeast needs a finite numerator and a positive denominator.`));
    }
  }
  if (plan.point !== undefined && (plan.point === null || typeof plan.point !== 'object' || Array.isArray(plan.point))) problems.push(problem('MALFORMED', 'point must be an object of variable values.'));
  if (problems.length > 0) return empty();

  let model: CompiledModel;
  try {
    model = compileModel(plan.model);
  } catch (error) {
    const lines = error instanceof ScenarioModelError ? error.problems : [error instanceof Error ? error.message : String(error)];
    for (const line of lines) problems.push(problem('MODEL_INVALID', line));
    return empty();
  }
  const def = plan.model;
  const currency = def.currency.toLowerCase();

  // ---- Units -------------------------------------------------------------
  const unitByName = new Map<string, Unit>();
  const unitText = new Map<string, string>();
  const declare = (key: string, unit: string, where: string): void => {
    try {
      unitByName.set(key, parseUnit(unit));
      unitText.set(key, unit);
    } catch (error) {
      problems.push(problem('UNIT_MISMATCH', `${where}: ${(error as Error).message}`));
    }
  };
  for (const v of def.variables) {
    if (v.spec.kind === 'CHOICE') continue; // attributes unify with anything
    declare(v.key, v.unit, `variable "${v.key}"`);
  }
  for (const d of def.derived ?? []) declare(d.key, d.unit, `derived "${d.key}"`);
  declare('contribution', def.currency, 'contribution');
  const unitOf = (name: string): Unit | null => unitByName.get(name) ?? null;
  for (const d of def.derived ?? []) {
    const issue = checkExpressionUnit(d.expr, d.unit, unitOf);
    if (issue) problems.push(problem('UNIT_MISMATCH', `derived "${d.key}": ${issue}`));
  }
  for (const line of def.lines) {
    const issue = checkExpressionUnit(line.expr, def.currency, unitOf);
    if (issue) problems.push(problem('UNIT_MISMATCH', `money line "${line.key}" must be in ${def.currency}: ${issue}`));
  }
  for (const m of def.metrics ?? []) {
    const issue = checkExpressionUnit(m.expr, m.unit, unitOf);
    if (issue) problems.push(problem('UNIT_MISMATCH', `metric "${m.key}": ${issue}`));
  }
  for (const c of def.constraints ?? []) {
    try { unitOfExpression(c.expr, unitOf); } catch (error) { problems.push(problem('UNIT_MISMATCH', `constraint "${c.key}": ${(error as Error).message}`)); }
  }

  // ---- Keys the plan names --------------------------------------------------
  const derivedKeys = new Set((def.derived ?? []).map((d) => d.key));
  const variableKeys = new Set(def.variables.map((v) => v.key));
  const lineKeys = new Set(def.lines.map((l) => l.key));
  const quantityKey = (key: string, where: string): boolean => {
    if (derivedKeys.has(key) || variableKeys.has(key) || key === 'contribution') return true;
    problems.push(problem('UNKNOWN_KEY', `${where} names "${key}", which is not a variable or derived quantity of the model.`));
    return false;
  };
  quantityKey(plan.roles.outcome, 'roles.outcome');
  for (const [role, key] of Object.entries(plan.roles)) if (role !== 'outcome' && key !== undefined) quantityKey(key, `roles.${role}`);
  for (const key of plan.integers ?? []) quantityKey(key, 'integers');
  for (const b of plan.bounds ?? []) { quantityKey(b.quantity, `bound "${b.label}"`); quantityKey(b.atMost, `bound "${b.label}"`); }
  for (const c of plan.checkpoints ?? []) { quantityKey(c.numerator, `checkpoint "${c.label}"`); quantityKey(c.denominator, `checkpoint "${c.label}"`); }
  for (const o of plan.obligations ?? []) {
    if (!lineKeys.has(o.revenueLine)) problems.push(problem('UNKNOWN_KEY', `obligation "${o.label}" names revenue line "${o.revenueLine}", which the model does not have.`));
    if (!lineKeys.has(o.costLine)) problems.push(problem('OBLIGATION_UNCOSTED', `obligation "${o.label}": "${o.costLine}" is not a money line, so the delivery owed for "${o.revenueLine}" is charged nowhere.`));
    quantityKey(o.costDerived, `obligation "${o.label}"`);
  }

  // Outcome unit against the goal's.
  try {
    const goalUnit = parseUnit(plan.goal.unit);
    const outcomeUnit = unitByName.get(plan.roles.outcome);
    if (['SETTLED_CASH', 'COLLECTED_CASH', 'CONTRIBUTION'].includes(plan.goal.metric) && plan.goal.unit.toLowerCase() !== currency) {
      problems.push(problem('OUTCOME_UNIT', `A ${plan.goal.metric} goal is in money: its unit must be the model currency ${def.currency}, not ${plan.goal.unit}.`));
    }
    if (outcomeUnit && !sameUnit(outcomeUnit, goalUnit)) {
      problems.push(problem('OUTCOME_UNIT', `The goal is in ${plan.goal.unit} and "${plan.roles.outcome}" is in ${formatUnit(outcomeUnit)}.`));
    }
  } catch (error) {
    problems.push(problem('OUTCOME_UNIT', (error as Error).message));
  }

  // Limits the goal states must be modelled, or they cannot be checked.
  if (plan.goal.capitalCeiling !== undefined && !plan.roles.peakExposure) problems.push(problem('LIMIT_NOT_MODELLED', 'The goal sets a capital ceiling and the plan names no peak exposure to hold to it.'));
  if (plan.goal.preFirstPaymentCeiling !== undefined && !plan.roles.preFirstPaymentSpend) problems.push(problem('LIMIT_NOT_MODELLED', 'The goal limits spending before the first payment and the plan names no such spend.'));
  if (plan.goal.deadlineDays !== undefined && !plan.roles.daysToOutcome) problems.push(problem('LIMIT_NOT_MODELLED', 'The goal has a deadline and the plan does not say when its outcome settles.'));
  if ((plan.obligations ?? []).length > 0 && !plan.roles.peakExposure) problems.push(problem('OBLIGATION_NOT_IN_EXPOSURE', 'The plan owes deliveries and names no exposure that carries them.'));

  // ---- Dependency propagation --------------------------------------------
  const exprOf = new Map<string, string>();
  for (const d of def.derived ?? []) exprOf.set(d.key, d.expr);
  for (const l of def.lines) exprOf.set(`line:${l.key}`, l.expr);
  const depends = (from: string, on: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const key = stack.pop()!;
      if (key === on) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      const expr = exprOf.get(key);
      if (!expr) continue;
      try { for (const id of identifiers(parse(expr))) stack.push(id); } catch { /* compile already reported it */ }
    }
    return false;
  };
  for (const o of plan.obligations ?? []) {
    if (lineKeys.has(o.costLine) && !depends(`line:${o.costLine}`, o.costDerived)) {
      problems.push(problem('OBLIGATION_UNCOSTED', `obligation "${o.label}": money line "${o.costLine}" does not depend on "${o.costDerived}", so what is owed is not what is charged.`));
    }
    if (plan.roles.peakExposure && !depends(plan.roles.peakExposure, o.costDerived)) {
      problems.push(problem('OBLIGATION_NOT_IN_EXPOSURE', `obligation "${o.label}": peak exposure "${plan.roles.peakExposure}" does not depend on "${o.costDerived}", so a delivery the owner must fund is left out of the money at risk.`));
    }
  }

  // ---- The point the plan's figures are stated at --------------------------
  const strategyIndex = model.strategies.findIndex((s) => s.spec.key === plan.strategy);
  if (strategyIndex < 0) {
    problems.push(problem('UNKNOWN_KEY', `The plan names strategy "${plan.strategy}", which the model does not have.`));
    return { ...empty(), figures: [] };
  }
  const point = plan.point ?? {};
  for (const key of Object.keys(point)) {
    if (!variableKeys.has(key)) problems.push(problem('UNKNOWN_KEY', `point names "${key}", which is not a variable of the model.`));
  }
  const values = new Float64Array(model.variables.length);
  for (const cv of model.variables) {
    const s = cv.spec.spec;
    if (cv.spec.controllable) { values[cv.index] = Number.NaN; continue; }
    if (!cv.sampled) { values[cv.index] = s.kind === 'FIXED' ? s.value : Number.NaN; continue; }
    const stated = point[cv.spec.key];
    if (stated === undefined) {
      problems.push(problem('POINT_NOT_STATED', `"${cv.spec.key}" (${cv.spec.provenance}) varies and the plan does not say which value its figures assume.`));
      values[cv.index] = Number.NaN;
      continue;
    }
    if (cv.isChoice) {
      const at = typeof stated === 'string' ? cv.optionKeys.indexOf(stated) : -1;
      if (at < 0) problems.push(problem('POINT_OUTSIDE_RANGE', `"${cv.spec.key}" is a choice; the point must name one of ${cv.optionKeys.join(', ')}.`));
      values[cv.index] = at;
      continue;
    }
    if (typeof stated !== 'number' || !Number.isFinite(stated)) {
      problems.push(problem('POINT_OUTSIDE_RANGE', `"${cv.spec.key}" must be stated as a finite number.`));
      values[cv.index] = Number.NaN;
      continue;
    }
    const lo = 'min' in s ? s.min : s.kind === 'EMPIRICAL' ? Math.min(...s.values) : -Infinity;
    const hi = 'max' in s ? s.max : s.kind === 'EMPIRICAL' ? Math.max(...s.values) : Infinity;
    if (stated < lo || stated > hi) problems.push(problem('POINT_OUTSIDE_RANGE', `"${cv.spec.key}" is stated at ${stated}, outside its own range ${lo}–${hi}.`));
    values[cv.index] = stated;
  }

  const evaluator = new Evaluator(model);
  const evaluation = evaluator.newEvaluation();
  evaluator.fill(values, strategyIndex);
  evaluator.evaluate(evaluation);
  const env = evaluator.env;
  const slotOf = new Map<string, number>();
  for (const cv of model.variables) slotOf.set(cv.spec.key, cv.slot);
  for (const d of model.derived) slotOf.set(d.key, d.slot);
  const at = (key: string): number => (key === 'contribution' ? evaluation.contributionCents / 100 : env[slotOf.get(key) ?? -1] ?? Number.NaN);

  const figures: PlanFigure[] = [];
  for (const cv of model.variables) {
    if (cv.isChoice) continue;
    figures.push({ key: cv.spec.key, label: cv.spec.label, unit: cv.spec.unit, value: env[cv.slot]!, provenance: cv.spec.provenance });
  }
  for (const d of def.derived ?? []) figures.push({ key: d.key, label: d.label, unit: d.unit, value: at(d.key), provenance: 'DERIVED' });
  model.lines.forEach((l, i) => figures.push({ key: `line:${l.key}`, label: l.label, unit: def.currency, value: evaluation.lineCents[i]! / 100, provenance: 'MONEY_LINE' }));
  figures.push({ key: 'contribution', label: 'Contribution (revenue less every cost line)', unit: def.currency, value: evaluation.contributionCents / 100, provenance: 'DERIVED' });
  figures.push({ key: 'goal:target', label: 'Goal target', unit: plan.goal.unit, value: plan.goal.target, provenance: 'GOAL' });
  if (plan.goal.deadlineDays !== undefined) figures.push({ key: 'goal:deadline', label: 'Days to the deadline', unit: 'days', value: plan.goal.deadlineDays, provenance: 'GOAL' });
  if (plan.goal.capitalCeiling !== undefined) figures.push({ key: 'goal:capital', label: 'Capital ceiling', unit: def.currency, value: plan.goal.capitalCeiling, provenance: 'GOAL' });
  if (plan.goal.preFirstPaymentCeiling !== undefined) figures.push({ key: 'goal:prepay', label: 'Spending allowed before the first payment', unit: def.currency, value: plan.goal.preFirstPaymentCeiling, provenance: 'GOAL' });

  const pointStated = !problems.some((p) => p.code === 'POINT_NOT_STATED' || p.code === 'POINT_OUTSIDE_RANGE' || p.code === 'UNKNOWN_KEY');
  if (pointStated) {
    if (!evaluation.valid) problems.push(problem('INVALID_EVALUATION', `At the stated point ${evaluation.invalidReason}.`));
    for (const i of evaluation.violated) {
      const c = model.constraints[i]!;
      problems.push(problem('CONSTRAINT_VIOLATED', `Constraint "${c.label}" (${(def.constraints ?? [])[i]?.expr ?? c.key} ${c.op} ${c.value}) fails at the stated point.`));
    }
    const integers = new Set(plan.integers ?? []);
    for (const d of def.derived ?? []) {
      const u = parseUnitSafe(d.unit);
      if (u && u.size === 1 && [...u.values()][0] === 1 && COUNT_UNITS.has([...u.keys()][0]!)) integers.add(d.key);
    }
    for (const key of integers) {
      const v = at(key);
      if (Number.isFinite(v) && Math.abs(v - Math.round(v)) > 1e-9) problems.push(problem('NOT_INTEGER', `"${key}" is ${round(v, 4)}, a count of whole things that is not whole — use ceil() or floor() in the model to say which way it rounds.`));
    }
    for (const b of plan.bounds ?? []) {
      const q = at(b.quantity);
      const cap = at(b.atMost);
      if (!(q <= cap + 1e-9)) problems.push(problem('BOUND_EXCEEDED', `${b.label}: "${b.quantity}" is ${round(q, 2)} and "${b.atMost}" allows ${round(cap, 2)}.`));
    }
    const outcome = at(plan.roles.outcome);
    const claim = plan.claim ?? 'REACHES_TARGET';
    if (claim === 'REACHES_TARGET' && !(outcome >= plan.goal.target)) {
      problems.push(problem('TARGET_NOT_REACHED', `At the stated point "${plan.roles.outcome}" is ${round(outcome, 2)} ${plan.goal.unit}, short of the ${plan.goal.target} target. A plan that does not reach its goal may be presented only as an ANALYSIS.`));
    }
    if (claim === 'REACHES_TARGET' && ['SETTLED_CASH', 'COLLECTED_CASH'].includes(plan.goal.metric) && evaluation.contributionCents < 0) {
      problems.push(problem('NEGATIVE_CONTRIBUTION', `The plan collects ${round(at(plan.roles.outcome), 2)} ${plan.goal.unit} and its own cost lines come to more: contribution is ${round(evaluation.contributionCents / 100, 2)} ${def.currency}. Cash that has to be paid back out to deliver what it bought is not money reached.`));
    }
    const limit = (role: string | undefined, ceiling: number | undefined, code: PlanProblemCode, words: string): void => {
      if (!role || ceiling === undefined) return;
      const v = at(role);
      if (!(v <= ceiling)) problems.push(problem(code, `${words}: "${role}" is ${round(v, 2)} against a limit of ${ceiling}.`));
    };
    limit(plan.roles.peakExposure, plan.goal.capitalCeiling, 'CAPITAL_CEILING', 'Peak capital exposure exceeds the ceiling');
    limit(plan.roles.preFirstPaymentSpend, plan.goal.preFirstPaymentCeiling, 'PRE_PAYMENT_CEILING', 'Spending before the first payment exceeds its limit');
    limit(plan.roles.daysToOutcome, plan.goal.deadlineDays, 'DEADLINE', 'The outcome settles after the deadline');

    for (const c of plan.checkpoints ?? []) {
      const ratioNeeded = at(c.numerator) / at(c.denominator);
      if (!Number.isFinite(ratioNeeded)) {
        problems.push(problem('INVALID_EVALUATION', `checkpoint "${c.label}": the plan's own ${c.numerator} per ${c.denominator} is not a finite number at the stated point, so the checkpoint cannot be judged.`));
        continue;
      }
      const given = c.atLeast.numerator / c.atLeast.denominator;
      figures.push({ key: `checkpoint:${c.label}:numerator`, label: `${c.label} (passes at)`, unit: unitText.get(c.numerator) ?? '', value: c.atLeast.numerator, provenance: 'CHECKPOINT' });
      figures.push({ key: `checkpoint:${c.label}:denominator`, label: `${c.label} (out of)`, unit: unitText.get(c.denominator) ?? '', value: c.atLeast.denominator, provenance: 'CHECKPOINT' });
      if (!(c.atLeast.denominator > 0) || !Number.isFinite(given)) {
        problems.push(problem('MALFORMED', `checkpoint "${c.label}" needs a positive denominator.`));
        continue;
      }
      const projected = given * at(c.denominator);
      figures.push({ key: `checkpoint:${c.label}:projected`, label: `${c.label}: what passing it projects`, unit: unitText.get(c.numerator) ?? '', value: projected, provenance: 'CHECKPOINT' });
      if (given + 1e-12 < ratioNeeded) {
        problems.push(problem('CHECKPOINT_TOO_LOW', `checkpoint "${c.label}" passes at ${c.atLeast.numerator} per ${c.atLeast.denominator}, which projects ${round(projected, 2)} "${c.numerator}" — the plan needs ${round(at(c.numerator), 2)} (${round(ratioNeeded * c.atLeast.denominator, 3)} per ${c.atLeast.denominator}). A checkpoint that passes a failing plan is refused.`));
      }
    }
  }

  // ---- Inputs and their provenance ------------------------------------------
  const provenance: Record<string, string[]> = {};
  for (const v of def.variables) (provenance[v.provenance] ??= []).push(v.key);
  for (const cv of model.variables) {
    if ((cv.spec.provenance === 'EVIDENCE' || cv.spec.provenance === 'HISTORICAL') && cv.justified && (cv.spec.sources ?? []).length === 0) {
      problems.push(problem('EVIDENCE_WITHOUT_SOURCE', `"${cv.spec.key}" claims ${cv.spec.provenance} and names no source; a distribution with no source is an assumption.`));
    }
  }

  // ---- Over the tested conditions ------------------------------------------
  let sweep: PlanCheck['sweep'] = null;
  let probability: number | null = null;
  const success = (ev: Evaluator, out: ReturnType<Evaluator['newEvaluation']>): boolean => {
    if (!out.valid || out.violated.length > 0) return false;
    const read = (key: string) => (key === 'contribution' ? out.contributionCents / 100 : ev.env[slotOf.get(key) ?? -1] ?? Number.NaN);
    if (!(read(plan.roles.outcome) >= plan.goal.target)) return false;
    if (plan.roles.peakExposure && plan.goal.capitalCeiling !== undefined && !(read(plan.roles.peakExposure) <= plan.goal.capitalCeiling)) return false;
    if (plan.roles.preFirstPaymentSpend && plan.goal.preFirstPaymentCeiling !== undefined && !(read(plan.roles.preFirstPaymentSpend) <= plan.goal.preFirstPaymentCeiling)) return false;
    if (plan.roles.daysToOutcome && plan.goal.deadlineDays !== undefined && !(read(plan.roles.daysToOutcome) <= plan.goal.deadlineDays)) return false;
    for (const b of plan.bounds ?? []) if (!(read(b.quantity) <= read(b.atMost) + 1e-9)) return false;
    return true;
  };
  const share = (scenarios: number, basis: 'MONTE_CARLO' | 'SWEEP'): number => {
    const draws = draw(model, scenarios, 20261031, basis);
    const ev = new Evaluator(model);
    const out = ev.newEvaluation();
    const row = new Float64Array(model.variables.length);
    let met = 0;
    for (let i = 0; i < scenarios; i++) {
      for (let v = 0; v < model.variables.length; v++) row[v] = draws.base[v * scenarios + i]!;
      ev.fill(row, strategyIndex);
      ev.evaluate(out);
      if (success(ev, out)) met++;
    }
    return met / scenarios;
  };
  try {
    const basis = resolveBasis(model, undefined);
    if (model.sampled.length > 0) {
      const scenarios = basis === 'MONTE_CARLO' ? PROBABILITY_SCENARIOS : SWEEP_SCENARIOS;
      const met = share(scenarios, basis);
      sweep = { basis, scenarios, goalMetShare: met };
      if (basis === 'MONTE_CARLO') probability = met;
    } else {
      // Nothing varies: the plan's point is the only world, and the share is 0 or 1 by arithmetic.
      sweep = { basis: 'SWEEP', scenarios: 1, goalMetShare: pointStated && success(evaluator, evaluation) ? 1 : 0 };
    }
  } catch (error) {
    if (!(error instanceof ScenarioRunError)) throw error;
    problems.push(problem('MODEL_INVALID', error.message));
  }
  if (sweep) figures.push({ key: 'computed:goalMetShare', label: sweep.basis === 'MONTE_CARLO' ? 'Computed chance of reaching the goal inside every limit' : 'Share of tested conditions that reach the goal (coverage, not a probability)', unit: '1', value: sweep.goalMetShare, provenance: 'COMPUTED' });

  if (plan.probability !== undefined) {
    const p = plan.probability;
    if (!p || typeof p.value !== 'number' || p.value < 0 || p.value > 1) {
      problems.push(problem('MALFORMED', 'probability.value is a fraction between 0 and 1.'));
    } else if (p.outcome !== plan.roles.outcome) {
      problems.push(problem('PROBABILITY_MISMATCH', `The probability is about "${p.outcome}" and the goal reads "${plan.roles.outcome}": a chance of something else is not a chance of this.`));
    } else if (probability === null) {
      problems.push(problem('PROBABILITY_UNSUPPORTED', `A chance of ${round(p.value * 100, 1)}% is stated and the engine cannot compute one: ${model.justified ? 'nothing in the model varies' : `inputs without a sourced distribution — ${model.unjustified.join('; ').replace(/ a (ASSUMPTION|UNKNOWN|HYPOTHETICAL|EVIDENCE|HISTORICAL)/g, ' an $1')}`}. Over the tested ranges the goal was met in ${sweep ? round(sweep.goalMetShare * 100, 1) : 0}% of conditions, which is coverage, not a probability.`));
    } else if (Math.abs(p.value - probability) > PROBABILITY_TOLERANCE || p.value > probability + 1e-9 + PROBABILITY_TOLERANCE / 2) {
      problems.push(problem('PROBABILITY_MISMATCH', `The plan states ${round(p.value * 100, 1)}% and the model computes ${round(probability * 100, 1)}%.`));
    } else {
      figures.push({ key: 'probability', label: 'Stated chance (as computed)', unit: '1', value: p.value, provenance: 'COMPUTED' });
    }
  }

  // ---- The narrative ---------------------------------------------------
  if (typeof plan.narrative === 'string') {
    for (const issue of narrativeProblems(plan.narrative, figures, plan.probability && problems.every((x) => x.code !== 'PROBABILITY_UNSUPPORTED' && x.code !== 'PROBABILITY_MISMATCH') ? plan.probability.value : null)) {
      problems.push(issue);
    }
  }

  const claim = plan.claim ?? 'REACHES_TARGET';
  const verdict: PlanCheck['verdict'] = problems.length > 0 ? 'REJECTED' : claim === 'ANALYSIS' ? 'VERIFIED_ANALYSIS' : 'VERIFIED';
  return { verdict, digest, title: plan.title, problems, figures, sweep, probability, provenance, narrative: plan.narrative };
}

function parseUnitSafe(unit: string): Unit | null {
  try { return parseUnit(unit); } catch { return null; }
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------------------
// Numbers in prose
// ---------------------------------------------------------------------------

const MONTHS = /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;
const APPROX = /(about|approximately|approx\.?|around|roughly|nearly|~|≈|some)\s*\$?$/i;
/** After a percentage: "90% chance", "90% likely", "a 90% probability". */
const CHANCE_AFTER = /^\s*(chance|probabilit|likel|odds\b|likelihood)/i;
/** Before a percentage: "the chance of success is 90%", "odds of 90%". */
const CHANCE_BEFORE = /(chance|probability|odds|likelihood)\s+(of\s+\w+(\s+\w+)?\s+)?(is|are|of|at|about|around|roughly|near|=)?\s*(about|around|roughly|approximately|~)?\s*$/i;

export interface NarrativeNumber {
  text: string;
  value: number;
  /** Decimal places written. */
  places: number;
  scale: 'NONE' | 'THOUSAND' | 'MILLION' | 'PERCENT';
  approximate: boolean;
  /** The number is a chance of success. */
  chance: boolean;
}

/** Every number a person would read as a quantity. Dates are not quantities here. */
export function numbersIn(text: string): NarrativeNumber[] {
  const found: NarrativeNumber[] = [];
  const pattern = /(?<![A-Za-z0-9_./])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*(%|percent\b|k\b|K\b|m\b|M\b|million\b|thousand\b))?(?![A-Za-z0-9_])/g;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 16), start);
    const after = text.slice(start + m[0].length, start + m[0].length + 40);
    if (MONTHS.test(before)) continue; // "Nov 25"
    if (/\d{4}-\d{2}-\d{2}/.test(text.slice(Math.max(0, start - 8), start + m[0].length + 6))) continue; // an ISO date
    if (/^(st|nd|rd|th)\b/i.test(after)) continue; // an ordinal
    const whole = Number(m[2]!.replace(/,/g, ''));
    const frac = m[3] ? Number(m[3]) : 0;
    const word = (m[5] ?? '').toLowerCase();
    const scale: NarrativeNumber['scale'] = word === '%' || word === 'percent' ? 'PERCENT' : word === 'k' || word === 'thousand' ? 'THOUSAND' : word === 'm' || word === 'million' ? 'MILLION' : 'NONE';
    const chanceContext = scale === 'PERCENT' && (CHANCE_AFTER.test(after) || CHANCE_BEFORE.test(text.slice(Math.max(0, start - 40), start)));
    found.push({ text: m[0].trim(), value: whole + frac, places: m[3] ? m[3].length - 1 : 0, scale, approximate: APPROX.test(before), chance: chanceContext });
  }
  // Spelled-out numbers are numbers: "ninety percent likely" is a probability
  // claim whether or not it was written in digits.
  const words = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})(?:[- ](${ONES.join('|')}))?\\b(\\s*(%|percent\\b|thousand\\b|million\\b))?`, 'gi');
  for (const m of text.matchAll(words)) {
    const start = m.index ?? 0;
    const first = NUMBER_WORDS[m[1]!.toLowerCase()]!;
    const second = m[2] ? NUMBER_WORDS[m[2].toLowerCase()]! : 0;
    if (m[2] && first < 20) continue; // "one three" is not a number
    const word = (m[4] ?? '').toLowerCase();
    const scale: NarrativeNumber['scale'] = word === '%' || word === 'percent' ? 'PERCENT' : word === 'thousand' ? 'THOUSAND' : word === 'million' ? 'MILLION' : 'NONE';
    const before = text.slice(Math.max(0, start - 16), start);
    const after = text.slice(start + m[0].length, start + m[0].length + 40);
        // A spelled-out number is checked only when it is a chance of success:
    // "one city" and "a hundred ways" are ordinary prose, "ninety percent
    // likely" is a probability claim in other spelling.
    const chance = scale === 'PERCENT' && (CHANCE_AFTER.test(after) || CHANCE_BEFORE.test(text.slice(Math.max(0, start - 40), start)));
    if (!chance) continue;
    void before;
    found.push({ text: m[0].trim(), value: first + second, places: 0, scale, approximate: APPROX.test(before), chance });
  }
  return found;
}

const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/**
 * Wording that claims a likelihood without a number: "almost certain",
 * "nine in ten", "guaranteed". A plan with no computed probability may not
 * use it, because it is the same claim in other words.
 */
const SUCCESS = '(to\\s+)?(work|succeed|success|reach|hit|make|earn|pay\\s+off|close|fill|sell\\s+out|win|get\\s+(you|us|there)|the\\s+(goal|target)|\\$)';
const CHANCE_WORDING = new RegExp(
  [
    // "guaranteed to work", "a guaranteed $10k", "guarantees results"
    `\\bguarantee[sd]?\\s+(you\\s+|that\\s+(you|we|it|this)\\s+(will|'ll)\\s+)?${SUCCESS}`,
    `\\bguaranteed\\s+(results|income|revenue|profit|returns?)`,
    // "almost certain to reach", "very likely to work"
    `\\b(almost|nearly|near|virtually)[- ]certain(ly)?\\s+${SUCCESS}`,
    `\\b(very|highly|extremely)\\s+likely\\s+${SUCCESS}`,
    `\\bhigh\\s+(probability|chance|likelihood)\\s+(of|that)\\b`,
    `\\b(safe\\s+bet|can'?t\\s+miss|sure\\s+thing)\\b`,
    // "nine in ten", "9 out of 10" — a number, not "back in 10 minutes"
    `\\b(one|two|three|four|five|six|seven|eight|nine|\\d{1,2})\\s+(in|out\\s+of)\\s+(ten|10)\\b(\\s+\\w+)?\\s+(will|would|should|could|can|are\\s+likely)\\b`,
  ].join('|'),
  'i',
);

function matches(n: NarrativeNumber, candidate: number): boolean {
  if (!Number.isFinite(candidate)) return false;
  const scaled = n.scale === 'THOUSAND' ? candidate / 1_000 : n.scale === 'MILLION' ? candidate / 1_000_000 : n.scale === 'PERCENT' ? candidate * 100 : candidate;
  const forms = [Math.abs(scaled)];
  for (const v of forms) {
    if (round(Math.abs(v), n.places) === n.value) return true;
    if (n.approximate && n.places === 0 && n.value !== 0) {
      // "about 4,000": the trailing zeros say what precision the number is written to.
      let zeros = 0;
      let x = n.value;
      while (x % 10 === 0 && x > 0) { zeros++; x /= 10; }
      const step = 10 ** Math.max(zeros, 0);
      if (Math.round(Math.abs(v) / step) * step === n.value) return true;
      if (zeros === 0 && Math.round(Math.abs(v)) === n.value) return true;
    }
  }
  return false;
}

export function narrativeProblems(text: string, figures: PlanFigure[], verifiedProbability: number | null): PlanProblem[] {
  const out: PlanProblem[] = [];
  const wording = CHANCE_WORDING.exec(text);
  if (wording && verifiedProbability === null) {
    out.push(problem('NARRATIVE_UNVERIFIED_PROBABILITY', `The narrative says "${wording[0]}", a claim about the chance of success, and the plan has no computed probability.`));
  }
  for (const n of numbersIn(text)) {
    if (n.chance) {
      if (verifiedProbability === null || !matches(n, verifiedProbability)) {
        out.push(problem('NARRATIVE_UNVERIFIED_PROBABILITY', `The narrative says "${n.text}" about a chance of success, and ${verifiedProbability === null ? 'the plan has no computed probability' : `the computed probability is ${round(verifiedProbability * 100, 1)}%`}.`));
      }
      continue;
    }
    if (!figures.some((f) => matches(n, f.value))) {
      out.push(problem('NARRATIVE_UNVERIFIED_NUMBER', `The narrative says "${n.text}", which is not a figure of this plan at the precision written.`));
    }
  }
  return out;
}

/**
 * A chance-of-success claim in text that carries no checked plan.
 *
 * Every surface that shows a person model-written prose — a Russell turn, a
 * worker's report — calls this. A conversation may talk about numbers; it may
 * not tell somebody how likely a plan is to work, because the only place a
 * chance is computed is `checkPlan` (or, for Brain's own goal plans, the
 * measured record in `services/goals/plan.ts`), and prose is neither.
 */
export function unverifiedChanceClaims(text: string): PlanProblem[] {
  return narrativeProblems(text, [], null).filter((p) => p.code === 'NARRATIVE_UNVERIFIED_PROBABILITY');
}

/** The text a person may be shown for a check, and nothing else. */
export function renderCheck(check: PlanCheck): string {
  const lines: string[] = [];
  lines.push(`PLAN: ${check.verdict} ${check.digest}`);
  lines.push(`title: ${check.title}`);
  if (check.problems.length > 0) {
    lines.push(`problems (${check.problems.length}) — nothing below may be presented as a verified conclusion:`);
    for (const p of check.problems) lines.push(`  ${p.code}: ${p.message}`);
  }
  lines.push('figures at the stated point:');
  for (const f of check.figures) lines.push(`  ${f.key} = ${round(f.value, 4)} ${f.unit}  [${f.provenance}]`);
  if (check.sweep) lines.push(`tested conditions: ${check.sweep.scenarios} (${check.sweep.basis}); goal met inside every limit in ${round(check.sweep.goalMetShare * 100, 1)}%${check.sweep.basis === 'SWEEP' ? ' — coverage of the tested ranges, NOT a probability' : ''}`);
  lines.push(`inputs by provenance: ${Object.entries(check.provenance).map(([k, v]) => `${k}=${v.join(',')}`).join('  ')}`);
  if (check.verdict !== 'REJECTED') {
    lines.push('--- narrative (verified with this digest; any edit needs a new check) ---');
    lines.push(check.narrative);
  }
  return lines.join('\n');
}
