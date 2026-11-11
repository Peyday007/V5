/**
 * A hard hyphen followed by an ordinary space is a real hyphen, not a line
 * break, and normalisation may only remove extraction artifacts (section 9).
 */
import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN = 'rejoined hyphenated line breaks';

describe('suspended hyphens survive normalisation', () => {
  it('A01: leaves "pre- and post-" and "short- or long-" unchanged, with no rejoin note', () => {
    const raw = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(raw);
    expect(result.text).toBe(raw);
    expect(result.notes).not.toContain(REJOIN);
  });

  it('keeps a hard hyphen followed by a tab or several spaces on the same line', () => {
    const cases: [string, string][] = [
      ['first-\tand second-order effects', 'first- and second-order effects'],
      ['mid-   to late-stage', 'mid- to late-stage'],
    ];
    for (const [raw, expected] of cases) {
      const result = normalizeBlockText(raw);
      expect(result.text).toBe(expected);
      expect(result.notes).not.toContain(REJOIN);
    }
  });
});

describe('line-break hyphenation is still rejoined', () => {
  it('A02: rejoins "recog-\\nnition" with the rejoin note', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN);
  });

  it('rejoins across a newline with spaces or tabs either side', () => {
    expect(normalizeBlockText('recog- \t\n  nition').text).toBe('recognition');
  });

  it('A02: a soft hyphen still joins across any whitespace', () => {
    const result = normalizeBlockText('co­ operate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN);
  });

  it('does not rejoin a hard hyphen before an uppercase word on the next line', () => {
    expect(normalizeBlockText('North-\nSouth').text).toBe('North-\nSouth');
  });
});
