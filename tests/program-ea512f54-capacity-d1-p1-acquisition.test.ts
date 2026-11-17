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
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { newId } from '../server/repos/util.ts';
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
  median,
  readAcquisitionMeasures,
  readSourceOutcomeLinks,
  recordAcquisitionMeasures,
  recordBytes,
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
    // The downstream measures are read from the linkage rows, never NOT_MEASURED by construction.
    expect(one.rawBytes.measured && one.rawBytes.value).toBeGreaterThan(0);
    expect(one.acceptedEvidence).toEqual(m(0));
    expect(one.verifiedBuyerPriceFulfillmentLinks).toEqual(m({ buyer: 0, price: 0, fulfillment: 0, complete: 0 }));
    expect(one.timeToGoalImpactMinutes).toEqual(m(null));
    expect(one.revenue).toEqual(m(0));
    // The screens ran on 'free-a', which no row prices: the cost is unknown, and said so — never $0.
    expect(one.dollarsPerUsefulFinding).toEqual(nm(UNMEASURED_REASONS.dollarsPerUsefulFinding));
    await getDb().run(`INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('free-a', 2, 1, ?, 'test')`, [at(1)]);
    const priced = (await readAcquisitionMeasures(SINCE, NOW.toISOString(), [])).find((s) => s.source === src)!;
    expect(priced.dollarsPerUsefulFinding).toEqual(m(0));
  });

  it('measures bytes, accepted evidence, verified links, time to goal impact, cost and revenue through the linkage rows', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layerId = fixture.layers[0]!.id;
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
    const orch = await createOrchestration({ projectId, layerId, runId: run.id, title: 'linkage', assignment: 'linkage', provider: 'WORKER' });
    const src = `linked-${tag}`;
    await pull(src, true, 2, 2, 6);
    const a = await item(src, 1, 6, { shortlisted: true });
    const b = await item(src, 2, 6);
    await screen(a, true);
    await getDb().run(`INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('free-a', 2, 1, ?, 'test')`, [at(1)]);
    const claimRow = async (id: string, url: string, validation: string, contradiction: string) => getDb().run(
      `INSERT INTO research_claims (id, orchestration_id, pass_key, claim, source_url, evidence_excerpt, confidence,
         contradiction_state, validation_state, content_hash, created_at)
       VALUES (?, ?, 'RESEARCH', 'A buyer pays $500 a month', ?, 'Budget $500 per month', 0.9, ?, ?, ?, ?)`,
      [id, orch.id, url, contradiction, validation, `hash-${id}`, at(5)],
    );
    await claimRow(`cl_${tag}_1`, `https://feed.test/${src}/1`, 'SOURCED', 'SUPPORTED');
    await claimRow(`cl_${tag}_2`, `https://feed.test/${src}/2`, 'SOURCED', 'REFUTED');
    await claimRow(`cl_${tag}_3`, `https://elsewhere.test/x`, 'SOURCED', 'UNCHALLENGED');
    const cashMode = newId('cm');
    await getDb().run(
      `INSERT INTO cash_modes (id, project_id, owner_user_id, objective, horizon_days, envelope_id, state, activated_at, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'u', 'cash', 30, 'env', 'ACTIVE', ?, 'u', ?, ?)`,
      [cashMode, projectId, at(10), at(10), at(10)],
    );
    const opp = newId('opp');
    await getDb().run(
      `INSERT INTO cash_opportunities (id, project_id, cash_mode_id, owner_user_id, title, mechanism, currency, required_capabilities, state,
         payer, price_cents, fulfillment_owner, discovery_round_id, validation_state, created_at, updated_at)
       VALUES (?, ?, ?, 'u', 'Bookkeeping for Acme', 'SERVICE', 'USD', '[]', 'DISCOVERED', 'Acme Dental LLC', 50000, 'BRAIN', ?, 'COMPLETE', ?, ?)`,
      [opp, projectId, cashMode, `rnd_${tag}`, at(5), at(5)],
    );
    const path = `mp_${tag}`;
    await getDb().run(
      `INSERT INTO monetization_paths (id, project_id, opportunity_id, method, title, origin, created_at, updated_at) VALUES (?, ?, ?, 'SERVICE', 'Bookkeeping', 'ENUMERATED', ?, ?)`,
      [path, projectId, opp, at(5), at(5)],
    );
    await getDb().run(
      `INSERT INTO monetization_path_facts (id, project_id, path_id, attribute, kind, value, claim_id, decided_by, created_at, updated_at)
       VALUES (?, ?, ?, 'expectedRevenue', 'EVIDENCE', '$500 a month', ?, 'BRAIN', ?, ?)`,
      [`mpf_${tag}`, projectId, path, `cl_${tag}_1`, at(4), at(4)],
    );
    const money = async (kind: string, cents: number) => getDb().run(
      `INSERT INTO cash_money_entries (id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference, occurred_at, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'USD', 'stripe:test', ?, 'u', ?)`,
      [newId('cme'), projectId, opp, kind, cents, at(2), at(2)],
    );
    await money('CUSTOMER_PAYMENT', 50000);
    await money('REFUND', 10000);

    const one = (await readAcquisitionMeasures(SINCE, NOW.toISOString(), [])).find((s) => s.source === src)!;
    expect(one.rawBytes).toEqual(m(recordBytes({ url: `https://feed.test/${src}/1`, title: `Hiring a contract bookkeeper for monthly reconciliation 1`, body: 'We need a freelance bookkeeper to reconcile accounts monthly. Budget $500 per month.', organization: 'Acme Dental LLC' })
      + recordBytes({ url: `https://feed.test/${src}/2`, title: `Hiring a contract bookkeeper for monthly reconciliation 2`, body: 'We need a freelance bookkeeper to reconcile accounts monthly. Budget $500 per month.', organization: 'Acme Dental LLC' })));
    // The refuted claim is not accepted; the claim citing another site is not this source's.
    expect(one.acceptedEvidence).toEqual(m(1));
    expect(one.verifiedBuyerPriceFulfillmentLinks).toEqual(m({ buyer: 1, price: 1, fulfillment: 1, complete: 1 }));
    // Item 1 arrived 6 h ago; its opportunity opened 5 h ago, before the plan fact (4 h ago): 60 minutes.
    expect(one.timeToGoalImpactMinutes).toEqual(m(60));
    expect(one.dollarsPerUsefulFinding).toEqual(m(0));
    expect(one.revenue).toEqual(m(400));
    void b;

    const links = (await readSourceOutcomeLinks([{ id: a, source: src, url: `https://feed.test/${src}/1`, title: 't', body: null, organization: null, fetched_at: at(6), shortlisted_round_id: `rnd_${tag}` }])).get(src)!;
    expect(links.variablesResolved).toBe(1);
    expect(links.economicRelationships).toBe(1);
    expect(links.settledContradictions).toBe(1);
    expect(links.screenCalls).toBe(1);
  });

  it('the median of an empty list is null, never zero', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
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
