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
  REMEDIES,
  ROUTE_MEASURE_KEYS,
  SCALING_OPTIONS,
  STAGE_LIMIT_EVENT,
  allocateMarginal,
  blockagesOf,
  limitingStage,
  preSpendGate,
  readStageLimit,
  recordStageLimit,
  routeWindowReadings,
  stagePressures,
  type LimitSignals,
  type StageLimitReport,
} from '../server/services/freeLane/stageLimit.ts';
import type { RecordedStageCapacity, StageCapacityReport, StageReading } from '../server/services/freeLane/stageCapacity.ts';

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

      const report = await readStageLimit({ now });
      expect(report.routes.map((r) => r.route).sort()).toEqual(['src-a', 'src-b']);
      expect(report.domains.map((d) => d.domain).sort()).toEqual(['corpus-y', 'domain:open']);
      expect(report.limit.kind).toBe('SOURCE_ACCESS');
      expect(report.gate.decision).toBe('REFUSE_NO_HEALTHY_READING');
      expect(report.allocation.ranked.length + report.allocation.unmeasured.length).toBe(5);

      await recordStageLimit(new Date(now));
      const row = await db.get<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [STAGE_LIMIT_EVENT]);
      expect(row?.outcome).toBe('SOURCE_ACCESS');
    });
  });
});
