import { describe, expect, it } from 'vitest';
import { statesNamedIn } from '../server/domain/jurisdiction.ts';

describe('statesNamedIn with overlapping names', () => {
  it('reads West Virginia as one state', () => {
    expect(statesNamedIn('Coal permits in West Virginia counties')).toEqual(['west virginia']);
  });
  it('still reports both when both are named', () => {
    expect(statesNamedIn('Virginia and West Virginia')).toEqual(['virginia', 'west virginia']);
  });
  it('reads the district in its written forms as the district only', () => {
    expect(statesNamedIn('Recording fees in Washington, DC')).toEqual(['district of columbia']);
    expect(statesNamedIn('Recording fees in Washington D.C.')).toEqual(['district of columbia']);
    expect(statesNamedIn('Recording fees in Washington, D.C.')).toEqual(['district of columbia']);
  });
  it('keeps Washington state as Washington', () => {
    expect(statesNamedIn('Washington state permits')).toEqual(['washington']);
  });
  it('leaves the capitals rule alone', () => {
    expect(statesNamedIn('Westbrook, OH')).toEqual(['ohio']);
    expect(statesNamedIn('do we roof this, or not')).toEqual([]);
  });
});
