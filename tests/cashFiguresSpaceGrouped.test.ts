import { describe, expect, it } from 'vitest';
import { readMoneyFigures } from '../server/services/cash/figures.ts';

describe('space-grouped figures', () => {
  it('refuses a space-grouped number rather than truncating it', () => {
    expect(readMoneyFigures('$12 000', 'USD')).toEqual([]);
    expect(readMoneyFigures('$12 per hour', 'USD').map((f) => f.cents)).toEqual([1200]);
  });
});
