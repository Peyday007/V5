/**
 * The intelligence sprint: a measured benchmark of Brain's reasoning on real,
 * held-out commercial problems, run inside the improvement loop (SPRINT-18-5).
 *
 * What it is, and what it is not. It measures whether a general reasoning
 * method — the metareasoning controller (`research/reasoningController.ts`)
 * with per-number provenance (`quant/mathToolkit.ts`) — turns real commercial
 * problems into economically supported, actionable transaction pathways more
 * often, and better calibrated, than a simple baseline does on the same
 * problems, and whether its extra cost earns that. It does not train a
 * model, and nothing it records is evidence that a general superintelligence
 * can be built in a week; a reading says how two methods compared on these
 * rows and nothing more.
 *
 * The problems are production rows: `cash_opportunities`, each a concrete
 * opening with an evidence card. Whether one was an actionable pathway is
 * read from what happened to it — it reached READY or went further — never
 * from either method's opinion. The split is a hash of the row id, so the
 * benchmark set is the same on every rerun, and the method's one tuned
 * choice (the probability above which it calls a pathway actionable) is made
 * on the benchmark set alone: held-out rows are only ever scored. A rerun
 * scores the same benchmark, the same held-out set, and every opening created
 * since the previous run as a new held-out set.
 *
 * Per set and method it records the actionable-pathway rate, method quality,
 * decision time, required human interventions, calibration and robust target
 * coverage, each with its numerator and denominator, or INSUFFICIENT_DATA
 * below a minimum sample (§77: a number nobody can check is not shown).
 *
 * It does not only measure. Each run tries the highest-leverage general
 * reasoning capability it has not adopted yet (`SPRINT_CAPABILITIES`: closed-loop
 * forecast recalibration, dimensional validation, a counter-model of the
 * pathway's own failure), chosen by its improvement on the benchmark set alone,
 * then reruns the held-out sets with and without it. A capability that improves
 * the held-out score is adopted, and every later run composes it into the
 * general method; one that does not is rejected; an adopted one whose held-out
 * score turns against it is reverted. Each trial is its own row, so a rerun's
 * delta is linked to the exact change that produced it.
 *
 * Required human interventions are counted, not modelled: the owner's real
 * Needs-You requests and orchestrations parked NEEDS_HUMAN (the same rows the
 * scoreboard's OWNER_INTERVENTIONS_PER_DAY reads) inside each opening's life.
 * The method's own projection is kept beside it, named as a projection.
 *
 * Owners reused, none added: rows go to `improvement_events` (the loop's
 * append-only record) and, for the controller and provenance it produced on
 * real problems, to `bin_events` through their own recorders; a held-out
 * result where the general method did not earn its cost becomes a weakness
 * registered through the loop's existing `registerDirected`, which is the one
 * path from a weakness to a Factory objective — and so do the general method's
 * false positives, even on a run where it beat the baseline. It runs from `improvementTick`,
 * at most once per `SPRINT_INTERVAL_MS`, and owns no schedule of its own.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { listImprovementEvents, recordImprovementEvent } from '../../repos/improvement.ts';
import type { Weakness } from '../../domain/improvement.ts';
import { SEED_METHODS, type ProblemProfile } from '../research/methodLibrary.ts';
import {
  decideNext,
  recordControllerDecision,
  type CandidateAction,
  type ControllerDecision,
  type EvidenceItem,
} from '../research/reasoningController.ts';
import { buildNumberProvenance, recordNumberProvenance, type NumberProvenance, type ProvenanceInput } from '../quant/mathToolkit.ts';
import type { Figure } from '../quant/graph.ts';

/* ------------------------------------------------------------------------- */
/* Problems                                                                   */
/* ------------------------------------------------------------------------- */

export interface SprintProblem {
  id: string;
  projectId: string;
  title: string;
  mechanism: string;
  industry: string | null;
  source: string | null;
  sourceClaimId: string | null;
  payer: string | null;
  reachableChannel: string | null;
  buyingSignal: string | null;
  acceptanceCondition: string | null;
  priceCents: number | null;
  currency: string;
  paymentTerms: string | null;
  fulfillmentOwner: string | null;
  deadline: string | null;
  humanHours: number | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}

/** The card fields a pathway cannot be acted on without. */
export const LOAD_BEARING = ['payer', 'reachableChannel', 'buyingSignal', 'acceptanceCondition', 'priceCents', 'paymentTerms', 'fulfillmentOwner'] as const;
type LoadBearing = (typeof LOAD_BEARING)[number];

/** States that mean the opening became an economically supported, actionable pathway. */
export const ACTIONABLE_STATES: ReadonlySet<string> = new Set(['READY', 'EXECUTING', 'DELIVERING', 'COLLECTED']);

export function actionableInProduction(p: Pick<SprintProblem, 'state'>): boolean {
  return ACTIONABLE_STATES.has(p.state);
}

interface ProblemRow {
  id: string;
  project_id: string;
  title: string;
  mechanism: string;
  industry: string | null;
  source: string | null;
  source_claim_id: string | null;
  payer: string | null;
  reachable_channel: string | null;
  buying_signal: string | null;
  acceptance_condition: string | null;
  price_cents: number | null;
  currency: string;
  payment_terms: string | null;
  fulfillment_owner: string | null;
  deadline: string | null;
  human_hours: number | null;
  state: string;
  created_at: string;
  updated_at: string;
}

/** Real commercial problems: openings with an evidence card, duplicates excluded. */
export async function readSprintProblems(limit = 2000): Promise<SprintProblem[]> {
  const rows = await getDb().all<ProblemRow>(
    `SELECT id, project_id, title, mechanism, industry, source, source_claim_id, payer, reachable_channel, buying_signal,
            acceptance_condition, price_cents, currency, payment_terms, fulfillment_owner, deadline, human_hours,
            state, created_at, updated_at
       FROM cash_opportunities
      WHERE duplicate_of_id IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    mechanism: r.mechanism,
    industry: r.industry,
    source: r.source,
    sourceClaimId: r.source_claim_id,
    payer: r.payer,
    reachableChannel: r.reachable_channel,
    buyingSignal: r.buying_signal,
    acceptanceCondition: r.acceptance_condition,
    priceCents: r.price_cents === null ? null : Number(r.price_cents),
    currency: r.currency,
    paymentTerms: r.payment_terms,
    fulfillmentOwner: r.fulfillment_owner,
    deadline: r.deadline,
    humanHours: r.human_hours === null ? null : Number(r.human_hours),
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type ProblemSet = 'BENCHMARK' | 'HELD_OUT' | 'NEW_HELD_OUT';

/** Share of problems (by id hash) in the benchmark set; the rest are held out. */
export const BENCHMARK_SHARE = 0.6;

function bucketOf(id: string): number {
  return parseInt(createHash('sha256').update(`sprint:${id}`).digest('hex').slice(0, 8), 16) / 0x100000000;
}

/**
 * Deterministic split. An opening created after the previous run's cutoff is
 * NEW_HELD_OUT, whatever its hash, so a rerun always meets tasks it has not
 * seen; otherwise the hash decides, so the benchmark is the same set each run.
 */
export function splitProblems(problems: readonly SprintProblem[], previousCutoff: string | null): Record<ProblemSet, SprintProblem[]> {
  const out: Record<ProblemSet, SprintProblem[]> = { BENCHMARK: [], HELD_OUT: [], NEW_HELD_OUT: [] };
  for (const p of problems) {
    if (previousCutoff && p.createdAt > previousCutoff) out.NEW_HELD_OUT.push(p);
    else if (bucketOf(p.id) < BENCHMARK_SHARE) out.BENCHMARK.push(p);
    else out.HELD_OUT.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Methods                                                                    */
/* ------------------------------------------------------------------------- */

export interface MethodVerdict {
  problemId: string;
  actionable: boolean;
  /** The method's probability that this is an actionable pathway. */
  probability: number;
  /** The method projects it could not progress without a person (a projection, not an observed intervention). */
  needsPerson: boolean;
  /** Its actionable verdict survives the adverse alternatives of its own numbers. */
  robust: boolean;
  /** Weak inferences and provenance refusals it found or committed. */
  findings: number;
  elapsedMs: number;
  decision?: ControllerDecision;
  provenance?: NumberProvenance | null;
}

export interface SprintMethod {
  key: string;
  run(problem: SprintProblem, threshold: number): MethodVerdict;
}

const known = (p: SprintProblem, field: LoadBearing): boolean => {
  const v = p[field];
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
};

function sourceOf(p: SprintProblem): string | null {
  return p.source?.trim() || (p.sourceClaimId ? `claim:${p.sourceClaimId}` : null);
}

/** The simpler baseline: a payer and a price make a pathway. */
export const BASELINE_METHOD: SprintMethod = {
  key: 'baseline:payer-and-price',
  run(p) {
    const started = performance.now();
    const actionable = known(p, 'payer') && known(p, 'priceCents');
    return {
      problemId: p.id,
      actionable,
      probability: actionable ? 0.6 : 0.2,
      needsPerson: !actionable,
      robust: actionable,
      findings: 0,
      elapsedMs: performance.now() - started,
    };
  },
};

const HOLDS = 'pathway-holds';
const FAILS = 'pathway-fails';

/** The problem as the controller sees it: its evidenced features and its open unknowns. */
export function profileOf(p: SprintProblem): { profile: ProblemProfile; unknowns: LoadBearing[]; evidence: EvidenceItem[]; actions: CandidateAction[] } {
  const source = sourceOf(p);
  const unknowns = LOAD_BEARING.filter((f) => !known(p, f));
  const features: ProblemProfile['features'] = [
    { feature: 'transaction-question', source },
    { feature: 'multi-party', source: known(p, 'payer') && known(p, 'fulfillmentOwner') ? source : null },
  ];
  if (known(p, 'paymentTerms')) features.push({ feature: 'time-to-cash', source });
  if (unknowns.length > 0) features.push({ feature: 'uncertain-quantity', source });
  if (p.industry) features.push({ feature: `industry:${p.industry}`, source });
  const available: string[] = [];
  if (known(p, 'paymentTerms')) available.push('payment-terms');
  const evidence: EvidenceItem[] = LOAD_BEARING.filter((f) => known(p, f)).map((f) => ({ id: `${p.id}:${f}`, source, bears: { [HOLDS]: 'SUPPORTS' } }));
  const actions: CandidateAction[] = unknowns.map((f) => ({
    key: `${p.id}:${f}`,
    kind: 'RESEARCH',
    subject: `${f} of ${p.title}`.slice(0, 200),
    question: `What is the ${f} for "${p.title}"?`.slice(0, 300),
    resolves: f,
    discriminates: [HOLDS, FAILS],
    cost: 0.01,
  }));
  return {
    profile: { id: p.id, domain: p.industry ?? p.mechanism, question: `Is "${p.title}" an actionable transaction pathway?`, features, available },
    unknowns,
    evidence,
    actions,
  };
}

function priceFigure(p: SprintProblem): Figure {
  const source = sourceOf(p);
  const value = p.priceCents === null ? null : p.priceCents / 100;
  const evidenced = value !== null && source !== null;
  return {
    meaning: 'price of one transaction',
    unit: p.currency,
    value: evidenced ? value : null,
    source: evidenced ? source : null,
    derivedFrom: [],
    status: evidenced ? 'EVIDENCED' : 'UNKNOWN',
    window: null,
    geography: null,
    scope: p.id,
    bounds: null,
    invalidatedBy: [],
  };
}

/** The gross billed per transaction, with its provenance; null when it cannot be built honestly. */
export function grossBilledProvenance(p: SprintProblem): { record: NumberProvenance | null; findings: number } {
  const input: ProvenanceInput = { key: 'price', figure: priceFigure(p), source: { ref: sourceOf(p) ?? '', retrievedAt: p.updatedAt } };
  const built = buildNumberProvenance({
    key: `gross-billed:${p.id}`,
    quantity: { kind: 'GROSS_BILLED', definition: 'amount invoiced to the payer for one transaction' },
    units: p.currency,
    horizon: p.deadline ? `until ${p.deadline}` : 'per transaction',
    formula: { ref: 'price' },
    inputs: [input],
    alternatives: [
      { label: 'price 20% lower', parameters: { price: (p.priceCents ?? 0) / 100 * 0.8 } },
      { label: 'price 20% higher', parameters: { price: (p.priceCents ?? 0) / 100 * 1.2 } },
    ],
    interdependence: p.payer ? [`payer:${p.payer}`] : [],
    applicability: { method: 'cash-flow identity', evidence: sourceOf(p) ? [sourceOf(p)!] : [] },
    form: 'IDENTITY',
  });
  if (built.ok) return { record: built.record, findings: 0 };
  return { record: null, findings: built.missing.length + built.problems.length };
}

/** The general method: the controller over the card, with the gross billed carried with its provenance. */
export const GENERAL_METHOD: SprintMethod = {
  key: 'general:controller+provenance',
  run(p, threshold) {
    const started = performance.now();
    const { profile, unknowns, evidence, actions } = profileOf(p);
    const decision = decideNext({
      problem: profile,
      knowledge: null,
      mechanism: null,
      catalogue: SEED_METHODS,
      outcomes: [],
      hypotheses: [
        { id: HOLDS, statement: `"${p.title}" is an actionable pathway`, basis: 'given:holds' },
        { id: FAILS, statement: `"${p.title}" fails at an unknown load-bearing field`, basis: 'given:fails' },
      ],
      evidence: [...evidence, ...unknowns.map((f): EvidenceItem => ({ id: `${p.id}:${f}:unknown`, source: sourceOf(p), bears: { [FAILS]: 'SUPPORTS', [HOLDS]: 'REFUTES' } }))],
      actions,
      now: p.updatedAt,
    });
    const { record, findings: provenanceFindings } = grossBilledProvenance(p);
    const probability = decision.hypotheses.find((h) => h.id === HOLDS)?.score ?? 0;
    const actionable = unknowns.length === 0 && record !== null && probability >= threshold;
    const robust = actionable && record !== null && record.alternatives.every((a) => a.value !== null && a.value > 0);
    return {
      problemId: p.id,
      actionable,
      probability,
      // A person is needed only when no research or method action can move it and it is still not actionable.
      needsPerson: !actionable && (decision.next === null || decision.next.kind === 'METHOD_GAP'),
      robust,
      findings: decision.weakInferences.length + provenanceFindings,
      elapsedMs: performance.now() - started,
      decision,
      provenance: record,
    };
  },
};

/* ------------------------------------------------------------------------- */
/* Measures                                                                   */
/* ------------------------------------------------------------------------- */

export const MIN_SAMPLE = 5;

export interface Measure {
  value: number | 'INSUFFICIENT_DATA';
  numerator: number;
  denominator: number;
}

const measure = (numerator: number, denominator: number, min = MIN_SAMPLE): Measure => ({
  value: denominator < min ? 'INSUFFICIENT_DATA' : Math.round((numerator / denominator) * 10000) / 10000,
  numerator: Math.round(numerator * 10000) / 10000,
  denominator,
});

export interface SetReading {
  set: ProblemSet;
  method: string;
  problems: number;
  /** Method called it actionable and production confirmed it, over the set. */
  actionablePathwayRate: Measure;
  /** Decisions free of weak-inference and provenance findings, over the set. */
  methodQuality: Measure;
  /** Total decision milliseconds over decisions. */
  decisionTimeMs: Measure;
  /**
   * Observed: problems during whose life the owner was actually asked (a Needs-You request or an
   * orchestration parked NEEDS_HUMAN in its project), over the problems those rows were read for.
   */
  humanInterventions: Measure;
  /** Projected: problems the method says it could not progress without a person, over the set. */
  projectedHumanInterventions: Measure;
  /** Brier score: summed squared error of the probability against what happened, over the set. Lower is better. */
  calibrationBrier: Measure;
  /** Actually actionable problems the method called actionable robustly, over actually actionable problems. */
  robustTargetCoverage: Measure;
  /** Called actionable, production says not: the failures fed to repair. */
  falsePositives: string[];
}

export function readSet(
  set: ProblemSet,
  method: string,
  problems: readonly SprintProblem[],
  verdicts: readonly MethodVerdict[],
  /** Real owner interventions per problem id; absent means they were not read, never zero. */
  observed?: ReadonlyMap<string, number>,
): SetReading {
  const truth = new Map(problems.map((p) => [p.id, actionableInProduction(p)]));
  const n = verdicts.length;
  const tp = verdicts.filter((v) => v.actionable && truth.get(v.problemId)).length;
  const clean = verdicts.filter((v) => v.findings === 0).length;
  const time = verdicts.reduce((s, v) => s + v.elapsedMs, 0);
  const people = verdicts.filter((v) => v.needsPerson).length;
  const asked = observed ? verdicts.filter((v) => (observed.get(v.problemId) ?? 0) > 0).length : 0;
  const brier = verdicts.reduce((s, v) => s + (v.probability - (truth.get(v.problemId) ? 1 : 0)) ** 2, 0);
  const targets = verdicts.filter((v) => truth.get(v.problemId));
  const covered = targets.filter((v) => v.actionable && v.robust).length;
  return {
    set,
    method,
    problems: n,
    actionablePathwayRate: measure(tp, n),
    methodQuality: measure(clean, n),
    decisionTimeMs: measure(time, n, 1),
    humanInterventions: measure(asked, observed ? n : 0),
    projectedHumanInterventions: measure(people, n),
    calibrationBrier: measure(brier, n),
    robustTargetCoverage: measure(covered, targets.length),
    falsePositives: verdicts.filter((v) => v.actionable && !truth.get(v.problemId)).map((v) => v.problemId),
  };
}

/**
 * The method's one tuned choice, made on the benchmark set only: the
 * probability threshold with the lowest misclassification there.
 */
export function chooseThreshold(benchmark: readonly SprintProblem[], method: SprintMethod = GENERAL_METHOD): number {
  const candidates = [0.5, 0.6, 0.7, 0.8, 0.9];
  let best = candidates[0]!;
  let bestErrors = Infinity;
  for (const t of candidates) {
    const errors = benchmark.filter((p) => method.run(p, t).actionable !== actionableInProduction(p)).length;
    if (errors < bestErrors) {
      best = t;
      bestErrors = errors;
    }
  }
  return best;
}

export interface BaselineComparison {
  set: ProblemSet;
  /** null when either side lacks data to say. */
  earned: boolean | null;
  statement: string;
  general: SetReading;
  baseline: SetReading;
}

const num = (m: Measure): number | null => (m.value === 'INSUFFICIENT_DATA' ? null : m.value);

/**
 * Whether the general method's extra cost earned its keep on one set: it must
 * find at least as many confirmed pathways, be no worse calibrated, and need
 * people no more often, for the decision time it spends beyond the baseline.
 */
export function compareWithBaseline(general: SetReading, baseline: SetReading): BaselineComparison {
  // Observed interventions happened once per problem whatever method reads it, so the methods differ only in what they project.
  const g = { rate: num(general.actionablePathwayRate), brier: num(general.calibrationBrier), people: num(general.projectedHumanInterventions) };
  const b = { rate: num(baseline.actionablePathwayRate), brier: num(baseline.calibrationBrier), people: num(baseline.projectedHumanInterventions) };
  const costRatio = baseline.decisionTimeMs.numerator > 0 ? general.decisionTimeMs.numerator / baseline.decisionTimeMs.numerator : null;
  if (g.rate === null || b.rate === null || g.brier === null || b.brier === null || g.people === null || b.people === null) {
    return { set: general.set, earned: null, statement: `${general.set}: too few problems (${general.problems}) to say whether the general method earned its cost`, general, baseline };
  }
  const earned = g.rate >= b.rate && g.brier <= b.brier && g.people <= b.people && (g.rate > b.rate || g.brier < b.brier || g.people < b.people);
  const cost = costRatio === null ? 'unmeasured extra time' : `${costRatio.toFixed(1)}x the baseline's decision time`;
  return {
    set: general.set,
    earned,
    statement:
      `${general.set}: pathway rate ${g.rate} vs ${b.rate}, Brier ${g.brier} vs ${b.brier}, projected people ${g.people} vs ${b.people}, at ${cost} — ` +
      (earned ? 'the extra complexity earned its cost' : 'the extra complexity did not earn its cost on this set'),
    general,
    baseline,
  };
}

/* ------------------------------------------------------------------------- */
/* Capabilities: implemented, tried, adopted or rejected by measurement       */
/* ------------------------------------------------------------------------- */

/** A capability fitted on the benchmark set: a transform of the general method's verdict. */
export interface FittedCapability {
  key: string;
  apply(problem: SprintProblem, verdict: MethodVerdict): MethodVerdict;
}

/** A general reasoning capability the sprint can add to the general method. */
export interface SprintCapability {
  key: string;
  title: string;
  /** Which reasoning failure it addresses. */
  addresses: string;
  /** Fit on benchmark problems and verdicts only; held-out rows never reach this. */
  fit(benchmark: readonly SprintProblem[], verdicts: readonly MethodVerdict[]): FittedCapability;
}

const downgrade = (v: MethodVerdict): MethodVerdict => ({
  ...v,
  actionable: false,
  robust: false,
  probability: Math.min(v.probability, 0.2),
  findings: v.findings + 1,
});

/** Closed-loop forecast evaluation: map the method's probability onto the rate it actually achieved on the benchmark. */
export const RECALIBRATION: SprintCapability = {
  key: 'forecast-recalibration',
  title: 'Closed-loop forecast recalibration',
  addresses: 'probabilities that do not match the rate at which such calls came true',
  fit(benchmark, verdicts) {
    const truth = new Map(benchmark.map((p) => [p.id, actionableInProduction(p)]));
    const bins = new Map<number, { hit: number; n: number }>();
    const binOf = (q: number) => Math.min(9, Math.max(0, Math.floor(q * 10)));
    for (const v of verdicts) {
      const b = bins.get(binOf(v.probability)) ?? { hit: 0, n: 0 };
      b.n += 1;
      if (truth.get(v.problemId)) b.hit += 1;
      bins.set(binOf(v.probability), b);
    }
    return {
      key: 'forecast-recalibration',
      apply(_p, v) {
        const b = bins.get(binOf(v.probability));
        // An empty bin has no evidence to recalibrate with; the raw probability stands.
        if (!b || b.n < 2) return v;
        return { ...v, probability: (b.hit + 1) / (b.n + 2) };
      },
    };
  },
};

/** Dimensional validation: a pathway's price, currency and effort must be quantities of the right kind and sign. */
export const DIMENSIONAL_VALIDATION: SprintCapability = {
  key: 'dimensional-validation',
  title: 'Dimensional validation of the card',
  addresses: 'actionable calls on a non-positive price, an unknown currency unit or negative effort',
  fit() {
    return {
      key: 'dimensional-validation',
      apply(p, v) {
        const bad =
          (p.priceCents !== null && !(Number.isFinite(p.priceCents) && p.priceCents > 0)) ||
          !/^[A-Z]{3}$/.test(p.currency ?? '') ||
          (p.humanHours !== null && !(Number.isFinite(p.humanHours) && p.humanHours >= 0));
        return bad && v.actionable ? downgrade(v) : bad ? { ...v, findings: v.findings + 1 } : v;
      },
    };
  },
};

/** Counter-model: the most direct way the pathway fails — its own deadline passed before the card was last touched. */
export const EXPIRED_WINDOW_COUNTER_MODEL: SprintCapability = {
  key: 'counter-model:expired-window',
  title: 'Counter-model: the opening\'s window has closed',
  addresses: 'actionable calls on openings whose stated deadline had already passed',
  fit() {
    return {
      key: 'counter-model:expired-window',
      apply(p, v) {
        // The counter-model lowers the forecast as well as the call: a closed window is evidence either way.
        if (!p.deadline) return v;
        const deadline = Date.parse(p.deadline);
        const seen = Date.parse(p.updatedAt);
        return Number.isFinite(deadline) && Number.isFinite(seen) && deadline < seen ? downgrade(v) : v;
      },
    };
  },
};

/** The library the sprint draws from. Illustrative, never exhaustive: a capability earns adoption only by measurement. */
export const SPRINT_CAPABILITIES: readonly SprintCapability[] = [RECALIBRATION, DIMENSIONAL_VALIDATION, EXPIRED_WINDOW_COUNTER_MODEL];

/** Run the general method, then the adopted capabilities in order. `cache` holds the general method's own verdicts. */
export function composeVerdicts(
  problems: readonly SprintProblem[],
  threshold: number,
  fitted: readonly FittedCapability[],
  cache?: Map<string, MethodVerdict>,
): MethodVerdict[] {
  return problems.map((p) => {
    const cacheKey = `${threshold}:${p.id}`;
    let v = cache?.get(cacheKey) ?? GENERAL_METHOD.run(p, threshold);
    cache?.set(cacheKey, v);
    for (const f of fitted) {
      const started = performance.now();
      const next = f.apply(p, v);
      v = { ...next, elapsedMs: next.elapsedMs + (performance.now() - started) };
    }
    return v;
  });
}

/** Misclassification rate plus mean Brier: lower is better. Null below the minimum sample. */
export function sprintScore(problems: readonly SprintProblem[], verdicts: readonly MethodVerdict[]): number | null {
  if (verdicts.length < MIN_SAMPLE) return null;
  const truth = new Map(problems.map((p) => [p.id, actionableInProduction(p)]));
  let wrong = 0;
  let brier = 0;
  for (const v of verdicts) {
    const t = truth.get(v.problemId) ?? false;
    if (v.actionable !== t) wrong += 1;
    brier += (v.probability - (t ? 1 : 0)) ** 2;
  }
  return Math.round(((wrong + brier) / verdicts.length) * 10000) / 10000;
}

export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** The threshold for a composition, chosen on the benchmark only: the lowest misclassification there. */
export function composedThreshold(benchmark: readonly SprintProblem[], fitted: readonly FittedCapability[], cache?: Map<string, MethodVerdict>): number {
  let best: number = THRESHOLDS[0];
  let bestErrors = Infinity;
  for (const t of THRESHOLDS) {
    const errors = composeVerdicts(benchmark, t, fitted, cache).filter((v, i) => v.actionable !== actionableInProduction(benchmark[i]!)).length;
    if (errors < bestErrors) {
      best = t;
      bestErrors = errors;
    }
  }
  return best;
}

export type TrialVerdict = 'ADOPTED' | 'REJECTED' | 'UNVERIFIED' | 'REVERTED' | 'RETAINED';

export interface CapabilityTrial {
  capability: string;
  title: string;
  verdict: TrialVerdict;
  /** The change this delta is linked to: the capability and the run that tried it. */
  change: string;
  benchmark: { before: number | null; after: number | null; problems: number };
  heldOut: { before: number | null; after: number | null; problems: number };
  statement: string;
}

/** Minimum benchmark improvement for a capability to be worth trying on held-out problems. */
export const MIN_LEVERAGE = 0.001;

interface CapabilityContext {
  split: Record<ProblemSet, SprintProblem[]>;
  threshold: number;
  adopted: readonly string[];
  library: readonly SprintCapability[];
  ranAt: string;
}

/**
 * Choose, try and verify. Re-verifies every adopted capability on held-out problems (reverting one
 * the results now invalidate), then picks the not-yet-adopted capability with the largest benchmark
 * improvement and adopts it only when the held-out rerun improves too.
 */
export function trialCapabilities(ctx: CapabilityContext): { adopted: string[]; trials: CapabilityTrial[]; fitted: FittedCapability[]; threshold: number } {
  const bench = ctx.split.BENCHMARK;
  const held = [...ctx.split.HELD_OUT, ...ctx.split.NEW_HELD_OUT];
  const byKey = new Map(ctx.library.map((c) => [c.key, c]));
  const cache = new Map<string, MethodVerdict>();
  const fitWith = (keys: readonly string[]): FittedCapability[] => {
    const out: FittedCapability[] = [];
    for (const key of keys) {
      const cap = byKey.get(key);
      if (!cap) continue;
      out.push(cap.fit(bench, composeVerdicts(bench, ctx.threshold, out, cache)));
    }
    return out;
  };
  // Each composition is scored at its own threshold, tuned on the benchmark alone.
  const score = (ps: readonly SprintProblem[], keys: readonly string[]) => {
    const fitted = fitWith(keys);
    return sprintScore(ps, composeVerdicts(ps, composedThreshold(bench, fitted, cache), fitted, cache));
  };
  const trials: CapabilityTrial[] = [];
  let adopted = ctx.adopted.filter((k) => byKey.has(k));

  // Results that invalidate an adopted capability change the method.
  for (const key of [...adopted]) {
    const without = adopted.filter((k) => k !== key);
    const before = score(held, without);
    const after = score(held, adopted);
    const reverted = before !== null && after !== null && after > before;
    if (reverted) adopted = without;
    trials.push({
      capability: key,
      title: byKey.get(key)!.title,
      verdict: reverted ? 'REVERTED' : 'RETAINED',
      change: `capability:${key}@${ctx.ranAt}`,
      benchmark: { before: score(bench, without), after: score(bench, [...without, key]), problems: bench.length },
      heldOut: { before, after, problems: held.length },
      statement: reverted
        ? `${key}: held-out score ${after} is worse than ${before} without it — reverted`
        : `${key}: held-out score ${after ?? 'insufficient'} vs ${before ?? 'insufficient'} without it — retained`,
    });
  }

  // The highest-leverage capability not yet adopted, judged on the benchmark alone.
  const baseBench = score(bench, adopted);
  let best: { cap: SprintCapability; after: number } | null = null;
  if (baseBench !== null) {
    for (const cap of ctx.library) {
      if (adopted.includes(cap.key)) continue;
      const after = score(bench, [...adopted, cap.key]);
      if (after !== null && baseBench - after > MIN_LEVERAGE && (!best || after < best.after)) best = { cap, after };
    }
  }
  if (best) {
    const before = score(held, adopted);
    const after = score(held, [...adopted, best.cap.key]);
    const verdict: TrialVerdict = before === null || after === null ? 'UNVERIFIED' : after < before ? 'ADOPTED' : 'REJECTED';
    if (verdict === 'ADOPTED') adopted = [...adopted, best.cap.key];
    trials.push({
      capability: best.cap.key,
      title: best.cap.title,
      verdict,
      change: `capability:${best.cap.key}@${ctx.ranAt}`,
      benchmark: { before: baseBench, after: best.after, problems: bench.length },
      heldOut: { before, after, problems: held.length },
      statement:
        `${best.cap.key} (${best.cap.addresses}): benchmark ${baseBench} -> ${best.after}; held-out ${before ?? 'insufficient'} -> ${after ?? 'insufficient'} — ` +
        (verdict === 'ADOPTED' ? 'adopted' : verdict === 'REJECTED' ? 'rejected: it did not improve held-out problems' : 'not adopted: too few held-out problems to verify'),
    });
  }
  const fitted = fitWith(adopted);
  return { adopted, trials, fitted, threshold: adopted.length > 0 ? composedThreshold(bench, fitted, cache) : ctx.threshold };
}

/* ------------------------------------------------------------------------- */
/* Observed owner interventions                                               */
/* ------------------------------------------------------------------------- */

/**
 * Real owner interventions per opening: Needs-You requests and orchestrations parked NEEDS_HUMAN
 * in its project between its creation and its last update — the rows OWNER_INTERVENTIONS_PER_DAY counts.
 */
export async function readOwnerInterventions(problems: readonly SprintProblem[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byProject = new Map<string, SprintProblem[]>();
  for (const p of problems) byProject.set(p.projectId, [...(byProject.get(p.projectId) ?? []), p]);
  const db = getDb();
  for (const [projectId, ps] of byProject) {
    const asks = await db.all<{ at: string }>('SELECT created_at AS at FROM russell_human_requests WHERE project_id = ?', [projectId]);
    const parked = await db.all<{ at: string }>(
      "SELECT updated_at AS at FROM research_orchestrations WHERE project_id = ? AND status = 'NEEDS_HUMAN'",
      [projectId],
    );
    const times = [...asks, ...parked].map((r) => r.at);
    for (const p of ps) out.set(p.id, times.filter((t) => t >= p.createdAt && t <= p.updatedAt).length);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The run                                                                    */
/* ------------------------------------------------------------------------- */

export const SPRINT_EVENT = 'SPRINT_BENCHMARK';
export const SPRINT_INTERVAL_MS = 24 * 3_600_000;
/** How many real problems per run also leave their controller decision and provenance as rows. */
export const DEMONSTRATED_PER_RUN = 5;

export interface SprintRun {
  ranAt: string;
  cutoff: string | null;
  previousCutoff: string | null;
  threshold: number;
  sets: Record<ProblemSet, number>;
  readings: SetReading[];
  comparisons: BaselineComparison[];
  /** The candidate a failed held-out comparison was registered as, when one was. */
  repairCandidateId: string | null;
  /** The candidate the general method's false positives were registered as, when it had any. */
  falsePositiveCandidateId: string | null;
  /** Capabilities composed into the general method after this run, in order. */
  adoptedCapabilities: string[];
  /** Every capability tried, retained, adopted, rejected or reverted this run, each with its linked delta. */
  trials: CapabilityTrial[];
  /** Always present: what the reading is not evidence of. */
  disclaimer: string;
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<PreviousRun | null>;
  interventions?: (problems: readonly SprintProblem[]) => Promise<Map<string, number>>;
  capabilities?: readonly SprintCapability[];
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
  registerDirected?: (weakness: Weakness, now?: Date) => Promise<{ candidate: { id: string } }>;
  now?: () => Date;
}

export const SPRINT_DISCLAIMER =
  'A comparison of two reasoning methods on these production rows. It is not evidence that a general superintelligence can be created, in seven days or otherwise.';

export interface PreviousRun {
  at: string;
  cutoff: string | null;
  /** Capabilities the previous run left adopted; absent on runs before capabilities existed. */
  adopted?: string[];
}

async function previousRun(): Promise<PreviousRun | null> {
  const [last] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
  if (!last) return null;
  const cutoff = typeof last.detail['cutoff'] === 'string' ? (last.detail['cutoff'] as string) : null;
  const raw = last.detail['adoptedCapabilities'];
  const adopted = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  return { at: last.at, cutoff, adopted };
}

export const SPRINT_CAPABILITY_EVENT = 'SPRINT_CAPABILITY_TRIAL';

/** Run the benchmark once: split, tune on the benchmark only, score every set, compare, record. */
export async function runSprintBenchmark(deps: SprintDeps = {}): Promise<SprintRun> {
  const now = (deps.now ?? (() => new Date()))();
  const problems = await (deps.read ?? readSprintProblems)();
  const previous = await (deps.previous ?? previousRun)();
  const previousCutoff = previous?.cutoff ?? null;
  const split = splitProblems(problems, previousCutoff);
  const ranAt = now.toISOString();

  // Implement, then verify: try the highest-leverage capability and keep only what held-out problems confirm.
  const { adopted, trials, fitted, threshold } = trialCapabilities({
    split,
    threshold: chooseThreshold(split.BENCHMARK),
    adopted: previous?.adopted ?? [],
    library: deps.capabilities ?? SPRINT_CAPABILITIES,
    ranAt,
  });
  const generalKey = adopted.length > 0 ? `${GENERAL_METHOD.key}+${adopted.join('+')}` : GENERAL_METHOD.key;
  const observed = await (deps.interventions ?? readOwnerInterventions)(problems);

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = composeVerdicts(ps, threshold, fitted);
    const b = ps.map((p) => BASELINE_METHOD.run(p, threshold));
    generalVerdicts.push(...g);
    const gr = readSet(set, generalKey, ps, g, observed);
    const br = readSet(set, BASELINE_METHOD.key, ps, b, observed);
    readings.push(gr, br);
    comparisons.push(compareWithBaseline(gr, br));
  }

  // The controller and provenance on real problems leave their own rows, through their own recorders.
  const byId = new Map(problems.map((p) => [p.id, p]));
  for (const v of generalVerdicts.slice(0, DEMONSTRATED_PER_RUN)) {
    const projectId = byId.get(v.problemId)?.projectId ?? null;
    if (v.decision) await (deps.recordDecision ?? recordControllerDecision)(v.decision, { projectId, caller: 'intelligence-sprint' });
    if (v.provenance) {
      try {
        await (deps.recordProvenance ?? recordNumberProvenance)(v.provenance, { projectId, caller: 'intelligence-sprint' });
      } catch {
        // A record the toolkit refuses is a finding already counted in method quality, not a run failure.
      }
    }
  }

  // Held-out failure feeds the existing repair path, once per weakness family (registerDirected refreshes an open one).
  let repairCandidateId: string | null = null;
  const failed = comparisons.filter((c) => c.set !== 'BENCHMARK' && c.earned === false);
  if (failed.length > 0) {
    const register = deps.registerDirected ?? (await import('./loop.ts')).registerDirected;
    const fp = failed.flatMap((c) => c.general.falsePositives).slice(0, 5);
    const { candidate } = await register(
      {
        key: 'reasoning-sprint:general-method',
        kind: 'REASONING_CAPABILITY',
        title: 'The general reasoning method did not beat the simple baseline on held-out commercial problems',
        problem: failed.map((c) => c.statement).join(' | ').slice(0, 1000),
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        downstreamMetric: null,
        ownerComponent: 'improvement/sprint',
        mutationScope: ['server/services/research/**', 'server/services/quant/**', 'server/services/improvement/sprint.ts'],
        frequency: failed.reduce((s, c) => s + c.general.problems, 0),
        denominator: problems.length,
        scope: 'GENERAL',
        severity: 'MEDIUM',
        researchQuestion: 'which general reasoning capability would turn more real openings into actionable pathways than a payer-and-price rule',
        samples: fp,
        knownCause: null,
      },
      now,
    );
    repairCandidateId = candidate.id;
  }

  // The general method's false positives are failures even on a run where it beat the baseline.
  let falsePositiveCandidateId: string | null = null;
  const generalReadings = readings.filter((r) => r.method === generalKey);
  const falsePositives = generalReadings.flatMap((r) => r.falsePositives);
  if (falsePositives.length > 0) {
    const register = deps.registerDirected ?? (await import('./loop.ts')).registerDirected;
    const called = generalReadings.reduce((s, r) => s + r.falsePositives.length + r.actionablePathwayRate.numerator, 0);
    const { candidate } = await register(
      {
        key: 'reasoning-sprint:false-positives',
        kind: 'REASONING_CAPABILITY',
        title: 'The general reasoning method called openings actionable that production did not confirm',
        problem:
          `${falsePositives.length} of ${called} actionable calls by ${generalKey} did not become actionable pathways: ` +
          generalReadings.map((r) => `${r.set} ${r.falsePositives.length}`).join(', '),
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        downstreamMetric: null,
        ownerComponent: 'improvement/sprint',
        mutationScope: ['server/services/research/**', 'server/services/quant/**', 'server/services/improvement/sprint.ts'],
        frequency: falsePositives.length,
        denominator: Math.max(1, called),
        scope: 'GENERAL',
        severity: 'MEDIUM',
        researchQuestion: 'which general reasoning check would have refused these actionable calls without refusing the confirmed ones',
        samples: falsePositives.slice(0, 5),
        knownCause: null,
      },
      now,
    );
    falsePositiveCandidateId = candidate.id;
  }

  for (const trial of trials) {
    await (deps.record ?? recordImprovementEvent)({
      candidateId: null,
      kind: SPRINT_CAPABILITY_EVENT,
      at: ranAt,
      detail: { ...trial, threshold, disclaimer: SPRINT_DISCLAIMER },
    });
  }

  const cutoff = problems.reduce<string | null>((m, p) => (m === null || p.createdAt > m ? p.createdAt : m), previousCutoff);
  const run: SprintRun = {
    ranAt,
    cutoff,
    previousCutoff,
    threshold,
    sets: { BENCHMARK: split.BENCHMARK.length, HELD_OUT: split.HELD_OUT.length, NEW_HELD_OUT: split.NEW_HELD_OUT.length },
    readings,
    comparisons: comparisons.map((c) => ({ ...c, general: { ...c.general }, baseline: { ...c.baseline } })),
    repairCandidateId,
    falsePositiveCandidateId,
    adoptedCapabilities: adopted,
    trials,
    disclaimer: SPRINT_DISCLAIMER,
  };
  await (deps.record ?? recordImprovementEvent)({
    candidateId: repairCandidateId,
    kind: SPRINT_EVENT,
    at: run.ranAt,
    detail: {
      cutoff: run.cutoff,
      previousCutoff: run.previousCutoff,
      threshold: run.threshold,
      sets: run.sets,
      readings: run.readings,
      comparisons: run.comparisons.map((c) => ({ set: c.set, earned: c.earned, statement: c.statement })),
      adoptedCapabilities: run.adoptedCapabilities,
      trials: run.trials.map((t) => ({ capability: t.capability, verdict: t.verdict, change: t.change, statement: t.statement })),
      falsePositiveCandidateId: run.falsePositiveCandidateId,
      disclaimer: run.disclaimer,
    },
  });
  return run;
}

/** The tick's entry: run when the last run is older than the interval. */
export async function sprintIfDue(now = new Date(), deps: SprintDeps = {}): Promise<SprintRun | null> {
  const previous = await (deps.previous ?? previousRun)();
  if (previous && now.getTime() - Date.parse(previous.at) < SPRINT_INTERVAL_MS) return null;
  return runSprintBenchmark({ ...deps, previous: async () => previous, now: () => now });
}
