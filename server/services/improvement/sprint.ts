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
  MECHANISM_HOLDS,
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
  type PriorDecision,
} from '../research/reasoningController.ts';
import { MECHANISM_ROLES, loadProjectKnowledge, mechanismFromOpening, type KnowledgeReading, type MechanismModel, type MechanismRole } from '../research/knowledgeModel.ts';
import {
  buildNumberProvenance,
  rateProvenance,
  recordMathSelection,
  recordNumberProvenance,
  selectMathematics,
  unknownInput,
  countFigure,
  type Expr,
  type MathSelection,
  type NumberProvenance,
  type ProvenanceInput,
} from '../quant/mathToolkit.ts';
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
  /** Layer 1: the opening's project knowledge, read from its research claims. */
  knowledge?: KnowledgeReading | null;
  /** Layer 2: the opening's transaction modelled as a mechanism over that knowledge. */
  mechanism?: MechanismModel | null;
  /** The baseline's base rates, fitted on the benchmark set alone (`fitBaselineRates`). */
  baseRates?: BaseRates | null;
}

/** One fitted base rate: the probability the baseline states, and where it came from. */
export interface BaseRate {
  /** The fitted rate, or the uninformed 0.5 when the benchmark holds no case of this kind (stated in the provenance as unknown). */
  probability: number;
  provenance: NumberProvenance | null;
  hits: number;
  considered: number;
}

export interface BaseRates {
  withPayerAndPrice: BaseRate;
  without: BaseRate;
}

/**
 * The baseline's probabilities are measured, not chosen: the share of
 * benchmark openings of each kind (payer and price stated, or not) that
 * production shows became actionable, each with its provenance. Fitted on the
 * benchmark alone, so held-out sets never tune the baseline either. A kind
 * the benchmark holds no case of is unknown, and the baseline says 0.5 —
 * the uninformed prior — rather than a convenient figure.
 */
export function fitBaselineRates(benchmark: readonly SprintProblem[], retrievedAt: string): BaseRates {
  const fit = (withFields: boolean): BaseRate => {
    const cases = benchmark.filter((p) => (known(p, 'payer') && known(p, 'priceCents')) === withFields);
    const hits = cases.filter(actionableInProduction).length;
    const definition = withFields
      ? 'a benchmark opening with payer and price stated became an actionable pathway'
      : 'a benchmark opening without payer and price became an actionable pathway';
    const built = rateProvenance({
      key: `sprint-baseline:${withFields ? 'payer-and-price' : 'missing-payer-or-price'}`,
      definition,
      hits,
      considered: cases.length,
      source: `cash_opportunities:sprint-benchmark(${cases.length} row(s), state in ${[...ACTIONABLE_STATES].join('/')})`,
      retrievedAt,
      horizon: `production state as of ${retrievedAt}`,
      applicability: {
        method: 'base rate (frequency estimate) over the benchmark split',
        evidence: [`${cases.length} benchmark opening(s) of this kind, ${hits} actionable in production`],
      },
      interdependence: ['the same benchmark rows also tune the general method’s threshold'],
    });
    const record = built.ok ? built.record : null;
    return { probability: record?.value ?? 0.5, provenance: record, hits, considered: cases.length };
  };
  return { withPayerAndPrice: fit(true), without: fit(false) };
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

/**
 * The simpler baseline: a payer and a price make a pathway. Its probability is
 * the base rate fitted on the benchmark for that kind of opening
 * (`fitBaselineRates`), carried with its provenance; without fitted rates it
 * states the uninformed 0.5, never a chosen figure.
 */
export const BASELINE_METHOD: SprintMethod = {
  key: 'baseline:payer-and-price',
  run(p, _threshold, context) {
    const started = performance.now();
    const actionable = known(p, 'payer') && known(p, 'priceCents');
    const rate = context?.baseRates ? (actionable ? context.baseRates.withPayerAndPrice : context.baseRates.without) : null;
    return {
      problemId: p.id,
      actionable,
      probability: rate?.probability ?? 0.5,
      needsPerson: !actionable,
      robust: actionable,
      findings: 0,
      elapsedMs: performance.now() - started,
      provenance: rate?.provenance ?? null,
    };
  },
};

/** Hypothesis ids decisions recorded before hypotheses were generated from the mechanism; still read from history. */
const LEGACY_HOLDS = 'pathway-holds';
const LEGACY_FAILS = 'pathway-fails';

/** The mechanism role each load-bearing card field states; acceptance has no checklist role. */
export const FIELD_ROLE: Readonly<Record<LoadBearing, MechanismRole | null>> = {
  payer: 'initiator',
  reachableChannel: 'access',
  buyingSignal: 'trigger',
  acceptanceCondition: null,
  priceCents: 'moneyMovement',
  paymentTerms: 'moneyMovement',
  fulfillmentOwner: 'deliverer',
};

/**
 * The problem as the controller sees it: its features and its open unknowns,
 * with one research action per unknown card field. A card field is not
 * evidence: whether the transaction holds is weighed only on the research
 * claims the mechanism model cites (`mechanismHypotheses` in the controller).
 */
export function profileOf(p: SprintProblem): { profile: ProblemProfile; unknowns: LoadBearing[]; actions: CandidateAction[] } {
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
  const actions: CandidateAction[] = unknowns.map((f) => {
    const role = FIELD_ROLE[f];
    return {
      key: `${p.id}:${f}`,
      kind: 'RESEARCH',
      subject: `${f} of ${p.title}`.slice(0, 200),
      question: `What is the ${f} for "${p.title}"?`.slice(0, 300),
      resolves: f,
      discriminates: role ? [MECHANISM_HOLDS, `fails:${role}`] : [MECHANISM_HOLDS],
      cost: 0.01,
    };
  });
  return {
    profile: { id: p.id, domain: p.industry ?? p.mechanism, question: `Is "${p.title}" an actionable transaction pathway?`, features, available },
    unknowns,
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

/**
 * The provenance of the general method's probability for one opening. It is
 * the controller's Laplace score of the mechanism holding, (s+1)/(s+r+2) over
 * the sourced evidence that supports (s) or refutes (r) it, times, for each
 * load-bearing role still unresolved, one minus the score of that role's
 * counter-model. A role no counter-model reads is an unknown input — the
 * method uses the uninformed 0.5 there, and the provenance says the
 * probability is therefore unknown rather than presenting it as measured.
 */
export function generalProbabilityProvenance(p: SprintProblem, decision: ControllerDecision, retrievedAt: string): { record: NumberProvenance | null; findings: number } {
  const inputs: ProvenanceInput[] = [];
  const counts = (prefix: string, h: { id: string; supports: string[]; refutes: string[] }): Expr => {
    const ref = `controller:${p.id}:${h.id}`;
    const sup = `${prefix}.supports`;
    const ref2 = `${prefix}.refutes`;
    inputs.push({ key: sup, figure: countFigure(`sourced evidence supporting ${h.id}`, h.supports.length, `${ref} [${h.supports.join(', ')}]`.slice(0, 300), p.id), source: { ref, retrievedAt } });
    inputs.push({ key: ref2, figure: countFigure(`sourced evidence refuting ${h.id}`, h.refutes.length, `${ref} [${h.refutes.join(', ')}]`.slice(0, 300), p.id), source: { ref, retrievedAt } });
    return { op: '/', args: [{ op: '+', args: [{ ref: sup }, { const: 1, unit: 'count' }] }, { op: '+', args: [{ ref: sup }, { ref: ref2 }, { const: 2, unit: 'count' }] }] };
  };
  const factors: Expr[] = [];
  const holds = decision.hypotheses.find((h) => h.id === MECHANISM_HOLDS) ?? null;
  if (holds) factors.push(counts('holds', holds));
  else {
    inputs.push(unknownInput('holds', 'the mechanism-holds score', 'probability'));
    factors.push({ ref: 'holds' });
  }
  const { unknowns } = profileOf(p);
  for (const key of new Set(unknowns.map((f) => FIELD_ROLE[f] ?? f))) {
    const counter = decision.hypotheses.find((h) => h.id === `fails:${key}`);
    if (counter) factors.push({ op: '-', args: [{ const: 1 }, counts(`fails_${key}`, counter)] });
    else {
      inputs.push(unknownInput(`uninformed_${key}`, `whether ${key} holds, with no counter-model reading it`, 'probability'));
      factors.push({ ref: `uninformed_${key}` });
    }
  }
  const formula: Expr = factors.length === 1 ? factors[0]! : { op: '*', args: factors };
  const supportKeys = inputs.filter((i) => i.key.endsWith('.supports')).map((i) => i.key);
  const built = buildNumberProvenance({
    key: `sprint-general-probability:${p.id}`,
    quantity: { kind: 'PROBABILITY', definition: `that "${p.title}" is an actionable transaction pathway`.slice(0, 240) },
    units: 'probability',
    horizon: p.deadline ? `until ${p.deadline}` : 'until the opening is decided in production',
    formula,
    inputs,
    alternatives: supportKeys.length > 0
      ? [
          { label: 'one more supporting source on each hypothesis', parameters: Object.fromEntries(supportKeys.map((k) => [k, (inputs.find((i) => i.key === k)!.figure.value ?? 0) + 1])) },
          { label: 'no supporting source at all', parameters: Object.fromEntries(supportKeys.map((k) => [k, 0])) },
        ]
      : [{ label: 'no evidence read: unknown', parameters: {} }],
    interdependence: ['the mechanism-holds and counter-model scores are read from the same research claims of the opening’s project'],
    applicability: {
      method: 'Laplace-smoothed evidence share per hypothesis (reasoningController), multiplied across independent load-bearing roles',
      evidence: [`controller decision on ${p.id}: ${decision.hypotheses.length} hypothesis(es), ${decision.weakInferences.length} weak inference(s)`],
    },
    form: 'PROBABILITY',
  });
  if (built.ok) return { record: built.record, findings: 0 };
  return { record: null, findings: built.missing.length + built.problems.length };
}

/**
 * The method selection for the sprint's own question, judged from the
 * benchmark it has: a base rate fits only with enough benchmark cases;
 * evidence-weighted hypothesis scoring fits only when the controller read any
 * sourced evidence; a cash-flow identity fits only when prices are sourced.
 */
export function sprintMathSelection(benchmark: readonly SprintProblem[], verdicts: readonly MethodVerdict[]): MathSelection {
  const evidenced = verdicts.filter((v) => (v.decision?.hypotheses ?? []).some((h) => h.supports.length + h.refutes.length > 0)).length;
  const priced = benchmark.filter((p) => known(p, 'priceCents') && sourceOf(p) !== null).length;
  const ref = `cash_opportunities:sprint-benchmark(${benchmark.length})`;
  return selectMathematics({
    question: 'Is each real opening an actionable transaction pathway, and how probable is it?',
    subject: 'intelligence sprint',
    candidates: [
      {
        family: 'statistical_estimation_calibration',
        purpose: 'fit base rates and score calibration (Brier) against production outcomes',
        preconditions: [{ condition: `at least ${MIN_SAMPLE} benchmark openings with a production outcome`, state: benchmark.length >= MIN_SAMPLE ? 'HOLDS' : 'FAILS', evidence: [`${ref} n=${benchmark.length}`] }],
      },
      {
        family: 'probability_bayesian_inference',
        purpose: 'weigh each mechanism hypothesis on sourced evidence',
        preconditions: [{ condition: 'the controller read sourced evidence on some opening', state: evidenced > 0 ? 'HOLDS' : 'FAILS', evidence: [`${evidenced} of ${verdicts.length} decision(s) with sourced evidence`] }],
      },
      {
        family: 'cash_flow_identities',
        purpose: 'carry the gross billed per transaction exactly from its sourced price',
        preconditions: [{ condition: 'openings state a sourced price', state: priced > 0 ? 'HOLDS' : 'FAILS', evidence: [`${ref} priced=${priced}`] }],
      },
    ],
  });
}

/**
 * The controller's snapshot of one opening: the card's evidence, the learned
 * catalogue and method outcomes, and — when the controller decided this
 * opening before — its prior decision and the results tracked against it, so
 * a contradicted result changes the method.
 */
export function controllerSnapshotOf(p: SprintProblem, context: MethodContext = {}): ControllerSnapshot {
  const { profile, actions } = profileOf(p);
  const mechanism = context.mechanism ?? null;
  // A mechanism role nothing evidences is research too, whether or not a card field names it.
  const covered = new Set(actions.flatMap((a) => a.discriminates));
  const roleActions: CandidateAction[] = (mechanism?.unknown ?? [])
    .filter((role) => !covered.has(`fails:${role}`))
    .map((role) => ({
      key: `${p.id}:role:${role}`,
      kind: 'RESEARCH',
      subject: `${role} of ${p.title}`.slice(0, 200),
      question: `${MECHANISM_ROLES[role].question} — for "${p.title}"`.slice(0, 300),
      resolves: `mechanism:${role}`,
      discriminates: [MECHANISM_HOLDS, `fails:${role}`],
      cost: 0.01,
    }));
  return {
    problem: profile,
    knowledge: context.knowledge ?? null,
    mechanism,
    catalogue: context.catalogue ?? SEED_METHODS,
    outcomes: context.outcomes ?? [],
    // No hypotheses or evidence are given: the controller generates them from the mechanism and weighs them on its cited claims.
    hypotheses: [],
    evidence: [],
    actions: [...actions, ...roleActions],
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
  const holds = hypothesisId === LEGACY_HOLDS || hypothesisId.startsWith('holds:');
  const fails = hypothesisId === LEGACY_FAILS || hypothesisId.startsWith('fails:');
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
    const holds = decision.hypotheses.find((h) => h.id === MECHANISM_HOLDS) ?? null;
    // Without a mechanism model there is nothing to weigh: the probability is the uninformed prior, never a favourable one.
    // The pathway needs every load-bearing field, so each one still unknown multiplies in the controller's own reading of
    // its counter-model (1 - score of fails:<role>), or the uninformed 0.5 where no role models it — never a convenient figure.
    const unresolved = new Set(unknowns.map((f) => FIELD_ROLE[f] ?? f));
    let probability = holds?.score ?? 0.5;
    for (const key of unresolved) {
      const counter = decision.hypotheses.find((h) => h.id === `fails:${key}`);
      probability *= counter ? 1 - counter.score : 0.5;
    }
    probability = Math.round(probability * 1000) / 1000;
    const evidenced = holds !== null && holds.supports.length > 0;
    const actionable = unknowns.length === 0 && record !== null && evidenced && probability >= threshold;
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
export function chooseThreshold(
  benchmark: readonly SprintProblem[],
  method: SprintMethod = GENERAL_METHOD,
  context?: MethodContext | ((p: SprintProblem) => MethodContext),
): number {
  const contextOf = typeof context === 'function' ? context : () => context;
  const candidates = [0.5, 0.6, 0.7, 0.8, 0.9];
  let best = candidates[0]!;
  let bestErrors = Infinity;
  for (const t of candidates) {
    const errors = benchmark.filter((p) => method.run(p, t, contextOf(p)).actionable !== actionableInProduction(p)).length;
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
/**
 * Provenance is not a demonstration: every scored opening whose row is new or
 * changed since the previous run has its gross billed and its probability
 * recorded, up to this many openings per run (the rest are next run's, since
 * an unrecorded row stays "changed").
 */
export const PROVENANCE_PER_RUN = 500;

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
  /** Always present: what the reading is not evidence of. */
  disclaimer: string;
}

/** What the controller's loop did this run: results tracked, decisions taken, methods changed, actions handed off. */
export interface SprintLoop {
  resultsTracked: number;
  decisions: number;
  methodChanges: number;
  capabilityGaps: number;
  handOffs: Record<string, number>;
  proceduresRecorded: number;
  /** Openings the controller decided with their project's knowledge and a mechanism model in hand. */
  knowledgeRead: number;
  mechanismsModelled: number;
  /** Information needs the knowledge and mechanism layers raised across those decisions. */
  informationNeeds: number;
  /** Number provenance records written this run (baseline rates, gross billed, general probabilities). */
  provenanceRecorded: number;
  /** Method-selection judgments recorded this run. */
  selectionsRecorded: number;
  errors: string[];
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<{ at: string; cutoff: string | null } | null>;
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
  recordSelection?: typeof recordMathSelection;
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
  /** Layer 1: a project's knowledge from its research claims (default: `loadProjectKnowledge`). */
  knowledge?: (projectId: string, subject: string, now: Date) => Promise<KnowledgeReading>;
}

/**
 * Layers 1 and 2 for one opening: its project's knowledge (read once per
 * project per run) and its card modelled as a mechanism over that knowledge.
 * A project whose knowledge cannot be read leaves both null and says why.
 */
export async function openingLayers(
  p: SprintProblem,
  now: Date,
  cache: Map<string, Promise<KnowledgeReading>>,
  load: NonNullable<SprintDeps['knowledge']> = (projectId, subject, at) => loadProjectKnowledge(projectId, { subject, now: at }),
): Promise<{ knowledge: KnowledgeReading | null; mechanism: MechanismModel | null; error: string | null }> {
  if (!p.projectId) return { knowledge: null, mechanism: null, error: null };
  let pending = cache.get(p.projectId);
  if (!pending) {
    pending = load(p.projectId, `project ${p.projectId}`, now);
    cache.set(p.projectId, pending);
  }
  let knowledge: KnowledgeReading;
  try {
    knowledge = await pending;
  } catch (error) {
    return { knowledge: null, mechanism: null, error: `knowledge: ${String((error as Error).message ?? error).slice(0, 200)}` };
  }
  const modelled = mechanismFromOpening(p, { ...knowledge, subject: p.title });
  return { knowledge, mechanism: modelled.ok ? modelled.model : null, error: modelled.ok ? null : `mechanism: ${modelled.reason.slice(0, 200)}` };
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

  // Layers 1 and 2 for every opening scored, so the general method weighs each one on its research claims (one read per project).
  const knowledgeCache = new Map<string, Promise<KnowledgeReading>>();
  const layersOf = new Map<string, Awaited<ReturnType<typeof openingLayers>>>();
  for (const p of problems) layersOf.set(p.id, await openingLayers(p, now, knowledgeCache, deps.knowledge));
  const contextOf = (p: SprintProblem): MethodContext => ({ ...learned, knowledge: layersOf.get(p.id)?.knowledge ?? null, mechanism: layersOf.get(p.id)?.mechanism ?? null });
  const threshold = chooseThreshold(split.BENCHMARK, GENERAL_METHOD, contextOf);
  const baseRates = fitBaselineRates(split.BENCHMARK, now.toISOString());

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = ps.map((p) => GENERAL_METHOD.run(p, threshold, contextOf(p)));
    const b = ps.map((p) => BASELINE_METHOD.run(p, threshold, { baseRates }));
    generalVerdicts.push(...g);
    const gr = readSet(set, GENERAL_METHOD.key, ps, g);
    const br = readSet(set, BASELINE_METHOD.key, ps, b);
    readings.push(gr, br);
    comparisons.push(compareWithBaseline(gr, br));
  }

  // The controller's operational loop on real openings: track what production said about an earlier
  // decision (a row, and a method outcome the library learns from), decide again with that result —
  // a contradicted one changes the method — record the decision, and hand the next action to its owner.
  const verdictOf = new Map(generalVerdicts.map((v) => [v.problemId, v]));
  const history = await (deps.history ?? (() => readControllerHistory(SPRINT_CALLER)))();
  const loop: SprintLoop = { resultsTracked: 0, decisions: 0, methodChanges: 0, capabilityGaps: 0, handOffs: {}, proceduresRecorded: 0, knowledgeRead: 0, mechanismsModelled: 0, informationNeeds: 0, provenanceRecorded: 0, selectionsRecorded: 0, errors: [] };
  for (const { problem: p, result } of chooseDemonstrated(problems, history)) {
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
      const layers = layersOf.get(p.id) ?? (await openingLayers(p, now, knowledgeCache, deps.knowledge));
      if (layers.error) loop.errors.push(`${p.id}: ${layers.error}`);
      if (layers.knowledge) loop.knowledgeRead += 1;
      if (layers.mechanism) loop.mechanismsModelled += 1;
      const snapshot = controllerSnapshotOf(p, {
        ...learned,
        knowledge: layers.knowledge,
        mechanism: layers.mechanism,
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
      loop.informationNeeds += decision.informationNeeds.length;
      if (decision.methodChange) loop.methodChanges += 1;
      if (decision.capabilityGap) loop.capabilityGaps += 1;
      loop.handOffs[handed.to] = (loop.handOffs[handed.to] ?? 0) + 1;
    } catch (error) {
      loop.errors.push(`${p.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  // Per-number provenance for the run's own numbers: the baseline's fitted rates, the method selection, and
  // for every opening new or changed since the previous run its gross billed and the general probability.
  const recordProv = deps.recordProvenance ?? recordNumberProvenance;
  const tryRecord = async (record: NumberProvenance | null | undefined, projectId: string | null): Promise<void> => {
    if (!record) return;
    try {
      await recordProv(record, { projectId, caller: SPRINT_CALLER });
      loop.provenanceRecorded += 1;
    } catch {
      // A record the toolkit refuses is a finding already counted in method quality, not a run failure.
    }
  };
  await tryRecord(baseRates.withPayerAndPrice.provenance, null);
  await tryRecord(baseRates.without.provenance, null);
  try {
    await (deps.recordSelection ?? recordMathSelection)(sprintMathSelection(split.BENCHMARK, generalVerdicts), { caller: SPRINT_CALLER });
    loop.selectionsRecorded += 1;
  } catch (error) {
    loop.errors.push(`selection: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  const since = previous?.at ?? null;
  const changed = problems.filter((p) => since === null || p.updatedAt > since || p.createdAt > since).slice(0, PROVENANCE_PER_RUN);
  for (const p of changed) {
    const v = verdictOf.get(p.id);
    if (!v) continue;
    await tryRecord(v.provenance, p.projectId ?? null);
    if (v.decision) await tryRecord(generalProbabilityProvenance(p, v.decision, now.toISOString()).record, p.projectId ?? null);
  }
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
