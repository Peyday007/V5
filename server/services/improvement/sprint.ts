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
 * the market's verdict on it — a buyer agreed and delivery began, or money
 * was collected; or it was declined or archived — never either method's
 * opinion, and never Brain's own readiness gate. READY is `markReady`
 * checking the card's load-bearing fields, which is what the general method
 * checks too, so scoring against READY would score the gate reproducing
 * itself (repair F5). READY and EXECUTING are therefore unresolved: they are
 * left out of every measure that needs an outcome, and counted as such. And
 * because a method can still "win" by re-implementing that gate, the general
 * method is compared with the gate itself as well as with the payer-and-price
 * baseline, and earns its cost only by beating both. The split is a hash of the row id, so the
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
 * Required human interventions are real owner requests (`russell_human_requests`
 * naming the opening), never the method's model of needing a person; that
 * model is kept apart (`modelledNeedsPerson`) and is what methods compare on.
 *
 * It does not only measure. Each run attributes the general method's
 * benchmark misses to the capability it lacked, and ships the highest-leverage
 * one to the Factory through `registerDirected` (the one path from a weakness
 * to an objective). The next run is the rerun: it measures the same sets again
 * and links the held-out delta to the change that candidate delivered in
 * between (`compareRuns`); a delivered change that did not improve held-out
 * results goes back to repair. The general method's held-out false positives
 * are fed to repair even when it beats the baseline.
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
  type InferenceStep,
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
  scoreHypotheses,
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
  countPrecondition,
  forecastBias,
  probabilityProvenance,
  provenanceReason,
  readRecordedMathReasons,
  recordForecastBias,
  recordMathSelection,
  recordNumberProvenance,
  selectMathematics,
  selectionReason,
  type BiasReading,
  type MathSelection,
  type NumberProvenance,
  type ProvenanceInput,
} from '../quant/mathToolkit.ts';
import { MIN_CALIBRATION_SAMPLE, buildLedger, calibrate, type CalibrationBucket, type ExposureRow, type OutcomeRow, type PredictionRow } from '../quant/forecast.ts';
import type { Figure } from '../quant/graph.ts';
import type { sendNeeds } from '../quant/needs.ts';
import { GATE_ASSERTED_STATES, MARKET_CONFIRMED_STATES, MARKET_REFUSED_STATES } from '../cash/opportunities.ts';

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

/**
 * States in which the market said yes: an agreement the buyer agreed to is
 * being delivered, or money was collected (`cash/opportunities.ts`). Not READY
 * or EXECUTING — those are Brain's own gate and Brain's own pursuit.
 */
export const ACTIONABLE_STATES: ReadonlySet<string> = new Set(MARKET_CONFIRMED_STATES);

/** States Brain's readiness gate or its own pursuit put the opening in: no verdict from the market yet. */
export const GATE_STATES: ReadonlySet<string> = new Set(GATE_ASSERTED_STATES);

/** The market made it an economically supported, actionable pathway. */
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

/**
 * The second baseline: Brain's own readiness gate, re-implemented — every
 * load-bearing card field known. It is what the general method's structural
 * requirement amounts to, so a general method that only matches it has
 * reproduced the gate rather than reasoned, and is not credited for it.
 */
export const GATE_METHOD: SprintMethod = {
  key: 'baseline:readiness-gate',
  run(p) {
    const started = performance.now();
    const actionable = LOAD_BEARING.every((f) => known(p, f));
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

/** Every simpler method the general one must beat to earn its cost. */
export const BASELINES: readonly SprintMethod[] = [BASELINE_METHOD, GATE_METHOD];

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
 * The reasoning chain behind "this opening is an actionable pathway", built
 * from what actually stands behind it: the research claim the card was drawn
 * from (with that claim's status in the project's knowledge), each card field
 * the conclusion rests on, the price as an estimate, and the causal step from
 * the buying signal to payment. It is what `detectWeakInferences` reads, so a
 * premise no supported claim backs, a price anchored on one figure, or a causal
 * step no evidenced mechanism stands behind is a finding on the real opening —
 * never assumed away and never invented.
 */
export function inferenceChainOf(
  p: SprintProblem,
  knowledge: KnowledgeReading | null = null,
  mechanism: MechanismModel | null = null,
): InferenceStep[] {
  const chain: InferenceStep[] = [];
  const supported = (knowledge?.claims ?? []).filter((c) => c.status === 'SUPPORTED');
  const sourceUrlOf = (claimId: string): string | null => supported.find((c) => c.id === claimId)?.provenance?.sourceUrl?.trim() || null;

  // The evidence step: the claim the card was drawn from, sourced only when the knowledge holds it as SUPPORTED.
  let evidenceStep: string | null = null;
  if (p.sourceClaimId) {
    const atomic = knowledge?.claims.find((c) => c.id === p.sourceClaimId) ?? null;
    const url = sourceUrlOf(p.sourceClaimId);
    evidenceStep = `claim:${p.sourceClaimId}`;
    chain.push({
      id: evidenceStep,
      claim: atomic
        ? `research claim ${p.sourceClaimId} (${atomic.status}: ${atomic.reason})`.slice(0, 300)
        : `research claim ${p.sourceClaimId} (not found in the project's knowledge)`,
      kind: 'OBSERVATION',
      premises: [],
      sources: url ? [url] : [],
    });
  } else if (p.source?.trim()) {
    evidenceStep = `source:${p.id}`;
    chain.push({ id: evidenceStep, claim: `the card's own source for "${p.title}"`.slice(0, 300), kind: 'OBSERVATION', premises: [], sources: [p.source.trim()] });
  }

  const roleKnown = (role: MechanismRole): boolean => mechanism?.roles.some((r) => r.role === role && r.status === 'KNOWN') ?? false;

  // One step per stated card field the conclusion rests on; each rests on the evidence step, or on nothing. A buying
  // signal the mechanism does not hold as a KNOWN trigger is only seen alongside the opening: a correlate, not a cause.
  const fieldStep = new Map<LoadBearing, string>();
  for (const f of LOAD_BEARING) {
    if (f === 'priceCents' || !known(p, f)) continue;
    const id = `field:${f}`;
    fieldStep.set(f, id);
    const kind = f === 'buyingSignal' && !roleKnown('trigger') ? 'CORRELATION' : 'OBSERVATION';
    chain.push({ id, claim: `${f} of "${p.title}" is ${String(p[f]).slice(0, 120)}`, kind, premises: evidenceStep ? [evidenceStep] : [], sources: [] });
  }

  // The price is an estimate: independent figures are the distinct supported claims that state a price for this project.
  if (p.priceCents !== null) {
    const priceClaims = new Set(supported.filter((c) => c.facet === 'prices').map((c) => c.id));
    if (p.sourceClaimId && sourceUrlOf(p.sourceClaimId)) priceClaims.add(p.sourceClaimId);
    fieldStep.set('priceCents', 'field:priceCents');
    chain.push({
      id: 'field:priceCents',
      claim: `the price of one transaction of "${p.title}" is ${p.priceCents / 100} ${p.currency}`.slice(0, 300),
      kind: 'ESTIMATE',
      premises: evidenceStep ? [evidenceStep] : [],
      sources: [],
      independentFigures: priceClaims.size,
    });
  }

  // The conclusion is causal: the buying signal makes the payer pay. It is backed by a mechanism only when the model
  // holds both the trigger and the money movement as KNOWN on supported evidence.
  const premises = [fieldStep.get('buyingSignal'), fieldStep.get('payer'), fieldStep.get('priceCents'), fieldStep.get('paymentTerms')].filter(
    (s): s is string => typeof s === 'string',
  );
  chain.push({
    id: `conclusion:${p.id}`,
    claim: `"${p.title}" is a transaction the payer will pay for`.slice(0, 300),
    kind: 'CAUSAL',
    premises,
    sources: [],
    causalSupport: roleKnown('trigger') && roleKnown('moneyMovement') ? 'MECHANISM' : null,
  });
  return chain;
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
    // The chain the conclusion rests on, so weak inferences are found on the real opening (S-0195).
    chain: inferenceChainOf(p, context.knowledge ?? null, mechanism),
    actions: [...actions, ...roleActions],
    prior: context.prior ?? null,
    results: context.results ?? [],
    now: context.now ?? p.updatedAt,
  };
}

/** States that mean the opening will not become a pathway. */
export const DEAD_STATES: ReadonlySet<string> = new Set(MARKET_REFUSED_STATES);

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

/** A hypothesis's score under the controller's own scorer, given how many sourced items support and refute it. */
export function scoreUnder(supports: number, refutes: number): number {
  const evidence = [
    ...Array.from({ length: supports }, (_, i) => ({ id: `s${i}`, source: 'margin-scale', bears: { h: 'SUPPORTS' as const } })),
    ...Array.from({ length: refutes }, (_, i) => ({ id: `r${i}`, source: 'margin-scale', bears: { h: 'REFUTES' as const } })),
  ];
  const [scored] = scoreHypotheses([{ id: 'h', statement: 'margin scale', basis: 'margin-scale' }], evidence);
  if (!scored) throw new Error('scoreHypotheses returned nothing for one hypothesis');
  return scored.score;
}

/**
 * How far the leading hypothesis must stand above the next one for the
 * controller's decision to count as settled.
 *
 * It is read off `scoreHypotheses`' own scale rather than typed as a figure:
 * the margin is the score of a hypothesis no sourced evidence bears on — the
 * uninformed prior. "Settled" therefore means evidence has moved the leader
 * above the runner-up by as much as the whole prior, on whatever scale the
 * scorer uses; under its Laplace smoothing that is 0.5. If the scorer is ever
 * rescaled the margin follows it, and `assertSettledMarginScale` below refuses
 * to load a margin that no longer separates the evidence patterns it exists to
 * separate. Not tuned on any problem set.
 */
export const SETTLED_MARGIN = scoreUnder(0, 0);

/**
 * The margin's contract with the scorer, checked when this module loads so
 * every test and every boot that imports the sprint reproduces a mismatch:
 *  - one unopposed sourced item either way is a lean, not a settlement;
 *  - the margin is no more than the uninformed prior, so a lone hypothesis
 *    (its absent runner-up reads 0 in `needsPersonOf`) is settled only on the
 *    scorer's own reading of it, never by a margin nothing can reach;
 *  - three sourced items for the leader against three refuting the runner-up
 *    is settled;
 *  - the margin is reachable: below the scorer's widest possible gap.
 */
export function assertSettledMarginScale(margin: number = SETTLED_MARGIN): void {
  const gap = (a: [number, number], b: [number, number]) => scoreUnder(...a) - scoreUnder(...b);
  const failures: string[] = [];
  if (!(margin > 0)) failures.push(`margin ${margin} is not positive`);
  if (gap([1, 0], [0, 1]) >= margin) failures.push(`one item each way (gap ${gap([1, 0], [0, 1])}) already settles at margin ${margin}`);
  if (gap([1, 0], [0, 0]) >= margin) failures.push(`one unopposed item (gap ${gap([1, 0], [0, 0])}) already settles at margin ${margin}`);
  if (gap([3, 0], [0, 3]) < margin) failures.push(`three items each way (gap ${gap([3, 0], [0, 3])}) does not settle at margin ${margin}`);
  if (margin > scoreUnder(0, 0)) failures.push(`margin ${margin} exceeds the uninformed prior ${scoreUnder(0, 0)}`);
  if (failures.length > 0) throw new Error(`SETTLED_MARGIN does not fit scoreHypotheses' scale: ${failures.join('; ')}`);
}
assertSettledMarginScale();

/**
 * Whether the general method could not progress this opening without a person.
 * A person is needed only when it is still not actionable and nothing the
 * method can do itself would move it: the controller's next step is obtaining a
 * method (METHOD_GAP), or it has no next step while research has nothing left
 * to answer and the decision is not settled.
 *
 * A null `next` is not by itself a need for a person (reasoning-sprint:general-method).
 * The controller leaves `next` null whenever no candidate action has positive
 * value against the two hypotheses contesting the lead — which is every
 * opening that reached the sprint without a mechanism model, because its
 * research actions bear on `holds:mechanism`/`fails:<role>` and those
 * hypotheses are then absent. Counting those as "needs a person" read
 * modelledNeedsPerson 1 on held-out sets where research could still fill every
 * unknown, and failed the baseline comparison on that alone. A settled
 * decision with nothing worth doing is a rejection, which needs nobody.
 */
export function needsPersonOf(actionable: boolean, decision: Pick<ControllerDecision, 'next' | 'valued' | 'hypotheses'>): boolean {
  if (actionable) return false;
  if (decision.next) return decision.next.kind === 'METHOD_GAP';
  const researchable = decision.valued.some((a) => a.kind === 'RESEARCH');
  const [first, second] = decision.hypotheses;
  const settled = first !== undefined && first.score - (second?.score ?? 0) >= SETTLED_MARGIN;
  return !researchable && !settled;
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
      needsPerson: needsPersonOf(actionable, decision),
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
  /**
   * Problems the market has not resolved (still undecided, or only at Brain's
   * own READY/EXECUTING): left out of every measure that needs an outcome.
   */
  unresolved: number;
  /** Method called it actionable and the market confirmed it, over the problems the market resolved. */
  actionablePathwayRate: Measure;
  /** Decisions free of weak-inference and provenance findings, over the set. */
  methodQuality: Measure;
  /** Total decision milliseconds over decisions. */
  decisionTimeMs: Measure;
  /**
   * Problems a real owner intervention was recorded for, over the set: a
   * Needs-You request (`russell_human_requests`) that names the opening. A
   * count of rows, never a model; INSUFFICIENT_DATA (denominator 0) when the
   * rows were not read for this reading.
   */
  humanInterventions: Measure;
  /**
   * Problems the method itself predicted it could not progress without a person, over the set: its own model, compared between methods.
   * For the general method that is `needsPersonOf`: a research action still open, or a settled rejection, needs nobody.
   */
  modelledNeedsPerson: Measure;
  /**
   * Problems left needing a person under ONE rule applied to every method's
   * verdicts alike (`needsPersonUnderOneRule`), over the set. This — never a
   * method's own model — is what methods are compared on, so no method can
   * clear the comparison by redefining what it counts. Optional only so a
   * reading stored before it existed still parses; a comparison missing it on
   * either side has too little data to say.
   */
  needsPersonComparable?: Measure;
  /** Brier score: summed squared error of the probability against what the market did, over resolved problems. Lower is better. */
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
  interventions?: ReadonlyMap<string, number> | null,
): SetReading {
  // Only the market's verdict is an outcome: an opening it has not resolved is neither a hit nor a miss.
  const truth = new Map(problems.filter(resolvedInProduction).map((p) => [p.id, actionableInProduction(p)]));
  const n = verdicts.length;
  const scored = verdicts.filter((v) => truth.has(v.problemId));
  const tp = scored.filter((v) => v.actionable && truth.get(v.problemId)).length;
  const clean = verdicts.filter((v) => v.findings === 0).length;
  const time = verdicts.reduce((s, v) => s + v.elapsedMs, 0);
  const people = verdicts.filter((v) => v.needsPerson).length;
  const byId = new Map(problems.map((p) => [p.id, p]));
  const comparablePeople = verdicts.filter((v) => needsPersonUnderOneRule(byId.get(v.problemId), v)).length;
  // Real interventions are read from rows; when they were not read, the measure says so rather than reading zero.
  const intervened = interventions ? verdicts.filter((v) => (interventions.get(v.problemId) ?? 0) > 0).length : 0;
  const brier = scored.reduce((s, v) => s + (v.probability - (truth.get(v.problemId) ? 1 : 0)) ** 2, 0);
  const targets = scored.filter((v) => truth.get(v.problemId));
  const covered = targets.filter((v) => v.actionable && v.robust).length;
  return {
    set,
    method,
    problems: n,
    unresolved: n - scored.length,
    actionablePathwayRate: measure(tp, scored.length),
    methodQuality: measure(clean, n),
    decisionTimeMs: measure(time, n, 1),
    humanInterventions: interventions ? measure(intervened, n) : measure(0, 0),
    modelledNeedsPerson: measure(people, n),
    needsPersonComparable: measure(comparablePeople, n),
    calibrationBrier: measure(brier, scored.length),
    robustTargetCoverage: measure(covered, targets.length),
    falsePositives: scored.filter((v) => v.actionable && !truth.get(v.problemId)).map((v) => v.problemId),
  };
}

/**
 * Whether an opening was left needing a person, by one rule applied to every
 * method's verdict alike — general or baseline — so no method can clear the
 * comparison by redefining what it counts. It reads the opening and the
 * verdict, never a method's own `needsPerson` model:
 *  - an actionable verdict needs nobody;
 *  - a verdict that names a missing method as its next step (METHOD_GAP) needs
 *    a person to supply it;
 *  - a verdict that names any other next step of its own (research, an
 *    experiment) progresses without one — a baseline that names none gets no
 *    such credit, because it has no step, not because it is counted otherwise;
 *  - an opening with a load-bearing field still unknown needs research, not a
 *    person, whichever method looked at it;
 *  - otherwise the verdict needs a person unless it is decisive: its
 *    probability stands at least SETTLED_MARGIN from its complement, so it is
 *    a decision (a rejection) rather than a shrug. The same margin
 *    `needsPersonOf` settles the controller's hypotheses by, read off the same
 *    scorer's scale.
 * An opening not found among the set's problems is counted as needing a
 * person: not knowing it is never read as favourable (invariant 39).
 */
export function needsPersonUnderOneRule(problem: SprintProblem | undefined, verdict: Pick<MethodVerdict, 'actionable' | 'probability' | 'decision'>): boolean {
  if (verdict.actionable) return false;
  const next = verdict.decision?.next;
  if (next) return next.kind === 'METHOD_GAP';
  if (!problem) return true;
  if (profileOf(problem).unknowns.length > 0) return false;
  return Math.abs(verdict.probability - (1 - verdict.probability)) < SETTLED_MARGIN;
}

/**
 * Extra decision time per opening, beyond the baseline's, that a method may
 * spend and still earn its cost. A ratio cannot be the ceiling — a two-field
 * baseline decides in microseconds, so any reasoning is thousands of times
 * slower — so the budget is absolute: one second per opening, well inside
 * what a sprint pass over a few hundred openings can afford. Structural, not
 * tuned on any problem set.
 */
export const DECISION_TIME_BUDGET_MS = 1000;

/**
 * The method's one tuned choice, made on the benchmark set only: the
 * probability threshold with the lowest misclassification there, against the
 * market's verdict on the openings it resolved.
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
    // Scored only where the market has spoken: an unresolved opening is not an error either way.
    const errors = benchmark.filter((p) => resolvedInProduction(p) && method.run(p, t, contextOf(p)).actionable !== actionableInProduction(p)).length;
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
 * find at least as many confirmed pathways, be no worse calibrated, and leave
 * people needed no more often — counted by one rule for both methods — and be
 * strictly better on an outcome the market judged (pathway rate or
 * calibration), within DECISION_TIME_BUDGET_MS of extra decision time per
 * opening. Needing people less often alone does not pay for extra time: that
 * figure is a model, the outcomes are the market's.
 */
export function compareWithBaseline(general: SetReading, baseline: SetReading): BaselineComparison {
  // Both sides are counted by the same rule (needsPersonUnderOneRule); a method's own needsPerson model is reported, never compared.
  const people = (r: SetReading): number | null => (r.needsPersonComparable ? num(r.needsPersonComparable) : null);
  const g = { rate: num(general.actionablePathwayRate), brier: num(general.calibrationBrier), people: people(general) };
  const b = { rate: num(baseline.actionablePathwayRate), brier: num(baseline.calibrationBrier), people: people(baseline) };
  const costRatio = baseline.decisionTimeMs.numerator > 0 ? general.decisionTimeMs.numerator / baseline.decisionTimeMs.numerator : null;
  if (g.rate === null || b.rate === null || g.brier === null || b.brier === null || g.people === null || b.people === null) {
    return {
      set: general.set,
      earned: null,
      statement:
        `${general.set} vs ${baseline.method}: too few problems the market resolved (${general.problems - general.unresolved} of ${general.problems}; ` +
        `${general.unresolved} undecided or only at Brain's own READY/EXECUTING) to say whether the general method earned its cost`,
      general,
      baseline,
    };
  }
  const perOpening = (r: SetReading): number => (r.decisionTimeMs.denominator > 0 ? r.decisionTimeMs.numerator / r.decisionTimeMs.denominator : 0);
  const extraMsPerOpening = Math.max(0, perOpening(general) - perOpening(baseline));
  const withinBudget = extraMsPerOpening <= DECISION_TIME_BUDGET_MS;
  const better = g.rate >= b.rate && g.brier <= b.brier && g.people <= b.people && (g.rate > b.rate || g.brier < b.brier);
  const earned = better && withinBudget;
  const cost =
    (costRatio === null ? 'unmeasured extra time' : `${costRatio.toFixed(1)}x the baseline's decision time`) +
    ` (${Math.round(extraMsPerOpening)} ms extra per opening, budget ${DECISION_TIME_BUDGET_MS} ms${withinBudget ? '' : ', exceeded'})`;
  return {
    set: general.set,
    earned,
    statement:
      `${general.set} vs ${baseline.method}: pathway rate ${g.rate} vs ${b.rate}, Brier ${g.brier} vs ${b.brier}, people ${g.people} vs ${b.people}, at ${cost} — ` +
      (earned ? 'the extra complexity earned its cost' : 'the extra complexity did not earn its cost on this set'),
    general,
    baseline,
  };
}

/**
 * The comparison's contract, checked when this module loads so every test and
 * every boot that imports the sprint reproduces a regression of either
 * recorded failure class (reasoning-sprint:general-method):
 *  - asymmetric counting: a method that only redefines its own `needsPerson`
 *    model — here, claiming it needs nobody — must not change `earned`;
 *    only the one-rule count is compared;
 *  - unearned cost: a method better on every outcome but spending more than
 *    DECISION_TIME_BUDGET_MS extra per opening has not earned it, and neither
 *    has one whose only advantage is needing people less often.
 */
export function assertComparisonContract(): void {
  const m = (numerator: number, denominator = 20): Measure => measure(numerator, denominator);
  const reading = (over: Partial<SetReading>): SetReading => ({
    set: 'HELD_OUT',
    method: 'contract',
    problems: 20,
    unresolved: 0,
    actionablePathwayRate: m(5),
    methodQuality: m(20),
    decisionTimeMs: measure(20, 20, 1),
    humanInterventions: measure(0, 0),
    modelledNeedsPerson: m(10),
    needsPersonComparable: m(10),
    calibrationBrier: m(4),
    robustTargetCoverage: m(5),
    falsePositives: [],
    ...over,
  });
  const failures: string[] = [];
  const baseline = reading({});
  // Worse on the one-rule count; its own model claims nobody is needed.
  const relabelled = reading({ calibrationBrier: m(1), modelledNeedsPerson: m(0), needsPersonComparable: m(18) });
  if (compareWithBaseline(relabelled, baseline).earned !== false) failures.push('a method that only relabels its own needsPerson model earned its cost');
  const fast = reading({ calibrationBrier: m(1) });
  if (compareWithBaseline(fast, baseline).earned !== true) failures.push('a method better on calibration within the time budget did not earn its cost');
  const slow = reading({ calibrationBrier: m(1), decisionTimeMs: measure(20 * (DECISION_TIME_BUDGET_MS + 2), 20, 1) });
  if (compareWithBaseline(slow, baseline).earned !== false) failures.push('a method over the decision-time budget earned its cost');
  const peopleOnly = reading({ needsPersonComparable: m(0) });
  if (compareWithBaseline(peopleOnly, baseline).earned !== false) failures.push('needing people less often alone paid for extra time');
  const unread = reading({ needsPersonComparable: undefined });
  if (compareWithBaseline(unread, baseline).earned !== null) failures.push('a reading without the one-rule count was compared');
  if (failures.length > 0) throw new Error(`compareWithBaseline broke its contract: ${failures.join('; ')}`);
}
assertComparisonContract();

/* ------------------------------------------------------------------------- */
/* The highest-leverage missing capability, and whether shipping it helped    */
/* ------------------------------------------------------------------------- */

/**
 * A general reasoning capability the method lacked, read from its misses: the
 * problems production says were (or were not) pathways that the general
 * method called the other way, attributed to what it could not do on each.
 * Leverage is how many misses the capability explains. It is selected on the
 * BENCHMARK set only — held-out problems verify it at the rerun and never
 * choose it, exactly as they never choose the threshold.
 */
export interface CapabilityGap {
  key: string;
  title: string;
  /** Misses it explains, over the misses read. */
  explains: number;
  of: number;
  problems: string[];
  /** Where the capability lives: the paths a Factory objective for it may change. */
  ownerPaths: string[];
  question: string;
}

const CAPABILITY_SPECS: Record<string, { title: string; ownerPaths: string[]; question: string }> = {
  'knowledge-acquisition': {
    title: 'acquire a sourced research claim behind an opening before judging it',
    ownerPaths: ['server/services/research/**'],
    question: 'how does Brain reach a sourced research claim for an opening whose card has none behind it',
  },
  'number-provenance': {
    title: 'build a material number with its provenance when the card states it',
    ownerPaths: ['server/services/quant/**'],
    question: 'which provenance a stated price lacks, and how Brain obtains it rather than refusing the number',
  },
  calibration: {
    title: 'calibrate the pathway probability against realized outcomes',
    ownerPaths: ['server/services/research/**', 'server/services/quant/**'],
    question: 'why evidenced pathways score under the tuned threshold, and which calibration corrects it',
  },
  'counter-model': {
    title: 'refute a pathway with an explicit counter-model before calling it actionable',
    ownerPaths: ['server/services/research/**'],
    question: 'which adversarial check would have refuted the pathways the method called actionable that production did not',
  },
};

function capabilitySpec(key: string): { title: string; ownerPaths: string[]; question: string } {
  const known = CAPABILITY_SPECS[key];
  if (known) return known;
  const role = key.startsWith('mechanism-role:') ? key.slice('mechanism-role:'.length) : key;
  return {
    title: `resolve the ${role} of a transaction from research rather than leave it unknown`,
    ownerPaths: ['server/services/research/**'],
    question: `how does Brain establish the ${role} of an opening's transaction from sourced evidence`,
  };
}

/** What the general method could not do on one miss. Pure. */
export function capabilitiesOfMiss(p: SprintProblem, v: MethodVerdict): string[] {
  if (!resolvedInProduction(p)) return [];
  const truth = actionableInProduction(p);
  if (v.actionable && !truth) return ['counter-model'];
  if (v.actionable || !truth) return [];
  const holds = v.decision?.hypotheses.find((h) => h.id === MECHANISM_HOLDS) ?? null;
  if (!holds || holds.supports.length === 0) return ['knowledge-acquisition'];
  const { unknowns } = profileOf(p);
  if (unknowns.length > 0) return [...new Set(unknowns.map((f) => `mechanism-role:${FIELD_ROLE[f] ?? f}`))];
  if (!v.provenance) return ['number-provenance'];
  return ['calibration'];
}

/** Rank the capabilities the general method's misses point to, highest leverage first. Pure. */
export function rankCapabilityGaps(problems: readonly SprintProblem[], verdicts: readonly MethodVerdict[]): CapabilityGap[] {
  const byId = new Map(problems.map((p) => [p.id, p]));
  const found = new Map<string, string[]>();
  let misses = 0;
  for (const v of verdicts) {
    const p = byId.get(v.problemId);
    if (!p) continue;
    const caps = capabilitiesOfMiss(p, v);
    if (caps.length === 0) continue;
    misses += 1;
    for (const c of caps) found.set(c, [...(found.get(c) ?? []), p.id]);
  }
  return [...found.entries()]
    .map(([key, ids]) => ({ key, ...capabilitySpec(key), explains: ids.length, of: misses, problems: ids.slice(0, 10) }))
    .sort((a, b) => b.explains - a.explains || a.key.localeCompare(b.key));
}

/** The fewest misses a capability must explain before a run ships it. */
export const MIN_CAPABILITY_MISSES = 2;

/** What a run shipped to the Factory, so the next run can say whether it helped. */
export interface ShippedCapability {
  capability: string | null;
  candidateId: string;
  shippedAt: string;
}

export interface MeasureDelta {
  set: ProblemSet;
  measure: 'actionablePathwayRate' | 'calibrationBrier' | 'robustTargetCoverage' | 'methodQuality' | 'humanInterventions';
  before: number | null;
  after: number | null;
  /** after − before, or null when either side lacks data. */
  delta: number | null;
}

export type RerunVerdict = 'IMPROVED' | 'NOT_IMPROVED' | 'NO_CHANGE_DELIVERED' | 'INSUFFICIENT_DATA';

/** The rerun: the same sets measured again, linked to the change shipped since, with its verdict. */
export interface RerunReading {
  previousRunAt: string;
  shipped: ShippedCapability | null;
  /** The delivered change the deltas are linked to: the candidate's delivered ref. */
  deliveredRef: string | null;
  deliveredAt: string | null;
  deltas: MeasureDelta[];
  verdict: RerunVerdict;
  statement: string;
}

export interface CandidateState {
  id: string;
  weaknessKey: string;
  deliveredAt: string | null;
  deliveredRef: string | null;
  decision: string | null;
}

const DELTA_MEASURES: MeasureDelta['measure'][] = ['actionablePathwayRate', 'calibrationBrier', 'robustTargetCoverage', 'methodQuality', 'humanInterventions'];
/** Lower is better for these. */
const LOWER_BETTER = new Set<MeasureDelta['measure']>(['calibrationBrier', 'humanInterventions']);

function measureValue(r: unknown, key: MeasureDelta['measure']): number | null {
  const m = (r as Record<string, unknown> | null | undefined)?.[key] as { value?: unknown } | undefined;
  return typeof m?.value === 'number' && Number.isFinite(m.value) ? m.value : null;
}

/**
 * Compare this run's general-method readings with the previous run's on the
 * same sets, and link the change to the capability shipped in between. Only
 * the held-out set decides the verdict — the benchmark chose the capability,
 * so its improvement there is not evidence. Pure.
 */
export function compareRuns(input: {
  previousRunAt: string;
  previousReadings: readonly unknown[];
  readings: readonly SetReading[];
  shipped: ShippedCapability | null;
  candidate: CandidateState | null;
  now: string;
}): RerunReading {
  const general = (rs: readonly unknown[], set: ProblemSet) =>
    rs.find((r) => (r as { set?: unknown; method?: unknown }).set === set && (r as { method?: unknown }).method === GENERAL_METHOD.key) ?? null;
  const deltas: MeasureDelta[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT'] as const) {
    const before = general(input.previousReadings, set);
    const after = general(input.readings, set);
    for (const measureKey of DELTA_MEASURES) {
      const b = measureValue(before, measureKey);
      const a = measureValue(after, measureKey);
      deltas.push({ set, measure: measureKey, before: b, after: a, delta: a === null || b === null ? null : Math.round((a - b) * 10000) / 10000 });
    }
  }
  const delivered = input.candidate?.deliveredAt && input.candidate.deliveredAt > input.previousRunAt && input.candidate.deliveredAt <= input.now ? input.candidate : null;
  const base = { previousRunAt: input.previousRunAt, shipped: input.shipped, deliveredRef: delivered?.deliveredRef ?? null, deliveredAt: delivered?.deliveredAt ?? null, deltas };
  if (!input.shipped || !delivered) {
    return { ...base, verdict: 'NO_CHANGE_DELIVERED', statement: input.shipped ? `capability ${input.shipped.capability ?? '(general method)'} (candidate ${input.shipped.candidateId}) is not delivered yet; the rerun links no change` : 'no capability was shipped since the previous run' };
  }
  const held = deltas.filter((d) => d.set === 'HELD_OUT' && (d.measure === 'actionablePathwayRate' || d.measure === 'calibrationBrier' || d.measure === 'robustTargetCoverage'));
  const readable = held.filter((d) => d.delta !== null);
  if (readable.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', statement: `change ${delivered.deliveredRef ?? delivered.id} delivered, but the held-out set is too small on one side to say whether it helped` };
  }
  const better = (d: MeasureDelta) => (LOWER_BETTER.has(d.measure) ? d.delta! < 0 : d.delta! > 0);
  const worse = (d: MeasureDelta) => (LOWER_BETTER.has(d.measure) ? d.delta! > 0 : d.delta! < 0);
  const improved = readable.some(better) && !readable.some(worse);
  const parts = readable.map((d) => `${d.measure} ${d.before} → ${d.after}`).join(', ');
  return {
    ...base,
    verdict: improved ? 'IMPROVED' : 'NOT_IMPROVED',
    statement: `held-out after change ${delivered.deliveredRef ?? delivered.id} (capability ${input.shipped.capability ?? '(general method)'}): ${parts} — ${improved ? 'improved with no measure worse' : 'did not improve'}`,
  };
}

/**
 * Real owner interventions per opening: Needs-You requests on the opening's
 * project, opened after the opening was, that name it. Read from rows; an
 * opening no request names has none, and a project nobody asked about adds
 * nothing.
 */
export async function readOwnerInterventions(problems: readonly SprintProblem[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byProject = new Map<string, SprintProblem[]>();
  for (const p of problems) if (p.projectId) byProject.set(p.projectId, [...(byProject.get(p.projectId) ?? []), p]);
  if (byProject.size === 0) return out;
  const since = problems.reduce((m, p) => (p.createdAt < m ? p.createdAt : m), problems[0]!.createdAt);
  const ids = [...byProject.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = await getDb().all<{ project_id: string; resume_key: string | null; why_not_russell: string | null; recommendation: string | null; authority_needed: string | null; created_at: string }>(
      `SELECT project_id, resume_key, why_not_russell, recommendation, authority_needed, created_at FROM russell_human_requests
        WHERE project_id IN (${chunk.map(() => '?').join(', ')}) AND created_at >= ? LIMIT 5000`,
      [...chunk, since],
    );
    for (const row of rows) {
      const text = [row.resume_key, row.why_not_russell, row.recommendation, row.authority_needed].filter(Boolean).join(' ');
      for (const p of byProject.get(row.project_id) ?? []) {
        if (row.created_at >= p.createdAt && text.includes(p.id)) out.set(p.id, (out.get(p.id) ?? 0) + 1);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The numbers the run states                                                 */
/* ------------------------------------------------------------------------- */

/** Whether the market has resolved an opening either way: only those are outcomes a method can be judged on. READY and EXECUTING are not. */
export function resolvedInProduction(p: Pick<SprintProblem, 'state'>): boolean {
  return ACTIONABLE_STATES.has(p.state) || DEAD_STATES.has(p.state);
}

/**
 * One method's probabilities against what production resolved, through the
 * existing forecast ledger shapes: each resolved opening is a prediction the
 * method made (its probability that the opening is an actionable pathway)
 * and an outcome (whether production made it one). The existing calibration
 * judges the bucket; `forecastBias` names a systematic error and the
 * correction it proposes. Openings production has not resolved are not
 * outcomes and are left out, never read as failures.
 */
export function methodForecastReading(
  methodKey: string,
  problems: readonly SprintProblem[],
  verdicts: readonly MethodVerdict[],
  at: string,
): { bias: BiasReading[]; calibration: CalibrationBucket | null } {
  const byId = new Map(problems.map((p) => [p.id, p]));
  const predictions: PredictionRow[] = [];
  const exposures: ExposureRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (const v of verdicts) {
    const p = byId.get(v.problemId);
    if (!p || !resolvedInProduction(p)) continue;
    const id = `${methodKey}:${p.id}`;
    predictions.push({
      id,
      claimId: id,
      version: 1,
      outcome: `"${p.title}" becomes an actionable transaction pathway`,
      horizonDays: null,
      population: 'cash_opportunities with an evidence card',
      data: [`cash_opportunities:${p.id}`],
      assumptions: [],
      probability: v.probability,
      comparableKey: methodKey,
      madeAt: at,
    });
    exposures.push({ predictionId: id, exposedAt: at, atRiskCents: null });
    outcomes.push({ predictionId: id, observedAt: at, occurred: actionableInProduction(p), evidence: `cash_opportunities:${p.id}#state=${p.state}` });
  }
  const buckets = calibrate(buildLedger(predictions, exposures, outcomes));
  return { bias: forecastBias(predictions, exposures, outcomes), calibration: buckets.find((b) => b.comparableKey === methodKey) ?? null };
}

/** The per-question method judgment for one opening, from what its card, controller and calibration evidence say. */
export function sprintSelection(p: SprintProblem, general: MethodVerdict, calibration: CalibrationBucket | null): MathSelection {
  const holds = general.decision?.hypotheses.find((h) => h.id === MECHANISM_HOLDS) ?? null;
  const supports = holds?.supports ?? [];
  const next = general.decision?.next ?? null;
  const unknowns = profileOf(p).unknowns;
  const selection = selectMathematics({
    question: 'What does one transaction bill, and how likely is it to become an actionable pathway?',
    subject: `opening ${p.id}`,
    candidates: [
      {
        family: 'cash_flow_identities',
        purpose: 'the gross billed per transaction, exact given the sourced price',
        preconditions: [
          general.provenance
            ? { condition: 'a sourced price states the billed amount', state: 'HOLDS', evidence: general.provenance.sources.map((x) => x.ref) }
            : { condition: 'a sourced price states the billed amount', state: 'UNKNOWN', evidence: [] },
        ],
      },
      {
        family: 'probability_bayesian_inference',
        purpose: 'weigh the mechanism hypotheses on the research claims they cite',
        preconditions: [
          supports.length > 0
            ? { condition: 'research claims bear on the mechanism', state: 'HOLDS', evidence: supports.map((id) => `claim:${id}`) }
            : { condition: 'research claims bear on the mechanism', state: 'UNKNOWN', evidence: [] },
        ],
      },
      {
        family: 'statistical_estimation_calibration',
        purpose: 'judge the stated probability against resolved openings',
        preconditions: [countPrecondition('enough resolved openings to judge calibration', calibration?.n ?? 0, MIN_CALIBRATION_SAMPLE, `sprint:${GENERAL_METHOD.key}`)],
      },
      {
        family: 'value_of_information_experimental_design',
        purpose: 'choose which unknown to research first by what it could change',
        preconditions: [
          unknowns.length > 0 && next
            ? { condition: 'an open unknown whose answer could change the decision', state: 'HOLDS', evidence: [next.key] }
            : { condition: 'an open unknown whose answer could change the decision', state: 'FAILS', evidence: [`cash_opportunities:${p.id}: ${unknowns.length} load-bearing unknown(s)${next ? '' : ', no action valued'}`] },
        ],
      },
    ],
  });
  // The subject carries what was chosen, so a changed judgment is a new row and an unchanged one is not repeated.
  return { ...selection, subject: `opening ${p.id} [${selection.selected.join('+') || 'none fit'}]` };
}

/** Both methods' probabilities for one opening, each with its provenance. */
export function probabilityRecords(
  p: SprintProblem,
  general: MethodVerdict,
  baseline: MethodVerdict,
  reading: Record<string, { bias: BiasReading[]; calibration: CalibrationBucket | null }>,
  at: string,
): { records: NumberProvenance[]; refused: number } {
  const holds = general.decision?.hypotheses.find((h) => h.id === MECHANISM_HOLDS) ?? null;
  const definition = `probability that "${p.title}" becomes an actionable transaction pathway`.slice(0, 300);
  const horizon = 'until production resolves the opening (READY or later, or declined/archived)';
  const out: NumberProvenance[] = [];
  let refused = 0;
  const specs = [
    {
      method: GENERAL_METHOD.key,
      v: general,
      other: baseline,
      sourceRef: `method:${GENERAL_METHOD.key}:cash_opportunities:${p.id}`,
      evidence: holds && holds.supports.length > 0 ? holds.supports.map((id) => `claim:${id}`) : [`cash_opportunities:${p.id}: no cited research claim, so the uninformed 0.5 per unresolved role`],
      applies: 'mechanism hypotheses scored on cited claims, times each unresolved role\'s counter-model',
    },
    {
      method: BASELINE_METHOD.key,
      v: baseline,
      other: general,
      sourceRef: `rule:${BASELINE_METHOD.key}`,
      evidence: [`cash_opportunities:${p.id}: payer ${known(p, 'payer') ? 'stated' : 'blank'}, price ${known(p, 'priceCents') ? 'stated' : 'blank'}`],
      applies: 'a fixed payer-and-price rule: 0.6 when both are stated, 0.2 otherwise',
    },
  ];
  for (const s of specs) {
    const built = probabilityProvenance({
      key: `actionable-probability:${s.method}:${p.id}`,
      definition,
      value: s.v.probability,
      horizon,
      sourceRef: s.sourceRef,
      retrievedAt: at,
      method: s.applies,
      evidence: s.evidence,
      alternatives: [{ label: `the ${s.method === GENERAL_METHOD.key ? BASELINE_METHOD.key : GENERAL_METHOD.key} reading of the same opening`, value: s.other.probability }],
      comparableKey: s.method,
      calibration: reading[s.method]?.calibration ?? null,
      bias: reading[s.method]?.bias ?? [],
      interdependence: p.payer ? [`payer:${p.payer}`] : [],
    });
    if (built.ok) out.push(built.record);
    else refused += 1;
  }
  return { records: out, refused };
}

/**
 * Record the numbers every scored opening states — not a sample. A number or
 * judgment already on record unchanged is not written again, so a daily run
 * writes what changed; the first run covers every opening.
 */
export async function recordSprintMath(
  problems: readonly SprintProblem[],
  generalVerdicts: readonly MethodVerdict[],
  baselineVerdicts: readonly MethodVerdict[],
  now: Date,
  deps: SprintDeps,
  errors: string[],
): Promise<SprintMath> {
  const at = now.toISOString();
  const reading: Record<string, { bias: BiasReading[]; calibration: CalibrationBucket | null }> = {
    [GENERAL_METHOD.key]: methodForecastReading(GENERAL_METHOD.key, problems, generalVerdicts, at),
    [BASELINE_METHOD.key]: methodForecastReading(BASELINE_METHOD.key, problems, baselineVerdicts, at),
  };
  const math: SprintMath = {
    provenanceRecorded: 0,
    provenanceUnchanged: 0,
    provenanceRefused: 0,
    selectionsRecorded: 0,
    bias: Object.fromEntries(Object.entries(reading).map(([k, r]) => [k, r.bias])),
    calibration: Object.fromEntries(Object.entries(reading).map(([k, r]) => [k, r.calibration])),
  };
  let held: Set<string>;
  try {
    held = await (deps.recordedMath ?? (() => readRecordedMathReasons(SPRINT_CALLER)))();
  } catch (error) {
    errors.push(`math: ${String((error as Error).message ?? error).slice(0, 200)}`);
    held = new Set();
  }
  try {
    for (const [method, r] of Object.entries(reading)) {
      if (r.bias.length > 0) await (deps.recordBias ?? recordForecastBias)(r.bias, { caller: SPRINT_CALLER, subject: `sprint method ${method}` });
    }
  } catch (error) {
    errors.push(`bias: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  const byId = new Map(problems.map((p) => [p.id, p]));
  const baselineOf = new Map(baselineVerdicts.map((v) => [v.problemId, v]));
  for (const g of generalVerdicts) {
    const p = byId.get(g.problemId);
    const b = baselineOf.get(g.problemId);
    if (!p || !b) continue;
    const projectId = p.projectId ?? null;
    try {
      const { records, refused } = probabilityRecords(p, g, b, reading, at);
      math.provenanceRefused += refused;
      for (const record of [...(g.provenance ? [g.provenance] : []), ...records]) {
        const key = provenanceReason(record);
        if (held.has(key)) {
          math.provenanceUnchanged += 1;
          continue;
        }
        await (deps.recordProvenance ?? recordNumberProvenance)(record, { projectId, caller: SPRINT_CALLER });
        held.add(key);
        math.provenanceRecorded += 1;
      }
      const selection = sprintSelection(p, g, reading[GENERAL_METHOD.key]?.calibration ?? null);
      const sKey = selectionReason(selection);
      if (!held.has(sKey)) {
        await (deps.recordSelection ?? recordMathSelection)(selection, { projectId, caller: SPRINT_CALLER });
        held.add(sKey);
        math.selectionsRecorded += 1;
      }
    } catch (error) {
      errors.push(`math ${p.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  return math;
}

/* ------------------------------------------------------------------------- */
/* The run                                                                    */
/* ------------------------------------------------------------------------- */

export const SPRINT_EVENT = 'SPRINT_BENCHMARK';
export const SPRINT_INTERVAL_MS = 24 * 3_600_000;
/** How many real problems per run also leave a controller decision as rows (every scored problem's numbers are recorded; see `recordSprintMath`). */
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
  /** The general method's missing capabilities this run, highest leverage first (selected on the benchmark set). */
  capabilities: CapabilityGap[];
  /** The capability shipped to the Factory and awaiting its rerun verdict: this run's, or an earlier one still undelivered. */
  shipped: ShippedCapability | null;
  /** The general method's held-out false positives fed to repair although it beat the baseline. */
  falsePositiveCandidateId: string | null;
  /** This run against the previous one, linked to the change delivered in between. Null on the first run. */
  rerun: RerunReading | null;
  /** The controller's operational loop on real openings this run. */
  loop: SprintLoop;
  /** Every scored opening's material numbers: provenance, per-question method selection and forecast-versus-realized bias. */
  math: SprintMath;
  /** Always present: what the reading is not evidence of. */
  disclaimer: string;
}

/** What the run did with the numbers it states (META-18-3). */
export interface SprintMath {
  /** Provenance rows recorded this run (a number unchanged since its last record is not recorded again). */
  provenanceRecorded: number;
  /** Numbers already on record unchanged. */
  provenanceUnchanged: number;
  /** Numbers the toolkit refused (an unsourced figure, units that do not reconcile): findings, not failures. */
  provenanceRefused: number;
  selectionsRecorded: number;
  /** Per method: its probabilities against what production resolved, with the correction a systematic error proposes. */
  bias: Record<string, BiasReading[]>;
  /** Per method: the calibration bucket that decides whether its probabilities may be called calibrated. */
  calibration: Record<string, CalibrationBucket | null>;
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
  errors: string[];
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<PreviousRun | null>;
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
  recordSelection?: typeof recordMathSelection;
  recordBias?: typeof recordForecastBias;
  /** What this caller's provenance and selection rows already say (default: `readRecordedMathReasons`), so only a changed number is recorded again. */
  recordedMath?: () => Promise<Set<string>>;
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
  /** Real owner interventions per opening (default: `readOwnerInterventions`). */
  interventions?: (problems: readonly SprintProblem[]) => Promise<Map<string, number>>;
  /** A shipped candidate's state, to link a rerun to the change it delivered (default: the improvement repository). */
  candidate?: (id: string) => Promise<CandidateState | null>;
}

/** The previous run as recorded: when, its cutoff, and — when the row carries them — its readings and what it shipped. */
export interface PreviousRun {
  at: string;
  cutoff: string | null;
  readings?: unknown[];
  shipped?: ShippedCapability | null;
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
    .filter((p) => !history.has(p.id) && !ACTIONABLE_STATES.has(p.state) && !GATE_STATES.has(p.state) && !DEAD_STATES.has(p.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
  for (const p of open) {
    if (out.length >= Math.max(limit, 0)) break;
    out.push({ problem: p, result: null });
  }
  return out;
}

export const SPRINT_DISCLAIMER =
  'A comparison of two reasoning methods on these production rows. It is not evidence that a general superintelligence can be created, in seven days or otherwise.';

function shippedFrom(v: unknown): ShippedCapability | null {
  const o = v as { capability?: unknown; candidateId?: unknown; shippedAt?: unknown } | null | undefined;
  if (!o || typeof o.candidateId !== 'string' || typeof o.shippedAt !== 'string') return null;
  return { capability: typeof o.capability === 'string' ? o.capability : null, candidateId: o.candidateId, shippedAt: o.shippedAt };
}

async function previousRun(): Promise<PreviousRun | null> {
  const [last] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
  if (!last) return null;
  const cutoff = typeof last.detail['cutoff'] === 'string' ? (last.detail['cutoff'] as string) : null;
  const readings = Array.isArray(last.detail['readings']) ? (last.detail['readings'] as unknown[]) : [];
  return { at: last.at, cutoff, readings, shipped: shippedFrom(last.detail['shipped']) };
}

async function candidateState(id: string): Promise<CandidateState | null> {
  const { getCandidate } = await import('../../repos/improvement.ts');
  const c = await getCandidate(id);
  return c ? { id: c.id, weaknessKey: c.weaknessKey, deliveredAt: c.deliveredAt, deliveredRef: c.deliveredRef, decision: c.decision } : null;
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
  let interventions: Map<string, number> | null = null;
  const readErrors: string[] = [];
  try {
    interventions = await (deps.interventions ?? readOwnerInterventions)(problems);
  } catch (error) {
    // Unread is not zero: the measure says INSUFFICIENT_DATA rather than claim nobody intervened.
    readErrors.push(`interventions: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  const baselineVerdicts: MethodVerdict[] = [];
  let benchmarkVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = ps.map((p) => GENERAL_METHOD.run(p, threshold, contextOf(p)));
    generalVerdicts.push(...g);
    if (set === 'BENCHMARK') benchmarkVerdicts = g;
    const gr = readSet(set, GENERAL_METHOD.key, ps, g, interventions);
    readings.push(gr);
    // Against every simpler method, the readiness gate included: matching the gate is not reasoning.
    for (const baseline of BASELINES) {
      const b = ps.map((p) => baseline.run(p, threshold));
      if (baseline === BASELINE_METHOD) baselineVerdicts.push(...b);
      const br = readSet(set, baseline.key, ps, b, interventions);
      readings.push(br);
      comparisons.push(compareWithBaseline(gr, br));
    }
  }

  // The controller's operational loop on real openings: track what production said about an earlier
  // decision (a row, and a method outcome the library learns from), decide again with that result —
  // a contradicted one changes the method — record the decision, and hand the next action to its owner.
  const history = await (deps.history ?? (() => readControllerHistory(SPRINT_CALLER)))();
  const loop: SprintLoop = { resultsTracked: 0, decisions: 0, methodChanges: 0, capabilityGaps: 0, handOffs: {}, proceduresRecorded: 0, knowledgeRead: 0, mechanismsModelled: 0, informationNeeds: 0, errors: [...readErrors] };
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
  // Every scored opening's numbers, not only the demonstrated ones: provenance for the gross billed and both
  // methods' probabilities, the per-question method judgment, and each method's forecasts against what
  // production resolved, with the correction a systematic error proposes (META-18-3).
  const math = await recordSprintMath(problems, generalVerdicts, baselineVerdicts, now, deps, loop.errors);
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
  // The rerun: the same sets measured again, linked to the change shipped since the previous run.
  let rerun: RerunReading | null = null;
  let carried: ShippedCapability | null = previous?.shipped ?? null;
  if (previous) {
    let candidate: CandidateState | null = null;
    if (carried) {
      try {
        candidate = await (deps.candidate ?? candidateState)(carried.candidateId);
      } catch (error) {
        loop.errors.push(`candidate: ${String((error as Error).message ?? error).slice(0, 200)}`);
      }
    }
    rerun = compareRuns({ previousRunAt: previous.at, previousReadings: previous.readings ?? [], readings, shipped: carried, candidate, now: now.toISOString() });
    // A shipped capability stays linked until a rerun measures its delivered change.
    if (rerun.verdict !== 'NO_CHANGE_DELIVERED') carried = null;
  }

  // The highest-leverage missing capability, chosen on the benchmark set only; the held-out sets verify it at the rerun.
  const capabilities = split.BENCHMARK.length >= MIN_SAMPLE ? rankCapabilityGaps(split.BENCHMARK, benchmarkVerdicts) : [];
  const top = capabilities.find((c) => c.explains >= MIN_CAPABILITY_MISSES) ?? null;
  const register = async (weakness: Weakness): Promise<string> =>
    (await (deps.registerDirected ?? (await import('./loop.ts')).registerDirected)(weakness, now)).candidate.id;
  const capabilityWeakness = (cap: CapabilityGap, extra: string | null): Weakness => ({
    key: `reasoning-sprint:capability:${cap.key}`,
    kind: 'REASONING_CAPABILITY',
    title: `The general reasoning method cannot ${cap.title}`.slice(0, 200),
    problem: (`${cap.explains} of ${cap.of} benchmark misses come from this missing capability` + (extra ? ` | ${extra}` : '')).slice(0, 1000),
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'improvement/sprint',
    mutationScope: [...cap.ownerPaths, 'server/services/improvement/sprint.ts'],
    frequency: cap.explains,
    denominator: Math.max(cap.of, 1),
    scope: 'GENERAL',
    severity: 'MEDIUM',
    researchQuestion: cap.question,
    samples: cap.problems.slice(0, 5),
    knownCause: null,
  });

  // Held-out failure feeds the existing repair path, once per weakness family (registerDirected refreshes an open one),
  // and names the capability to build; otherwise the highest-leverage capability is shipped on its own.
  let repairCandidateId: string | null = null;
  let shipped: ShippedCapability | null = carried;
  const failed = comparisons.filter((c) => c.set !== 'BENCHMARK' && c.earned === false);
  if (failed.length > 0) {
    const fp = failed.flatMap((c) => c.general.falsePositives).slice(0, 5);
    repairCandidateId = await register({
      key: 'reasoning-sprint:general-method',
      kind: 'REASONING_CAPABILITY',
      title: 'The general reasoning method did not beat a simpler baseline (payer-and-price, or the readiness gate itself) on held-out commercial problems',
      problem: (failed.map((c) => c.statement).join(' | ') + (top ? ` | highest-leverage missing capability: ${top.key} (${top.explains} of ${top.of} benchmark misses)` : '')).slice(0, 1000),
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'improvement/sprint',
      mutationScope: [...new Set([...(top?.ownerPaths ?? []), 'server/services/research/**', 'server/services/quant/**', 'server/services/improvement/sprint.ts'])],
      frequency: failed.reduce((s, c) => s + c.general.problems, 0),
      denominator: problems.length,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: top ? top.question : 'which general reasoning capability would turn more real openings into actionable pathways than a payer-and-price rule',
      samples: fp,
      knownCause: null,
    });
    shipped = { capability: top?.key ?? null, candidateId: repairCandidateId, shippedAt: now.toISOString() };
  } else if (top && !carried) {
    const notImproved = rerun?.verdict === 'NOT_IMPROVED' ? `the previous change did not improve held-out results: ${rerun.statement}` : null;
    const id = await register(capabilityWeakness(top, notImproved));
    shipped = { capability: top.key, candidateId: id, shippedAt: now.toISOString() };
  }

  // Per-method findings reach repair even when the general method wins: its held-out false positives are its own errors.
  let falsePositiveCandidateId: string | null = null;
  const fpWins = comparisons.filter((c) => c.set !== 'BENCHMARK' && c.earned !== false && c.general.falsePositives.length > 0);
  if (fpWins.length > 0) {
    const ids = fpWins.flatMap((c) => c.general.falsePositives);
    falsePositiveCandidateId = await register({
      key: 'reasoning-sprint:false-positives',
      kind: 'REASONING_CAPABILITY',
      title: 'The general reasoning method called held-out openings actionable that production did not',
      problem: fpWins.map((c) => `${c.set}: ${c.general.falsePositives.length} of ${c.general.problems} called actionable and not confirmed (${c.statement})`).join(' | ').slice(0, 1000),
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'improvement/sprint',
      mutationScope: [...CAPABILITY_SPECS['counter-model']!.ownerPaths, 'server/services/improvement/sprint.ts'],
      frequency: ids.length,
      denominator: fpWins.reduce((s, c) => s + c.general.problems, 0),
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: CAPABILITY_SPECS['counter-model']!.question,
      samples: ids.slice(0, 5),
      knownCause: null,
    });
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
    capabilities: capabilities.slice(0, 5),
    shipped,
    falsePositiveCandidateId,
    rerun,
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
      comparisons: run.comparisons.map((c) => ({ set: c.set, baseline: c.baseline.method, earned: c.earned, statement: c.statement })),
      capabilities: run.capabilities,
      shipped: run.shipped,
      falsePositiveCandidateId: run.falsePositiveCandidateId,
      rerun: run.rerun,
      loop: run.loop,
      math: run.math,
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
