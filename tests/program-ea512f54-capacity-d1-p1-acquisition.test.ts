/**
 * CAP-21-7 — resource-aware acquisition measurement. Every measure is present
 * per source, measured or NOT_MEASURED with a reason; the classifier names the
 * constrained resource class from measurements and scales only it; an outage
 * or failed authorization is a repair, never CPU; work is shared across goal
 * demand, exploration, capability building and future planning with no owner
 * quota. Over real database rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { RecordBinEventInput } from '../server/repos/bins.ts';
import type { Measured, RecordedStageCapacity, StageCapacityReport, StageReading } from '../server/services/freeLane/stageCapacity.ts';
import { CONNECTOR_HEALTH_EVENT } from '../server/services/feeds/health.ts';
import type { FeedSource } from '../server/services/feeds/sources.ts';
import {
  ACQUISITION_MEASURES_EVENT,
  LANE_FLOOR,
  RESOURCE_CLASSES,
  UNMEASURED_REASONS,
  WORK_LANES,
  allocateWork,
  classifyConstraint,
  failureRecovery,
  laneReadings,
  placementAdvice,
  readAcquisitionMeasures,
  recordAcquisitionMeasures,
  resourceSignals,
  sourceRepair,
  type ResourceSignal,
} from '../server/services/feeds/acquisitionMeasures.ts';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-17T12:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 24 * HOUR).toISOString();
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const m = <T>(value: T): Measured<T> => ({ measured: true, value });
const nm = <T>(reason: string): Measured<T> => ({ measured: false, reason });

let tag = '';
beforeEach(async () => {
  await freshProject();
  tag = Math.random().toString(36).slice(2, 8);
});

const catalogSource = (id: string, over: Partial<FeedSource> = {}): FeedSource => ({
  id,
  label: id,
  url: `https://feed.test/${id}`,
  intervalMs: HOUR,
  parse: () => [],
  ...over,
});

async function pull(source: string, ok: boolean, fetched: number, inserted: number, hoursAgo: number, error: string | null = null) {
  await getDb().run(`INSERT INTO feed_pulls (id, source, ok, fetched, inserted, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    `fp_${tag}_${Math.random().toString(36).slice(2)}`,
    source,
    ok ? 1 : 0,
    fetched,
    inserted,
    error,
    at(hoursAgo),
  ]);
}

async function item(source: string, n: number, hoursAgo: number, over: { title?: string; organization?: string | null; shortlisted?: boolean } = {}): Promise<string> {
  const id = `fi_${tag}_${source}_${n}`;
  await getDb().run(
    `INSERT INTO feed_items (id, source, external_id, url, title, body, organization, published_at, fetched_at, shortlisted_round_id, shortlisted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      source,
      `${source}-${n}`,
      `https://feed.test/${source}/${n}`,
      over.title ?? `Hiring a contract bookkeeper for monthly reconciliation ${n}`,
      'We need a freelance bookkeeper to reconcile accounts monthly. Budget $500 per month.',
      over.organization === undefined ? 'Acme Dental LLC' : over.organization,
      at(hoursAgo),
      at(hoursAgo),
      over.shortlisted ? `rnd_${tag}` : null,
      over.shortlisted ? at(hoursAgo) : null,
    ],
  );
  return id;
}

async function screen(subject: string, keep: boolean) {
  await getDb().run(
    `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, 'free-a', 1, ?, NULL, ?)`,
    [`cr_${tag}_${subject}`, `h_${subject}`, subject, JSON.stringify({ verdict: keep ? 'KEEP' : 'DROP' }), at(1)],
  );
}

async function cover(itemId: string) {
  await getDb().run(`INSERT INTO feed_item_coverage (item_id, detection_id, covered_at) VALUES (?, ?, ?)`, [itemId, `det_${tag}`, at(1)]);
}

async function health(source: string, state: string, hoursAgo: number) {
  await getDb().run(`INSERT INTO bin_events (id, event_type, at, provider, measures, outcome) VALUES (?, ?, ?, ?, ?, ?)`, [
    `bev_${tag}_${source}_${hoursAgo}`,
    CONNECTOR_HEALTH_EVENT,
    at(hoursAgo),
    source,
    JSON.stringify({ source, state }),
    'BACKOFF',
  ]);
}

const EVERY_MEASURE = [
  'recordsVisited',
  'newUniqueDocuments',
  'newUniqueUsefulDocuments',
  'refreshedRecords',
  'rawBytes',
  'parserCoverage',
  'structuredFacts',
  'acceptedEvidence',
  'codeDerivedMatches',
  'verifiedBuyerPriceFulfillmentLinks',
  'usableTransactionPaths',
  'timeToGoalImpactMinutes',
  'aiJobsAvoided',
  'aiEscalations',
  'aiCallsPerUsefulFinding',
  'dollarsPerUsefulFinding',
  'failureRecovery',
  'providerSaturation',
  'revenue',
] as const;

describe('per-source acquisition measures (CAP-21-7)', () => {
  it('measures every CAP-21-7 figure per source from rows, or says why not', async () => {
    const src = `src-${tag}`;
    await pull(src, true, 10, 3, 5);
    await pull(src, false, 0, 0, 4, 'HTTP 429 Too Many Requests');
    await pull(src, true, 4, 1, 3);
    const a = await item(src, 1, 5);
    const b = await item(src, 2, 5, { shortlisted: true });
    const c = await item(src, 3, 5);
    await item(src, 4, 3);
    await screen(a, true);
    await screen(b, true);
    await cover(c);

    const all = await readAcquisitionMeasures(SINCE, NOW.toISOString(), []);
    const one = all.find((s) => s.source === src)!;
    expect(one).toBeTruthy();
    for (const key of EVERY_MEASURE) {
      const value = one[key] as Measured<unknown>;
      expect(value, key).toBeTruthy();
      if (!value.measured) expect(value.reason.length, key).toBeGreaterThan(10);
    }
    expect(one.recordsVisited).toEqual(m(14));
    expect(one.newUniqueDocuments).toEqual(m(4));
    expect(one.newUniqueUsefulDocuments).toEqual(m(3));
    expect(one.refreshedRecords).toEqual(m(10));
    expect(one.codeDerivedMatches).toEqual(m(1));
    expect(one.usableTransactionPaths).toEqual(m(1));
    expect(one.aiEscalations).toEqual(m(2));
    // 10 repeats storage dropped + 1 item a code rule covered without a screen.
    expect(one.aiJobsAvoided).toEqual(m(11));
    expect(one.aiCallsPerUsefulFinding).toEqual(m(0.6667));
    expect(one.failureRecovery).toEqual(m({ failures: 1, recoveries: 1, pulls: 3 }));
    expect(one.providerSaturation).toEqual(m({ throttled: 1, latestHealth: null }));
    expect(one.parserCoverage.measured).toBe(true);
    expect(one.structuredFacts.measured).toBe(true);
    // What the rows cannot see is not guessed.
    expect(one.rawBytes).toEqual(nm(UNMEASURED_REASONS.rawBytes));
    expect(one.acceptedEvidence).toEqual(nm(UNMEASURED_REASONS.acceptedEvidence));
    expect(one.verifiedBuyerPriceFulfillmentLinks.measured).toBe(false);
    expect(one.timeToGoalImpactMinutes.measured).toBe(false);
    expect(one.dollarsPerUsefulFinding.measured).toBe(false);
    expect(one.revenue.measured).toBe(false);
  });

  it('takes its sources from the rows as well as the catalog: nothing is a whitelist', async () => {
    const listed = catalogSource(`listed-${tag}`);
    const unlisted = `unlisted-${tag}`;
    await pull(unlisted, true, 2, 2, 2);
    const all = await readAcquisitionMeasures(SINCE, NOW.toISOString(), [listed]);
    const ids = all.map((s) => s.source);
    expect(ids).toContain(listed.id);
    expect(ids).toContain(unlisted);
    const none = all.find((s) => s.source === listed.id)!;
    expect(none.parserCoverage).toEqual(m(null));
    expect(none.aiCallsPerUsefulFinding).toEqual(m(null));
  });

  it('turns an outage or a refused authorization into a repair for that source, never compute', async () => {
    const out = `out-${tag}`;
    const denied = `denied-${tag}`;
    await pull(out, false, 0, 0, 2, 'HTTP 503');
    await pull(denied, false, 0, 0, 2, 'HTTP 403');
    await health(out, 'TRANSIENT_OUTAGE', 1);
    await health(denied, 'HEALTHY', 3);
    await health(denied, 'PERMISSION_REVOKED', 1);
    const all = await readAcquisitionMeasures(SINCE, NOW.toISOString(), []);
    expect(all.find((s) => s.source === out)!.repair?.kind).toBe('REPAIR_OUTAGE');
    expect(all.find((s) => s.source === denied)!.repair?.kind).toBe('REPAIR_AUTHORIZATION');
    expect(all.find((s) => s.source === denied)!.providerSaturation).toEqual(m({ throttled: 0, latestHealth: 'PERMISSION_REVOKED' }));
    for (const state of ['PERMISSION_REVOKED', 'TRANSIENT_OUTAGE'] as const) expect(sourceRepair(state)!.reason).toMatch(/cannot repair/);
    expect(sourceRepair('HEALTHY')).toBeNull();
    expect(sourceRepair(null)).toBeNull();
  });

  it('counts recovery only when the next pull succeeded', () => {
    expect(failureRecovery([{ ok: false }, { ok: false }, { ok: true }, { ok: false }])).toEqual({ failures: 3, recoveries: 1, pulls: 4 });
  });
});

describe('placement and egress', () => {
  it('filters in place when the provider supports it, and shards a bulk source otherwise', () => {
    const acq = (mechanism: 'CONDITIONAL_FETCH' | 'PAGED_API' | 'BULK_SNAPSHOT', resourceQuery?: string) => ({
      corpus: 'domain:x',
      factKinds: [],
      ...(resourceQuery ? { resourceQuery } : {}),
      access: { format: 'JSON', updateMechanism: mechanism, authentication: 'NONE' as const, usage: 'terms' },
      provenance: { publisher: 'p', license: 'l', parserVersion: 'v' },
    });
    expect(placementAdvice({ cursorUrl: (s: string) => s }).placement).toBe('FILTER_AT_SOURCE');
    expect(placementAdvice({ acquisition: acq('BULK_SNAPSHOT', 'rows=100') }).placement).toBe('FILTER_AT_SOURCE');
    expect(placementAdvice({ acquisition: acq('BULK_SNAPSHOT') }).placement).toBe('SHARDED_BULK_READ');
    expect(placementAdvice({ acquisition: acq('CONDITIONAL_FETCH') }).placement).toBe('CONDITIONAL_READ');
    expect(placementAdvice(null).placement).toBe('WHOLE_READ');
  });
});

describe('which resource class is constrained', () => {
  const signal = (resource: ResourceSignal['resource'], over: Partial<ResourceSignal> = {}): ResourceSignal => ({
    resource,
    waiting: m(0),
    throughputPerHour: m(10),
    marginalGain: nm('none'),
    fault: null,
    ...over,
  });

  it('names the class with the longest measured backlog and a positive marginal gain, and scales only it', () => {
    const verdict = classifyConstraint([
      signal('INGESTION_WORKERS', { waiting: m(20), throughputPerHour: m(10), marginalGain: m(3) }),
      signal('BULK_PROCESSING', { waiting: m(200), throughputPerHour: m(10), marginalGain: m(5) }),
      // The longest backlog, but nothing says another unit would help: not scaled.
      signal('LLM_WORKERS', { waiting: m(10_000), throughputPerHour: m(1), marginalGain: nm('no estimate') }),
    ]);
    expect(verdict.constrained).toBe('BULK_PROCESSING');
    const increases = verdict.recommendations.filter((r) => r.action === 'INCREASE');
    expect(increases.map((r) => r.resource)).toEqual(['BULK_PROCESSING']);
    expect(verdict.recommendations.map((r) => r.resource).sort()).toEqual([...RESOURCE_CLASSES].sort());
    // The application server is not a resource class at all.
    expect(RESOURCE_CLASSES as readonly string[]).not.toContain('APPLICATION_SERVER');
  });

  it('repairs an outage or refused authorization and never scales past it', () => {
    const verdict = classifyConstraint([
      signal('LLM_WORKERS', { waiting: m(500), throughputPerHour: m(1), marginalGain: m(9), fault: { kind: 'AUTHORIZATION', evidence: 'route-a: credentials' } }),
      signal('GPU', { fault: { kind: 'OUTAGE', evidence: 'pod down' } }),
    ]);
    expect(verdict.constrained).toBeNull();
    expect(verdict.recommendations.find((r) => r.resource === 'LLM_WORKERS')!.action).toBe('REPAIR');
    expect(verdict.recommendations.find((r) => r.resource === 'GPU')!.action).toBe('REPAIR');
    expect(verdict.recommendations.some((r) => r.action === 'INCREASE')).toBe(false);
    expect(verdict.basis).toMatch(/add nothing/);
  });

  it('never treats an unmeasured resource as the bottleneck', () => {
    const verdict = classifyConstraint([signal('OBJECT_STORAGE', { waiting: nm('no rows'), throughputPerHour: nm('no rows'), marginalGain: nm('no rows') })]);
    expect(verdict.constrained).toBeNull();
    expect(verdict.recommendations.every((r) => r.action === 'HOLD')).toBe(true);
  });

  const stage = (id: string, queue: number, perHour: number): StageReading => ({
    stage: id,
    label: id,
    queueSize: m(queue),
    oldestUsefulItemMinutes: m(null),
    itemsProcessedPerHour: m(perHour),
    uniqueUsableFacts: m(0),
    droppedOrDuplicate: m(0),
    modelCallsAvoided: m(0),
    providerFailures: m(0),
    elapsedMs: m(0),
    incrementalDollars: m(0),
    resources: nm('x'),
    accepted: 0,
    acceptedPerHour: 0,
  });

  const recorded = (over: Partial<StageCapacityReport> = {}, stale = false): RecordedStageCapacity => ({
    at: NOW.toISOString(),
    outcome: 'MEASURED',
    reason: '',
    ageMinutes: stale ? 500 : 5,
    stale,
    queuedNow: null,
    queueAdvance: null,
    report: {
      windowHours: 1,
      since: SINCE,
      stages: [stage('source-ingestion', 2, 50), stage('parsing-indexing', 0, 50), stage('model-interpretation', 300, 6)],
      purposes: [],
      totalProductiveJobs: 0,
      purposesSumToTotal: true,
      attribution: [
        { category: 'IMMEDIATE_COMMERCIAL_DISCOVERY', productiveJobs: 6, bases: {} },
        { category: 'DEAL_COMPLETION', productiveJobs: 2, bases: {} },
        { category: 'BROADER_WORLD_RESEARCH', productiveJobs: 4, bases: {} },
        { category: 'SELF_IMPROVEMENT', productiveJobs: 0, bases: {} },
        { category: 'FUTURE_GOAL_PREPARATION', productiveJobs: 0, bases: {} },
      ],
      attributionSumsToTotal: true,
      process: { scope: 'process', cpuSecondsSinceStart: 1, rssBytes: 1, heapUsedBytes: 1, dbPool: m({ workloadWaiting: 0 }), network: nm('x') },
      gpuSpend: nm('no samples'),
      diagnosis: { routes: [], gpu: {} as never, primary: null, restored: [] },
      constrained: { stage: 'model-interpretation', basis: 'model stage', expectedGain: m({ acceptedFactsPerHour: 4, dollars: 0 }), recommendation: '' },
      ...over,
    },
  });

  it('reads the constrained class from the recorded stage-capacity measurement', () => {
    const verdict = classifyConstraint(resourceSignals(recorded()));
    expect(verdict.constrained).toBe('LLM_WORKERS');
    const signals = resourceSignals(recorded());
    expect(signals.find((s) => s.resource === 'OBJECT_STORAGE')!.waiting.measured).toBe(false);
    expect(signals.find((s) => s.resource === 'BROWSER_WORKERS')!.waiting.measured).toBe(false);
  });

  it('turns a failing model route into a repair rather than more LLM workers', () => {
    for (const [cause, kind] of [['credentials', 'AUTHORIZATION'], ['provider availability', 'OUTAGE']] as const) {
      const r = recorded({ diagnosis: { routes: [], gpu: {} as never, primary: { route: 'route-a', cause, failures: 7, evidence: 'x' }, restored: [] } });
      const verdict = classifyConstraint(resourceSignals(r));
      expect(verdict.constrained).toBeNull();
      const llm = verdict.recommendations.find((x) => x.resource === 'LLM_WORKERS')!;
      expect(llm.action).toBe('REPAIR');
      expect(llm.reason.toLowerCase()).toContain(kind.toLowerCase());
    }
  });

  it('scales nothing from a stale or missing measurement', () => {
    expect(classifyConstraint(resourceSignals(recorded({}, true))).constrained).toBeNull();
    expect(classifyConstraint(resourceSignals(null)).constrained).toBeNull();
  });

  it('allocates across goal demand, exploration, capability building and future planning without a quota', () => {
    const shares = allocateWork(laneReadings(recorded()));
    expect(shares.map((s) => s.lane)).toEqual([...WORK_LANES]);
    const total = shares.reduce((n, s) => n + s.share, 0);
    expect(total).toBeCloseTo(1, 3);
    const by = Object.fromEntries(shares.map((s) => [s.lane, s.share]));
    expect(by.ACTIVE_GOAL_DEMAND).toBeGreaterThan(by.OPEN_WORLD_EXPLORATION!);
    expect(by.OPEN_WORLD_EXPLORATION).toBeGreaterThan(by.CAPABILITY_BUILDING!);
    for (const s of shares) expect(s.share).toBeGreaterThanOrEqual(LANE_FLOOR);
    // Unmeasured lanes get the floor only, never a favourable share.
    const unknown = allocateWork(laneReadings(null));
    for (const s of unknown) expect(s.share).toBe(LANE_FLOOR);
  });
});

describe('the recorded reading', () => {
  it('writes one ACQUISITION_MEASURES bin event per window, back to back', async () => {
    const src = `rec-${tag}`;
    await pull(src, true, 3, 3, 2);
    await item(src, 1, 2);
    const events: RecordBinEventInput[] = [];
    const record = async (e: RecordBinEventInput) => {
      events.push(e);
      const { recordBinEvent } = await import('../server/repos/bins.ts');
      await recordBinEvent(e);
    };
    const first = await recordAcquisitionMeasures(NOW, record, { readStageCapacity: async () => null, catalog: [] });
    expect(first).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe(ACQUISITION_MEASURES_EVENT);
    expect(first!.sources.find((s) => s.source === src)!.recordsVisited).toEqual(m(3));
    expect(first!.constraint.constrained).toBeNull();
    // Inside the same window: nothing written.
    expect(await recordAcquisitionMeasures(new Date(NOW.getTime() + HOUR), record, { readStageCapacity: async () => null, catalog: [] })).toBeNull();
    // The next window starts where the last ended.
    const next = await recordAcquisitionMeasures(new Date(NOW.getTime() + 25 * HOUR), record, { readStageCapacity: async () => null, catalog: [] });
    expect(next!.since).toBe(NOW.toISOString());
    expect(events).toHaveLength(2);
  });
});
