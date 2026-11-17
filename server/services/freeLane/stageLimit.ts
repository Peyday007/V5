/**
 * Measure each stage and remove the limiting one (CAP-25-2, S-0360…S-0363).
 *
 * `stageCapacity.ts` (CAP-16-3) reads the lane's stages and names the
 * constrained one. This module extends that owner along the three axes the
 * source asks for — per **domain** (the corpus or open domain class a source is
 * an instance of), per **ingestion route** (the source itself) and per **time
 * window** — and turns a measured bottleneck into the remedy the source names
 * for it, rather than into a bigger server:
 *
 *   SOURCE_ACCESS            improve access or source selection
 *   PARSING                  add efficient code workers
 *   RECONCILIATION/VERIFICATION  more worker/model capacity at that stage
 *   DATABASE / APP_CPU       isolated processing and measured infrastructure expansion
 *   COMMERCIAL_RELEVANCE     change the questions, not the server size
 *
 * Two further rules:
 *
 *   - **The allocator compares kinds of addition.** Another LLM job is weighed
 *     against another non-LLM algorithm, worker, source connector or indexing
 *     improvement on measured gain per cost; an option whose gain is unmeasured
 *     is listed and never chosen.
 *   - **A pre-spend gate.** Before a hardware increase, the latest healthy
 *     reading is inspected; a known reversible blockage (an unavailable model, a
 *     failing audit handoff) refuses the spend until it is removed. An allowed
 *     increase carries the obligation to measure accepted, commercially useful
 *     output after it, and a later reading with no gain says to revert.
 *     Independent ingestion workers and optimized bulk processing are always
 *     offered as scaling options beside the application request loop.
 *
 * Read-only over existing rows (`bin_events`: FEED_ACQUISITION, FEED_SOURCE_YIELD,
 * FREE_LANE_ITEM, FREE_LANE_CAPACITY, the recorded FREE_LANE_STAGE_CAPACITY),
 * one `STAGE_LIMIT` row written through the existing bin-event writer. No
 * scheduler, store or table. Domains and routes are whatever the rows name.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { readSourceYields, type SourceYield } from '../feeds/run.ts';
import { readStageCapacity, STAGES, type Measured, type RecordedStageCapacity, type StageCapacityReport } from './stageCapacity.ts';

export const STAGE_LIMIT_EVENT = 'STAGE_LIMIT';

const NOT = (reason: string): { measured: false; reason: string } => ({ measured: false, reason });
const ok = <T>(value: T): { measured: true; value: T } => ({ measured: true, value });
const n = (value: unknown): number => Number(value ?? 0) || 0;
const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places;

// ---------------------------------------------------------------------------
// Per domain × route × window.

/** Every S-0360/S-0361 quantity, for one (domain, route, window). */
export interface RouteWindowMeasures {
  newRelevantSources: Measured<number>;
  recordsConsidered: Measured<number>;
  recordsNewlyFetched: Measured<number>;
  bytes: Measured<number>;
  transferMs: Measured<number>;
  processedRecords: Measured<number>;
  deduplicatedRecords: Measured<number>;
  acceptedFacts: Measured<number>;
  evidenceQuality: Measured<number>;
  economicRelationships: Measured<number>;
  correctedContradictions: Measured<number>;
  variablesResolved: Measured<number>;
  candidatesImproved: Measured<number>;
  minutesSourceChangeToPlan: Measured<number>;
  computeCost: Measured<number>;
  apiCost: Measured<number>;
  storageCost: Measured<number>;
}

export const ROUTE_MEASURE_KEYS: readonly (keyof RouteWindowMeasures)[] = [
  'newRelevantSources', 'recordsConsidered', 'recordsNewlyFetched', 'bytes', 'transferMs', 'processedRecords',
  'deduplicatedRecords', 'acceptedFacts', 'evidenceQuality', 'economicRelationships', 'correctedContradictions',
  'variablesResolved', 'candidatesImproved', 'minutesSourceChangeToPlan', 'computeCost', 'apiCost', 'storageCost',
];

export interface RouteWindowReading {
  domain: string;
  route: string;
  since: string;
  until: string;
  pulls: number;
  failedPulls: number;
  measures: RouteWindowMeasures;
}

/** One FEED_ACQUISITION row, as the measurement reads it. */
export interface AcquisitionRow {
  source: string;
  outcome: string;
  at: string;
  corpus: string | null;
  fetched: number;
  inserted: number;
  bytes?: number | null;
  durationMs?: number | null;
}

/**
 * Per (domain, route) readings over one window. A source pulled for the first
 * time in the window is a newly discovered source; a figure the rows do not
 * carry says which row would have to carry it. Pure.
 */
export function routeWindowReadings(input: {
  since: string;
  until: string;
  rows: readonly AcquisitionRow[];
  /** Routes that had any acquisition row before `since`. */
  seenBefore: ReadonlySet<string>;
  yields: readonly SourceYield[];
}): RouteWindowReading[] {
  const groups = new Map<string, { domain: string; route: string; pulls: number; failed: number; fetched: number; inserted: number; bytes: number; bytesSeen: number; ms: number; msSeen: number }>();
  for (const row of input.rows) {
    const domain = row.corpus ?? 'unclassified';
    const key = `${domain}\u0000${row.source}`;
    const g = groups.get(key) ?? { domain, route: row.source, pulls: 0, failed: 0, fetched: 0, inserted: 0, bytes: 0, bytesSeen: 0, ms: 0, msSeen: 0 };
    g.pulls += 1;
    if (row.outcome === 'FAILED' || row.outcome === 'PERMISSION_NEED') g.failed += 1;
    g.fetched += row.fetched;
    g.inserted += row.inserted;
    if (typeof row.bytes === 'number') { g.bytes += row.bytes; g.bytesSeen += 1; }
    if (typeof row.durationMs === 'number') { g.ms += row.durationMs; g.msSeen += 1; }
    groups.set(key, g);
  }
  const yieldOf = new Map(input.yields.map((y) => [y.source, y]));
  return [...groups.values()].map((g): RouteWindowReading => {
    const y = yieldOf.get(g.route);
    const notOnRow = (what: string) => NOT(`${what} is not on the route's FEED_ACQUISITION rows`);
    const measures: RouteWindowMeasures = {
      newRelevantSources: ok(input.seenBefore.has(g.route) ? 0 : 1),
      recordsConsidered: ok(g.fetched),
      recordsNewlyFetched: ok(g.inserted),
      bytes: g.bytesSeen > 0 ? ok(g.bytes) : notOnRow('raw bytes'),
      transferMs: g.msSeen > 0 ? ok(g.ms) : notOnRow('transfer time'),
      processedRecords: y ? ok(y.acquired) : NOT('no source-yield reading for the route in the window'),
      deduplicatedRecords: ok(Math.max(0, g.fetched - g.inserted)),
      acceptedFacts: y ? ok(y.accepted) : NOT('no source-yield reading for the route in the window'),
      evidenceQuality: y && y.acquired > 0 ? ok(round(y.accepted / y.acquired)) : NOT('nothing acquired to judge'),
      economicRelationships: NOT('event-graph relationships are not attributed to the route that supplied them'),
      correctedContradictions: NOT('contradiction corrections are not attributed to a route'),
      variablesResolved: NOT('plan variables resolved are not attributed to a route'),
      candidatesImproved: y ? ok(y.usable) : NOT('no source-yield reading for the route in the window'),
      minutesSourceChangeToPlan: NOT('no row stamps when a source change reached the blueprint and goal plan'),
      computeCost: NOT('feed pulls record no CPU time'),
      apiCost: ok(0),
      storageCost: NOT('stored bytes per route are not recorded'),
    };
    return { domain: g.domain, route: g.route, since: input.since, until: input.until, pulls: g.pulls, failedPulls: g.failed, measures };
  });
}

// ---------------------------------------------------------------------------
// Per stage: queue depth, utilization, retries, backpressure.

export interface StagePressure {
  stage: string;
  queueDepth: Measured<number>;
  workerUtilization: Measured<number>;
  retries: Measured<number>;
  backpressure: Measured<boolean>;
}

/** Stage pressure from the recorded stage-capacity reading, lane retries and pool utilization. Pure. */
export function stagePressures(
  report: StageCapacityReport | null,
  retriesByStage: ReadonlyMap<string, number>,
  utilization: Measured<number>,
): StagePressure[] {
  return STAGES.map((def): StagePressure => {
    const reading = report?.stages.find((s) => s.stage === def.id);
    const queue = reading?.queueSize ?? NOT('no recorded stage-capacity reading');
    const lane = def.workTypes.length > 0;
    return {
      stage: def.id,
      queueDepth: queue,
      workerUtilization: lane ? utilization : NOT('this stage runs outside the free lane\'s worker pools'),
      retries: lane ? ok(retriesByStage.get(def.id) ?? 0) : NOT('this stage records no retries of its own'),
      backpressure: queue.measured && reading
        ? ok(queue.value > 0 && reading.acceptedPerHour > 0 && queue.value / reading.acceptedPerHour > 1)
        : NOT('queue or accepted rate not measured'),
    };
  });
}

// ---------------------------------------------------------------------------
// The limiting stage and its remedy.

export type BottleneckKind =
  | 'SOURCE_ACCESS'
  | 'PARSING'
  | 'RECONCILIATION'
  | 'VERIFICATION'
  | 'MODEL_INTERPRETATION'
  | 'DATABASE'
  | 'APP_CPU'
  | 'COMMERCIAL_RELEVANCE'
  | 'NONE';

export const REMEDIES: Record<BottleneckKind, { remedy: string; scaleServer: false }> = {
  SOURCE_ACCESS: { remedy: 'Improve access or source selection.', scaleServer: false },
  PARSING: { remedy: 'Add efficient code workers for parsing.', scaleServer: false },
  RECONCILIATION: { remedy: 'Give entity reconciliation more worker/model capacity.', scaleServer: false },
  VERIFICATION: { remedy: 'Give verification more worker/model capacity.', scaleServer: false },
  MODEL_INTERPRETATION: { remedy: 'Give interpretation more worker/model capacity once its routes answer.', scaleServer: false },
  DATABASE: { remedy: 'Consider isolated processing and measured infrastructure expansion for the database.', scaleServer: false },
  APP_CPU: { remedy: 'Consider isolated processing (independent workers) and measured infrastructure expansion; not a larger web process.', scaleServer: false },
  COMMERCIAL_RELEVANCE: { remedy: 'Change the questions, not the server size.', scaleServer: false },
  NONE: { remedy: 'No measured bottleneck; add nothing.', scaleServer: false },
};

/** What the constrained stage of `stageCapacity.ts` is, as a bottleneck kind. */
const STAGE_KIND: Record<string, BottleneckKind> = {
  'source-ingestion': 'SOURCE_ACCESS',
  'parsing-indexing': 'PARSING',
  'graph-quant': 'RECONCILIATION',
  'model-interpretation': 'MODEL_INTERPRETATION',
  'evidence-verification': 'VERIFICATION',
};

export interface LimitSignals {
  /** Failed or permission-refused pulls over all pulls. */
  accessFailureShare: Measured<number>;
  /** Accepted over acquired records. */
  parseCoverage: Measured<number>;
  /** The stage `chooseConstraint` named, or null. */
  constrainedStage: string | null;
  /** Workload waiting on the database pool. */
  dbWaiting: Measured<number>;
  /** Brain's CPU pressure, 0..1 of available cores. */
  cpu: Measured<number>;
  /** Commercially usable over accepted. */
  commercialShare: Measured<number>;
}

export interface LimitVerdict {
  kind: BottleneckKind;
  basis: string;
  remedy: string;
  scaleServer: false;
}

/**
 * The limiting stage, from measurements, in a fixed precedence: a source Brain
 * cannot reach limits everything after it; then parsing; then the stage the
 * stage-capacity reading names; then the database and CPU of the process
 * itself; and only when everything flows does a low commercial share say the
 * questions are wrong. Pure.
 */
export function limitingStage(s: LimitSignals): LimitVerdict {
  const verdict = (kind: BottleneckKind, basis: string): LimitVerdict => ({ kind, basis, remedy: REMEDIES[kind].remedy, scaleServer: false });
  if (s.accessFailureShare.measured && s.accessFailureShare.value >= 0.5) return verdict('SOURCE_ACCESS', `${Math.round(s.accessFailureShare.value * 100)}% of pulls failed or were refused`);
  if (s.parseCoverage.measured && s.parseCoverage.value < 0.25) return verdict('PARSING', `${Math.round(s.parseCoverage.value * 100)}% of acquired records parsed into accepted records`);
  if (s.constrainedStage && STAGE_KIND[s.constrainedStage]) return verdict(STAGE_KIND[s.constrainedStage]!, `stage-capacity names ${s.constrainedStage} the constraint`);
  if (s.dbWaiting.measured && s.dbWaiting.value > 0) return verdict('DATABASE', `${s.dbWaiting.value} workload(s) waiting on the database pool`);
  if (s.cpu.measured && s.cpu.value >= 0.85) return verdict('APP_CPU', `Brain CPU at ${Math.round(s.cpu.value * 100)}%`);
  if (s.commercialShare.measured && s.commercialShare.value < 0.05) return verdict('COMMERCIAL_RELEVANCE', `${round(s.commercialShare.value * 100, 1)}% of accepted records were commercially usable`);
  return verdict('NONE', 'no measured signal crosses its bound');
}

// ---------------------------------------------------------------------------
// The marginal-gain allocator.

export type AdditionKind = 'LLM_JOB' | 'ALGORITHM' | 'WORKER' | 'SOURCE_CONNECTOR' | 'INDEXING';

export interface AdditionOption {
  kind: AdditionKind;
  id: string;
  /** Accepted, commercially useful output per hour one more of this would add. */
  gain: Measured<number>;
  /** Its cost per hour (dollars; a code path is a measured 0). */
  cost: Measured<number>;
}

export interface Allocation {
  chosen: AdditionOption | null;
  ranked: { kind: AdditionKind; id: string; gainPerCost: number }[];
  unmeasured: { kind: AdditionKind; id: string; reason: string }[];
  /** True when an LLM job and at least one non-LLM option were both measured and compared. */
  comparedLlmWithNonLlm: boolean;
  basis: string;
}

const gainPerCost = (gain: number, cost: number): number => (cost <= 0 ? (gain > 0 ? Number.POSITIVE_INFINITY : 0) : gain / cost);

/**
 * Compare another LLM job with another algorithm, worker, connector or indexing
 * improvement and pick the larger measured gain per cost. Ties prefer the
 * non-LLM option (it needs no model call). Unmeasured options are never chosen. Pure.
 */
export function allocateMarginal(options: readonly AdditionOption[]): Allocation {
  const unmeasured: Allocation['unmeasured'] = [];
  const measured: { option: AdditionOption; score: number }[] = [];
  for (const o of options) {
    if (!o.gain.measured) unmeasured.push({ kind: o.kind, id: o.id, reason: o.gain.reason });
    else if (!o.cost.measured) unmeasured.push({ kind: o.kind, id: o.id, reason: o.cost.reason });
    else measured.push({ option: o, score: gainPerCost(o.gain.value, o.cost.value) });
  }
  measured.sort((a, b) => b.score - a.score || Number(a.option.kind === 'LLM_JOB') - Number(b.option.kind === 'LLM_JOB') || a.option.id.localeCompare(b.option.id));
  const best = measured.find((m) => m.option.gain.measured && m.option.gain.value > 0) ?? null;
  const compared = measured.some((m) => m.option.kind === 'LLM_JOB') && measured.some((m) => m.option.kind !== 'LLM_JOB');
  return {
    chosen: best?.option ?? null,
    ranked: measured.map((m) => ({ kind: m.option.kind, id: m.option.id, gainPerCost: Number.isFinite(m.score) ? round(m.score) : Number.MAX_SAFE_INTEGER })),
    unmeasured,
    comparedLlmWithNonLlm: compared,
    basis: best
      ? `${best.option.kind} ${best.option.id} adds the most accepted output per cost${compared ? ' (an LLM job and a non-LLM option were both measured)' : ''}.`
      : 'No option has a measured positive gain; add nothing.',
  };
}

// ---------------------------------------------------------------------------
// The pre-spend gate.

export interface Blockage {
  kind: 'UNAVAILABLE_MODEL' | 'FAILING_AUDIT_HANDOFF' | 'FAILING_ROUTE' | 'OTHER';
  reversible: boolean;
  detail: string;
}

export interface SpendGate {
  decision: 'REFUSE_REMOVE_BLOCKAGE_FIRST' | 'REFUSE_NO_HEALTHY_READING' | 'ALLOW_THEN_MEASURE' | 'GAIN_VERIFIED' | 'NO_GAIN_REVERT';
  reason: string;
  /** What must be measured after an allowed increase. */
  measureAfter: string | null;
  scalingOptions: readonly string[];
}

export const SCALING_OPTIONS = [
  'independent ingestion workers',
  'optimized bulk processing',
  'per-stage worker pools outside the application request loop',
] as const;

/**
 * Before a substantial hardware increase: inspect the latest healthy reading,
 * refuse while a known reversible blockage stands, and require the accepted,
 * commercially useful output to be measured afterwards. With a before/after
 * pair, say whether the increase earned its keep. Pure.
 */
export function preSpendGate(input: {
  latestHealthy: { at: string; stale: boolean } | null;
  blockages: readonly Blockage[];
  usefulBefore?: number | null;
  usefulAfter?: number | null;
}): SpendGate {
  const base = { scalingOptions: SCALING_OPTIONS };
  if (!input.latestHealthy || input.latestHealthy.stale) {
    return { ...base, decision: 'REFUSE_NO_HEALTHY_READING', reason: 'No current healthy measurement to inspect; measure before spending.', measureAfter: null };
  }
  const reversible = input.blockages.filter((b) => b.reversible);
  if (reversible.length > 0) {
    return {
      ...base, decision: 'REFUSE_REMOVE_BLOCKAGE_FIRST',
      reason: `Remove the reversible blockage first: ${reversible.map((b) => `${b.kind} (${b.detail})`).join('; ')}.`,
      measureAfter: null,
    };
  }
  if (typeof input.usefulBefore === 'number' && typeof input.usefulAfter === 'number') {
    return input.usefulAfter > input.usefulBefore
      ? { ...base, decision: 'GAIN_VERIFIED', reason: `Accepted useful output rose from ${input.usefulBefore} to ${input.usefulAfter}.`, measureAfter: null }
      : { ...base, decision: 'NO_GAIN_REVERT', reason: `Accepted useful output did not rise (${input.usefulBefore} -> ${input.usefulAfter}); the added capacity is not earning, revert it.`, measureAfter: null };
  }
  return {
    ...base, decision: 'ALLOW_THEN_MEASURE',
    reason: 'No reversible blockage in the latest healthy reading.',
    measureAfter: 'accepted, commercially useful output per hour over an equal window after the change',
  };
}

/** Known reversible blockages in a recorded stage-capacity reading. Pure. */
export function blockagesOf(recorded: RecordedStageCapacity | null): Blockage[] {
  const report = recorded?.report;
  if (!report) return [];
  const out: Blockage[] = [];
  const primary = report.diagnosis?.primary;
  if (primary) {
    out.push({ kind: 'UNAVAILABLE_MODEL', reversible: true, detail: `model route ${primary.route}: ${primary.cause}` });
  }
  const audit = report.stages.find((s) => s.stage === 'evidence-verification');
  if (audit && audit.queueSize.measured && audit.queueSize.value > 0 && audit.accepted === 0 && audit.providerFailures.measured && audit.providerFailures.value > 0) {
    out.push({ kind: 'FAILING_AUDIT_HANDOFF', reversible: true, detail: `${audit.queueSize.value} verification/audit item(s) waiting, ${audit.providerFailures.value} provider failure(s), none accepted` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report and record.

export interface StageLimitReport {
  since: string;
  until: string;
  routes: RouteWindowReading[];
  domains: { domain: string; routes: number; recordsConsidered: number; acceptedFacts: number }[];
  pressures: StagePressure[];
  limit: LimitVerdict;
  allocation: Allocation;
  gate: SpendGate;
}

/** The addition options the rows can price: one more LLM job vs one more code path per kind. Pure. */
export function additionOptions(report: StageCapacityReport | null, routes: readonly RouteWindowReading[], hours: number): AdditionOption[] {
  const out: AdditionOption[] = [];
  const interp = report?.stages.find((s) => s.stage === 'model-interpretation');
  if (interp && interp.itemsProcessedPerHour.measured && interp.itemsProcessedPerHour.value > 0) {
    const perJob = interp.acceptedPerHour / interp.itemsProcessedPerHour.value;
    out.push({ kind: 'LLM_JOB', id: 'model-interpretation', gain: ok(round(perJob)), cost: interp.incrementalDollars.measured ? ok(round(interp.incrementalDollars.value / Math.max(1, interp.itemsProcessedPerHour.value * hours))) : interp.incrementalDollars });
  } else {
    out.push({ kind: 'LLM_JOB', id: 'model-interpretation', gain: NOT('the interpretation stage processed nothing measured in the window'), cost: NOT('no reading') });
  }
  // Another connector: the best route's accepted facts per hour, at a code path's $0.
  const best = [...routes].sort((a, b) => n((b.measures.acceptedFacts as { value?: number }).value) - n((a.measures.acceptedFacts as { value?: number }).value))[0];
  out.push(best && best.measures.acceptedFacts.measured
    ? { kind: 'SOURCE_CONNECTOR', id: `like ${best.route}`, gain: ok(round(best.measures.acceptedFacts.value / Math.max(1, hours))), cost: ok(0) }
    : { kind: 'SOURCE_CONNECTOR', id: 'connector', gain: NOT('no route accepted facts in the window'), cost: ok(0) });
  // A parser/algorithm: the unread records a code parser would turn into accepted records at the parsed share.
  const totals = routes.reduce((t, r) => ({
    considered: t.considered + (r.measures.processedRecords.measured ? r.measures.processedRecords.value : 0),
    accepted: t.accepted + (r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0),
  }), { considered: 0, accepted: 0 });
  out.push(totals.considered > 0
    ? { kind: 'ALGORITHM', id: 'code parser for unread records', gain: ok(round((totals.considered - totals.accepted) * (totals.accepted / totals.considered) / Math.max(1, hours))), cost: ok(0) }
    : { kind: 'ALGORITHM', id: 'code parser', gain: NOT('no records considered in the window'), cost: ok(0) });
  out.push({ kind: 'WORKER', id: 'free-lane slot', gain: report?.constrained.expectedGain.measured ? ok(round(report.constrained.expectedGain.value.acceptedFactsPerHour)) : NOT(report?.constrained.expectedGain.measured === false ? report.constrained.expectedGain.reason : 'no recorded stage-capacity reading'), cost: report?.constrained.expectedGain.measured ? ok(round(report.constrained.expectedGain.value.dollars)) : NOT('no reading') });
  out.push({ kind: 'INDEXING', id: 'index improvement', gain: NOT('no row measures a query or index improvement\'s effect on accepted output'), cost: ok(0) });
  return out;
}

export function buildStageLimitReport(input: {
  since: string;
  until: string;
  hours: number;
  routes: RouteWindowReading[];
  recorded: RecordedStageCapacity | null;
  retriesByStage: ReadonlyMap<string, number>;
  utilization: Measured<number>;
  cpu: Measured<number>;
}): StageLimitReport {
  const report = input.recorded?.report ?? null;
  const domains = new Map<string, { domain: string; routes: number; recordsConsidered: number; acceptedFacts: number }>();
  let pulls = 0;
  let failed = 0;
  let acquired = 0;
  let accepted = 0;
  let usable = 0;
  for (const r of input.routes) {
    const d = domains.get(r.domain) ?? { domain: r.domain, routes: 0, recordsConsidered: 0, acceptedFacts: 0 };
    d.routes += 1;
    d.recordsConsidered += r.measures.recordsConsidered.measured ? r.measures.recordsConsidered.value : 0;
    d.acceptedFacts += r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0;
    domains.set(r.domain, d);
    pulls += r.pulls;
    failed += r.failedPulls;
    acquired += r.measures.processedRecords.measured ? r.measures.processedRecords.value : 0;
    accepted += r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0;
    usable += r.measures.candidatesImproved.measured ? r.measures.candidatesImproved.value : 0;
  }
  const dbWaiting = report?.process.dbPool.measured ? ok(report.process.dbPool.value.workloadWaiting) : NOT('no database pool reading');
  const limit = limitingStage({
    accessFailureShare: pulls > 0 ? ok(failed / pulls) : NOT('no pulls in the window'),
    parseCoverage: acquired > 0 ? ok(accepted / acquired) : NOT('nothing acquired in the window'),
    constrainedStage: report?.constrained.stage ?? null,
    dbWaiting,
    cpu: input.cpu,
    commercialShare: accepted > 0 ? ok(usable / accepted) : NOT('nothing accepted in the window'),
  });
  return {
    since: input.since, until: input.until,
    routes: input.routes,
    domains: [...domains.values()],
    pressures: stagePressures(report, input.retriesByStage, input.utilization),
    limit,
    allocation: allocateMarginal(additionOptions(report, input.routes, input.hours)),
    gate: preSpendGate({
      latestHealthy: input.recorded && input.recorded.outcome === 'MEASURED' ? { at: input.recorded.at, stale: input.recorded.stale } : null,
      blockages: blockagesOf(input.recorded),
    }),
  };
}

async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

const parse = (text: string | null): Record<string, unknown> => {
  try {
    return JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Read the stage-limit reading over one window, from rows. Read-only. */
export async function readStageLimit(options: { hours?: number; now?: number } = {}): Promise<StageLimitReport> {
  const hours = options.hours ?? 24;
  const nowMs = options.now ?? Date.now();
  const since = new Date(nowMs - hours * 3_600_000).toISOString();
  const until = new Date(nowMs).toISOString();
  const db = getDb();

  const acqRows = await safely(async () => (await db.all<{ provider: string | null; outcome: string | null; at: string; duration_ms: number | string | null; measures: string | null }>(
    `SELECT provider, outcome, at, duration_ms, measures FROM bin_events WHERE event_type = 'FEED_ACQUISITION' AND at >= ? AND at <= ?`,
    [since, until],
  )).map((r): AcquisitionRow => {
    const m = parse(r.measures);
    return {
      source: r.provider ?? 'unknown', outcome: r.outcome ?? '', at: r.at,
      corpus: typeof m.corpus === 'string' ? m.corpus : null,
      fetched: n(m.fetched), inserted: n(m.inserted),
      bytes: typeof m.bytes === 'number' ? m.bytes : null,
      durationMs: r.duration_ms === null ? null : n(r.duration_ms),
    };
  }), [] as AcquisitionRow[]);
  const seenBefore = new Set(await safely(async () => (await db.all<{ provider: string | null }>(
    `SELECT DISTINCT provider FROM bin_events WHERE event_type = 'FEED_ACQUISITION' AND at < ?`, [since],
  )).map((r) => r.provider ?? ''), [] as string[]));
  const yields = await safely(() => readSourceYields(since, until), [] as SourceYield[]);

  const retriesByStage = new Map<string, number>();
  const retryRows = await safely(() => db.all<{ workload_class: string | null; k: number | string }>(
    `SELECT workload_class, COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND outcome <> 'SUBMITTED' GROUP BY workload_class`, [since],
  ), [] as { workload_class: string | null; k: number | string }[]);
  for (const row of retryRows) {
    const stage = STAGES.find((s) => s.workTypes.includes(row.workload_class ?? ''));
    if (stage) retriesByStage.set(stage.id, (retriesByStage.get(stage.id) ?? 0) + n(row.k));
  }
  const pools = await safely(() => db.all<{ reason: string | null; measures: string | null }>(
    `SELECT e.reason, e.measures FROM bin_events e WHERE e.event_type = 'FREE_LANE_CAPACITY' AND e.workload_class IS NOT NULL
        AND e.at = (SELECT MAX(x.at) FROM bin_events x WHERE x.event_type = 'FREE_LANE_CAPACITY' AND x.workload_class = e.workload_class)`,
  ), [] as { reason: string | null; measures: string | null }[]);
  let slots = 0;
  let busy = 0;
  let cpu: Measured<number> = NOT('no capacity row carries a CPU reading');
  for (const p of pools) {
    const target = /->\s*(\d+)/.exec(p.reason ?? '')?.[1];
    const m = parse(p.measures);
    if (target !== undefined && typeof m.busy === 'number') { slots += Number(target); busy += m.busy; }
    if (typeof m.cpu === 'number') cpu = ok(Math.max(cpu.measured ? cpu.value : 0, m.cpu));
  }
  const utilization: Measured<number> = slots > 0 ? ok(round(busy / slots)) : NOT('no capacity row carries a target and busy count');
  const recorded = await safely(() => readStageCapacity(nowMs), null as RecordedStageCapacity | null);

  return buildStageLimitReport({
    since, until, hours,
    routes: routeWindowReadings({ since, until, rows: acqRows, seenBefore, yields }),
    recorded, retriesByStage, utilization, cpu,
  });
}

/** Measure and record one `STAGE_LIMIT` row. Background only. */
export async function recordStageLimit(
  now: Date = new Date(),
  record: typeof recordBinEvent = recordBinEvent,
  read: (options: { now: number }) => Promise<StageLimitReport> = (o) => readStageLimit(o),
): Promise<StageLimitReport> {
  const report = await read({ now: now.getTime() });
  await record({
    eventType: STAGE_LIMIT_EVENT,
    workloadClass: 'capacity',
    outcome: report.limit.kind,
    reason: `${report.limit.kind}: ${report.limit.basis}. ${report.limit.remedy} Spend gate: ${report.gate.decision}. ${report.allocation.basis}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: report as unknown as Record<string, unknown>,
  });
  return report;
}
