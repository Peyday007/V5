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
 * engine already owns.
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
 */
import { makeRng } from '../scenario/random.ts';

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
  /** What is genuinely free to use; null when the collection or the hold is unknown. */
  freeCents: Figure;
  /** Parts of the route nobody has stated. */
  gaps: string[];
}

export function readMoneyRoute(route: MoneyRoute): MoneyRouteReading {
  const gaps: string[] = [];
  for (const key of ['payer', 'for', 'terms', 'channel'] as const) if (!route[key].trim()) gaps.push(key);
  if (!route.invoicedAt) gaps.push('invoice date');
  if (!route.collectedAt) gaps.push('collection date');
  for (const one of route.outflows) if (!one.at) gaps.push(`when ${one.to} is paid`);
  const outflowCents = route.outflows.reduce((sum, one) => sum + one.amountCents, 0);
  const outflow = { ...unknownFigure('', 'cents'), meaning: 'outflows', unit: 'cents', status: 'CONTRACTED' as FigureStatus, value: outflowCents, source: 'route outflows' };
  const free = derive('free to use', 'cents', [route.collectedCents, route.heldAgainstCents, outflow], ([collected, held, out]) => Math.max(0, (collected ?? 0) - (held ?? 0) - (out ?? 0)));
  if (route.collectedCents.value === null) gaps.push('collected amount');
  if (route.heldAgainstCents.value === null) gaps.push('amount held against refund or fulfilment');
  return { route: route.id, collectedCents: route.collectedCents.value, outflowCents, heldAgainstCents: route.heldAgainstCents.value, freeCents: free, gaps };
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
 */
export function evaluatePortfolio(
  streams: readonly Stream[],
  failureProbability: Record<string, number>,
  seed: number,
  trials = 4000,
): PortfolioReading | { missing: string[] } {
  const needed = [...new Set(streams.flatMap((one) => one.resources))];
  const missing = needed.filter((id) => !(id in failureProbability) || !(failureProbability[id]! >= 0 && failureProbability[id]! <= 1));
  if (missing.length > 0) return { missing };
  const rng = makeRng(seed);
  const naiveSumCents = streams.reduce((sum, one) => sum + one.bestCaseCents, 0);
  let total = 0;
  let allUp = 0;
  let halfLoss = 0;
  for (let t = 0; t < trials; t++) {
    const down = new Set(needed.filter((id) => rng() < (failureProbability[id] as number)));
    const earned = streams.reduce((sum, one) => sum + (one.resources.some((id) => down.has(id)) ? 0 : one.bestCaseCents), 0);
    total += earned;
    if (down.size === 0) allUp++;
    if (earned <= naiveSumCents / 2) halfLoss++;
  }
  const uses = new Map<string, number>();
  for (const one of streams) for (const id of new Set(one.resources)) uses.set(id, (uses.get(id) ?? 0) + 1);
  return {
    naiveSumCents,
    expectedCents: Math.round(total / trials),
    allUpProbability: allUp / trials,
    halfLossProbability: halfLoss / trials,
    trials,
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
