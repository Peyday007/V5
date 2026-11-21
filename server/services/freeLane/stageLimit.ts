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
import { median, readRouteAttribution, type RouteAttribution } from '../feeds/acquisitionMeasures.ts';
import { boundMeasures, readStageCapacity, STAGES, type Measured, type RecordedStageCapacity, type StageCapacityReport } from './stageCapacity.ts';

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
  /**
   * Pulls whose body reached the route's parser, and how many it read
   * (`SourceYield.parseAttempts` / `parsed`); null when no yield read them.
   * Parse success, never the screen's accepted share.
   */
  parse?: { attempts: number; parsed: number } | null;
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
const EMPTY_ATTRIBUTION: RouteAttribution = {
  source: '', bytes: 0, acceptedEvidence: 0, verifiedLinks: 0, economicRelationships: 0, correctedContradictions: 0,
  variablesResolved: 0, minutesToGoalImpact: [], minutesToPlan: [], revenueCents: 0, computeDollars: 0,
};

/** The operator's storage unit price, in whole currency units per GB-month; null when unset or unreadable. */
export function storageUnitPrice(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['BRAIN_STORAGE_COST_PER_GB_MONTH'];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function routeWindowReadings(input: {
  since: string;
  until: string;
  rows: readonly AcquisitionRow[];
  /** Routes that had any acquisition row before `since`. */
  seenBefore: ReadonlySet<string>;
  yields: readonly SourceYield[];
  /**
   * What each route's records led to downstream (`readRouteAttribution`).
   * Absent when it could not be read, and then each attributed measure says so.
   */
  attribution?: ReadonlyMap<string, RouteAttribution> | null;
  /** The operator's storage unit price (`BRAIN_STORAGE_COST_PER_GB_MONTH`); null when none is configured. */
  storagePerGbMonth?: number | null;
}): RouteWindowReading[] {
  const windowMonths = Math.max(0, Date.parse(input.until) - Date.parse(input.since)) / (30 * 86_400_000);
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
    const a = input.attribution === undefined || input.attribution === null ? null : (input.attribution.get(g.route) ?? EMPTY_ATTRIBUTION);
    const unread = NOT('the route\'s downstream attribution (claims, path facts, openings, blueprint facts) could not be read');
    const attributed = (read: (x: RouteAttribution) => number): Measured<number> => (a ? ok(read(a)) : unread);
    const toPlan = a ? median(a.minutesToPlan) : null;
    const measures: RouteWindowMeasures = {
      newRelevantSources: ok(input.seenBefore.has(g.route) ? 0 : 1),
      recordsConsidered: ok(g.fetched),
      recordsNewlyFetched: ok(g.inserted),
      // Bytes the pull rows carry when they carry them; otherwise the bytes of the records the route stored.
      bytes: g.bytesSeen > 0 ? ok(g.bytes) : a ? ok(a.bytes) : notOnRow('raw bytes'),
      transferMs: g.msSeen > 0 ? ok(g.ms) : notOnRow('transfer time'),
      processedRecords: y ? ok(y.acquired) : NOT('no source-yield reading for the route in the window'),
      deduplicatedRecords: ok(Math.max(0, g.fetched - g.inserted)),
      acceptedFacts: y ? ok(y.accepted) : NOT('no source-yield reading for the route in the window'),
      evidenceQuality: y && y.acquired > 0 ? ok(round(y.accepted / y.acquired)) : NOT('nothing acquired to judge'),
      economicRelationships: attributed((x) => x.economicRelationships),
      correctedContradictions: attributed((x) => x.correctedContradictions),
      variablesResolved: attributed((x) => x.variablesResolved),
      candidatesImproved: y ? ok(y.usable) : NOT('no source-yield reading for the route in the window'),
      minutesSourceChangeToPlan: !a ? unread : toPlan === null ? NOT('no blueprint fact cites a record the route stored in the window yet') : ok(toPlan),
      // The application server is a fixed cost no route changes; what a route is billed for is its screens' share of GPU pod time.
      computeCost: !a ? unread : a.computeDollars === null ? NOT('the GPU pod ran while RunPod returned no price for part of it, so the route\'s compute dollars are not known') : ok(a.computeDollars),
      apiCost: ok(0),
      storageCost: !a ? unread
        : input.storagePerGbMonth === null || input.storagePerGbMonth === undefined ? NOT('no storage unit price is configured (BRAIN_STORAGE_COST_PER_GB_MONTH), so stored bytes cannot be priced')
        : ok(round((a.bytes / 1024 ** 3) * input.storagePerGbMonth * windowMonths)),
    };
    const parse = y && typeof y.parseAttempts === 'number' ? { attempts: y.parseAttempts, parsed: y.parsed ?? 0 } : null;
    return { domain: g.domain, route: g.route, since: input.since, until: input.until, pulls: g.pulls, failedPulls: g.failed, parse, measures };
  });
}

// ---------------------------------------------------------------------------
// Per stage: queue depth, utilization, retries, backpressure.

/** One free-lane attempt on a work item, as its FREE_LANE_ITEM row records it. */
export interface LaneAttempt {
  workItemId: string;
  workloadClass: string | null;
  at: string;
}

/**
 * Retries per stage: an attempt on a work item the lane had already attempted
 * (earlier in the window, or before it — `attemptedBefore`). A first attempt
 * is not a retry whatever its outcome, and a failed attempt that is never
 * tried again is a failure, not a retry. An attempt without a work item cannot
 * be told from a first one and is not counted. Pure.
 */
export function retriesByStageOf(attempts: readonly LaneAttempt[], attemptedBefore: ReadonlySet<string>): Map<string, number> {
  const seen = new Set(attemptedBefore);
  const out = new Map<string, number>();
  for (const a of [...attempts].sort((x, y) => x.at.localeCompare(y.at))) {
    if (!a.workItemId) continue;
    if (seen.has(a.workItemId)) {
      const stage = STAGES.find((s) => s.workTypes.includes(a.workloadClass ?? ''));
      if (stage) out.set(stage.id, (out.get(stage.id) ?? 0) + 1);
    }
    seen.add(a.workItemId);
  }
  return out;
}

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
  /** Parse success: pulls whose body reached a parser that the parser read. Never the screen's accepted share. */
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
  if (s.parseCoverage.measured && s.parseCoverage.value < 0.25) return verdict('PARSING', `the parser read ${Math.round(s.parseCoverage.value * 100)}% of the pulls whose body reached it`);
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
  /**
   * Accepted, commercially useful output per hour one more of this would add,
   * measured from an addition of the same kind that already ran — never an
   * extrapolation of what an addition that does not exist would do.
   */
  gain: Measured<number>;
  /**
   * Its ongoing cost per hour, in dollars, as rows recorded it. A code path is
   * not assumed to be free: it consumes compute and storage, and until a row
   * prices them its cost is unmeasured.
   */
  cost: Measured<number>;
  /**
   * True when one more of this is more model capacity: an LLM job, or a
   * free-lane slot (a slot runs model calls). Defaults to `kind === 'LLM_JOB'`.
   * The LLM-versus-non-LLM comparison S-0362 requires counts only options for
   * which this is false as the non-LLM side.
   */
  modelCapacity?: boolean;
}

/** Whether an option adds model capacity (an LLM job, or a slot that runs model calls). Pure. */
export function isModelCapacity(o: Pick<AdditionOption, 'kind' | 'modelCapacity'>): boolean {
  return o.modelCapacity ?? o.kind === 'LLM_JOB';
}

export interface Allocation {
  chosen: AdditionOption | null;
  /**
   * Measured options, best first. `gainPerCost` is accepted output per dollar,
   * or null for an option whose measured cost is $0 (those are ranked by gain
   * among themselves, ahead of priced options — never by an infinite ratio).
   */
  ranked: { kind: AdditionKind; id: string; gain: number; cost: number; gainPerCost: number | null }[];
  unmeasured: { kind: AdditionKind; id: string; reason: string }[];
  /**
   * True when model capacity (an LLM job or a model slot) and at least one
   * option that needs no model call (an algorithm, connector or index) were
   * both measured and compared. A free-lane slot is model capacity, never the non-LLM side.
   */
  comparedLlmWithNonLlm: boolean;
  basis: string;
}

/**
 * Order two measured options by marginal gain against cost. A measured $0
 * (recorded, never assumed) dominates any priced option with a gain, and two
 * $0 options are ordered by their gain; priced options by gain per dollar.
 * No score is infinite, so every kind — an LLM job included — can win on its
 * measurements. Ties prefer the non-LLM option (it needs no model call).
 */
function compareOptions(a: AdditionOption & { gain: { measured: true; value: number }; cost: { measured: true; value: number } }, b: typeof a): number {
  const freeA = a.cost.value <= 0 && a.gain.value > 0;
  const freeB = b.cost.value <= 0 && b.gain.value > 0;
  if (freeA !== freeB) return freeA ? -1 : 1;
  const score = (o: typeof a): number => (freeA ? o.gain.value : o.cost.value > 0 ? o.gain.value / o.cost.value : 0);
  return score(b) - score(a)
    || Number(isModelCapacity(a)) - Number(isModelCapacity(b))
    || a.id.localeCompare(b.id);
}

/**
 * Compare another LLM job with another algorithm, worker, connector or indexing
 * improvement and pick the larger measured marginal gain per cost. An option
 * whose gain or cost is unmeasured is listed with the reason and never chosen. Pure.
 */
export function allocateMarginal(options: readonly AdditionOption[]): Allocation {
  type MeasuredOption = AdditionOption & { gain: { measured: true; value: number }; cost: { measured: true; value: number } };
  const unmeasured: Allocation['unmeasured'] = [];
  const measured: MeasuredOption[] = [];
  for (const o of options) {
    if (!o.gain.measured) unmeasured.push({ kind: o.kind, id: o.id, reason: o.gain.reason });
    else if (!o.cost.measured) unmeasured.push({ kind: o.kind, id: o.id, reason: o.cost.reason });
    else if (!Number.isFinite(o.gain.value) || !Number.isFinite(o.cost.value) || o.cost.value < 0) {
      unmeasured.push({ kind: o.kind, id: o.id, reason: `gain ${o.gain.value} or cost ${o.cost.value} is not a finite, non-negative measurement` });
    } else measured.push(o as MeasuredOption);
  }
  measured.sort(compareOptions);
  const best = measured.find((m) => m.gain.value > 0) ?? null;
  const compared = measured.some((m) => isModelCapacity(m)) && measured.some((m) => !isModelCapacity(m));
  return {
    chosen: best,
    ranked: measured.map((m) => ({
      kind: m.kind, id: m.id, gain: m.gain.value, cost: m.cost.value,
      gainPerCost: m.cost.value > 0 ? round(m.gain.value / m.cost.value) : null,
    })),
    unmeasured,
    comparedLlmWithNonLlm: compared,
    basis: best
      ? `${best.kind} ${best.id} adds the most accepted output per cost${compared ? ' (model capacity and an option that needs no model call were both measured)' : ''}.`
      : 'No option has a measured positive gain at a measured cost; add nothing.',
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
  /** The added capacity the before/after pair is measured around. */
  change?: CapacityChange | null;
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
  const which = input.change ? ` after ${input.change.model} grew ${input.change.from} -> ${input.change.to} at ${input.change.at}` : '';
  if (typeof input.usefulBefore === 'number' && typeof input.usefulAfter === 'number') {
    return input.usefulAfter > input.usefulBefore
      ? { ...base, decision: 'GAIN_VERIFIED', reason: `Accepted useful output rose from ${input.usefulBefore} to ${input.usefulAfter}${which}.`, measureAfter: null }
      : { ...base, decision: 'NO_GAIN_REVERT', reason: `Accepted useful output did not rise (${input.usefulBefore} -> ${input.usefulAfter})${which}; the added capacity is not earning, revert it.`, measureAfter: null };
  }
  return {
    ...base, decision: 'ALLOW_THEN_MEASURE',
    reason: `No reversible blockage in the latest healthy reading.${input.change ? ` The growth of ${input.change.model} at ${input.change.at} is still inside its after-window.` : ''}`,
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
  /** The latest capacity growth the gate measured after, or null when none was recorded in the lookback. */
  capacityChange: MeasuredChange | null;
}

/**
 * A set of routes' ongoing cost per hour, from what their rows priced. Every
 * cost component of every route must be measured; one that is not makes the
 * total unmeasured, with that route's reason. Pure.
 */
export function routesCostPerHour(routes: readonly RouteWindowReading[], hours: number): Measured<number> {
  if (routes.length === 0) return NOT('no route to price');
  let dollars = 0;
  for (const r of routes) {
    for (const key of ['computeCost', 'apiCost', 'storageCost'] as const) {
      const m = r.measures[key];
      if (!m.measured) return NOT(`${r.route}'s ${key} is not measured: ${m.reason}`);
      dollars += m.value;
    }
  }
  return ok(round(dollars / Math.max(1, hours)));
}

/**
 * The addition options the rows can measure: one more LLM job against one more
 * code path of each kind. A gain is the measured contribution of an addition of
 * that kind that actually ran in the window, and a cost is what the rows
 * priced; anything else is unmeasured with its reason — never extrapolated
 * from a different component, and never a code path assumed to cost $0. Pure.
 */
export function additionOptions(
  report: StageCapacityReport | null,
  routes: readonly RouteWindowReading[],
  hours: number,
  algorithms: AlgorithmAdditions | null = null,
): AdditionOption[] {
  const out: AdditionOption[] = [];
  const interp = report?.stages.find((s) => s.stage === 'model-interpretation');
  if (interp && interp.itemsProcessedPerHour.measured && interp.itemsProcessedPerHour.value > 0) {
    // One more job per hour adds the accepted output a job measurably yields, at what a job measurably cost.
    const perJob = interp.acceptedPerHour / interp.itemsProcessedPerHour.value;
    out.push({ kind: 'LLM_JOB', id: 'model-interpretation', gain: ok(round(perJob)), cost: interp.incrementalDollars.measured ? ok(round(interp.incrementalDollars.value / Math.max(1, interp.itemsProcessedPerHour.value * hours))) : interp.incrementalDollars });
  } else {
    out.push({ kind: 'LLM_JOB', id: 'model-interpretation', gain: NOT('the interpretation stage processed nothing measured in the window'), cost: NOT('no reading') });
  }
  // Another connector: what the connectors first pulled in this window measurably added — not the best existing route's rate.
  const added = routes.filter((r) => r.measures.newRelevantSources.measured && r.measures.newRelevantSources.value > 0);
  if (added.length === 0) {
    out.push({ kind: 'SOURCE_CONNECTOR', id: 'connector', gain: NOT('no connector was added in the window, so the gain of one more is not measured'), cost: NOT('no connector was added in the window to price') });
  } else {
    const ids = `added: ${added.map((r) => r.route).sort().join(', ')}`;
    const unread = added.find((r) => !r.measures.acceptedFacts.measured);
    const accepted = added.reduce((t, r) => t + (r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0), 0);
    out.push({
      kind: 'SOURCE_CONNECTOR', id: ids,
      gain: unread && !unread.measures.acceptedFacts.measured
        ? NOT(`${unread.route}'s accepted facts are not measured: ${unread.measures.acceptedFacts.reason}`)
        : ok(round(accepted / added.length / Math.max(1, hours))),
      cost: (() => {
        const c = routesCostPerHour(added, hours);
        return c.measured ? ok(round(c.value / added.length)) : c;
      })(),
    });
  }
  // A code algorithm: what the detector rule versions added in the lookback measurably produced since they were added.
  out.push(algorithmOption(algorithms));
  // A free-lane slot runs model calls: it is model capacity, never the non-LLM side of the comparison.
  out.push({ kind: 'WORKER', id: 'free-lane slot', modelCapacity: true, gain: report?.constrained.expectedGain.measured ? ok(round(report.constrained.expectedGain.value.acceptedFactsPerHour)) : NOT(report?.constrained.expectedGain.measured === false ? report.constrained.expectedGain.reason : 'no recorded stage-capacity reading'), cost: report?.constrained.expectedGain.measured ? ok(round(report.constrained.expectedGain.value.dollars)) : NOT('no reading') });
  out.push({ kind: 'INDEXING', id: 'index improvement', gain: NOT('no row measures a query or index improvement\'s effect on accepted output'), cost: NOT('no row records an index improvement\'s cost') });
  return out;
}

/**
 * One code-rule (detector) version, read from its `feed_detections` rows: when
 * it first detected anything (its addition), whether it ran ACTIVE, the leads
 * its detections became, and the bytes its rows hold.
 */
export interface AlgorithmAddition {
  ruleId: string;
  ruleVersion: number;
  /** ACTIVE when any of its detections ran ACTIVE; a SHADOW rule changes nothing downstream. */
  mode: string;
  /** Its first detection: when this version was added. */
  addedAt: string;
  /** Detections that became a lead: accepted output a model call did not produce. */
  leads: number;
  /** Bytes its detection rows store. */
  bytes: number;
}

export interface AlgorithmAdditions {
  additions: readonly AlgorithmAddition[];
  nowMs: number;
  /** The operator's storage unit price; null when none is configured. */
  storagePerGbMonth: number | null;
}

/** How far back a rule version's first detection counts as a recent addition. */
export const ALGORITHM_ADDITION_LOOKBACK_MS = 7 * 24 * 3_600_000;

/**
 * Another code algorithm, priced from the rule versions that were actually
 * added: each ACTIVE version first detecting within the lookback contributes
 * its leads per hour since it was added (its own measured output, never an
 * extrapolation from unread records), and its cost is what its rows measurably
 * consume. A rule runs inside the feed tick on the application server, a fixed
 * cost no rule changes, and calls no model, GPU or provider, so the only
 * dollars it adds are the storage of its rows, priced at the operator's unit
 * price; unpriced storage leaves the cost unmeasured, never assumed $0. Pure.
 */
export function algorithmOption(input: AlgorithmAdditions | null): AdditionOption {
  const kind = 'ALGORITHM' as const;
  if (!input) return { kind, id: 'code rule', gain: NOT('the detector rule rows could not be read'), cost: NOT('the detector rule rows could not be read') };
  const from = input.nowMs - ALGORITHM_ADDITION_LOOKBACK_MS;
  const recent = input.additions.filter((a) => {
    const at = Date.parse(a.addedAt);
    return Number.isFinite(at) && at >= from && at <= input.nowMs;
  });
  const active = recent.filter((a) => a.mode === 'ACTIVE');
  if (active.length === 0) {
    const reason = recent.length > 0
      ? `the rule versions added in the last 7 days (${recent.map((a) => `${a.ruleId}@${a.ruleVersion}`).sort().join(', ')}) ran SHADOW, which changes nothing downstream, so the gain of one more is not measured`
      : 'no detector rule version was added in the last 7 days, so the gain of one more is not measured';
    return { kind, id: 'code rule', gain: NOT(reason), cost: NOT(reason) };
  }
  const id = `added: ${active.map((a) => `${a.ruleId}@${a.ruleVersion}`).sort().join(', ')}`;
  const hoursLive = (a: AlgorithmAddition): number => Math.max(1, (input.nowMs - Date.parse(a.addedAt)) / 3_600_000);
  const gain = active.reduce((t, a) => t + a.leads / hoursLive(a), 0) / active.length;
  const price = input.storagePerGbMonth;
  const cost: Measured<number> = price === null || !Number.isFinite(price) || price < 0
    ? NOT('no storage unit price is configured (BRAIN_STORAGE_COST_PER_GB_MONTH), so the rule rows\' storage cannot be priced')
    : ok(round(active.reduce((t, a) => t + (a.bytes / 1024 ** 3) * price / (30 * 24), 0) / active.length, 8));
  return { kind, id, gain: ok(round(gain)), cost };
}

/** One recorded growth of a lane model's slots (`FREE_LANE_CAPACITY` GROW, "a -> b: …"). */
export interface CapacityChange {
  model: string;
  at: string;
  from: number;
  to: number;
}

/** The equal windows either side of a capacity change that the after-measurement compares. */
export const POST_CHANGE_WINDOW_MS = 6 * 3_600_000;
/** How far back the latest growth is looked for; an older one has been judged already. */
export const POST_CHANGE_LOOKBACK_MS = 7 * 24 * 3_600_000;

/** A GROW row as a capacity change, or null when its reason does not state "a -> b". Pure. */
export function capacityChangeOf(row: { workload_class: string | null; at: string; reason: string | null }): CapacityChange | null {
  const m = /^\s*(\d+)\s*->\s*(\d+)/.exec(row.reason ?? '');
  if (!m || !row.workload_class) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return to > from ? { model: row.workload_class, at: row.at, from, to } : null;
}

/**
 * The before and after windows of one change: equal, adjacent at the change.
 * Null until the after window has fully elapsed — a partial window would
 * compare less time after the change with a full one before it. Pure.
 */
export function postChangeWindows(change: Pick<CapacityChange, 'at'>, nowMs: number, windowMs = POST_CHANGE_WINDOW_MS): { before: [string, string]; after: [string, string] } | null {
  const at = Date.parse(change.at);
  if (!Number.isFinite(at) || at + windowMs > nowMs) return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { before: [iso(at - windowMs), iso(at)], after: [iso(at), iso(at + windowMs)] };
}

/** The latest added capacity and the accepted output either side of it, as the gate reads it. */
export interface MeasuredChange {
  change: CapacityChange;
  /** Null while the after window is still open. */
  usefulBefore: number | null;
  usefulAfter: number | null;
  windowHours: number;
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
  /** The latest capacity growth and the accepted output measured either side of it. */
  change?: MeasuredChange | null;
  /** The detector rule versions recently added, priced as the ALGORITHM option; null when unread. */
  algorithms?: AlgorithmAdditions | null;
}): StageLimitReport {
  const report = input.recorded?.report ?? null;
  const domains = new Map<string, { domain: string; routes: number; recordsConsidered: number; acceptedFacts: number }>();
  let pulls = 0;
  let failed = 0;
  let accepted = 0;
  let usable = 0;
  let parseAttempts = 0;
  let parsed = 0;
  for (const r of input.routes) {
    if (r.parse) { parseAttempts += r.parse.attempts; parsed += r.parse.parsed; }
    const d = domains.get(r.domain) ?? { domain: r.domain, routes: 0, recordsConsidered: 0, acceptedFacts: 0 };
    d.routes += 1;
    d.recordsConsidered += r.measures.recordsConsidered.measured ? r.measures.recordsConsidered.value : 0;
    d.acceptedFacts += r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0;
    domains.set(r.domain, d);
    pulls += r.pulls;
    failed += r.failedPulls;
    accepted += r.measures.acceptedFacts.measured ? r.measures.acceptedFacts.value : 0;
    usable += r.measures.candidatesImproved.measured ? r.measures.candidatesImproved.value : 0;
  }
  const dbWaiting = report?.process.dbPool.measured ? ok(report.process.dbPool.value.workloadWaiting) : NOT('no database pool reading');
  const limit = limitingStage({
    accessFailureShare: pulls > 0 ? ok(failed / pulls) : NOT('no pulls in the window'),
    // Parse success: the pulls whose body reached a parser that the parser read. The screen's
    // KEEP share (accepted / acquired) is commercial relevance, never parsing (S-0362).
    parseCoverage: parseAttempts > 0 ? ok(parsed / parseAttempts) : NOT('no pull delivered a body to a parser in the window'),
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
    allocation: allocateMarginal(additionOptions(report, input.routes, input.hours, input.algorithms ?? null)),
    gate: preSpendGate({
      latestHealthy: input.recorded && input.recorded.outcome === 'MEASURED' ? { at: input.recorded.at, stale: input.recorded.stale } : null,
      blockages: blockagesOf(input.recorded),
      usefulBefore: input.change?.usefulBefore ?? null,
      usefulAfter: input.change?.usefulAfter ?? null,
      change: input.change?.change ?? null,
    }),
    capacityChange: input.change ?? null,
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

/**
 * The latest recorded growth of a lane model's slots within the lookback, and
 * the lane's accepted output (`FREE_LANE_ITEM` SUBMITTED) over equal windows
 * before and after it — S-0363's "measure whether the added capacity actually
 * increases accepted and commercially useful output", from the rows the
 * capacity controller and the lane already write. Read-only.
 */
export async function readMeasuredChange(nowMs: number, windowMs = POST_CHANGE_WINDOW_MS): Promise<MeasuredChange | null> {
  const db = getDb();
  const rows = await db.all<{ workload_class: string | null; at: string; reason: string | null }>(
    `SELECT workload_class, at, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND outcome = 'GROW' AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 20`,
    [new Date(nowMs - POST_CHANGE_LOOKBACK_MS).toISOString(), new Date(nowMs).toISOString()],
  );
  const change = rows.map(capacityChangeOf).find((one): one is CapacityChange => one !== null) ?? null;
  if (!change) return null;
  const windows = postChangeWindows(change, nowMs, windowMs);
  const windowHours = round(windowMs / 3_600_000, 2);
  if (!windows) return { change, usefulBefore: null, usefulAfter: null, windowHours };
  const accepted = async ([from, to]: [string, string]): Promise<number> =>
    n((await db.get<{ k: number | string }>(
      `SELECT COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED' AND at >= ? AND at < ?`,
      [from, to],
    ))?.k);
  return { change, usefulBefore: await accepted(windows.before), usefulAfter: await accepted(windows.after), windowHours };
}

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
  const attribution = await safely(() => readRouteAttribution(since, until), null as Map<string, RouteAttribution> | null);

  const attemptRows = await safely(() => db.all<{ work_item_id: string | null; workload_class: string | null; at: string }>(
    `SELECT work_item_id, workload_class, at FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at <= ? AND work_item_id IS NOT NULL`,
    [since, until],
  ), [] as { work_item_id: string | null; workload_class: string | null; at: string }[]);
  const windowItems = [...new Set(attemptRows.map((r) => r.work_item_id).filter((id): id is string => Boolean(id)))];
  const attemptedBefore = new Set<string>();
  for (let i = 0; i < windowItems.length; i += 500) {
    const chunk = windowItems.slice(i, i + 500);
    const prior = await safely(() => db.all<{ work_item_id: string | null }>(
      `SELECT DISTINCT work_item_id FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at < ? AND work_item_id IN (${chunk.map(() => '?').join(', ')})`,
      [since, ...chunk],
    ), [] as { work_item_id: string | null }[]);
    for (const r of prior) if (r.work_item_id) attemptedBefore.add(r.work_item_id);
  }
  const retriesByStage = retriesByStageOf(
    attemptRows.map((r) => ({ workItemId: r.work_item_id ?? '', workloadClass: r.workload_class, at: r.at })),
    attemptedBefore,
  );
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
  const change = await safely(() => readMeasuredChange(nowMs), null as MeasuredChange | null);
  const additions = await safely(() => readAlgorithmAdditions(nowMs), null as AlgorithmAddition[] | null);
  const storagePerGbMonth = storageUnitPrice();

  return buildStageLimitReport({
    since, until, hours,
    routes: routeWindowReadings({ since, until, rows: acqRows, seenBefore, yields, attribution, storagePerGbMonth: storageUnitPrice() }),
    recorded, retriesByStage, utilization, cpu, change,
    algorithms: additions === null ? null : { additions, nowMs, storagePerGbMonth },
  });
}

/** The detector rule versions whose first detection falls in the lookback, from `feed_detections`. Read-only. */
export async function readAlgorithmAdditions(nowMs: number, lookbackMs = ALGORITHM_ADDITION_LOOKBACK_MS): Promise<AlgorithmAddition[]> {
  const from = new Date(nowMs - lookbackMs).toISOString();
  const rows = await getDb().all<{ rule_id: string; rule_version: number | string; added_at: string; active: number | string; leads: number | string; bytes: number | string | null }>(
    `SELECT rule_id, rule_version, MIN(detected_at) AS added_at,
            SUM(CASE WHEN mode = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN lead_item_id IS NOT NULL THEN 1 ELSE 0 END) AS leads,
            SUM(LENGTH(group_key) + LENGTH(label) + LENGTH(member_ids) + LENGTH(source_urls) + LENGTH(qualifiers) + COALESCE(LENGTH(hypothesis), 0)) AS bytes
       FROM feed_detections
      GROUP BY rule_id, rule_version
     HAVING MIN(detected_at) >= ?`,
    [from],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id, ruleVersion: n(r.rule_version), mode: n(r.active) > 0 ? 'ACTIVE' : 'SHADOW',
    addedAt: r.added_at, leads: n(r.leads), bytes: n(r.bytes),
  }));
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
    measures: storedStageLimit(report),
  });
  return report;
}

/**
 * The reading as one hourly row stores it: routes ordered by accepted facts and
 * domains by records considered, so the routes that carry the window survive
 * the list bound, and every list cut to `boundMeasures`' size with what was cut
 * counted. The full report is still returned to the caller. Pure.
 */
export function storedStageLimit(report: StageLimitReport): Record<string, unknown> {
  const facts = (r: RouteWindowReading): number => (r.measures.acceptedFacts.measured ? n(r.measures.acceptedFacts.value) : -1);
  const routes = report.routes ?? [];
  const domains = report.domains ?? [];
  return boundMeasures({
    ...report,
    routes: [...routes].sort((a, b) => facts(b) - facts(a)),
    domains: [...domains].sort((a, b) => b.recordsConsidered - a.recordsConsidered),
    totals: { routes: routes.length, domains: domains.length },
  } as unknown as Record<string, unknown>);
}
