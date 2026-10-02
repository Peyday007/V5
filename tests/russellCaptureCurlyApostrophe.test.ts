import { describe, expect, it } from 'vitest';
import { shouldCapture } from '../server/services/russell/judgment.ts';

const curly = (s: string) => s.replace(/'/g, '’');
const left = (s: string) => s.replace(/'/g, '‘');

describe('shouldCapture folds typographic apostrophes', () => {
  const cases: Array<[string, boolean]> = [
    ["How's it going, are you well?", false],
    ["Let's map the county fees", true],
  ];
  for (const [text, expected] of cases) {
    it(`${text}`, () => {
      expect(shouldCapture(text).capture).toBe(expected);
      expect(shouldCapture(curly(text))).toEqual(shouldCapture(text));
      expect(shouldCapture(left(text))).toEqual(shouldCapture(text));
    });
  }
  it('curly forms give the stated decisions', () => {
    expect(shouldCapture('How’s it going, are you well?').capture).toBe(false);
    expect(shouldCapture('Let’s map the county fees').capture).toBe(true);
  });
});
