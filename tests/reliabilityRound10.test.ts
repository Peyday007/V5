/**
 * planningReliability round 10.
 *
 * - A frequency stated as a floor ("at least once a year", "once a year or
 *   more") cannot cap the market: buyers × window ÷ cycle is the fewest
 *   purchases that fall due, so round 9's spread bound does not apply to it,
 *   and the cycle counts as one stated without its timing.
 * - Pacing ("little by little") is something the owner set — a before-proof
 *   figure or a weekly one. A before-proof ceiling only assumed from the
 *   objective's words ("no up-front capital") is a capital limit, and does not
 *   refuse an award that ties nothing up for paying in one lump.
 */
import { describe, expect, it } from 'vitest';
import { readVolume } from '../server/services/cash/volume.ts';
import { pacedByOwner } from '../server/services/goals/plan.ts';

describe('readVolume: a minimum frequency is not a ceiling', () => {
  it('does not bound a spread market by a frequency stated as a floor', () => {
    expect(readVolume('300 shops each service their lifts at least once a year, booked year-round.', 60)).toMatchObject({ deals: 300, buyers: 300 });
    expect(readVolume('300 shops service their lifts once a year or more, spread through the year.', 60)).toMatchObject({ deals: 300 });
    expect(readVolume('300 shops service their lifts at least annually, on a rolling schedule.', 60)).toMatchObject({ deals: 300 });
  });
  it('still bounds a spread market whose frequency is exact', () => {
    // 300 × 60 / 365 = 49.
    expect(readVolume('300 shops each service their lifts once a year, booked year-round.', 60)).toMatchObject({ deals: 49, buyers: 300 });
  });
});

describe('pacedByOwner: pacing is set by the owner, never assumed from words', () => {
  const assumed = { cents: 0, phrase: 'no up-front capital', basis: 'assumed' };
  const scope = (capitalAssumed: typeof assumed | null) => ({ recurring: null, industry: null, hoursPerWeek: null, capitalAssumed });
  it('is not paced by a ceiling assumed from "no up-front capital"', () => {
    expect(pacedByOwner({ capitalBeforeProofCents: 0, capitalPerWeekCents: null, scope: scope(assumed) })).toBe(false);
  });
  it('is paced by a before-proof or weekly figure the owner set', () => {
    expect(pacedByOwner({ capitalBeforeProofCents: 30_000, capitalPerWeekCents: null, scope: scope(null) })).toBe(true);
    expect(pacedByOwner({ capitalBeforeProofCents: null, capitalPerWeekCents: 75_000, scope: scope(null) })).toBe(true);
    expect(pacedByOwner({ capitalBeforeProofCents: 0, capitalPerWeekCents: 75_000, scope: scope(assumed) })).toBe(true);
  });
  it('is not paced when nothing is set', () => {
    expect(pacedByOwner({ capitalBeforeProofCents: null, capitalPerWeekCents: null })).toBe(false);
  });
});
