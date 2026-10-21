import { describe, expect, it } from 'vitest';
import { NEGATORS, clauseBefore, foldApostrophes } from '../server/services/russell/negation.ts';

describe('NEGATORS apostrophes', () => {
  for (const word of ['don', 'doesn', 'didn', 'can', 'won']) {
    it(`${word}t matches with ASCII and curly apostrophes`, () => {
      expect(NEGATORS.test(`${word}'t fix the footer`)).toBe(true);
      expect(NEGATORS.test(`${word}’t fix the footer`)).toBe(true);
    });
  }
  it('reads a curly exclusion in a software request', () => {
    expect(NEGATORS.test('Don’t change Brain, fix V4')).toBe(true);
  });
  it('still ignores plain sentences', () => {
    expect(NEGATORS.test('Fix the footer')).toBe(false);
  });
  it('foldApostrophes maps U+2019 to ASCII', () => {
    expect(foldApostrophes('Don’t')).toBe("Don't");
    expect(foldApostrophes("Don't")).toBe("Don't");
  });
  it('clauseBefore returns the folded clause, so every reader sees one spelling', () => {
    const text = 'Don’t touch it. Please fix the footer';
    const clause = clauseBefore(text, text.indexOf('touch'));
    expect(clause).toBe("Don't ");
    expect(NEGATORS.test(clause)).toBe(true);
    expect(text.length).toBe(foldApostrophes(text).length);
  });
});
