/**
 * planningReliability round 9: what the volume reader counts.
 *
 * - A payer named by a compound before its role ("Marina berth managers",
 *   "Depot facility managers") is counted by each noun of the compound, and a
 *   noun ending in -y pluralizes to -ies, so a market sized in the payer's own
 *   organisation noun is read as sized rather than left open.
 * - A cycle whose due dates research states are spread through it is bounded
 *   by the window: buyers renewing once a year, evenly, make window/365 of
 *   their renewals inside a month — never one each. A cycle stated without its
 *   timing keeps one purchase each, as before.
 */
import { describe, expect, it } from 'vitest';
import { payerHeldWords, readVolume } from '../server/services/cash/volume.ts';

describe('payerHeldWords: the nouns of a compound before the role', () => {
  it('reads each organisation noun and pluralizes -y to -ies', () => {
    expect(payerHeldWords('Depot facility managers')).toEqual(expect.arrayContaining(['depot', 'depots', 'facility', 'facilities']));
    expect(payerHeldWords('Depot facility managers')).not.toContain('facilitys');
    expect(payerHeldWords('Marina berth revenue managers')).toEqual(expect.arrayContaining(['marinas', 'berths']));
  });
  it('never takes an adjective further out than the head', () => {
    expect(payerHeldWords('Licensed regional depot managers')).not.toContain('licenseds');
    expect(payerHeldWords('Licensed regional depot managers')).not.toContain('regionals');
    expect(payerHeldWords('Licensed regional depot managers')).toContain('depots');
  });
  it('sizes a market counted in the compound noun', () => {
    expect(readVolume('310 marinas are listed in the harbour directory; each books berth audits every quarter.', 45, 'Marina berth revenue managers')).toMatchObject({ buyers: 310 });
    expect(readVolume('95 depot facilities are registered; each contracts cleaning monthly.', 30, 'Depot facility managers')).toMatchObject({ buyers: 95 });
  });
});

describe('readVolume: a spread cycle is bounded by the window', () => {
  it('counts only the purchases that fall due inside the window', () => {
    // 730 × 30 / 365 = 60.
    expect(readVolume('730 shops renew their hygiene certificate once a year, spread evenly through the year.', 30)).toMatchObject({ deals: 60, buyers: 730, everyDays: 365 });
    // 200 × 20 / 91 = 43.
    expect(readVolume('200 clinics each recalibrate quarterly on a rolling schedule.', 20)).toMatchObject({ deals: 43, buyers: 200 });
  });
  it('keeps one purchase each when the timing is not stated', () => {
    expect(readVolume('730 shops renew their hygiene certificate once a year.', 30)).toMatchObject({ deals: 730 });
    expect(readVolume('200 clinics each recalibrate quarterly.', 20)).toMatchObject({ deals: 200 });
  });
  it('reads once and twice as a frequency, and a stated renewal rate as orders', () => {
    expect(readVolume('90 salons renew twice a year, staggered across the year.', 30)).toMatchObject({ deals: 14 });
    expect(readVolume('About 25 renewals a month are filed.', 30)).toMatchObject({ deals: 25, counted: 'ORDERS' });
  });
});
