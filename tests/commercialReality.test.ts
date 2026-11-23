import { describe, expect, it } from 'vitest';
import { commercialRealityOf, planCommercialReality } from '../server/services/goals/commercialReality.ts';
import { legFeasibility } from '../server/services/goals/pathways.ts';

const input = (value: number | null, provenance: string, note = '', low?: number, high?: number) => ({ value, low: low ?? value, high: high ?? value, provenance, source: null, note }) as never;
const leg = (over: Record<string, unknown> = {}) =>
  ({
    opportunity: { id: 'o1', title: 'Vendor credentialing audit workbook', offerScope: null, buyingSignal: null, source: null, payer: 'Dental practices', reachableChannel: 'Published practice emails', fulfillmentOwner: null },
    price: input(400, 'EVIDENCE', 'the price on the card'),
    directCost: input(20, 'EVIDENCE'),
    volume: input(30, 'EVIDENCE', '30 practices buy each month'),
    repeatable: true,
    daysToCash: input(5, 'EVIDENCE'),
    fulfilledBy: { value: 'BRAIN', provenance: 'EVIDENCE', source: null },
    competitiveAward: false,
    agreed: false,
    agreedDeals: 0,
    ...over,
  }) as never;

describe('the commercial reality check (§116)', () => {
  it('passes a real purchase by a population at evidenced volume, delivered and paid in time', () => {
    expect(commercialRealityOf(leg(), 30)).toEqual({ opportunityId: 'o1', validated: true, failing: [] });
  });

  it('rejects the audited GitHub leg: a reward as the price, one company swept as 200 buyers, no channel, nobody to deliver', () => {
    const github = leg({
      opportunity: { id: 'arr_6f3b7a404ca5', title: 'Constructed: GitHub Inc is the payer — its bug bounty page publishes rewards of $10,000 or more', offerScope: null, buyingSignal: null, source: null, payer: 'GitHub, Inc.', reachableChannel: null, fulfillmentOwner: null },
      price: input(10000, 'EVIDENCE', 'GitHub Inc pays $10,000 per slot for a critical finding in its public bug bounty program.'),
      volume: input(null, 'UNKNOWN', 'nobody has established how many buyers exist', 1, 200),
      fulfilledBy: null,
    });
    const r = commercialRealityOf(github, 16);
    expect(r.validated).toBe(false);
    expect(r.failing.map((f) => f.requirement)).toEqual(expect.arrayContaining(['PURCHASE', 'BUYER_POPULATION', 'ACQUISITION', 'VOLUME', 'DELIVERY_AND_PAYMENT']));
  });

  it('rejects an assumed price, a loss-making deal and an award with no evidence it pays in time', () => {
    expect(commercialRealityOf(leg({ price: input(400, 'ASSUMPTION', 'swept') }), 30).failing[0]!.requirement).toBe('BUYERS_BUY_IT');
    expect(commercialRealityOf(leg({ directCost: input(500, 'EVIDENCE') }), 30).failing.map((f) => f.requirement)).toContain('ECONOMICS');
    expect(commercialRealityOf(leg({ competitiveAward: true, daysToCash: input(null, 'UNKNOWN', '', 8, 30) }), 30).failing.map((f) => f.requirement)).toContain('DELIVERY_AND_PAYMENT');
  });

  it('keeps legitimate unusual mechanisms: an affiliate payout from one vendor that buys referrals repeatedly, with evidence', () => {
    const affiliate = leg({ opportunity: { id: 'aff', title: 'Referrals for an invoicing vendor', offerScope: null, buyingSignal: null, source: null, payer: 'Invoicing software vendor (affiliate program)', reachableChannel: 'Comparison pages', fulfillmentOwner: null }, price: input(200, 'EVIDENCE', "The vendor's affiliate program pays affiliates $200 for each paying customer they refer") });
    expect(commercialRealityOf(affiliate, 60).validated).toBe(true);
  });

  it('a plan with no counted strategy is not validated, and the leg verdict names the mechanism', () => {
    expect(planCommercialReality([], 30).validated).toBe(false);
    expect(legFeasibility('x', { gaps: ['NOT_A_PURCHASE'], permissionsMissing: [] }).lacks).toContain('MECHANISM');
    expect(legFeasibility('x', { gaps: ['ONE_PAYER_REPEATS'], permissionsMissing: [] }).supported).toBe(false);
  });
});
