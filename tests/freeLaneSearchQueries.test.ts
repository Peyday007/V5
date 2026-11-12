/**
 * The free lane searches with short phrases, never a question's preamble.
 *
 * Production, 2026-11-07: a constructed round's question opens with ~240
 * characters of boilerplate, `webSearch` keeps exactly that much, and the lane
 * searched with the whole question — so one of every fragment's two searches
 * asked for boilerplate.
 */
import { describe, expect, it } from 'vitest';
import { searchQueries } from '../server/services/freeLane/worker.ts';

const CONSTRUCTED =
  'Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ' +
  'buyers described as "Small and mid-size firms sending year-end client and employee gifts" pay for what they need most, ' +
  'fulfilled by Brain producing it (spreadsheet, business document). Establish whether such buyers actually pay for this.';

describe('free-lane search queries', () => {
  it('uses the model phrase, then the quoted subject, and never the preamble', () => {
    const q = searchQueries(CONSTRUCTED, ['corporate holiday gift program pricing', 'year-end client gifts small business']);
    expect(q).toEqual(['corporate holiday gift program pricing', 'Small and mid-size firms sending year-end client and employee gifts']);
    expect(q.some((one) => one.startsWith('Brain composed'))).toBe(false);
  });

  it('accepts the older single "search" field and falls back to the first sentence when nothing is quoted', () => {
    expect(searchQueries('What do dental practices pay for patient newsletters? Name sources.', 'dental newsletter price')).toEqual([
      'dental newsletter price',
      'What do dental practices pay for patient newsletters?',
    ]);
  });

  it('runs at most two searches, each short, with no duplicates', () => {
    const q = searchQueries(CONSTRUCTED, ['Small and mid-size firms sending year-end client and employee gifts', 'x'.repeat(400)]);
    expect(q.length).toBeLessThanOrEqual(2);
    expect(q.every((one) => one.length <= 120)).toBe(true);
    expect(new Set(q.map((one) => one.toLowerCase())).size).toBe(q.length);
  });

  it('still searches when the model gave nothing', () => {
    expect(searchQueries(CONSTRUCTED, undefined)).toEqual(['Small and mid-size firms sending year-end client and employee gifts']);
  });
});
