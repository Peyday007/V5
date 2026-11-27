/**
 * `readVolume` multiplies a rate by a count only where the text says each
 * counted unit does that rate. planningReliability case ho-11 found the
 * reader taking "35 pharmacies ship 20 deliveries a week" as 85 orders a month:
 * the 35x population was dropped. The correct reading is 35 x 20 x 30/7 = 3,000.
 * Ambiguous or collective phrasings keep the conservative reading — a
 * multiplier the text does not state is never invented.
 */
import { describe, expect, it } from 'vitest';
import { payerAgentWords, payerNounWords, readVolume } from '../server/services/cash/volume.ts';

describe('readVolume: a count of units each doing a rate multiplies', () => {
  it.each([
    ['35 independent pharmacies in the county ship 20 temperature-controlled deliveries a week.'],
    ['35 pharmacies ship 20 deliveries a week'],
    ['35 pharmacies each place 20 orders a week'],
    ['35 pharmacies ship 20 deliveries a week each'],
    ['Each of the 35 pharmacies ships about 20 deliveries a week.'],
    ['20 deliveries a week from each of 35 pharmacies'],
    ['20 deliveries a week per pharmacy across 35 pharmacies'],
    ['20 deliveries per pharmacy a week, across 35 pharmacies'],
  ])('%s → 3,000 in 30 days', (text) => {
    expect(readVolume(text, 30)).toMatchObject({ deals: 3000, buyers: 35 });
  });

  it('multiplies at any period and window', () => {
    expect(readVolume('120 firms ship 3 orders a month', 30)).toMatchObject({ deals: 360, buyers: 120 });
    expect(readVolume('1,200 stores registered in Ohio typically place 2 orders a year', 365)).toMatchObject({ deals: 2400, buyers: 1200 });
    expect(readVolume('40 clinics book 5 jobs per day', 7)).toMatchObject({ deals: 1400, buyers: 40 });
  });

  it('reads a rate stated across a population as the total it is', () => {
    expect(readVolume('700 deliveries a week across 35 pharmacies', 30)).toMatchObject({ deals: 3000, buyers: null });
  });

  it('takes the slowest stated rate, as before', () => {
    expect(readVolume('35 pharmacies ship 20 deliveries a week; the courier can take 50 deliveries a week.', 30)!.deals).toBe(214);
  });
});

describe('readVolume: an ambiguous rate is never multiplied', () => {
  it.each([
    ['35 pharmacies together ship 20 deliveries a week'],
    ['35 pharmacies collectively ship 20 deliveries a week'],
    ['35 pharmacies ship 20 deliveries a week in total'],
    ['35 pharmacies ship 20 deliveries a week between them'],
    ['35 pharmacies and 20 deliveries a week'],
    ['35 pharmacies use a courier making 20 deliveries a week'],
    ['35 pharmacies; the courier makes 20 deliveries a week'],
    ['35 pharmacies. The courier completes 20 deliveries a week.'],
    ['35 pharmacies with 20 deliveries a week'],
    ['35 pharmacies that ship 20 deliveries a week'],
    ['Of 35 pharmacies, 3 ship 20 deliveries a week'],
    ['20 deliveries a week per pharmacy'],
  ])('%s → the rate alone', (text) => {
    expect(readVolume(text, 30)).toMatchObject({ deals: 85, buyers: null });
  });

  it('leaves the existing readings unchanged', () => {
    expect(readVolume('about 40 orders a month', 30)?.deals).toBe(40);
    expect(readVolume('120 orders per month are published in the category', 30)).toMatchObject({ deals: 120 });
    expect(readVolume('200 restaurants buy weekly', 30)!.deals).toBe(800);
    expect(readVolume('12 businesses', 30)).toMatchObject({ deals: 12, everyDays: null });
    expect(readVolume('$5,000 per engagement', 30)).toBeNull();
    expect(readVolume('Thousands of buyers need this', 30)).toBeNull();
  });
});

/*
 * A count of the payer's own noun counts buyers, and a stated share of them who
 * buy narrows it (planningReliability round 3, 2026-11-22). Synthetic texts: a
 * venue's listed caterers, not any case's own words.
 */
describe('readVolume: the payer names its own buyers, and a stated share narrows them', () => {
  it('reads a count of the payer’s head noun as buyers', () => {
    expect(payerNounWords('Wedding caterers')).toEqual(['caterers', 'caterer']);
    expect(payerNounWords('Contractors renting mini-excavators')).toEqual(['contractors', 'contractor']);
    expect(payerNounWords('Independent garden centres')).toEqual(['centres', 'centre']);
    expect(payerNounWords(null)).toEqual([]);
    expect(readVolume('The venue lists 300 approved caterers.', 30)).toBeNull();
    expect(readVolume('The venue lists 300 approved caterers.', 30, 'Wedding caterers')).toMatchObject({ deals: 300, buyers: 300 });
  });

  it('narrows the count to the share stated to buy, never past it', () => {
    const text = 'The venue lists 300 approved caterers; the venue reports 40% hire their linen rather than own it.';
    expect(readVolume(text, 30, 'Wedding caterers')).toMatchObject({ deals: 120, buyers: 120 });
    // Two stated shares: the smaller.
    expect(readVolume('300 caterers; 40% hire linen and 25% hire glassware.', 30, 'Wedding caterers')).toMatchObject({ buyers: 75 });
  });

  it('is not narrowed by a share of something else', () => {
    for (const text of ['300 caterers, at 15% off list', '300 caterers; 30% margin on each order', '300 caterers at a 28% impression share', '300 caterers, 10% of revenue']) {
      expect(readVolume(text, 30, 'Wedding caterers')).toMatchObject({ buyers: 300 });
    }
  });
});

/*
 * Published buyer-volume evidence read both ways (2026-11-23): a real stated
 * volume read as unknown made Brain refuse plans as MARKET_VOLUME-unknown, and
 * a count of sellers read as buyers invented volume.
 */
describe('readVolume: real stated volume is read', () => {
  it('counts a payer named for its trade by the trade’s agent noun, repeating at the stated frequency', () => {
    expect(payerAgentWords('Licensed local moving companies')).toEqual(['mover', 'movers']);
    expect(payerAgentWords('Roofing contractors')).toEqual(['roofer', 'roofers']);
    expect(payerAgentWords('Companies entering trade-industry awards programmes')).toEqual([]);
    const text = 'The state household-goods register lists 2,400 licensed movers; lead marketplaces report they reorder packs monthly.';
    // Without the payer, "movers" is no buyer word; a register's licensed count is still a population (2026-11-24).
    expect(readVolume(text.replace('licensed ', ''), 30)).toBeNull();
    expect(readVolume(text, 30)).toMatchObject({ buyers: 2400, counted: 'BUYERS' });
    expect(readVolume(text, 30, 'Licensed local moving companies')).toMatchObject({ deals: 2400, buyers: 2400, everyDays: 30, counted: 'BUYERS' });
    expect(readVolume(text, 60, 'Licensed local moving companies')).toMatchObject({ deals: 4800, buyers: 2400, everyDays: 30 });
  });

  it('reads paid entries a year as the market’s purchases', () => {
    const text = 'The twelve largest trade awards programmes receive about 9,000 paid entries a year; three have entry deadlines inside the next 45 days.';
    expect(readVolume(text, 365, 'Companies entering trade-industry awards programmes')).toMatchObject({ deals: 9000, buyers: null, counted: 'ORDERS' });
    expect(readVolume(text, 30, 'Companies entering trade-industry awards programmes')).toMatchObject({ deals: 739, counted: 'ORDERS' });
  });

  it.each([
    ['45 commercial solar installers operate in the tri-county area; each buys about 10 qualified leads a month.'],
    ['45 commercial solar installers in the region each buy about 10 qualified leads a month.'],
  ])('%s → 45 buyers, 10 a month each', (text) => {
    expect(readVolume(text, 30, 'Commercial solar installers')).toMatchObject({ deals: 450, buyers: 45 });
    expect(readVolume(text, 90, 'Commercial solar installers')).toMatchObject({ deals: 1350, buyers: 45 });
  });

  it.each([
    ['220 heat pump installers are registered with the utility; each files several rebate applications a week.'],
    ['220 heat pump installers in the state each file several rebate applications a week.'],
  ])('%s → "several" read at its low end, 2 a week each, and says so', (text) => {
    const reading = readVolume(text, 7, 'Residential heat pump installers');
    expect(reading).toMatchObject({ deals: 440, buyers: 220 });
    expect(reading!.basis).toContain('"several" read at its low end, 2');
  });

  it('keeps "each of" and a rate belonging to someone else as before', () => {
    expect(readVolume('Each of the 35 pharmacies ships about 20 deliveries a week.', 30)).toMatchObject({ deals: 3000, buyers: 35 });
    expect(readVolume('35 pharmacies; the courier makes 20 deliveries a week', 30)).toMatchObject({ deals: 85, buyers: null });
  });
});

describe('readVolume: the supply side and web counts are never buyers', () => {
  it('reads sales over a trailing span as market purchases, never its sellers as buyers', () => {
    const text = 'The marketplace shows 2,300 sales of comparable meal-plan workbooks in the last 12 months across 40 sellers; buyers return each season.';
    // Spread across 40 sellers, the category's 191 monthly orders are one listing's average share of about 4 (mv-04, 2026-11-27).
    expect(readVolume(text, 30, 'Home cooks buying meal-plan workbooks')).toMatchObject({ deals: 4, buyers: null, counted: 'ORDERS' });
    expect(readVolume(text, 30)!.basis).toMatch(/across 40 sellers.*average share is 4 in 30 days/);
    expect(readVolume(text, 360)).toMatchObject({ deals: 57, buyers: null });
    // Controls: the same total with no sellers named is the market's whole rate, and a total across a few sellers leaves each a large share.
    expect(readVolume('The marketplace shows 2,300 sales of comparable meal-plan workbooks in the last 12 months.', 30)).toMatchObject({ deals: 191, buyers: null });
    expect(readVolume('The marketplace shows 2,300 sales of comparable meal-plan workbooks in the last 12 months across 4 sellers.', 30)).toMatchObject({ deals: 47 });
    // A count of units that buy is not a count of sellers: orders from 40 stores are 40 buyers ordering.
    expect(readVolume('The distributor shows 2,300 orders in the last 12 months from 40 stores.', 30)!.deals).toBe(191);
  });

  it.each([
    ['The marketplace lists 40 sellers of comparable meal-plan workbooks.', null],
    ['2,300 copies of comparable workbooks were sold across 40 shops.', null],
    ['40 agencies offering the service compete for these clients.', null],
    ['12 vendors selling comparable kits are listed.', null],
    ['15 firms compete for the same contracts.', null],
    ['Google shows 2.1M results for moving companies.', 'Licensed local moving companies'],
    ['Google shows 2,100,000 results for local movers.', 'Licensed local moving companies'],
    ['The page has 40,000 LinkedIn followers among companies.', 'Companies entering trade-industry awards programmes'],
    ['The association has 40,000 LinkedIn followers.', null],
    ['A search returns 1,200 webpages about movers.', 'Licensed local moving companies'],
  ])('%s → null', (text, payer) => {
    expect(readVolume(text, 30, payer)).toBeNull();
  });

  it('still counts a payer that is itself a seller', () => {
    expect(readVolume('The platform has 3,000 active Etsy sellers in the craft category.', 30, 'Etsy sellers')).toMatchObject({ buyers: 3000 });
  });
});

/*
 * Market sizes stated as a licensed population, a count of licences, a flow of new
 * licences, another listed kind of the payer, or a consumer platform's hundreds of millions
 * (planner residuals, 2026-11-25). Synthetic texts in the shapes research publishes, not any
 * case's own words.
 */
describe('readVolume: a licensed population is the payer when it is the payer’s kind', () => {
  it('counts a population an authority licenses when it shares the payer’s kind', () => {
    expect(readVolume('The state board licenses about 310 veterinary and animal-boarding clinics in the three counties.', 30, 'Veterinary practices in the tri-county area'))
      .toMatchObject({ buyers: 310, counted: 'BUYERS' });
  });

  it('counts licences in a registry by the holder the sentence names', () => {
    expect(readVolume("The state's electrician registry holds over 12,000 active licences.", 30, 'Small electricians and their office staff'))
      .toMatchObject({ buyers: 12000 });
  });

  it('reads new licences a period as new buyers in the window, and never that period as a purchase frequency', () => {
    expect(readVolume('The agency grants about 300 new food-truck permits every month, mostly to single-truck operators.', 60, 'Food-truck operators with one or two trucks'))
      .toMatchObject({ buyers: 600, deals: 600, everyDays: null });
  });

  it('counts another kind of buyer the payer lists, and the sites a payer is reached at', () => {
    expect(readVolume('The county lists about 900 landscapers.', 30, 'Small plumbers, landscapers and cleaners')).toMatchObject({ buyers: 900 });
    expect(readVolume('The metro area has about 1,400 warehouses.', 30, 'Workers at warehouses, garages and laundromats')).toMatchObject({ buyers: 1400 });
  });

  it('reads a consumer platform’s hundreds of millions, and a "monthly" count as a count, not a frequency', () => {
    expect(readVolume('The marketplace serves more than 300 million monthly shoppers.', 60, 'Marketplace shoppers')).toMatchObject({ buyers: 300_000_000, everyDays: null });
  });

  it.each([
    // a licensed population that is not the payer's kind
    ['The city issues about 5,000 food-truck permits a year.', 'Dental office managers'],
    // licensed sellers competing with the offer
    ['The state licenses 300 staffing agencies that offer the same service.', 'Staffing agencies hiring nurses'],
    // a count with no licensing act at all
    ['The software ships with 40,000 seats.', 'Software resellers'],
  ])('%s → not a licensed buyer count', (text, payer) => {
    expect(readVolume(text, 30, payer)).toBeNull();
  });
});

/*
 * 2026-11-24 investigation §3, residuals on supplied routes: a market stated as a
 * register of licensed entities, as a flow of new entrants, or as a consumer
 * marketplace's published user count read as unsized.
 */
describe('readVolume: registers, flows and published platform counts are sized populations', () => {
  it.each([
    ['There are 12,400 licensed notaries in the state.', 12_400],
    ['There are 12,000 notaries commissioned in Ohio.', 12_000],
    ['The state has 6,500 active liquor licences.', 6_500],
    ['The FMCSA register shows 3,000 carriers are registered in Michigan.', 3_000],
  ])('%s → %i buyers, one purchase each', (text, buyers) => {
    expect(readVolume(text, 30)).toMatchObject({ buyers, deals: buyers, counted: 'BUYERS', everyDays: null });
  });

  it.each([
    ['FMCSA grants about 4,000 new authorities every month.', 30, 4_000],
    ['About 4,000 new motor carrier authorities are granted every month.', 90, 12_000],
    ['Roughly 1,500 new LLCs are formed in the county each month.', 14, 700],
    ['About 900 new restaurant permits are issued every year in the city.', 30, 73],
    ['Each month, about 1,500 new LLCs are formed in the county.', 30, 1_500],
  ])('%s → a flow: buyers arriving inside %i days = %i, never a cadence of repeat purchases', (text, window, buyers) => {
    const reading = readVolume(text, window);
    expect(reading).toMatchObject({ buyers, deals: buyers, counted: 'BUYERS', everyDays: null });
    expect(reading!.basis).toContain('arrive as buyers');
  });

  it.each([
    ['Etsy reports 96 million active buyers.', 96_000_000],
    ['Etsy has 96.5M active buyers and 7 million sellers.', 96_500_000],
    ['Vinted has over 80 million registered members across Europe.', 80_000_000],
  ])('%s → a consumer marketplace sized from its published count', (text, buyers) => {
    expect(readVolume(text, 30)).toMatchObject({ buyers, counted: 'BUYERS' });
  });

  it('reads "monthly active users" as a population, never as each user buying monthly', () => {
    expect(readVolume('The app has 2.5 million monthly active users.', 90)).toMatchObject({ buyers: 2_500_000, deals: 2_500_000, everyDays: null });
  });

  it('still refuses a register of sellers, a money figure and a measure', () => {
    expect(readVolume('40 licensed agencies offering the service compete for these clients.', 30)).toBeNull();
    expect(readVolume('Permits cost $4,000 every month.', 30)).toBeNull();
    expect(readVolume('Google shows 2.1M results for licensed movers.', 30)).toBeNull();
    expect(readVolume('About 4,000 new listings are added every month.', 30)).toBeNull();
  });
});
