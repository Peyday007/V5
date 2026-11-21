/**
 * `readVolume` multiplies a rate by a count only where the text says each
 * counted unit does that rate. planningReliability case ho-11 found the
 * reader taking "35 pharmacies ship 20 deliveries a week" as 85 orders a month:
 * the 35x population was dropped. The correct reading is 35 x 20 x 30/7 = 3,000.
 * Ambiguous or collective phrasings keep the conservative reading — a
 * multiplier the text does not state is never invented.
 */
import { describe, expect, it } from 'vitest';
import { readVolume } from '../server/services/cash/volume.ts';

describe('readVolume: a count of units each doing a rate multiplies', () => {
  it.each([
    ['35 independent pharmacies in the county ship 20 temperature-controlled deliveries a week.'],
    ['35 pharmacies ship 20 deliveries a week'],
    ['35 pharmacies each place 20 orders a week'],
    ['35 pharmacies ship 20 deliveries a week each'],
    ['Each of the 35 pharmacies ships about 20 deliveries a week.'],
    ['20 deliveries a week from each of 35 pharmacies'],
    ['20 deliveries a week per pharmacy across 35 pharmacies'],
    ['20 deliveries per pharmacy a week, across 35 pharmacies'],
  ])('%s → 3,000 in 30 days', (text) => {
    expect(readVolume(text, 30)).toMatchObject({ deals: 3000, buyers: 35 });
  });

  it('multiplies at any period and window', () => {
    expect(readVolume('120 firms ship 3 orders a month', 30)).toMatchObject({ deals: 360, buyers: 120 });
    expect(readVolume('1,200 stores registered in Ohio typically place 2 orders a year', 365)).toMatchObject({ deals: 2400, buyers: 1200 });
    expect(readVolume('40 clinics book 5 jobs per day', 7)).toMatchObject({ deals: 1400, buyers: 40 });
  });

  it('reads a rate stated across a population as the total it is', () => {
    expect(readVolume('700 deliveries a week across 35 pharmacies', 30)).toMatchObject({ deals: 3000, buyers: null });
  });

  it('takes the slowest stated rate, as before', () => {
    expect(readVolume('35 pharmacies ship 20 deliveries a week; the courier can take 50 deliveries a week.', 30)!.deals).toBe(214);
  });
});

describe('readVolume: an ambiguous rate is never multiplied', () => {
  it.each([
    ['35 pharmacies together ship 20 deliveries a week'],
    ['35 pharmacies collectively ship 20 deliveries a week'],
    ['35 pharmacies ship 20 deliveries a week in total'],
    ['35 pharmacies ship 20 deliveries a week between them'],
    ['35 pharmacies and 20 deliveries a week'],
    ['35 pharmacies use a courier making 20 deliveries a week'],
    ['35 pharmacies; the courier makes 20 deliveries a week'],
    ['35 pharmacies. The courier completes 20 deliveries a week.'],
    ['35 pharmacies with 20 deliveries a week'],
    ['35 pharmacies that ship 20 deliveries a week'],
    ['Of 35 pharmacies, 3 ship 20 deliveries a week'],
    ['20 deliveries a week per pharmacy'],
  ])('%s → the rate alone', (text) => {
    expect(readVolume(text, 30)).toMatchObject({ deals: 85, buyers: null });
  });

  it('leaves the existing readings unchanged', () => {
    expect(readVolume('about 40 orders a month', 30)?.deals).toBe(40);
    expect(readVolume('120 orders per month are published in the category', 30)).toMatchObject({ deals: 120 });
    expect(readVolume('200 restaurants buy weekly', 30)!.deals).toBe(800);
    expect(readVolume('12 businesses', 30)).toMatchObject({ deals: 12, everyDays: null });
    expect(readVolume('$5,000 per engagement', 30)).toBeNull();
    expect(readVolume('Thousands of buyers need this', 30)).toBeNull();
  });
});
