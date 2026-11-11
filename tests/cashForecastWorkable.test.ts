/**
 * §47: evidence is not work. The forecast counts only what `isWorkable` says is
 * work, so other people's published prices are never totalled as revenue.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CashOpportunity } from '../server/domain/types.ts';
import type { TierReading } from '../server/services/cash/tier.ts';

const rows: CashOpportunity[] = [];
vi.mock('../server/repos/cashPortfolio.ts', () => ({
  listOpportunities: async () => rows,
}));

const { cashForecast } = await import('../server/services/cash/forecast.ts');

function opportunity(overrides: Partial<CashOpportunity>): CashOpportunity {
  return {
    id: 'cop_x',
    projectId: 'prj_1',
    cashModeId: 'csm_1',
    ownerUserId: 'usr_1',
    title: 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    industryNodeId: null,
    industry: null,
    source: null,
    candidateId: null,
    externalRecordId: null,
    sourceClaimId: null,
    discoveredByCandidateId: null,
    orchestrationId: null,
    fragmentId: null,
    discoveryRoundId: null,
    validationOrchestrationId: null,
    validationState: null,
    validationStartedAt: null,
    validationSettledAt: null,
    validationRounds: 0,
    opportunitySignal: null,
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    signalObservedAt: null,
    offerScope: null,
    acceptanceCondition: null,
    priceCents: null,
    currency: 'USD',
    paymentTerms: null,
    fulfillmentOwner: null,
    deliveryMethod: null,
    requiredInputs: null,
    deadline: null,
    economicsNote: null,
    peakFundingCents: null,
    humanHours: null,
    expiresAt: null,
    expiryReason: null,
    dependsOnId: null,
    duplicateOfId: null,
    requiredCapabilities: [],
    executionAsset: null,
    assetRevision: null,
    state: 'EVIDENCE_CARD',
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    nextActionDue: null,
    outcome: null,
    stopRule: null,
    declinedByUserId: null,
    declinedReason: null,
    reofferedFromId: null,
    archivedReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const reading = (tier: TierReading['tier']): TierReading => ({
  tier,
  establishes: '',
  doesNotEstablish: '',
  toAdvance: [],
  answered: 0,
  required: 0,
  summary: '',
});

describe('the forecast counts work, not evidence', () => {
  it('SIGNAL-tier evidence cards with prices give qualified 0 and no revenue', async () => {
    rows.length = 0;
    rows.push(
      opportunity({ id: 'cop_a', priceCents: 10_000 }),
      opportunity({ id: 'cop_b', priceCents: 20_000 }),
    );
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { cop_a: reading('SIGNAL'), cop_b: reading('SIGNAL') },
    });
    expect(forecast.qualified).toBe(0);
    expect(forecast.considered).toBe(2);
    expect(forecast.revenue.valueCents).toBeNull();
  });

  it('a READY opportunity is still counted and its price contributes', async () => {
    rows.length = 0;
    rows.push(
      opportunity({ id: 'cop_a', priceCents: 10_000 }),
      opportunity({ id: 'cop_r', state: 'READY', priceCents: 75_000, peakFundingCents: 5_000 }),
    );
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { cop_a: reading('SIGNAL'), cop_r: reading('SIGNAL') },
    });
    expect(forecast.qualified).toBe(1);
    expect(forecast.considered).toBe(2);
    expect(forecast.revenue.valueCents).toBe(75_000);
    expect(forecast.contribution.valueCents).toBe(70_000);
  });

  it('an evidence card whose tier is workable (QUALIFIED) is counted; a tier missing from the map is not', async () => {
    rows.length = 0;
    rows.push(
      opportunity({ id: 'cop_q', priceCents: 40_000 }),
      opportunity({ id: 'cop_unread', priceCents: 90_000 }),
      opportunity({ id: 'cop_eur', currency: 'EUR', priceCents: 50_000 }),
    );
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { cop_q: reading('QUALIFIED'), cop_eur: reading('QUALIFIED') },
    });
    expect(forecast.qualified).toBe(1);
    // considered is every opportunity in the project, the EUR one included.
    expect(forecast.considered).toBe(3);
    expect(forecast.revenue.valueCents).toBe(40_000);
  });

  it('with no tiers supplied no evidence is workable, and a taken piece counts exactly as the portfolio counts it', async () => {
    rows.length = 0;
    rows.push(opportunity({ id: 'cop_e', priceCents: 90_000 }));
    const evidenceOnly = await cashForecast({ projectId: 'prj_1', currency: 'USD' });
    expect(evidenceOnly.qualified).toBe(0);
    expect(evidenceOnly.considered).toBe(1);
    expect(evidenceOnly.revenue.valueCents).toBeNull();

    rows.length = 0;
    rows.push(opportunity({ id: 'cop_e', priceCents: 90_000 }), opportunity({ id: 'cop_r', state: 'READY', priceCents: 75_000 }));
    const forecast = await cashForecast({ projectId: 'prj_1', currency: 'USD' });
    expect(forecast.qualified).toBe(1);
    expect(forecast.considered).toBe(2);
    expect(forecast.revenue.valueCents).toBe(75_000);
  });

  it('agrees with the portfolio on every piece whose tier is missing from the map, in every state', async () => {
    const { isWorkable, tierOf, UNREAD_TIER } = await import('../server/services/cash/portfolio.ts');
    const states = ['EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING', 'COLLECTED'] as const;
    for (const state of states) {
      rows.length = 0;
      rows.push(opportunity({ id: 'cop_missing', state, priceCents: 30_000 }));
      // The portfolio's own reading of a piece absent from the map.
      expect(tierOf({}, 'cop_missing')).toBe(UNREAD_TIER);
      const portfolioSays = isWorkable({ tier: tierOf({}, 'cop_missing').tier, state });
      const forecast = await cashForecast({ projectId: 'prj_1', currency: 'USD', tiers: {} });
      expect(forecast.qualified, state).toBe(portfolioSays ? 1 : 0);
      expect(forecast.revenue.valueCents, state).toBe(portfolioSays ? 30_000 : null);
    }
  });

  it('considered keeps its meaning: every opportunity in the project, all states and all currencies', async () => {
    rows.length = 0;
    rows.push(
      opportunity({ id: 'cop_r', state: 'READY', priceCents: 75_000 }),
      opportunity({ id: 'cop_eur', state: 'READY', currency: 'EUR', priceCents: 50_000 }),
      opportunity({ id: 'cop_gone', state: 'ARCHIVED', priceCents: 30_000 }),
    );
    const forecast = await cashForecast({
      projectId: 'prj_1',
      currency: 'USD',
      tiers: { cop_r: reading('QUALIFIED'), cop_eur: reading('QUALIFIED'), cop_gone: reading('QUALIFIED') },
    });
    expect(forecast.qualified).toBe(1);
    expect(forecast.considered).toBe(3);
    expect(forecast.revenue.valueCents).toBe(75_000);
  });
});
