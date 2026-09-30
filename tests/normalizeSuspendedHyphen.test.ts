import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const NOTE = 'rejoined hyphenated line breaks';

describe('suspended hyphens', () => {
  it('leaves real hyphens followed by a space alone', () => {
    const raw = 'pre- and post-closing inspections; short- or long-term leases';
    const out = normalizeBlockText(raw);
    expect(out.text).toBe(raw);
    expect(out.notes).not.toContain(NOTE);
  });

  it('rejoins a hard hyphen across a newline', () => {
    const out = normalizeBlockText('recog-\nnition');
    expect(out.text).toBe('recognition');
    expect(out.notes).toContain(NOTE);
  });

  it('still joins a soft hyphen before a space', () => {
    const out = normalizeBlockText('intermedi\u00ad ation');
    expect(out.text).toBe('intermediation');
    expect(out.notes).toContain(NOTE);
  });
});
