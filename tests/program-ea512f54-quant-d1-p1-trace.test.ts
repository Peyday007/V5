/**
 * COM-13-2 (S-0103): tracing leverage combinations, enforcing the real
 * constraints, verifying prepayment from evidence, and the read-only probe
 * reader's holding and violating cases.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import type { Arrangement, Levers, Part } from '../server/services/quant/mechanism.ts';
import { combinationsOf, DIMENSIONS, enforceConstraints, leverageHoldsOnRows, revenueCeilingIn, traceLeverage, verifyPrepayment, type Reading } from '../server/services/quant/leverage.ts';
import type { Observation } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');
const src = (url: string) => ({ url, title: url, retrievedAt: '2026-11-01T00:00:00Z' }) as unknown as Observation['source'];
const pt = (id: string, value: number): Part => ({ observations: [{ id, value: { kind: 'POINT', value, exact: true }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });
const rate = (id: string, s: number, n: number): Part => ({ observations: [{ id, value: { kind: 'COUNT', successes: s, trials: n }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });

const arrangement = (levers: Levers, over: Partial<Arrangement> = {}): Arrangement => ({
  key: 'tr', label: 'Traced', period: 'month', currency: 'USD',
  demand: { buyers: pt('buyers', 200), needRate: pt('need', 1), reach: rate('reach', 50, 100), conversion: rate('conv', 20, 100) },
  value: pt('price', 1_000),
  capture: { kind: 'MARGIN', supplyCost: pt('supply_cost', 600) },
  cost: pt('cost', 50),
  levers,
  ...over,
});

const prepay = { willingness: rate('willing', 50, 100), refundShare: rate('refund', 10, 100), usableDays: pt('usable', 2) };
const fulfil = { capacity: pt('cap', 30), failureRate: rate('fail', 5, 100), paymentDays: pt('pay', 30) };
const ai = { costPerTransaction: pt('ai', 10), throughput: pt('tp', 500) };

const reading = (p50: number | null, p90: number | null = p50): Reading => ({ key: 'x', tier: 'DIRECT', p10: p50, p50, p90, established: true });

describe('traceLeverage', () => {
  it('returns every combination of the carried levers with all seven dimensions', () => {
    const t = traceLeverage(arrangement({ fulfilment: fulfil, prepayment: prepay, aiLabor: ai, settlementDays: pt('settle', 14) }), {}, { now });
    expect(t.levers).toEqual(['aiLabor', 'fulfilment', 'prepayment']);
    expect(t.combinations).toHaveLength(8);
    expect(t.truncated).toBe(0);
    expect(new Set(t.combinations.map((c) => c.levers.join('+'))).size).toBe(8);
    for (const c of t.combinations) {
      for (const d of DIMENSIONS) expect(c.dimensions[d]).toBeDefined();
      expect(Object.keys(c.deltas).sort()).toEqual([...c.levers].sort());
    }
  });

  it('reports the per-lever delta against the combination without it', () => {
    const t = traceLeverage(arrangement({ fulfilment: fulfil, prepayment: prepay, settlementDays: pt('settle', 14) }), {}, { now });
    const both = t.combinations.find((c) => c.levers.length === 2)!;
    // Prepayment adds refund obligations to liability.
    expect(both.deltas.prepayment!.liability!).toBeGreaterThan(0);
    // Prepayment, usable before the supplier is paid, shortens cash conversion.
    expect(both.deltas.prepayment!.cashConversion!).toBeLessThan(0);
    // The supplier's capacity (30) does not bind below demand (24).
    expect(Math.abs(both.deltas.fulfilment!.deliveryCapacity!)).toBeLessThan(3);
    expect(both.prepaymentCredited).toBe(true);
  });

  it('enumerates subsets of all seven levers', () => {
    expect(combinationsOf(['aiLabor', 'fulfilment', 'channel', 'marketing', 'prepayment', 'financing', 'sharedInfrastructure'])).toHaveLength(128);
    const t = traceLeverage(arrangement({ aiLabor: ai, fulfilment: fulfil, prepayment: prepay }), {}, { now, maxCombinations: 3 });
    expect(t.combinations).toHaveLength(3);
    expect(t.truncated).toBe(5);
  });
});

describe('enforceConstraints', () => {
  const base = { deliveryCapacity: reading(24), cashExposure: reading(100, 120) };
  it('names cash exposure when the cash tied up binds', () => {
    const v = enforceConstraints(base, { cashAvailable: 1_200, authorityCeiling: 100_000, contractMax: 50 });
    expect(v.binding).toBe('CASH_EXPOSURE');
    expect(v.allowed).toBeCloseTo(10, 5);
  });
  it('names authority when the ceiling a person set binds', () => {
    expect(enforceConstraints(base, { cashAvailable: 100_000, authorityCeiling: 600, contractMax: 50 }).binding).toBe('AUTHORITY');
  });
  it('names capacity when delivery binds', () => {
    expect(enforceConstraints(base, { cashAvailable: 100_000, authorityCeiling: 100_000, contractMax: 50 }).binding).toBe('CAPACITY');
  });
  it('names the contract when its maximum binds', () => {
    expect(enforceConstraints(base, { cashAvailable: 100_000, authorityCeiling: 100_000, contractMax: 5 }).binding).toBe('CONTRACT');
  });
  it('reads an unstated constraint as unknown, never as permission, and has no revenue-ceiling input', () => {
    const v = enforceConstraints(base, {});
    expect(v.unknown).toEqual(['CASH_EXPOSURE', 'AUTHORITY', 'CONTRACT']);
    expect(v.binding).toBe('CAPACITY');
    expect(Object.keys(v.allows)).toEqual(['CASH_EXPOSURE', 'AUTHORITY', 'CAPACITY', 'CONTRACT']);
  });
  it('a fully prepaid design with no exposure is not capped by cash', () => {
    const v = enforceConstraints({ deliveryCapacity: reading(24), cashExposure: reading(0, 0) }, { cashAvailable: 0 });
    expect(v.allows.CASH_EXPOSURE).toBe(Number.POSITIVE_INFINITY);
    expect(v.binding).toBe('CAPACITY');
  });
});

describe('verifyPrepayment', () => {
  it('marks every condition ESTABLISHED from evidence, with the timing read', () => {
    const [v] = verifyPrepayment(arrangement({ fulfilment: fulfil, prepayment: prepay }), now);
    expect(v).toMatchObject({ willingness: 'ESTABLISHED', refundObligations: 'ESTABLISHED', timing: 'ESTABLISHED', usableBeforeSupplierPayment: true, credited: true });
    expect(v!.tasks).toEqual([]);
  });
  it('reads late funds as not usable before the supplier is paid', () => {
    const [v] = verifyPrepayment(arrangement({ fulfilment: fulfil, prepayment: { ...prepay, usableDays: pt('late', 60) } }), now);
    expect(v!.usableBeforeSupplierPayment).toBe(false);
  });
  it('marks unstated, bounded or assumed conditions UNKNOWN and raises them as tasks', () => {
    const assumed: Part = { assumed: { low: 0.4, high: 0.6, source: src('https://example.test/guess') } };
    const [v] = verifyPrepayment(arrangement({ prepayment: { willingness: assumed, refundShare: { min: 0, max: 1 }, usableDays: {} } }), now);
    expect(v).toMatchObject({ willingness: 'UNKNOWN', refundObligations: 'UNKNOWN', timing: 'UNKNOWN', usableBeforeSupplierPayment: null });
    expect(v!.tasks).toHaveLength(3);
  });
  it('never reports a credit the evidence does not support: credited agrees with the verification', () => {
    const guess = (low: number, high: number): Part => ({ assumed: { low, high, source: src('https://example.test/guess') } });
    const assumed = arrangement({ fulfilment: { ...fulfil, paymentDays: guess(30, 40) }, prepayment: { willingness: guess(0.8, 0.9), refundShare: guess(0, 0.05), usableDays: guess(0, 2) } });
    const [v] = verifyPrepayment(assumed, now);
    expect(v).toMatchObject({ willingness: 'UNKNOWN', refundObligations: 'UNKNOWN', timing: 'UNKNOWN', credited: false });
    const t = traceLeverage(assumed, {}, { now });
    const withPrepay = t.combinations.find((c) => c.levers.join('+') === 'fulfilment+prepayment')!;
    const without = t.combinations.find((c) => c.levers.join('+') === 'fulfilment')!;
    expect(withPrepay.prepaymentCredited).toBe(false);
    expect(withPrepay.cashExposure.p50! / without.cashExposure.p50!).toBeCloseTo(1, 1);
    // Evidence on every condition: established and credited together.
    const [e] = verifyPrepayment(arrangement({ fulfilment: fulfil, prepayment: prepay }), now);
    expect(e!.credited).toBe(e!.willingness === 'ESTABLISHED' && e!.refundObligations === 'ESTABLISHED' && e!.timing === 'ESTABLISHED');
  });
  it('with no supplier, timing is read against the day the work is paid for, not left unknown (repair: supplier days unknown blocked AI-only)', () => {
    const fee = { capture: { kind: 'FEE' as const, fee: pt('fee', 100) } };
    const [late] = verifyPrepayment(arrangement({ aiLabor: ai, prepayment: prepay, settlementDays: pt('settle', 14) }, fee), now);
    expect(late).toMatchObject({ willingness: 'ESTABLISHED', refundObligations: 'ESTABLISHED', timing: 'ESTABLISHED', usableBeforeSupplierPayment: false, credited: true });
    const [onDelivery] = verifyPrepayment(arrangement({ aiLabor: ai, prepayment: { ...prepay, usableDays: pt('now', 0) } }, fee), now);
    expect(onDelivery!.usableBeforeSupplierPayment).toBe(true);
    // A supplier with unstated terms is still an unknown.
    const [unstated] = verifyPrepayment(arrangement({ aiLabor: ai, prepayment: prepay }), now);
    expect(unstated!.timing).toBe('UNKNOWN');
  });
  it('returns nothing for an arrangement without a prepayment lever', () => {
    expect(verifyPrepayment(arrangement({ aiLabor: ai }), now)).toEqual([]);
  });
});

describe('leverageHoldsOnRows', () => {
  it('holds when combinations are traced and nothing rests on a revenue ceiling', async () => {
    const r = await leverageHoldsOnRows({ now, projects: async () => [{ id: 'p1' }], arrangementsFor: async () => [arrangement({ fulfilment: fulfil, prepayment: prepay })] });
    expect(r.ok).toBe(true);
    expect(r.combinations).toBe(4);
    expect(r.prepayment).toEqual({ levers: 1, credited: 1, established: 1 });
    expect(r.revenueCeilingViolations).toEqual([]);
    expect(r.detail).toMatch(/no transaction limited by a revenue ceiling/);
  });

  it('names an arrangement whose transactions rest on owned capital as a violation', async () => {
    const capped = arrangement({ aiLabor: ai, limits: { contractMax: { formula: 'tr_owned_capital / 10' } } }, {
      extra: [{ key: 'tr_owned_capital', label: 'Owned capital', unit: 'USD', kind: 'POSITIVE', observations: pt('owned', 500).observations }],
    });
    expect(revenueCeilingIn(capped)).toBe(true);
    const r = await leverageHoldsOnRows({ now, projects: async () => [{ id: 'p1' }], arrangementsFor: async () => [capped] });
    expect(r.ok).toBe(false);
    expect(r.revenueCeilingViolations).toEqual(['p1:tr']);
    expect(r.detail).toMatch(/REVENUE CEILING/);
  });

  it('reports no rows plainly rather than holding', async () => {
    const r = await leverageHoldsOnRows({ now, projects: async () => [{ id: 'p1' }], arrangementsFor: async () => [] });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^no arrangement is constructed/);
  });

  it('counts unknown dimensions on an arrangement known only as bounds', async () => {
    const bounds: Part = { min: 0, max: 1 };
    const loose = arrangement({ prepayment: { willingness: bounds, refundShare: bounds, usableDays: { min: 0, max: 30 } } });
    const r = await leverageHoldsOnRows({ now, projects: async () => [{ id: 'p1' }], arrangementsFor: async () => [loose] });
    expect(r.prepayment).toEqual({ levers: 1, credited: 0, established: 0 });
    expect(r.unknown.cashConversion).toBe(2);
  });
});

describe('leverageHoldsOnRows on a real database, through the production entry points', () => {
  afterAll(teardown);
  it('reads the rows Brain constructs from, writes nothing, and traces what it finds', async () => {
    const { project } = await freshProject();
    const { createNode } = await import('../server/repos/industry.ts');
    const { getDb } = await import('../server/db/database.ts');
    const { node: sector } = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'BUYER_TYPE', name: 'Independent hotels', origin: 'SEED' });
    const counts = async () => (await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM project_events", []))[0]!.n;
    const before = await counts();
    const r = await leverageHoldsOnRows({ now, perProject: 3 });
    expect(await counts()).toBe(before);
    expect(r.projects).toBeGreaterThanOrEqual(1);
    expect(r.revenueCeilingViolations).toEqual([]);
    expect(r.arrangements).toBeGreaterThan(0);
    expect(r.combinations).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    // Nothing on these rows establishes prepayment, so nothing is credited or verified.
    expect(r.prepayment.credited).toBe(0);
    expect(r.prepayment.established).toBe(0);
  }, 120_000);
});
