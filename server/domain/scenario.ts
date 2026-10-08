/**
 * The scenario engine's vocabulary.
 *
 * A scenario model is a typed, declarative description of a decision: the
 * variables that bear on it, where each one came from, how they relate, the
 * strategies a person controls, and the arithmetic that turns one draw of the
 * world plus one strategy into money, time and labour. Nothing here computes;
 * `services/scenario/` does. Keeping the vocabulary in one file is what lets a
 * later integration — Cash, monetization, Factory capacity — build a model from
 * its own rows without importing the engine's internals.
 *
 * Three rules are written into the shape of these types rather than into
 * comments somebody has to remember:
 *
 *   * **Every variable says what it is.** `provenance` is required, and only
 *     `EVIDENCE` and `HISTORICAL` may carry a probability distribution or a
 *     weighted choice. An assumption or an unknown can be a *range* — swept, so
 *     its outcomes are coverage of a tested interval and never probabilities.
 *     A distribution nobody can source would make every percentile downstream a
 *     number that reads like a measurement and is a guess.
 *   * **Money is line items, and the engine sums them.** A model declares each
 *     revenue and each cost once, by key; contribution is computed from the
 *     lines and never written by the model, so a cost cannot be subtracted twice
 *     by an expression that mentions it twice.
 *   * **Results are labelled as simulated.** Every result carries
 *     `simulated: true`, the configuration hash and the seed, for
 *     `services/dispatch/simulate.ts`'s reason: a projection that cannot be
 *     traced to its assumptions is quoted later as though it were observed.
 */

/** Where a variable's value came from. Ordered strongest first. */
export const VARIABLE_PROVENANCES = [
  /** A sourced fact — a gated claim, a published figure, a ledger entry. */
  'EVIDENCE',
  /** Observations of what actually happened before, counted rather than said. */
  'HISTORICAL',
  /** A statement a person made and is accountable for, not established. */
  'ASSUMPTION',
  /** A deliberately illustrative value, used to explore "what if". */
  'HYPOTHETICAL',
  /** Nobody knows. Only a range may stand for it, and it is swept. */
  'UNKNOWN',
] as const;
export type VariableProvenance = (typeof VARIABLE_PROVENANCES)[number];

/** Provenances that may justify a probability distribution or choice weights. */
export const DISTRIBUTION_PROVENANCES: readonly VariableProvenance[] = ['EVIDENCE', 'HISTORICAL'];

/**
 * A pointer to the row or source a value rests on.
 *
 * The engine copies nothing from the record: a future integration hands it
 * the reference and the value, and a reader follows the reference back. That
 * is what keeps this engine from becoming a second owner of a Cash fact.
 */
export interface SourceRef {
  kind: 'CLAIM' | 'CASH_OPPORTUNITY' | 'CARD_FACT' | 'LEDGER_ENTRY' | 'DOCUMENT' | 'URL' | 'PERSON' | 'OTHER';
  ref: string;
  note?: string;
}

/** One option of a categorical variable. Its attributes are what expressions read. */
export interface ChoiceOption {
  key: string;
  label: string;
  /** Numeric attributes, read in an expression as `variable.attribute`. */
  attributes: Record<string, number>;
  /** A weight, only where provenance justifies one. */
  weight?: number;
}

export type VariableSpec =
  /** One value. */
  | { kind: 'FIXED'; value: number }
  /** A bounded interval. Sampled uniformly (swept) — coverage, not probability. */
  | { kind: 'RANGE'; min: number; max: number }
  /** A sourced distribution, truncated to its own bounds. */
  | { kind: 'TRIANGULAR'; min: number; mode: number; max: number }
  | { kind: 'NORMAL'; mean: number; sd: number; min: number; max: number }
  /** Observed values, resampled as an empirical distribution. */
  | { kind: 'EMPIRICAL'; values: number[] }
  /** A categorical variable. */
  | { kind: 'CHOICE'; options: ChoiceOption[] };

/**
 * A documented relationship: this variable responds to another.
 *
 * Constant elasticity — `value × (other / reference) ^ elasticity` — applied
 * after the strategy sets the controllables. It is the one relationship shape
 * the engine knows, so it is one a reader can check, and it carries its own
 * provenance because a relationship is a claim exactly as a value is.
 */
export interface ResponseSpec {
  to: string;
  elasticity: number;
  reference: number;
  provenance: VariableProvenance;
  note?: string;
}

/**
 * A variable is active only while a categorical variable holds one of some
 * options. Inactive, it takes `inactiveValue`, is not sampled, and is left out
 * of that strategy's sensitivity — a contractor's rate does not bear on a
 * strategy with no contractors.
 */
export interface ActiveWhen {
  variable: string;
  in: string[];
  inactiveValue: number;
}

export interface ScenarioVariable {
  key: string;
  label: string;
  unit: string;
  provenance: VariableProvenance;
  /** Controllable: a decision a strategy sets. Never sampled. */
  controllable: boolean;
  spec: VariableSpec;
  sources?: SourceRef[];
  note?: string;
  responses?: ResponseSpec[];
  activeWhen?: ActiveWhen;
  /** For a FIXED or controllable numeric variable: the interval sensitivity may search. */
  testRange?: { min: number; max: number };
}

/**
 * A statistical dependency between two sampled numeric variables, as a rank
 * correlation imposed through a Gaussian copula. Only between variables whose
 * relationship is known — declared, with provenance — never inferred.
 */
export interface CorrelationSpec {
  a: string;
  b: string;
  rho: number;
  provenance: VariableProvenance;
  note?: string;
}

/** A named intermediate quantity, evaluated in declaration order. */
export interface DerivedSpec {
  key: string;
  label: string;
  unit: string;
  expr: string;
}

/** One revenue or cost, in the model's currency units, over the model horizon. */
export interface MoneyLine {
  key: string;
  label: string;
  kind: 'REVENUE' | 'COST';
  expr: string;
}

/** A non-money outcome the comparison reads. */
export interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  expr: string;
  better: 'HIGHER' | 'LOWER';
  /** The standard role this metric plays, so the comparison can name it. */
  role?: 'CAPITAL_EXPOSURE' | 'DAYS_TO_CASH' | 'LABOR_HOURS' | 'OTHER';
}

/** A scenario violating any constraint is infeasible: counted, never hidden. */
export interface ConstraintSpec {
  key: string;
  label: string;
  expr: string;
  op: '<=' | '>=' | '<' | '>';
  value: number;
}

export interface StrategySpec {
  key: string;
  label: string;
  description?: string;
  /** Controllable variable key → numeric value, or option key for a CHOICE. */
  set: Record<string, number | string>;
}

export interface ScenarioModelDefinition {
  title: string;
  description?: string;
  /** ISO 4217 code for the money lines; the engine reports cents. */
  currency: string;
  /** What one evaluation covers — "six months of operation". */
  horizon: string;
  variables: ScenarioVariable[];
  correlations?: CorrelationSpec[];
  derived?: DerivedSpec[];
  lines: MoneyLine[];
  metrics?: MetricSpec[];
  constraints?: ConstraintSpec[];
  strategies: StrategySpec[];
  /** True for an illustrative model; the UI says so on every figure. */
  illustrative?: boolean;
}

/** Bounds on one run. Each is a ceiling, and exceeding one is a refusal. */
export const SCENARIO_LIMITS = {
  maxEvaluations: 50_000,
  maxVariables: 40,
  maxStrategies: 8,
  maxDerived: 60,
  maxLines: 40,
  maxMetrics: 12,
  maxConstraints: 12,
  maxExpressionLength: 600,
  maxExpressionDepth: 40,
  maxEmpiricalValues: 5_000,
  maxChoiceOptions: 12,
  /** Wall-clock budget for the sampling loop; past it the run fails rather than hangs. */
  maxRunMs: 20_000,
} as const;

export const ENGINE_VERSION = 'scenario-engine/1';

export type RunBasis = 'MONTE_CARLO' | 'SWEEP';

export interface RunOptions {
  seed: number;
  /** Total evaluations = scenarios × strategies. Capped at SCENARIO_LIMITS.maxEvaluations. */
  evaluations: number;
  /** Requested basis. MONTE_CARLO is refused unless every sampled input is justified. */
  basis?: RunBasis;
  /** Stress overrides: multiply a variable or replace it, applied to every scenario. */
  overrides?: Record<string, { multiply?: number; value?: number }>;
  /** An explicit objective a person chose; without one the engine ranks nothing. */
  objective?: SelectedObjective;
  /** What "acceptable" means for robustness. Default: feasible and contribution ≥ 0. */
  acceptable?: { minContributionCents: number };
}

export type SummaryStatistic = 'MEAN' | 'P10' | 'P50' | 'P90' | 'MIN' | 'MAX';

export interface SelectedObjective {
  /** `contribution` or a metric key. */
  metric: string;
  statistic: SummaryStatistic;
  direction: 'MAX' | 'MIN';
  constraints?: Array<{ metric: string; statistic: SummaryStatistic; op: '<=' | '>='; value: number }>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface Distribution {
  mean: number;
  sd: number;
  min: number;
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
  /** Mean of the worst 10% (lowest for HIGHER-is-better, highest otherwise). */
  tail10: number;
}

export interface Histogram {
  /** Shared edges across strategies, so bars are comparable. */
  edges: number[];
  counts: number[];
}

export interface DownsideCase {
  scenario: number;
  contributionCents: number;
  /** The exact inputs this strategy saw in that scenario. */
  inputs: Record<string, number | string>;
  infeasible: string[];
}

export interface StrategyResult {
  key: string;
  label: string;
  evaluated: number;
  invalid: number;
  infeasible: number;
  /** Over feasible, valid scenarios, in cents. Null when none was feasible. */
  contribution: Distribution | null;
  lines: Record<string, { meanCents: number; p50Cents: number }>;
  metrics: Record<string, Distribution | null>;
  /** Share of all scenarios with contribution below zero, feasible or not. */
  lossShare: number;
  /** Share meeting the acceptability rule — feasible and contribution at least the floor. */
  acceptableShare: number;
  /** Share of scenarios where this strategy had the best contribution (paired draws). */
  winShare: number;
  /** Best contribution in a scenario minus this strategy's, across scenarios. */
  regret: { meanCents: number; p90Cents: number; maxCents: number };
  histogram: Histogram;
  downside: DownsideCase[];
  distinctContributions: number;
}

export interface DominanceFinding {
  dominated: string;
  by: string;
  /** The summary criteria the comparison used, named. */
  on: string[];
}

export interface TradeOff {
  a: string;
  b: string;
  aBetterOn: string[];
  bBetterOn: string[];
}

export interface TornadoBar {
  variable: string;
  label: string;
  provenance: VariableProvenance;
  lowValue: number;
  highValue: number;
  /** For a categorical variable, the option at each end. */
  lowLabel?: string;
  highLabel?: string;
  lowCents: number;
  highCents: number;
  swingCents: number;
  /** True when the adverse end turns the baseline contribution negative. */
  mustHold: boolean;
}

export interface BreakEven {
  variable: string;
  label: string;
  strategy: string;
  /** The value at which baseline contribution crosses zero, or null with the reason. */
  value: number | null;
  searched: { min: number; max: number };
  /** Contribution rises with this variable? */
  direction: 'RISES' | 'FALLS' | 'NONE';
  note: string;
}

export interface StressReading {
  variable: string;
  label: string;
  strategy: string;
  baselineCents: number;
  doubledCents: number;
  outsideTestedRange: boolean;
}

export interface InvestigationPriority {
  variable: string;
  label: string;
  provenance: VariableProvenance;
  /** The best strategy (by baseline contribution) flips across this variable's range. */
  decisionRelevant: boolean;
  bestAtLow: string;
  bestAtHigh: string;
  maxSwingCents: number;
  why: string;
}

export interface Sensitivity {
  baselineCents: Record<string, number>;
  tornado: Record<string, TornadoBar[]>;
  rankCorrelation: Record<string, Array<{ variable: string; label: string; rho: number }>>;
  breakEvens: BreakEven[];
  stress: StressReading[];
  investigate: InvestigationPriority[];
}

export interface ObjectiveRanking {
  objective: SelectedObjective;
  order: Array<{ strategy: string; value: number }>;
  excluded: Array<{ strategy: string; reason: string }>;
}

export interface ScenarioResult {
  simulated: true;
  engineVersion: string;
  configHash: string;
  seed: number;
  basis: RunBasis;
  /** True only when every sampled input carried a justified distribution. */
  probabilistic: boolean;
  basisNote: string;
  scenarios: number;
  evaluations: number;
  distinctScenarios: number;
  elapsedMs: number;
  currency: string;
  horizon: string;
  provenance: Record<VariableProvenance, number>;
  assumptions: Array<{ key: string; label: string; provenance: VariableProvenance; describe: string; sources: SourceRef[] }>;
  strategies: StrategyResult[];
  dominance: DominanceFinding[];
  tradeOffs: TradeOff[];
  dominanceCriteria: string[];
  ranking: ObjectiveRanking | null;
  sensitivity: Sensitivity;
  limitations: string[];
}
