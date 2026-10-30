/**
 * Reliability engineering: failure paths come only from stated plan facts, a
 * protection needs evidence, an accepted improvement rebuilds the plan, and
 * combined setbacks are tested as well as single ones.
 */
import { describe, expect, it } from 'vitest';
import {
  contributionUnder, deriveFailurePaths, improvePlan, proposeProtections, rebuildPlan, testSetbacks,
  type CandidatePlan, type EvidenceCatalogue, type Setback,
} from '../server/services/goals/reliability.ts';

const plan = (over: Partial<CandidatePlan> = {}): CandidatePlan => ({
  id: 'p', targetCents: 1_000_000, daysLeft: 30, expectedRevenueCents: 2_000_000, directCostsCents: 400_000,
  customers: [{ id: 'acme', shareOfRevenue: 0.8 }, { id: 'beta', shareOfRevenue: 0.2 }],
  suppliers: [{ id: 'mill', shareOfDelivery: 0.6, alternativeIds: [] }],
  upfrontCents: 300_000, capitalCeilingCents: 500_000, paymentDays: 10, capacityUnits: 100, neededUnits: 100,
  evidence: ['ev_base'], ...over,
});
const empty: EvidenceCatalogue = { alternativeSuppliers: [], customerSources: [], deposit: null, backupCapacity: null, compatiblePaths: [] };
const kinds = (p: CandidatePlan) => deriveFailurePaths(p).map((x) => x.kind);

describe('failure paths', () => {
  it('derives each path only from a fact the plan states', () => {
    expect(kinds(plan())).toEqual(['SINGLE_CUSTOMER', 'SUPPLIER_OR_WORKER_FAILURE', 'UPFRONT_EXPOSURE', 'CAPACITY']);
    const safe = plan({
      customers: [{ id: 'a', shareOfRevenue: 0.4 }, { id: 'b', shareOfRevenue: 0.6 - 0.1 }, { id: 'c', shareOfRevenue: 0.1 }].map((c) => ({ ...c, shareOfRevenue: Math.min(c.shareOfRevenue, 0.4) })),
      suppliers: [{ id: 'mill', shareOfDelivery: 0.6, alternativeIds: ['alt'] }], upfrontCents: 0, capacityUnits: 200,
    });
    expect(kinds(safe)).toEqual([]);
  });

  it('treats an unknown payment time or capacity as a path, never as fine', () => {
    expect(kinds(plan({ paymentDays: null, capacityUnits: null }))).toEqual(
      expect.arrayContaining(['PAYMENT_DELAY', 'CAPACITY']),
    );
    expect(kinds(plan({ customers: [{ id: 'only', shareOfRevenue: 1 }] }))).toEqual(
      expect.arrayContaining(['CUSTOMER_ACQUISITION', 'SINGLE_CUSTOMER']),
    );
    expect(kinds(plan({ paymentDays: 20 }))).toContain('PAYMENT_DELAY');
  });
});

describe('protections', () => {
  it('invents none: a path with no evidenced protection is reported with its question', () => {
    const { protections, unprotected } = proposeProtections(deriveFailurePaths(plan()), empty);
    expect(protections).toEqual([]);
    expect(unprotected.map((u) => u.path.kind)).toEqual(['SINGLE_CUSTOMER', 'SUPPLIER_OR_WORKER_FAILURE', 'UPFRONT_EXPOSURE', 'CAPACITY']);
    expect(unprotected[1]?.question).toMatch(/supplies or does this work/);
  });

  it('names a protection per evidenced option, each with its evidence id', () => {
    const catalogue: EvidenceCatalogue = {
      alternativeSuppliers: [{ supplierId: 'mill', alternativeId: 'mill2', evidenceId: 'ev_s' }],
      customerSources: [{ id: 'gamma', shareOfRevenue: 0.3, evidenceId: 'ev_c' }],
      deposit: { fraction: 0.5, evidenceId: 'ev_d' },
      backupCapacity: { units: 50, evidenceId: 'ev_b' },
      compatiblePaths: [],
    };
    const { protections, unprotected } = proposeProtections(deriveFailurePaths(plan()), catalogue);
    expect(new Set(protections.map((p) => p.kind))).toEqual(
      new Set(['ALTERNATIVE_SUPPLIER', 'SECOND_CUSTOMER_SOURCE', 'DEPOSIT_OR_PAYMENT_TERMS', 'BACKUP_CAPACITY']),
    );
    expect(protections.every((p) => p.evidenceId.startsWith('ev_'))).toBe(true);
    expect(unprotected).toEqual([]);
  });
});

describe('rebuilding the plan', () => {
  it('applies each accepted protection, records its evidence, and leaves the input alone', () => {
    const base = plan();
    const catalogue: EvidenceCatalogue = {
      alternativeSuppliers: [{ supplierId: 'mill', alternativeId: 'mill2', evidenceId: 'ev_s' }],
      customerSources: [{ id: 'gamma', shareOfRevenue: 0.4, evidenceId: 'ev_c' }],
      deposit: { fraction: 0.5, evidenceId: 'ev_d' },
      backupCapacity: { units: 50, evidenceId: 'ev_b' },
      compatiblePaths: [{ id: 'second-path', revenueCents: 500_000, evidenceId: 'ev_p' }],
    };
    const { protections } = proposeProtections(deriveFailurePaths(base), catalogue);
    const rebuilt = rebuildPlan(base, protections);
    expect(base.customers.length).toBe(2);
    expect(rebuilt.suppliers[0]?.alternativeIds).toEqual(['mill2']);
    expect(rebuilt.upfrontCents).toBe(150_000);
    expect(rebuilt.paymentDays).toBe(5);
    expect(rebuilt.capacityUnits).toBe(150);
    expect(rebuilt.customers.map((c) => c.id)).toEqual(['acme', 'beta', 'gamma', 'second-path']);
    expect(rebuilt.customers.reduce((s, c) => s + c.shareOfRevenue, 0)).toBeCloseTo(1, 6);
    expect(rebuilt.expectedRevenueCents).toBe(2_500_000);
    expect(rebuilt.evidence).toEqual(expect.arrayContaining(['ev_base', 'ev_s', 'ev_c', 'ev_d', 'ev_b', 'ev_p']));
    expect(Math.max(...rebuilt.customers.map((c) => c.shareOfRevenue))).toBeLessThan(0.5);
  });
});

describe('setbacks', () => {
  const plausible: Setback[] = [
    { kind: 'LOSE_CUSTOMER', customerId: 'acme' },
    { kind: 'SUPPLIER_FAILS', supplierId: 'mill' },
    { kind: 'PAYMENT_LATE', extraDays: 25 },
  ];

  it('counts revenue after the deadline, and an unknown payment time, as nothing', () => {
    expect(contributionUnder(plan(), [])).toBe(1_600_000);
    expect(contributionUnder(plan({ paymentDays: 31 }), [])).toBe(-400_000);
    expect(contributionUnder(plan({ paymentDays: null }), [])).toBe(-400_000);
  });

  it('tests singles and every pair, and reports counts rather than a probability', () => {
    const test = testSetbacks(plan(), plausible);
    expect(test.singles.length).toBe(3);
    expect(test.combined.length).toBe(3);
    expect(test.tested).toBe(6);
    expect(test.worst?.contributionCents).toBeLessThan(0);
    expect(test.note).toMatch(/not a probability/);
    const both = test.combined.find((r) => r.setbacks.includes('LOSE_CUSTOMER:acme') && r.setbacks.includes('SUPPLIER_FAILS:mill'));
    expect(both?.contributionCents).toBe(Math.round(2_000_000 - 1_600_000 - 1_200_000 - 400_000));
    expect(test.singles.find((r) => r.setbacks[0] === 'LOSE_CUSTOMER:acme')?.meetsTarget).toBe(false);
    expect(both?.meetsTarget).toBe(false);
  });

  it('shows a pair failing where each setback alone is survived', () => {
    const mild: Setback[] = [{ kind: 'LOSE_CUSTOMER', customerId: 'beta' }, { kind: 'CAPACITY_SHORT', fraction: 0.2 }];
    const test = testSetbacks(plan(), mild);
    expect(test.singles.map((r) => r.meetsTarget)).toEqual([true, true]);
    expect(test.combined.map((r) => r.meetsTarget)).toEqual([false]);
    expect(test.meetingTarget).toBe(2);
    expect(test.tested).toBe(3);
  });

  it('an improved plan survives more of the tested setbacks, with its evidence updated', () => {
    const catalogue: EvidenceCatalogue = {
      alternativeSuppliers: [{ supplierId: 'mill', alternativeId: 'mill2', evidenceId: 'ev_s' }],
      customerSources: [{ id: 'gamma', shareOfRevenue: 0.4, evidenceId: 'ev_c' }],
      deposit: null, backupCapacity: null, compatiblePaths: [],
    };
    const result = improvePlan(plan(), catalogue, plausible);
    expect(result.after.meetingTarget).toBeGreaterThan(result.before.meetingTarget);
    expect(result.rebuilt.evidence).toEqual(expect.arrayContaining(['ev_s', 'ev_c']));
    expect(result.unprotected.map((u) => u.path.kind)).toEqual(expect.arrayContaining(['UPFRONT_EXPOSURE', 'CAPACITY']));
  });
});
