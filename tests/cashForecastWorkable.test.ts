/**
 * The forecast totals work, not evidence (§47). Other people's published prices
 * on SIGNAL-tier pieces are not revenue this operation would earn.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CashOpportunity } from '../server/domain/types.ts';
import type { TierReading } from '../server/services/cash/tier.ts';

let rows: CashOpportunity[] = [];
vi.mock('../server/repos/cashPortfolio.ts', () => ({
  listOpportunities: async () => rows,
}));

const { cashForecast } = await import('../server/services/cash/forecast.ts');

function row(id: string, state: CashOpportunity['state'], priceCents: number | null): CashOpportunity {
  return { id, projectId: 'prj_1', state, currency: 'USD', priceCents, peakFundingCents: null, humanHours: null } as unknown as CashOpportunity;
}
const tier = (name: TierReading['tier']): TierReading => ({ tier: name }) as unknown as TierReading;

describe('cashForecast counts only workable pieces', () => {
  it('SIGNAL-tier evidence cards with prices give qualified 0 and no revenue', async () => {
    rows = [row('a', 'EVIDENCE_CARD', 199), row('b', 'EVIDENCE_CARD', 500)];
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { a: tier('SIGNAL'), b: tier('SIGNAL') },
    });
    expect(forecast.qualified).toBe(0);
    expect(forecast.considered).toBe(2);
    expect(forecast.revenue.valueCents).toBeNull();
  });

  it('a READY opportunity is counted and its price contributes', async () => {
    rows = [row('a', 'EVIDENCE_CARD', 199), row('r', 'READY', 90_000)];
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { a: tier('SIGNAL'), r: tier('SIGNAL') },
    });
    expect(forecast.qualified).toBe(1);
    expect(forecast.considered).toBe(2);
    expect(forecast.revenue.valueCents).toBe(90_000);
  });

  it('with no tiers supplied nothing is workable', async () => {
    rows = [row('r', 'READY', 90_000), row('a', 'EVIDENCE_CARD', 1)];
    const forecast = await cashForecast({ projectId: 'prj_1', currency: 'USD' });
    expect(forecast.qualified).toBe(0);
    expect(forecast.revenue.valueCents).toBeNull();
  });
});
