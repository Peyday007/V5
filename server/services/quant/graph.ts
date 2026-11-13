/**
 * The causal graph of a business, a deal or a portfolio (CAUSAL-14-1..3).
 *
 * One graph per subject. Node and relation types are *data*: a small seed
 * vocabulary exists so a first graph is not empty, and a type outside it is
 * declared with a reason before use. No category is a whitelist — a type the
 * arrangement itself needs is added, never forced into an ill-fitting one.
 *
 * Everything here is pure. Nothing reads a clock, a table or the network, and
 * no scheduler, queue or store is created: callers keep a graph where they
 * already keep state. Randomness comes from the seeded generator the scenario
 * engine already owns, through the portfolio evaluator.
 *
 *   * Actions carry prerequisites, actor, permissions, effect, timing, external
 *     dependencies, evidence and an observable completion condition, or they
 *     are refused.
 *   * A money route states who pays, for what, on which terms, through which
 *     channel, when it is invoiced and collected, what is paid out and when,
 *     and what is genuinely free — collected money still owed to refunds or
 *     fulfilment is not free.
 *   * A figure carries its meaning and unit, source or derivation, status,
 *     window, geography, scope, bounds (only where the status supports them)
 *     and the dependencies that would invalidate it. A derived figure points at
 *     its inputs, and an unknown input makes it unknown.
 *   * Books are double-entry. A rollup somebody claims is compared with the sum
 *     of the entries; a difference is reported as a discrepancy and never
 *     plugged.
 *   * Volume passes every bottleneck of a dependency chain before it is called
 *     revenue, yield falls as volume saturates a stage, and streams that share
 *     a resource fail together rather than being summed at their best case.
 *   * A claim replaced by new information keeps its history.
 *   * Brain constructs the graph: `discoverMissing` names every variable the
 *     routes and actions imply but the graph does not model (declaring a type
 *     when the vocabulary has no word for the role), `expandToFixpoint` adds
 *     them, and `linkGraphs` joins several graphs into a portfolio in which a
 *     party or resource more than one member depends on is one shared node.
 */
import { evaluateCombination } from './portfolio.ts';

/* ------------------------------------------------------------------------- */
/* Open vocabulary                                                           */
/* ------------------------------------------------------------------------- */

/** Illustrative seeds. Not exhaustive, not a filter: see `declareType`. */
export const SEED_NODE_TYPES = [
  'actor', 'payer', 'beneficiary', 'asset', 'right', 'supplier', 'channel', 'offer', 'obligation', 'contract',
  'approval', 'capability', 'workflow_step', 'time_dependency', 'resource', 'price', 'fee', 'tax',
  'acquisition_event', 'capacity_limit', 'fulfillment_output', 'acceptance_condition', 'payment', 'refund',
  'debt', 'liability', 'recurring_relationship', 'failure_mode',
] as const;

export const SEED_RELATION_TYPES = [
  'causes', 'requires', 'pays', 'delivers', 'depends_on', 'constrains', 'shares_resource_with', 'authorizes', 'obliges',
] as const;

export interface TypeDeclaration {
  name: string;
  /** 'seed' for the starting vocabulary; otherwise why the existing vocabulary was insufficient. */
  reason: string;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface GraphRelation {
  id: string;
  type: string;
  from: string;
  to: string;
  label?: string;
}

/* ------------------------------------------------------------------------- */
/* Figures: every number has lineage                                         */
/* ------------------------------------------------------------------------- */

export const FIGURE_STATUSES = ['OBSERVED', 'CONTRACTED', 'EVIDENCED', 'MODELED', 'ASSUMED', 'UNKNOWN'] as const;
export type FigureStatus = (typeof FIGURE_STATUSES)[number];

/** Statuses that may carry uncertainty bounds: a bound on a guess is a counterfeit. */
const BOUNDABLE: ReadonlySet<FigureStatus> = new Set(['OBSERVED', 'EVIDENCED', 'MODELED']);

export interface Figure {
  /** (a) what the number means */
  meaning: string;
  unit: string;
  /** null only while the status is UNKNOWN */
  value: number | null;
  /** (b) where it came from: a source, or a derivation pointing at inputs */
  source: string | null;
  derivedFrom: Figure[];
  /** (c) */
  status: FigureStatus;
  /** (d) */
  window: string | null;
  geography: string | null;
  /** (e) counterparty, transaction or cohort */
  scope: string | null;
  /** (f) only where supported */
  bounds: { low: number; high: number } | null;
  /** (g) what would make it stale */
  invalidatedBy: string[];
}

export type FigureInput = Omit<Figure, 'derivedFrom' | 'bounds' | 'invalidatedBy' | 'source' | 'window' | 'geography' | 'scope'> &
  Partial<Pick<Figure, 'derivedFrom' | 'bounds' | 'invalidatedBy' | 'source' | 'window' | 'geography' | 'scope'>>;

export type FigureResult = { ok: true; figure: Figure } | { ok: false; reason: string };

/** Build a figure, refusing one that lacks the lineage its status implies. */
export function makeFigure(input: FigureInput): FigureResult {
  if (!input.meaning.trim() || !input.unit.trim()) return { ok: false, reason: 'A figure states what it means and its unit.' };
  if (!(FIGURE_STATUSES as readonly string[]).includes(input.status)) return { ok: false, reason: `Status must be one of ${FIGURE_STATUSES.join(', ')}.` };
  const derivedFrom = input.derivedFrom ?? [];
  const source = input.source?.trim() ? input.source.trim() : null;
  if (input.status === 'UNKNOWN') {
    if (input.value !== null) return { ok: false, reason: 'An unknown figure has no value.' };
  } else {
    if (input.value === null || !Number.isFinite(input.value)) return { ok: false, reason: 'A figure that is not unknown has a finite value.' };
    if (!source && derivedFrom.length === 0) return { ok: false, reason: 'A figure names its source or the inputs it was derived from.' };
  }
  if (input.bounds) {
    if (!BOUNDABLE.has(input.status)) return { ok: false, reason: `A ${input.status.toLowerCase()} figure cannot carry bounds; nothing supports them.` };
    if (!(input.bounds.low <= input.bounds.high)) return { ok: false, reason: 'Bounds run low to high.' };
    if (input.value !== null && (input.value < input.bounds.low || input.value > input.bounds.high)) return { ok: false, reason: 'The value lies outside its own bounds.' };
  }
  return {
    ok: true,
    figure: {
      meaning: input.meaning,
      unit: input.unit,
      value: input.value,
      source,
      derivedFrom,
      status: input.status,
      window: input.window ?? null,
      geography: input.geography ?? null,
      scope: input.scope ?? null,
      bounds: input.bounds ?? null,
      invalidatedBy: input.invalidatedBy ?? [],
    },
  };
}

/** A figure nobody has: shown as unknown, never as a favourable number. */
export function unknownFigure(meaning: string, unit: string, invalidatedBy: string[] = []): Figure {
  return { meaning, unit, value: null, source: null, derivedFrom: [], status: 'UNKNOWN', window: null, geography: null, scope: null, bounds: null, invalidatedBy };
}

/** Weakest first: a derivation is only as strong as its weakest input. */
const STRENGTH: Record<FigureStatus, number> = { UNKNOWN: 0, ASSUMED: 1, MODELED: 2, EVIDENCED: 3, CONTRACTED: 4, OBSERVED: 5 };

/**
 * Derive a figure from inputs. The result points at them, inherits their
 * invalidating dependencies, takes the weakest input's status (never stronger
 * than what it was computed from) and is unknown if any input is. Bounds are
 * carried only when every input has them, by evaluating at the corners.
 */
export function derive(meaning: string, unit: string, inputs: Figure[], compute: (values: number[]) => number): Figure {
  const invalidatedBy = [...new Set(inputs.flatMap((one) => one.invalidatedBy))];
  const gap = inputs.find((one) => one.status === 'UNKNOWN' || one.value === null);
  if (gap) return { ...unknownFigure(meaning, unit, invalidatedBy), derivedFrom: inputs };
  const status = inputs.reduce<FigureStatus>((weakest, one) => (STRENGTH[one.status] < STRENGTH[weakest] ? one.status : weakest), 'OBSERVED');
  // A computation over observed or contracted inputs is evidenced, not itself observed.
  const derivedStatus: FigureStatus = STRENGTH[status] > STRENGTH.EVIDENCED ? 'EVIDENCED' : status;
  const values = inputs.map((one) => one.value as number);
  let bounds: Figure['bounds'] = null;
  if (inputs.every((one) => one.bounds) && BOUNDABLE.has(derivedStatus) && inputs.length <= 12) {
    let low = Infinity;
    let high = -Infinity;
    for (let mask = 0; mask < 1 << inputs.length; mask++) {
      const corner = inputs.map((one, i) => (mask & (1 << i) ? (one.bounds as { high: number }).high : (one.bounds as { low: number }).low));
      const out = compute(corner);
      low = Math.min(low, out);
      high = Math.max(high, out);
    }
    bounds = Number.isFinite(low) && Number.isFinite(high) ? { low, high } : null;
  }
  return {
    meaning, unit, value: compute(values), source: null, derivedFrom: inputs, status: derivedStatus,
    window: sameOrNull(inputs.map((one) => one.window)), geography: sameOrNull(inputs.map((one) => one.geography)),
    scope: sameOrNull(inputs.map((one) => one.scope)), bounds, invalidatedBy,
  };
}

function sameOrNull(values: (string | null)[]): string | null {
  const first = values[0] ?? null;
  return values.every((one) => one === first) ? first : null;
}

/**
 * The lowest value an unknown input must take for a result to reach a target,
 * found by bisection over [0, ceiling]. Null when even the ceiling cannot get
 * there. Assumes the result rises with the input.
 */
export function thresholdFor(target: number, ceiling: number, evaluate: (x: number) => number): number | null {
  if (!(ceiling > 0) || evaluate(ceiling) < target) return null;
  let low = 0;
  let high = ceiling;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (evaluate(mid) >= target) high = mid;
    else low = mid;
  }
  return high;
}

/* ------------------------------------------------------------------------- */
/* Operational actions                                                       */
/* ------------------------------------------------------------------------- */

export interface OperationalAction {
  id: string;
  label: string;
  /** Action ids that must be complete first. */
  prerequisites: string[];
  actor: string;
  permissions: string[];
  effect: string;
  /** When, or how long. Free text a person can read: "within 2 business days of payment". */
  timing: string;
  externalDependencies: string[];
  evidence: string[];
  completionCondition: string;
}

const ACTION_TEXT = ['label', 'actor', 'effect', 'timing', 'completionCondition'] as const;

/* ------------------------------------------------------------------------- */
/* The route to the money                                                    */
/* ------------------------------------------------------------------------- */

export interface Outflow {
  to: string;
  reason: string;
  amountCents: number;
  /** ISO date the money leaves. */
  at: string | null;
}

export interface MoneyRoute {
  id: string;
  payer: string;
  for: string;
  terms: string;
  channel: string;
  /** ISO dates; null while not yet known. */
  invoicedAt: string | null;
  collectedAt: string | null;
  collectedCents: Figure;
  outflows: Outflow[];
  /** Collected money still exposed to refund or fulfilment obligations. */
  heldAgainstCents: Figure;
}

export interface MoneyRouteReading {
  route: string;
  collectedCents: number | null;
  outflowCents: number;
  heldAgainstCents: number | null;
  /**
   * What is genuinely free to use; null when the collection or the hold is
   * unknown. Signed: a route whose hold and outflows exceed what it collects is
   * under water, and its free amount is negative rather than plugged to zero.
   */
  freeCents: Figure;
  /** How far the hold and outflows exceed the collection; 0 when they do not, null when unknown. */
  shortfallCents: number | null;
  /** Parts of the route nobody has stated. */
  gaps: string[];
  /** Figures that do not reconcile, stated rather than silently plugged. */
  discrepancies: string[];
  /**
   * The route as double-entry accounting events (billing, collection, the hold
   * against refund or fulfilment, each outflow) and their reconciliation, so the
   * free amount is reproducible from entries rather than asserted.
   */
  ledger: { entries: Entry[]; reconciliation: Reconciliation };
  /**
   * When exactly one of the collection or the hold is unknown: the value it must
   * take for the route not to be under water. The unknown stays unknown; this is
   * the threshold the plan needs, never a filled-in number.
   */
  breakEven: BreakEven | null;
}

export interface BreakEven {
  /** Which unknown the threshold is for. */
  unknown: 'collectedCents' | 'heldAgainstCents';
  /** 'at least' for a collection, 'at most' for a hold. */
  bound: 'AT_LEAST' | 'AT_MOST';
  /** Null when no value of the unknown can keep the route above water. */
  cents: number | null;
  statement: string;
}

/** Accounts of a route's ledger. Free to use is cash less what is still owed against it. */
const ACCOUNT = { cash: 'cash', revenue: 'gross billings', obligation: 'held against refund or fulfilment' } as const;

function routeEntries(route: MoneyRoute): Entry[] {
  const entries: Entry[] = [];
  const receivable = `receivable: ${route.payer || 'payer'}`;
  const collected = route.collectedCents.value;
  if (collected !== null) {
    entries.push({ id: `${route.id}:billed`, debit: receivable, credit: ACCOUNT.revenue, amountCents: Math.round(collected), evidence: route.collectedCents.source ?? 'derived collection' });
    entries.push({ id: `${route.id}:collected`, debit: ACCOUNT.cash, credit: receivable, amountCents: Math.round(collected), evidence: route.collectedCents.source ?? 'derived collection' });
  }
  const held = route.heldAgainstCents.value;
  if (held !== null) entries.push({ id: `${route.id}:held`, debit: ACCOUNT.revenue, credit: ACCOUNT.obligation, amountCents: Math.round(held), evidence: route.heldAgainstCents.source ?? 'derived hold' });
  route.outflows.forEach((one, i) => {
    entries.push({ id: `${route.id}:out:${i}`, debit: `paid to: ${one.to}`, credit: ACCOUNT.cash, amountCents: Number.isFinite(one.amountCents) ? Math.round(one.amountCents) : one.amountCents, evidence: one.reason });
  });
  return entries;
}

function breakEvenOf(route: MoneyRoute, outflowCents: number): BreakEven | null {
  const collected = route.collectedCents.value;
  const held = route.heldAgainstCents.value;
  if (collected === null && held !== null) {
    const owed = held + outflowCents;
    const found = owed <= 0 ? 0 : thresholdFor(0, owed * 2, (x) => x - owed);
    const cents = found === null ? null : Math.ceil(found - 1e-6);
    return {
      unknown: 'collectedCents', bound: 'AT_LEAST', cents,
      statement: cents === null ? 'no collection keeps this route above water' : `the route needs at least ${cents} cents collected to cover the hold and outflows`,
    };
  }
  if (held === null && collected !== null) {
    // x is how much of the collection is NOT held; free cash rises with it.
    const found = collected <= 0 ? null : thresholdFor(0, collected, (x) => collected - (collected - x) - outflowCents);
    const cents = found === null ? null : Math.max(0, Math.floor(collected - found + 1e-6));
    return {
      unknown: 'heldAgainstCents', bound: 'AT_MOST', cents,
      statement: cents === null
        ? `outflows of ${outflowCents} cents exceed the ${collected} cents collected even with nothing held`
        : `the route stays above water if at most ${cents} cents of the collection is held against refund or fulfilment`,
    };
  }
  return null;
}

export function readMoneyRoute(route: MoneyRoute): MoneyRouteReading {
  const gaps: string[] = [];
  for (const key of ['payer', 'for', 'terms', 'channel'] as const) if (!route[key].trim()) gaps.push(key);
  if (!route.invoicedAt) gaps.push('invoice date');
  if (!route.collectedAt) gaps.push('collection date');
  for (const one of route.outflows) if (!one.at) gaps.push(`when ${one.to} is paid`);
  const outflowCents = route.outflows.reduce((sum, one) => sum + one.amountCents, 0);
  const outflow = { ...unknownFigure('', 'cents'), meaning: 'outflows', unit: 'cents', status: 'CONTRACTED' as FigureStatus, value: outflowCents, source: 'route outflows' };
  const free = derive('free to use', 'cents', [route.collectedCents, route.heldAgainstCents, outflow], ([collected, held, out]) => (collected ?? 0) - (held ?? 0) - (out ?? 0));
  if (route.collectedCents.value === null) gaps.push('collected amount');
  if (route.heldAgainstCents.value === null) gaps.push('amount held against refund or fulfilment');
  const shortfallCents = free.value === null ? null : Math.max(0, -free.value);
  const discrepancies: string[] = [];
  if (shortfallCents !== null && shortfallCents > 0) {
    discrepancies.push(
      `hold and outflows (${(route.heldAgainstCents.value ?? 0) + outflowCents} cents) exceed the ${route.collectedCents.value} cents collected by ${shortfallCents} cents`,
    );
  }
  const entries = routeEntries(route);
  const reconciliation = reconcile(entries);
  if (!reconciliation.balanced) discrepancies.push('the route\'s accounting entries do not balance: an amount is negative or not a number');
  if (free.value !== null) {
    const fromEntries = (reconciliation.balances[ACCOUNT.cash] ?? 0) + (reconciliation.balances[ACCOUNT.obligation] ?? 0);
    if (Number.isFinite(fromEntries) && Math.abs(fromEntries - free.value) >= 1) discrepancies.push(`free to use is ${free.value} cents but the entries give ${fromEntries} cents`);
  }
  return {
    route: route.id, collectedCents: route.collectedCents.value, outflowCents, heldAgainstCents: route.heldAgainstCents.value,
    freeCents: free, shortfallCents, gaps, discrepancies,
    ledger: { entries, reconciliation },
    breakEven: breakEvenOf(route, outflowCents),
  };
}

/* ------------------------------------------------------------------------- */
/* Double-entry                                                              */
/* ------------------------------------------------------------------------- */

export interface Entry {
  id: string;
  debit: string;
  credit: string;
  amountCents: number;
  /** What evidence or accounting event this entry records. */
  evidence: string;
}

export interface Discrepancy {
  account: string;
  claimedCents: number;
  entriesCents: number;
  differenceCents: number;
}

export interface Reconciliation {
  /** Net balance per account: debits less credits. */
  balances: Record<string, number>;
  /** Debits equal credits by construction; this is the check that nobody added a one-sided row. */
  balanced: boolean;
  discrepancies: Discrepancy[];
  /** Claimed accounts with no entries at all. */
  unsupported: string[];
}

/**
 * Reproduce every account from its entries and compare with what was claimed.
 * A claim that differs is reported with the difference. Nothing is adjusted.
 */
export function reconcile(entries: readonly Entry[], claimed: Record<string, number> = {}): Reconciliation {
  const balances: Record<string, number> = {};
  let debits = 0;
  let credits = 0;
  for (const one of entries) {
    if (!Number.isFinite(one.amountCents) || one.amountCents < 0 || one.debit === one.credit) continue;
    balances[one.debit] = (balances[one.debit] ?? 0) + one.amountCents;
    balances[one.credit] = (balances[one.credit] ?? 0) - one.amountCents;
    debits += one.amountCents;
    credits += one.amountCents;
  }
  const discrepancies: Discrepancy[] = [];
  const unsupported: string[] = [];
  for (const [account, claimedCents] of Object.entries(claimed)) {
    if (!(account in balances)) {
      unsupported.push(account);
      continue;
    }
    const entriesCents = balances[account] as number;
    if (entriesCents !== claimedCents) discrepancies.push({ account, claimedCents, entriesCents, differenceCents: claimedCents - entriesCents });
  }
  const malformed = entries.some((one) => !Number.isFinite(one.amountCents) || one.amountCents < 0 || one.debit === one.credit);
  return { balances, balanced: debits === credits && !malformed, discrepancies, unsupported };
}

/* ------------------------------------------------------------------------- */
/* Dependency chain: volume through every bottleneck                         */
/* ------------------------------------------------------------------------- */

export interface ChainStage {
  name: string;
  /** Share of incoming volume that passes at low volume. Unknown stays unknown. */
  yield: Figure;
  /** Most units this stage can handle in the period. Absent means no stated limit, not unlimited. */
  capacity?: Figure;
  /**
   * Incoming volume at which the yield has halved. Absent when saturation is
   * not material for this stage; the reading says so rather than assuming it.
   */
  saturationHalfAt?: number;
}

export interface StageReading {
  name: string;
  incoming: number | null;
  passed: number | null;
  effectiveYield: number | null;
  capped: boolean;
  saturated: boolean;
  unknown: string | null;
}

export interface ChainReading {
  stages: StageReading[];
  /** Volume that came out of the last stage; null if any stage is unknown. */
  outputUnits: number | null;
  /** The stage that most limits output: a cap that bound, else the lowest effective yield. */
  bindingConstraint: string | null;
  firstUnknown: string | null;
}

/** Pass volume through every stage in order. Revenue is read only from `outputUnits`. */
export function passVolume(startUnits: number, stages: readonly ChainStage[]): ChainReading {
  const readings: StageReading[] = [];
  let volume: number | null = startUnits;
  let firstUnknown: string | null = null;
  for (const stage of stages) {
    const yieldValue = stage.yield.value;
    if (volume === null || yieldValue === null || (stage.capacity && stage.capacity.status !== 'UNKNOWN' && stage.capacity.value === null)) {
      firstUnknown ??= stage.name;
      readings.push({ name: stage.name, incoming: volume, passed: null, effectiveYield: null, capped: false, saturated: false, unknown: `${stage.name} has an unknown input` });
      volume = null;
      continue;
    }
    if (stage.capacity && stage.capacity.status === 'UNKNOWN') {
      firstUnknown ??= stage.name;
      readings.push({ name: stage.name, incoming: volume, passed: null, effectiveYield: null, capped: false, saturated: false, unknown: `${stage.name} capacity is unknown` });
      volume = null;
      continue;
    }
    const saturated = stage.saturationHalfAt !== undefined && stage.saturationHalfAt > 0;
    const effectiveYield = saturated ? yieldValue / (1 + volume / (stage.saturationHalfAt as number)) : yieldValue;
    const raw = volume * effectiveYield;
    const limit = stage.capacity?.value ?? Infinity;
    const passed = Math.min(raw, limit);
    readings.push({ name: stage.name, incoming: volume, passed, effectiveYield, capped: raw > limit, saturated, unknown: null });
    volume = passed;
  }
  const known = readings.filter((one) => one.passed !== null);
  const capped = known.find((one) => one.capped);
  const lowest = known.reduce<StageReading | null>((best, one) => (best === null || (one.effectiveYield ?? 1) < (best.effectiveYield ?? 1) ? one : best), null);
  return { stages: readings, outputUnits: volume, bindingConstraint: (capped ?? lowest)?.name ?? null, firstUnknown };
}

export interface Stream {
  id: string;
  /** Revenue if nothing fails, in cents. */
  bestCaseCents: number;
  /** Resource ids this stream cannot run without. */
  resources: string[];
}

export interface PortfolioReading {
  /** What summing the independent best cases would claim. Reported only to show the gap. */
  naiveSumCents: number;
  expectedCents: number;
  /** Probability that every stream's resources are up. */
  allUpProbability: number;
  /** Probability of losing at least half the naive total. */
  halfLossProbability: number;
  trials: number;
  /** Resources more than one stream depends on. */
  shared: string[];
}

/**
 * Evaluate streams that share resources. Each resource has a failure
 * probability for the period; a stream earns nothing when any resource it
 * needs has failed. Seeded, so the same inputs give the same answer. A resource
 * with no stated failure probability is refused rather than assumed reliable.
 *
 * This is a view, not a second evaluator: each stream becomes an activity
 * that `needs` its resources and the combination is evaluated by
 * `evaluateCombination` in `quant/portfolio.ts`, over the same world drawing
 * the portfolio optimizer uses — so shared-resource and correlated failure
 * (CAUSAL-14-3) have one owner and cannot drift.
 */
export function evaluatePortfolio(
  streams: readonly Stream[],
  failureProbability: Record<string, number>,
  seed: number,
  trials = 4000,
): PortfolioReading | { missing: string[] } {
  const naiveSumCents = streams.reduce((sum, one) => sum + one.bestCaseCents, 0);
  const reading = evaluateCombination(
    {
      activities: streams.map((one) => ({
        key: one.id,
        label: one.id,
        cash: [one.bestCaseCents],
        days: [0],
        justified: true,
        needs: [...new Set(one.resources)],
      })),
      target: naiveSumCents,
      deadlineDays: 0,
      resourceFailure: failureProbability,
      worlds: trials,
      seed,
    },
    naiveSumCents / 2,
  );
  if ('missing' in reading) return reading;
  const uses = new Map<string, number>();
  for (const one of streams) for (const id of new Set(one.resources)) uses.set(id, (uses.get(id) ?? 0) + 1);
  return {
    naiveSumCents,
    expectedCents: Math.round(reading.settledMean),
    allUpProbability: reading.allNeedsUp,
    halfLossProbability: reading.shareAtOrBelow ?? 0,
    trials: reading.worlds,
    shared: [...uses].filter(([, n]) => n > 1).map(([id]) => id).sort(),
  };
}

/* ------------------------------------------------------------------------- */
/* The graph                                                                 */
/* ------------------------------------------------------------------------- */

export interface ClaimVersion {
  version: number;
  figure: Figure;
  /** Why it replaced the previous one; empty for the first. */
  reason: string;
}

export interface CausalGraph {
  subject: string;
  nodeTypes: Map<string, TypeDeclaration>;
  relationTypes: Map<string, TypeDeclaration>;
  nodes: Map<string, GraphNode>;
  relations: Map<string, GraphRelation>;
  actions: Map<string, OperationalAction>;
  routes: Map<string, MoneyRoute>;
  claims: Map<string, ClaimVersion[]>;
}

export type GraphResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | { ok: false; reason: string };

export function createGraph(subject: string): CausalGraph {
  return {
    subject,
    nodeTypes: new Map(SEED_NODE_TYPES.map((name) => [name, { name, reason: 'seed' }])),
    relationTypes: new Map(SEED_RELATION_TYPES.map((name) => [name, { name, reason: 'seed' }])),
    nodes: new Map(),
    relations: new Map(),
    actions: new Map(),
    routes: new Map(),
    claims: new Map(),
  };
}

/** Add a node or relation type the seed vocabulary lacks. A reason is required. */
export function declareType(graph: CausalGraph, kind: 'node' | 'relation', name: string, reason: string): GraphResult {
  const key = name.trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(key)) return { ok: false, reason: 'A type name is lowercase words.' };
  if (!reason.trim()) return { ok: false, reason: 'Say why the existing vocabulary is insufficient.' };
  const table = kind === 'node' ? graph.nodeTypes : graph.relationTypes;
  if (!table.has(key)) table.set(key, { name: key, reason: reason.trim() });
  return { ok: true };
}

export function addNode(graph: CausalGraph, node: Omit<GraphNode, 'attributes'> & { attributes?: GraphNode['attributes'] }): GraphResult {
  if (graph.nodes.has(node.id)) return { ok: false, reason: `Node ${node.id} already exists.` };
  if (!graph.nodeTypes.has(node.type)) return { ok: false, reason: `Node type ${node.type} is not declared; declare it with a reason first.` };
  graph.nodes.set(node.id, { ...node, attributes: node.attributes ?? {} });
  return { ok: true };
}

export function addRelation(graph: CausalGraph, relation: GraphRelation): GraphResult {
  if (graph.relations.has(relation.id)) return { ok: false, reason: `Relation ${relation.id} already exists.` };
  if (!graph.relationTypes.has(relation.type)) return { ok: false, reason: `Relation type ${relation.type} is not declared; declare it with a reason first.` };
  for (const end of [relation.from, relation.to]) if (!graph.nodes.has(end)) return { ok: false, reason: `Node ${end} does not exist.` };
  graph.relations.set(relation.id, relation);
  return { ok: true };
}

export function addAction(graph: CausalGraph, action: OperationalAction): GraphResult {
  if (graph.actions.has(action.id)) return { ok: false, reason: `Action ${action.id} already exists.` };
  for (const key of ACTION_TEXT) if (!action[key].trim()) return { ok: false, reason: `An action states its ${key}.` };
  if (action.permissions.length === 0) return { ok: false, reason: 'An action names the permissions it needs, or states that none are.' };
  if (action.evidence.length === 0) return { ok: false, reason: 'An action cites its evidence.' };
  for (const one of action.prerequisites) if (!graph.actions.has(one)) return { ok: false, reason: `Prerequisite ${one} is not an action in this graph.` };
  graph.actions.set(action.id, action);
  return { ok: true };
}

/** Actions whose prerequisites are all in `complete` and which are not themselves complete. */
export function readyActions(graph: CausalGraph, complete: ReadonlySet<string>): OperationalAction[] {
  return [...graph.actions.values()].filter((one) => !complete.has(one.id) && one.prerequisites.every((p) => complete.has(p)));
}

export function addMoneyRoute(graph: CausalGraph, route: MoneyRoute): GraphResult {
  if (graph.routes.has(route.id)) return { ok: false, reason: `Route ${route.id} already exists.` };
  graph.routes.set(route.id, route);
  return { ok: true };
}

/** Record a claim. A replacement keeps every earlier version with the reason it was replaced. */
export function recordClaim(graph: CausalGraph, key: string, figure: Figure, reason = ''): ClaimVersion {
  const history = graph.claims.get(key) ?? [];
  if (history.length > 0 && !reason.trim()) reason = 'replaced without a stated reason';
  const next: ClaimVersion = { version: history.length + 1, figure, reason: history.length === 0 ? '' : reason };
  graph.claims.set(key, [...history, next]);
  return next;
}

export function currentClaim(graph: CausalGraph, key: string): Figure | null {
  const history = graph.claims.get(key);
  return history && history.length > 0 ? (history[history.length - 1] as ClaimVersion).figure : null;
}

export function claimHistory(graph: CausalGraph, key: string): ClaimVersion[] {
  return [...(graph.claims.get(key) ?? [])];
}

export interface Trace {
  from: string;
  direction: 'forward' | 'backward';
  /** Nodes reached, nearest first, each with the relation that led to it. */
  reached: { node: GraphNode; via: GraphRelation; depth: number }[];
}

/** Follow relations away from a node (effects) or toward it (causes). */
export function trace(graph: CausalGraph, from: string, direction: 'forward' | 'backward', maxDepth = Infinity): Trace | null {
  if (!graph.nodes.has(from)) return null;
  const seen = new Set([from]);
  const reached: Trace['reached'] = [];
  let frontier = [from];
  for (let depth = 1; frontier.length > 0 && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const rel of graph.relations.values()) {
        const [here, there] = direction === 'forward' ? [rel.from, rel.to] : [rel.to, rel.from];
        if (here !== id || seen.has(there)) continue;
        seen.add(there);
        reached.push({ node: graph.nodes.get(there) as GraphNode, via: rel, depth });
        next.push(there);
      }
    }
    frontier = next;
  }
  return { from, direction, reached };
}

/** The whole graph, unsummarised, for an owner who asks for the complete account. */
export function fullAccount(graph: CausalGraph): {
  subject: string;
  nodeTypes: TypeDeclaration[];
  relationTypes: TypeDeclaration[];
  nodes: GraphNode[];
  relations: GraphRelation[];
  actions: OperationalAction[];
  routes: MoneyRouteReading[];
  claims: Record<string, ClaimVersion[]>;
} {
  return {
    subject: graph.subject,
    nodeTypes: [...graph.nodeTypes.values()],
    relationTypes: [...graph.relationTypes.values()],
    nodes: [...graph.nodes.values()],
    relations: [...graph.relations.values()],
    actions: [...graph.actions.values()],
    routes: [...graph.routes.values()].map(readMoneyRoute),
    claims: Object.fromEntries(graph.claims),
  };
}

/* ------------------------------------------------------------------------- */
/* Construction: Brain builds the graph and discovers what it lacks           */
/* ------------------------------------------------------------------------- */

/**
 * A variable the graph implies but does not model. Every one names what in the
 * graph implied it, so an expansion is auditable rather than invented: a money
 * route names a payer, an offer, a channel and the people it pays out to; an
 * action names an actor, the approvals it needs and the outside parties it waits
 * on. When none of those is a node, the graph is missing a variable, and when the
 * vocabulary has no type for the role, the type is missing too.
 */
export interface Discovery {
  kind: 'type' | 'node' | 'relation';
  /** What in the graph implied this variable. */
  because: string;
  type?: { kind: 'node' | 'relation'; name: string; reason: string };
  node?: GraphNode;
  relation?: GraphRelation;
}

/**
 * Types Brain declares on its own when the seed vocabulary has no word for a role
 * the graph already implies. Each reason is the vocabulary's own insufficiency.
 */
const DISCOVERED_TYPES: Record<string, { kind: 'node' | 'relation'; reason: string }> = {
  payee: { kind: 'node', reason: 'A route pays money out to a party that is neither payer, supplier nor beneficiary of the offer; no seed type names the recipient of an outflow.' },
  external_dependency: { kind: 'node', reason: 'An action waits on an outside party or system the arrangement does not control; no seed type names a dependency outside the graph.' },
  shared_dependency: { kind: 'node', reason: 'More than one business in a portfolio depends on the same party or resource; no seed type names a node that belongs to the portfolio rather than one member.' },
};

const normal = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');
const slug = (value: string): string => normal(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';

/**
 * Everything the graph implies but does not yet hold, in the order it would be
 * added. Pure: the graph is not changed. Applying the result with `expandGraph`
 * and asking again returns nothing new, so discovery reaches a fixpoint.
 */
export function discoverMissing(graph: CausalGraph): Discovery[] {
  const found: Discovery[] = [];
  const types = { node: new Set(graph.nodeTypes.keys()), relation: new Set(graph.relationTypes.keys()) };
  const byId = new Map(graph.nodes);
  const byLabel = new Map<string, string>();
  for (const node of graph.nodes.values()) if (!byLabel.has(normal(node.label))) byLabel.set(normal(node.label), node.id);
  const relationKeys = new Set([...graph.relations.values()].map((rel) => `${rel.type}|${rel.from}|${rel.to}`));
  const relationIds = new Set(graph.relations.keys());

  const needType = (kind: 'node' | 'relation', name: string, because: string): void => {
    if (types[kind].has(name)) return;
    const known = DISCOVERED_TYPES[name];
    types[kind].add(name);
    found.push({ kind: 'type', because, type: { kind, name, reason: known?.reason ?? `Implied by ${because}.` } });
  };

  /** The node a reference names: an existing node by id or label, or a new one. */
  const nodeFor = (reference: string, type: string, because: string, attributes: GraphNode['attributes'] = {}): string | null => {
    const label = reference.trim();
    if (!label) return null;
    if (byId.has(label)) return label;
    const existing = byLabel.get(normal(label));
    if (existing) return existing;
    needType('node', type, because);
    let id = `${type}:${slug(label)}`;
    for (let n = 2; byId.has(id); n++) id = `${type}:${slug(label)}-${n}`;
    const node: GraphNode = { id, type, label, attributes: { ...attributes, discovered: true, discoveredBecause: because } };
    byId.set(id, node);
    byLabel.set(normal(label), id);
    found.push({ kind: 'node', because, node });
    return id;
  };

  const relate = (type: string, from: string | null, to: string | null, because: string): void => {
    if (!from || !to || from === to) return;
    const key = `${type}|${from}|${to}`;
    if (relationKeys.has(key)) return;
    needType('relation', type, because);
    let id = `${type}:${from}->${to}`;
    for (let n = 2; relationIds.has(id); n++) id = `${type}:${from}->${to}#${n}`;
    relationKeys.add(key);
    relationIds.add(id);
    found.push({ kind: 'relation', because, relation: { id, type, from, to } });
  };

  for (const route of graph.routes.values()) {
    const because = `money route ${route.id}`;
    const payer = nodeFor(route.payer, 'payer', `${because} names its payer`);
    const offer = nodeFor(route.for, 'offer', `${because} says what is paid for`);
    const channel = nodeFor(route.channel, 'channel', `${because} names the channel the money moves through`);
    relate('pays', payer, offer, `${because}: the payer pays for the offer`);
    relate('depends_on', offer, channel, `${because}: collection depends on the channel`);
    for (const outflow of route.outflows) {
      const payee = nodeFor(outflow.to, 'payee', `${because} pays out to ${outflow.to.trim() || 'an unnamed party'}`, { reason: outflow.reason });
      relate('obliges', offer, payee, `${because}: each sale obliges the outflow "${outflow.reason}"`);
    }
    const held = route.heldAgainstCents;
    if (held.status === 'UNKNOWN' || (held.value ?? 0) > 0) {
      const hold = nodeFor(`refund or fulfilment hold on ${route.id}`, 'obligation', `${because} holds collected money against refund or fulfilment`, { route: route.id });
      relate('obliges', offer, hold, `${because}: collected money is not free while the hold stands`);
    }
  }

  for (const action of graph.actions.values()) {
    const because = `action ${action.id}`;
    const step = nodeFor(`action:${action.id}`, 'workflow_step', `${because} is a step of the operation`, { action: action.id, label: action.label });
    const actor = nodeFor(action.actor, 'actor', `${because} names its responsible actor`);
    relate('causes', actor, step, `${because}: the actor performs the step`);
    for (const prerequisite of action.prerequisites) {
      const before = nodeFor(`action:${prerequisite}`, 'workflow_step', `action ${prerequisite} is a prerequisite of ${action.id}`, { action: prerequisite });
      relate('requires', step, before, `${because} requires ${prerequisite} first`);
    }
    for (const permission of action.permissions) {
      if (normal(permission) === 'none') continue;
      const approval = nodeFor(permission, 'approval', `${because} needs the permission "${permission}"`);
      relate('requires', step, approval, `${because} cannot run without "${permission}"`);
    }
    for (const dependency of action.externalDependencies) {
      const outside = nodeFor(dependency, 'external_dependency', `${because} waits on "${dependency}"`);
      relate('depends_on', step, outside, `${because} depends on "${dependency}"`);
    }
  }

  return found;
}

/** Apply discoveries through the model's own constructors. Returns how many were applied. */
export function expandGraph(graph: CausalGraph, discoveries: readonly Discovery[]): GraphResult<number> {
  let applied = 0;
  for (const one of discoveries) {
    let result: GraphResult = { ok: true };
    if (one.kind === 'type' && one.type) result = declareType(graph, one.type.kind, one.type.name, one.type.reason);
    else if (one.kind === 'node' && one.node) result = graph.nodes.has(one.node.id) ? { ok: true } : addNode(graph, one.node);
    else if (one.kind === 'relation' && one.relation) result = graph.relations.has(one.relation.id) ? { ok: true } : addRelation(graph, one.relation);
    if (!result.ok) return { ok: false, reason: `${one.because}: ${result.reason}` };
    applied += 1;
  }
  return { ok: true, value: applied };
}

/**
 * Discover and expand until nothing new is implied. The graph is changed in
 * place and every discovery is returned, in order, so the owner can see what
 * Brain added and why.
 */
export function expandToFixpoint(graph: CausalGraph, maxPasses = 8): GraphResult<Discovery[]> {
  const all: Discovery[] = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = discoverMissing(graph);
    if (next.length === 0) return { ok: true, value: all };
    const applied = expandGraph(graph, next);
    if (!applied.ok) return applied;
    all.push(...next);
  }
  return discoverMissing(graph).length === 0 ? { ok: true, value: all } : { ok: false, reason: `Discovery did not settle in ${maxPasses} passes.` };
}

/* ------------------------------------------------------------------------- */
/* Portfolios: graphs that depend on each other                               */
/* ------------------------------------------------------------------------- */

export interface CrossLink {
  from: { graph: string; node: string };
  to: { graph: string; node: string };
  type: string;
  label?: string;
}

export interface SharedDependency {
  /** The portfolio-level node standing for the one party or resource. */
  node: string;
  type: string;
  label: string;
  /** The member nodes that are the same party or resource, as `member::node`. */
  members: string[];
}

export interface PortfolioGraph {
  graph: CausalGraph;
  members: string[];
  shared: SharedDependency[];
  links: GraphRelation[];
}

/** The id a member's node has inside a portfolio. */
export const memberNodeId = (member: string, node: string): string => `${member}::${node}`;

/**
 * One graph over several businesses, deals or portfolios. Each member keeps its
 * own nodes, relations, actions, routes and claims under its subject, so nothing
 * is hand-copied and nothing collides. Two kinds of cross-graph dependency are
 * then made explicit:
 *
 *   * discovered — the same party or resource (same type, same name) appearing in
 *     more than one member becomes one portfolio node that constrains each of
 *     them, so a supplier two businesses share fails both of them in a trace;
 *   * stated — a link the caller names between nodes of two members.
 *
 * Tracing forward from a shared node reaches every member it can stop.
 */
export function linkGraphs(subject: string, members: readonly CausalGraph[], links: readonly CrossLink[] = []): GraphResult<PortfolioGraph> {
  const subjects = members.map((one) => one.subject);
  const duplicate = subjects.find((one, index) => subjects.indexOf(one) !== index);
  if (duplicate !== undefined) return { ok: false, reason: `Two members share the subject ${duplicate}; a portfolio names each member once.` };
  const portfolio = createGraph(subject);
  for (const member of members) {
    for (const [name, declared] of member.nodeTypes) if (!portfolio.nodeTypes.has(name)) portfolio.nodeTypes.set(name, declared);
    for (const [name, declared] of member.relationTypes) if (!portfolio.relationTypes.has(name)) portfolio.relationTypes.set(name, declared);
  }
  for (const member of members) {
    const m = member.subject;
    for (const node of member.nodes.values()) portfolio.nodes.set(memberNodeId(m, node.id), { ...node, id: memberNodeId(m, node.id), attributes: { ...node.attributes, member: m } });
    for (const rel of member.relations.values()) {
      portfolio.relations.set(memberNodeId(m, rel.id), { ...rel, id: memberNodeId(m, rel.id), from: memberNodeId(m, rel.from), to: memberNodeId(m, rel.to) });
    }
    for (const action of member.actions.values()) {
      portfolio.actions.set(memberNodeId(m, action.id), { ...action, id: memberNodeId(m, action.id), prerequisites: action.prerequisites.map((p) => memberNodeId(m, p)) });
    }
    for (const route of member.routes.values()) portfolio.routes.set(memberNodeId(m, route.id), { ...route, id: memberNodeId(m, route.id) });
    for (const [key, history] of member.claims) portfolio.claims.set(memberNodeId(m, key), history);
  }

  // Discovered: one party or resource that more than one member depends on.
  const groups = new Map<string, { type: string; label: string; nodes: string[]; owners: Set<string> }>();
  for (const member of members) {
    for (const node of member.nodes.values()) {
      if (node.type === 'workflow_step' || node.type === 'offer' || node.type === 'obligation') continue; // a member's own steps, offers and holds are its own
      const key = `${node.type}|${normal(node.label)}`;
      const group = groups.get(key) ?? { type: node.type, label: node.label, nodes: [], owners: new Set<string>() };
      group.nodes.push(memberNodeId(member.subject, node.id));
      group.owners.add(member.subject);
      groups.set(key, group);
    }
  }
  const shared: SharedDependency[] = [];
  for (const group of groups.values()) {
    if (group.owners.size < 2) continue;
    if (!portfolio.nodeTypes.has('shared_dependency')) {
      const declared = DISCOVERED_TYPES.shared_dependency as { reason: string };
      portfolio.nodeTypes.set('shared_dependency', { name: 'shared_dependency', reason: declared.reason });
    }
    const id = `portfolio::${group.type}:${slug(group.label)}`;
    portfolio.nodes.set(id, {
      id,
      type: 'shared_dependency',
      label: group.label,
      attributes: { sharedType: group.type, members: [...group.owners].sort().join(', '), discovered: true, discoveredBecause: `${group.owners.size} members depend on ${group.label}` },
    });
    for (const memberNode of group.nodes) {
      const relId = `constrains:${id}->${memberNode}`;
      portfolio.relations.set(relId, { id: relId, type: 'constrains', from: id, to: memberNode, label: 'the same party or resource' });
    }
    shared.push({ node: id, type: group.type, label: group.label, members: group.nodes });
  }

  // Stated: links the caller names between members.
  const stated: GraphRelation[] = [];
  const known = new Set(subjects);
  for (const [index, link] of links.entries()) {
    for (const end of [link.from, link.to]) {
      if (!known.has(end.graph)) return { ok: false, reason: `links[${index}] names ${end.graph}, which is not a member of this portfolio.` };
      if (!portfolio.nodes.has(memberNodeId(end.graph, end.node))) return { ok: false, reason: `links[${index}]: node ${end.node} is not in ${end.graph}.` };
    }
    const relation: GraphRelation = {
      id: `link:${index + 1}`,
      type: link.type,
      from: memberNodeId(link.from.graph, link.from.node),
      to: memberNodeId(link.to.graph, link.to.node),
      ...(link.label ? { label: link.label } : {}),
    };
    const added = addRelation(portfolio, relation);
    if (!added.ok) return { ok: false, reason: `links[${index}]: ${added.reason}` };
    stated.push(relation);
  }

  return { ok: true, value: { graph: portfolio, members: subjects, shared, links: stated } };
}
