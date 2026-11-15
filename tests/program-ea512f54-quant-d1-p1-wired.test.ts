/**
 * COM-13-2 (S-0103), wired into the running Brain: construction — the path
 * every goal plan and constructed research round reads — traces each
 * best-ranked arrangement's leverage on its own parts and evidence, judges it
 * against the cash the ledger says is deployable and the authority a person
 * granted, refuses one a real limit cannot fit, and asks research to verify
 * prepayment. The probe reader reads that, rather than re-mapping
 * arrangements onto bounds with no limits.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import type { Arrangement, Part } from '../server/services/quant/mechanism.ts';
import { leverageHoldsOnRows, leverageOf } from '../server/services/quant/leverage.ts';
import type { Observation } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');
const src = (url: string) => ({ url, title: url, retrievedAt: '2026-11-01T00:00:00Z' }) as unknown as Observation['source'];
const pt = (id: string, value: number): Part => ({ observations: [{ id, value: { kind: 'POINT', value, exact: true }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });
const rate = (id: string, s: number, n: number): Part => ({ observations: [{ id, value: { kind: 'COUNT', successes: s, trials: n }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });

const evidenced = (): Arrangement => ({
  key: 'w', label: 'Wired', period: 'month', currency: 'USD',
  demand: { buyers: pt('buyers', 200), needRate: pt('need', 1), reach: rate('reach', 50, 100), conversion: rate('conv', 20, 100) },
  value: pt('price', 1_000),
  capture: { kind: 'MARGIN', supplyCost: pt('supply_cost', 600) },
  cost: pt('cost', 50),
  levers: { fulfilment: { capacity: pt('cap', 30), failureRate: rate('fail', 5, 100), paymentDays: pt('pay', 30) }, settlementDays: pt('settle', 14) },
});

describe('leverageOf enforces the real limits', () => {
  it('refuses an arrangement whose evidenced exposure the deployable cash cannot fit once', () => {
    const tight = leverageOf(evidenced(), { cashAvailable: 100, authorityCeiling: null, contractMax: null }, { now });
    expect(tight.refused).toMatch(/^CASH_EXPOSURE allows/);
    expect(tight.constraints).toEqual({ cashAvailable: 100, authorityCeiling: null, contractMax: null });
    expect(tight.tasks.some((t) => /AUTHORITY/.test(t) && /CONTRACT/.test(t))).toBe(true);
  });
  it('lets the same arrangement run where cash and authority fit, bounded by capacity rather than revenue', () => {
    const fits = leverageOf(evidenced(), { cashAvailable: 1_000_000, authorityCeiling: 1_000_000, contractMax: null }, { now });
    expect(fits.refused).toBeNull();
    const full = fits.combinations.find((c) => c.levers.length === fits.levers.length)!;
    expect(full.constraint.binding).toBe('CAPACITY');
    expect(fits.revenueCeiling).toBe(false);
  });
  it('refuses nothing on an exposure nobody established', () => {
    const loose: Arrangement = { ...evidenced(), capture: { kind: 'MARGIN', supplyCost: { min: 0, max: 100_000 } } };
    expect(leverageOf(loose, { cashAvailable: 1, authorityCeiling: 1, contractMax: 1 }, { now }).refused).toBeNull();
  });
});

describe('construction traces leverage in the running Brain', () => {
  afterAll(teardown);
  it('attaches traced leverage with the ledger and authority limits, asks prepayment, and the probe reads it', async () => {
    const { project } = await freshProject();
    const { createNode } = await import('../server/repos/industry.ts');
    const { constructArrangements, clearConstructionMemo, LEVERAGE_TRACED } = await import('../server/services/cash/construct.ts');
    const { node: sector } = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'BUYER_TYPE', name: 'Independent hotels', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'BOTTLENECK', name: 'Linen turnaround', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'FULFILMENT_SOURCE', name: 'Regional laundries', origin: 'SEED' });
    clearConstructionMemo();
    const built = await constructArrangements({ projectId: project.id, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const traced = built.filter((one) => one.leverage);
    expect(traced.length).toBeGreaterThan(0);
    expect(traced.length).toBeLessThanOrEqual(LEVERAGE_TRACED);
    for (const one of traced) {
      const l = one.leverage!;
      // The goal's capital ceiling is the authority a person set; the ledger's deployable cash is read (none here: 0).
      expect(l.constraints.authorityCeiling).toBe(500);
      expect(l.constraints.cashAvailable).toBe(0);
      expect(l.levers.length).toBeGreaterThan(0);
      expect(l.combinations).toHaveLength(2 ** l.levers.length);
      expect(l.revenueCeiling).toBe(false);
      for (const c of l.combinations) expect(c.constraint.unknown).not.toContain('AUTHORITY');
    }
    // A design that takes money early carries a prepayment lever, verified from evidence and asked when it is not.
    const prepaid = traced.find((one) => one.leverage!.levers.includes('prepayment'));
    expect(prepaid).toBeDefined();
    expect(prepaid!.leverage!.prepayment[0]!.willingness).toBe('UNKNOWN');
    expect(prepaid!.leverage!.prepayment[0]!.credited).toBe(false);
    expect(prepaid!.question).toMatch(/Prepayment is a design possibility here, not a presumption: establish what share of these buyers will prepay/);

    const r = await leverageHoldsOnRows({ now, perProject: 3, projects: async () => [{ id: project.id }] });
    expect(r.arrangements).toBeGreaterThan(0);
    expect(r.combinations).toBeGreaterThan(0);
    // The probe read the limits construction applied: cash from the ledger on every arrangement.
    expect(r.limits.cashAvailable).toBe(r.arrangements);
    expect(r.ok).toBe(true);
  }, 180_000);
});
