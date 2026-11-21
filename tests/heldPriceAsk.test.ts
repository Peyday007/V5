/**
 * Production 2026-11-21 (goal C, plan read 44842405254): an accepted goal-price
 * claim became a $6,000 construction fact and the plan carried it (COMPARABLE
 * p50 6000, one observation), yet the research step still read "what buyers of
 * this kind are published as paying" as if no price existed. A held price is
 * asked as what would establish it.
 */
import { describe, expect, it } from 'vitest';
import { heldPriceAsk } from '../server/services/goals/arrangementSteps.ts';
import { PART_ASK } from '../server/services/cash/construct.ts';

describe('a price the model holds is asked as what would establish it', () => {
  it('names one held observation and asks for a further independent one', () => {
    const ask = heldPriceAsk({ observations: 1, p50: 6000 }, 'USD');
    expect(ask).toContain('one published price (USD 6,000)');
    expect(ask).toMatch(/not yet established/);
    expect(ask).not.toBe(PART_ASK['value']);
  });
  it('names several observations by their middle', () => {
    expect(heldPriceAsk({ observations: 3, p50: 449.4 }, 'USD')).toContain('3 published prices (middle USD 449)');
  });
});
