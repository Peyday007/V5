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
import {
  CAPACITY_CONTRIBUTION_EVENT,
  CONTRIBUTION_MEASURE_KEYS,
  buildContributionReport,
  compareContributions,
  decideComponent,
  detectorReadings,
  extractionGapsFromYields,
  minutesToVerification,
  parserReadings,
  planGap,
  poolReadings,
  readContribution,
  recordContribution,
  routeReadings,
  type ComponentReading,
  type ContributionMeasures,
  type ContributionReport,
} from '../server/services/freeLane/contribution.ts';

const ok = <T = number>(value: T) => ({ measured: true as const, value });
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

  it('a source under a permission need does not get code or model extraction chosen over it', () => {
    const [gap] = extractionGapsFromYields([{ source: 's1', acquired: 10, accepted: 4, usable: 1, acceptedShare: 0.4, usableShare: 0.1, value: 0.6 }], new Set(['s1']));
    const plan = planGap(gap!);
    expect(plan.excluded.map((e) => e.method)).toContain('code parser for the source');
    expect(plan.chosen).toBeNull();
  });
});

describe('readings from rows', () => {
  it('model routes: errors, AI calls per finding, free provider $0, failing route named', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => ({ outcome: 'SUBMITTED', reason: 'model free/a', durationMs: 1000, measures: JSON.stringify({ usage: { modelCalls: 2, modelCallsAvoided: 1, cpuMicros: 500_000 } }) })),
      ...Array.from({ length: 6 }, () => ({ outcome: 'FAILED_RETRYABLE', reason: 'model free/b: model call failed [provider availability] 503', durationMs: 100, measures: null })),
    ];
    const r = routeReadings(rows, null, 3);
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

      await recordContribution(new Date(now));
      const row = await db.get<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1`, [CAPACITY_CONTRIBUTION_EVENT]);
      expect(row?.outcome).toBe('REPAIR_FIRST');
    });

    it('measures time to a verified candidate and cash outcomes from the opportunity and money rows', async () => {
      const db = getDb();
      const now = Date.now();
      const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
      const empty = await readContribution({ now });
      // Nothing verified and no money yet: measured, and said as null / zero, never NOT_MEASURED.
      expect(empty.system.minutesToVerifiedCandidate).toEqual(ok(null));
      expect(empty.system.cashOutcomes).toEqual(ok(0));

      const project = (await db.get<{ id: string }>(`SELECT id FROM projects LIMIT 1`))!.id;
      const cashMode = newId('cm');
      await db.run(
        `INSERT INTO cash_modes (id, project_id, owner_user_id, objective, horizon_days, envelope_id, state, activated_at, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'u', 'cash', 30, 'env', 'ACTIVE', ?, 'u', ?, ?)`,
        [cashMode, project, iso(10 * 3_600_000), iso(10 * 3_600_000), iso(10 * 3_600_000)],
      );
      const opp = async (signalMsAgo: number, settledMsAgo: number, state: string) => {
        const id = newId('opp');
        await db.run(
          `INSERT INTO cash_opportunities (id, project_id, cash_mode_id, owner_user_id, title, mechanism, currency, required_capabilities, state,
             signal_observed_at, validation_state, validation_settled_at, created_at, updated_at)
           VALUES (?, ?, ?, 'u', 'An opening', 'SERVICE', 'USD', '[]', 'DISCOVERED', ?, ?, ?, ?, ?)`,
          [id, project, cashMode, iso(signalMsAgo), state, iso(settledMsAgo), iso(signalMsAgo), iso(signalMsAgo)],
        );
        return id;
      };
      const verified = await opp(3 * 3_600_000, 3_600_000, 'COMPLETE'); // 120 minutes
      await opp(5 * 3_600_000, 3_600_000, 'COMPLETE'); // 240 minutes
      await opp(2 * 3_600_000, 3_600_000, 'BLOCKED'); // not verified
      const money = (kind: string, cents: number) => db.run(
        `INSERT INTO cash_money_entries (id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference, occurred_at, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'USD', 'stripe:test', ?, 'u', ?)`,
        [newId('cme'), project, verified, kind, cents, iso(60_000), iso(60_000)],
      );
      await money('CUSTOMER_PAYMENT', 25_000);
      await money('REFUND', 5_000);
      await money('COST', 1_000);

      const report = await readContribution({ now });
      expect(report.system.minutesToVerifiedCandidate).toEqual(ok(180));
      expect(report.system.cashOutcomes).toEqual(ok(20_000));
    });
  });
});

describe('minutesToVerification', () => {
  it('is the median from first signal (else opening) to verification, null with none', () => {
    expect(minutesToVerification([])).toBeNull();
    expect(minutesToVerification([
      { signal_observed_at: null, created_at: '2026-11-17T00:00:00.000Z', validation_settled_at: '2026-11-17T00:30:00.000Z' },
      { signal_observed_at: '2026-11-17T00:00:00.000Z', created_at: '2026-11-17T01:00:00.000Z', validation_settled_at: '2026-11-17T01:30:00.000Z' },
    ])).toBe(60);
  });
});
