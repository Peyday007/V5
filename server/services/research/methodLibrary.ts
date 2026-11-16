/**
 * The method library: which way of reasoning fits a problem, judged per case
 * and learned from what happened (META-18-2, layer 3).
 *
 * `method.ts` tells a research worker how to research and `methodRules.ts`
 * hands it what Brain has researched about researching. Neither decides, for
 * one problem, *which* analytical method, experiment, decomposition, analogy,
 * optimization technique, research method or tool to use, nor learns from the
 * results whether that choice was any good. This module does, and nothing else:
 *
 *   * a **catalogue** of methods, open and extensible. The seed entries are
 *     illustrative so a first judgment is not empty; a method outside them is
 *     declared with a reason and is then selectable like any other (R01-A1:
 *     no category is a whitelist). A declared or derived method starts
 *     UNVERIFIED and earns VERIFIED only from results on cases other than the
 *     one it was made for.
 *   * a **fitness judgment** per method per problem, from the problem's own
 *     evidenced features and the method's recorded track record in comparable
 *     problems. There is no fixed rule: a feature nobody evidenced counts for
 *     less than one a source supports, and the reasons are kept with the
 *     judgment (approved reading of S-0195).
 *   * **comparison** of competing methods, best first, with what separates them.
 *   * **weak-inference detection** over a reasoning chain, returned as typed
 *     findings rather than prose.
 *   * **procedure learning** from recorded successes and errors.
 *   * **capability-gap diagnosis**: when a domain is reasoned about badly, it
 *     names the methodological capability that is absent and proposes how to
 *     obtain or derive it, how to verify it, and which other domains it should
 *     then be applied to — never "collect more facts about this domain".
 *
 * Storage: none of its own. Judgments, outcomes, procedures and gaps are rows
 * appended through the existing `recordBinEvent` writer (`bin_events`), the
 * same one the forecast ledger uses, and read back from there (§10.3). It
 * owns no schedule, queue or authority path; the reasoning controller calls it.
 */
import { getDb } from '../../db/database.ts';
import type { SqlParam } from '../../db/types.ts';
import { recordBinEvent } from '../../repos/bins.ts';

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * What kind of reasoning a method is. Open: the seed kinds name the families
 * the specification lists; another is a string declared with its method.
 */
export const SEED_METHOD_KINDS = [
  'ANALYTICAL',
  'EXPERIMENT',
  'DECOMPOSITION',
  'ANALOGY',
  'OPTIMIZATION',
  'RESEARCH',
  'TOOL',
] as const;
export type MethodKind = (typeof SEED_METHOD_KINDS)[number] | (string & {});

export type MethodStatus = 'ESTABLISHED' | 'UNVERIFIED' | 'VERIFIED' | 'RETIRED';

export interface MethodSpec {
  id: string;
  name: string;
  kind: MethodKind;
  /** What it answers, in one sentence. */
  purpose: string;
  /** Problem features it is built for. A match is evidence of fit, never a gate. */
  fitsWhen: string[];
  /** Problem features under which it misleads. */
  misleadsWhen: string[];
  /** Inputs it cannot run without. A missing one makes the judgment PARTIAL, not a refusal. */
  requires: string[];
  status: MethodStatus;
  /** Why a non-seed method exists. Null only for the seed catalogue. */
  declaredReason: string | null;
  /** The domain a derived method was made for; verification must come from elsewhere. */
  derivedFor: string | null;
}

/** A feature of a problem and what supports it. Without a source it is an assertion. */
export interface ProblemFeature {
  feature: string;
  source: string | null;
}

export interface ProblemProfile {
  id: string;
  domain: string;
  question: string;
  features: ProblemFeature[];
  /** Inputs actually available for this problem. */
  available: string[];
}

/** One application of one method to one problem, and what came of it. */
export interface MethodOutcome {
  methodId: string;
  problemId: string;
  domain: string;
  features: string[];
  succeeded: boolean;
  /** A short class of what went wrong, when it did ("misattributed-risk", "timing-overrun"). */
  errorClass: string | null;
  at: string;
}

/* ------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* ------------------------------------------------------------------------- */

const seed = (
  id: string,
  name: string,
  kind: MethodKind,
  purpose: string,
  fitsWhen: string[],
  misleadsWhen: string[],
  requires: string[],
): MethodSpec => ({ id, name, kind, purpose, fitsWhen, misleadsWhen, requires, status: 'ESTABLISHED', declaredReason: null, derivedFor: null });

/**
 * Illustrative seed entries — a starting vocabulary so a first judgment has
 * something to judge, never the set of methods Brain may use.
 */
export const SEED_METHODS: readonly MethodSpec[] = Object.freeze([
  seed('bayesian-update', 'Bayesian updating', 'ANALYTICAL', 'Revise a probability as observations arrive.', ['uncertain-quantity', 'has-observations', 'prior-available'], ['no-observations'], ['observations']),
  seed('reference-class', 'Reference-class forecasting', 'ANALOGY', 'Estimate from the outcomes of comparable cases.', ['uncertain-quantity', 'comparables-exist'], ['novel-domain'], ['comparables']),
  seed('mechanism-decomposition', 'Mechanism decomposition', 'DECOMPOSITION', 'Break a transaction into who acts, what flows, and what can fail.', ['transaction-question', 'novel-domain', 'multi-party'], [], []),
  seed('causal-graph', 'Causal graph reasoning', 'ANALYTICAL', 'Separate cause from correlation and trace what an intervention changes.', ['causal-question', 'multi-party'], [], ['mechanism-model']),
  seed('value-of-information', 'Value of information', 'ANALYTICAL', 'Decide which unknown is worth learning before acting.', ['decision-between-actions', 'uncertain-quantity'], [], ['paired-samples']),
  seed('small-experiment', 'Small reversible experiment', 'EXPERIMENT', 'Measure the quantity directly with a bounded, reversible action.', ['reversible-action-available', 'uncertain-quantity', 'no-observations'], ['irreversible-action'], ['authorized-action']),
  seed('constrained-optimization', 'Constrained optimization', 'OPTIMIZATION', 'Choose a combination under shared limits.', ['scarce-capacity', 'decision-between-actions'], [], ['objective', 'constraints']),
  seed('scenario-simulation', 'Monte Carlo scenario simulation', 'TOOL', 'Propagate uncertainty through a model to a distribution.', ['uncertain-quantity', 'interdependent-inputs'], [], ['mechanism-model']),
  seed('primary-source-research', 'Primary-source research', 'RESEARCH', 'Establish a fact from the party that controls it.', ['fact-question', 'rules-or-terms'], [], []),
  seed('counter-model', 'Counter-model and adversarial check', 'ANALYTICAL', 'Construct the strongest alternative explanation and test which the evidence prefers.', ['expensive-decision', 'competing-explanations'], [], []),
  seed('game-response', 'Competitive response analysis', 'ANALYTICAL', 'Ask how other parties react to the move.', ['competing-parties'], [], []),
  seed('time-to-cash', 'Settlement and time-to-cash model', 'TOOL', 'Model when money actually moves, not when it is billed.', ['time-to-cash', 'transaction-question'], [], ['payment-terms']),
]);

export interface DeclareResult {
  ok: boolean;
  catalogue: MethodSpec[];
  method: MethodSpec | null;
  reason: string | null;
}

/**
 * Add a method the catalogue does not have. Refused only without a reason or
 * with an id already taken; never refused for being unlike the seed entries.
 */
export function declareMethod(
  catalogue: readonly MethodSpec[],
  spec: Omit<MethodSpec, 'status' | 'declaredReason' | 'derivedFor'> & { derivedFor?: string | null },
  reason: string,
): DeclareResult {
  if (!reason.trim()) return { ok: false, catalogue: [...catalogue], method: null, reason: 'a declared method states why it is needed' };
  if (catalogue.some((m) => m.id === spec.id)) {
    return { ok: false, catalogue: [...catalogue], method: null, reason: `a method with id ${spec.id} already exists` };
  }
  const method: MethodSpec = { ...spec, status: 'UNVERIFIED', declaredReason: reason.trim(), derivedFor: spec.derivedFor ?? null };
  return { ok: true, catalogue: [...catalogue, method], method, reason: null };
}

/* ------------------------------------------------------------------------- */
/* Fitness, judged per case                                                   */
/* ------------------------------------------------------------------------- */

export type Fit = 'FIT' | 'PARTIAL' | 'UNFIT' | 'UNKNOWN';

export interface MethodJudgment {
  methodId: string;
  problemId: string;
  fit: Fit;
  /** 0..1, comparable across methods for this one problem only. */
  score: number;
  reasons: string[];
  /** Sources behind the features that drove the judgment. */
  evidence: string[];
  missingInputs: string[];
  /** Results of this method on comparable problems: successes / applications. */
  trackRecord: { successes: number; applications: number };
}

/** Weight of a feature a source supports versus one merely asserted. */
const EVIDENCED = 1;
const ASSERTED = 0.4;

/** Comparable means sharing at least half of the smaller feature set. */
export function comparable(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  const shared = b.filter((f) => set.has(f)).length;
  return shared / Math.min(a.length, b.length) >= 0.5;
}

/** Judge one method against one problem. Pure. */
export function judgeMethod(method: MethodSpec, problem: ProblemProfile, outcomes: readonly MethodOutcome[] = []): MethodJudgment {
  const reasons: string[] = [];
  const evidence: string[] = [];
  const featureNames = problem.features.map((f) => f.feature);
  const weightOf = (f: ProblemFeature) => (f.source ? EVIDENCED : ASSERTED);

  let fitWeight = 0;
  for (const f of problem.features) {
    if (!method.fitsWhen.includes(f.feature)) continue;
    fitWeight += weightOf(f);
    reasons.push(`${f.feature} ${f.source ? 'is evidenced' : 'is asserted without a source'} and the method is built for it`);
    if (f.source) evidence.push(f.source);
  }
  let misleadWeight = 0;
  for (const f of problem.features) {
    if (!method.misleadsWhen.includes(f.feature)) continue;
    misleadWeight += weightOf(f);
    reasons.push(`${f.feature} is present and the method misleads under it`);
    if (f.source) evidence.push(f.source);
  }
  const missingInputs = method.requires.filter((r) => !problem.available.includes(r));
  for (const m of missingInputs) reasons.push(`input ${m} is not available`);

  const relevant = outcomes.filter((o) => o.methodId === method.id && comparable(o.features, featureNames));
  const successes = relevant.filter((o) => o.succeeded).length;
  if (relevant.length > 0) reasons.push(`succeeded on ${successes} of ${relevant.length} comparable problems`);
  if (method.status === 'UNVERIFIED') reasons.push('the method is declared but not yet verified');
  if (method.status === 'RETIRED') reasons.push('the method was retired after its results contradicted it');

  const coverage = method.fitsWhen.length === 0 ? 0 : Math.min(1, fitWeight / method.fitsWhen.length);
  // Laplace-smoothed record; with no applications it is 0.5 and moves nothing.
  const record = (successes + 1) / (relevant.length + 2);
  const penalty = Math.min(1, misleadWeight / Math.max(1, method.misleadsWhen.length));
  const inputs = method.requires.length === 0 ? 1 : 1 - missingInputs.length / method.requires.length;
  const statusFactor = method.status === 'RETIRED' ? 0.2 : method.status === 'UNVERIFIED' ? 0.8 : 1;
  const raw = (0.55 * coverage + 0.3 * record + 0.15 * inputs) * (1 - 0.7 * penalty) * statusFactor;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;

  let fit: Fit;
  if (fitWeight === 0 && relevant.length === 0) fit = 'UNKNOWN';
  else if (penalty >= 0.5 || method.status === 'RETIRED' || (relevant.length >= 3 && successes / relevant.length < 0.34)) fit = 'UNFIT';
  else if (missingInputs.length > 0 || coverage < 0.5) fit = 'PARTIAL';
  else fit = 'FIT';
  if (fit === 'UNKNOWN') reasons.push('no evidenced feature of this problem and no comparable result speak to this method');

  return { methodId: method.id, problemId: problem.id, fit, score, reasons, evidence: [...new Set(evidence)], missingInputs, trackRecord: { successes, applications: relevant.length } };
}

export interface MethodComparison {
  problemId: string;
  ranked: MethodJudgment[];
  /** The best judgment, or null when no method is FIT or PARTIAL. */
  chosen: MethodJudgment | null;
  /** What separates the first from the runner-up, in words. */
  margin: string | null;
}

const FIT_ORDER: Record<Fit, number> = { FIT: 0, PARTIAL: 1, UNKNOWN: 2, UNFIT: 3 };

/** Compare competing methods for one problem, best first. Pure. */
export function compareMethods(catalogue: readonly MethodSpec[], problem: ProblemProfile, outcomes: readonly MethodOutcome[] = []): MethodComparison {
  const ranked = catalogue
    .map((m) => judgeMethod(m, problem, outcomes))
    .sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || b.score - a.score || a.methodId.localeCompare(b.methodId));
  const first = ranked[0];
  const chosen = first && (first.fit === 'FIT' || first.fit === 'PARTIAL') ? first : null;
  const second = ranked[1];
  let margin: string | null = null;
  if (chosen && second) {
    margin =
      chosen.fit !== second.fit
        ? `${chosen.methodId} is ${chosen.fit}, ${second.methodId} is ${second.fit}`
        : `${chosen.methodId} scores ${chosen.score} against ${second.methodId} at ${second.score}`;
  }
  return { problemId: problem.id, ranked, chosen, margin };
}

export interface MethodSelection {
  problemId: string;
  chosen: MethodJudgment[];
  alternatives: MethodJudgment[];
  rejected: MethodJudgment[];
  /** True when nothing fits: the case for a capability-gap diagnosis. */
  noFit: boolean;
}

/** Pick up to `limit` methods for a problem, with the runners-up and the rejected kept. */
export function selectMethods(
  catalogue: readonly MethodSpec[],
  problem: ProblemProfile,
  outcomes: readonly MethodOutcome[] = [],
  limit = 2,
): MethodSelection {
  const { ranked } = compareMethods(catalogue, problem, outcomes);
  const usable = ranked.filter((j) => j.fit === 'FIT' || j.fit === 'PARTIAL');
  return {
    problemId: problem.id,
    chosen: usable.slice(0, limit),
    alternatives: usable.slice(limit),
    rejected: ranked.filter((j) => j.fit === 'UNFIT'),
    noFit: usable.length === 0,
  };
}

/* ------------------------------------------------------------------------- */
/* Weak inferences                                                            */
/* ------------------------------------------------------------------------- */

export type InferenceKind = 'DEDUCTION' | 'CAUSAL' | 'CORRELATION' | 'GENERALIZATION' | 'ESTIMATE' | 'ANALOGY' | (string & {});

export interface InferenceStep {
  id: string;
  claim: string;
  kind: InferenceKind;
  /** Ids of earlier steps this one rests on. */
  premises: string[];
  /** Sources cited directly by this step. */
  sources: string[];
  /** Independent observations behind a generalization or estimate. */
  observations?: number | null;
  /** Independent figures an estimate was built from. */
  independentFigures?: number | null;
  /** For CAUSAL: whether a mechanism, experiment or controlled comparison backs it. */
  causalSupport?: 'MECHANISM' | 'EXPERIMENT' | 'CONTROLLED' | null;
  /** For ANALOGY: features shared with the source case. */
  sharedFeatures?: number | null;
}

export type WeakInferenceType =
  | 'UNSOURCED_PREMISE'
  | 'SINGLE_OBSERVATION_GENERALIZED'
  | 'CORRELATION_AS_CAUSE'
  | 'ANCHORED_ON_ONE_FIGURE'
  | 'THIN_ANALOGY'
  | 'DANGLING_PREMISE'
  | 'CIRCULAR';

export interface WeakInference {
  stepId: string;
  type: WeakInferenceType;
  detail: string;
}

/** Find the weak steps in a reasoning chain. Pure; returns typed findings. */
export function detectWeakInferences(chain: readonly InferenceStep[]): WeakInference[] {
  const findings: WeakInference[] = [];
  const byId = new Map(chain.map((s) => [s.id, s]));

  for (const step of chain) {
    if (step.premises.length === 0 && step.sources.length === 0 && step.kind !== 'DEDUCTION') {
      findings.push({ stepId: step.id, type: 'UNSOURCED_PREMISE', detail: `"${step.claim}" rests on neither a source nor an earlier step` });
    }
    for (const p of step.premises) {
      if (!byId.has(p)) findings.push({ stepId: step.id, type: 'DANGLING_PREMISE', detail: `premise ${p} is not a step of this chain` });
    }
    if ((step.kind === 'GENERALIZATION' || step.kind === 'ESTIMATE') && step.observations != null && step.observations <= 1) {
      findings.push({ stepId: step.id, type: 'SINGLE_OBSERVATION_GENERALIZED', detail: `generalizes from ${step.observations} observation(s)` });
    }
    if (step.kind === 'CAUSAL' && !step.causalSupport) {
      const fromCorrelation = step.premises.some((p) => byId.get(p)?.kind === 'CORRELATION');
      if (fromCorrelation || step.premises.length === 0) {
        findings.push({ stepId: step.id, type: 'CORRELATION_AS_CAUSE', detail: 'a causal claim backed by no mechanism, experiment or controlled comparison' });
      }
    }
    if (step.kind === 'ESTIMATE' && step.independentFigures != null && step.independentFigures <= 1) {
      findings.push({ stepId: step.id, type: 'ANCHORED_ON_ONE_FIGURE', detail: 'an estimate built from a single figure, with no independent cross-check' });
    }
    if (step.kind === 'ANALOGY' && (step.sharedFeatures ?? 0) < 2) {
      findings.push({ stepId: step.id, type: 'THIN_ANALOGY', detail: `the analogy shares ${step.sharedFeatures ?? 0} feature(s) with its source case` });
    }
  }

  // A step that reaches itself through its premises proves nothing.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const circular = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      circular.add(id);
      return;
    }
    visiting.add(id);
    for (const p of byId.get(id)?.premises ?? []) if (byId.has(p)) visit(p);
    visiting.delete(id);
    done.add(id);
  };
  for (const step of chain) visit(step.id);
  for (const id of circular) findings.push({ stepId: id, type: 'CIRCULAR', detail: 'the step is among its own premises' });

  return findings;
}

/* ------------------------------------------------------------------------- */
/* Learning procedures from successes and errors                              */
/* ------------------------------------------------------------------------- */

export interface Procedure {
  id: string;
  /** USE: apply this method when the features hold. AVOID: do not, because it keeps failing the same way. */
  rule: 'USE' | 'AVOID';
  methodId: string;
  appliesWhen: string[];
  successes: number;
  failures: number;
  /** The recurring error behind an AVOID rule. */
  errorClass: string | null;
  /** Distinct domains it was learned from: a procedure from one domain is not yet reusable. */
  domains: string[];
  reusable: boolean;
}

/** Learn reusable procedures from recorded outcomes. Pure. */
export function learnProcedures(outcomes: readonly MethodOutcome[], minimum = 2): Procedure[] {
  const groups = new Map<string, MethodOutcome[]>();
  for (const o of outcomes) {
    const key = `${o.methodId}\u0000${[...o.features].sort().join(',')}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const procedures: Procedure[] = [];
  for (const [key, rows] of groups) {
    const [methodId = '', featureKey = ''] = key.split('\u0000');
    const appliesWhen = featureKey ? featureKey.split(',') : [];
    const successes = rows.filter((r) => r.succeeded).length;
    const failures = rows.length - successes;
    const domains = [...new Set(rows.map((r) => r.domain))].sort();
    if (successes >= minimum && successes > failures) {
      procedures.push({ id: `use:${methodId}:${featureKey}`, rule: 'USE', methodId, appliesWhen, successes, failures, errorClass: null, domains, reusable: domains.length >= 2 });
    }
    const errors = new Map<string, number>();
    for (const r of rows) if (!r.succeeded && r.errorClass) errors.set(r.errorClass, (errors.get(r.errorClass) ?? 0) + 1);
    for (const [errorClass, count] of errors) {
      if (count >= minimum && failures > successes) {
        procedures.push({ id: `avoid:${methodId}:${featureKey}:${errorClass}`, rule: 'AVOID', methodId, appliesWhen, successes, failures, errorClass, domains, reusable: domains.length >= 2 });
      }
    }
  }
  return procedures.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a declared or derived method has earned VERIFIED (or RETIRED) from
 * results. Results in the domain it was derived for do not count: a method
 * verified only on the case that produced it has not been verified.
 */
export function verifyMethod(method: MethodSpec, outcomes: readonly MethodOutcome[], minimum = 2): MethodSpec {
  if (method.status === 'ESTABLISHED') return method;
  const elsewhere = outcomes.filter((o) => o.methodId === method.id && o.domain !== method.derivedFor);
  const successes = elsewhere.filter((o) => o.succeeded).length;
  const failures = elsewhere.length - successes;
  if (failures >= minimum && failures > successes) return { ...method, status: 'RETIRED' };
  if (successes >= minimum && successes > failures) return { ...method, status: 'VERIFIED' };
  return { ...method, status: 'UNVERIFIED' };
}

/* ------------------------------------------------------------------------- */
/* Capability gaps                                                            */
/* ------------------------------------------------------------------------- */

export interface ReasoningFailure {
  problem: ProblemProfile;
  /** Methods that were applied and did not produce a defensible answer. */
  methodsTried: string[];
  /** The error classes the attempts showed. */
  errorClasses: string[];
}

export interface CapabilityGap {
  problemId: string;
  domain: string;
  /** The methodological capability that is absent, named as a capability rather than a fact. */
  absentCapability: string;
  /** Problem features no FIT method covers. */
  uncoveredFeatures: string[];
  /** The error classes every tried method shared, when coverage was not the problem. */
  recurringErrors: string[];
  /** OBTAIN: an unverified method already covers it. DERIVE: none does, so a new one is proposed. */
  remedy: 'OBTAIN' | 'DERIVE';
  proposedMethod: MethodSpec;
  /** How the proposed method is verified: results on cases other than this one. */
  verification: string;
  /** Other domains with the same uncovered features, where it should then be applied. */
  applyTo: string[];
  /** Always false: the remedy for a method gap is a method, never more facts about the domain. */
  requestsDomainFacts: false;
}

/**
 * Name the absent capability behind a reasoning failure, and the way to
 * obtain or derive it. Pure.
 */
export function diagnoseCapabilityGap(
  failure: ReasoningFailure,
  catalogue: readonly MethodSpec[],
  outcomes: readonly MethodOutcome[] = [],
): CapabilityGap {
  const { problem } = failure;
  const judgments = catalogue.map((m) => judgeMethod(m, problem, outcomes));
  const fitIds = new Set(judgments.filter((j) => j.fit === 'FIT').map((j) => j.methodId));
  const covered = new Set(catalogue.filter((m) => fitIds.has(m.id) && !failure.methodsTried.includes(m.id)).flatMap((m) => m.fitsWhen));
  const uncoveredFeatures = problem.features.map((f) => f.feature).filter((f) => !covered.has(f));

  const errorCounts = new Map<string, number>();
  for (const e of failure.errorClasses) errorCounts.set(e, (errorCounts.get(e) ?? 0) + 1);
  const recurringErrors = [...errorCounts.entries()].filter(([, n]) => n >= Math.max(1, Math.ceil(failure.methodsTried.length / 2))).map(([e]) => e).sort();

  const target = uncoveredFeatures.length > 0 ? uncoveredFeatures : recurringErrors;
  const absentCapability =
    uncoveredFeatures.length > 0
      ? `a method that reasons about ${uncoveredFeatures.join(' + ')}`
      : `a method that avoids ${recurringErrors.join(' + ') || 'the failure the tried methods share'}`;

  const existing = catalogue.find(
    (m) => m.status === 'UNVERIFIED' && !failure.methodsTried.includes(m.id) && target.length > 0 && target.every((f) => m.fitsWhen.includes(f)),
  );
  const proposedMethod: MethodSpec =
    existing ?? {
      id: `derived:${target.join('+') || problem.domain}`.slice(0, 120),
      name: `Derived: ${absentCapability}`,
      kind: 'DECOMPOSITION',
      purpose: `Reason about ${target.join(', ') || 'the failure'} by decomposing the transaction into the parties, rights, risks and flows those features involve, then testing each part against evidence.`,
      fitsWhen: uncoveredFeatures.length > 0 ? uncoveredFeatures : problem.features.map((f) => f.feature),
      misleadsWhen: [],
      requires: [],
      status: 'UNVERIFIED',
      declaredReason: `derived after ${failure.methodsTried.join(', ') || 'no method'} failed on ${problem.domain}`,
      derivedFor: problem.domain,
    };

  const applyTo = [
    ...new Set(
      outcomes
        .filter((o) => o.domain !== problem.domain && target.some((f) => o.features.includes(f)))
        .map((o) => o.domain),
    ),
  ].sort();

  return {
    problemId: problem.id,
    domain: problem.domain,
    absentCapability,
    uncoveredFeatures,
    recurringErrors,
    remedy: existing ? 'OBTAIN' : 'DERIVE',
    proposedMethod,
    verification: `apply ${proposedMethod.id} to at least two problems outside ${problem.domain} and record their outcomes; it stays UNVERIFIED until they succeed`,
    applyTo,
    requestsDomainFacts: false,
  };
}

/* ------------------------------------------------------------------------- */
/* Rows: written through the existing append-only writer, read back from it   */
/* ------------------------------------------------------------------------- */

export const METHOD_EVENTS = {
  JUDGMENT: 'METHOD_JUDGMENT',
  OUTCOME: 'METHOD_OUTCOME',
  PROCEDURE: 'METHOD_PROCEDURE',
  CAPABILITY_GAP: 'METHOD_CAPABILITY_GAP',
  DECLARED: 'METHOD_DECLARED',
} as const;

export interface MethodRowDeps {
  record?: typeof recordBinEvent;
  projectId?: string | null;
  caller?: string;
}

async function write(eventType: string, outcome: string, reason: string, measures: Record<string, unknown>, deps: MethodRowDeps): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'method-library',
    outcome,
    reason: reason.slice(0, 480),
    measures,
  });
}

/** Record a selection: every judgment with its reasons, as one row. */
export async function recordMethodSelection(problem: ProblemProfile, selection: MethodSelection, deps: MethodRowDeps = {}): Promise<void> {
  const chosen = selection.chosen.map((j) => j.methodId);
  await write(
    METHOD_EVENTS.JUDGMENT,
    selection.noFit ? 'NO_FIT' : 'SELECTED',
    selection.noFit ? `no method fits ${problem.id}` : `${chosen.join(', ')} for ${problem.id}`,
    { problem, selection },
    deps,
  );
}

export async function recordMethodOutcome(outcome: MethodOutcome, deps: MethodRowDeps = {}): Promise<void> {
  await write(METHOD_EVENTS.OUTCOME, outcome.succeeded ? 'SUCCEEDED' : 'FAILED', `${outcome.methodId} on ${outcome.problemId}`, { outcome }, deps);
}

export async function recordProcedure(procedure: Procedure, deps: MethodRowDeps = {}): Promise<void> {
  await write(METHOD_EVENTS.PROCEDURE, procedure.rule, procedure.id, { procedure }, deps);
}

export async function recordCapabilityGap(gap: CapabilityGap, deps: MethodRowDeps = {}): Promise<void> {
  await write(METHOD_EVENTS.CAPABILITY_GAP, gap.remedy, gap.absentCapability, { gap }, deps);
}

export async function recordDeclaredMethod(method: MethodSpec, deps: MethodRowDeps = {}): Promise<void> {
  await write(METHOD_EVENTS.DECLARED, method.status, `${method.id}: ${method.declaredReason ?? ''}`, { method }, deps);
}

async function readMeasures(eventType: string, projectId: string | null, limit: number): Promise<Record<string, unknown>[]> {
  const params: SqlParam[] = [eventType];
  let where = 'event_type = ?';
  if (projectId !== null) {
    where += ' AND project_id = ?';
    params.push(projectId);
  }
  params.push(Math.max(1, Math.floor(limit)));
  const rows = await getDb().all<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE ${where} ORDER BY at ASC, id ASC LIMIT ?`,
    params,
  );
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = row.measures ? JSON.parse(row.measures) : null;
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // A row that does not parse is skipped, never guessed.
    }
  }
  return out;
}

function isOutcome(value: unknown): value is MethodOutcome {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['methodId'] === 'string' && typeof v['problemId'] === 'string' && typeof v['succeeded'] === 'boolean' && Array.isArray(v['features']);
}

function isMethod(value: unknown): value is MethodSpec {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && Array.isArray(v['fitsWhen']) && Array.isArray(v['misleadsWhen']) && Array.isArray(v['requires']);
}

/** Every recorded method outcome, oldest first. */
export async function readMethodOutcomes(projectId: string | null = null, limit = 5000): Promise<MethodOutcome[]> {
  return (await readMeasures(METHOD_EVENTS.OUTCOME, projectId, limit)).map((m) => m['outcome']).filter(isOutcome);
}

/**
 * The working catalogue: the seed entries plus every method declared or
 * derived since, each with its status recomputed from the outcomes.
 */
export async function readCatalogue(projectId: string | null = null): Promise<MethodSpec[]> {
  const declared = (await readMeasures(METHOD_EVENTS.DECLARED, projectId, 2000)).map((m) => m['method']).filter(isMethod);
  const outcomes = await readMethodOutcomes(projectId);
  const byId = new Map<string, MethodSpec>(SEED_METHODS.map((m) => [m.id, m]));
  for (const m of declared) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].map((m) => verifyMethod(m, outcomes));
}
