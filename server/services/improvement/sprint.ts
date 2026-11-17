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
import { loadProjectKnowledge, mechanismFromOpening, type KnowledgeReading, type MechanismModel } from '../research/knowledgeModel.ts';
import { buildNumberProvenance, recordNumberProvenance, type NumberProvenance, type ProvenanceInput } from '../quant/mathToolkit.ts';
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
  /**
   * Real owner interventions on this opening, counted from rows: a cash event a
   * person (a `usr…` actor) carried out on it, and a Needs-You (`cash_needs`)
   * request Brain raised about it. Never a model of what a method predicts; absent
   * when the rows were not read, which is not the same as zero.
   */
  ownerInterventions?: number;
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

/**
 * Real owner interventions per opening, from the rows that record them: an
 * action a signed-in person took on the opening (`cash_events.actor_ref` is a
 * user id; Brain's own rows carry 'BRAIN' or a `brain:` ref) and a request
 * Brain raised to a person about it (`cash_needs`).
 */
export async function readOwnerInterventions(): Promise<Map<string, number>> {
  const db = getDb();
  const [acted, asked] = await Promise.all([
    db.all<{ opportunity_id: string; n: number | string }>(
      `SELECT opportunity_id, COUNT(*) AS n FROM cash_events
        WHERE opportunity_id IS NOT NULL AND actor_ref LIKE 'usr%'
        GROUP BY opportunity_id`,
      [],
    ),
    db.all<{ opportunity_id: string; n: number | string }>(
      `SELECT opportunity_id, COUNT(*) AS n FROM cash_needs
        WHERE opportunity_id IS NOT NULL
        GROUP BY opportunity_id`,
      [],
    ),
  ]);
  const out = new Map<string, number>();
  for (const r of [...acted, ...asked]) out.set(r.opportunity_id, (out.get(r.opportunity_id) ?? 0) + Number(r.n));
  return out;
}

/** Real commercial problems: openings with an evidence card, duplicates excluded, with their real owner interventions. */
export async function readSprintProblems(limit = 2000): Promise<SprintProblem[]> {
  const interventions = await readOwnerInterventions();
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
    ownerInterventions: interventions.get(r.id) ?? 0,
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
    knowledge: context.knowledge ?? null,
    mechanism: context.mechanism ?? null,
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
/* Capabilities: implemented, trialled, verified on held-out sets, adopted     */
/* ------------------------------------------------------------------------- */

/**
 * What a capability learned from the benchmark set. Every field is fitted on
 * benchmark rows only, so a held-out reading of a variant is a real test.
 */
export interface CapabilityFit {
  /** Load-bearing fields whose absence did not stop benchmark openings becoming pathways. */
  optionalFields?: LoadBearing[];
  /** Known-field signatures whose benchmark openings mostly died: counter-examples to an actionable call. */
  deadSignatures?: string[];
  /** Raw controller score bins (upper edges) mapped to the benchmark's observed actionable rate. */
  calibration?: { edges: number[]; rates: number[] };
}

/**
 * A general reasoning capability the sprint can add to the general method.
 * None of them names a category, an industry or a field value: each is a
 * procedure fitted from whatever the benchmark rows hold (R01-A1).
 */
export interface SprintCapability {
  key: string;
  /** Which of the sprint's named techniques this implements. */
  technique: string;
  fit(benchmark: readonly SprintProblem[], raw: ReadonlyMap<string, MethodVerdict>): CapabilityFit;
}

/** The signature a counter-example is matched on: which load-bearing fields are known, and the mechanism. */
export function knownSignature(p: SprintProblem): string {
  return `${p.mechanism}|${LOAD_BEARING.filter((f) => known(p, f)).join(',')}`;
}

export const SPRINT_CAPABILITIES: readonly SprintCapability[] = [
  {
    key: 'learned-load-bearing',
    technique: 'automated decomposition and dimensional validation',
    fit(benchmark) {
      const optionalFields: LoadBearing[] = [];
      for (const f of LOAD_BEARING) {
        // Price and payer carry the provenance and the counterparty: never optional, an unknown is not a convenient figure.
        if (f === 'priceCents' || f === 'payer') continue;
        const missing = benchmark.filter((p) => !known(p, f));
        if (missing.length < MIN_SAMPLE) continue;
        const actionable = missing.filter(actionableInProduction).length;
        if (actionable / missing.length >= 0.5) optionalFields.push(f);
      }
      return { optionalFields };
    },
  },
  {
    key: 'counter-example-check',
    technique: 'explicit counter-models and adversarial checks for expensive decisions',
    fit(benchmark) {
      const bySig = new Map<string, { dead: number; n: number }>();
      for (const p of benchmark) {
        const sig = knownSignature(p);
        const e = bySig.get(sig) ?? { dead: 0, n: 0 };
        e.n += 1;
        if (DEAD_STATES.has(p.state)) e.dead += 1;
        bySig.set(sig, e);
      }
      return { deadSignatures: [...bySig].filter(([, e]) => e.n >= MIN_SAMPLE && e.dead / e.n >= 0.5).map(([sig]) => sig).sort() };
    },
  },
  {
    key: 'calibrated-probability',
    technique: 'closed-loop forecast evaluation',
    fit(benchmark, raw) {
      const edges = [0.2, 0.4, 0.6, 0.8, 1.0000001];
      const hits = edges.map(() => 0);
      const counts = edges.map(() => 0);
      for (const p of benchmark) {
        const v = raw.get(p.id);
        if (!v) continue;
        const i = Math.max(0, edges.findIndex((e) => v.probability < e));
        counts[i]! += 1;
        if (actionableInProduction(p)) hits[i]! += 1;
      }
      // Laplace-smoothed toward the bin's own midpoint, so an empty bin keeps the raw reading rather than an invented one.
      const rates = edges.map((e, i) => {
        const mid = Math.min(1, e) - 0.1;
        return (hits[i]! + mid) / (counts[i]! + 1);
      });
      return { calibration: { edges, rates } };
    },
  },
];

const capabilityByKey = new Map(SPRINT_CAPABILITIES.map((c) => [c.key, c]));

/** Fit the named capabilities on the benchmark set alone. */
export function fitCapabilities(keys: readonly string[], benchmark: readonly SprintProblem[], context?: MethodContext): CapabilityFit {
  const raw = new Map(benchmark.map((p) => [p.id, GENERAL_METHOD.run(p, 1, context)]));
  const fit: CapabilityFit = {};
  for (const key of keys) Object.assign(fit, capabilityByKey.get(key)?.fit(benchmark, raw) ?? {});
  return fit;
}

/**
 * The general method with capabilities applied. With none it behaves exactly
 * as GENERAL_METHOD; each capability changes one step of its decision.
 */
export function generalWith(keys: readonly string[], fit: CapabilityFit): SprintMethod {
  if (keys.length === 0) return GENERAL_METHOD;
  const optional = new Set<string>(fit.optionalFields ?? []);
  const dead = new Set(fit.deadSignatures ?? []);
  const cal = fit.calibration;
  return {
    key: `${GENERAL_METHOD.key}+${[...keys].sort().join('+')}`,
    run(p, threshold, context) {
      const started = performance.now();
      const base = GENERAL_METHOD.run(p, threshold, context);
      const required = profileOf(p).unknowns.filter((f) => !optional.has(f));
      let probability = base.probability;
      if (cal) {
        const i = Math.max(0, cal.edges.findIndex((e) => probability < e));
        probability = cal.rates[i] ?? probability;
      }
      let findings = base.findings;
      let actionable = required.length === 0 && base.provenance != null && probability >= threshold;
      if (actionable && dead.has(knownSignature(p))) {
        actionable = false;
        findings += 1;
      }
      const robust = actionable && base.provenance != null && base.provenance.alternatives.every((a) => a.value !== null && a.value > 0);
      return {
        ...base,
        actionable,
        probability,
        needsPerson: !actionable && (base.decision?.next == null || base.decision.next.kind === 'METHOD_GAP'),
        robust,
        findings,
        elapsedMs: base.elapsedMs + (performance.now() - started),
      };
    },
  };
}

/** Misclassifications plus the Brier sum on a set: the benchmark objective a capability is selected by. */
export function benchmarkLoss(problems: readonly SprintProblem[], method: SprintMethod, threshold: number, context?: MethodContext): number {
  let loss = 0;
  for (const p of problems) {
    const v = method.run(p, threshold, context);
    const truth = actionableInProduction(p);
    if (v.actionable !== truth) loss += 1;
    loss += (v.probability - (truth ? 1 : 0)) ** 2;
  }
  return Math.round(loss * 10000) / 10000;
}

export type TrialVerdict = 'ADOPTED' | 'REJECTED' | 'UNVERIFIED';

/** One capability, selected on the benchmark, verified on held-out sets, and adopted or not. */
export interface CapabilityTrial {
  capability: string;
  technique: string;
  /** Every untried capability's benchmark gain: what the selection chose from. */
  leverage: { capability: string; gain: number }[];
  benchmarkLoss: { incumbent: number; variant: number };
  threshold: number;
  fit: CapabilityFit;
  /** The variant against the incumbent, per held-out set: the rerun with the change. */
  verification: { set: ProblemSet; earned: boolean | null; statement: string }[];
  /** Variant reading minus incumbent reading, per set, for the measures the change is meant to move. */
  delta: { set: ProblemSet; pathwayRate: number | null; brier: number | null; robustCoverage: number | null; falsePositives: number }[];
  verdict: TrialVerdict;
}

const diff = (a: Measure, b: Measure): number | null => {
  const x = num(a);
  const y = num(b);
  return x === null || y === null ? null : Math.round((x - y) * 10000) / 10000;
};

/**
 * Select the highest-leverage untried capability on the benchmark set, rerun
 * the benchmark and every held-out set with it, and adopt it only when it
 * beats the incumbent on a held-out set and loses on none. Null when no
 * untried capability improves the benchmark at all.
 */
export function trialCapability(
  split: Record<ProblemSet, SprintProblem[]>,
  adopted: readonly string[],
  tried: ReadonlySet<string>,
  context?: MethodContext,
): CapabilityTrial | null {
  const benchmark = split.BENCHMARK;
  if (benchmark.length < MIN_SAMPLE) return null;
  const incumbentFit = fitCapabilities(adopted, benchmark, context);
  const incumbent = generalWith(adopted, incumbentFit);
  const incumbentThreshold = chooseThreshold(benchmark, incumbent, context);
  const incumbentLoss = benchmarkLoss(benchmark, incumbent, incumbentThreshold, context);
  const leverage: { capability: string; gain: number; threshold: number; fit: CapabilityFit; loss: number }[] = [];
  for (const cap of SPRINT_CAPABILITIES) {
    if (adopted.includes(cap.key) || tried.has(cap.key)) continue;
    const keys = [...adopted, cap.key];
    const fit = fitCapabilities(keys, benchmark, context);
    const variant = generalWith(keys, fit);
    const threshold = chooseThreshold(benchmark, variant, context);
    const loss = benchmarkLoss(benchmark, variant, threshold, context);
    leverage.push({ capability: cap.key, gain: Math.round((incumbentLoss - loss) * 10000) / 10000, threshold, fit, loss });
  }
  leverage.sort((a, b) => b.gain - a.gain || a.capability.localeCompare(b.capability));
  const best = leverage[0];
  if (!best || best.gain <= 0) return null;
  const variant = generalWith([...adopted, best.capability], best.fit);
  const verification: CapabilityTrial['verification'] = [];
  const delta: CapabilityTrial['delta'] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const v = readSet(set, variant.key, ps, ps.map((p) => variant.run(p, best.threshold, context)));
    const i = readSet(set, incumbent.key, ps, ps.map((p) => incumbent.run(p, incumbentThreshold, context)));
    delta.push({
      set,
      pathwayRate: diff(v.actionablePathwayRate, i.actionablePathwayRate),
      brier: diff(v.calibrationBrier, i.calibrationBrier),
      robustCoverage: diff(v.robustTargetCoverage, i.robustTargetCoverage),
      falsePositives: v.falsePositives.length - i.falsePositives.length,
    });
    if (set !== 'BENCHMARK') {
      // A change that buys pathways or fewer person-needs with false positives has not earned adoption.
      const c = compareWithBaseline(v, i);
      const morePositives = v.falsePositives.length > i.falsePositives.length;
      verification.push({
        set,
        earned: c.earned === null ? null : c.earned && !morePositives,
        statement:
          c.statement.replace("the baseline's", "the incumbent's") +
          (morePositives ? `; but ${v.falsePositives.length} false positive(s) against ${i.falsePositives.length}, so it is not adopted` : ''),
      });
    }
  }
  const verdict: TrialVerdict = verification.some((c) => c.earned === false)
    ? 'REJECTED'
    : verification.some((c) => c.earned === true)
      ? 'ADOPTED'
      : 'UNVERIFIED';
  return {
    capability: best.capability,
    technique: capabilityByKey.get(best.capability)!.technique,
    leverage: leverage.map(({ capability, gain }) => ({ capability, gain })),
    benchmarkLoss: { incumbent: incumbentLoss, variant: best.loss },
    threshold: best.threshold,
    fit: best.fit,
    verification,
    delta,
    verdict,
  };
}

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
   * Required human interventions as they really happened: owner-intervention
   * rows on the set's openings (`readOwnerInterventions`), over the openings whose
   * rows were read. A fact about the problems, the same for every method.
   */
  humanInterventions: Measure;
  /** The method's own prediction: problems it could not progress without a person, over the set. */
  modelledPersonNeeds: Measure;
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
  const counted = problems.filter((p) => typeof p.ownerInterventions === 'number');
  const interventions = counted.reduce((s, p) => s + (p.ownerInterventions ?? 0), 0);
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
    humanInterventions: measure(interventions, counted.length),
    modelledPersonNeeds: measure(people, n),
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
  // Real interventions are a fact about the problems, equal for both methods; what a method changes is how often it needs a person.
  const g = { rate: num(general.actionablePathwayRate), brier: num(general.calibrationBrier), people: num(general.modelledPersonNeeds) };
  const b = { rate: num(baseline.actionablePathwayRate), brier: num(baseline.calibrationBrier), people: num(baseline.modelledPersonNeeds) };
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
  /** Every candidate this run fed to the repair path: a held-out loss, and held-out false positives even when the method won. */
  repairCandidateIds: string[];
  /** Capabilities the general method ran with this run (adopted by earlier runs). */
  capabilities: string[];
  /** The capability this run selected, verified and adopted or rejected; null when none was left to improve the benchmark. */
  trial: CapabilityTrial | null;
  /** This run's general readings against the previous run's, linked to the change adopted in between. */
  rerun: SprintRerun | null;
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
  errors: string[];
}

/** A rerun's change against the previous run, and the capability adoption it follows. */
export interface SprintRerun {
  previousRunAt: string;
  /** The capability the previous run adopted, which this run is the first to run with; null when nothing changed. */
  change: { capability: string; adoptedAt: string } | null;
  deltas: { set: ProblemSet; pathwayRate: number | null; brier: number | null; robustCoverage: number | null }[];
}

export interface PreviousSprint {
  at: string;
  cutoff: string | null;
  /** Capabilities adopted up to and including that run. */
  adopted?: string[];
  /** Capabilities tried and rejected up to and including that run: never retried (invariant 16). */
  rejected?: string[];
  /** The capability that run adopted, if any. */
  adoptedThisRun?: string | null;
  readings?: SetReading[];
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<PreviousSprint | null>;
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
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

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

async function previousRun(): Promise<PreviousSprint | null> {
  const [last] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
  if (!last) return null;
  const cutoff = typeof last.detail['cutoff'] === 'string' ? (last.detail['cutoff'] as string) : null;
  const caps = (last.detail['capabilities'] ?? {}) as Record<string, unknown>;
  const trial = (last.detail['trial'] ?? null) as { capability?: unknown; verdict?: unknown } | null;
  return {
    at: last.at,
    cutoff,
    adopted: strings(caps['adopted']),
    rejected: strings(caps['rejected']),
    adoptedThisRun: trial && trial.verdict === 'ADOPTED' && typeof trial.capability === 'string' ? trial.capability : null,
    readings: Array.isArray(last.detail['readings']) ? (last.detail['readings'] as SetReading[]) : [],
  };
}

/** This run's general readings against the previous run's on the stable sets. */
export function rerunAgainst(previous: PreviousSprint | null, readings: readonly SetReading[]): SprintRerun | null {
  if (!previous?.readings?.length) return null;
  const isGeneral = (r: SetReading) => typeof r.method === 'string' && r.method.startsWith(GENERAL_METHOD.key);
  const deltas: SprintRerun['deltas'] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT'] as const) {
    const before = previous.readings.find((r) => r.set === set && isGeneral(r));
    const after = readings.find((r) => r.set === set && isGeneral(r));
    if (!before || !after) continue;
    deltas.push({
      set,
      pathwayRate: diff(after.actionablePathwayRate, before.actionablePathwayRate),
      brier: diff(after.calibrationBrier, before.calibrationBrier),
      robustCoverage: diff(after.robustTargetCoverage, before.robustTargetCoverage),
    });
  }
  return { previousRunAt: previous.at, change: previous.adoptedThisRun ? { capability: previous.adoptedThisRun, adoptedAt: previous.at } : null, deltas };
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
  // The general method runs with every capability earlier runs adopted, each refitted on the benchmark alone.
  const adopted = (previous?.adopted ?? []).filter((k) => capabilityByKey.has(k));
  const general = generalWith(adopted, fitCapabilities(adopted, split.BENCHMARK, learned));
  const threshold = chooseThreshold(split.BENCHMARK, general, learned);

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = ps.map((p) => general.run(p, threshold, learned));
    const b = ps.map((p) => BASELINE_METHOD.run(p, threshold));
    generalVerdicts.push(...g);
    const gr = readSet(set, general.key, ps, g);
    const br = readSet(set, BASELINE_METHOD.key, ps, b);
    readings.push(gr, br);
    comparisons.push(compareWithBaseline(gr, br));
  }

  // The controller's operational loop on real openings: track what production said about an earlier
  // decision (a row, and a method outcome the library learns from), decide again with that result —
  // a contradicted one changes the method — record the decision, and hand the next action to its owner.
  const verdictOf = new Map(generalVerdicts.map((v) => [v.problemId, v]));
  const history = await (deps.history ?? (() => readControllerHistory(SPRINT_CALLER)))();
  const loop: SprintLoop = { resultsTracked: 0, decisions: 0, methodChanges: 0, capabilityGaps: 0, handOffs: {}, proceduresRecorded: 0, knowledgeRead: 0, mechanismsModelled: 0, informationNeeds: 0, errors: [] };
  const knowledgeCache = new Map<string, Promise<KnowledgeReading>>();
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
      const layers = await openingLayers(p, now, knowledgeCache, deps.knowledge);
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
    const v = verdictOf.get(p.id);
    if (v?.provenance) {
      try {
        await (deps.recordProvenance ?? recordNumberProvenance)(v.provenance, { projectId, caller: SPRINT_CALLER });
      } catch {
        // A record the toolkit refuses is a finding already counted in method quality, not a run failure.
      }
    }
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
  // Implement → verify → adopt: the highest-leverage untried capability is selected on the benchmark,
  // rerun on the benchmark and every held-out set against the incumbent, and adopted only when it wins there.
  const rejectedBefore = (previous?.rejected ?? []).filter((k) => capabilityByKey.has(k));
  const trial = trialCapability(split, adopted, new Set(rejectedBefore), learned);
  const adoptedAfter = trial?.verdict === 'ADOPTED' ? [...adopted, trial.capability] : adopted;
  const rejectedAfter = trial?.verdict === 'REJECTED' ? [...rejectedBefore, trial.capability] : rejectedBefore;
  const rerun = rerunAgainst(previous, readings);

  // Held-out failure feeds the existing repair path, once per weakness family (registerDirected refreshes an open one).
  let repairCandidateId: string | null = null;
  const repairCandidateIds: string[] = [];
  const failed = comparisons.filter((c) => c.set !== 'BENCHMARK' && c.earned === false);
  const register = async (w: Weakness): Promise<string> => {
    const fn = deps.registerDirected ?? (await import('./loop.ts')).registerDirected;
    const { candidate } = await fn(w, now);
    repairCandidateIds.push(candidate.id);
    return candidate.id;
  };
  if (failed.length > 0) {
    const fp = failed.flatMap((c) => c.general.falsePositives).slice(0, 5);
    repairCandidateId = await register(
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
    );
  }
  // A method that wins overall can still call dead openings actionable: those false positives are its own
  // findings, and they reach repair whether or not the comparison was earned.
  const heldOutFp = comparisons
    .filter((c) => c.set !== 'BENCHMARK' && c.earned !== null && !failed.includes(c))
    .flatMap((c) => c.general.falsePositives);
  if (heldOutFp.length > 0) {
    const id = await register({
      key: 'reasoning-sprint:false-positives',
      kind: 'REASONING_CAPABILITY',
      title: 'The general reasoning method called held-out openings actionable that production did not confirm',
      problem:
        `${heldOutFp.length} held-out opening(s) were called actionable by ${general.key} and did not become pathways, ` +
        `even where the method beat the baseline overall.`,
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'improvement/sprint',
      mutationScope: ['server/services/research/**', 'server/services/quant/**', 'server/services/improvement/sprint.ts'],
      frequency: heldOutFp.length,
      denominator: comparisons.filter((c) => c.set !== 'BENCHMARK').reduce((s, c) => s + c.general.problems, 0),
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: 'which counter-model or adversarial check would have refuted these actionable calls before they were made',
      samples: heldOutFp.slice(0, 5),
      knownCause: null,
    });
    repairCandidateId ??= id;
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
    repairCandidateIds,
    capabilities: adopted,
    trial,
    rerun,
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
      capabilities: { ranWith: adopted, adopted: adoptedAfter, rejected: rejectedAfter },
      trial: run.trial,
      rerun: run.rerun,
      repairCandidateIds,
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
