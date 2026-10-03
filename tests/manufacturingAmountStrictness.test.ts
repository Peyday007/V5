import { describe, expect, it } from 'vitest';
import { validateCapabilityFinding } from '../server/domain/manufacturing.ts';

const base = {
  where: 'claims[0]',
  finding: 'CAPITAL_REQUIREMENT',
  subject: 'TOOLING_AND_EQUIPMENT',
  observedOn: '2026-05-01',
  qualifier: 'TYPICAL_ENTRY',
  basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
  currency: 'USD',
};

const check = (amount: unknown) =>
  validateCapabilityFinding({ ...base, amountLowMinor: amount, amountHighMinor: amount });

describe('a capital amount is a whole number of minor units or it is refused', () => {
  it.each(['  ', '', '0x10', '12500.00', '1e6', '12,500', '-5', '+5', ' 5', '5 ', '1.5'])(
    'refuses the string %j',
    (amount) => {
      expect(check(amount).ok).toBe(false);
    },
  );

  it('refuses unsafe, negative and non-finite numbers', () => {
    for (const amount of [Number.MAX_SAFE_INTEGER + 2, -1, NaN, Infinity, 10.5]) {
      expect(check(amount).ok).toBe(false);
    }
  });

  it('refuses a digit string beyond the safe integer range', () => {
    expect(check('99999999999999999999').ok).toBe(false);
  });

  it('still accepts integers and digit-only strings', () => {
    for (const amount of [12500, 0, '12500', '0']) {
      expect(check(amount).ok).toBe(true);
    }
  });
});
