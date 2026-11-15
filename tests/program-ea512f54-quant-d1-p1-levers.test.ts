/**
 * COM-13-2 (S-0103), review finding repair-four-levers-never-composed-in-running-brain.
 *
 * At 1c6da40 construction attached { settlementDays, aiLabor OR fulfilment,
 * prepayment where funding is early }: channel, marketing, financing and
 * shared infrastructure were never composed by any production path, and AI
 * labor never stood beside a supplier, so the combinations S-0103 names were
 * traced only on hand-built arrangements in tests.
 *
 * Pinned here, through the production entry point (`constructArrangements`):
 * every traced arrangement carries all seven levers its design can use — AI
 * labor beside the supplier where one fulfils — every combination of them is
 * traced, including the one with all of them, and each lever's change is
 * reported against the same combination without it. An unstated lever stays
 * a question: it credits nothing and refuses nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { DIMENSIONS, LEVER_KEYS, leverageOf } from '../server/services/quant/leverage.ts';
import type { Arrangement, Part } from '../server/services/quant/mechanism.ts';
import type { Observation } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');
const NON_FULFILMENT = ['aiLabor', 'channel', 'marketing', 'financing', 'sharedInfrastructure'] as const;

describe('construction composes every lever in the running Brain', () => {
  afterAll(teardown);

  it('traces channel, marketing, financing, shared infrastructure and AI labor beside a supplier, in every combination', async () => {
    const { project } = await freshProject();
    const { createNode } = await import('../server/repos/industry.ts');
    const { constructArrangements, clearConstructionMemo, designLevers } = await import('../server/services/cash/construct.ts');
    const { designFacts } = await import('../server/services/cash/properties.ts');
    const { node: sector } = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'BUYER_TYPE', name: 'Independent hotels', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'BOTTLENECK', name: 'Linen turnaround', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: sector.id, kind: 'FULFILMENT_SOURCE', name: 'Regional laundries', origin: 'SEED' });
    clearConstructionMemo();
    const built = await constructArrangements({ projectId: project.id, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const traced = built.filter((one) => one.leverage);
    expect(traced.length).toBeGreaterThan(0);

    for (const one of traced) {
      const l = one.leverage!;
      // The four levers the finding named, and AI labor, are on every traced arrangement.
      for (const lever of NON_FULFILMENT) expect(l.levers, `${one.key} ${lever}`).toContain(lever);
      // Exactly the levers its design can use: the same function construction composes from.
      const composed = designLevers(one.design, designFacts(one.design).fulfiller);
      const expected = LEVER_KEYS.filter((k) => composed[k] !== undefined);
      expect(l.levers).toEqual(expected);
      // Every combination is traced, the one with all of them included, and nothing was cut.
      expect(l.truncated).toBe(0);
      expect(l.combinations).toHaveLength(2 ** l.levers.length);
      const full = l.combinations.find((c) => c.levers.length === l.levers.length)!;
      expect(full).toBeDefined();
      // Each lever's change is reported on each traced dimension against the combination without it.
      for (const lever of l.levers) {
        expect(Object.keys(full.deltas[lever]!).sort()).toEqual([...DIMENSIONS].sort());
      }
      // Bounds only: no lever is credited or refused on an unstated part.
      expect(l.refused).toBeNull();
      for (const v of l.prepayment) expect(v.credited).toBe(false);
    }

    // AI labor and a supplier together, on a design a supplier fulfils.
    const both = traced.find((one) => one.leverage!.levers.includes('fulfilment'));
    expect(both).toBeDefined();
    expect(both!.leverage!.levers).toContain('aiLabor');
    expect(both!.leverage!.combinations.some((c) => c.levers.includes('aiLabor') && c.levers.includes('fulfilment'))).toBe(true);
  }, 300_000);
});

describe('designLevers', () => {
  it('composes supplier fulfilment only where a supplier fulfils, and prepayment only where money comes early', async () => {
    const { designLevers } = await import('../server/services/cash/construct.ts');
    const onDelivery = designLevers({ base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as never, 'BRAIN');
    expect(Object.keys(onDelivery).sort()).toEqual(['aiLabor', 'channel', 'financing', 'marketing', 'settlementDays', 'sharedInfrastructure']);
    const supplied = designLevers({ base: 'SUBCONTRACT', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as never, 'SUPPLIER');
    expect(supplied.fulfilment).toBeDefined();
    expect(supplied.aiLabor).toBeDefined();
    expect(supplied.prepayment).toBeDefined();
    // Every part is a bound, never an observation: a question, not a reading (invariant 39).
    const parts = Object.values(supplied).flatMap((lever) => (lever && typeof lever === 'object' && !('min' in lever) ? Object.values(lever) : [lever])) as Part[];
    for (const p of parts) expect(p.observations ?? []).toHaveLength(0);
  });
});

describe('leverageOf refuses only on evidence', () => {
  const src = (url: string) => ({ url, title: url, retrievedAt: '2026-11-01T00:00:00Z' }) as unknown as Observation['source'];
  const pt = (id: string, value: number): Part => ({ observations: [{ id, value: { kind: 'POINT', value, exact: true }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });
  const rate = (id: string, s: number, n: number): Part => ({ observations: [{ id, value: { kind: 'COUNT', successes: s, trials: n }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });
  const evidenced = (extra: Arrangement['levers'] = {}): Arrangement => ({
    key: 'r', label: 'Refusal', period: 'month', currency: 'USD',
    demand: { buyers: pt('buyers', 200), needRate: pt('need', 1), reach: rate('reach', 50, 100), conversion: rate('conv', 20, 100) },
    value: pt('price', 1_000),
    capture: { kind: 'MARGIN', supplyCost: pt('supply_cost', 600) },
    cost: pt('cost', 50),
    levers: { fulfilment: { capacity: pt('cap', 30), failureRate: rate('fail', 5, 100), paymentDays: pt('pay', 30) }, settlementDays: pt('settle', 14), ...extra },
  });

  it('still refuses an evidenced exposure the cash cannot fit once, though unstated levers sit beside it', () => {
    const l = leverageOf(evidenced({ channel: { share: { min: 0, max: 1 }, fee: { min: 0, max: 100 } }, marketing: { reachUplift: { min: 0, max: 1 }, acquisitionCost: { min: 0, max: 100 }, daysToAcquire: { min: 1, max: 30 } } }), { cashAvailable: 100, authorityCeiling: null, contractMax: null }, { now });
    expect(l.combinations).toHaveLength(2 ** l.levers.length);
    expect(l.refused).toMatch(/^CASH_EXPOSURE allows/);
  });

  it('refuses nothing when the cash fits the evidenced combination', () => {
    const l = leverageOf(evidenced({ channel: { share: { min: 0, max: 1 }, fee: { min: 0, max: 100 } } }), { cashAvailable: 1_000_000, authorityCeiling: 1_000_000, contractMax: null }, { now });
    expect(l.refused).toBeNull();
  });
});
