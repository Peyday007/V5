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
  /** Always present: what the reading is not evidence of. */
  disclaimer: string;
}

export interface SprintDeps {
  read?: () => Promise<SprintProblem[]>;
  previous?: () => Promise<{ at: string; cutoff: string | null } | null>;
  record?: typeof recordImprovementEvent;
  recordDecision?: typeof recordControllerDecision;
  recordProvenance?: typeof recordNumberProvenance;
  registerDirected?: (weakness: Weakness, now?: Date) => Promise<{ candidate: { id: string } }>;
  now?: () => Date;
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
  const threshold = chooseThreshold(split.BENCHMARK);

  const readings: SetReading[] = [];
  const comparisons: BaselineComparison[] = [];
  const generalVerdicts: MethodVerdict[] = [];
  for (const set of ['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT'] as const) {
    const ps = split[set];
    const g = ps.map((p) => GENERAL_METHOD.run(p, threshold));
    const b = ps.map((p) => BASELINE_METHOD.run(p, threshold));
    generalVerdicts.push(...g);
    const gr = readSet(set, GENERAL_METHOD.key, ps, g);
    const br = readSet(set, BASELINE_METHOD.key, ps, b);
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
