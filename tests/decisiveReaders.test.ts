import { describe, expect, it } from 'vitest';
import { readPriceEvidence } from '../server/domain/paymentNature.ts';
import { readSettlementDays } from '../server/services/cash/figures.ts';
import { isCompetitiveAward, statesNoCost } from '../server/services/cash/goalScenario.ts';
import { payerNounWords, readVolume } from '../server/services/cash/volume.ts';

/*
 * Readers that dropped evidence real research filed on the decisive-10 fresh
 * goals (2026-11-25). Each sentence below is a researcher's, unedited; each
 * reading was null or refused before, so the plan read a researched link as
 * unknown.
 */
describe('evidence the decisive-10 research filed reaches the plan', () => {
  it('counts a payer named with its kinds in a parenthesis by its own head noun', () => {
    const payer = 'Michigan local governments (cities, townships, counties)';
    expect(payerNounWords(payer)).toEqual(expect.arrayContaining(['governments', 'government', 'cities', 'townships', 'counties']));
    const read = readVolume('Nearly 200 Michigan local governments publish their bids through MITN.', 120, payer, null);
    expect(read?.buyers).toBe(200);
  });

  it('reads a rate per unit of work a platform pays its suppliers as a price', () => {
    expect(readPriceEvidence('Lugg invites box truck companies to become fleet partners and claim booked local moves it sends, averaging $165 per crew hour with typical jobs of $390–$590.', { payer: 'Lugg (on-demand moving platform)', title: 'booked local moves crewed with the owner’s box truck as a fleet partner' }).counts).toBe(true);
    expect(readPriceEvidence('Lead Smart publishes top net publisher payouts per qualified lead of $122.50 for HVAC and $121.28 for plumbing.', { payer: 'home-service pay-per-call networks', title: 'qualified inbound homeowner calls' }).counts).toBe(true);
  });

  it('reads a payout schedule as its longest wait', () => {
    expect(readSettlementDays('Lugg pays out at the end of every workday, plus tips.')).toBe(1);
    expect(readSettlementDays('Dispatch fees are invoiced weekly.')).toBe(7);
    expect(readSettlementDays('Lead Smart pays monthly, around the 10th, for the previous month.')).toBe(40);
    expect(readSettlementDays('Payment terms are not published.')).toBeNull();
  });

  it('reads an explicit statement that taking part costs nothing, and nothing less explicit', () => {
    expect(statesNoCost('Lugg charges fleets no lead fees and no bidding; jobs are first come, first served.')).toBe(true);
    expect(statesNoCost('A free Limited Access registration; paid tiers cost $108 a year.')).toBe(false);
    expect(statesNoCost('Registration requires a company name and address.')).toBe(false);
  });

  it('reads a service sold to award seekers as a sale, and an award or solicitation as an award', () => {
    expect(isCompetitiveAward({ title: 'Recurring outsourced work: US nonprofits · outsourced grant prospect research and proposal drafting', source: null, buyingSignal: null })).toBe(false);
    expect(isCompetitiveAward({ title: 'City RFP for janitorial services', source: null, buyingSignal: null })).toBe(true);
    expect(isCompetitiveAward({ title: 'Grant program: a state arts council awards $5,000 grants', source: null, buyingSignal: null })).toBe(true);
  });
});
