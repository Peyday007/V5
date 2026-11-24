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
