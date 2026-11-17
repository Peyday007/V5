/**
 * Scale decisions from measured contribution, per parser, detector, worker and
 * model route (CAP-19-5, S-0230 / S-0231).
 *
 * `stageCapacity.ts` (CAP-16-3) names the constrained *stage*. This module asks
 * the question one level down: of the components Brain has added — a source's
 * parser, a code detector rule, a worker pool's slots, a model route — what does
 * each contribute, against what it costs to keep and what it does downstream?
 * It extends the free-lane owner: it reads `bin_events` (FREE_LANE_ITEM,
 * FREE_LANE_CAPACITY, RUNPOD_POD), `feed_detections`, `feed_item_coverage`,
 * and the feed owner's own source-yield reader. It schedules nothing, owns no
 * table, and changes no capacity: its output is one `CAPACITY_CONTRIBUTION`
 * row a controller, report or probe reads.
 *
 * The rules the decision keeps, each from the quoted source:
 *
 *   - **Provisioned concurrency is not throughput.** A worker's slots count as
 *     contribution only through the accepted output they produced; a pool that
 *     holds slots and accepts nothing is reported as idle provision, never as
 *     capacity to grow.
 *   - **A failing provider or unavailable GPU is repaired, not out-scaled.** A
 *     route whose rows name a provider/credential/GPU failure is REPAIR, and the
 *     recommendation says that a larger application server does not repair it.
 *   - **Hardware only on measured saturation of a working path, or a measured
 *     marginal gain.** SCALE needs accepted output *and* measured saturation
 *     with work waiting, or a measured contribution per cost above the kind's
 *     median with work waiting; nothing unmeasured ever scales.
 *   - **An algorithm cannot produce facts its sources do not contain.** What
 *     stays unknown is a gap, with the highest-value *permitted* way of
 *     obtaining it; a way that would cross a data-access or contact permission
 *     is listed as excluded with its reason and never chosen.
 *
 * A figure is measured or says why not (`Measured<T>`); nothing is invented.
 * Kinds, sources, rules and routes are data read from rows — none of them is a
 * whitelist of what Brain may work on.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { isRunpodSlot } from '../cheap/runpod.ts';
import { readPodSpend, type PodSpend } from '../cheap/runpodPod.ts';
import { readSourceYields, type SourceYield } from '../feeds/run.ts';
import { causeOfReason, type RouteFailureCause } from './worker.ts';
import { waitingNow } from './capacity.ts';
import { boundMeasures, routeOfReason, usageOf, type Measured } from './stageCapacity.ts';

export const CAPACITY_CONTRIBUTION_EVENT = 'CAPACITY_CONTRIBUTION';

export type ComponentKind = 'PARSER' | 'DETECTOR' | 'WORKER' | 'MODEL_ROUTE';

/** Every S-0230 measure, per component. A measure that does not apply to a kind says so. */
export interface ContributionMeasures {
  recordsPerComputeSecond: Measured<number>;
  sourcesCovered: Measured<number>;
  dedupCoverage: Measured<number>;
  parseCoverage: Measured<number>;
  codeDerivedMatches: Measured<number>;
  aiCallsPerUsefulFinding: Measured<number>;
  minutesToVerifiedCandidate: Measured<number>;
  acceptedEconomicEvidence: Measured<number>;
  offerReadyPathways: Measured<number>;
  cashOutcomes: Measured<number>;
  errorRate: Measured<number>;
  saturation: Measured<number>;
  queueDelayMinutes: Measured<number>;
  idleShare: Measured<number>;
}

export const CONTRIBUTION_MEASURE_KEYS: readonly (keyof ContributionMeasures)[] = [
  'recordsPerComputeSecond', 'sourcesCovered', 'dedupCoverage', 'parseCoverage', 'codeDerivedMatches',
  'aiCallsPerUsefulFinding', 'minutesToVerifiedCandidate', 'acceptedEconomicEvidence', 'offerReadyPathways',
  'cashOutcomes', 'errorRate', 'saturation', 'queueDelayMinutes', 'idleShare',
];

export interface ComponentReading {
  kind: ComponentKind;
  id: string;
  /** Slots, rules or pulls the component holds; never itself a contribution. */
  provisioned: number | null;
  /** Output that something downstream accepted in the window. */
  usefulOutput: Measured<number>;
  /** Ongoing dollar cost in the window. A free provider or code path is a measured $0. */
  cost: Measured<number>;
  /** What the component changed downstream: model calls it spared, leads it carried on, items it handed on. */
  downstreamEffect: Measured<number>;
  /** Whether useful work is waiting for this component. */
  workWaiting: Measured<number>;
  /** The failure its own rows name now, if any. */
  failing: { cause: RouteFailureCause; failures: number } | null;
  measures: ContributionMeasures;
}

export type ContributionVerdict = 'SCALE' | 'HOLD' | 'RETIRE' | 'REPAIR' | 'MEASURE';

export interface ContributionDecision {
  kind: ComponentKind;
  id: string;
  verdict: ContributionVerdict;
  /** Whether added hardware/capacity for this component is justified by a measurement. */
  hardwareJustified: boolean;
  /** Accepted output per dollar; null when cost is $0 (unbounded) or either side is unmeasured. */
  contributionPerDollar: number | null;
  basis: string;
  recommendation: string;
}

const NOT = (reason: string): { measured: false; reason: string } => ({ measured: false, reason });
const ok = <T>(value: T): { measured: true; value: T } => ({ measured: true, value });
const n = (value: unknown): number => Number(value ?? 0) || 0;
const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places;

/** Saturation at or above which a working component with waiting work is shown to be saturated. */
export const SATURATION_FLOOR = 0.85;
/** Failure causes that are repairs of the path, not capacity. */
const REPAIR_CAUSES: readonly RouteFailureCause[] = ['credentials', 'task routing', 'broken GPU', 'provider availability', 'database'];

const NO_APP_SERVER = 'A larger application server does not repair it.';

/**
 * One component's decision. Pure. Order matters and is the rule's precedence:
 * a named failure is a repair before anything else; an unmeasured output is
 * measured before it is judged; provision without accepted output is idle,
 * never scaled; and only then can saturation or marginal gain justify more.
 */
export function decideComponent(reading: ComponentReading, kindMedianPerDollar: number | null = null): ContributionDecision {
  const base = { kind: reading.kind, id: reading.id };
  const perDollar = contributionPerDollar(reading);
  if (reading.failing && REPAIR_CAUSES.includes(reading.failing.cause)) {
    return {
      ...base, verdict: 'REPAIR', hardwareJustified: false, contributionPerDollar: perDollar,
      basis: `FAILING:${reading.failing.cause}`,
      recommendation: `Repair ${reading.kind.toLowerCase()} ${reading.id}: ${reading.failing.failures} failure(s) name ${reading.failing.cause}. ${NO_APP_SERVER}`,
    };
  }
  if (!reading.usefulOutput.measured) {
    return {
      ...base, verdict: 'MEASURE', hardwareJustified: false, contributionPerDollar: null,
      basis: 'OUTPUT_NOT_MEASURED',
      recommendation: `Record ${reading.id}'s accepted output before deciding anything about it: ${reading.usefulOutput.reason}.`,
    };
  }
  const useful = reading.usefulOutput.value;
  const costDollars = reading.cost.measured ? reading.cost.value : 0;
  const costly = costDollars > 0;
  if (useful <= 0) {
    const holds = (reading.provisioned ?? 0) > 0;
    const errored = reading.measures.errorRate.measured && reading.measures.errorRate.value >= 0.5;
    if (costly || errored) {
      return {
        ...base, verdict: 'RETIRE', hardwareJustified: false, contributionPerDollar: perDollar,
        basis: costly ? 'COST_WITHOUT_OUTPUT' : 'ERRORS_WITHOUT_OUTPUT',
        recommendation: `${reading.id} produced no accepted output in the window${costly ? ` while costing $${round(costDollars, 2)}` : ''}${errored ? ' and mostly errored' : ''}; retire or rework it rather than keep paying for it.`,
      };
    }
    return {
      ...base, verdict: 'HOLD', hardwareJustified: false, contributionPerDollar: perDollar,
      basis: holds ? 'PROVISIONED_NOT_PRODUCTIVE' : 'NO_OUTPUT',
      recommendation: holds
        ? `${reading.id} holds ${reading.provisioned} provisioned unit(s) and accepted nothing: provisioned concurrency is not throughput, so it does not grow.`
        : `${reading.id} accepted nothing in the window; nothing supports adding to it.`,
    };
  }
  const waiting = reading.workWaiting.measured && reading.workWaiting.value > 0;
  const saturated = reading.measures.saturation.measured && reading.measures.saturation.value >= SATURATION_FLOOR;
  if (saturated && waiting) {
    return {
      ...base, verdict: 'SCALE', hardwareJustified: true, contributionPerDollar: perDollar,
      basis: 'MEASURED_SATURATION',
      recommendation: `${reading.id} is a working path at measured saturation ${round((reading.measures.saturation as { value: number }).value, 2)} with ${(reading.workWaiting as { value: number }).value} waiting; one more unit is justified, then re-measure accepted output.`,
    };
  }
  const gain = waiting && kindMedianPerDollar !== null && (perDollar === null ? reading.cost.measured : perDollar > kindMedianPerDollar);
  if (gain) {
    return {
      ...base, verdict: 'SCALE', hardwareJustified: true, contributionPerDollar: perDollar,
      basis: 'MARGINAL_GAIN',
      recommendation: `${reading.id} yields ${perDollar === null ? 'accepted output at $0' : `${round(perDollar, 2)} accepted per dollar, above its kind's median ${round(kindMedianPerDollar!, 2)}`} with work waiting; add to it and re-measure.`,
    };
  }
  return {
    ...base, verdict: 'HOLD', hardwareJustified: false, contributionPerDollar: perDollar,
    basis: waiting ? 'NOT_SATURATED' : 'NOTHING_WAITING',
    recommendation: `${reading.id} contributes ${useful} accepted; ${waiting ? 'it is not saturated, so more of it would wait idle' : 'nothing is waiting for it'}.`,
  };
}

export function contributionPerDollar(reading: ComponentReading): number | null {
  if (!reading.usefulOutput.measured || !reading.cost.measured || reading.cost.value <= 0) return null;
  return reading.usefulOutput.value / reading.cost.value;
}

/** Every component compared against the others of its kind: the median accepted-per-dollar is the bar. Pure. */
export function compareContributions(readings: readonly ComponentReading[]): ContributionDecision[] {
  const medians = new Map<ComponentKind, number | null>();
  for (const kind of new Set(readings.map((r) => r.kind))) {
    const values = readings.filter((r) => r.kind === kind).map(contributionPerDollar).filter((v): v is number => v !== null).sort((a, b) => a - b);
    medians.set(kind, values.length === 0 ? null : values[Math.floor((values.length - 1) / 2)]!);
  }
  return readings.map((r) => decideComponent(r, medians.get(r.kind) ?? null));
}

// ---------------------------------------------------------------------------
// Gaps: what no algorithm can read out of sources that do not contain it.

export type GapSubject = 'EXTRACTION' | 'RELATIONSHIP' | 'MARKET_DEMAND' | 'DELIVERY_CAPABILITY' | 'PAYMENT_TIMING';

export interface AcquisitionWay {
  method: string;
  /** Expected value of the answer (decision value units the caller measures in). */
  value: number;
  /** Expected cost to obtain it; 0 for code over stored rows. */
  cost: number;
  /** Whether a data-access constraint permits it. */
  accessPermitted: boolean;
  /** Whether it contacts a person and, if so, whether a contact permission exists. */
  contacts: boolean;
  contactPermitted: boolean;
}

export interface Gap {
  subject: GapSubject;
  key: string;
  count: number;
  ways: readonly AcquisitionWay[];
}

export interface GapPlan {
  subject: GapSubject;
  key: string;
  count: number;
  chosen: { method: string; value: number; cost: number } | null;
  excluded: { method: string; reason: string }[];
  reason: string;
}

/**
 * Expose a gap and choose the highest-value permitted way to obtain it: value
 * per unit cost (a $0 way ranks by value alone, ahead of any priced way of no
 * greater value). A way that crosses a data-access constraint, or contacts
 * someone without a contact permission, is excluded with its reason and is
 * never chosen, however valuable. Pure.
 */
export function planGap(gap: Gap): GapPlan {
  const excluded: GapPlan['excluded'] = [];
  const allowed: AcquisitionWay[] = [];
  for (const way of gap.ways) {
    if (!way.accessPermitted) excluded.push({ method: way.method, reason: 'data-access constraint does not permit it' });
    else if (way.contacts && !way.contactPermitted) excluded.push({ method: way.method, reason: 'no commercial contact permission' });
    else allowed.push(way);
  }
  const score = (w: AcquisitionWay): number => (w.cost <= 0 ? Number.POSITIVE_INFINITY : w.value / w.cost);
  const ranked = allowed.filter((w) => w.value > 0).sort((a, b) => score(b) - score(a) || b.value - a.value || a.method.localeCompare(b.method));
  const best = ranked[0] ?? null;
  return {
    subject: gap.subject, key: gap.key, count: gap.count,
    chosen: best ? { method: best.method, value: best.value, cost: best.cost } : null,
    excluded,
    reason: best
      ? `${gap.count} ${gap.subject.toLowerCase().replace('_', ' ')} unknown(s) at ${gap.key}: obtain by ${best.method}.`
      : `${gap.count} ${gap.subject.toLowerCase().replace('_', ' ')} unknown(s) at ${gap.key}: no permitted way to obtain them; the gap stays open and is reported.`,
  };
}

/**
 * The extraction gaps a source's own yield shows: records acquired that neither
 * the screen kept nor a code rule accounted for. The ways are data: a parser
 * written for the source (code, $0 per record afterwards), model assistance on
 * the unread records (a model call each), or asking the provider for structured
 * access (only where the source's access state permits it).
 */
export function extractionGapsFromYields(yields: readonly SourceYield[], permissionNeeds: ReadonlySet<string> = new Set()): Gap[] {
  const gaps: Gap[] = [];
  for (const y of yields) {
    const unread = Math.max(0, y.acquired - y.accepted);
    if (unread <= 0) continue;
    const accessOk = !permissionNeeds.has(y.source);
    gaps.push({
      subject: 'EXTRACTION',
      key: y.source,
      count: unread,
      ways: [
        { method: 'code parser for the source', value: unread, cost: 0, accessPermitted: accessOk, contacts: false, contactPermitted: false },
        { method: 'model assistance on unread records', value: unread, cost: unread, accessPermitted: accessOk, contacts: false, contactPermitted: false },
        { method: 'request structured access from the provider', value: unread * 2, cost: 1, accessPermitted: true, contacts: true, contactPermitted: false },
      ],
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Readers: rows → component readings. Pure builders, thin queries.

const NA = (what: string, kind: ComponentKind): { measured: false; reason: string } => NOT(`${what} does not apply to a ${kind.toLowerCase().replace('_', ' ')}`);

function blankMeasures(kind: ComponentKind): ContributionMeasures {
  const m = {} as ContributionMeasures;
  for (const key of CONTRIBUTION_MEASURE_KEYS) m[key] = NA(key, kind);
  return m;
}

/** One lane row: `FREE_LANE_ITEM` with its reason, outcome, duration and usage. */
export interface LaneItemRow {
  outcome: string | null;
  reason: string | null;
  durationMs: number | null;
  measures: string | null;
}

/** Model-route readings from lane rows. GPU routes are priced at the pod's measured spend; free providers are a measured $0. Pure. */
export function routeReadings(rows: readonly LaneItemRow[], podSpend: PodSpend | null, waiting: number | null): ComponentReading[] {
  const byRoute = new Map<string, { items: number; submitted: number; failures: number; causes: Map<RouteFailureCause, number>; modelCalls: number; avoided: number; cpuMicros: number; metered: number; elapsedMs: number }>();
  for (const row of rows) {
    const route = routeOfReason(row.reason);
    if (!route) continue;
    const e = byRoute.get(route) ?? { items: 0, submitted: 0, failures: 0, causes: new Map(), modelCalls: 0, avoided: 0, cpuMicros: 0, metered: 0, elapsedMs: 0 };
    e.items += 1;
    if (row.outcome === 'SUBMITTED') e.submitted += 1;
    const cause = causeOfReason(row.reason);
    if (cause) {
      e.failures += 1;
      e.causes.set(cause, (e.causes.get(cause) ?? 0) + 1);
    }
    const usage = usageOf(row.measures);
    if (usage) {
      e.metered += 1;
      e.modelCalls += usage.modelCalls;
      e.avoided += usage.modelCallsAvoided;
      e.cpuMicros += usage.cpuMicros;
    }
    e.elapsedMs += n(row.durationMs);
    byRoute.set(route, e);
  }
  const gpuRoutes = [...byRoute.keys()].filter(isRunpodSlot);
  return [...byRoute.entries()].map(([route, e]): ComponentReading => {
    const measures = blankMeasures('MODEL_ROUTE');
    measures.recordsPerComputeSecond = e.metered > 0 && e.cpuMicros > 0 ? ok(round(e.submitted / (e.cpuMicros / 1e6))) : NOT('no lane item on this route carried a CPU reading');
    measures.aiCallsPerUsefulFinding = e.metered === 0 ? NOT('no item on this route recorded its model calls') : e.submitted > 0 ? ok(round(e.modelCalls / e.submitted)) : NOT('no accepted finding to divide by');
    measures.acceptedEconomicEvidence = ok(e.submitted);
    measures.errorRate = ok(e.items > 0 ? round(e.failures / e.items) : 0);
    measures.saturation = NOT('saturation is a worker pool\'s, read on its WORKER component');
    measures.idleShare = NOT('idle share is a worker pool\'s, read on its WORKER component');
    measures.queueDelayMinutes = NOT('queue delay is per stage, not per route (stage-capacity reading)');
    measures.minutesToVerifiedCandidate = NOT('the lane rows do not tie a route\'s answer to the candidate it verified');
    measures.offerReadyPathways = NOT('no row attributes an offer-ready pathway to a model route');
    measures.cashOutcomes = NOT('no row attributes a cash outcome to a model route');
    let cost: Measured<number>;
    if (!isRunpodSlot(route)) cost = ok(0);
    else if (!podSpend || podSpend.samples === 0) cost = NOT('no RunPod supervisor sample in the window');
    else if (podSpend.unpricedRunningSamples > 0) cost = NOT(`RunPod returned no price for ${podSpend.unpricedRunningSamples} running sample(s)`);
    else cost = ok(round(podSpend.dollars / Math.max(1, gpuRoutes.length), 4));
    const ranked = [...e.causes.entries()].sort((a, b) => b[1] - a[1]);
    const failingNow = e.failures > 0 && e.submitted * 5 < e.items;
    return {
      kind: 'MODEL_ROUTE', id: route, provisioned: null,
      usefulOutput: ok(e.submitted), cost,
      downstreamEffect: e.metered > 0 ? ok(e.avoided) : NOT('no item on this route recorded model calls avoided'),
      workWaiting: waiting === null ? NOT('the lane queue was not read') : ok(waiting),
      failing: failingNow && ranked[0] ? { cause: ranked[0][0], failures: e.failures } : null,
      measures,
    };
  });
}

/** One `FREE_LANE_CAPACITY` row, the latest per model. */
export interface PoolRow {
  model: string;
  reason: string | null;
  measures: string | null;
}

/** Worker-pool readings: provisioned slots beside the accepted output those slots produced. Pure. */
export function poolReadings(pools: readonly PoolRow[], submittedByModel: ReadonlyMap<string, number>): ComponentReading[] {
  return pools.map((pool): ComponentReading => {
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(pool.measures ?? '{}') as Record<string, unknown>; } catch { m = {}; }
    const target = /->\s*(\d+)/.exec(pool.reason ?? '')?.[1];
    const slots = target !== undefined ? Number(target) : null;
    const busy = typeof m.busy === 'number' ? m.busy : null;
    const peak = typeof m.peakBusy === 'number' ? m.peakBusy : busy;
    const waiting = typeof m.waiting === 'number' ? m.waiting : null;
    const measures = blankMeasures('WORKER');
    measures.saturation = slots && peak !== null ? ok(round(peak / slots)) : NOT('the pool\'s target or peak busy is not on its latest capacity row');
    measures.idleShare = slots && busy !== null ? ok(round(Math.max(0, slots - busy) / slots)) : NOT('the pool\'s target or busy count is not on its latest capacity row');
    const submitted = submittedByModel.get(pool.model) ?? 0;
    measures.acceptedEconomicEvidence = ok(submitted);
    return {
      kind: 'WORKER', id: pool.model, provisioned: slots,
      usefulOutput: ok(submitted),
      cost: NOT('a worker slot\'s own cost is its route\'s, read on the MODEL_ROUTE component'),
      downstreamEffect: ok(submitted),
      workWaiting: waiting === null ? NOT('the latest capacity row carries no waiting count') : ok(waiting),
      failing: null,
      measures,
    };
  });
}

/** One detector rule's rows over the window. */
export interface DetectorRow {
  ruleId: string;
  ruleVersion: number;
  mode: string;
  detections: number;
  covered: number;
  leads: number;
}

/**
 * Detector readings. An ACTIVE rule's covered items skip the free screen, so
 * each is a model call avoided downstream; a SHADOW rule avoids nothing yet and
 * says so. Code costs no provider dollars, so its cost is a measured $0. Pure.
 */
export function detectorReadings(rows: readonly DetectorRow[], waitingUncovered: number | null): ComponentReading[] {
  return rows.map((r): ComponentReading => {
    const measures = blankMeasures('DETECTOR');
    measures.codeDerivedMatches = ok(r.detections);
    measures.acceptedEconomicEvidence = ok(r.leads);
    measures.aiCallsPerUsefulFinding = ok(0);
    measures.errorRate = NOT('no row records a detector\'s false positives yet; SHADOW readings are the check');
    measures.recordsPerComputeSecond = NOT('detectors run inside the feed tick, which records no per-rule CPU time');
    return {
      kind: 'DETECTOR', id: `${r.ruleId}@${r.ruleVersion}`, provisioned: 1,
      usefulOutput: ok(r.leads),
      cost: ok(0),
      downstreamEffect: r.mode === 'ACTIVE' ? ok(r.covered) : NOT('a SHADOW rule changes nothing downstream until it is made ACTIVE'),
      workWaiting: waitingUncovered === null ? NOT('uncovered stored items were not counted') : ok(waitingUncovered),
      failing: null,
      measures,
    };
  });
}

/** Parser (per feed source) readings from the feed owner's yield reading and the source's pulls. Pure. */
export function parserReadings(
  yields: readonly SourceYield[],
  pulls: ReadonlyMap<string, { pulls: number; failed: number; fetched: number; inserted: number }>,
): ComponentReading[] {
  return yields.map((y): ComponentReading => {
    const p = pulls.get(y.source);
    const measures = blankMeasures('PARSER');
    measures.sourcesCovered = ok(y.acquired > 0 ? 1 : 0);
    measures.parseCoverage = y.acquired > 0 ? ok(round(y.accepted / y.acquired)) : NOT('nothing acquired from this source in the window');
    measures.dedupCoverage = p && p.fetched > 0 ? ok(round((p.fetched - p.inserted) / p.fetched)) : NOT('no pull of this source fetched records in the window');
    measures.errorRate = p && p.pulls > 0 ? ok(round(p.failed / p.pulls)) : NOT('no pull of this source in the window');
    measures.acceptedEconomicEvidence = ok(y.accepted);
    measures.offerReadyPathways = ok(y.usable);
    measures.recordsPerComputeSecond = NOT('feed pulls record no CPU time');
    return {
      kind: 'PARSER', id: y.source, provisioned: null,
      usefulOutput: ok(y.accepted),
      cost: ok(0),
      downstreamEffect: ok(y.usable),
      workWaiting: NOT('a parser reads what its pull brought; nothing queues for it'),
      failing: null,
      measures,
    };
  });
}

/** System-wide commercial outcomes: not attributable per component, so reported once, measured or not. */
export interface SystemOutcomes {
  minutesToVerifiedCandidate: Measured<number>;
  offerReadyPathways: Measured<number>;
  cashOutcomes: Measured<number>;
}

export interface ContributionReport {
  since: string;
  until: string;
  components: ComponentReading[];
  decisions: ContributionDecision[];
  gaps: GapPlan[];
  system: SystemOutcomes;
  /** Whether any decision justifies added hardware, and which. */
  hardwareJustifiedFor: string[];
  repairsFirst: string[];
}

export function buildContributionReport(input: {
  since: string;
  until: string;
  components: ComponentReading[];
  gaps: Gap[];
  system: SystemOutcomes;
}): ContributionReport {
  const decisions = compareContributions(input.components);
  const repairsFirst = decisions.filter((d) => d.verdict === 'REPAIR').map((d) => `${d.kind}:${d.id}`);
  // A pending repair comes before any hardware: added capacity is measured only on a working path.
  const hardwareJustifiedFor = repairsFirst.length > 0 ? [] : decisions.filter((d) => d.hardwareJustified).map((d) => `${d.kind}:${d.id}`);
  return {
    since: input.since, until: input.until,
    components: input.components, decisions,
    gaps: input.gaps.map(planGap),
    system: input.system,
    hardwareJustifiedFor, repairsFirst,
  };
}

async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function readSystemOutcomes(since: string): Promise<SystemOutcomes> {
  const db = getDb();
  const opened = await safely(
    async () => ok(n((await db.get<{ k: number | string }>(`SELECT COUNT(*) AS k FROM cash_opportunities WHERE created_at >= ?`, [since]))?.k)),
    NOT('cash_opportunities could not be read') as Measured<number>,
  );
  return {
    minutesToVerifiedCandidate: NOT('no row stamps when a candidate was verified against when its first source arrived'),
    offerReadyPathways: opened,
    cashOutcomes: NOT('cash outcomes are read only where the owner authorized the deal; no per-window outcome row is attributed here'),
  };
}

/** Read every component's contribution over the window, from rows. Read-only. */
export async function readContribution(options: { hours?: number; now?: number } = {}): Promise<ContributionReport> {
  const hours = options.hours ?? 24;
  const nowMs = options.now ?? Date.now();
  const since = new Date(nowMs - hours * 3_600_000).toISOString();
  const until = new Date(nowMs).toISOString();
  const db = getDb();

  const laneRows = await safely(async () => (await db.all<{ outcome: string | null; reason: string | null; duration_ms: number | string | null; measures: string | null; workload_class: string | null }>(
    `SELECT outcome, reason, duration_ms, measures, workload_class FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND reason LIKE 'model %'`,
    [since],
  )).map((r) => ({ outcome: r.outcome, reason: r.reason, durationMs: r.duration_ms === null ? null : n(r.duration_ms), measures: r.measures })), [] as LaneItemRow[]);
  const waiting = await safely(() => waitingNow(), null as number | null);
  const podSpend = await safely(() => readPodSpend(since), null as PodSpend | null);

  const submittedByModel = new Map<string, number>();
  for (const row of laneRows) {
    const route = routeOfReason(row.reason);
    if (route && row.outcome === 'SUBMITTED') submittedByModel.set(route, (submittedByModel.get(route) ?? 0) + 1);
  }
  const pools = await safely(async () => (await db.all<{ workload_class: string; reason: string | null; measures: string | null; at: string }>(
    `SELECT e.workload_class, e.reason, e.measures, e.at FROM bin_events e
      WHERE e.event_type = 'FREE_LANE_CAPACITY' AND e.workload_class IS NOT NULL
        AND e.at = (SELECT MAX(x.at) FROM bin_events x WHERE x.event_type = 'FREE_LANE_CAPACITY' AND x.workload_class = e.workload_class)`,
  )).map((r) => ({ model: r.workload_class, reason: r.reason, measures: r.measures })), [] as PoolRow[]);

  const detectorRows = await safely(async () => (await db.all<{ rule_id: string; rule_version: number | string; mode: string; detections: number | string; covered: number | string; leads: number | string }>(
    `SELECT d.rule_id, d.rule_version, d.mode, COUNT(*) AS detections,
            (SELECT COUNT(*) FROM feed_item_coverage c JOIN feed_detections d2 ON d2.id = c.detection_id
              WHERE d2.rule_id = d.rule_id AND d2.rule_version = d.rule_version AND c.covered_at >= ?) AS covered,
            SUM(CASE WHEN d.lead_item_id IS NOT NULL THEN 1 ELSE 0 END) AS leads
       FROM feed_detections d WHERE d.updated_at >= ?
      GROUP BY d.rule_id, d.rule_version, d.mode`,
    [since, since],
  )).map((r) => ({ ruleId: r.rule_id, ruleVersion: n(r.rule_version), mode: r.mode, detections: n(r.detections), covered: n(r.covered), leads: n(r.leads) })), [] as DetectorRow[]);
  const uncovered = await safely(async () => n((await db.get<{ k: number | string }>(
    `SELECT COUNT(*) AS k FROM feed_items i WHERE i.fetched_at >= ? AND NOT EXISTS (SELECT 1 FROM feed_item_coverage c WHERE c.item_id = i.id)`,
    [since],
  ))?.k), null as number | null);

  const yields = await safely(() => readSourceYields(since, until), [] as SourceYield[]);
  const pullRows = await safely(() => db.all<{ source: string; pulls: number | string; failed: number | string; fetched: number | string; inserted: number | string }>(
    `SELECT source, COUNT(*) AS pulls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, SUM(fetched) AS fetched, SUM(inserted) AS inserted
       FROM feed_pulls WHERE created_at >= ? GROUP BY source`,
    [since],
  ), [] as { source: string; pulls: number | string; failed: number | string; fetched: number | string; inserted: number | string }[]);
  const pulls = new Map(pullRows.map((r) => [r.source, { pulls: n(r.pulls), failed: n(r.failed), fetched: n(r.fetched), inserted: n(r.inserted) }]));
  const permissionNeeds = new Set(await safely(async () => (await db.all<{ provider: string | null }>(
    `SELECT DISTINCT provider FROM bin_events WHERE event_type = 'FEED_ACQUISITION' AND outcome = 'PERMISSION_NEED' AND at >= ?`,
    [since],
  )).map((r) => r.provider ?? '').filter(Boolean), [] as string[]));

  return buildContributionReport({
    since, until,
    components: [
      ...parserReadings(yields, pulls),
      ...detectorReadings(detectorRows, uncovered),
      ...poolReadings(pools, submittedByModel),
      ...routeReadings(laneRows, podSpend, waiting),
    ],
    gaps: extractionGapsFromYields(yields, permissionNeeds),
    system: await readSystemOutcomes(since),
  });
}

/** Measure and record one `CAPACITY_CONTRIBUTION` row. Background only; never on a web request. */
export async function recordContribution(
  now: Date = new Date(),
  record: typeof recordBinEvent = recordBinEvent,
  read: (options: { now: number }) => Promise<ContributionReport> = (o) => readContribution(o),
): Promise<ContributionReport> {
  const report = await read({ now: now.getTime() });
  const counts: Record<ContributionVerdict, number> = { SCALE: 0, HOLD: 0, RETIRE: 0, REPAIR: 0, MEASURE: 0 };
  for (const d of report.decisions) counts[d.verdict] += 1;
  await record({
    eventType: CAPACITY_CONTRIBUTION_EVENT,
    workloadClass: 'capacity',
    outcome: report.repairsFirst.length > 0 ? 'REPAIR_FIRST' : report.hardwareJustifiedFor.length > 0 ? 'SCALE_JUSTIFIED' : 'NO_SCALE_JUSTIFIED',
    reason: (report.repairsFirst.length > 0
      ? `Repair before scaling: ${report.repairsFirst.join(', ')}.`
      : report.hardwareJustifiedFor.length > 0
        ? `Measured contribution justifies more for: ${report.hardwareJustifiedFor.join(', ')}.`
        : 'No component shows measured saturation of a working path or a marginal gain.').slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: storedContribution(report, counts),
  });
  return report;
}

/** Verdicts in the order a stored reading keeps them: what asks for action first. */
const VERDICT_ORDER: readonly ContributionVerdict[] = ['REPAIR', 'SCALE', 'RETIRE', 'MEASURE', 'HOLD'];

/**
 * The reading as one hourly row stores it: decisions ordered by verdict so the
 * repairs and scale calls survive the list bound, components in the same order,
 * and every list cut to `boundMeasures`' size with what was cut counted. The
 * full report is still returned to the caller; only the row is bounded. Pure.
 */
export function storedContribution(report: ContributionReport, counts: Record<ContributionVerdict, number>): Record<string, unknown> {
  const rank = (v: ContributionVerdict): number => VERDICT_ORDER.indexOf(v);
  const decisions = [...(report.decisions ?? [])].sort((a, b) => rank(a.verdict) - rank(b.verdict));
  const order = new Map(decisions.map((d, i) => [`${d.kind}:${d.id}`, i]));
  const components = [...(report.components ?? [])].sort(
    (a, b) => (order.get(`${a.kind}:${a.id}`) ?? Number.MAX_SAFE_INTEGER) - (order.get(`${b.kind}:${b.id}`) ?? Number.MAX_SAFE_INTEGER),
  );
  return boundMeasures({
    ...report,
    decisions,
    components,
    counts,
    totals: { components: components.length, decisions: decisions.length, gaps: (report.gaps ?? []).length },
  } as unknown as Record<string, unknown>);
}
