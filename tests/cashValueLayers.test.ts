import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { goalContribution, refuseLayer } from '../server/services/cash/valueLayers.ts';
import { listValueLayers, recordValueLayer } from '../server/repos/cashValueLayers.ts';
import type { ValueLayerReading } from '../server/domain/cashValueLayers.ts';

function r(layer: ValueLayerReading['layer'], over: Partial<ValueLayerReading> = {}): ValueLayerReading {
  return {
    id: layer, projectId: 'p', opportunityId: 'o', layer, status: 'VERIFIED', amountCents: null,
    currency: 'USD', source: 'src', note: null, createdAt: '', updatedAt: '', ...over,
  };
}

describe('value layers', () => {
  it('counts nothing for an $85,000 listing with no transaction or buyer evidence', () => {
    const c = goalContribution([r('ADVERTISED_VALUE', { amountCents: 8_500_000, status: 'ESTIMATE' })], 'USD');
    expect(c.countedCents).toBe(0);
    expect(c.zeroed).toContain('ADVERTISED_VALUE');
  });

  it('counts a realistic figure copied in with no evidence as nothing', () => {
    const c = goalContribution([r('REALISTIC_REVENUE', { amountCents: 8_500_000, status: 'ESTIMATE' })], 'USD');
    expect(c.countedCents).toBe(0);
    expect(c.realisticReason).toMatch(/no completed-transaction or buyer-demand evidence/);
  });

  it('counts a published award or bid as zero secured revenue', () => {
    const c = goalContribution([r('ADVERTISED_VALUE', { amountCents: 50_000_000 }), r('BUYER_DEMAND', { amountCents: 50_000_000 })], 'USD');
    expect(c.countedCents).toBe(0);
  });

  it('counts supported realistic revenue plus a verified ledger, kept apart', () => {
    const c = goalContribution(
      [r('REALISTIC_REVENUE', { amountCents: 200_000, status: 'ESTIMATE' }), r('BUYER_DEMAND', { status: 'VERIFIED' }), r('LEDGER', { amountCents: 50_000 })],
      'USD',
    );
    expect([c.realisticCents, c.ledgerCents, c.countedCents]).toEqual([200_000, 50_000, 250_000]);
  });

  it('does not count an estimated ledger entry or another currency', () => {
    expect(goalContribution([r('LEDGER', { amountCents: 1, status: 'ESTIMATE' })], 'USD').ledgerCents).toBe(0);
    expect(goalContribution([r('LEDGER', { amountCents: 1, currency: 'EUR' })], 'USD').ledgerCents).toBe(0);
  });

  it('refuses an UNKNOWN layer with an amount and a sourceless estimate', () => {
    expect(refuseLayer({ layer: 'LEDGER', status: 'UNKNOWN', amountCents: 5 })).toMatch(/blank/);
    expect(refuseLayer({ layer: 'LEDGER', status: 'ESTIMATE', amountCents: 5, currency: 'USD' })).toMatch(/where it came from/);
    expect(refuseLayer({ layer: 'LEDGER', status: 'UNKNOWN' })).toBeNull();
  });
});

describe('value layer repository', () => {
  let projectId: string;
  beforeEach(async () => { projectId = (await freshProject()).project.id; });

  it('replaces a layer rather than accumulating it', async () => {
    await recordValueLayer(projectId, 'opp_1', { layer: 'ADVERTISED_VALUE', status: 'ESTIMATE', amountCents: 100, currency: 'USD', source: 'listing' });
    await recordValueLayer(projectId, 'opp_1', { layer: 'ADVERTISED_VALUE', status: 'ESTIMATE', amountCents: 200, currency: 'USD', source: 'listing' });
    const rows = await listValueLayers(projectId, 'opp_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountCents).toBe(200);
  });

  it('refuses a layer that breaks the rules', async () => {
    await expect(recordValueLayer(projectId, 'opp_1', { layer: 'LEDGER', status: 'UNKNOWN', amountCents: 5 })).rejects.toThrow(/blank/);
  });
});
