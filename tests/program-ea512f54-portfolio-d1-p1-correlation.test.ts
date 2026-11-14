/**
 * PORT-05, review finding F6: stream correlations were entirely assumed. They
 * are now measured from the openings' own weekly cash on the ledger wherever
 * the record has enough overlapping weeks, the measurement reaches both the
 * stream reading and the coefficient the optimizer simulates the shared
 * outreach at, and a pair the record cannot measure still says ASSUMED.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_CO_MOVEMENT_WEEKS,
  measureCoMovement,
  pairKey,
  readCoMovement,
  refreshCoMovementIfDue,
  setCoMovement,
  cachedCoMovement,
  type CashObservation,
  type MeasuredCoMovement,
} from '../server/services/goals/coMovement.ts';
import { DEFAULT_RISK_CORRELATION, SHARED_OUTREACH_CORRELATION, evaluateGoalPortfolio, sharedOutreachCorrelation } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
function opening(id: string, over: Partial<ModelledOpportunity> = {}, index = 1): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}`, payer: null, reachableChannel: null, fulfillmentOwner: null } as unknown as ModelledOpportunity['opportunity'],
    index, tier: 'QUALIFIED', repeatable: true, price: fixed(1500), capital: fixed(60), hours: fixed(2), daysToCash: fixed(3), close: fixed(0.2),
    respond: fixed(0.02), directCost: fixed(100), volume: fixed(500), agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false,
    ...over,
  };
}
const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 400, seed: 7 };

const since = '2026-05-01T00:00:00.000Z';
const until = new Date(Date.parse('2026-05-01T00:00:00.000Z') + 13 * 7 * 86_400_000).toISOString();
const week = (i: number) => new Date(Date.parse(since) + i * 7 * 86_400_000 + 3_600_000).toISOString();

/** Two streams that rise and fall together, one that moves against them, and one with a single payment. */
function ledger(): CashObservation[] {
  const pattern = [100, 0, 300, 50, 400, 0, 250, 10, 500, 0, 200, 80, 350];
  const out: CashObservation[] = [];
  pattern.forEach((v, i) => {
    out.push({ opportunityId: 'a', at: week(i), amount: v });
    out.push({ opportunityId: 'b', at: week(i), amount: v * 2 + 5 });
    out.push({ opportunityId: 'c', at: week(i), amount: 600 - v });
  });
  out.push({ opportunityId: 'lone', at: week(12), amount: 900 });
  return out;
}

afterEach(() => setCoMovement(null));

describe('co-movement is measured from the ledger, and only where it can be', () => {
  it('measures streams that move together and against each other', () => {
    const m = measureCoMovement(ledger(), { since, until });
    expect(m.get(pairKey('a', 'b'))!.coefficient).toBeGreaterThan(0.9);
    expect(m.get(pairKey('a', 'c'))!.coefficient).toBeLessThan(-0.9);
    expect(m.get(pairKey('b', 'a'))).toBe(m.get(pairKey('a', 'b')));
    expect(m.get(pairKey('a', 'b'))!.weeks).toBeGreaterThanOrEqual(MIN_CO_MOVEMENT_WEEKS);
    // Bounded: never a certainty.
    for (const one of m.values()) expect(Math.abs(one.coefficient)).toBeLessThanOrEqual(0.95);
  });

  it('a stream with too few weeks, or a series that never varies, is not measured', () => {
    const m = measureCoMovement(ledger(), { since, until });
    expect(m.get(pairKey('a', 'lone'))).toBeUndefined();
    const flat = [...Array(13).keys()].flatMap((i) => [{ opportunityId: 'x', at: week(i), amount: 100 }, { opportunityId: 'y', at: week(i), amount: i * 10 }]);
    expect(measureCoMovement(flat, { since, until }).size).toBe(0);
  });
});

describe('the measurement reaches the portfolio', () => {
  const openings = [opening('a', {}, 1), opening('b', { price: fixed(1200) }, 2), opening('n', { channel: { label: 'm', perDay: fixed(20), resource: 'marketplace', riskGroup: 'marketplace' } }, 3)];

  it('a measured pair is MEASURED_CO_MOVEMENT and ESTABLISHED; an unmeasured one stays assumed', () => {
    const coMovement = new Map<string, MeasuredCoMovement>([[pairKey('a', 'b'), { coefficient: 0.8, weeks: 12, source: 'test ledger' }]]);
    const r = evaluateGoalPortfolio({ ...limits, openings, coMovement });
    const all = r.streams!.streams.flatMap((s) => s.correlations.map((c) => ({ from: s.opportunityId, ...c })));
    const ab = all.find((c) => pairKey(c.from, c.with) === pairKey('a', 'b'));
    const leading = r.best!.members.map((m) => m.opportunityId);
    // a and b are compared whenever either leads.
    if (leading.includes('a') || leading.includes('b')) {
      expect(ab).toMatchObject({ kind: 'MEASURED_CO_MOVEMENT', coefficient: 0.8, basis: 'ESTABLISHED', measured: { weeks: 12 } });
    }
    for (const c of all) if (pairKey(c.from, c.with) !== pairKey('a', 'b')) expect(c.basis).toBe('ASSUMED');
    // The optimizer simulates the shared outreach at the measured coefficient, and the reading says so.
    expect(r.limits.correlation).toBe(0.8);
    expect(r.limits.correlationBasis).toContain('measured');
  });

  it('a measured co-movement makes the stream dependent, a measured absence of one does not', () => {
    const lead = [opening('a', {}, 1), opening('b', { channel: { label: 'm', perDay: fixed(20), resource: 'marketplace', riskGroup: 'marketplace' } }, 2)];
    const together = evaluateGoalPortfolio({ ...limits, openings: lead, coMovement: new Map([[pairKey('a', 'b'), { coefficient: 0.9, weeks: 10, source: 't' }]]) });
    const apart = evaluateGoalPortfolio({ ...limits, openings: lead, coMovement: new Map([[pairKey('a', 'b'), { coefficient: 0.01, weeks: 10, source: 't' }]]) });
    const leaders = together.best!.members.map((m) => m.opportunityId);
    const follower = together.streams!.streams.find((s) => s.correlations.some((c) => c.kind === 'MEASURED_CO_MOVEMENT'));
    expect(follower).toBeDefined();
    expect(leaders.length).toBeGreaterThan(0);
    expect(follower!.independent).toBe(false);
    expect(follower!.independence).toContain('measured 0.90');
    const sameApart = apart.streams!.streams.find((s) => s.opportunityId === follower!.opportunityId)!;
    expect(sameApart.correlations.find((c) => c.kind === 'MEASURED_CO_MOVEMENT')!.coefficient).toBe(0.01);
    expect(sameApart.independence).not.toContain('moves with');
  });

  it('without any measurement the declared assumption stands and is named as one', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings, coMovement: null });
    expect(r.limits.correlation).toBe(SHARED_OUTREACH_CORRELATION);
    expect(r.limits.correlationBasis).toContain('assumed');
    for (const s of r.streams!.streams) for (const c of s.correlations) {
      expect(c.kind).not.toBe('MEASURED_CO_MOVEMENT');
      expect(c.basis).toBe('ASSUMED');
    }
    expect(DEFAULT_RISK_CORRELATION).toBe(0.5);
  });

  it('a shared mailbox never hedges: a negative measurement floors the simulated coefficient at zero', () => {
    const neg = new Map<string, MeasuredCoMovement>([[pairKey('a', 'b'), { coefficient: -0.6, weeks: 10, source: 't' }]]);
    expect(sharedOutreachCorrelation(['a', 'b'], neg)).toMatchObject({ coefficient: 0, basis: 'MEASURED', pairs: 1 });
    expect(sharedOutreachCorrelation(['a', 'b'], undefined)).toMatchObject({ coefficient: SHARED_OUTREACH_CORRELATION, basis: 'ASSUMED' });
  });

  it('with no explicit input, the portfolio reads the goals tick\'s last measurement', () => {
    setCoMovement({ readAt: until, window: { since, until }, observed: 2, pairs: new Map([[pairKey('a', 'b'), { coefficient: 0.7, weeks: 9, source: 'cached' }]]) });
    const r = evaluateGoalPortfolio({ ...limits, openings });
    expect(r.limits.correlation).toBe(0.7);
  });
});

describe('the production reader', () => {
  it('reads customer payments less refunds per opening from the ledger, and the tick refresh caches it', async () => {
    const { project } = await freshProject();
    const db = getDb();
    const now = new Date();
    const at = (weeksAgo: number) => new Date(now.getTime() - weeksAgo * 7 * 86_400_000).toISOString();
    let n = 0;
    const put = async (opp: string, kind: string, cents: number, weeksAgo: number) => {
      n += 1;
      await db.run(
        `INSERT INTO cash_money_entries (id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference, occurred_at, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, 'test', ?)`,
        [`cme_co_${n}`, project.id, opp, kind, cents, `ref_${n}`, at(weeksAgo), at(weeksAgo)],
      );
    };
    const pattern = [1, 5, 2, 8, 3, 9, 1, 7, 2, 6, 4];
    for (let i = 0; i < pattern.length; i++) {
      await put('opp_x', 'CUSTOMER_PAYMENT', pattern[i]! * 10_000, pattern.length - i);
      await put('opp_y', 'CUSTOMER_PAYMENT', pattern[i]! * 20_000, pattern.length - i);
    }
    // A refund counts against the week it happened in.
    await put('opp_y', 'REFUND', 5_000, 3);
    const reading = await readCoMovement(now);
    expect(reading.observed).toBe(2);
    const m = reading.pairs.get(pairKey('opp_x', 'opp_y'))!;
    expect(m.coefficient).toBeGreaterThan(0.8);
    expect(m.weeks).toBeGreaterThanOrEqual(MIN_CO_MOVEMENT_WEEKS);
    const refreshed = await refreshCoMovementIfDue(now.getTime());
    expect(refreshed && 'pairs' in refreshed ? refreshed.pairs.size : -1).toBe(1);
    expect(cachedCoMovement()!.pairs.get(pairKey('opp_x', 'opp_y'))!.coefficient).toBeCloseTo(m.coefficient, 9);
    // At most once per refresh period: a second call within it reads nothing.
    expect(await refreshCoMovementIfDue(now.getTime() + 1000)).toBeNull();
  });
});
