/**
 * PORT-05 finding F6: stream correlations were entirely assumed — a shared
 * risk group got a configured coefficient, everything else zero, always
 * 'ASSUMED', and no measured co-movement was ever read. Now a pair of openings
 * with enough shared ledger history carries its measured coefficient
 * (ESTABLISHED), and only a pair without it keeps a labelled assumption.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { setGoalTerms } from '../server/repos/goals.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import { noteGoalStreamsCleared } from '../server/services/goals/port05.ts';
import { evaluateGoalPortfolio, OPTIMIZER_DEFAULT_CORRELATION, SHARED_OUTREACH_CORRELATION } from '../server/services/goals/portfolio.ts';
import { readCoMovement, CO_MOVEMENT_SOURCE } from '../server/services/goals/coMovement.ts';
import { applyMeasuredCoMovement, measureCoMovement, MATERIAL_CORRELATION, MIN_CO_MOVEMENT_WEEKS, type MeasuredCoMovement } from '../server/services/goals/streams.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const WEEK = 7 * 86_400_000;
const NOW = new Date('2026-11-14T12:00:00.000Z');
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function opening(id: string, over: Partial<ModelledOpportunity> = {}, card: Record<string, unknown> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}`, payer: null, reachableChannel: null, fulfillmentOwner: null, ...card } as unknown as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond: fixed(0.02),
    directCost: fixed(100),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

/** Weekly amounts as dated points, the last week ending at NOW. */
function weekly(amounts: number[]): Array<{ at: string; amount: number }> {
  return amounts.map((amount, i) => ({ at: new Date(NOW.getTime() - (amounts.length - 1 - i) * WEEK - 3_600_000).toISOString(), amount })).filter((p) => p.amount !== 0);
}

const UP = [1, 3, 2, 5, 4, 6, 5, 8, 7, 9];
const DOWN = UP.map((x) => 10 - x);
const NOISE = [5, 1, 6, 2, 2, 7, 1, 5, 3, 4];

describe('measureCoMovement: a coefficient is read from dated records', () => {
  it('measures lines that move together, against each other, and apart', () => {
    const series = new Map([
      ['a', weekly(UP)],
      ['b', weekly(UP.map((x) => x * 2))],
      ['c', weekly(DOWN)],
      ['d', weekly(NOISE)],
    ]);
    const m = measureCoMovement(series, { now: NOW, source: 'test' });
    const of = (x: string, y: string) => m.find((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));
    expect(of('a', 'b')!.coefficient).toBeCloseTo(1, 2);
    expect(of('a', 'c')!.coefficient).toBeCloseTo(-1, 2);
    expect(Math.abs(of('a', 'd')!.coefficient)).toBeLessThan(MATERIAL_CORRELATION);
    for (const p of m) {
      expect(p.weeks).toBeGreaterThanOrEqual(MIN_CO_MOVEMENT_WEEKS);
      expect(p.source).toBe('test');
    }
  });

  it('does not invent a measurement from too little shared history or a flat line', () => {
    const short = new Map([
      ['a', weekly(UP.slice(-4))],
      ['b', weekly(UP.slice(-4))],
    ]);
    expect(measureCoMovement(short, { now: NOW, source: 't' })).toEqual([]);
    const flat = new Map([
      ['a', weekly(UP)],
      ['b', weekly(UP.map(() => 3))],
    ]);
    expect(measureCoMovement(flat, { now: NOW, source: 't' })).toEqual([]);
    expect(measureCoMovement(new Map([['a', weekly(UP)]]), { now: NOW, source: 't' })).toEqual([]);
  });
});

describe('the streams reading takes the measurement in place of the assumption', () => {
  const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 400, seed: 7 };
  const openings = [opening('x'), opening('y', { price: fixed(1300) })];

  it('without a measurement, a shared mailbox is still an assumption and says so', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings });
    const pairs = r.streams!.streams.flatMap((s) => s.correlations);
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) expect(c).toMatchObject({ kind: 'SHARED_RISK_GROUP', basis: 'ASSUMED', coefficient: SHARED_OUTREACH_CORRELATION });
    expect(OPTIMIZER_DEFAULT_CORRELATION).toBe(0.5);
  });

  it('a measured weak co-movement replaces the assumed coefficient, is ESTABLISHED, and frees the pair', () => {
    const measured: MeasuredCoMovement[] = [{ a: 'x', b: 'y', coefficient: 0.05, weeks: 12, source: CO_MOVEMENT_SOURCE }];
    const r = evaluateGoalPortfolio({ ...limits, openings, measuredCoMovement: measured });
    const pairs = r.streams!.streams.flatMap((s) => s.correlations);
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) expect(c).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', coefficient: 0.05, weeks: 12, source: CO_MOVEMENT_SOURCE });
    for (const p of r.streams!.across.correlations) expect(p).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', coefficient: 0.05 });
    for (const s of r.streams!.streams) expect(s.independence).not.toMatch(/through shared-outreach .*assumed/);
  });

  it('a measured strong co-movement between separate channels makes them dependent, which no assumption could', () => {
    const channel = (resource: string): ModelledOpportunity['channel'] => ({ label: resource, perDay: fixed(20), resource, riskGroup: resource });
    const split = [opening('p', { channel: channel('marketplace') }), opening('q', { channel: channel('referrals') })];
    const assumed = evaluateGoalPortfolio({ ...limits, openings: split });
    for (const c of assumed.streams!.streams.flatMap((s) => s.correlations)) expect(c).toMatchObject({ kind: 'NONE_KNOWN', basis: 'ASSUMED', coefficient: 0 });
    const measured = evaluateGoalPortfolio({ ...limits, openings: split, measuredCoMovement: [{ a: 'q', b: 'p', coefficient: 0.8, weeks: 10, source: 'ledger' }] });
    const withPeer = measured.streams!.streams.filter((s) => s.correlations.length > 0);
    expect(withPeer.length).toBeGreaterThan(0);
    for (const s of withPeer) {
      expect(s.correlations[0]).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', coefficient: 0.8 });
      expect(s.independent).toBe(false);
      expect(s.independence).toMatch(/measured over 10 weeks/);
    }
  });

  it('applying a measurement never mutates the reading it was given', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings });
    const before = JSON.stringify(r.streams);
    applyMeasuredCoMovement(r.streams!, [{ a: 'x', b: 'y', coefficient: 0.9, weeks: 9, source: 's' }]);
    expect(JSON.stringify(r.streams)).toBe(before);
  });
});

describe('the goal view reads the co-movement from the ledger rows', () => {
  let projectId = '';
  let userId = '';

  beforeEach(async () => {
    noteGoalStreamsCleared();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `f6-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  afterAll(async () => {
    await teardown();
  });

  async function opened(title: string): Promise<ModelledOpportunity['opportunity']> {
    const one = await capture({ projectId, actorRef: userId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'services', source: `https://example.com/${encodeURIComponent(title)}` });
    if (!one.ok) throw new Error(one.reason);
    return one.value as unknown as ModelledOpportunity['opportunity'];
  }

  async function pay(opportunityId: string, amounts: number[], now: Date): Promise<void> {
    for (const [i, amount] of amounts.entries()) {
      if (amount === 0) continue;
      const occurredAt = new Date(now.getTime() - (amounts.length - 1 - i) * WEEK - 3_600_000).toISOString();
      const r = await recordMoney({ projectId, opportunityId, kind: 'CUSTOMER_PAYMENT', amountCents: amount * 10_000, currency: 'USD', occurredAt, verifiedReference: `ref-${opportunityId}-${i}`, recordedBy: userId, idempotencyKey: `f6-${opportunityId}-${i}` });
      expect(r).toBeTruthy();
    }
  }

  it('readCoMovement measures two openings from their own customer payments', async () => {
    const now = new Date();
    const a = await opened('Weekly bookkeeping');
    const b = await opened('Monthly payroll');
    await pay(a.id, UP, now);
    await pay(b.id, UP.map((x) => x + 1), now);
    const m = await readCoMovement({ projectId, currency: 'USD', opportunityIds: [a.id, b.id], now });
    expect(m).toHaveLength(1);
    expect(m[0]!.coefficient).toBeCloseTo(1, 2);
    expect(m[0]!.weeks).toBeGreaterThanOrEqual(MIN_CO_MOVEMENT_WEEKS);
    expect(m[0]!.source).toBe(CO_MOVEMENT_SOURCE);
    // A third opening with no payments has nothing to measure.
    const c = await opened('Quarterly tax');
    expect((await readCoMovement({ projectId, currency: 'USD', opportunityIds: [a.id, c.id], now })).length).toBe(0);
  });

  it('a goal’s streams in the goal view carry the measured coefficient, ESTABLISHED', async () => {
    const now = new Date();
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const a = await opened('Weekly bookkeeping for dental practices');
    const b = await opened('Monthly payroll for dental practices');
    for (const o of [a, b]) await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: o.id, relation: 'PURSUES', recordedBy: 'PERSON', recordedByUserId: userId });
    await pay(a.id, UP, now);
    await pay(b.id, NOISE, now);
    expect((await setTarget({ goal: (await getWorkstream(goal.id))!, metric: 'SETTLED_CASH', amountCents: 100_000_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    await setGoalTerms(goal.id, { dueAt: new Date(now.getTime() + 20 * 86_400_000).toISOString() });
    const target = (await readTarget((await getWorkstream(goal.id))!))!;
    evaluateGoalPortfolio({
      openings: [opening(a.id, {}, a as unknown as Record<string, unknown>), opening(b.id, { price: fixed(1300) }, b as unknown as Record<string, unknown>)],
      remaining: target.remainingCents / 100,
      daysLeft: target.daysLeft!,
      capitalCeiling: 3000,
      beforeProof: 375,
      perWeek: 750,
      resources: '40 emails a day',
    });
    const expected = (await readCoMovement({ projectId, currency: 'USD', opportunityIds: [a.id, b.id], now }))[0]!;
    expect(expected).toBeTruthy();

    const view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === goal.id)!;
    const p5 = view.port05!;
    if (!p5.streams.known) throw new Error(`streams unknown: ${p5.streams.reason}`);
    const correlations = p5.streams.streams.flatMap((s) => s.correlations);
    expect(correlations.length).toBeGreaterThan(0);
    for (const c of correlations) {
      expect(c).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', coefficient: expected.coefficient, weeks: expected.weeks });
    }
  });
});
