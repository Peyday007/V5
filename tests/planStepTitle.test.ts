import { describe, expect, it } from 'vitest';
import { changeTitle } from '../server/services/goals/stepTitle.ts';

// Production plan read 2026-11-19 (goal wst_4f0c312400e1425dab2e): reconstruction keys printed as step names.
describe('a reconstruction change reads as words in a plan step', () => {
  it('names a focus change by what it does, not "focus:4"', () => {
    expect(changeTitle({ label: 'focus:4', detail: 'concentrate outreach and money on the 4 opening(s) that settle most per interested buyer, and drop 2' }))
      .toBe('Concentrate outreach and money on the 4 opening(s) that settle most per interested buyer');
  });

  it('names a price change by what it does, keeping its parenthesised scope', () => {
    expect(changeTitle({ label: 'price×2.50@SMALL_TICKET', detail: 'raise price ×2.50 on 4 opening(s) (SMALL_TICKET), each held within ×0.25–×4 of its card\'s unit price; close rate and the deals the market takes assumed to move ×0.33 until selling measures it' }))
      .toBe('Raise price ×2.50 on 4 opening(s) (SMALL_TICKET)');
  });

  it('stops at a colon and does not split inside parentheses', () => {
    expect(changeTitle({ label: 'deposit', detail: 'ask for a deposit of 20–50% at signing (assumed accepted): that share arrives at the fast end' }))
      .toBe('Ask for a deposit of 20–50% at signing (assumed accepted)');
    expect(changeTitle({ label: 'bundle', detail: 'sell a bundle of 4 unit(s) at 10% off (×3.6 the unit price, ×4.0 its direct cost); close rate assumed ×0.8 until measured' }))
      .toBe('Sell a bundle of 4 unit(s) at 10% off (×3.6 the unit price, ×4.0 its direct cost)');
  });

  it('never prints the raw key when there is no description', () => {
    const t = changeTitle({ label: 'referral-partner>arr_53ae6fed770b', detail: '' });
    expect(t).not.toContain('>');
    expect(t).toBe('Referral-partner arr 53ae6fed770b');
  });
});
