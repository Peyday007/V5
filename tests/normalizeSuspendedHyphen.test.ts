import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN_NOTE = 'rejoined hyphenated line breaks';

describe('normalizeBlockText keeps real hyphens (§9)', () => {
  it('leaves suspended hyphens before a space untouched', () => {
    const text = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(text);
    expect(result.text).toBe(text);
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('rejoins a hard hyphen across a newline', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('rejoins a hard hyphen across a CRLF with surrounding spaces', () => {
    const result = normalizeBlockText('recog- \r\n nition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('still joins a soft hyphen before a space', () => {
    const result = normalizeBlockText('recog\u00ad nition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });
});
