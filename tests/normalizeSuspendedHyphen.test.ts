import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN = 'rejoined hyphenated line breaks';

describe('normalizeBlockText keeps hyphens that are not line breaks (§9)', () => {
  it('A01: leaves suspended hyphens before a space untouched', () => {
    const input = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(input);
    expect(result.text).toBe(input);
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A01: a hard hyphen followed by spaces or tabs on the same line is kept', () => {
    const result = normalizeBlockText('first-\tand second-  order effects');
    expect(result.text).toBe('first- and second- order effects');
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A02: rejoins a hard hyphen across a newline', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN);
  });

  it('A02: rejoins a hard hyphen across a newline with surrounding spaces, tabs or CRLF', () => {
    expect(normalizeBlockText('intermedi- \t\r\n  ation').text).toBe('intermediation');
  });

  it('A02: does not rejoin before an uppercase letter', () => {
    const result = normalizeBlockText('North-\nEast');
    expect(result.text).toBe('North-\nEast');
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A02: a soft hyphen still joins across any whitespace', () => {
    const result = normalizeBlockText('co­ operate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN);
    expect(normalizeBlockText('co­\n operate').text).toBe('cooperate');
  });
});
