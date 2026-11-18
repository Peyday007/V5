/**
 * B1f, production 2026-11-18: PR #1072 filed claim clm_9cf1f15cc99846198399,
 * "Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total
 * $4,675", as `price_per_unit` 0.47 against "Local businesses buying a slot on
 * a shared direct-mail postcard". The plan reads that fact as `value`, what a
 * buyer pays per transaction (`composeArrangement`), so arrangement
 * 2821cce3c372 was a $0.47 deal and scored 0 cents. The back-fill now files
 * the figure a claim states for one deal — its total — when it states one.
 */
import { describe, expect, it } from 'vitest';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { dealLevelFigures } from '../server/services/industry/expand.ts';

const CLAIM = 'Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total $4,675';

describe('B1f: a per-piece price is not the price of one deal', () => {
  it('reads the stated total of the exact production claim as the deal-level figure', () => {
    const figures = readMoneyFigures(CLAIM, 'USD');
    expect(figures.map((one) => [one.cents, one.perUnit])).toEqual([[47, true], [467500, false]]);
    expect(dealLevelFigures(figures).map((one) => one.cents)).toEqual([467500]);
  });

  it('keeps a rate where the claim states nothing but a rate, and multiplies nothing', () => {
    expect(dealLevelFigures(readMoneyFigures('Oppizi charges $0.26 per postcard piece.', 'USD')).map((one) => one.cents)).toEqual([26]);
  });

  it('keeps every total when a claim states several, so the caller picks its end', () => {
    const figures = readMoneyFigures('Runs cost $0.40 per piece; a 5,000-home run is $2,100 and a 10,000-home run $4,000.', 'USD');
    expect(dealLevelFigures(figures).map((one) => one.cents)).toEqual([210000, 400000]);
  });
});
