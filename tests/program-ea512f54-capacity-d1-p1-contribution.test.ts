/**
 * CAP-19-5: scale decisions from measured contribution per parser, detector,
 * worker and model route. Every S-0230 measure is present per component as
 * measured or not; a failing provider/GPU is REPAIR and never an app server;
 * added capacity needs measured saturation of a working path or a measured
 * marginal gain; provisioned concurrency is not throughput; unknowns are gaps
 * with the highest-value permitted way to obtain them; and the reading is built
 * from real rows and recorded as one CAPACITY_CONTRIBUTION event.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import {
  CAPACITY_CONTRIBUTION_EVENT,
  CONTRIBUTION_MEASURE_KEYS,
  buildContributionReport,
  compareContributions,
  decideComponent,
  detectorReadings,
  CONTACT_CALLS,
  PARSER_BUILD_CALLS,
  extractionGaps,
  modelCallsPerAnswer,
  openingGaps,
  permittedActionsByProject,
  type GapContext,
  type OpeningCardRow,
  parserReadings,
  planGap,
  poolReadings,
  readContribution,
  recordContribution,
  routeReadings,
  storedContribution,
  waitingByPool,
  type ComponentReading,
  type ContributionMeasures,
  type ContributionReport,
} from '../server/services/freeLane/contribution.ts';
import { readCapacityDecisions, STORED_MEASURES_MAX_BYTES } from '../server/services/freeLane/stageCapacity.ts';
import { recordBinEvent } from '../server/repos/bins.ts';

const ok = (value: number) => ({ measured: true as const, value });
const NOT = (reason: string) => ({ measured: false as const, reason });

function measures(over: Partial<ContributionMeasures> = {}): ContributionMeasures {
  const m = {} as ContributionMeasures;
  for (const k of CONTRIBUTION_MEASURE_KEYS) m[k] = NOT('test');
  return { ...m, ...over };
}

function reading(over: Partial<ComponentReading> = {}): ComponentReading {
  return {
    kind: 'MODEL_ROUTE', id: 'groq/x', provisioned: null,
    usefulOutput: ok(10), cost: ok(0), downstreamEffect: ok(0), workWaiting: ok(5), failing: null,
    measures: measures(), ...over,
  };
}

describe('decideComponent', () => {
  it('a failing provider or GPU route is REPAIR, never a larger application server', () => {
    for (const cause of ['provider availability', 'broken GPU', 'credentials'] as const) {
      const d = decideComponent(reading({ failing: { cause, failures: 7 }, measures: measures({ saturation: ok(1) }) }));
      expect(d.verdict).toBe('REPAIR');
      expect(d.hardwareJustified).toBe(false);
      expect(d.recommendation).toMatch(/larger application server does not repair it/);
    }
  });

  it('provisioned concurrency with no accepted output is not throughput and never scales', () => {
    const d = decideComponent(reading({ kind: 'WORKER', provisioned: 16, usefulOutput: ok(0), measures: measures({ saturation: ok(1) }) }));
    expect(d.verdict).toBe('HOLD');
    expect(d.basis).toBe('PROVISIONED_NOT_PRODUCTIVE');
    expect(d.hardwareJustified).toBe(false);
  });

  it('cost without output is RETIRE', () => {
    expect(decideComponent(reading({ usefulOutput: ok(0), cost: ok(3.2) })).verdict).toBe('RETIRE');
  });

  it('an unmeasured output is measured before it is judged', () => {
    const d = decideComponent(reading({ usefulOutput: NOT('no rows') }));
    expect(d.verdict).toBe('MEASURE');
    expect(d.hardwareJustified).toBe(false);
  });

  it('scales only on measured saturation of a working path with work waiting', () => {
    expect(decideComponent(reading({ measures: measures({ saturation: ok(0.95) }) })).verdict).toBe('SCALE');
    expect(decideComponent(reading({ measures: measures({ saturation: ok(0.95) }), workWaiting: ok(0) })).verdict).toBe('HOLD');
    expect(decideComponent(reading({ measures: measures({ saturation: ok(0.4) }) })).verdict).toBe('HOLD');
    expect(decideComponent(reading({ measures: measures({ saturation: NOT('unread') }) })).verdict).toBe('HOLD');
  });

  it('compares each component against its kind: above-median contribution per dollar with work waiting is a marginal gain', () => {
    const cheap = reading({ id: 'gpu-a', usefulOutput: ok(40), cost: ok(1) });
    const dear = reading({ id: 'gpu-b', usefulOutput: ok(4), cost: ok(2) });
    const mid = reading({ id: 'gpu-c', usefulOutput: ok(10), cost: ok(1) });
    const decisions = compareContributions([cheap, dear, mid]);
    expect(decisions.find((d) => d.id === 'gpu-a')).toMatchObject({ verdict: 'SCALE', basis: 'MARGINAL_GAIN', hardwareJustified: true });
    expect(decisions.find((d) => d.id === 'gpu-b')!.verdict).toBe('HOLD');
    expect(decisions.find((d) => d.id === 'gpu-a')!.contributionPerDollar).toBe(40);
  });
});

describe('a free route is not scaled on a priced peer and the lane-wide queue (finding F9)', () => {
  it('a $0 route with output is not a MARGINAL_GAIN just because a priced route sets a median', () => {
    const free = reading({ id: 'groq/x', usefulOutput: ok(50), cost: ok(0), workWaiting: ok(9) });
    const gpuA = reading({ id: 'runpod/a', usefulOutput: ok(10), cost: ok(1) });
    const gpuB = reading({ id: 'runpod/b', usefulOutput: ok(4), cost: ok(2) });
    const d = compareContributions([free, gpuA, gpuB]).find((x) => x.id === 'groq/x')!;
    expect(d.verdict).toBe('HOLD');
    expect(d.basis).toBe('NO_MARGINAL_MEASURE');
    expect(d.hardwareJustified).toBe(false);
  });

  it('a $0 route still scales on its own measured saturation with its own work waiting', () => {
    const d = decideComponent(reading({ cost: ok(0), workWaiting: ok(4), measures: measures({ saturation: ok(0.95) }) }), 2);
    expect(d).toMatchObject({ verdict: 'SCALE', basis: 'MEASURED_SATURATION' });
  });

  it('each route reads its own pool\'s waiting count, never the lane-wide queue', () => {
    const rows = [
      { outcome: 'SUBMITTED', reason: 'model free/a', durationMs: 10, measures: null },
      { outcome: 'SUBMITTED', reason: 'model free/c', durationMs: 10, measures: null },
    ];
    const waiting = waitingByPool([
      { model: 'free/a', reason: '2 -> 4', measures: JSON.stringify({ busy: 2, waiting: 0 }) },
      { model: 'free/b', reason: '2 -> 4', measures: JSON.stringify({ busy: 2, waiting: 7 }) },
      { model: 'free/c', reason: '2 -> 4', measures: JSON.stringify({ busy: 2 }) },
    ]);
    const r = routeReadings(rows, null, waiting);
    expect(r.find((x) => x.id === 'free/a')!.workWaiting).toEqual(ok(0));
    expect(r.find((x) => x.id === 'free/c')!.workWaiting.measured).toBe(false);
    for (const x of r) expect(decideComponent(x, 1).hardwareJustified).toBe(false);
  });
});

describe('gaps', () => {
  it('chooses the highest-value permitted way and never one that crosses access or contact permission', () => {
    const plan = planGap({
      subject: 'MARKET_DEMAND', key: 'any-industry', count: 3,
      ways: [
        { method: 'cold email buyers', value: 100, cost: 1, accessPermitted: true, contacts: true, contactPermitted: false },
        { method: 'scrape a forbidden portal', value: 90, cost: 0, accessPermitted: false, contacts: false, contactPermitted: false },
        { method: 'public procurement records', value: 20, cost: 2, accessPermitted: true, contacts: false, contactPermitted: false },
        { method: 'stored-row join', value: 5, cost: 0, accessPermitted: true, contacts: false, contactPermitted: false },
      ],
    });
    expect(plan.chosen!.method).toBe('stored-row join');
    expect(plan.excluded.map((e) => e.method).sort()).toEqual(['cold email buyers', 'scrape a forbidden portal']);
  });

  it('a gap with no permitted way stays open and is reported, not filled', () => {
    const plan = planGap({ subject: 'PAYMENT_TIMING', key: 'x', count: 1, ways: [{ method: 'ask buyer', value: 9, cost: 1, accessPermitted: true, contacts: true, contactPermitted: false }] });
    expect(plan.chosen).toBeNull();
    expect(plan.reason).toMatch(/no permitted way/);
  });

  const ctx = (over: Partial<GapContext> = {}): GapContext => ({ permissionNeeds: new Set(), callsPerAnswer: ok(2), providerContactPermitted: false, ...over });

  it('a source under a permission need does not get code or model extraction chosen over it', () => {
    const [gap] = extractionGaps([{ source: 's1', stored: 10, screened: 4, unread: 6 }], ctx({ permissionNeeds: new Set(['s1']) }));
    const plan = planGap(gap!);
    expect(plan.excluded.map((e) => e.method)).toContain('code parser for the source');
    expect(plan.chosen).toBeNull();
  });

  it('counts only records nothing has read: a screened DROP is known, not an extraction unknown (review F5)', () => {
    // 10 stored, all 10 screened (most of them DROP): no gap at all.
    expect(extractionGaps([{ source: 's1', stored: 10, screened: 10, unread: 0 }], ctx())).toEqual([]);
    expect(extractionGaps([{ source: 's1', stored: 10, screened: 7, unread: 3 }], ctx())[0]!.count).toBe(3);
  });

  it('chooses the extraction way from the measurements, not a fixed order (review F5)', () => {
    // Few unread records at 2 measured calls each: a model reading them beats building a parser.
    const few = planGap(extractionGaps([{ source: 's1', stored: 5, screened: 0, unread: 5 }], ctx())[0]!);
    expect(few.chosen!.method).toBe('model assistance on unread records');
    // Many unread records: one parser build serves them all.
    const many = planGap(extractionGaps([{ source: 's1', stored: 500, screened: 0, unread: 500 }], ctx())[0]!);
    expect(many.chosen!.method).toBe('code parser for the source');
    expect(PARSER_BUILD_CALLS).toBeGreaterThan(0);
    // Model calls per answer not measured: the model way is excluded with the reason, never assumed cheap.
    const blind = planGap(extractionGaps([{ source: 's1', stored: 5, screened: 0, unread: 5 }], ctx({ callsPerAnswer: NOT('no route measured') }))[0]!);
    expect(blind.chosen!.method).toBe('code parser for the source');
    expect(blind.excluded.find((e) => e.method === 'model assistance on unread records')!.reason).toContain('no route measured');
  });

  it('asks the provider for structured access only where a live authority permits it, and then prefers it (review F5)', () => {
    const refused = planGap(extractionGaps([{ source: 's1', stored: 500, screened: 0, unread: 500 }], ctx())[0]!);
    expect(refused.excluded.map((e) => e.method)).toContain('request structured access from the provider');
    const allowed = planGap(extractionGaps([{ source: 's1', stored: 500, screened: 0, unread: 500 }], ctx({ providerContactPermitted: true }))[0]!);
    expect(allowed.chosen!.method).toBe('request structured access from the provider');
  });

  const card = (over: Partial<OpeningCardRow> = {}): OpeningCardRow => ({
    projectId: 'p1', mechanism: 'ANY_MECHANISM', payer: 'a payer', reachableChannel: 'email', buyingSignal: 'a signal',
    paymentTerms: 'net 30', fulfillmentOwner: 'us', deliveryMethod: 'file', ...over,
  });

  it('exposes relationship, market demand, delivery capability and payment timing gaps from open evidence cards (review F5)', () => {
    const gaps = openingGaps(
      [card({ payer: null }), card({ buyingSignal: ' ' }), card({ deliveryMethod: null }), card({ paymentTerms: null }), card({ paymentTerms: null, mechanism: 'OTHER' }), card()],
      new Map(), ok(2),
    );
    expect(gaps.map((g) => `${g.subject}@${g.key}x${g.count}`).sort()).toEqual([
      'DELIVERY_CAPABILITY@p1:ANY_MECHANISMx1',
      'MARKET_DEMAND@p1:ANY_MECHANISMx1',
      'PAYMENT_TIMING@p1:ANY_MECHANISMx1',
      'PAYMENT_TIMING@p1:OTHERx1',
      'RELATIONSHIP@p1:ANY_MECHANISMx1',
    ]);
    // A complete card exposes nothing.
    expect(openingGaps([card()], new Map(), ok(2))).toEqual([]);
  });

  it('chooses research or contact by measured cost, and contact only under the project\'s own permission (review F5)', () => {
    const rows = [card({ paymentTerms: null })];
    // No permission: research, whatever it costs.
    expect(planGap(openingGaps(rows, new Map(), ok(CONTACT_CALLS * 4))[0]!).chosen!.method).toBe('research question through the free lane');
    // Permission held and research cheaper than a contact: research.
    const allowed = new Map([['p1', new Set(['CONTACT_BUYER'])]]);
    expect(planGap(openingGaps(rows, allowed, ok(1))[0]!).chosen!.method).toBe('research question through the free lane');
    // Permission held and research measured dearer than a contact: ask the buyer.
    expect(planGap(openingGaps(rows, allowed, ok(CONTACT_CALLS * 4))[0]!).chosen!.method).toBe('ask the buyer');
    // Another project's permission does not reach this one.
    const elsewhere = new Map([['p2', new Set(['CONTACT_BUYER'])]]);
    expect(planGap(openingGaps(rows, elsewhere, ok(CONTACT_CALLS * 4))[0]!).excluded.map((e) => e.method)).toContain('ask the buyer');
    // Delivery capability needs ENGAGE_CONTRACTOR, not CONTACT_BUYER.
    const delivery = planGap(openingGaps([card({ fulfillmentOwner: null })], allowed, ok(CONTACT_CALLS * 4))[0]!);
    expect(delivery.excluded.map((e) => e.method)).toContain('ask a fulfilment provider');
  });

  it('reads permitted actions from live authorities only: allowed, not prohibited, started, not expired', () => {
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    const permitted = permittedActionsByProject([
      { projectId: 'p1', allowedActions: '["CONTACT_BUYER","ENGAGE_CONTRACTOR"]', prohibitions: '["ENGAGE_CONTRACTOR"]', startsAt: '2026-11-01T00:00:00.000Z', expiresAt: null },
      { projectId: 'p2', allowedActions: '["CONTACT_BUYER"]', prohibitions: '[]', startsAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-10T00:00:00.000Z' },
      { projectId: 'p3', allowedActions: '["CONTACT_BUYER"]', prohibitions: '[]', startsAt: '2026-12-01T00:00:00.000Z', expiresAt: null },
      { projectId: 'p4', allowedActions: 'not json', prohibitions: '[]', startsAt: '2026-11-01T00:00:00.000Z', expiresAt: null },
    ], now);
    expect([...permitted.get('p1')!]).toEqual(['CONTACT_BUYER']);
    expect(permitted.has('p2')).toBe(false);
    expect(permitted.has('p3')).toBe(false);
    expect([...permitted.get('p4')!]).toEqual([]);
  });

  it('prices a model answer at the median measured calls per finding across routes, or says it is unmeasured', () => {
    const route = (id: string, calls: ReturnType<typeof ok> | ReturnType<typeof NOT>) => reading({ id, measures: measures({ aiCallsPerUsefulFinding: calls }) });
    expect(modelCallsPerAnswer([route('a', ok(1)), route('b', ok(3)), route('c', ok(9))])).toEqual(ok(3));
    expect(modelCallsPerAnswer([route('a', NOT('x'))]).measured).toBe(false);
  });
});

describe('readings from rows', () => {
  it('model routes: errors, AI calls per finding, free provider $0, failing route named', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => ({ outcome: 'SUBMITTED', reason: 'model free/a', durationMs: 1000, measures: JSON.stringify({ usage: { modelCalls: 2, modelCallsAvoided: 1, cpuMicros: 500_000 } }) })),
      ...Array.from({ length: 6 }, () => ({ outcome: 'FAILED_RETRYABLE', reason: 'model free/b: model call failed [provider availability] 503', durationMs: 100, measures: null })),
    ];
    const r = routeReadings(rows, null, new Map([['free/a', 3]]));
    const a = r.find((x) => x.id === 'free/a')!;
    const b = r.find((x) => x.id === 'free/b')!;
    expect(a.measures.aiCallsPerUsefulFinding).toEqual(ok(2));
    expect(a.cost).toEqual(ok(0));
    expect(a.downstreamEffect).toEqual(ok(4));
    expect(b.failing?.cause).toBe('provider availability');
    expect(b.measures.errorRate).toEqual(ok(1));
    for (const x of r) for (const k of CONTRIBUTION_MEASURE_KEYS) expect(x.measures[k]).toHaveProperty('measured');
  });

  it('worker pools: saturation and idle share from the capacity row; output is what they accepted', () => {
    const [w] = poolReadings([{ model: 'free/a', reason: '4 -> 8: grow', measures: JSON.stringify({ busy: 2, peakBusy: 8, waiting: 9 }) }], new Map([['free/a', 0]]));
    expect(w!.provisioned).toBe(8);
    expect(w!.measures.saturation).toEqual(ok(1));
    expect(w!.measures.idleShare).toEqual(ok(0.75));
    expect(decideComponent(w!).verdict).toBe('HOLD');
  });

  it('detectors: ACTIVE coverage is model calls avoided downstream; SHADOW avoids nothing yet', () => {
    const [active, shadow] = detectorReadings([
      { ruleId: 'hiring', ruleVersion: 2, mode: 'ACTIVE', detections: 3, covered: 30, leads: 2 },
      { ruleId: 'tender', ruleVersion: 1, mode: 'SHADOW', detections: 5, covered: 0, leads: 0 },
    ], 12);
    expect(active!.downstreamEffect).toEqual(ok(30));
    expect(active!.measures.codeDerivedMatches).toEqual(ok(3));
    expect(shadow!.downstreamEffect.measured).toBe(false);
  });

  it('parsers: parse, dedup and error coverage per source', () => {
    const [p] = parserReadings(
      [{ source: 'feed-x', acquired: 20, accepted: 5, usable: 1, acceptedShare: 0.25, usableShare: 0.05, value: 0.35 }],
      new Map([['feed-x', { pulls: 4, failed: 1, fetched: 40, inserted: 20 }]]),
    );
    expect(p!.measures.parseCoverage).toEqual(ok(0.25));
    expect(p!.measures.dedupCoverage).toEqual(ok(0.5));
    expect(p!.measures.errorRate).toEqual(ok(0.25));
  });

  it('a pending repair withholds every hardware justification', () => {
    const report = buildContributionReport({
      since: 'a', until: 'b', gaps: [],
      system: { minutesToVerifiedCandidate: NOT('x'), offerReadyPathways: NOT('x'), cashOutcomes: NOT('x') },
      components: [
        reading({ id: 'ok', measures: measures({ saturation: ok(0.99) }) }),
        reading({ id: 'bad', failing: { cause: 'broken GPU', failures: 4 } }),
      ],
    });
    expect(report.repairsFirst).toEqual(['MODEL_ROUTE:bad']);
    expect(report.hardwareJustifiedFor).toEqual([]);
  });
});

describe('recordContribution', () => {
  it('writes one CAPACITY_CONTRIBUTION row carrying the decisions', async () => {
    const recorded: { eventType: string; outcome?: string | null; measures?: Record<string, unknown> }[] = [];
    const report: ContributionReport = buildContributionReport({
      since: 'a', until: 'b', gaps: [],
      system: { minutesToVerifiedCandidate: NOT('x'), offerReadyPathways: ok(1), cashOutcomes: NOT('x') },
      components: [reading({ measures: measures({ saturation: ok(0.9) }) })],
    });
    await recordContribution(new Date(), async (e) => { recorded.push(e); }, async () => report);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.eventType).toBe(CAPACITY_CONTRIBUTION_EVENT);
    expect(recorded[0]!.outcome).toBe('SCALE_JUSTIFIED');
    expect((recorded[0]!.measures as { counts: Record<string, number> }).counts.SCALE).toBe(1);
  });

  describe('against a real database', () => {
    beforeEach(async () => {
      await freshProject();
    });

    it('reads components from bin_events and feed rows and records the reading', async () => {
      const db = getDb();
      const now = Date.now();
      const at = new Date(now - 60_000).toISOString();
      const insert = (type: string, outcome: string, reason: string, measures: object, workload: string | null = null) =>
        db.run(
          `INSERT INTO bin_events (id, event_type, at, measures, outcome, reason, is_proxy, workload_class) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [newId('bev'), type, at, JSON.stringify(measures), outcome, reason, workload],
        );
      for (let i = 0; i < 3; i += 1) await insert('FREE_LANE_ITEM', 'SUBMITTED', 'model free/a', { usage: { modelCalls: 1 } }, 'RESEARCH_FRAGMENT');
      for (let i = 0; i < 5; i += 1) await insert('FREE_LANE_ITEM', 'FAILED_RETRYABLE', 'model free/b: model call failed [credentials] 401', {}, 'RESEARCH_FRAGMENT');
      await insert('FREE_LANE_CAPACITY', 'GROW', '2 -> 4: useful work waiting', { busy: 4, peakBusy: 4, waiting: 6 }, 'free/a');
      await db.run(`INSERT INTO feed_pulls (id, source, ok, fetched, inserted, error, created_at) VALUES (?, 'feed-x', 1, 10, 6, NULL, ?)`, [newId('fp'), at]);

      const report = await readContribution({ now });
      const route = report.decisions.find((d) => d.kind === 'MODEL_ROUTE' && d.id === 'free/b');
      expect(route?.verdict).toBe('REPAIR');
      expect(report.decisions.find((d) => d.kind === 'WORKER' && d.id === 'free/a')).toBeDefined();
      expect(report.repairsFirst).toContain('MODEL_ROUTE:free/b');
      expect(report.hardwareJustifiedFor).toEqual([]);
      expect(report.components.find((c) => c.kind === 'MODEL_ROUTE' && c.id === 'free/a')!.workWaiting).toEqual(ok(6));

      await recordContribution(new Date(now));
      const row = await db.get<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [CAPACITY_CONTRIBUTION_EVENT]);
      expect(row?.outcome).toBe('REPAIR_FIRST');
    });

    it('exposes every gap subject from real rows: unread feed records and blank evidence cards (review F5)', async () => {
      const db = getDb();
      const at = new Date(Date.now() - 60_000).toISOString();
      const source = `gap-src-${Math.random().toString(36).slice(2, 8)}`;
      await insertFeedItems(source, ['dropped', 'unread', 'covered'].map((externalId) => ({ externalId, url: `https://gap.test/${source}/${externalId}`, title: externalId, body: null, organization: null, publishedAt: at })));
      const items = new Map((await db.all<{ id: string; external_id: string }>(`SELECT id, external_id FROM feed_items WHERE source = ?`, [source])).map((r) => [r.external_id, r.id]));
      await db.run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, 'm', 1, ?, NULL, ?)`,
        [newId('cr'), `h-${source}`, items.get('dropped')!, JSON.stringify({ verdict: 'DROP', reason: 'irrelevant' }), at],
      );
      await db.run(`INSERT INTO feed_item_coverage (item_id, detection_id, covered_at) VALUES (?, ?, ?)`, [items.get('covered')!, `fd-${source}`, at]);

      const projectId = (await getDb().get<{ id: string }>(`SELECT id FROM projects ORDER BY created_at DESC LIMIT 1`))!.id;
      const userId = (await createUser({ email: `gaps-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
      expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
      const cashModeId = (await getCashMode(projectId))!.id;
      await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: 'An opening with a blank card', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
        requiredCapabilities: ['PRODUCE_SPREADSHEET'],
      });

      // The window ends after the items were stored (fetched_at is their insert time).
      const report = await readContribution({ now: Date.now() + 1_000 });
      const extraction = report.gaps.filter((g) => g.subject === 'EXTRACTION' && g.key === source);
      // Three stored: the DROP is known and the covered one was read by a code rule, so one unknown.
      expect(extraction.map((g) => g.count)).toEqual([1]);
      const subjects = new Set(report.gaps.filter((g) => g.key.startsWith(`${projectId}:`)).map((g) => g.subject));
      expect([...subjects].sort()).toEqual(['DELIVERY_CAPABILITY', 'MARKET_DEMAND', 'PAYMENT_TIMING', 'RELATIONSHIP']);
      for (const g of report.gaps.filter((one) => one.key.startsWith(`${projectId}:`))) {
        // No contact permission is held, so no contact is ever chosen; the reason is on the record.
        expect(g.chosen?.method ?? '').not.toMatch(/^ask /);
        expect(g.excluded.some((e) => /^ask /.test(e.method))).toBe(true);
      }
    });
  });
});

describe('the hourly contribution row is bounded (finding F8)', () => {
  it('stores a bounded row however many components the window read, the controller holds first', async () => {
    const components = Array.from({ length: 2_000 }, (_, i) => reading({ id: `route-${i}`, workWaiting: ok(0) }));
    components.push(reading({ id: 'broken', failing: { cause: 'credentials', failures: 3 } }));
    const report = buildContributionReport({
      since: 'a', until: 'b', gaps: [],
      system: { minutesToVerifiedCandidate: NOT('x'), offerReadyPathways: ok(1), cashOutcomes: NOT('x') },
      components,
    });
    const recorded: { measures?: Record<string, unknown> }[] = [];
    const returned = await recordContribution(new Date(), async (e) => { recorded.push(e); }, async () => report);
    expect(returned.components).toHaveLength(2_001);
    const stored = recorded[0]!.measures!;
    // The contribution row carries the controller's decisions too, so its bound is twice a reading's.
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(2 * STORED_MEASURES_MAX_BYTES);
    expect((stored['decisions'] as { id: string; verdict: string }[])[0]).toMatchObject({ id: 'broken', verdict: 'REPAIR' });
    expect((stored['components'] as { id: string }[])[0]!.id).toBe('broken');
    expect(stored['totals']).toMatchObject({ components: 2_001, decisions: 2_001 });
    expect((stored['truncated'] as Record<string, { total: number }>)['components']!.total).toBe(2_001);
    expect(stored['repairsFirst']).toEqual(['MODEL_ROUTE:broken']);
    expect(storedContribution(report, { SCALE: 0, HOLD: 0, RETIRE: 0, REPAIR: 1, MEASURE: 0 })['counts']).toMatchObject({ REPAIR: 1 });
  });

  it('keeps the decisions the capacity controller holds growth on, read back from the real row', async () => {
    await freshProject();
    const components = Array.from({ length: 1_500 }, (_, i) => reading({ id: `route-${i}`, measures: measures({ saturation: ok(0.9) }) }));
    components.push(reading({ id: 'runpod/Org/broken', failing: { cause: 'broken GPU', failures: 2 } }));
    const report = buildContributionReport({
      since: 'a', until: 'b', gaps: [],
      system: { minutesToVerifiedCandidate: NOT('x'), offerReadyPathways: ok(1), cashOutcomes: NOT('x') },
      components,
    });
    await recordContribution(new Date(), recordBinEvent, async () => report);
    const decisions = await readCapacityDecisions();
    expect(decisions.contribution?.decisions[0]).toMatchObject({ id: 'runpod/Org/broken', verdict: 'REPAIR' });
    expect(decisions.contribution!.decisions.length).toBeGreaterThan(40);
    const row = await getDb().get<{ measures: string }>(`SELECT measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [CAPACITY_CONTRIBUTION_EVENT]);
    expect(row!.measures.length).toBeLessThanOrEqual(2 * STORED_MEASURES_MAX_BYTES);
  });
});
