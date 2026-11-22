/**
 * planningReliability round 8: three general readings, each pure.
 *
 *   1. A price per billing period contests a card exactly as a whole-deal
 *      figure does: a recurring card's price is one period's price, so a
 *      source stating a quarter of it per month is a contradiction, not a
 *      rate the card might be a multiple of.
 *   2. A count of buyers who each put their work out to bid once a period is
 *      a count of solicitations a period, read over the window only.
 *   3. Hours a card states for work Brain produces, or a named supplier
 *      fulfils, are not the owner's hours.
 */
import { describe, expect, it } from 'vitest';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { priceContradiction, statedHoursNotOwners } from '../server/services/cash/goalScenario.ts';
import { readTrialVolume } from '../server/services/cash/volume.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

describe('a per-period price contests the card', () => {
  it('marks a billing period, and nothing smaller, as one period\'s price', () => {
    expect(readMoneyFigures('$150 a month', 'USD')[0]).toMatchObject({ perUnit: true, perPeriod: true });
    expect(readMoneyFigures('$150/mo', 'USD')[0]).toMatchObject({ perUnit: true, perPeriod: true });
    expect(readMoneyFigures('$1,800 annually', 'USD')[0]).toMatchObject({ perUnit: true, perPeriod: true });
    expect(readMoneyFigures('$150 a month per location', 'USD')[0]?.perPeriod).toBeUndefined();
    expect(readMoneyFigures('$40 an hour', 'USD')[0]?.perPeriod).toBeUndefined();
    expect(readMoneyFigures('$0.05 per word', 'USD')[0]?.perPeriod).toBeUndefined();
  });

  it('contests a card several times the sourced monthly price, either way', () => {
    expect(priceContradiction(600, '$150 a month', 'USD')).toMatchObject({ stated: 150 });
    expect(priceContradiction(150, '$600 per month', 'USD')).toMatchObject({ stated: 600 });
  });

  it('leaves a restated monthly price, or a rate per smaller unit, uncontested', () => {
    expect(priceContradiction(150, '$150 a month', 'USD')).toBeNull();
    expect(priceContradiction(160, 'about $150/month', 'USD')).toBeNull();
    expect(priceContradiction(600, '$150 a month per location', 'USD')).toBeNull();
    expect(priceContradiction(600, '$40 an hour', 'USD')).toBeNull();
  });
});

describe('buyers who each solicit bids are solicitations', () => {
  it('reads the issuers\' period as a rate over the window, never the whole year', () => {
    const read = readTrialVolume('90 county libraries tender their cleaning contract each year.', 73, 'bids');
    expect(read).toMatchObject({ deals: 18, counted: 'BUYERS' });
    expect(readTrialVolume('52 water districts put their meter-reading work out to bid every year.', 70, 'tenders')?.deals).toBe(9);
  });

  it('reads nothing for another unit, a count of the tenders themselves, or no period', () => {
    expect(readTrialVolume('90 county libraries tender their cleaning contract each year.', 73, 'visitors')).toBeNull();
    expect(readTrialVolume('90 county libraries tender their cleaning contract.', 73, 'bids')).toBeNull();
    expect(readTrialVolume('400 libraries are listed in the directory.', 73, 'bids')).toBeNull();
  });
});

describe('stated hours are the performer\'s', () => {
  const card = (over: Partial<CashOpportunity>): Pick<CashOpportunity, 'id' | 'offerScope' | 'title' | 'payer' | 'fulfillmentOwner' | 'humanHours'> => ({
    id: 'cop_y', offerScope: null, title: 'An opening', payer: 'Clinic owners', fulfillmentOwner: null, humanHours: 2, ...over,
  });
  const delivers = ['spreadsheet', 'website'];

  it('reads 0 owner hours when Brain produces a proved deliverable', () => {
    expect(statedHoursNotOwners(card({ title: 'Landing pages for clinics' }), delivers, false)?.value).toBe(0);
    // The card's delivery statement names it when the title does not.
    expect(statedHoursNotOwners(card({ title: 'Rota planning for clinics' }), delivers, false, null, 'A spreadsheet Brain produces.')?.value).toBe(0);
  });

  it('reads 0 owner hours when an established supplier who is not the owner fulfils', () => {
    expect(statedHoursNotOwners(card({ fulfillmentOwner: 'Acme Staffing (quoted)' }), delivers, true)?.value).toBe(0);
  });

  it('keeps the stated hours the owner\'s otherwise', () => {
    expect(statedHoursNotOwners(card({ fulfillmentOwner: 'The owner, personally' }), delivers, true)).toBeNull();
    expect(statedHoursNotOwners(card({ fulfillmentOwner: 'Acme Staffing' }), delivers, false)).toBeNull();
    expect(statedHoursNotOwners(card({ title: 'Rota planning for clinics' }), delivers, false)).toBeNull();
    expect(statedHoursNotOwners(card({ title: 'Rota planning for clinics' }), delivers, false, null, 'A spreadsheet the owner fills in.')).toBeNull();
    expect(statedHoursNotOwners(card({ humanHours: null, title: 'Landing pages for clinics' }), delivers, false)).toBeNull();
  });
});
