import { describe, expect, it } from 'vitest';
import { readMoneyFigures } from '../server/services/cash/figures.ts';

/*
 * A range's unit is written once, after its upper end. Production 2026-11-25
 * (cop_a167f9eb396f43268de4): "Agencies charge $0.01 to $0.05 per email" read
 * its $0.01 as a whole purchase's price, and the card's price became USD 0.01.
 */
describe('a range states its unit for both ends', () => {
  it('reads the low end of a per-unit range as per unit', () => {
    const figures = readMoneyFigures('Agencies charge $0.01 to $0.05 per email for list cleaning', 'USD');
    expect(figures.map((f) => [f.cents, f.perUnit])).toEqual([[1, true], [5, true]]);
  });

  it('carries every kind of unit across a dash, a symbol-less end and a code', () => {
    expect(readMoneyFigures('$0.04-$0.08 per word', 'USD').every((f) => f.perUnit && f.perMeasure)).toBe(true);
    expect(readMoneyFigures('$200 – 400 a month', 'USD').every((f) => f.perUnit && f.perPeriod)).toBe(true);
    expect(readMoneyFigures('USD 300 to USD 500 per slot', 'USD').every((f) => f.perParticipant)).toBe(true);
  });

  it('leaves a whole-purchase range and separate figures as they were', () => {
    expect(readMoneyFigures('Projects cost $500 to $1,500 in total', 'USD').map((f) => f.perUnit)).toEqual([false, false]);
    expect(readMoneyFigures('A $2,000 setup fee and $50 per month', 'USD').map((f) => [f.cents, f.perUnit])).toEqual([[5000, true], [200000, false]]);
  });
});
