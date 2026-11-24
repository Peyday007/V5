import { describe, expect, it } from 'vitest';
import { readDays, readSettlementDays } from '../server/services/cash/figures.ts';

/** A pay-at-the-sale term is a stated settlement, never an unknown one (2026-11-24 investigation). */
describe('readSettlementDays', () => {
  it('reads a stated zero as zero, where a duration reader refuses it', () => {
    expect(readDays('0 days')).toBeNull();
    expect(readSettlementDays('0 days')).toBe(0);
    expect(readSettlementDays('Paid in 0 business days.')).toBe(0);
  });
  it('reads same-day and at-checkout payment as zero days', () => {
    expect(readSettlementDays('Buyers pay at checkout by card.')).toBe(0);
    expect(readSettlementDays('Same-day payment by Stripe link.')).toBe(0);
  });
  it('keeps every stated duration as readDays reads it', () => {
    expect(readSettlementDays('5 days')).toBe(5);
    expect(readSettlementDays('Payout takes 2 weeks.')).toBe(14);
    expect(readSettlementDays('10 days')).toBe(10);
  });
  it('leaves a term that says nothing about when money lands unknown', () => {
    expect(readSettlementDays('Paid up front.')).toBeNull();
    expect(readSettlementDays('It settles next quarter.')).toBeNull();
    expect(readSettlementDays('')).toBeNull();
  });
});

import { readVolume } from '../server/services/cash/volume.ts';

/** A count whose own sentence says each of them buys counts buyers whatever its noun (2026-11-24 investigation). */
describe('readVolume: a count named as buyers by its own clause', () => {
  it('counts investors, facilities and LLCs that the sentence says each buy', () => {
    expect(readVolume('About 800 active Detroit investors are listed on BiggerPockets and local REIA rosters; each buys one.', 30, 'Detroit real-estate wholesalers, flippers and landlords', 'real estate investing')?.buyers).toBe(800);
    expect(readVolume('About 2,000 such facilities are listed in Oakland and Wayne counties; each pays monthly.', 30, 'Medical and dental offices, churches and gyms', 'commercial cleaning')?.buyers).toBe(2000);
  });
  it('still reads a count nobody says buys as unsized', () => {
    expect(readVolume('About 800 active Detroit investors are listed on BiggerPockets.', 30, 'Detroit real-estate wholesalers, flippers and landlords', 'real estate investing')).toBeNull();
    expect(readVolume('3,400 boats are registered; each needs a slip.', 30, null, null)).not.toBeNull();
  });
});
