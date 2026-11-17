/**
 * CAP-21-7 — resource-aware acquisition measurement. Every measure is present
 * per source, measured or NOT_MEASURED with a reason; the classifier names the
 * constrained resource class from measurements and scales only it; an outage
 * or failed authorization is a repair, never CPU; work is shared across goal
 * demand, exploration, capability building and future planning with no owner
 * quota. Over real database rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { getDb } from '../server/db/database.ts';
import type { RecordBinEventInput } from '../server/repos/bins.ts';
import type { Measured, RecordedStageCapacity, StageCapacityReport, StageReading } from '../server/services/freeLane/stageCapacity.ts';
import { CONNECTOR_HEALTH_EVENT } from '../server/services/feeds/health.ts';
import type { FeedSource } from '../server/services/feeds/sources.ts';
import {
  ACQUISITION_MEASURES_EVENT,
  LANE_OF_PURPOSE,
  RESOURCE_CLASSES,
  UNMEASURED_REASONS,
  WORK_LANES,
  allocationInForce,
  classifyConstraint,
  failureRecovery,
  laneReadings,
  placementAdvice,
  readAcquisitionMeasures,
  readRouteAttribution,
  readSourceAttribution,
  recordBytes,
  dollarsPerCall,
  isVerifiedLink,
  median,
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
let project: TestProject;
beforeEach(async () => {
  project = await freshProject();
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
    // Review F6: every quoted measure is read from rows; none is NOT_MEASURED by construction.
    const stored = await getDb().all<{ external_id: string; url: string; title: string; body: string | null; organization: string | null; published_at: string | null }>(
      `SELECT external_id, url, title, body, organization, published_at FROM feed_items WHERE source = ?`, [src],
    );
    const bytes = stored.reduce((k, r) => k + recordBytes({ externalId: r.external_id, url: r.url, title: r.title, body: r.body, organization: r.organization, publishedAt: r.published_at }), 0);
    expect(bytes).toBeGreaterThan(4 * 100);
    expect(one.rawBytes).toEqual(m(bytes));
    // Nothing downstream cites these records yet: zero is a measurement, not an unknown.
    expect(one.acceptedEvidence).toEqual(m(0));
    expect(one.verifiedBuyerPriceFulfillmentLinks).toEqual(m(0));
    expect(one.revenue).toEqual(m(0));
    // The shortlisted record was taken the hour it was published.
    expect(one.timeToGoalImpactMinutes).toEqual(m(0));
    // Screens ran on a free provider: a measured $0 per useful finding.
    expect(one.dollarsPerUsefulFinding).toEqual(m(0));
  });

  it('says why a window leaves a measure unread, as a fact about that window, never by construction', async () => {
    const src = `quiet-${tag}`;
    await pull(src, true, 1, 1, 2);
    await item(src, 1, 2);
    const one = (await readAcquisitionMeasures(SINCE, NOW.toISOString(), [])).find((s) => s.source === src)!;
    expect(one.timeToGoalImpactMinutes).toEqual(nm(UNMEASURED_REASONS.timeToGoalImpact));
    expect(one.dollarsPerUsefulFinding).toEqual(nm(UNMEASURED_REASONS.dollarsNoUseful));
    expect(one.rawBytes.measured).toBe(true);
    expect(one.acceptedEvidence).toEqual(m(0));
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
        { category: 'IMMEDIATE_COMMERCIAL_DISCOVERY', productiveJobs: 6, jobs: 30, bases: {} },
        { category: 'DEAL_COMPLETION', productiveJobs: 2, jobs: 2, bases: {} },
        { category: 'BROADER_WORLD_RESEARCH', productiveJobs: 4, jobs: 5, bases: {} },
        { category: 'SELF_IMPROVEMENT', productiveJobs: 0, jobs: 4, bases: {} },
        { category: 'FUTURE_GOAL_PREPARATION', productiveJobs: 0, jobs: 0, bases: {} },
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

  it('measures each lane by its own jobs, not by its share of every lane\'s productive jobs (review F2)', () => {
    const by = Object.fromEntries(laneReadings(recorded()).map((r) => [r.lane, r]));
    // Goal demand spent 32 jobs for 8 accepted; exploration 5 for 4. Shares of the 12 productive jobs would rank them the other way.
    expect(by.ACTIVE_GOAL_DEMAND!.jobs).toEqual(m(32));
    expect(by.ACTIVE_GOAL_DEMAND!.useful).toEqual(m(8));
    expect(by.ACTIVE_GOAL_DEMAND!.usefulPerJob).toEqual(m(0.25));
    expect(by.OPEN_WORLD_EXPLORATION!.usefulPerJob).toEqual(m(0.8));
    expect(by.CAPABILITY_BUILDING!.usefulPerJob).toEqual(m(0));
    // A lane that spent nothing has no yield, measured as such, never a favourable one.
    expect(by.FUTURE_PLANNING!.jobs).toEqual(m(0));
    expect(by.FUTURE_PLANNING!.usefulPerJob.measured).toBe(false);
  });

  it('says nothing about yield from a reading that counted accepted jobs only, or from no reading', () => {
    const old = recorded();
    old.report!.attribution = old.report!.attribution.map(({ jobs: _jobs, ...rest }) => rest);
    for (const r of [...laneReadings(old), ...laneReadings(null), ...laneReadings(recorded({}, true))]) {
      expect(r.usefulPerJob.measured).toBe(false);
      expect(r.jobs.measured).toBe(false);
    }
  });

  const decision = {
    shares: { BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.35, OPERATING_SUPPORT: 0.1, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.2 },
    observed: { BROAD_DISCOVERY: 0.1, TRANSACTION_ROUTES: 0.5, OPERATING_SUPPORT: 0.1, SELF_IMPROVEMENT: 0.2, FORWARD_EXPLORATION: 0.1 },
    held: false,
    urgentCommercialGoal: true,
    fingerprint: 'fp-test',
  };

  it('reports the allocation the free lane and the goals tick apply, per lane, with no quota and no shares of its own (review F2)', () => {
    const shares = allocationInForce(decision, laneReadings(recorded()));
    expect(shares.map((s) => s.lane)).toEqual([...WORK_LANES]);
    const by = Object.fromEntries(shares.map((s) => [s.lane, s]));
    expect(by.ACTIVE_GOAL_DEMAND!.decided).toEqual(m(0.45));
    expect(by.ACTIVE_GOAL_DEMAND!.observed).toEqual(m(0.6));
    expect(by.OPEN_WORLD_EXPLORATION!.decided).toEqual(m(0.2));
    expect(by.CAPABILITY_BUILDING!.decided).toEqual(m(0.15));
    expect(by.FUTURE_PLANNING!.decided).toEqual(m(0.2));
    expect(by.OPEN_WORLD_EXPLORATION!.usefulPerJob).toEqual(m(0.8));
    expect(shares.reduce((n, s) => n + (s.decided.measured ? s.decided.value : 0), 0)).toBeCloseTo(1, 6);
    for (const s of shares) expect(s.basis).toContain('fp-test');
    // Every research purpose belongs to exactly one lane, so no decided share is lost or counted twice.
    expect(new Set(Object.keys(LANE_OF_PURPOSE))).toEqual(new Set(Object.keys(decision.shares)));
  });

  it('claims no share when no decision is in force, rather than inventing one', () => {
    for (const none of [null, { ...decision, held: true }]) {
      for (const s of allocationInForce(none, laneReadings(recorded()))) {
        expect(s.decided.measured).toBe(false);
        expect(s.basis).toContain('stored priority');
      }
    }
  });
});

describe('jobs per category, over real rows', () => {
  it('counts every job a category spent and only accepted ones as productive; a refunded hand-back is no job', async () => {
    const { recordBinEvent } = await import('../server/repos/bins.ts');
    const { stageCapacity } = await import('../server/services/freeLane/stageCapacity.ts');
    const broad = async () => (await stageCapacity({ hours: 1 })).attribution.find((a) => a.category === 'BROADER_WORLD_RESEARCH')!;
    const before = await broad();
    for (const outcome of ['SUBMITTED', 'FAILED_RETRYABLE', 'FAILED_RETRYABLE', 'RELEASED_TRANSIENT']) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', outcome, reason: `model jobs-${tag}` });
    }
    const after = await broad();
    expect(after.jobs! - before.jobs!).toBe(3);
    expect(after.productiveJobs - before.productiveJobs).toBe(1);
    expect((await stageCapacity({ hours: 1 })).attributionSumsToTotal).toBe(true);
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

  it('records the research allocation decision row in force, read as the free lane reads it (review F2)', async () => {
    const { recordImprovementEvent } = await import('../server/repos/improvement.ts');
    const { RESEARCH_ALLOCATION_DECIDED } = await import('../server/services/goals/tick.ts');
    const fingerprint = `fp-${tag}`;
    await recordImprovementEvent({
      candidateId: null,
      kind: RESEARCH_ALLOCATION_DECIDED,
      at: '2030-01-01T00:00:00.000Z',
      detail: {
        fingerprint,
        shares: { BROAD_DISCOVERY: 0.25, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.05, SELF_IMPROVEMENT: 0.2, FORWARD_EXPLORATION: 0.2 },
        observed: { BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.4, OPERATING_SUPPORT: 0.1, SELF_IMPROVEMENT: 0.2, FORWARD_EXPLORATION: 0.1 },
      },
    });
    const events: RecordBinEventInput[] = [];
    const later = new Date(NOW.getTime() + 200 * 24 * HOUR);
    const reading = await recordAcquisitionMeasures(later, async (e) => { events.push(e); }, { readStageCapacity: async () => null, catalog: [] });
    const by = Object.fromEntries(reading!.allocation.map((s) => [s.lane, s]));
    expect(by.ACTIVE_GOAL_DEMAND!.decided).toEqual(m(0.35));
    expect(by.OPEN_WORLD_EXPLORATION!.decided).toEqual(m(0.25));
    expect(by.ACTIVE_GOAL_DEMAND!.basis).toContain(fingerprint);
    expect((events[0]!.measures as { allocation: unknown }).allocation).toEqual(reading!.allocation);
    // An unreadable decision records no share, and the reading is still written.
    const failed = await recordAcquisitionMeasures(new Date(later.getTime() + 25 * HOUR), async () => {}, {
      readStageCapacity: async () => null, catalog: [], readAllocation: async () => { throw new Error('unreadable'); },
    });
    for (const s of failed!.allocation) expect(s.decided.measured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review F6: the attributed measures, over the rows that carry the chain.
// ---------------------------------------------------------------------------

async function claimFrom(url: string, accepted: boolean, over: { contradiction?: string } = {}): Promise<string> {
  const projectId = project.project.id;
  const layerId = project.layers[0]!.id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'attribution fixture', assignment: 'read the record', provider: 'WORKER' });
  const id = `rc_${tag}_${Math.random().toString(36).slice(2)}`;
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', 'A buyer pays $500 a month', ?, 'record', NULL, NULL, 'excerpt', NULL, 'lane-1',
             ?, 0.9, ?, NULL, 'VALID', NULL, 1, 0, '[]', ?, ?, ?)`,
    [id, orchestration.id, url, at(1), over.contradiction ?? 'UNCHALLENGED', accepted ? 1 : 0, `hash-${id}`, at(1)],
  );
  return id;
}

async function openingFrom(claimId: string | null, verified: boolean): Promise<string> {
  const projectId = project.project.id;
  const cashMode = `cm_${tag}`;
  await getDb().run(
    `INSERT INTO cash_modes (id, project_id, owner_user_id, objective, horizon_days, envelope_id, state, activated_at, created_by_user_id, created_at, updated_at)
     SELECT ?, ?, 'u', 'cash', 30, 'env', 'ACTIVE', ?, 'u', ?, ? WHERE NOT EXISTS (SELECT 1 FROM cash_modes WHERE id = ?)`,
    [cashMode, projectId, at(2), at(2), at(2), cashMode],
  );
  const id = `opp_${tag}_${Math.random().toString(36).slice(2)}`;
  await getDb().run(
    `INSERT INTO cash_opportunities (id, project_id, cash_mode_id, owner_user_id, title, mechanism, currency, required_capabilities, state,
       created_at, updated_at, source_claim_id, payer, price_cents, fulfillment_owner)
     VALUES (?, ?, ?, 'u', 'An opening', 'SERVICE', 'USD', '[]', 'DISCOVERED', ?, ?, ?, ?, ?, ?)`,
    [id, projectId, cashMode, at(1), at(1), claimId, verified ? 'Acme Dental LLC' : null, verified ? 50_000 : null, verified ? 'Brain' : null],
  );
  return id;
}

async function pathFact(claimId: string): Promise<void> {
  const projectId = project.project.id;
  // The path hangs from an opening of its own; the claim reaches it only as the path's evidence.
  const opening = await openingFrom(null, false);
  const pathId = `mp_${tag}_${Math.random().toString(36).slice(2)}`;
  await getDb().run(
    `INSERT INTO monetization_paths (id, project_id, opportunity_id, method, title, origin, created_at, updated_at)
     VALUES (?, ?, ?, 'SERVICE', 'A path', 'ENUMERATED', ?, ?)`,
    [pathId, projectId, opening, at(1), at(1)],
  );
  await getDb().run(
    `INSERT INTO monetization_path_facts (id, project_id, path_id, attribute, kind, value, claim_id, decided_by, created_at, updated_at)
     VALUES (?, ?, ?, 'PRICE', 'EVIDENCE', '$500 a month', ?, 'BRAIN', ?, ?)`,
    [`mpf_${tag}_${Math.random().toString(36).slice(2)}`, projectId, pathId, claimId, at(1), at(1)],
  );
}

async function payment(opportunityId: string, kind: 'CUSTOMER_PAYMENT' | 'REFUND', cents: number, reference: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO cash_money_entries (id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference, occurred_at, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, 'test', ?)`,
    [`cme_${tag}_${Math.random().toString(36).slice(2)}`, project.project.id, opportunityId, kind, cents, reference, at(1), at(1)],
  );
}

async function blueprintFact(url: string, key: string, minutesAfterPublication: number, publishedHoursAgo: number): Promise<void> {
  const projectId = project.project.id;
  const ws = `ws_${tag}_${Math.random().toString(36).slice(2)}`;
  await getDb().run(
    `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES (?, ?, 'Goal', 'cash', 'REVENUE_DIRECT', ?, ?)`,
    [ws, projectId, at(6), at(6)],
  );
  const created = new Date(NOW.getTime() - publishedHoursAgo * HOUR + minutesAfterPublication * 60_000).toISOString();
  await getDb().run(
    `INSERT INTO construction_facts (id, project_id, workstream_id, fact_key, low, high, status, measures, source_title, source_url, recorded_by, created_at)
     VALUES (?, ?, ?, ?, 1, 2, 'OBSERVED', '{}', 'record', ?, 'BRAIN', ?)`,
    [`cf_${tag}_${Math.random().toString(36).slice(2)}`, projectId, ws, key, url, created],
  );
}

describe('measures attributed to the source through the rows (review F6)', () => {
  it('follows item → claim → path fact / opening → money, and item → blueprint fact, per source', async () => {
    const src = `chain-${tag}`;
    const other = `other-${tag}`;
    await pull(src, true, 3, 3, 5);
    await pull(other, true, 1, 1, 5);
    await item(src, 1, 5, { shortlisted: true });
    await item(src, 2, 5);
    await item(src, 3, 5);
    await item(other, 1, 5);
    const urlOf = (source: string, k: number) => `https://feed.test/${source}/${k}`;

    const accepted = await claimFrom(urlOf(src, 1), true);
    await claimFrom(urlOf(src, 2), false, { contradiction: 'REFUTED' });
    const second = await claimFrom(urlOf(src, 3), true, { contradiction: 'CONTESTED' });
    await claimFrom(urlOf(other, 1), false);
    await pathFact(accepted);
    const won = await openingFrom(second, true);
    await openingFrom(accepted, false);
    await payment(won, 'CUSTOMER_PAYMENT', 50_000, 'pi_123');
    await payment(won, 'CUSTOMER_PAYMENT', 9_999, null); // no provider reference: pipeline, not revenue
    await payment(won, 'REFUND', 5_000, null);
    await blueprintFact(urlOf(src, 1), 'price_per_month', 90, 5);
    await blueprintFact(urlOf(src, 3), 'price_per_month', 30, 5);
    await blueprintFact(urlOf(src, 3), 'buyers_per_region', 60, 5);

    const all = await readAcquisitionMeasures(SINCE, NOW.toISOString(), []);
    const one = all.find((s) => s.source === src)!;
    expect(one.acceptedEvidence).toEqual(m(2));
    // One path evidence fact plus one opening with payer, price and fulfillment; the bare opening is not a verified link.
    expect(one.verifiedBuyerPriceFulfillmentLinks).toEqual(m(2));
    expect(one.revenue).toEqual(m(45_000));
    const none = all.find((s) => s.source === other)!;
    expect(none.acceptedEvidence).toEqual(m(0));
    expect(none.revenue).toEqual(m(0));

    const routes = await readRouteAttribution(SINCE, NOW.toISOString());
    const route = routes.get(src)!;
    // The path its evidence fact sits on, and the two openings started from accepted claims.
    expect(route.economicRelationships).toBe(3);
    expect(route.correctedContradictions).toBe(2);
    expect(route.variablesResolved).toBe(2);
    expect(median(route.minutesToPlan)).toBe(60);
    expect(route.computeDollars).toBe(0);
    expect(route.bytes).toBeGreaterThan(0);
  });

  it('prices a GPU pod screen at its share of billed pod spend, and leaves an unpriced pod unknown', async () => {
    expect(dollarsPerCall(null, 0)).toEqual({ pod: 0 });
    expect(dollarsPerCall({ dollars: 2, unpricedRunningSamples: 0 }, 4)).toEqual({ pod: 0.5 });
    expect(dollarsPerCall({ dollars: 2, unpricedRunningSamples: 1 }, 4)).toEqual({ pod: null });
    expect(dollarsPerCall(null, 4)).toEqual({ pod: null });

    const src = `pod-${tag}`;
    await pull(src, true, 2, 2, 3);
    const a = await item(src, 1, 3);
    await item(src, 2, 3);
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, 'runpod/qwen', 1, ?, NULL, ?)`,
      [`cr_${tag}_pod`, `hp_${a}`, a, JSON.stringify({ verdict: 'KEEP' }), at(1)],
    );
    const priced = (await readAcquisitionMeasures(SINCE, NOW.toISOString(), [], async () => ({ dollars: 3, unpricedRunningSamples: 0 }))).find((s) => s.source === src)!;
    expect(priced.dollarsPerUsefulFinding).toEqual(m(3));
    const unpriced = (await readAcquisitionMeasures(SINCE, NOW.toISOString(), [], async () => ({ dollars: 3, unpricedRunningSamples: 2 }))).find((s) => s.source === src)!;
    expect(unpriced.dollarsPerUsefulFinding).toEqual(nm(UNMEASURED_REASONS.dollarsUnpriced));
    expect((await readRouteAttribution(SINCE, NOW.toISOString(), async () => ({ dollars: 3, unpricedRunningSamples: 0 }))).get(src)!.computeDollars).toBe(3);
  });

  it('counts a record\'s bytes as stored, and a link only when payer, price and fulfillment are all settled', async () => {
    expect(recordBytes({ url: 'ab', title: 'é', body: null, organization: null })).toBe(4);
    expect(isVerifiedLink({ payer: 'A', price_cents: 100, fulfillment_owner: null, delivery_method: 'email' })).toBe(true);
    expect(isVerifiedLink({ payer: 'A', price_cents: null, fulfillment_owner: 'B', delivery_method: null })).toBe(false);
    expect(isVerifiedLink({ payer: null, price_cents: 100, fulfillment_owner: 'B', delivery_method: null })).toBe(false);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
    expect((await readSourceAttribution([], NOW.toISOString())).size).toBe(0);
  });
});
