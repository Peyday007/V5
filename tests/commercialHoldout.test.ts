import { describe, expect, it } from 'vitest';
import { arrangementExclusion, readPriceEvidence, wrongWayPrice } from '../server/domain/paymentNature.ts';
import { COMMERCIAL_BLIND, COMMERCIAL_HOLDOUT, type HoldoutCase } from './fixtures/commercialHoldout.ts';

/**
 * Commercial classification by transaction structure (Task E, 2026-11-24).
 *
 * Scores, recorded when the reading was built:
 *   holdout (40 cases, written before tuning): 27/40 with the classifier then
 *     on production (nonCommercialExclusion + payerPaysOut + paymentNatureOf +
 *     evidenceIsAbout + evidencesPurchase), 40/40 with readPriceEvidence.
 *   blind (18 cases, written after, scored once untuned): legacy 13/18,
 *     readPriceEvidence 16/18 on first score; the two misses (a developer's
 *     fee for a website, a part-time job ad) were fixed generally (what the
 *     money is "for" decides before the payee's role name; part-time and
 *     hiring frames are employment) and are pinned here.
 */
const goal = 'Collect 10000 dollars of settled cash within 30 days using little up-front capital';
const counts = (c: HoldoutCase): boolean => !arrangementExclusion(c, goal) && readPriceEvidence(c.evidence, c).counts;

describe('commercial holdout: a figure counts only when this buyer pays a supplier for this deliverable', () => {
  for (const c of [...COMMERCIAL_HOLDOUT, ...COMMERCIAL_BLIND]) {
    it(`${c.id} ${c.kind}: ${c.counts ? 'counts' : 'does not count'}`, () => {
      expect(counts(c), `${c.evidence} → ${JSON.stringify(readPriceEvidence(c.evidence, c))} / ${arrangementExclusion(c, goal)}`).toBe(c.counts);
    });
  }
  it('keeps every evidence-based estimate and comparable-buyer price', () => {
    const estimates = [...COMMERCIAL_HOLDOUT, ...COMMERCIAL_BLIND].filter((c) => c.kind === 'ESTIMATE');
    expect(estimates.length).toBeGreaterThanOrEqual(4);
    for (const c of estimates) expect(counts(c)).toBe(true);
  });
});

describe('the audit cases that motivated it (fresh-plan audit, 2026-11-24)', () => {
  it('reads a public-procurement bid-document fee as paid by the bidder', () => {
    const district = { title: 'School District of Philadelphia: custodial supplies bid', payer: 'The School District of Philadelphia', offerScope: 'Custodial supplies under the published bid', buyingSignal: 'Open invitation for bids', source: 'district procurement portal' };
    expect(readPriceEvidence('The School District of Philadelphia charges a $15 non-refundable fee for each bid package.', district).direction).toBe('PAID_BY_SELLER');
    expect(readPriceEvidence('Bid documents are available from the Office of Procurement Services at $15 per set.', district).direction).toBe('PAID_BY_SELLER');
    // The same district's contract value is its price.
    expect(readPriceEvidence('The district awarded a $48,000 contract for custodial supplies last year, payable net 30.', district).counts).toBe(true);
  });
  it("reads a domain broker's upfront fee as the price of brokering, not of a different deliverable", () => {
    const leg = { title: 'Constructed: domain buyer or seller — naming shortlist workbook', payer: 'domain buyer or seller', offerScope: 'Domain naming shortlist workbook' };
    const broker = "flat-fee-plus-commission brokers charge 10-20% plus a service fee 'often $75-$500'";
    expect(readPriceEvidence(broker, leg).direction).toBe('ANOTHER_DELIVERABLE');
    // When Brain sells the brokering itself, the broker's fee is its price.
    expect(readPriceEvidence(broker, { ...leg, title: 'Domain brokerage for sellers', offerScope: 'Domain brokerage' }).counts).toBe(true);
  });
  it('excludes funding programmes and funders paying out, and keeps grant writing a sale', () => {
    expect(arrangementExclusion({ title: 'The RFP', payer: 'Market: US federal grants (NEH cooperative agreements), not a buyer', buyingSignal: "NEH's NDNP page lists an open funding opportunity" }, goal)).toMatch(/not a sale/);
    expect(arrangementExclusion({ title: 'Farm business plan', payer: 'Pennsylvania: the Farm Vitality Planning Grant reimburses the cost of business planning' }, goal)).toMatch(/not a sale/);
    expect(arrangementExclusion({ title: 'Collections care', payer: 'Institute of Museum and Library Services', buyingSignal: 'Applications invited; awards up to $250,000' }, goal)).toMatch(/not a sale/);
    expect(arrangementExclusion({ title: 'Federal grant proposal writing', payer: 'Small nonprofits', offerScope: 'Writing a federal grant proposal' }, goal)).toBeNull();
    expect(arrangementExclusion({ title: 'Collections care', payer: 'Institute of Museum and Library Services' }, 'Win $50,000 of federal grant funding for the museum')).toBeNull();
    // A funder that buys through procurement is a buyer.
    expect(arrangementExclusion({ title: 'Program evaluation', payer: 'Regional community foundation', buyingSignal: 'RFP for an external program evaluation' }, goal)).toBeNull();
  });
  it('reads the body a payer names, not the program it is registered with (2026-11-27 frozen run, fx-15)', () => {
    const varroa = { title: 'Varroa mite-load analysis reports from sticky-board photos for commercial beekeepers', payer: 'Commercial beekeepers registered with the state apiary program', offerScope: 'A mite-load report per apiary for the spring filing' };
    expect(arrangementExclusion(varroa, goal)).toBeNull();
    expect(arrangementExclusion({ ...varroa, payer: 'Dairy farms enrolled in the federal margin coverage program' }, goal)).toBeNull();
    expect(arrangementExclusion({ ...varroa, payer: 'Contractors who are members of the state apprenticeship program' }, goal)).toBeNull();
    // Controls: a program or funder that IS the payer still pays out, and is still excluded.
    expect(arrangementExclusion({ ...varroa, payer: 'The state apiary program' }, goal)).toMatch(/not a sale/);
    expect(arrangementExclusion({ ...varroa, payer: 'Riverside community foundation, registered with the state' }, goal)).toMatch(/not a sale/);
  });
});

describe('a price filed for a buyer population is never a fee the selling side pays', () => {
  it('refuses seller fees, input costs and payouts, and keeps a population buying', () => {
    expect(wrongWayPrice('Etsy charges sellers $0.20 per listing.', 'Etsy shoppers')?.direction).toBe('PAID_BY_SELLER');
    expect(wrongWayPrice('Print shops charge stationery designers $1.10 per invitation.', 'Engaged couples')?.direction).toBe('SUPPLIER_COST');
    expect(wrongWayPrice('Etsy sellers pay product photographers $20 per image.', 'Etsy sellers')).toBeNull();
    expect(wrongWayPrice('Community foundations pay evaluation consultants $12,000 per program evaluation.', 'Community foundations')).toBeNull();
  });
});
