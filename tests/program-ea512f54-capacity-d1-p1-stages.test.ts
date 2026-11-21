/**
 * CAP-25-2: measure each stage per domain, ingestion route and time window, and
 * remove the limiting one. Every S-0360/S-0361 quantity is present per route as
 * measured or not; each bottleneck kind maps to the remedy the source names and
 * never to a larger server; the allocator compares another LLM job with a
 * non-LLM algorithm, worker, connector or indexing option; the pre-spend gate
 * refuses hardware while a reversible blockage stands and demands a
 * post-change measurement; and the reading is built from real rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  POST_CHANGE_WINDOW_MS,
  REMEDIES,
  ROUTE_MEASURE_KEYS,
  SCALING_OPTIONS,
  STAGE_LIMIT_EVENT,
  additionOptions,
  allocateMarginal,
  blockagesOf,
  capacityChangeOf,
  limitingStage,
  postChangeWindows,
  readMeasuredChange,
  preSpendGate,
  readStageLimit,
  recordStageLimit,
  retriesByStageOf,
  routeWindowReadings,
  stagePressures,
  storageUnitPrice,
  type LimitSignals,
  type RouteWindowReading,
  type StageLimitReport,
} from '../server/services/freeLane/stageLimit.ts';
import { recordStageCapacity, STORED_MEASURES_MAX_BYTES, type RecordedStageCapacity, type StageCapacityReport, type StageReading } from '../server/services/freeLane/stageCapacity.ts';

const ok = (value: number) => ({ measured: true as const, value });
const NOT = (reason: string) => ({ measured: false as const, reason });

const signals = (over: Partial<LimitSignals> = {}): LimitSignals => ({
  accessFailureShare: ok(0), parseCoverage: ok(0.8), constrainedStage: null, dbWaiting: ok(0), cpu: ok(0.2), commercialShare: ok(0.3), ...over,
});

describe('routeWindowReadings', () => {
  it('reports every quantity per (domain, route, window), measured or with a reason', () => {
    const readings = routeWindowReadings({
      since: '2026-11-16T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z',
      rows: [
        { source: 'src-a', outcome: 'OK', at: 'x', corpus: 'domain:any', fetched: 10, inserted: 4, bytes: 2048, durationMs: 300 },
        { source: 'src-a', outcome: 'FAILED', at: 'y', corpus: 'domain:any', fetched: 0, inserted: 0 },
        { source: 'src-b', outcome: 'OK', at: 'z', corpus: 'corpus-x', fetched: 5, inserted: 5 },
      ],
      seenBefore: new Set(['src-b']),
      yields: [{ source: 'src-a', acquired: 4, accepted: 2, usable: 1, acceptedShare: 0.5, usableShare: 0.25, value: 1 }],
    });
    const a = readings.find((r) => r.route === 'src-a')!;
    const b = readings.find((r) => r.route === 'src-b')!;
    expect(a.domain).toBe('domain:any');
    expect(a.measures.newRelevantSources).toEqual(ok(1));
    expect(b.measures.newRelevantSources).toEqual(ok(0));
    expect(a.measures.recordsConsidered).toEqual(ok(10));
    expect(a.measures.deduplicatedRecords).toEqual(ok(6));
    expect(a.measures.bytes).toEqual(ok(2048));
    expect(b.measures.bytes.measured).toBe(false);
    expect(a.measures.acceptedFacts).toEqual(ok(2));
    expect(a.failedPulls).toBe(1);
    for (const r of readings) for (const k of ROUTE_MEASURE_KEYS) expect(r.measures[k]).toHaveProperty('measured');
  });
});

describe('routeWindowReadings attributes the downstream measures to the route (review F6)', () => {
  const window = { since: '2026-11-16T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z' };
  const rows = [
    { source: 'src-a', outcome: 'OK', at: 'x', corpus: 'domain:any', fetched: 10, inserted: 4 },
    { source: 'src-c', outcome: 'OK', at: 'y', corpus: 'domain:any', fetched: 2, inserted: 2 },
  ];
  const attribution = new Map([
    ['src-a', {
      source: 'src-a', bytes: 3 * 1024 ** 3, acceptedEvidence: 5, verifiedLinks: 2, economicRelationships: 3, correctedContradictions: 1,
      variablesResolved: 4, minutesToGoalImpact: [10], minutesToPlan: [30, 90, 60], revenueCents: 0, computeDollars: 1.25,
    }],
  ]);
  const ATTRIBUTED = ['economicRelationships', 'correctedContradictions', 'variablesResolved', 'minutesSourceChangeToPlan', 'computeCost', 'storageCost', 'bytes'] as const;

  it('measures every quantity review F6 named from the attribution rows', () => {
    const [a] = routeWindowReadings({ ...window, rows: rows.slice(0, 1), seenBefore: new Set(), yields: [], attribution, storagePerGbMonth: 0.02 });
    expect(a!.measures.bytes).toEqual(ok(3 * 1024 ** 3));
    expect(a!.measures.economicRelationships).toEqual(ok(3));
    expect(a!.measures.correctedContradictions).toEqual(ok(1));
    expect(a!.measures.variablesResolved).toEqual(ok(4));
    expect(a!.measures.minutesSourceChangeToPlan).toEqual(ok(60));
    expect(a!.measures.computeCost).toEqual(ok(1.25));
    // 3 GB for one day at $0.02 per GB-month.
    expect(a!.measures.storageCost).toEqual(ok(0.002));
  });

  it('reads a route nothing downstream has cited as measured zeros, not unknowns', () => {
    const c = routeWindowReadings({ ...window, rows: rows.slice(1), seenBefore: new Set(), yields: [], attribution, storagePerGbMonth: 0.02 })[0]!;
    expect(c.measures.economicRelationships).toEqual(ok(0));
    expect(c.measures.correctedContradictions).toEqual(ok(0));
    expect(c.measures.variablesResolved).toEqual(ok(0));
    expect(c.measures.computeCost).toEqual(ok(0));
    expect(c.measures.storageCost).toEqual(ok(0));
    expect(c.measures.minutesSourceChangeToPlan.measured).toBe(false);
  });

  it('says which input is missing when attribution or a price is absent, never a guess', () => {
    const none = routeWindowReadings({ ...window, rows: rows.slice(0, 1), seenBefore: new Set(), yields: [], attribution: null })[0]!;
    for (const k of ATTRIBUTED) expect(none.measures[k].measured, k).toBe(false);
    const unpriced = routeWindowReadings({ ...window, rows: rows.slice(0, 1), seenBefore: new Set(), yields: [], attribution, storagePerGbMonth: null })[0]!;
    expect(unpriced.measures.storageCost).toEqual(NOT('no storage unit price is configured (BRAIN_STORAGE_COST_PER_GB_MONTH), so stored bytes cannot be priced'));
    const podUnpriced = routeWindowReadings({ ...window, rows: rows.slice(0, 1), seenBefore: new Set(), yields: [], attribution: new Map([['src-a', { ...attribution.get('src-a')!, computeDollars: null }]]) })[0]!;
    expect(podUnpriced.measures.computeCost.measured).toBe(false);
  });

  it('reads the storage unit price the operator configured, and nothing else', () => {
    expect(storageUnitPrice({ BRAIN_STORAGE_COST_PER_GB_MONTH: '0.023' })).toBe(0.023);
    expect(storageUnitPrice({})).toBeNull();
    expect(storageUnitPrice({ BRAIN_STORAGE_COST_PER_GB_MONTH: 'abc' })).toBeNull();
  });
});

describe('limitingStage maps each bottleneck to the quoted remedy, never a server', () => {
  it.each([
    [signals({ accessFailureShare: ok(0.7) }), 'SOURCE_ACCESS', /access or source selection/],
    [signals({ parseCoverage: ok(0.1) }), 'PARSING', /efficient code workers/],
    [signals({ constrainedStage: 'graph-quant' }), 'RECONCILIATION', /reconciliation more worker\/model capacity/],
    [signals({ constrainedStage: 'evidence-verification' }), 'VERIFICATION', /verification more worker\/model capacity/],
    [signals({ dbWaiting: ok(3) }), 'DATABASE', /isolated processing and measured infrastructure expansion/],
    [signals({ cpu: ok(0.95) }), 'APP_CPU', /isolated processing/],
    [signals({ commercialShare: ok(0.01) }), 'COMMERCIAL_RELEVANCE', /Change the questions, not the server size/],
    [signals(), 'NONE', /add nothing/],
  ] as const)('%#', (s, kind, remedy) => {
    const v = limitingStage(s);
    expect(v.kind).toBe(kind);
    expect(v.remedy).toMatch(remedy);
    expect(v.scaleServer).toBe(false);
  });

  it('no remedy anywhere scales the server', () => {
    for (const r of Object.values(REMEDIES)) expect(r.scaleServer).toBe(false);
  });
});

describe('retriesByStageOf counts re-attempts, not non-submitted items (finding F7)', () => {
  it('a failed first attempt is not a retry; a second attempt on the same item is', () => {
    const r = retriesByStageOf([
      { workItemId: 'w1', workloadClass: 'RESEARCH_FRAGMENT', at: '2026-11-17T01:00:00.000Z' }, // first attempt, failed
      { workItemId: 'w2', workloadClass: 'RESEARCH_FRAGMENT', at: '2026-11-17T01:05:00.000Z' }, // first attempt, never retried
      { workItemId: 'w1', workloadClass: 'RESEARCH_FRAGMENT', at: '2026-11-17T02:00:00.000Z' }, // retry, submitted
      { workItemId: 'w3', workloadClass: 'RESEARCH_AUDIT', at: '2026-11-17T02:10:00.000Z' }, // tried before the window
      { workItemId: '', workloadClass: 'RESEARCH_AUDIT', at: '2026-11-17T02:20:00.000Z' }, // unattributable
    ], new Set(['w3']));
    expect(r.get('model-interpretation')).toBe(1);
    expect(r.get('evidence-verification')).toBe(1);
  });

  it('order of rows does not matter, only their time', () => {
    const r = retriesByStageOf([
      { workItemId: 'w1', workloadClass: 'RESEARCH_PLAN', at: '2026-11-17T03:00:00.000Z' },
      { workItemId: 'w1', workloadClass: 'RESEARCH_PLAN', at: '2026-11-17T01:00:00.000Z' },
      { workItemId: 'w1', workloadClass: 'RESEARCH_PLAN', at: '2026-11-17T02:00:00.000Z' },
    ], new Set());
    expect(r.get('model-interpretation')).toBe(2);
  });
});

describe('allocateMarginal', () => {
  it('compares an LLM job with non-LLM options and picks the larger gain per cost', () => {
    const a = allocateMarginal([
      { kind: 'LLM_JOB', id: 'llm', gain: ok(4), cost: ok(2) },
      { kind: 'ALGORITHM', id: 'parser', gain: ok(1), cost: ok(0) },
      { kind: 'SOURCE_CONNECTOR', id: 'conn', gain: ok(3), cost: ok(1) },
      { kind: 'INDEXING', id: 'idx', gain: NOT('unmeasured'), cost: ok(0) },
    ]);
    expect(a.comparedLlmWithNonLlm).toBe(true);
    expect(a.chosen!.id).toBe('parser');
    expect(a.unmeasured.map((u) => u.id)).toEqual(['idx']);
  });

  it('an LLM job wins when its measured gain per cost is larger', () => {
    const a = allocateMarginal([
      { kind: 'LLM_JOB', id: 'llm', gain: ok(10), cost: ok(1) },
      { kind: 'WORKER', id: 'slot', gain: ok(2), cost: ok(1) },
    ]);
    expect(a.chosen!.kind).toBe('LLM_JOB');
  });

  it('nothing measured means nothing is added', () => {
    expect(allocateMarginal([{ kind: 'LLM_JOB', id: 'llm', gain: NOT('x'), cost: ok(1) }]).chosen).toBeNull();
  });
});

describe('allocateMarginal is not degenerate (finding F3)', () => {
  it('no score is infinite: a $0 option is ranked by gain, and an LLM job at a measured $0 can win', () => {
    const a = allocateMarginal([
      { kind: 'LLM_JOB', id: 'llm', gain: ok(5), cost: ok(0) },
      { kind: 'WORKER', id: 'slot', gain: ok(2), cost: ok(0) },
      { kind: 'SOURCE_CONNECTOR', id: 'conn', gain: ok(9), cost: ok(1) },
    ]);
    expect(a.chosen!.kind).toBe('LLM_JOB');
    for (const r of a.ranked) expect(r.gainPerCost === null || Number.isFinite(r.gainPerCost)).toBe(true);
    expect(a.ranked.find((r) => r.id === 'llm')!.gainPerCost).toBeNull();
    expect(a.ranked.find((r) => r.id === 'conn')!.gainPerCost).toBe(9);
  });

  it('an LLM job beats priced non-LLM options on gain per dollar', () => {
    const a = allocateMarginal([
      { kind: 'LLM_JOB', id: 'llm', gain: ok(6), cost: ok(1) },
      { kind: 'SOURCE_CONNECTOR', id: 'conn', gain: ok(3), cost: ok(1) },
      { kind: 'ALGORITHM', id: 'parser', gain: ok(1), cost: ok(0.5) },
    ]);
    expect(a.chosen!.kind).toBe('LLM_JOB');
    expect(a.comparedLlmWithNonLlm).toBe(true);
  });

  const route = (name: string, isNew: boolean, accepted: number): RouteWindowReading => ({
    domain: 'd', route: name, since: 's', until: 'u', pulls: 1, failedPulls: 0,
    measures: {
      newRelevantSources: ok(isNew ? 1 : 0), recordsConsidered: ok(100), recordsNewlyFetched: ok(50), bytes: NOT('x'), transferMs: NOT('x'),
      processedRecords: ok(100), deduplicatedRecords: ok(50), acceptedFacts: ok(accepted), evidenceQuality: ok(0.5),
      economicRelationships: NOT('x'), correctedContradictions: NOT('x'), variablesResolved: NOT('x'), candidatesImproved: ok(1),
      minutesSourceChangeToPlan: NOT('x'), computeCost: NOT('feed pulls record no CPU time'), apiCost: ok(0), storageCost: NOT('x'),
    },
  });
  const interpReport = {
    stages: [stage('model-interpretation', { itemsProcessedPerHour: ok(10), acceptedPerHour: 4, incrementalDollars: ok(12) })],
    constrained: { stage: 'model-interpretation', basis: 'b', expectedGain: { measured: true, value: { acceptedFactsPerHour: 1, dollars: 2 } }, recommendation: 'r' },
  } as unknown as StageCapacityReport;

  it('code paths are never assumed to cost $0 and gains are never extrapolated', () => {
    const opts = additionOptions(interpReport, [route('existing-big', false, 900)], 6);
    const byKind = new Map(opts.map((o) => [o.kind, o]));
    // No connector was added in the window: the best existing route is not a measured marginal gain.
    expect(byKind.get('SOURCE_CONNECTOR')!.gain.measured).toBe(false);
    // Unread records converting at the accepted share is an extrapolation.
    expect(byKind.get('ALGORITHM')!.gain.measured).toBe(false);
    for (const o of opts) if (o.kind !== 'LLM_JOB' && o.kind !== 'WORKER') expect(o.cost.measured).toBe(false);
    const a = allocateMarginal(opts);
    // The LLM job (0.4 accepted/job at $0.2/job = 2/$) and the worker slot (1/h at $2/h = 0.5/$) are measured; the LLM wins.
    // A free-lane slot runs model calls, so LLM-vs-slot is not an LLM-vs-non-LLM comparison (finding F3).
    expect(a.comparedLlmWithNonLlm).toBe(false);
    expect(a.chosen!.kind).toBe('LLM_JOB');
    expect(a.unmeasured.map((u) => u.kind).sort()).toEqual(['ALGORITHM', 'INDEXING', 'SOURCE_CONNECTOR']);
  });

  it('a connector added in the window has a measured gain, and stays unchosen until its cost is priced', () => {
    const opts = additionOptions(interpReport, [route('existing-big', false, 900), route('new-src', true, 12)], 6);
    const conn = opts.find((o) => o.kind === 'SOURCE_CONNECTOR')!;
    expect(conn.id).toBe('added: new-src');
    expect(conn.gain).toEqual(ok(2));
    expect(conn.cost.measured).toBe(false);
    expect(allocateMarginal(opts).unmeasured.some((u) => u.kind === 'SOURCE_CONNECTOR')).toBe(true);
  });
});

describe('preSpendGate', () => {
  const healthy = { at: '2026-11-17T00:00:00.000Z', stale: false };
  it('refuses hardware while a reversible blockage stands', () => {
    const g = preSpendGate({ latestHealthy: healthy, blockages: [{ kind: 'UNAVAILABLE_MODEL', reversible: true, detail: 'route x: credentials' }] });
    expect(g.decision).toBe('REFUSE_REMOVE_BLOCKAGE_FIRST');
  });
  it('refuses without a current healthy reading', () => {
    expect(preSpendGate({ latestHealthy: null, blockages: [] }).decision).toBe('REFUSE_NO_HEALTHY_READING');
    expect(preSpendGate({ latestHealthy: { ...healthy, stale: true }, blockages: [] }).decision).toBe('REFUSE_NO_HEALTHY_READING');
  });
  it('allows only with a post-change measurement, then judges it', () => {
    const g = preSpendGate({ latestHealthy: healthy, blockages: [] });
    expect(g.decision).toBe('ALLOW_THEN_MEASURE');
    expect(g.measureAfter).toMatch(/accepted, commercially useful output/);
    expect(g.scalingOptions).toEqual(expect.arrayContaining(['independent ingestion workers', 'optimized bulk processing']));
    expect(preSpendGate({ latestHealthy: healthy, blockages: [], usefulBefore: 5, usefulAfter: 5 }).decision).toBe('NO_GAIN_REVERT');
    expect(preSpendGate({ latestHealthy: healthy, blockages: [], usefulBefore: 5, usefulAfter: 9 }).decision).toBe('GAIN_VERIFIED');
  });
  it('scaling options are not only the application request loop', () => {
    expect(SCALING_OPTIONS).toContain('independent ingestion workers');
  });
});

function stage(id: string, over: Partial<StageReading> = {}): StageReading {
  return {
    stage: id, label: id, queueSize: ok(0), oldestUsefulItemMinutes: ok(null as unknown as number), itemsProcessedPerHour: ok(0),
    uniqueUsableFacts: ok(0), droppedOrDuplicate: ok(0), modelCallsAvoided: ok(0), providerFailures: ok(0), elapsedMs: ok(0),
    incrementalDollars: ok(0), resources: NOT('x'), accepted: 0, acceptedPerHour: 0, ...over,
  } as StageReading;
}

describe('blockages and stage pressure from a recorded reading', () => {
  const report = {
    stages: [stage('evidence-verification', { queueSize: ok(7), providerFailures: ok(4), accepted: 0 }), stage('model-interpretation', { queueSize: ok(20), acceptedPerHour: 2 })],
    diagnosis: { routes: [], primary: { route: 'gpu/1', cause: 'broken GPU', failures: 5, evidence: 'e' }, restored: [] },
    constrained: { stage: 'model-interpretation', basis: 'b', expectedGain: NOT('x'), recommendation: 'r' },
    process: { dbPool: NOT('sqlite') },
  } as unknown as StageCapacityReport;
  const recorded = { at: 'now', outcome: 'MEASURED', reason: '', ageMinutes: 1, stale: false, report, queuedNow: 27, queueAdvance: null } as RecordedStageCapacity;

  it('names an unavailable model and a failing audit handoff as reversible blockages', () => {
    const kinds = blockagesOf(recorded).map((b) => b.kind);
    expect(kinds).toEqual(['UNAVAILABLE_MODEL', 'FAILING_AUDIT_HANDOFF']);
    expect(preSpendGate({ latestHealthy: { at: 'now', stale: false }, blockages: blockagesOf(recorded) }).decision).toBe('REFUSE_REMOVE_BLOCKAGE_FIRST');
  });

  it('reports queue depth, utilization, retries and backpressure per stage', () => {
    const p = stagePressures(report, new Map([['model-interpretation', 3]]), ok(0.5));
    const interp = p.find((x) => x.stage === 'model-interpretation')!;
    expect(interp.queueDepth).toEqual(ok(20));
    expect(interp.retries).toEqual(ok(3));
    expect(interp.workerUtilization).toEqual(ok(0.5));
    expect(interp.backpressure).toEqual({ measured: true, value: true });
    expect(p.find((x) => x.stage === 'source-ingestion')!.workerUtilization.measured).toBe(false);
  });
});

describe('recordStageLimit', () => {
  it('stores a bounded row however many routes the window read, busiest routes first (finding F8)', async () => {
    const rows: { measures?: Record<string, unknown> }[] = [];
    const route = (i: number) => ({
      domain: `d${i % 50}`, route: `r${i}`, since: 'a', until: 'b', pulls: 1, failedPulls: 0,
      measures: { acceptedFacts: { measured: true, value: i }, processedRecords: { measured: true, value: i }, pad: 'x'.repeat(200) },
    });
    const routes = Array.from({ length: 3_000 }, (_, i) => route(i));
    const report = {
      since: 'a', until: 'b', routes,
      domains: Array.from({ length: 50 }, (_, i) => ({ domain: `d${i}`, routes: 60, recordsConsidered: i, acceptedFacts: i })),
      pressures: [], limit: { kind: 'PARSING', basis: 'b', remedy: 'r', scaleServer: false }, gate: { decision: 'ALLOW_THEN_MEASURE' }, allocation: { basis: 'a' },
    } as unknown as StageLimitReport;
    const returned = await recordStageLimit(new Date(), async (e) => { rows.push(e); }, async () => report);
    expect(returned.routes).toHaveLength(3_000);
    const stored = rows[0]!.measures!;
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(STORED_MEASURES_MAX_BYTES);
    expect((stored['routes'] as { route: string }[])[0]!.route).toBe('r2999');
    expect(stored['totals']).toEqual({ routes: 3_000, domains: 50 });
    expect(stored['limit']).toMatchObject({ kind: 'PARSING' });
  });

  it('writes one STAGE_LIMIT row', async () => {
    const rows: { eventType: string; outcome?: string | null }[] = [];
    const report = { limit: { kind: 'PARSING', basis: 'b', remedy: 'r', scaleServer: false }, gate: { decision: 'ALLOW_THEN_MEASURE' }, allocation: { basis: 'a' } } as unknown as StageLimitReport;
    await recordStageLimit(new Date(), async (e) => { rows.push(e); }, async () => report);
    expect(rows).toEqual([expect.objectContaining({ eventType: STAGE_LIMIT_EVENT, outcome: 'PARSING' })]);
  });

  describe('against a real database', () => {
    beforeEach(async () => {
      await freshProject();
    });

    it('reads routes by domain from FEED_ACQUISITION rows and records the reading', async () => {
      const db = getDb();
      const now = Date.now();
      const at = new Date(now - 60_000).toISOString();
      const insert = (type: string, provider: string | null, outcome: string, reason: string, measures: object, workload: string | null = null) =>
        db.run(
          `INSERT INTO bin_events (id, event_type, at, provider, measures, outcome, reason, is_proxy, workload_class) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [newId('bev'), type, at, provider, JSON.stringify(measures), outcome, reason, workload],
        );
      await insert('FEED_ACQUISITION', 'src-a', 'FAILED', 'src-a: HTTP 403', { corpus: 'domain:open', fetched: 0, inserted: 0 });
      await insert('FEED_ACQUISITION', 'src-a', 'FAILED', 'src-a: HTTP 403', { corpus: 'domain:open', fetched: 0, inserted: 0 });
      await insert('FEED_ACQUISITION', 'src-b', 'OK', 'src-b: 8 read, 3 stored', { corpus: 'corpus-y', fetched: 8, inserted: 3 });
      await insert('FREE_LANE_CAPACITY', null, 'GROW', '2 -> 4: waiting', { busy: 3, waiting: 5, cpu: 0.3 }, 'free/a');
      // Lane attempts: one item failed once and was never retried, another failed and was retried, one was
      // attempted before the window and again inside it. Only re-attempts are retries.
      const attempt = (item: string, outcome: string, atIso: string) => db.run(
        `INSERT INTO bin_events (id, event_type, at, work_item_id, outcome, reason, is_proxy, workload_class) VALUES (?, 'FREE_LANE_ITEM', ?, ?, ?, 'model m', 0, 'RESEARCH_FRAGMENT')`,
        [newId('bev'), atIso, item, outcome],
      );
      await attempt('wi-once', 'FAILED_RETRYABLE', new Date(now - 50 * 60_000).toISOString());
      await attempt('wi-once-b', 'FAILED_RETRYABLE', new Date(now - 45 * 60_000).toISOString());
      await attempt('wi-once-c', 'RELEASED_TRANSIENT', new Date(now - 44 * 60_000).toISOString());
      await attempt('wi-twice', 'FAILED_RETRYABLE', new Date(now - 40 * 60_000).toISOString());
      await attempt('wi-twice', 'SUBMITTED', new Date(now - 30 * 60_000).toISOString());
      await attempt('wi-old', 'RELEASED_TRANSIENT', new Date(now - 30 * 3_600_000).toISOString());
      await attempt('wi-old', 'SUBMITTED', new Date(now - 20 * 60_000).toISOString());

      const report = await readStageLimit({ now });
      expect(report.routes.map((r) => r.route).sort()).toEqual(['src-a', 'src-b']);
      expect(report.domains.map((d) => d.domain).sort()).toEqual(['corpus-y', 'domain:open']);
      expect(report.limit.kind).toBe('SOURCE_ACCESS');
      expect(report.gate.decision).toBe('REFUSE_NO_HEALTHY_READING');
      expect(report.allocation.ranked.length + report.allocation.unmeasured.length).toBe(5);
      // Four non-submitted rows in the window, but only two re-attempts.
      expect(report.pressures.find((p) => p.stage === 'model-interpretation')!.retries).toEqual(ok(2));

      await recordStageLimit(new Date(now));
      const row = await db.get<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [STAGE_LIMIT_EVENT]);
      expect(row?.outcome).toBe('SOURCE_ACCESS');
    });
  });
});

/*
 * F4 (review round 1): GAIN_VERIFIED / NO_GAIN_REVERT were unreachable on
 * production because nothing fed the gate a before/after pair. The reading now
 * finds the latest recorded growth (FREE_LANE_CAPACITY GROW, written by the
 * capacity controller) and counts the lane's accepted output over equal windows
 * either side of it, from FREE_LANE_ITEM rows.
 */
describe('the post-change measurement is fed from rows', () => {
  it('reads a growth from its capacity row and only judges a fully elapsed after-window', () => {
    expect(capacityChangeOf({ workload_class: 'free/a', at: 't', reason: '2 -> 4: waiting' })).toEqual({ model: 'free/a', at: 't', from: 2, to: 4 });
    expect(capacityChangeOf({ workload_class: 'free/a', at: 't', reason: '4 -> 2: overloaded' })).toBeNull();
    expect(capacityChangeOf({ workload_class: null, at: 't', reason: '2 -> 4' })).toBeNull();
    const at = '2026-11-17T00:00:00.000Z';
    expect(postChangeWindows({ at }, Date.parse(at) + POST_CHANGE_WINDOW_MS - 1)).toBeNull();
    expect(postChangeWindows({ at }, Date.parse(at) + POST_CHANGE_WINDOW_MS)).toEqual({
      before: [new Date(Date.parse(at) - POST_CHANGE_WINDOW_MS).toISOString(), at],
      after: [at, new Date(Date.parse(at) + POST_CHANGE_WINDOW_MS).toISOString()],
    });
  });

  describe('against a real database', () => {
    beforeEach(async () => {
      await freshProject();
    });

    const insertAt = (type: string, at: string, outcome: string, reason: string, workload: string | null = null) =>
      getDb().run(
        `INSERT INTO bin_events (id, event_type, at, measures, outcome, reason, is_proxy, workload_class) VALUES (?, ?, ?, '{}', ?, ?, 0, ?)`,
        [newId('bev'), type, at, outcome, reason, workload],
      );
    const iso = (ms: number) => new Date(ms).toISOString();

    async function scenario(before: number, after: number): Promise<number> {
      const now = Date.now();
      const grewAt = now - POST_CHANGE_WINDOW_MS - 30 * 60_000;
      await insertAt('FREE_LANE_CAPACITY', iso(grewAt), 'GROW', '2 -> 4: waiting', 'free/a');
      for (let i = 0; i < before; i += 1) await insertAt('FREE_LANE_ITEM', iso(grewAt - 60_000 * (i + 1)), 'SUBMITTED', 'model free/a: ok', 'claims');
      for (let i = 0; i < after; i += 1) await insertAt('FREE_LANE_ITEM', iso(grewAt + 60_000 * (i + 1)), 'SUBMITTED', 'model free/a: ok', 'claims');
      // Not accepted output, and output outside the windows: neither counts.
      await insertAt('FREE_LANE_ITEM', iso(grewAt + 60_000), 'FAILED', 'model free/a: HTTP 503', 'claims');
      await insertAt('FREE_LANE_ITEM', iso(grewAt - POST_CHANGE_WINDOW_MS - 60_000), 'SUBMITTED', 'model free/a: ok', 'claims');
      return now;
    }

    it('counts accepted output either side of the latest growth', async () => {
      const now = await scenario(3, 7);
      const measured = await readMeasuredChange(now);
      expect(measured).toMatchObject({ change: { model: 'free/a', from: 2, to: 4 }, usefulBefore: 3, usefulAfter: 7 });
    });

    it('the recorded reading reaches GAIN_VERIFIED when output rose after the growth', async () => {
      const now = await scenario(3, 7);
      await recordStageCapacity({ hours: 1, now, followers: [] });
      const report = await readStageLimit({ now });
      expect(report.capacityChange?.change.model).toBe('free/a');
      expect(report.gate.decision).toBe('GAIN_VERIFIED');
      expect(report.gate.reason).toContain('free/a grew 2 -> 4');
    });

    it('the recorded reading reaches NO_GAIN_REVERT when output did not rise, and writes it on the STAGE_LIMIT row', async () => {
      const now = await scenario(5, 5);
      await recordStageCapacity({ hours: 1, now, followers: [] });
      expect((await readStageLimit({ now })).gate.decision).toBe('NO_GAIN_REVERT');
      await recordStageLimit(new Date(now));
      const row = await getDb().get<{ reason: string; measures: string }>(`SELECT reason, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [STAGE_LIMIT_EVENT]);
      expect(row?.reason).toContain('NO_GAIN_REVERT');
      expect((JSON.parse(row!.measures) as StageLimitReport).gate.decision).toBe('NO_GAIN_REVERT');
    });

    it('a growth whose after-window is still open is named and still measured after, not judged', async () => {
      const now = Date.now();
      await insertAt('FREE_LANE_CAPACITY', iso(now - 60 * 60_000), 'GROW', '1 -> 3: waiting', 'free/b');
      await recordStageCapacity({ hours: 1, now, followers: [] });
      const report = await readStageLimit({ now });
      expect(report.capacityChange).toMatchObject({ change: { model: 'free/b' }, usefulBefore: null, usefulAfter: null });
      expect(report.gate.decision).toBe('ALLOW_THEN_MEASURE');
      expect(report.gate.reason).toContain('still inside its after-window');
    });

    it('no growth in the lookback leaves the gate as before', async () => {
      const now = Date.now();
      expect(await readMeasuredChange(now)).toBeNull();
      await recordStageCapacity({ hours: 1, now, followers: [] });
      expect((await readStageLimit({ now })).gate.decision).toBe('ALLOW_THEN_MEASURE');
    });
  });
});
