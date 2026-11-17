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
 * Owners reused, none added: rows go to `improvement_events` (the loop's
 * append-only record) and, for the controller and provenance it produced on
 * real problems, to `bin_events` through their own recorders; a held-out
 * result where the general method did not earn its cost becomes a weakness
 * registered through the loop's existing `registerDirected`, which is the one
 * path from a weakness to a Factory objective. It runs from `improvementTick`,
 * at most once per `SPRINT_INTERVAL_MS`, and owns no schedule of its own.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { listImprovementEvents, recordImprovementEvent } from '../../repos/improvement.ts';
import type { Weakness } from '../../domain/improvement.ts';
import {
  SEED_METHODS,
  learnAndRecordProcedures,
  readCatalogue,
  readMethodOutcomes,
  readProcedures,
  type MethodOutcome,
  type MethodSpec,
  type Procedure,
  type ProblemProfile,
} from '../research/methodLibrary.ts';
import {
  decideNext,
  readControllerHistory,
  recordActionResult,
  recordControllerDecision,
  runController,
  type ActionResult,
  type CandidateAction,
  type ControllerDecision,
  type ControllerHistory,
  type ControllerSnapshot,
  type EvidenceItem,
  type PriorDecision,
} from '../research/reasoningController.ts';
import {
  buildNumberProvenance,
  calibrationByKey,
  forecastBias,
  observedRateProvenance,
  probabilityProvenance,
  recordMathSelection,
  recordNumberProvenance,
  selectMathematics,
  type BiasReading,
  type MathQuestion,
  type MathSelection,
  type NumberProvenance,
  type ProvenanceInput,
} from '../quant/mathToolkit.ts';
import { MIN_CALIBRATION_SAMPLE, type CalibrationBucket, type OutcomeRow, type PredictionRow } from '../quant/forecast.ts';
import type { Figure } from '../quant/graph.ts';
import type { sendNeeds } from '../quant/needs.ts';

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
  /** The method could not progress without a person. */
  needsPerson: boolean;
  /** Its actionable verdict survives the adverse alternatives of its own numbers. */
  robust: boolean;
  /** Weak inferences and provenance refusals it found or committed. */
  findings: number;
  elapsedMs: number;
  decision?: ControllerDecision;
  provenance?: NumberProvenance | null;
}

/** What the general method has learned so far, and — for a problem it decided before — that decision and its results. */
export interface MethodContext {
  catalogue?: readonly MethodSpec[];
  outcomes?: readonly MethodOutcome[];
  prior?: PriorDecision | null;
  results?: readonly ActionResult[];
  now?: string;
}

export interface SprintMethod {
  key: string;
  run(problem: SprintProblem, threshold: number, context?: MethodContext): MethodVerdict;
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

/* ------------------------------------------------------------------------- */
/* Per-question mathematics, forecasts against realized results               */
/* ------------------------------------------------------------------------- */

/** method key -> opening id -> the probability that method gave the opening on one run. */
export type SprintForecasts = Record<string, Record<string, number>>;

export interface PriorForecastRun {
  at: string;
  forecasts: SprintForecasts;
}

/** Whether production has settled an opening: true it became actionable, false it died, null not yet. */
export function resolutionOf(p: Pick<SprintProblem, 'state'>): boolean | null {
  if (actionableInProduction(p)) return true;
  if (DEAD_STATES.has(p.state)) return false;
  return null;
}

/** Each method's probability for every opening production has not settled yet: next run's forecasts to resolve. */
export function forecastsOf(problems: readonly SprintProblem[], verdicts: Readonly<Record<string, readonly MethodVerdict[]>>): SprintForecasts {
  const open = new Set(problems.filter((p) => resolutionOf(p) === null).map((p) => p.id));
  const out: SprintForecasts = {};
  for (const [method, list] of Object.entries(verdicts)) {
    const one: Record<string, number> = {};
    for (const v of list) if (open.has(v.problemId)) one[v.problemId] = v.probability;
    out[method] = one;
  }
  return out;
}

/** The outcome every sprint forecast is a claim about. */
export const SPRINT_FORECAST_OUTCOME = 'the opening becomes an actionable transaction pathway in production';

/**
 * The sprint's own forecasts as ledger rows: each method's earliest forecast on
 * an opening that was open when it was made, resolved by what production did to
 * that opening since. Comparable bucket = the method, so each method is judged
 * against realized results on its own record.
 */
export function sprintForecastLedger(
  prior: readonly PriorForecastRun[],
  problems: readonly SprintProblem[],
  now: Date,
): { predictions: PredictionRow[]; outcomes: OutcomeRow[] } {
  const byId = new Map(problems.map((p) => [p.id, p]));
  const earliest = new Map<string, { method: string; problemId: string; probability: number; at: string }>();
  for (const run of prior) {
    for (const [method, list] of Object.entries(run.forecasts ?? {})) {
      for (const [problemId, probability] of Object.entries(list ?? {})) {
        if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) continue;
        const claimId = `${method}|${problemId}`;
        const held = earliest.get(claimId);
        if (!held || run.at < held.at) earliest.set(claimId, { method, problemId, probability, at: run.at });
      }
    }
  }
  const predictions: PredictionRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (const [claimId, f] of [...earliest].sort(([a], [b]) => a.localeCompare(b))) {
    const id = `${claimId}|${f.at}`;
    predictions.push({
      id,
      claimId,
      version: 1,
      outcome: SPRINT_FORECAST_OUTCOME,
      horizonDays: null,
      population: 'cash_opportunities',
      data: [`cash_opportunities:${f.problemId}`],
      assumptions: [],
      probability: f.probability,
      comparableKey: f.method,
      madeAt: f.at,
    });
    const p = byId.get(f.problemId);
    const occurred = p ? resolutionOf(p) : null;
    if (occurred !== null) outcomes.push({ predictionId: id, observedAt: now.toISOString(), occurred, evidence: `cash_opportunities:${f.problemId}` });
  }
  return { predictions, outcomes };
}

/**
 * The economic question one opening poses, with the candidate mathematics and
 * what the opening's own row and the sprint's resolved forecasts say about each
 * method's preconditions. The families are the ones these questions touch; the
 * toolkit judges fitness per case, and an unknown never makes one fit.
 */
export function mathQuestionOf(p: SprintProblem, resolvedForecasts: number): MathQuestion {
  const row = `cash_opportunities:${p.id}`;
  const source = sourceOf(p);
  const unknowns = LOAD_BEARING.filter((f) => !known(p, f));
  return {
    question: `What does one transaction bill, and how likely is "${p.title}" to become an actionable pathway?`.slice(0, 300),
    subject: row,
    candidates: [
      {
        family: 'cash_flow_identities',
        purpose: 'gross billed per transaction as an identity over the sourced price',
        preconditions: [
          { condition: 'a price is stated', state: known(p, 'priceCents') ? 'HOLDS' : 'UNKNOWN', evidence: known(p, 'priceCents') ? [`${row}:priceCents`] : [] },
          { condition: 'the price has a source', state: source ? 'HOLDS' : 'FAILS', evidence: [source ?? `${row}:no source`] },
        ],
      },
      {
        family: 'statistical_estimation_calibration',
        purpose: "judge the method's probability against realized outcomes of comparable forecasts",
        preconditions: [
          {
            condition: `at least ${MIN_CALIBRATION_SAMPLE} comparable forecasts have resolved`,
            state: resolvedForecasts >= MIN_CALIBRATION_SAMPLE ? 'HOLDS' : 'FAILS',
            evidence: [`sprint-forecasts:${resolvedForecasts} resolved`],
          },
        ],
      },
      {
        family: 'value_of_information_experimental_design',
        purpose: 'which unknown is worth researching before deciding',
        preconditions: [
          {
            condition: 'a load-bearing input is unknown',
            state: unknowns.length > 0 ? 'HOLDS' : 'FAILS',
            evidence: unknowns.length > 0 ? unknowns.map((f) => `${row}:${f} unknown`) : [`${row}: every load-bearing field stated`],
          },
        ],
      },
      {
        family: 'time_to_event_settlement',
        purpose: 'when the cash arrives under the stated terms',
        preconditions: [
          { condition: 'payment terms are stated', state: known(p, 'paymentTerms') ? 'HOLDS' : 'UNKNOWN', evidence: known(p, 'paymentTerms') ? [`${row}:paymentTerms`] : [] },
        ],
      },
    ],
  };
}

/**
 * The controller's snapshot of one opening: the card's evidence, the learned
 * catalogue and method outcomes, and — when the controller decided this
 * opening before — its prior decision and the results tracked against it, so
 * a contradicted result changes the method.
 */
export function controllerSnapshotOf(p: SprintProblem, context: MethodContext = {}): ControllerSnapshot {
  const { profile, unknowns, evidence, actions } = profileOf(p);
  return {
    problem: profile,
    knowledge: null,
    mechanism: null,
    catalogue: context.catalogue ?? SEED_METHODS,
    outcomes: context.outcomes ?? [],
    hypotheses: [
      { id: HOLDS, statement: `"${p.title}" is an actionable pathway`, basis: 'given:holds' },
      { id: FAILS, statement: `"${p.title}" fails at an unknown load-bearing field`, basis: 'given:fails' },
    ],
    evidence: [...evidence, ...unknowns.map((f): EvidenceItem => ({ id: `${p.id}:${f}:unknown`, source: sourceOf(p), bears: { [FAILS]: 'SUPPORTS', [HOLDS]: 'REFUTES' } }))],
    actions,
    prior: context.prior ?? null,
    results: context.results ?? [],
    now: context.now ?? p.updatedAt,
  };
}

/** States that mean the opening will not become a pathway. */
export const DEAD_STATES: ReadonlySet<string> = new Set(['DECLINED', 'ARCHIVED']);

/**
 * What production now says about a hypothesis the controller led with: the
 * opening became a pathway, or it died. Null while production has not said.
 * Read from the row's state, never from either method's opinion.
 */
export function productionOutcome(p: Pick<SprintProblem, 'state'>, hypothesisId: string): ActionResult['outcome'] | null {
  const holds = hypothesisId === HOLDS || hypothesisId.startsWith('holds:');
  const fails = hypothesisId === FAILS || hypothesisId.startsWith('fails:');
  if (!holds && !fails) return null;
  if (ACTIONABLE_STATES.has(p.state)) return holds ? 'CONFIRMED' : 'CONTRADICTED';
  if (DEAD_STATES.has(p.state)) return holds ? 'CONTRADICTED' : 'CONFIRMED';
  return null;
}

/**
 * The result to track for a problem the controller decided before: only when
 * the row changed after that decision and production has now said, and only
 * once per decision.
 */
export function pendingResult(p: SprintProblem, history: ControllerHistory | undefined): ActionResult | null {
  if (!history?.prior.leadingHypothesis) return null;
  if (!(p.updatedAt > history.decidedAt)) return null;
  if (history.results.some((r) => r.decisionAt === history.decidedAt)) return null;
  const outcome = productionOutcome(p, history.prior.leadingHypothesis);
  if (!outcome) return null;
  return {
    actionKey: `production-state:${p.id}`,
    hypothesisId: history.prior.leadingHypothesis,
    outcome,
    evidence: `cash_opportunities:${p.id}#state=${p.state}`,
    at: p.updatedAt,
    decisionAt: history.decidedAt,
  };
}

/** The general method: the controller over the card, with the gross billed carried with its provenance. */
export const GENERAL_METHOD: SprintMethod = {
  key: 'general:controller+provenance',
  run(p, threshold, context) {
    const started = performance.now();
    const { unknowns } = profileOf(p);
    const decision = decideNext(controllerSnapshotOf(p, context));
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
  /** Problems the method could not progress without a person, over the set. */
  humanInterventions: Measure;
  /** Brier score: summed squared error of the probability against what happened, over the set. Lower is better. */
  calibrationBrier: Measure;
  /** Actually actionable problems the method called actionable robustly, over actually actionable problems. */
  robustTargetCoverage: Measure;
  /** Called actionable, production says not: the failures fed to repair. */
  falsePositives: string[];
}

export function readSet(set: ProblemSet, method: string, problems: readonly SprintProblem[], verdicts: readonly MethodVerdict[]): SetReading {
  const truth = new Map(problems.map((p) => [p.id, actionableInProduction(p)]));
  const n = verdicts.length;
  const tp = verdicts.filter((v) => v.actionable && truth.get(v.problemId)).length;
  const clean = verdicts.filter((v) => v.findings === 0).length;
  const time = verdicts.reduce((s, v) => s + v.elapsedMs, 0);
  const people = verdicts.filter((v) => v.needsPerson).length;
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
    humanInterventions: measure(people, n),
    calibrationBrier: measure(brier, n),
    robustTargetCoverage: measure(covered, targets.length),
    falsePositives: verdicts.filter((v) => v.actionable && !truth.get(v.problemId)).map((v) => v.problemId),
  };
}

/**
 * The method's one tuned choice, made on the benchmark set only: the
 * probability threshold with the lowest misclassification there.
 */
export function chooseThreshold(benchmark: readonly SprintProblem[], method: SprintMethod = GENERAL_METHOD, context?: MethodContext): number {
  const candidates = [0.5, 0.6, 0.7, 0.8, 0.9];
  let best = candidates[0]!;
  let bestErrors = Infinity;
  for (const t of candidates) {
    const errors = benchmark.filter((p) => method.run(p, t, context).actionable !== actionableInProduction(p)).length;
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
  const g = { rate: num(general.actionablePathwayRate), brier: num(general.calibrationBrier), people: num(general.humanInterventions) };
  const b = { rate: num(baseline.actionablePathwayRate), brier: num(baseline.calibrationBrier), people: num(baseline.humanInterventions) };
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
      `${general.set}: pathway rate ${g.rate} vs ${b.rate}, Brier ${g.brier} vs ${b.brier}, people ${g.people} vs ${b.people}, at ${cost} — ` +
      (earned ? 'the extra complexity earned its cost' : 'the extra complexity did not earn its cost on this set'),
    general,
    baseline,
  };
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
  /** The controller's operational loop on real openings this run. */
  loop: SprintLoop;
  /** The per-question mathematics and per-number provenance this run recorded. */
  math: SprintMath;
  /** Always present: what the reading is not evidence of. */
  disclaimer: string;
}

/** What the run did with the toolkit: selections judged, numbers recorded with provenance, forecasts compared with results. */
export interface SprintMath {
  /** Openings whose numbers are material this run: demonstrated, or actionable by either method or in production. */
  material: number;
  /** Material openings beyond the per-run bound, counted rather than silently dropped. */
  materialSkipped: number;
  selections: number;
  provenanceRecorded: number;
  provenanceRefused: number;
  /** Forecasts from earlier runs that production has since settled. */
  forecastsResolved: number;
  /** Probabilities recorded with the measured systematic error corrected. */
  correctionsApplied: number;
  bias: BiasReading[];
  errors: string[];
}

/** The most openings one run records selections and provenance for. */
export const MAX_MATERIAL_PER_RUN = 500;
/** How many earlier runs' forecasts are compared with what happened since. */
export const FORECAST_RUNS_READ = 30;

/** What the controller's loop did this run: results tracked, decisions taken, methods changed, actions handed off. */
export interface SprintLoop {
  resultsTracked: number;
  decisions: number;
  methodChanges: number;
  capabilityGaps: number;
  handOffs: Record<string, number>;
  proceduresRecorded: number;
  errors: string[];
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<{ at: string; cutoff: string | null } | null>;
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
  recordSelection?: typeof recordMathSelection;
  /** Earlier runs' forecasts, to compare with what production did since. */
  priorForecasts?: () => Promise<PriorForecastRun[]>;
  registerDirected?: (weakness: Weakness, now?: Date) => Promise<{ candidate: { id: string } }>;
  now?: () => Date;
  /** What the method library has learned: the catalogue, outcomes and procedures recorded so far. */
  learning?: () => Promise<{ catalogue: MethodSpec[]; outcomes: MethodOutcome[]; procedures: Procedure[] }>;
  /** The controller's own earlier decisions and results on these openings. */
  history?: () => Promise<Map<string, ControllerHistory>>;
  recordResult?: typeof recordActionResult;
  recordProcedure?: (procedure: Procedure) => Promise<void>;
  /** The research owner the controller hands a RESEARCH action to. */
  sendNeeds?: typeof sendNeeds;
}

export const SPRINT_CALLER = 'intelligence-sprint';

async function readLearning(): Promise<{ catalogue: MethodSpec[]; outcomes: MethodOutcome[]; procedures: Procedure[] }> {
  const [catalogue, outcomes, procedures] = await Promise.all([readCatalogue(), readMethodOutcomes(), readProcedures()]);
  return { catalogue, outcomes, procedures };
}

/**
 * Which openings the loop runs on this time: every one with a result to track
 * first (so the loop closes), then undecided openings the controller has not
 * decided yet, newest first, up to the per-run demonstration count.
 */
export function chooseDemonstrated(
  problems: readonly SprintProblem[],
  history: ReadonlyMap<string, ControllerHistory>,
  limit = DEMONSTRATED_PER_RUN,
): { problem: SprintProblem; result: ActionResult | null }[] {
  const out: { problem: SprintProblem; result: ActionResult | null }[] = [];
  for (const p of problems) {
    const result = pendingResult(p, history.get(p.id));
    if (result) out.push({ problem: p, result });
  }
  const open = problems
    .filter((p) => !history.has(p.id) && !ACTIONABLE_STATES.has(p.state) && !DEAD_STATES.has(p.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
  for (const p of open) {
    if (out.length >= Math.max(limit, 0)) break;
    out.push({ problem: p, result: null });
  }
  return out;
}

export const SPRINT_DISCLAIMER =
  'A comparison of two reasoning methods on these production rows. It is not evidence that a general superintelligence can be created, in seven days or otherwise.';

async function readPriorForecasts(): Promise<PriorForecastRun[]> {
  const events = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: FORECAST_RUNS_READ });
  return events
    .map((e) => ({ at: e.at, forecasts: e.detail['forecasts'] }))
    .filter((r): r is PriorForecastRun => !!r.forecasts && typeof r.forecasts === 'object')
    .map((r) => ({ at: r.at, forecasts: r.forecasts }));
}

async function previousRun(): Promise<{ at: string; cutoff: string | null } | null> {
  const [last] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
  if (!last) return null;
  const cutoff = typeof last.detail['cutoff'] === 'string' ? (last.detail['cutoff'] as string) : null;
  return { at: last.at, cutoff };
}

/** Run the benchmark once: split, tune on the benchmark only, score every set, compare, record. */
export async function runSprintBenchmark(deps: SprintDeps = {}): Promise<SprintRun> {
  const now = (deps.now ?? (() => new Date()))();
  const problems = await (deps.read ?? readSprintProblems)();
  const previous = await (deps.previous ?? previousRun)();
  const previousCutoff = previous?.cutoff ?? null;
  const split = splitProblems(problems, previousCutoff);
  const learning = await (deps.learning ?? readLearning)();
  const outcomes: MethodOutcome[] = [...learning.outcomes];
  const learned: MethodContext = { catalogue: learning.catalogue.length > 0 ? learning.catalogue : SEED_METHODS, outcomes };
  const threshold = chooseThreshold(split.BENCHMARK, GENERAL_METHOD, learned);

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  const baselineVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = ps.map((p) => GENERAL_METHOD.run(p, threshold, learned));
    const b = ps.map((p) => BASELINE_METHOD.run(p, threshold));
    generalVerdicts.push(...g);
    baselineVerdicts.push(...b);
    const gr = readSet(set, GENERAL_METHOD.key, ps, g);
    const br = readSet(set, BASELINE_METHOD.key, ps, b);
    readings.push(gr, br);
    comparisons.push(compareWithBaseline(gr, br));
  }

  // The controller's operational loop on real openings: track what production said about an earlier
  // decision (a row, and a method outcome the library learns from), decide again with that result —
  // a contradicted one changes the method — record the decision, and hand the next action to its owner.
  const verdictOf = new Map(generalVerdicts.map((v) => [v.problemId, v]));
  const baselineOf = new Map(baselineVerdicts.map((v) => [v.problemId, v]));
  const history = await (deps.history ?? (() => readControllerHistory(SPRINT_CALLER)))();
  const loop: SprintLoop = { resultsTracked: 0, decisions: 0, methodChanges: 0, capabilityGaps: 0, handOffs: {}, proceduresRecorded: 0, errors: [] };
  const demonstrated = chooseDemonstrated(problems, history);
  for (const { problem: p, result } of demonstrated) {
    const prior = history.get(p.id);
    const projectId = p.projectId ?? null;
    try {
      if (result && prior) {
        await (deps.recordResult ?? recordActionResult)(
          result,
          { problemId: p.id, method: prior.prior.methodId ? { methodId: prior.prior.methodId } : null },
          profileOf(p).profile,
          { projectId, caller: SPRINT_CALLER },
        );
        loop.resultsTracked += 1;
        if (prior.prior.methodId && result.outcome !== 'INCONCLUSIVE') {
          outcomes.push({
            methodId: prior.prior.methodId,
            problemId: p.id,
            domain: profileOf(p).profile.domain,
            features: profileOf(p).profile.features.map((f) => f.feature),
            succeeded: result.outcome === 'CONFIRMED',
            errorClass: result.outcome === 'CONTRADICTED' ? 'hypothesis-contradicted' : null,
            at: result.at,
          });
        }
      }
      const snapshot = controllerSnapshotOf(p, {
        ...learned,
        prior: prior?.prior ?? null,
        results: [...(prior?.results ?? []), ...(result ? [result] : [])],
        now: now.toISOString(),
      });
      const { decision, handOff: handed } = await runController(
        snapshot,
        { projectId, actorRef: SPRINT_CALLER },
        {
          caller: SPRINT_CALLER,
          projectId,
          recordDecision: deps.recordDecision,
          sendNeeds: deps.sendNeeds,
        },
      );
      loop.decisions += 1;
      if (decision.methodChange) loop.methodChanges += 1;
      if (decision.capabilityGap) loop.capabilityGaps += 1;
      loop.handOffs[handed.to] = (loop.handOffs[handed.to] ?? 0) + 1;
    } catch (error) {
      loop.errors.push(`${p.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }

  // Per-question mathematics and per-number provenance on every material opening, with each
  // method's probabilities judged against what production did to its earlier forecasts.
  const math = await recordSprintMathematics({
    problems,
    demonstrated: demonstrated.map((d) => d.problem),
    general: verdictOf,
    baseline: baselineOf,
    now,
    deps,
  });
  try {
    loop.proceduresRecorded = (
      await learnAndRecordProcedures(outcomes, learning.procedures, {
        caller: SPRINT_CALLER,
        recordProcedure: deps.recordProcedure ? async (p) => deps.recordProcedure!(p) : undefined,
      })
    ).length;
  } catch (error) {
    loop.errors.push(`procedures: ${String((error as Error).message ?? error).slice(0, 200)}`);
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

  const cutoff = problems.reduce<string | null>((m, p) => (m === null || p.createdAt > m ? p.createdAt : m), previousCutoff);
  const run: SprintRun = {
    ranAt: now.toISOString(),
    cutoff,
    previousCutoff,
    threshold,
    sets: { BENCHMARK: split.BENCHMARK.length, HELD_OUT: split.HELD_OUT.length, NEW_HELD_OUT: split.NEW_HELD_OUT.length },
    readings,
    comparisons: comparisons.map((c) => ({ ...c, general: { ...c.general }, baseline: { ...c.baseline } })),
    repairCandidateId,
    loop,
    math,
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
      loop: run.loop,
      math: { ...run.math, bias: run.math.bias.map((b) => ({ ...b })) },
      forecasts: forecastsOf(problems, { [GENERAL_METHOD.key]: generalVerdicts, [BASELINE_METHOD.key]: baselineVerdicts }),
      disclaimer: run.disclaimer,
    },
  });
  return run;
}

/**
 * Judge the mathematics each material opening's question needs and record the
 * judgment; record, with provenance, the gross billed where the cash-flow
 * identity was judged fit and both methods' probabilities corrected for the
 * systematic error their earlier forecasts showed against realized results;
 * and record each judged bucket's observed rate. A record the toolkit refuses
 * is counted, never written and never a run failure.
 */
export async function recordSprintMathematics(input: {
  problems: readonly SprintProblem[];
  demonstrated: readonly SprintProblem[];
  general: ReadonlyMap<string, MethodVerdict>;
  baseline: ReadonlyMap<string, MethodVerdict>;
  now: Date;
  deps: SprintDeps;
}): Promise<SprintMath> {
  const { problems, general, baseline, now, deps } = input;
  const at = now.toISOString();
  const math: SprintMath = {
    material: 0, materialSkipped: 0, selections: 0, provenanceRecorded: 0, provenanceRefused: 0,
    forecastsResolved: 0, correctionsApplied: 0, bias: [], errors: [],
  };
  let prior: PriorForecastRun[] = [];
  try {
    prior = await (deps.priorForecasts ?? readPriorForecasts)();
  } catch (error) {
    math.errors.push(`forecasts: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  const { predictions, outcomes } = sprintForecastLedger(prior, problems, now);
  math.forecastsResolved = outcomes.length;
  math.bias = forecastBias(predictions, [], outcomes);
  const buckets: Map<string, CalibrationBucket> = calibrationByKey(predictions, [], outcomes);
  const biasOf = new Map(math.bias.filter((b) => b.basis === 'PROBABILITY').map((b) => [b.comparableKey, b]));
  const resolvedBy = new Map<string, number>();
  for (const pr of predictions) if (outcomes.some((o) => o.predictionId === pr.id)) resolvedBy.set(pr.comparableKey, (resolvedBy.get(pr.comparableKey) ?? 0) + 1);

  const record = deps.recordProvenance ?? recordNumberProvenance;
  const write = async (built: { ok: true; record: NumberProvenance } | { ok: false; missing: string[]; problems: string[] } | null, projectId: string | null): Promise<void> => {
    if (!built) return;
    if (!built.ok) {
      math.provenanceRefused += 1;
      return;
    }
    try {
      await record(built.record, { projectId, caller: SPRINT_CALLER });
      math.provenanceRecorded += 1;
    } catch {
      math.provenanceRefused += 1;
    }
  };

  const material: SprintProblem[] = [];
  const seen = new Set<string>();
  const consider = (p: SprintProblem): void => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    if (material.length >= MAX_MATERIAL_PER_RUN) math.materialSkipped += 1;
    else material.push(p);
  };
  for (const p of input.demonstrated) consider(p);
  for (const p of problems) {
    if (general.get(p.id)?.actionable || baseline.get(p.id)?.actionable || actionableInProduction(p)) consider(p);
  }
  math.material = material.length;

  for (const p of material) {
    const projectId = p.projectId ?? null;
    let selection: MathSelection;
    try {
      selection = selectMathematics(mathQuestionOf(p, resolvedBy.get(GENERAL_METHOD.key) ?? 0));
      await (deps.recordSelection ?? recordMathSelection)(selection, { projectId, caller: SPRINT_CALLER });
      math.selections += 1;
    } catch (error) {
      math.errors.push(`${p.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
      continue;
    }
    const v = general.get(p.id);
    if (selection.selected.includes('cash_flow_identities')) {
      const billed = v?.provenance ?? grossBilledProvenance(p).record;
      if (billed) await write({ ok: true, record: billed }, projectId);
      else math.provenanceRefused += 1;
    }
    const calibrated = selection.selected.includes('statistical_estimation_calibration');
    const horizon = p.deadline ? `until ${p.deadline}` : 'until production settles the opening';
    for (const [method, verdict, ref] of [
      [GENERAL_METHOD.key, v, `controller-decision:${p.id}@${at}`],
      [BASELINE_METHOD.key, baseline.get(p.id), `rule:${BASELINE_METHOD.key}@${at}`],
    ] as const) {
      if (!verdict) continue;
      const { result, corrected } = probabilityProvenance(
        {
          key: `p-actionable:${method}:${p.id}`,
          definition: `probability that ${p.id} ${SPRINT_FORECAST_OUTCOME}, by ${method}`,
          probability: verdict.probability,
          method: calibrated ? 'statistical_estimation_calibration' : method,
          source: { ref, retrievedAt: at },
          horizon,
          evidence: [`cash_opportunities:${p.id}`, `method:${method}`],
          interdependence: p.payer ? [`payer:${p.payer}`] : [],
        },
        { bias: biasOf.get(method) ?? null, bucket: buckets.get(method) ?? null, measuredAt: at },
      );
      if (corrected) math.correctionsApplied += 1;
      await write(result, projectId);
    }
  }
  for (const bucket of buckets.values()) {
    if (bucket.n < MIN_CALIBRATION_SAMPLE) continue;
    await write(observedRateProvenance(bucket, { ref: `sprint-forecasts:${bucket.comparableKey}@${at}`, retrievedAt: at }), null);
  }
  return math;
}

/** The tick's entry: run when the last run is older than the interval. */
export async function sprintIfDue(now = new Date(), deps: SprintDeps = {}): Promise<SprintRun | null> {
  const previous = await (deps.previous ?? previousRun)();
  if (previous && now.getTime() - Date.parse(previous.at) < SPRINT_INTERVAL_MS) return null;
  return runSprintBenchmark({ ...deps, previous: async () => previous, now: () => now });
}
