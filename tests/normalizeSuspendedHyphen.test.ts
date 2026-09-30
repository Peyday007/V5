import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const NOTE = 'rejoined hyphenated line breaks';

describe('hyphen rejoining', () => {
  it('leaves real suspended hyphens alone', () => {
    const raw = 'pre- and post-closing inspections; short- or long-term leases';
    const r = normalizeBlockText(raw);
    expect(r.text).toBe(raw);
    expect(r.notes).not.toContain(NOTE);
  });

  it('rejoins a hard hyphen across a newline', () => {
    const r = normalizeBlockText('recog-\nnition');
    expect(r.text).toBe('recognition');
    expect(r.notes).toContain(NOTE);
  });

  it('still joins a soft hyphen before a space', () => {
    const r = normalizeBlockText('recog\u00ad nition');
    expect(r.text).toBe('recognition');
    expect(r.notes).toContain(NOTE);
  });
});
