import { describe, expect, it } from 'vitest';
import { readMoneyFigures } from '../server/services/cash/figures.ts';

describe('currency symbol boundary', () => {
  it('does not read C$, A$ or NZ$ as a bare $', () => {
    expect(readMoneyFigures('Pays C$1,200 per job', 'USD')).toEqual([]);
    expect(readMoneyFigures('Budget A$500 and NZ$300', 'USD')).toEqual([]);
  });

  it('still reads them in their own currency, and US$ / $ under USD', () => {
    expect(readMoneyFigures('C$1,200', 'CAD').map((f) => f.cents)).toEqual([120000]);
    expect(readMoneyFigures('A$500 NZ$300', 'AUD').map((f) => f.cents)).toEqual([50000]);
    expect(readMoneyFigures('US$40 and $25', 'USD').map((f) => f.cents)).toEqual([2500, 4000]);
  });

  it('refuses a space-grouped number rather than truncating it', () => {
    expect(readMoneyFigures('$12 000', 'USD')).toEqual([]);
    expect(readMoneyFigures('$12 per hour', 'USD').map((f) => f.cents)).toEqual([1200]);
  });

  it('does not let a foreign amount borrow the symbol that follows it', () => {
    expect(readMoneyFigures('C$5 $6', 'USD').map((f) => f.cents)).toEqual([600]);
    expect(readMoneyFigures('A$500 $', 'USD')).toEqual([]);
    expect(readMoneyFigures('It costs 40 $', 'USD').map((f) => f.cents)).toEqual([4000]);
  });
});
