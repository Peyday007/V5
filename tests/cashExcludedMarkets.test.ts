import { describe, expect, it } from 'vitest';
import type { CashOpportunity } from '../server/domain/types.ts';
import { excludedMarket, federalProcurementHost } from '../server/services/cash/excludedMarkets.ts';
import { jobEligibility } from '../server/services/cash/jobPipeline.ts';
import { ALL_BUCKETS, RETIRED_BUCKETS, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import type { TierReading } from '../server/services/cash/tier.ts';

function opening(fields: Partial<CashOpportunity>): CashOpportunity {
  return {
    title: 'An opening',
    industry: null,
    source: null,
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    offerScope: null,
    state: 'DISCOVERED',
    duplicateOfId: null,
    priceCents: null,
    peakFundingCents: null,
    currency: 'USD',
    ...fields,
  } as CashOpportunity;
}

const qualified = { tier: 'QUALIFIED' } as TierReading;

describe("the owner's ruled-out markets are code, not prose", () => {
  it('refuses a federal bid by its source host', () => {
    expect(federalProcurementHost('https://sam.gov/opp/abc/view')).toBe('sam.gov');
    expect(federalProcurementHost('https://www.fpds.gov/x')).toBe('fpds.gov');
    expect(federalProcurementHost('https://notsam.gov.example.com/')).toBeNull();
    expect(excludedMarket(opening({}), 'https://sam.gov/opp/N0010426QAC01')).toMatchObject({ kind: 'FEDERAL_BID' });
  });

  it('refuses a federal bid whose own text names SAM.gov', () => {
    expect(
      excludedMarket(opening({ buyingSignal: 'Navy solicitation N0010426QAC01, offers via SAM.gov by 30 Oct' })),
    ).toMatchObject({ kind: 'FEDERAL_BID' });
  });

  it('refuses the excluded cities as whole words only', () => {
    expect(excludedMarket(opening({ title: 'Roofers in Detroit, MI with a backlog' }))).toEqual({
      kind: 'EXCLUDED_CITY',
      city: 'Detroit',
    });
    expect(excludedMarket(opening({ payer: 'cleveland clinic vendors' }))).toMatchObject({ city: 'Cleveland' });
    expect(excludedMarket(opening({ title: 'Clevelander Tools catalogue refresh' }))).toBeNull();
  });

  it('leaves an ordinary opening alone', () => {
    expect(excludedMarket(opening({ title: 'Dental practices in Phoenix needing intake forms' }))).toBeNull();
  });

  it('never makes a ruled-out opening a job, however well qualified', () => {
    const refused = jobEligibility(opening({ title: 'HVAC contractors in Cleveland' }), qualified, false);
    expect(refused.eligible).toBe(false);
    expect(refused.because).toMatch(/Cleveland/);
    expect(jobEligibility(opening({ title: 'HVAC contractors in Tucson' }), qualified, false).eligible).toBe(true);
  });
});

describe('the gig-posting bucket is retired', () => {
  it('is no longer asked, and old rounds still resolve it', () => {
    expect(SEARCH_BUCKETS.some((one) => one.id === 'explicit-paid-request')).toBe(false);
    expect(RETIRED_BUCKETS.map((one) => one.id)).toEqual(['explicit-paid-request']);
    expect(ALL_BUCKETS.some((one) => one.id === 'explicit-paid-request')).toBe(true);
  });
});
