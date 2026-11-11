import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN = 'rejoined hyphenated line breaks';

describe('normalizeBlockText keeps hyphens an author wrote (section 9)', () => {
  it('A01: leaves suspended hyphens followed by an ordinary space untouched', () => {
    const input = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(input);
    expect(result.text).toBe(input);
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A01: does not rejoin a hard hyphen across several spaces or a tab', () => {
    const input = 'first-  and second-\tor third-party';
    const result = normalizeBlockText(input);
    expect(result.text).toBe('first- and second- or third-party');
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A02: rejoins a hard hyphen across a line break and records it', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN);
  });

  it('A02: rejoins across a line break padded with spaces, tabs or CRLF', () => {
    expect(normalizeBlockText('recog- \t\r\n  nition').text).toBe('recognition');
  });

  it('A02: keeps a hard hyphen before a capital on the next line', () => {
    const result = normalizeBlockText('Franco-\nGerman');
    expect(result.text).toBe('Franco-\nGerman');
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A02: a soft hyphen still joins across any whitespace', () => {
    const result = normalizeBlockText('co\u00ad operate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN);
    expect(normalizeBlockText('co\u00ad\noperate').text).toBe('cooperate');
  });
});
