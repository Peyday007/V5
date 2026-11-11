import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN_NOTE = 'rejoined hyphenated line breaks';

describe('normalizeBlockText keeps authored hyphens (§9)', () => {
  it('A01: leaves suspended hyphens followed by a space untouched', () => {
    const input = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(input);
    expect(result.text).toBe(input);
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('A01: a hyphen before spaces or tabs on the same line is never a line break', () => {
    const result = normalizeBlockText('first-\tand second-  order effects');
    expect(result.text).toBe('first- and second- order effects');
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('A02: rejoins a hard hyphen split across a line break', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('A02: rejoins across a CRLF break with surrounding spaces or tabs', () => {
    const result = normalizeBlockText('intermedi- \r\n\tation');
    expect(result.text).toBe('intermediation');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('A02: a hard hyphen before a capital on the next line is kept', () => {
    const result = normalizeBlockText('North-\nSouth');
    expect(result.text).toBe('North-\nSouth');
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('A02: a soft hyphen still joins across any whitespace', () => {
    const result = normalizeBlockText('co­ operate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('A02: a soft hyphen still joins across a line break', () => {
    const result = normalizeBlockText('co­\noperate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN_NOTE);
  });
});
