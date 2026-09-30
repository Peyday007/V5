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

  it('with no tiers supplied nothing is workable', async () => {
    rows.length = 0;
    rows.push(opportunity({ id: 'cop_r', state: 'READY', priceCents: 75_000 }));
    const forecast = await cashForecast({ projectId: 'prj_1', currency: 'USD' });
    expect(forecast.qualified).toBe(0);
    expect(forecast.considered).toBe(1);
    expect(forecast.revenue.valueCents).toBeNull();
  });
});
