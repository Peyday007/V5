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
 * - Adaptation: a capital ceiling the objective's own words state answers how
 *   much may be committed even when the target holds none, so removing a
 *   stored limit never turns a plan inside the words into an open question;
 *   agreed money read at a price a filed fact contradicts does not establish
 *   the offer and price; and with no live opening left, the first missing link
 *   is a reachable buyer, not a price.
 */
import { describe, expect, it } from 'vitest';
import { readVolume } from '../server/services/cash/volume.ts';
import { agreedAtContestedPrice, capitalQuestionOpen, pacedByOwner, qualifyTest } from '../server/services/goals/plan.ts';

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

describe('capitalQuestionOpen: loosening a limit never opens the question', () => {
  const scope = (stated: number | null, assumed = false) => ({ recurring: null, industry: null, hoursPerWeek: null, capitalAssumed: assumed ? { cents: 0, phrase: 'no up-front capital', basis: 'assumed' } : null, capitalStatedCents: stated });
  it('is answered by a stored ceiling', () => {
    expect(capitalQuestionOpen({ capitalCeilingCents: 800_000, scope: scope(null) }, 3000)).toBe(false);
  });
  it('is answered by the words when the stored ceiling is removed, for a plan inside them', () => {
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(800_000) }, 3000)).toBe(false);
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(800_000) }, 9000)).toBe(true);
  });
  it('stays open when nobody stated a figure, or only an assumed one', () => {
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(null) }, 3000)).toBe(true);
    expect(capitalQuestionOpen({ capitalCeilingCents: null }, 3000)).toBe(true);
    expect(capitalQuestionOpen({ capitalCeilingCents: 0, scope: scope(null, true) }, 3000)).toBe(true);
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(null) }, 0)).toBe(false);
  });
});

describe('agreedAtContestedPrice: an agreement does not settle a contested price', () => {
  const price = (contested?: { card: number; stated: number }) => ({ value: contested ? null : 1800, low: contested ? Math.min(contested.card, contested.stated) : 1800, high: contested ? Math.max(contested.card, contested.stated) : 1800, provenance: 'EVIDENCE' as const, source: null, note: '', contested });
  it('flags agreements read above the lower of the two figures', () => {
    expect(agreedAtContestedPrice({ agreed: true, agreedDeals: 2, agreedValue: 3600, price: price({ card: 1800, stated: 180 }) })).toBe(true);
  });
  it('holds agreements at or below the lower figure, and anything uncontested', () => {
    expect(agreedAtContestedPrice({ agreed: true, agreedDeals: 2, agreedValue: 360, price: price({ card: 1800, stated: 180 }) })).toBe(false);
    expect(agreedAtContestedPrice({ agreed: true, agreedDeals: 2, agreedValue: 3600, price: price() })).toBe(false);
    expect(agreedAtContestedPrice({ agreed: false, agreedDeals: 0, agreedValue: 0, price: price({ card: 1800, stated: 180 }) })).toBe(false);
  });
});

describe('qualifyTest: with no live opening, the buyer is missing first', () => {
  it('names a reachable buyer when no opening is live, and a price when one is', () => {
    expect(qualifyTest(0).link).toBe('REACHABLE_BUYER');
    expect(qualifyTest(3).link).toBe('OFFER_AND_PRICE');
    expect(qualifyTest(undefined).link).toBe('OFFER_AND_PRICE');
  });
});
